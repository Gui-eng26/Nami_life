# BRIEFING — Confirmação de dose: âncora estruturada + migração para doseLogId

**Sessão:** v10 — 26/06/2026
**Arquivos afetados:** `src/agentes/principal.js`, `src/prompts.js`
**Não toca:** scheduler, lembrete, fast-path do reply (BUG-029)

---

## Contexto e causa raiz (já confirmada por dados)

O Briefing 3 injetou `historicoConversa` no contexto do `principal`. Esse histórico vem do `agent_logs`, que **não contém os lembretes do scheduler** (disparados pelo cron, fora do roteador). Resultado: o `principal` recebia um "Sim" acompanhado de um histórico onde a pergunta "Já tomou?" não aparecia — o "Sim" ficava órfão e era lido como social.

**Medições que confirmam:**
- Pré-Briefing 3: "Sim" confirmava dose em 100% dos casos
- Pós-Briefing 3 (com histórico): ~64% de falha
- Pós-remoção do histórico do principal: 10/10 confirmaram (0% falha), múltiplos usuários

A remoção do histórico do `principal` (já deployada) restaurou a confirmação. Mas removeu também a continuidade conversacional ("ok" de fechamento, "dele"). Este briefing implementa a solução estrutural que blinda a confirmação de dose **sem depender de histórico**, permitindo devolver a continuidade com segurança.

---

## Princípio da solução: âncora estruturada, não estado rígido

A informação da dose pendente já chega ao `principal` (via `recentDoses`), mas como **JSON cru misturado** (`JSON.stringify(recentDoses.slice(0,5))`) com todos os status juntos. O `principal` precisa garimpar qual está pendente — frágil, facilmente ofuscado por outros sinais (como o histórico foi).

A solução é apresentar as doses pendentes como um **bloco estruturado, destacado, com instrução de uso clara** — a mesma riqueza que os medicamentos já recebem no contexto. Isso dá a âncora que o "Sim" precisa, sem criar um estado conversacional rígido que trave o fluxo.

**Por que NÃO um estado `aguardando_confirmacao_dose` no lembrete:** um estado rígido criaria rua sem saída. Se a última mensagem da Nami foi um alerta de estoque e o usuário responde "comprei mais 20 cps", um estado que só espera confirmação de dose trava. O bloco estruturado informa sem aprisionar: se o usuário confirma, registra; se fala de outra coisa, ajuda normalmente e a dose segue pendente.

---

## Parte 1 — Bloco estruturado de doses pendentes no `buildUserMessage`

Em `principal.js`, `buildUserMessage`, substituir a apresentação crua das doses recentes.

**Hoje:**
```javascript
Doses recentes: ${recentDoses.length === 0
    ? 'nenhuma ainda'
    : JSON.stringify(recentDoses.slice(0, 5))
}
```

**Novo — separar doses pendentes (destaque) de doses recentes (contexto):**
```javascript
// Doses pendentes de confirmação (reminder enviado, não confirmado, não expirado)
const dosesPendentes = recentDoses.filter(d =>
    d.reminder_sent === true &&
    d.confirmed === false &&
    d.status !== 'nao_informado' &&
    d.status !== 'pausado' &&
    d.status !== 'nao_tomado' &&
    d.status !== 'sem_estoque'
);

const blocoPendentes = dosesPendentes.length === 0
    ? 'Nenhuma dose aguardando confirmação no momento.'
    : dosesPendentes.map(d => {
        const nome = d.medications?.nome || 'medicamento';
        const hora = new Date(d.scheduled_at).toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        return `⚠️ ${nome} — dose das ${hora} [ref: ${d.id}]`;
    }).join('\n');
```

E no template de contexto, adicionar um bloco dedicado e destacado (separado de "Doses recentes", que continua existindo para contexto histórico):

```
=== DOSES AGUARDANDO CONFIRMAÇÃO ===
${blocoPendentes}

Como usar este bloco:
- Se o usuário responder confirmando que tomou (qualquer forma: "sim", "tomei", "já tomei", "isso", "tomei sim", etc.), emita CONFIRM_DOSE para a(s) dose(s) correspondente(s), usando o valor [ref: ...] no campo doseLogId.
- Se houver várias doses pendentes e o usuário confirmar coletivamente ("tomei todos", "tomei os dois"), emita um CONFIRM_DOSE para cada [ref] da lista.
- Se o usuário mencionar um medicamento ou horário específico, confirme apenas a dose correspondente.
- Se o usuário falar de OUTRA coisa (estoque, horário, dúvida, "comprei mais X"), ajude normalmente com o assunto dele. NÃO force confirmação. As doses continuam pendentes e serão cobradas depois.
```

**Manter "Doses recentes" como bloco separado** (contexto histórico, sem destaque) — útil para o LLM entender o panorama, mas não é mais a fonte da confirmação.

