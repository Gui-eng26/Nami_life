# BRIEFING — BUG-036
## detectarConfirmacaoDose confirma doses não tomadas + ausência de DENY_DOSE

**Data:** 17/06/2026  
**Origem:** Análise de logs Railway (linhas 446–473) + prints de interação com Vitor  
**Escopo:** `src/router.js`, `src/prompts.js`, `src/database.js`, `src/agentes/principal.js`  
**Complexidade:** Média — sem alteração de banco, sem novos agentes  
**Impacto:** CRÍTICO — corrompe dados de adesão com doses marcadas como tomadas que não foram

---

## 1. Causa Raiz Confirmada

### Problema A — `detectarConfirmacaoDose` faz match em substrings sem contexto negativo

```js
// ATUAL — usa .includes() sem verificar negação
const termos = ['sim', 'tomei', 'já tomei', 'pode', 'ok', ...];
return termos.some(t => msg.includes(t));
```

**"Eu não tomei, não vou mais tomar"** → `.includes('tomei')` → **TRUE** → roteado para principal como confirmação de dose → Claude retornou `CONFIRM_DOSE` → dose marcada como tomada no banco.

Evidência direta (logs linha 469–473):
```
📩 "Eu não tomei, não vou mais tomar"
💊 Confirmação de dose detectada, roteando para principal
✅ Claude respondeu — action: CONFIRM_DOSE
✅ Dose confirmada — log id: 65c36be1...
```

### Problema B — Ausência da action `REGISTER_NAO_TOMADO` no prompt

Quando o Claude setou `newState: confirming` após Vitor dizer que não ia tomar, e Vitor respondeu "Pode registrar" (querendo registrar que NÃO tomou), o Claude não tinha nenhuma action disponível para isso. Com apenas `CONFIRM_DOSE` no repertório, usou a mais próxima semanticamente → registrou dose como tomada. Resultado: dado errado no banco.

---

## 2. Por que isso é grave

- Doses marcadas como `confirmado` no banco que nunca foram tomadas
- Taxa de adesão inflada artificialmente
- Estoque decrementado incorretamente (o medicamento "tomado" nunca saiu do estoque real)
- Follow-ups não são disparados porque a dose aparece como confirmada

---

## 3. Solução

### 3.1 — Filtro de negação em `detectarConfirmacaoDose` (`router.js`)

Antes de verificar termos positivos, checar se a mensagem contém negação. **Negação tem prioridade** — é melhor perder uma confirmação (false negative, recuperável via follow-up) do que confirmar uma dose não tomada (false positive, corrompendo dados).

```js
// ANTES
function detectarConfirmacaoDose(message) {
    if (!message) return false;
    const termos = ['sim', 'tomei', 'já tomei', 'pode', 'ok', 'claro',
        'feito', 'tá', 'foi', 'tomei sim', 'já tomei sim'];
    const msg = message.toLowerCase().trim();
    return termos.some(t => msg.includes(t));
}

// DEPOIS
function detectarConfirmacaoDose(message) {
    if (!message) return false;
    const msg = message.toLowerCase().trim();

    // PRIMEIRO: negação explícita invalida qualquer confirmação
    // Prioridade à negação — falso negativo é recuperável via follow-up;
    // falso positivo corrompe dados de adesão
    const negacoes = [
        'não tomei', 'nao tomei',
        'não vou tomar', 'nao vou tomar',
        'não vou mais', 'nao vou mais',
        'ainda não tomei', 'ainda nao tomei',
        'não tomou', 'nao tomou',
        'não consigo tomar', 'nao consigo tomar',
        'não consigo', 'nao consigo'
    ];
    if (negacoes.some(n => msg.includes(n))) return false;

    // Termos positivos de confirmação
    const termos = ['sim', 'tomei', 'já tomei', 'pode', 'ok', 'claro',
        'feito', 'tá', 'foi', 'tomei sim', 'já tomei sim'];
    return termos.some(t => msg.includes(t));
}
```

**Atenção:** "pode" permanece na lista positiva. "Pode registrar" sem negação preexistente no estado da conversa é tratado pelo problema B abaixo (action `REGISTER_NAO_TOMADO` no prompt). A detecção do "pode" em si é correta — o problema era o Claude não ter a action certa para executar.

---

### 3.2 — Nova action `REGISTER_NAO_TOMADO` (`prompts.js`)

Localizar a seção `AÇÕES DISPONÍVEIS` e adicionar:

```
// ANTES
AÇÕES DISPONÍVEIS:
- CONFIRM_DOSE: confirmar que o usuário tomou a dose
- SET_USER_NAME: salvar o nome do usuário
- UPDATE_STOCK: atualizar estoque de medicamento após recompra

// DEPOIS
AÇÕES DISPONÍVEIS:
- CONFIRM_DOSE: confirmar que o usuário tomou a dose
- REGISTER_NAO_TOMADO: registrar que o usuário decidiu explicitamente não tomar a dose
- SET_USER_NAME: salvar o nome do usuário
- UPDATE_STOCK: atualizar estoque de medicamento após recompra
```

