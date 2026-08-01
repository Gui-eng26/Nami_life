# BRIEFING B — MH-70: Tabela `eventos_proativos` e instrumentação dos envios proativos

**Sessão:** 28 (continuação — Parte B do plano de 3 partes desenhado para o contexto proativo do classificador)
**Arquivos alterados:** `supabase/migrations/` (novo), `src/database.js`, `src/scheduler.js`, `src/agentes/lembrete.js`, `src/agentes/relatorios.js`
**Prioridade:** média (é infraestrutura pura — nada lê essa tabela ainda, então não há risco de regressão de comportamento)
**Relacionado a:** MH-065 (v27) — substitui a fonte de dados que `getContextoProativoRecente` usa hoje; MH-67/MH-68 (backlog, notas a atualizar no encerramento)
**Depende de:** nada. Este briefing só ESCREVE numa tabela nova — nenhum código de leitura muda ainda (isso é a Parte C, briefing separado)

---

## 1. Contexto

Na sessão de hoje, ao investigar por que `getContextoProativoRecente` (MH-065) não reflete fielmente o que a Nami realmente mostrou na tela do usuário, identificamos o erro de modelagem: a função tenta **reconstruir** histórico a partir de `dose_logs`, uma tabela de **estado mutável** (cada `UPDATE` de follow-up sobrescreve o valor anterior — o horário do follow-up 1 se perde quando o follow-up 2 é gravado). Não existe hoje nenhum registro que **acumule**, no momento do envio, cada evento proativo como um fato imutável.

A correção não é ler melhor o que já existe — é criar o registro que falta, escrito **no instante do envio**, separado do estado operacional da dose. Esta parte (B) só cria essa infraestrutura de escrita. A parte C (próximo briefing) reescreve a leitura para consumir essa tabela nova.

**Escopo confirmado com Guilherme:** cobrir todos os tipos de evento proativo, incluindo os 3 que a v27 já sabia que ficavam fora de cobertura (resumo semanal, alerta de estoque zerado, alerta pós-`nao_informado`) e o que encontramos nesta sessão (alerta de estoque zerado disparado na hora do lembrete, `scheduler.js:376` — não estava nem na lista da v27).

---

## 2. Migration — nova tabela

Criar `supabase/migrations/20260801000000_eventos_proativos.sql`:

```sql
-- -----------------------------------------------------------------------------
-- EVENTOS_PROATIVOS (MH-70, v28)
-- Registro de ENTREGA (escrito no instante do envio), nunca de intenção — mesma
-- semântica de dose_logs, mas append-only: ao contrário de dose_logs, cada envio
-- gera uma linha própria, que nunca é sobrescrita por um envio posterior.
-- Existe para permitir ao contexto proativo do classificador central (Parte C
-- desta mesma sessão) reconstruir a linha do tempo real de mensagens que a Nami
-- enviou por iniciativa própria, sem depender do estado mutável de dose_logs.
-- Ver decisão de arquitetura na sessão v28: getContextoProativoRecente (MH-065)
-- reconstruía a partir de dose_logs, que só guarda o último follow-up — os
-- follow-ups intermediários se perdiam antes de qualquer leitura acontecer.
-- -----------------------------------------------------------------------------
CREATE TABLE public.eventos_proativos (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid REFERENCES public.users(id) ON DELETE CASCADE,
    tipo                text NOT NULL, -- 'lembrete' | 'follow_up' | 'alerta_estoque_zerado'
                                       -- | 'alerta_estoque_nao_informado' | 'resumo_semanal'
    medication_id       uuid REFERENCES public.medications(id) ON DELETE CASCADE,
    dose_log_id         uuid REFERENCES public.dose_logs(id) ON DELETE SET NULL,
    tentativa           int,           -- só relevante para tipo 'follow_up'
    horario_agendado    time,          -- copiado no momento do envio, não por join depois
    enviado_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_eventos_proativos_user_enviado ON public.eventos_proativos(user_id, enviado_at);
```

**Por que `ON DELETE CASCADE` em `user_id` e `medication_id` (diferente de `system_events`/`feedbacks`, que usam `SET NULL`):** este dado é puramente operacional (o que foi mandado, quando) — não tem valor de aprendizado de produto depois que a conta é apagada. Mesmo padrão que `dose_logs` já segue. Não exige nenhuma mudança na função de exclusão de conta (LGPD, MH-020) — a cascata já cuida disso sozinha.

