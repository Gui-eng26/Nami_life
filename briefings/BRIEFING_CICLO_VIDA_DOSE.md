# BRIEFING: Ciclo de Vida da Dose
## Confirmação Retroativa + Reversão de Confirmação

**Sessão v11 — 29/06/2026**

---

## Contexto e objetivo

Resolver dois fluxos de integridade de dado clínico identificados na investigação do ciclo de vida da dose:

**Situação 1 — Confirmação retroativa:**
Dose virou `nao_informado` após 3 follow-ups sem resposta, mas o usuário tomou o medicamento e quer registrar depois (janela de 2 dias: ontem e anteontem). Hoje a Nami responde "sem doses pendentes" e ignora o registro.

**Situação 2 — Reversão de confirmação:**
Usuário confirmou por engano (ex: confirmou 3 doses de vez mas só tomou 2). A Nami precisa reverter o status e recréditar o estoque.

**Bug menor associado:**
`nao_informado` quando o usuário diz "não tomei" para uma dose retroativa → deve virar `nao_tomado`.

---

## O que NÃO precisa ser feito

**Sem migration SQL.** As colunas de auditoria já existem em produção desde a migração de 29/06/2026:
```sql
-- Já existem em dose_logs:
revertido         boolean DEFAULT false
revertido_at      timestamptz
revertido_de      text
revertido_motivo  text
```

---

## Arquivos a modificar

1. `src/database.js` — 4 novas funções + 1 extensão
2. `src/prompts.js` — 2 novas actions + regras de uso
3. `src/agentes/principal.js` — 2 novos blocos em `buildUserMessage` + 2 novos handlers em `processAction` + extensão do handler `REGISTER_NAO_TOMADO`
4. `src/router.js` — atualização obrigatória do inventário do classificador LLM

---

## 1. database.js

### 1.1 Nova função: `getDosesRetroativas(userId, dias = 2)`

Busca doses com `status = 'nao_informado'` dos últimos `dias` dias para todos os medicamentos ativos do usuário.

```javascript
export async function getDosesRetroativas(userId, dias = 2) {
    const since = new Date();
    since.setDate(since.getDate() - dias);

    const { data: meds } = await supabase
        .from('medications')
        .select('id, nome')
        .eq('user_id', userId)
        .eq('ativo', true);

    if (!meds || meds.length === 0) return [];

    const medicationIds = meds.map(m => m.id);
    const medNomeMap = Object.fromEntries(meds.map(m => [m.id, m.nome]));

    const { data, error } = await supabase
        .from('dose_logs')
        .select('*')
        .in('medication_id', medicationIds)
        .eq('status', 'nao_informado')
        .gte('scheduled_at', since.toISOString())
        .order('scheduled_at', { ascending: false });

    if (error) {
        console.error('Erro ao buscar doses retroativas:', error.message);
        return [];
    }

    return (data || []).map(d => ({
        ...d,
        medications: { nome: medNomeMap[d.medication_id], user_id: userId }
    }));
}
```

---

### 1.2 Nova função: `getDosesConfirmadasHoje(userId)`

Busca doses com `status = 'confirmado'` e `taken_at` de hoje para todos os medicamentos ativos do usuário. Usada para o bloco de reversão.

```javascript
export async function getDosesConfirmadasHoje(userId) {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    const { data: meds } = await supabase
        .from('medications')
        .select('id, nome')
        .eq('user_id', userId)
        .eq('ativo', true);

    if (!meds || meds.length === 0) return [];

    const medicationIds = meds.map(m => m.id);
    const medNomeMap = Object.fromEntries(meds.map(m => [m.id, m.nome]));

    const { data, error } = await supabase
        .from('dose_logs')
        .select('*')
        .in('medication_id', medicationIds)
        .eq('status', 'confirmado')
        .gte('taken_at', hoje.toISOString())
        .order('taken_at', { ascending: false });

    if (error) {
        console.error('Erro ao buscar doses confirmadas hoje:', error.message);
        return [];
    }

    return (data || []).map(d => ({
        ...d,
        medications: { nome: medNomeMap[d.medication_id], user_id: userId }
    }));
}
```

