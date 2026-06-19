# BRIEFING: BUG-040 — Confirmação de múltiplas doses não é registrada

**Data:** 19/06/2026  
**Sessão:** v9  
**Prioridade:** CRÍTICA — afeta diretamente o registro de adesão, núcleo de valor da Nami  
**Arquivos afetados:** `src/agentes/principal.js`, `src/prompts.js`  
**Sem alteração de banco de dados**

---

## Contexto e causa raiz — confirmada por código E dados

### Sintoma
Quando um usuário tem múltiplos medicamentos no mesmo horário (ou em horários próximos) e tenta confirmar todos de uma vez ("tomei todos", "tomei os dois", "sim para todos"), a Nami responde corretamente reconhecendo a intenção ("Vou confirmar os três!"), mas **nenhuma dose é registrada no banco**. Os lembretes continuam disparando como se o usuário não tivesse respondido.

### Evidência dos dados (usuário Wellington — 3 medicamentos no horário da manhã)
Doses do horário da manhã (08:28 Dorforte + 08:28 Losartana + 08:58 Testefarma), em 4 dias seguidos:

| Data | Resultado de TODAS as 3 doses |
|---|---|
| 16/06 | nao_informado |
| 17/06 | nao_informado |
| 18/06 | nao_informado |
| 19/06 | nao_informado |

Em contraste, doses isoladas (sem colisão de horário) confirmam normalmente:
- 17/06 15:28 Dorforte sozinho → confirmado
- 16/06 15:28 Dorforte sozinho → confirmado
- 16/06 20:58 Testefarma sozinho → confirmado

O padrão é inequívoco: **confirmação de dose única funciona; confirmação de múltiplas doses falha completamente.**

### Causa raiz no código
O contrato do agente_principal permite **uma única ação por resposta**. Em `prompts.js`:
```
"action": null  // ou um único objeto
```
E em `principal.js`, `handlePrincipal` processa apenas uma ação:
```javascript
if (claudeResponse.action) {
    const override = await processAction(claudeResponse.action, user);
    ...
}
```

Quando o usuário confirma N doses, o Claude precisaria emitir N ações `CONFIRM_DOSE` com N `medicationId` diferentes — mas o contrato só comporta uma. O resultado observado é que ele acaba não emitindo nenhuma confirmação válida (a mensagem amigável é gerada, mas o `action` fica `null` ou inválido), e nenhuma dose é registrada.

---

## Solução: contrato de ações em lote (`actions` array)

A correção transforma o campo singular `action` em um campo `actions` que aceita uma lista de ações. O agente percorre a lista e executa cada uma. Para não quebrar nada, o código mantém **compatibilidade com o formato singular antigo**.

---

## Mudança 1 — `src/prompts.js`

### 1a. Atualizar o formato de resposta

**Localizar:**
```
FORMATO DE RESPOSTA — SEMPRE JSON VÁLIDO, sem texto fora, sem markdown, sem backticks:
{
  "message": "texto da mensagem para enviar ao usuário",
  "newState": "idle | confirming",
  "context": {},
  "action": null
}

O campo action pode ser:
- null
- { "type": "CONFIRM_DOSE", "medicationId": "" }
- { "type": "REGISTER_NAO_TOMADO", "medicationId": "" }
- { "type": "SET_USER_NAME", "name": "" }
- { "type": "UPDATE_STOCK", "medicationId": "", "quantidade": 0 }
```

**Substituir por:**
```
FORMATO DE RESPOSTA — SEMPRE JSON VÁLIDO, sem texto fora, sem markdown, sem backticks:
{
  "message": "texto da mensagem para enviar ao usuário",
  "newState": "idle | confirming",
  "context": {},
  "actions": []
}

O campo actions é uma LISTA (array) de ações. Pode conter zero, uma ou várias ações.
Cada ação na lista pode ser:
- { "type": "CONFIRM_DOSE", "medicationId": "" }
- { "type": "REGISTER_NAO_TOMADO", "medicationId": "" }
- { "type": "SET_USER_NAME", "name": "" }
- { "type": "UPDATE_STOCK", "medicationId": "", "quantidade": 0 }

Se nenhuma ação for necessária, retorne "actions": [] (lista vazia).
```

### 1b. Adicionar regra explícita sobre confirmação de múltiplas doses

**Localizar a seção "REGRA DE MÁXIMA PRIORIDADE — CONFIRMAÇÃO DE DOSE"** e adicionar ao final dela (antes da próxima seção "REGRA IMPORTANTE — CONSULTAS"):