---

## 3. Nova função em `database.js` — ponto único de escrita

Adicionar próximo a `getContextoProativoRecente` (linha ~1589 aproximadamente, seção já comentada como "CONTEXTO PROATIVO — MH-065"):

```js
// ============================================================
// EVENTOS PROATIVOS (MH-70, v28)
// Ponto único de escrita — nunca inserir em eventos_proativos por SQL direto
// fora desta função (mesmo princípio de src/backlog.js para backlog_items).
// Defensiva: uma falha aqui nunca pode impedir o envio real da mensagem ao
// usuário, por isso nunca lança exceção — mesmo padrão de registrarEvento/
// registrarFeedback (observabilidade.js).
// ============================================================
export async function registrarEventoProativo({ userId, tipo, medicationId = null, doseLogId = null, tentativa = null, horarioAgendado = null }) {
    try {
        const { error } = await supabase.from('eventos_proativos').insert({
            user_id: userId,
            tipo,
            medication_id: medicationId,
            dose_log_id: doseLogId,
            tentativa,
            horario_agendado: horarioAgendado
        });
        if (error) console.error(`[eventos_proativos] Falha ao registrar evento proativo: ${error.message}`);
    } catch (e) {
        console.error(`[eventos_proativos] Exceção ao registrar evento proativo: ${e.message}`);
    }
}
```

---

## 4. Instrumentação — 7 pontos de chamada

### 4.1 — `scheduler.js`: import

No topo do arquivo, adicionar `registrarEventoProativo` ao import existente de `database.js`:

```js
import { getPendingReminders, getPendingFollowUps, createDoseLog,
    getUsuariosAtivos, updateDoseLogTentativa, registrarEventoProativo } from './database.js';
```

### 4.2 — `scheduler.js`: `sendGroupedReminder` (tipo `lembrete`, agrupado)

Localizar:
```js
        for (const reminder of grupo) {
            await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                // zapiMessageId omitido de propósito (default null)
                horarioAgendado: String(reminder.horario).substring(0, 5)
            });
        }
```

Substituir por:
```js
        for (const reminder of grupo) {
            const horarioAgendado = String(reminder.horario).substring(0, 5);
            const doseLog = await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                // zapiMessageId omitido de propósito (default null)
                horarioAgendado
            });
            await registrarEventoProativo({
                userId: reminder.user_id,
                tipo: 'lembrete',
                medicationId: reminder.medication_id,
                doseLogId: doseLog.id,
                horarioAgendado
            });
        }
```

### 4.3 — `scheduler.js`: `handleGroupedFollowUp` (tipo `follow_up`, agrupado)

Localizar:
```js
        for (const item of grupo) {
            const tentativaItem = (item.tentativas || 1) + 1;
            await updateDoseLogTentativa(item.id, tentativaItem);
        }
```

Substituir por:
```js
        for (const item of grupo) {
            const tentativaItem = (item.tentativas || 1) + 1;
            await updateDoseLogTentativa(item.id, tentativaItem);
            await registrarEventoProativo({
                userId: item.user_id,
                tipo: 'follow_up',
                medicationId: item.medication_id,
                doseLogId: item.id,
                tentativa: tentativaItem,
                horarioAgendado: item.horario_agendado ? String(item.horario_agendado).substring(0, 5) : null
            });
        }
```

### 4.4 — `scheduler.js`: `sendReminder`, ramo estoque zerado (tipo `alerta_estoque_zerado`)

Localizar:
```js
        if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
            const firstName = reminder.user_name?.split(' ')[0] || 'você';
            const message = buildEstoqueZeradoMessage(firstName, reminder);
            await sendTextMessage(reminder.phone, message);

            // Cria dose_log com status 'sem_estoque' para ativar deduplicação do scheduler
            // Sem isso, o stored procedure retorna o mesmo medicamento no próximo ciclo
            await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                status: 'sem_estoque',
                horarioAgendado
            });

            console.log(`📦 Aviso de estoque zerado enviado para ${reminder.phone} — ${reminder.med_nome}`);
            return;
        }
```