---

### 1.3 Nova função: `confirmarDoseRetroativa(doseLogId, motivo)`

Transição: `nao_informado` → `confirmado`. Decrementa estoque. Preenche trilha auditável.

```javascript
export async function confirmarDoseRetroativa(doseLogId, motivo) {
    const { data: log, error: fetchError } = await supabase
        .from('dose_logs')
        .select('*, medications(id, nome, estoque_atual)')
        .eq('id', doseLogId)
        .single();

    if (fetchError || !log) throw new Error(`Dose log não encontrado: ${doseLogId}`);
    if (log.status !== 'nao_informado') throw new Error(`Dose não está em nao_informado: ${log.status}`);

    const agora = new Date().toISOString();

    const { error: updateError } = await supabase
        .from('dose_logs')
        .update({
            status: 'confirmado',
            confirmed: true,
            taken_at: agora,
            revertido: true,
            revertido_at: agora,
            revertido_de: 'nao_informado',
            revertido_motivo: motivo || 'confirmação retroativa pelo usuário'
        })
        .eq('id', doseLogId);

    if (updateError) throw new Error(`Erro ao confirmar dose retroativa: ${updateError.message}`);
    console.log(`⏪ Dose confirmada retroativamente — log id: ${doseLogId}`);

    const estoque = log.medications?.estoque_atual;
    if (estoque !== null && estoque > 0) {
        await updateMedicationStock(log.medication_id, estoque - 1);
    }

    return log.medication_id;
}
```

---

### 1.4 Nova função: `reverterConfirmacao(doseLogId, motivo)`

Transição: `confirmado` → `pendente` (se `tentativas < 3`) ou `confirmado` → `nao_tomado` (se `tentativas >= 3`). Recrédita estoque (+1). Preenche trilha auditável.

**Importante:** não reseta `ultima_tentativa_at` nem `schedules`. O scheduler retoma o follow-up naturalmente com base nos intervalos já calculados, sem perder a referência do horário original cadastrado.

```javascript
export async function reverterConfirmacao(doseLogId, motivo) {
    const { data: log, error: fetchError } = await supabase
        .from('dose_logs')
        .select('*, medications(id, nome, estoque_atual)')
        .eq('id', doseLogId)
        .single();

    if (fetchError || !log) throw new Error(`Dose log não encontrado: ${doseLogId}`);
    if (log.status !== 'confirmado') throw new Error(`Dose não está confirmada: ${log.status}`);

    // < 3 tentativas: ainda pode ser tomada → pendente (re-entra no follow-up natural)
    // >= 3 tentativas: janela esgotada → nao_tomado (declaração definitiva)
    const novoStatus = (log.tentativas < 3) ? 'pendente' : 'nao_tomado';
    const agora = new Date().toISOString();

    const { error: updateError } = await supabase
        .from('dose_logs')
        .update({
            status: novoStatus,
            confirmed: false,
            taken_at: null,
            revertido: true,
            revertido_at: agora,
            revertido_de: 'confirmado',
            revertido_motivo: motivo || 'reversão solicitada pelo usuário'
        })
        .eq('id', doseLogId);

    if (updateError) throw new Error(`Erro ao reverter confirmação: ${updateError.message}`);
    console.log(`↩️ Confirmação revertida — log id: ${doseLogId}, novo status: ${novoStatus}`);

    // Recrédita estoque sobre o valor atual
    const estoque = log.medications?.estoque_atual;
    if (estoque !== null) {
        await updateMedicationStock(log.medication_id, estoque + 1);
    }

    return { medicationId: log.medication_id, novoStatus };
}
```

---

### 1.5 Extensão da função existente: `registrarNaoTomado`

Adicionar parâmetro opcional `doseLogId` para cobrir o caso retroativo (`nao_informado` → `nao_tomado`). O comportamento atual (busca por `medicationId`) é mantido intacto como fallback.