```
CONFIRMAÇÃO DE MÚLTIPLAS DOSES (MUITO IMPORTANTE):
Quando houver MAIS DE UMA dose aguardando confirmação (vários dose_logs com
reminder_sent = true e confirmed = false) E o usuário confirmar de forma coletiva
("tomei todos", "tomei os dois", "tomei os três", "sim para todos", "tomei tudo",
"já tomei todos"), você DEVE emitir UMA ação CONFIRM_DOSE para CADA medicamento
pendente, todas na lista "actions".

Exemplo: se há 3 doses pendentes (Dorforte, Losartana, Testefarma) e o usuário diz
"tomei todos", retorne:
"actions": [
  { "type": "CONFIRM_DOSE", "medicationId": "id_do_dorforte" },
  { "type": "CONFIRM_DOSE", "medicationId": "id_da_losartana" },
  { "type": "CONFIRM_DOSE", "medicationId": "id_do_testefarma" }
]

Se o usuário confirmar apenas ALGUNS medicamentos por nome ("tomei o Dorforte e a
Losartana"), emita CONFIRM_DOSE apenas para os mencionados.

Identifique os medicationId corretos a partir do contexto de doses recentes e
medicamentos cadastrados. Use SEMPRE o id real do medicamento.
```

---

## Mudança 2 — `src/agentes/principal.js`

### 2a. Processar a lista de ações com compatibilidade retroativa

**Localizar:**
```javascript
    if (claudeResponse.action) {
        const override = await processAction(claudeResponse.action, user);
        if (override) {
            if (override.alertaEstoque) {
                claudeResponse = {
                    ...claudeResponse,
                    message: claudeResponse.message + override.alertaEstoque
                };
            } else {
                claudeResponse = { ...claudeResponse, ...override };
            }
        }
    }
```

**Substituir por:**
```javascript
    // Compatibilidade: aceita tanto o formato novo (actions: array)
    // quanto o formato antigo (action: objeto único)
    let listaAcoes = [];
    if (Array.isArray(claudeResponse.actions)) {
        listaAcoes = claudeResponse.actions;
    } else if (claudeResponse.action) {
        listaAcoes = [claudeResponse.action];
    }

    // Processa todas as ações em sequência.
    // Alertas de estoque de cada confirmação são acumulados e anexados à mensagem.
    let alertasEstoque = '';
    for (const acao of listaAcoes) {
        const override = await processAction(acao, user);
        if (override) {
            if (override.alertaEstoque) {
                alertasEstoque += override.alertaEstoque;
            } else {
                claudeResponse = { ...claudeResponse, ...override };
            }
        }
    }
    if (alertasEstoque) {
        claudeResponse = {
            ...claudeResponse,
            message: claudeResponse.message + alertasEstoque
        };
    }
```

Nenhuma alteração é necessária na função `processAction` — ela já processa uma ação por chamada, e agora é chamada uma vez por ação na lista.

---

## Notas de implementação

- **Compatibilidade total:** o código aceita tanto `actions` (array, novo) quanto `action` (objeto, antigo). Se o Claude ainda retornar o formato antigo em algum caso, continua funcionando.
- **Sem alteração de banco:** cada `CONFIRM_DOSE` chama `confirmDose(medicationId)` que já existe e funciona — apenas passa a ser chamada N vezes.
- **Alerta de estoque em lote:** se múltiplas confirmações gerarem alertas de estoque, todos são acumulados e anexados à mensagem final. Isso é aceitável — o usuário vê todos os avisos relevantes de uma vez.
- **Decremento de estoque:** cada `confirmDose` decrementa o estoque do seu medicamento individualmente — comportamento correto.

---

## Verificação pós-implementação

**Teste 1 — confirmação coletiva de múltiplas doses:**
1. Usuário com 3 medicamentos no mesmo horário recebe os 3 lembretes
2. Responder: "tomei todos"
3. **Esperado:** Nami confirma os 3 E os 3 dose_logs ficam `confirmed: true` no banco
4. **Verificar no Supabase:** os 3 registros do horário com `status: confirmado`, `taken_at` preenchido
5. **Verificar:** os lembretes NÃO voltam a disparar para essas doses

**Teste 2 — confirmação parcial por nome:**
1. Usuário com 3 doses pendentes
2. Responder: "tomei o Dorforte e a Losartana"
3. **Esperado:** apenas Dorforte e Losartana confirmados; Testefarma continua pendente

**Teste 3 — confirmação de dose única (regressão):**
1. Usuário com 1 dose pendente
2. Responder: "tomei"
3. **Esperado:** funciona exatamente como antes — 1 dose confirmada

**Teste 4 — verificar formato no log:**
Após "tomei todos", verificar no Railway que o Claude retornou `actions` com múltiplos itens. Se ainda retornar `action` singular, o prompt precisa de reforço.

---

## Observação para o backlog (não implementar agora)

Este BUG-040 resolve a **confirmação** de múltiplas doses. Há um problema relacionado de **entrega** — MH-032 (design de lembretes agrupados por horário) — em que os lembretes de medicamentos do mesmo horário deveriam ser agrupados em uma única mensagem em vez de N mensagens separadas. O BUG-040 é pré-requisito do MH-032: só faz sentido agrupar a entrega depois que sabemos processar a confirmação agrupada. Os dados mostram que a janela de agrupamento deve considerar uma tolerância de tempo (ex: doses entre 08:28 e 08:58 são percebidas como "do mesmo momento" pelo usuário), não horário exato.