Substituir por:
```js
        if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
            const firstName = reminder.user_name?.split(' ')[0] || 'você';
            const message = buildEstoqueZeradoMessage(firstName, reminder);
            await sendTextMessage(reminder.phone, message);

            // Cria dose_log com status 'sem_estoque' para ativar deduplicação do scheduler
            // Sem isso, o stored procedure retorna o mesmo medicamento no próximo ciclo
            const doseLog = await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                status: 'sem_estoque',
                horarioAgendado
            });
            await registrarEventoProativo({
                userId: reminder.user_id,
                tipo: 'alerta_estoque_zerado',
                medicationId: reminder.medication_id,
                doseLogId: doseLog.id,
                horarioAgendado
            });

            console.log(`📦 Aviso de estoque zerado enviado para ${reminder.phone} — ${reminder.med_nome}`);
            return;
        }
```

### 4.5 — `scheduler.js`: `sendReminder`, lembrete individual (tipo `lembrete`)

Localizar:
```js
        // BUG-029: capturar o ID da mensagem enviada pela Z-API
        const zapiResult = await sendTextMessage(reminder.phone, message);
        const zapiMessageId = zapiResult?.zapiMessageId || null;

        await createDoseLog({
            medicationId: reminder.medication_id,
            scheduledAt: new Date().toISOString(),
            reminderSent: true,
            reminderSentAt: new Date().toISOString(),
            zapiMessageId,
            horarioAgendado
        });

        console.log(`✅ Lembrete enviado para ${reminder.phone} — ${reminder.med_nome}`);
```

Substituir por:
```js
        // BUG-029: capturar o ID da mensagem enviada pela Z-API
        const zapiResult = await sendTextMessage(reminder.phone, message);
        const zapiMessageId = zapiResult?.zapiMessageId || null;

        const doseLog = await createDoseLog({
            medicationId: reminder.medication_id,
            scheduledAt: new Date().toISOString(),
            reminderSent: true,
            reminderSentAt: new Date().toISOString(),
            zapiMessageId,
            horarioAgendado
        });
        await registrarEventoProativo({
            userId: reminder.user_id,
            tipo: 'lembrete',
            medicationId: reminder.medication_id,
            doseLogId: doseLog.id,
            horarioAgendado
        });

        console.log(`✅ Lembrete enviado para ${reminder.phone} — ${reminder.med_nome}`);
```

### 4.6 — `lembrete.js`: import

No topo do arquivo:
```js
import {
    updateDoseLogTentativa,
    updateDoseLogZapiMessageId,
    markAsNaoInformado,
    getCaregivers,
    markCaregiverNotified,
    getEstoqueInfoParaAlerta,
    calcularAlertaEstoque,
    registrarEventoProativo
} from '../database.js';
```

### 4.7 — `lembrete.js`: `handleFollowUp`, follow-up individual (tipo `follow_up`)

Localizar:
```js
        if (tentativa <= 3) {
            const message = buildFollowUpMessage(tentativa, reminder);
            const zapiResult = await sendTextMessage(reminder.phone, message);
            const zapiMessageId = zapiResult?.zapiMessageId || null;

            await updateDoseLogTentativa(doseLog.id, tentativa);

            // BUG-029: atualizar com o ID do follow-up mais recente para confirmação via "responder"
            if (zapiMessageId) {
                await updateDoseLogZapiMessageId(doseLog.id, zapiMessageId);
            }

            console.log(`🔔 Follow-up tentativa ${tentativa} enviado para ${reminder.phone} — ${reminder.med_nome}`);
        } else {
```

Substituir por:
```js
        if (tentativa <= 3) {
            const message = buildFollowUpMessage(tentativa, reminder);
            const zapiResult = await sendTextMessage(reminder.phone, message);
            const zapiMessageId = zapiResult?.zapiMessageId || null;

            await updateDoseLogTentativa(doseLog.id, tentativa);

            // BUG-029: atualizar com o ID do follow-up mais recente para confirmação via "responder"
            if (zapiMessageId) {
                await updateDoseLogZapiMessageId(doseLog.id, zapiMessageId);
            }
            await registrarEventoProativo({
                userId: reminder.user_id,
                tipo: 'follow_up',
                medicationId: doseLog.medication_id,
                doseLogId: doseLog.id,
                tentativa,
                horarioAgendado: doseLog.horario_agendado ? String(doseLog.horario_agendado).substring(0, 5) : null
            });

            console.log(`🔔 Follow-up tentativa ${tentativa} enviado para ${reminder.phone} — ${reminder.med_nome}`);
        } else {
```

### 4.8 — `lembrete.js`: `handleFollowUp`, alerta pós-`nao_informado` (tipo `alerta_estoque_nao_informado`)