```javascript
export async function registrarNaoTomado(medicationId, doseLogId = null) {
    // Caso retroativo: dose específica por ID
    if (doseLogId) {
        const { data: log, error: fetchError } = await supabase
            .from('dose_logs')
            .select('id, status')
            .eq('id', doseLogId)
            .single();

        if (fetchError || !log) {
            console.log(`⚠️ Dose log não encontrado para registrarNaoTomado — id: ${doseLogId}`);
            return null;
        }

        // Auditoria só se não era pendente (pendente→nao_tomado é fluxo normal)
        const eraRetroativo = log.status !== 'pendente';
        const agora = new Date().toISOString();

        const { error } = await supabase
            .from('dose_logs')
            .update({
                status: 'nao_tomado',
                ...(eraRetroativo && {
                    revertido: true,
                    revertido_at: agora,
                    revertido_de: log.status,
                    revertido_motivo: 'usuário confirmou que não tomou'
                })
            })
            .eq('id', doseLogId);

        if (error) throw new Error(`Erro ao registrar nao_tomado retroativo: ${error.message}`);
        console.log(`🚫 Dose registrada como nao_tomado — log id: ${doseLogId}${eraRetroativo ? ' (retroativo)' : ''}`);
        return doseLogId;
    }

    // Caso normal: busca dose pendente mais recente por medicationId (comportamento original intacto)
    const { data: log, error: fetchError } = await supabase
        .from('dose_logs')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('status', 'pendente')
        .eq('confirmed', false)
        .order('scheduled_at', { ascending: false })
        .limit(1)
        .single();

    if (fetchError || !log) {
        console.log(`⚠️ Nenhum log pendente encontrado para registrarNaoTomado — medication: ${medicationId}`);
        return null;
    }

    const { error: updateError } = await supabase
        .from('dose_logs')
        .update({ status: 'nao_tomado' })
        .eq('id', log.id);

    if (updateError) throw new Error(`Erro ao registrar não tomado: ${updateError.message}`);
    console.log(`🚫 Dose registrada como nao_tomado — log id: ${log.id}`);
    return log.id;
}
```

---

## 2. prompts.js

### 2.1 Adicionar às actions disponíveis (seção "AÇÕES DISPONÍVEIS")

```
- CONFIRM_RETROATIVA: confirmar uma dose do passado que não foi registrada no momento
- REVERSE_CONFIRMATION: desfazer uma confirmação feita por engano
```

### 2.2 Adicionar à lista de formatos JSON de actions

```
- { "type": "CONFIRM_RETROATIVA",   "doseLogId": "" }   // ref-retro do bloco retroativo
- { "type": "REVERSE_CONFIRMATION", "doseLogId": "" }   // ref-conf do bloco confirmadas hoje
- { "type": "REGISTER_NAO_TOMADO",  "doseLogId": "" }   // retroativo: nao_informado → nao_tomado
- { "type": "REGISTER_NAO_TOMADO",  "medicationId": "" } // normal: dose pendente atual (inalterado)
```

### 2.3 Adicionar regras de uso — após as regras existentes de REGISTER_NAO_TOMADO