Localizar a seção de exemplos de `action` no JSON e adicionar:

```json
- { "type": "REGISTER_NAO_TOMADO", "medicationId": "" }
```

Adicionar IMEDIATAMENTE APÓS a explicação de CONFIRM_DOSE o seguinte bloco:

```
QUANDO USAR REGISTER_NAO_TOMADO:
Use REGISTER_NAO_TOMADO quando o usuário EXPLICITAMENTE declarar que não vai tomar
a dose E pedir para registrar isso. Sinais claros:
- "pode registrar que não tomei"
- "não vou mais tomar, registra aí"
- "pode registrar" (quando o contexto da conversa é de não-tomada — newState estava
   "confirming" após o usuário dizer que não ia tomar)
- "anota que não tomei"

Nunca use REGISTER_NAO_TOMADO se o usuário apenas disse "não" sem pedir registro —
nesses casos, responda com empatia (newState: "confirming") para aguardar confirmação
posterior ou decisão do usuário.

Nunca use CONFIRM_DOSE quando o usuário disser variações de "não tomei", "não vou
tomar", "não vou mais tomar" — mesmo que a mensagem contenha a palavra "tomei".
O contexto de negação prevalece sempre.
```

---

### 3.3 — Nova função `registrarNaoTomado()` (`database.js`)

Adicionar junto às funções de confirmação de dose:

```js
// Registra que o usuário decidiu explicitamente não tomar a dose
// Status 'nao_tomado' é automaticamente excluído dos follow-ups
// (getPendingFollowUps filtra por status = 'pendente')
export async function registrarNaoTomado(medicationId) {
    // Busca o log mais recente pendente para o medicamento
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

**Por que isso é suficiente para parar os follow-ups:**
`getPendingFollowUps()` já filtra `.eq('status', 'pendente')`. Ao mudar para `nao_tomado`, a dose sai automaticamente da fila de follow-ups sem nenhuma outra mudança.

---

### 3.4 — Tratar `REGISTER_NAO_TOMADO` em `processAction` (`principal.js`)

**Mudança 1: adicionar import**

```js
import {
    // ...imports existentes...
    registrarNaoTomado    // NOVO
} from '../database.js';
```

**Mudança 2: adicionar case em `processAction`**

```js
case 'REGISTER_NAO_TOMADO':
    if (action.medicationId) {
        await registrarNaoTomado(action.medicationId);
        console.log(`🚫 Dose registrada como não tomada via REGISTER_NAO_TOMADO — ${action.medicationId}`);
    }
    return null; // Claude já gerou a mensagem de resposta adequada no campo "message"
```

---

## 4. Ordem de Execução

1. `src/database.js` — adicionar função `registrarNaoTomado()`
2. `src/router.js` — atualizar `detectarConfirmacaoDose` com filtro de negação
3. `src/prompts.js` — adicionar action `REGISTER_NAO_TOMADO` + instruções
4. `src/agentes/principal.js` — import + case em processAction
5. Deploy

---

## 5. Validação Pós-Deploy

### Teste A — Negação bloqueada no detector
Enviar "Eu não tomei ainda" quando há dose pendente.  
**Log esperado:** sem `💊 Confirmação de dose detectada` → cai no principal normalmente → Claude responde com empatia sem CONFIRM_DOSE.  
**Log que NÃO deve aparecer:** `✅ Dose confirmada`

### Teste B — `REGISTER_NAO_TOMADO` funcionando
Sequência:
1. Receber lembrete
2. Responder "Não vou tomar agora, mudei de ideia"
3. Nami pergunta "quer que eu registre?"
4. Responder "pode registrar"

**Logs esperados:**
```
🤖 Chamando Claude para: "pode registrar"
✅ Claude respondeu — action: REGISTER_NAO_TOMADO
🚫 Dose registrada como nao_tomado — log id: ...
```
**Comportamento esperado:** os follow-ups do lembrete param (dose não aparece mais como pendente).

### Teste C — Confirmação normal não afetada
Enviar "tomei" ou "sim" quando há dose pendente.  
Deve continuar funcionando normalmente com `CONFIRM_DOSE`.

---

## 6. Dados corrompidos nos testes anteriores

> ⚠️ **AÇÃO MANUAL — Supabase (opcional, mas recomendado)**
>
> Os testes do Vitor geraram dose_logs incorretos marcados como `confirmado` que nunca foram tomados. Para corrigir a adesão histórica:
> ```sql
> -- Identificar e corrigir doses falsamente confirmadas do Vitor
> -- (dose_log id: 65c36be1-7195-45e5-8a3a-65a85ad271f0)
> UPDATE dose_logs
> SET status = 'nao_tomado', confirmed = false, taken_at = null
> WHERE id = '65c36be1-7195-45e5-8a3a-65a85ad271f0';
> ```
> Isso não é bloqueante para o deploy, mas corrige a integridade dos dados históricos.