---

## Parte 2 — Migrar CONFIRM_DOSE de `medicationId` para `doseLogId` (com retrocompatibilidade)

### Por que migrar (investigação histórica)

`confirmDose(medicationId)` existe desde o primeiro commit. Foi a escolha original e adequada quando havia uma dose pendente por medicamento: a heurística "pega a mais recente não confirmada daquele medicamento" (`order by scheduled_at desc, limit 1`) resolvia o caso comum.

`confirmDoseByLogId(doseLogId)` foi adicionada depois (commit 5f7c010, BUG-029) para o fast-path do reply, onde o id da dose era conhecido com precisão.

**O problema atual:** no cenário de mesmo medicamento com dois horários pendentes (ex: Dipirona 08:00 e 14:00), `confirmDose(medicationId)` confirma sempre a mais recente (14:00). Se o usuário tomou a das 8, a dose errada é registrada. A limitação inofensiva no início virou bug latente com múltiplas doses.

Agora que o bloco estruturado (Parte 1) expõe o `dose_log.id` ao `principal`, o caminho principal passa a ter a informação que antes só o fast-path tinha. Migrar para `doseLogId` estende a precisão ao caminho principal.

### ⚠️ Cuidado registrado: fast-path NÃO validado

`confirmDoseByLogId` é tecnicamente sólida (update por id — operação determinística simples). Mas o **caminho que a aciona hoje (fast-path do reply) NÃO está validado em produção** — por causa do BUG-029 (namespace de id do reply do WhatsApp não casa: `zaapId` 019E... salvo vs `referenceMessageId` 3EB0... recebido).

**A fonte do `doseLogId` no nosso desenho é diferente e não depende do reply:** o id vem do bloco estruturado que montamos do banco (`getRecentDoses`), não do `referenceMessageId` do Z-API. Não passa pelo namespace problemático. Controlamos a geração do id de ponta a ponta (banco → prompt → CONFIRM_DOSE).

**Este briefing NÃO toca o fast-path do reply.** Ele permanece como está (limitação conhecida, BUG-029). Escopo limpo.

### Implementação com retrocompatibilidade

**`processAction` em `principal.js`** — aceitar ambos, com `doseLogId` tendo precedência:

```javascript
case 'CONFIRM_DOSE':
    if (action.doseLogId) {
        // Caminho novo: confirmação precisa por id da dose
        await confirmDoseByLogId(action.doseLogId);
    } else if (action.medicationId) {
        // Fallback retrocompatível: confirmação por medicamento (mais recente não confirmada)
        await confirmDose(action.medicationId);
    } else {
        console.warn('⚠️ CONFIRM_DOSE sem doseLogId nem medicationId');
        return null;
    }

    // Alerta de estoque pós-confirmação — usar medication_id resolvido
    try {
        // Se veio por doseLogId, precisamos do medication_id para o alerta.
        // confirmDoseByLogId já tem o medication_id internamente; expor via retorno
        // ou buscar aqui. Ver nota de implementação abaixo.
        const medId = action.medicationId || await getMedicationIdFromDoseLog(action.doseLogId);
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
        console.error('⚠️ Erro ao verificar alerta de estoque pós-confirmação:', e.message);
    }
    return null;
```

**Nota de implementação — `medication_id` para o alerta de estoque:** quando a confirmação vem por `doseLogId`, ainda precisamos do `medication_id` para o alerta de estoque. Duas opções (escolher a mais limpa):
- (a) `confirmDoseByLogId` retorna o `medication_id` do log confirmado (modificar o `return` da função), ou
- (b) criar helper `getMedicationIdFromDoseLog(doseLogId)`.
Preferir (a) — `confirmDoseByLogId` já busca o log internamente (`select('*, medications(...)')`), então tem o `medication_id` em mãos; basta retorná-lo. Evita uma query extra.

### Atualização do prompt (`prompts.js`)

O prompt instrui CONFIRM_DOSE com `medicationId`. Atualizar para `doseLogId` como campo primário, mantando exemplos claros.

**Trecho de múltiplas doses — hoje:**
```
"actions": [
  { "type": "CONFIRM_DOSE", "medicationId": "id_do_dorforte" },
  { "type": "CONFIRM_DOSE", "medicationId": "id_da_losartana" }
]
```

**Novo:**
```
"actions": [
  { "type": "CONFIRM_DOSE", "doseLogId": "ref_da_dose_1" },
  { "type": "CONFIRM_DOSE", "doseLogId": "ref_da_dose_2" }
]
```

E na REGRA DE MÁXIMA PRIORIDADE, instruir explicitamente: usar o valor `[ref: ...]` do bloco "DOSES AGUARDANDO CONFIRMAÇÃO" como `doseLogId`. Manter a menção de que, se por algum motivo o ref não estiver disponível, pode usar `medicationId` (retrocompatibilidade — o sistema aceita ambos).