```
QUANDO USAR CONFIRM_RETROATIVA:
Use quando o usuário mencionar que tomou uma dose do passado que aparece no bloco
"DOSES SEM CONFIRMAÇÃO — ÚLTIMOS 2 DIAS". O fluxo obrigatório é em 2 etapas:
1. Apresente a dose ao usuário (nome + data + horário) e peça confirmação explícita.
2. Somente após "sim" / "isso" / "tomei" / "confirmo" → emita CONFIRM_RETROATIVA
   com o doseLogId do [ref-retro: ...] correspondente.
NUNCA emita CONFIRM_RETROATIVA sem confirmação explícita. Aguarde se necessário.

Se a referência temporal for além de 2 dias (ex: "tomei há 3 dias"), informe:
"Por consistência dos seus dados de saúde, consigo ajustar doses de até 2 dias atrás.
Quer que eu atualize seu estoque atual desse remédio?" → Se sim, use UPDATE_STOCK.

QUANDO USAR REVERSE_CONFIRMATION:
Use quando o usuário indicar que confirmou por engano uma dose do bloco
"DOSES CONFIRMADAS HOJE" (ex: "na verdade não tomei o X", "errei, não foi esse",
"confirmei sem querer"). A declaração do usuário já é suficiente — não peça
confirmação adicional. Use o doseLogId do [ref-conf: ...] correspondente.

REGISTER_NAO_TOMADO com doseLogId (retroativo):
Se o usuário disser que não tomou uma dose do bloco retroativo, use
REGISTER_NAO_TOMADO com o doseLogId do [ref-retro: ...] — não com medicationId.

SEPARAÇÃO ABSOLUTA DE CONTEXTOS — NUNCA cruzar os prefixos:
- [ref: ...]       → apenas CONFIRM_DOSE (dose pendente atual)
- [ref-retro: ...] → apenas CONFIRM_RETROATIVA ou REGISTER_NAO_TOMADO com doseLogId
- [ref-conf: ...]  → apenas REVERSE_CONFIRMATION
Cruzar contextos é um erro crítico de integridade de dado clínico.
```

---

## 3. principal.js

### 3.1 Adicionar novos imports

```javascript
import {
    // ... imports já existentes (confirmDose, confirmDoseByLogId, etc.) ...
    getDosesRetroativas,
    getDosesConfirmadasHoje,
    confirmarDoseRetroativa,
    reverterConfirmacao
} from '../database.js';
```

### 3.2 Fetch dos novos dados no início de `processMessage`

No início de `processMessage`, antes de `buildUserMessage`, adicionar:

```javascript
// Busca dados para os novos fluxos do ciclo de vida da dose
const [dosesRetroativas, dosesConfirmadasHoje] = await Promise.all([
    getDosesRetroativas(user.id, 2),
    getDosesConfirmadasHoje(user.id)
]);
```

Passar os dois novos arrays para `buildUserMessage`:

```javascript
const userMessage = buildUserMessage({
    text: message, image, user, state, medications, recentDoses,
    dosesRetroativas, dosesConfirmadasHoje,
    historicoConversa, intencaoNaoSuportada
});
```

### 3.3 Dois novos blocos em `buildUserMessage`

Adicionar `dosesRetroativas = []` e `dosesConfirmadasHoje = []` à assinatura da função. Inserir os dois blocos no template do context, logo após o bloco `=== DOSES AGUARDANDO CONFIRMAÇÃO ===` e antes de "Doses recentes":

```javascript
function buildUserMessage({ text, image, user, state, medications, recentDoses,
    dosesRetroativas = [], dosesConfirmadasHoje = [],
    historicoConversa = [], intencaoNaoSuportada = false }) {

    // ... lógica existente do bloco dosesPendentes — sem alterações ...

    // Bloco retroativo (Situação 1): doses nao_informado dos últimos 2 dias
    const blocoRetroativo = dosesRetroativas.length === 0 ? null :
        dosesRetroativas.map(d => {
            const nome = d.medications?.nome || 'medicamento';
            const scheduledDate = new Date(d.scheduled_at);
            const dataStr = scheduledDate.toLocaleDateString('pt-BR', {
                day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            const hora = scheduledDate.toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            return `⏰ ${nome} — dose de ${dataStr} às ${hora} [ref-retro: ${d.id}]`;
        }).join('\n');

    // Bloco confirmadas hoje (Situação 2): doses confirmadas hoje para reversão
    const blocoConfirmadasHoje = dosesConfirmadasHoje.length === 0 ? null :
        dosesConfirmadasHoje.map(d => {
            const nome = d.medications?.nome || 'medicamento';
            const hora = new Date(d.taken_at).toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            return `✅ ${nome} — confirmada às ${hora} [ref-conf: ${d.id}]`;
        }).join('\n');

    // No template literal do context, após o bloco === DOSES AGUARDANDO CONFIRMAÇÃO ===,
    // adicionar condicionalmente os dois novos blocos:

    // ${blocoRetroativo ? `