Localizar:
```js
                    if (deveAlertar) {
                        const firstName = reminder.user_name?.split(' ')[0] || 'você';
                        const msg = buildAlertaEstoqueNaoInformado(firstName, estoqueInfo);
                        await sendTextMessage(reminder.phone, msg);
                        console.log(`📦 Alerta de estoque (nao_informado) enviado para ${reminder.phone} — ${estoqueInfo.medNome}`);
                    }
```

Substituir por:
```js
                    if (deveAlertar) {
                        const firstName = reminder.user_name?.split(' ')[0] || 'você';
                        const msg = buildAlertaEstoqueNaoInformado(firstName, estoqueInfo);
                        await sendTextMessage(reminder.phone, msg);
                        await registrarEventoProativo({
                            userId: reminder.user_id,
                            tipo: 'alerta_estoque_nao_informado',
                            medicationId: doseLog.medication_id,
                            doseLogId: doseLog.id
                        });
                        console.log(`📦 Alerta de estoque (nao_informado) enviado para ${reminder.phone} — ${estoqueInfo.medNome}`);
                    }
```

### 4.9 — `relatorios.js`: import

No topo do arquivo, adicionar `registrarEventoProativo` ao import existente de `database.js` (confirmar nome exato do import já presente antes de editar — só acrescentar ao final da lista).

### 4.10 — `relatorios.js`: `enviarResumoSemanal` (tipo `resumo_semanal`)

Localizar:
```js
        await sendTextMessage(user.phone, texto);

        const melhorFaixaNova = (!melhorAnterior || RANKING_FAIXA[faixaNova] > RANKING_FAIXA[melhorAnterior])
```

Substituir por:
```js
        await sendTextMessage(user.phone, texto);
        await registrarEventoProativo({
            userId: user.id,
            tipo: 'resumo_semanal'
        });

        const melhorFaixaNova = (!melhorAnterior || RANKING_FAIXA[faixaNova] > RANKING_FAIXA[melhorAnterior])
```

---

## 5. Fora de escopo (decisão já tomada nesta sessão)

- **Notificação de cuidador** (`lembrete.js`, `notificarCuidadores`) — fica de fora de propósito. É uma mensagem para outro telefone (o cuidador, não o paciente); o contexto proativo (Parte C) é sobre o que o **paciente** viu na própria tela.
- **Nenhuma leitura muda nesta parte.** `getContextoProativoRecente` continua exatamente como está até o Briefing C.

---

## 6. Verificação antes de considerar concluído

```bash
node --check src/database.js
node --check src/scheduler.js
node --check src/agentes/lembrete.js
node --check src/agentes/relatorios.js
```

Aplicar a migration no Supabase (via MCP ou painel, conforme o fluxo já usado nas migrations anteriores). Commit (`feat: tabela eventos_proativos + instrumentação dos 5 tipos de envio proativo (MH-70)`), push.

---

## 7. Registro no backlog

- **MH-70**
  - Título: "Tabela eventos_proativos (append-only) + instrumentação de todos os envios proativos — infraestrutura de escrita para o contexto proativo do classificador (substitui a base de dados do MH-065)"
  - Status inicial: `em_validacao`
  - Prioridade: média
  - Relacionado a: MH-065, MH-67, MH-68
  - Observação: como esta parte só escreve (nenhuma leitura muda), a validação em produção é sobre **existência e correção dos dados gravados**, não sobre comportamento visível do usuário — ver seção 8.

---

## 8. Validação — via consulta SQL (não é um teste de WhatsApp desta vez)

Como esta parte só grava dados, sem mudar nenhuma resposta visível, a validação é conferir diretamente na tabela depois de alguns ciclos do scheduler (lembretes/follow-ups reais acontecendo em produção):

```sql
SELECT tipo, count(*), min(enviado_at), max(enviado_at)
FROM eventos_proativos
GROUP BY tipo
ORDER BY tipo;
```

Esperado: pelo menos os tipos `lembrete` e `follow_up` aparecendo com contagem > 0 dentro de algumas horas (dado o volume normal de lembretes). `alerta_estoque_zerado`, `alerta_estoque_nao_informado` e `resumo_semanal` só aparecerão quando as condições reais ocorrerem (estoque zerado, 3 tentativas sem resposta, ou domingo 16h) — não são esperados imediatamente.