Atualizar também a seção de formato de actions (linha ~116) para incluir `doseLogId`:
```
- { "type": "CONFIRM_DOSE", "doseLogId": "" }   // preferencial
- { "type": "CONFIRM_DOSE", "medicationId": "" } // fallback retrocompatível
```

---

## Parte 3 — Reintroduzir histórico conversacional no `principal` (com precedência clara)

Agora que a confirmação de dose tem âncora estruturada própria (Parte 1), o `historicoConversa` pode voltar ao `principal` para resolver "ok" de fechamento e "dele" — sem reintroduzir a regressão, porque a confirmação não depende mais do histórico.

**Readicionar o bloco de histórico ao `buildUserMessage`**, mas posicionado DEPOIS do bloco de doses pendentes e com precedência explícita no prompt:

```
=== CONVERSA RECENTE (apenas para entender referências como "ele", "esse", "ok") ===
${formatarHistoricoConversa(historicoConversa)}

IMPORTANTE: O bloco "DOSES AGUARDANDO CONFIRMAÇÃO" tem precedência. Se há dose pendente
e o usuário responde algo afirmativo, isso é confirmação de dose — não trate como fechamento
social, mesmo que a conversa recente sugira fim de papo. Use a CONVERSA RECENTE apenas para
resolver pronomes e reconhecer fechamentos quando NÃO há dose pendente.
```

**Decisão a validar:** a reintrodução do histórico é o ponto de maior risco de regressão. Recomendação: implementar Partes 1 e 2 primeiro, validar a confirmação em produção, e só então reintroduzir o histórico (Parte 3) como passo separado — isolando a variável, como fizemos para diagnosticar. Se a Parte 3 reintroduzir qualquer falha de confirmação, sabemos exatamente a causa.

**Sugestão de faseamento:**
- Deploy A: Partes 1 + 2 (âncora estruturada + doseLogId). Validar confirmação.
- Deploy B: Parte 3 (histórico de volta). Validar que confirmação permanece 100% E que "ok"/"dele" voltam a funcionar.

---

## Validação esperada

**Confirmação de dose (Partes 1+2):**
1. Lembrete → "Sim" → confirma na primeira tentativa (estado idle) ✅
2. Variações ("tomei", "já tomei", "isso", "pode crer") → confirmam ✅
3. Cenário 2 (Dipirona 08:00 e 14:00 pendentes) → "tomei a das 8" confirma a dose das 08:00 especificamente (não a das 14:00) ✅
4. "Tomei os dois" (duas doses pendentes) → confirma ambas pelos ids ✅
5. Última msg foi alerta de estoque → "comprei mais 20 cps" → trata como estoque, NÃO força confirmação, dose segue pendente ✅

**Retrocompatibilidade:**
6. CONFIRM_DOSE emitido com `medicationId` (sem doseLogId) → ainda confirma via fallback ✅

**Continuidade (Parte 3, deploy B):**
7. "Ômega 3 registrado. Continue assim" → "ok" → fechamento acolhedor, sem reiniciar ✅
8. "quais horários dele?" após mencionar medicamento → resolve o pronome ✅
9. Com dose pendente + "sim" → ainda confirma (precedência do bloco de doses) ✅

**Não regressão:**
10. Confirmação coletiva "tomei todos" segue funcionando ✅
11. Fast-path do reply intocado (BUG-029 permanece como limitação conhecida) ✅

---

## Resumo das alterações

| O que muda | Onde | Parte |
|---|---|---|
| Bloco estruturado "DOSES AGUARDANDO CONFIRMAÇÃO" com [ref: id] | `principal.js` buildUserMessage | 1 |
| Manter "Doses recentes" como contexto separado | `principal.js` | 1 |
| CONFIRM_DOSE aceita doseLogId (precedência) + medicationId (fallback) | `principal.js` processAction | 2 |
| `confirmDoseByLogId` retorna medication_id (para alerta estoque) | `database.js` | 2 |
| Prompt: CONFIRM_DOSE usa doseLogId primário, medicationId fallback | `prompts.js` | 2 |
| Reintroduzir histórico com precedência do bloco de doses | `principal.js` + `prompts.js` | 3 (deploy B) |

---

**Comando para Claude Code (Deploy A — Partes 1+2):**
`Leia o briefings/BRIEFING_CONFIRMACAO_HIBRIDA.md e implemente APENAS as Partes 1 e 2 (âncora estruturada + migração doseLogId com retrocompatibilidade). NÃO implemente a Parte 3 ainda. NÃO toque no fast-path do reply.`

Após validação em produção, Deploy B (Parte 3) será liberado separadamente.