// === DOSES SEM CONFIRMAÇÃO — ÚLTIMOS 2 DIAS ===
// ${blocoRetroativo}
//
// Como usar este bloco:
// - Se o usuário mencionar ter tomado uma dose do passado (ex: "tomei o ômega 3 de ontem",
//   "tomei os remédios de anteontem"), apresente a dose específica ao usuário e PEÇA
//   CONFIRMAÇÃO EXPLÍCITA antes de registrar. Aguarde "sim" / "isso" / "tomei".
// - Após confirmação explícita → CONFIRM_RETROATIVA com o [ref-retro: ...] correspondente.
// - Se o usuário disser que não tomou → REGISTER_NAO_TOMADO com o [ref-retro: ...].
// - Se a referência for além de 2 dias → informe o limite e ofereça UPDATE_STOCK.
// - NUNCA use [ref-retro: ...] em CONFIRM_DOSE. Contextos completamente separados.
// ` : ''}

    // ${blocoConfirmadasHoje ? `
// === DOSES CONFIRMADAS HOJE ===
// ${blocoConfirmadasHoje}
//
// Como usar este bloco:
// - Se o usuário disser que NÃO tomou um medicamento listado aqui (ex: "na verdade não
//   tomei o X", "errei, não foi esse", "confirmei sem querer"), emita REVERSE_CONFIRMATION
//   com o [ref-conf: ...] correspondente. A declaração já é suficiente, não peça confirmação.
// - NUNCA use [ref-conf: ...] em CONFIRM_DOSE ou CONFIRM_RETROATIVA.
// ` : ''}
}
```

**Nota de implementação:** os dois blocos são condicionais — o bloco inteiro (incluindo o cabeçalho e as instruções) só aparece no context quando há dados. Quando os arrays estão vazios, nada é injetado no prompt. Isso mantém o context enxuto para usuários sem histórico de doses a ajustar.

### 3.4 Novos handlers em `processAction` + extensão do existente

#### Novo case: CONFIRM_RETROATIVA

```javascript
case 'CONFIRM_RETROATIVA': {
    if (!action.doseLogId) {
        console.warn('⚠️ CONFIRM_RETROATIVA sem doseLogId — ignorando');
        return null;
    }
    let medId;
    try {
        medId = await confirmarDoseRetroativa(
            action.doseLogId,
            'usuário confirmou retroativamente via chat'
        );
    } catch (e) {
        console.error('⚠️ Erro em CONFIRM_RETROATIVA:', e.message);
        return null;
    }
    // Verificar alerta de estoque — mesmo padrão do CONFIRM_DOSE
    try {
        const estoqueInfo = await getEstoqueInfoParaAlerta(medId);
        if (estoqueInfo) {
            const confirmacoesDoDia = await contarConfirmacoesHoje(medId);
            const deveAlertar = calcularAlertaEstoque({
                diasRestantes: estoqueInfo.diasRestantes,
                tipo_tratamento: estoqueInfo.tipo_tratamento,
                tratamento_dias: estoqueInfo.tratamento_dias,
                confirmacoesDoDia
            });
            if (deveAlertar) {
                return { alertaEstoque: buildAlertaEstoqueMessage(estoqueInfo) };
            }
        }
    } catch (e) {
        console.error('⚠️ Erro ao verificar alerta pós-CONFIRM_RETROATIVA:', e.message);
    }
    return null;
}
```

#### Novo case: REVERSE_CONFIRMATION

```javascript
case 'REVERSE_CONFIRMATION': {
    if (!action.doseLogId) {
        console.warn('⚠️ REVERSE_CONFIRMATION sem doseLogId — ignorando');
        return null;
    }
    try {
        const { novoStatus } = await reverterConfirmacao(
            action.doseLogId,
            'usuário informou que confirmação foi por engano'
        );
        console.log(`↩️ Confirmação revertida via chat — novo status: ${novoStatus}`);
    } catch (e) {
        console.error('⚠️ Erro em REVERSE_CONFIRMATION:', e.message);
    }
    return null;
}
```

#### Case existente substituído: REGISTER_NAO_TOMADO

Substituir o case atual por esta versão que suporta `doseLogId`:

```javascript
case 'REGISTER_NAO_TOMADO':
    if (action.doseLogId) {
        await registrarNaoTomado(null, action.doseLogId);
        console.log(`🚫 Dose retroativa registrada como não tomada — doseLogId: ${action.doseLogId}`);
    } else if (action.medicationId) {
        await registrarNaoTomado(action.medicationId);
        console.log(`🚫 Dose registrada como não tomada — medicationId: ${action.medicationId}`);
    } else {
        console.warn('⚠️ REGISTER_NAO_TOMADO sem doseLogId nem medicationId — ignorando');
    }
    return null;
```

---

## 4. router.js — atualização obrigatória do inventário

Padrão de engenharia v10: sempre que uma capacidade do agente_principal for adicionada, o inventário em `classificarIntencaoComContexto` deve ser atualizado na mesma alteração para evitar misclassificação.

Localizar a descrição do agente_principal no prompt de `classificarIntencaoComContexto` e adicionar as novas capacidades:

```
// Exemplo do ajuste no inventário:
// Antes: "confirmação de doses, consultas gerais, estoque"
// Depois: "confirmação de doses, confirmação retroativa de doses (últimos 2 dias),
//          reversão de confirmação, consultas gerais, estoque"
```

O texto exato deve seguir o estilo já existente no arquivo. Ajustar mantendo coerência com o restante do inventário.

---

## Cenários de validação obrigatória após deploy

Testar no WhatsApp em sequência:

**S1 — Confirmação retroativa básica:**
1. Deixar dose virar `nao_informado` (ou atualizar manualmente no Supabase SQL Editor)
2. Usuário: "tomei o [remédio] de ontem"
3. Esperado: Nami apresenta a dose específica e pede confirmação explícita
4. Usuário: "sim"
5. Verificar no Supabase: `status = 'confirmado'`, `revertido = true`, `revertido_de = 'nao_informado'`, estoque decrementado

**S1b — Referência além da janela:**
1. Usuário: "tomei o [remédio] de 3 dias atrás"
2. Esperado: Nami informa o limite de 2 dias e oferece UPDATE_STOCK

**S1c — Não tomei retroativo:**
1. Dose em `nao_informado`
2. Usuário: "não tomei o [remédio] de ontem"
3. Verificar no Supabase: `status = 'nao_tomado'`, `revertido = true`, `revertido_de = 'nao_informado'`

**S2 — Reversão dentro da janela (`tentativas < 3`):**
1. Confirmar 2 doses de vez
2. Verificar no Supabase que ambas estão `confirmado`, estoque decrementado
3. Usuário: "na verdade não tomei o [remédio X]"
4. Verificar no Supabase: `status = 'pendente'`, `confirmed = false`, `revertido = true`, `revertido_de = 'confirmado'`, estoque +1

**S2b — Reversão fora da janela (`tentativas >= 3`):**
1. Mesma setup, mas com dose que teve 3 tentativas
2. Usuário: "na verdade não tomei"
3. Verificar no Supabase: `status = 'nao_tomado'` (não `pendente`), estoque +1

**S3 — Isolamento de contextos (crítico):**
1. Dose `pendente` hoje E dose `nao_informado` de ontem simultaneamente
2. Usuário: "tomei de ontem"
3. Esperado: Nami pergunta sobre a dose retroativa de ontem — NÃO confirma a dose pendente de hoje

---

## Fora de escopo neste briefing

- Confirmação de doses com mais de 2 dias de atraso
- Reversão de confirmação de dias anteriores (só hoje)
- Reset de `ultima_tentativa_at` ou reativação de lembretes (schedulers intocados por design)
- Alterações no agente_lembrete
- Impacto de `revertido = true` nos relatórios de adesão (backlog — MH-037)