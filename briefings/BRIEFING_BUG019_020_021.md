# BRIEFING — BUG-019, BUG-020, BUG-021
**Data:** 12/06/2026  
**Para:** Claude Code  
**Contexto:** Três bugs identificados a partir de chat real de novo usuário (Vitor). Causa raiz confirmada por análise do código-fonte de `router.js` e `recepcionista.js`.

---

## O que aconteceu (resumo do chat real)

1. Vitor enviou "Oi" → Nami respondeu **duas vezes** com boas-vindas (BUG-019)
2. Vitor enviou mensagem rica: *"Preciso tomar meu remedio nimesulida de 12 em 12 horas e tomei as 21:30 de ontem"* → Nami **ignorou tudo** e deu boas-vindas genérica (BUG-020)
3. Vitor respondeu "Sim" ao consentimento LGPD → Nami respondeu **"Vou registrar que você tomou o remédio agora"** (BUG-021)

---

## BUG-019 — Duplicação de boas-vindas

**Causa raiz:** A Z-API entrega o mesmo evento webhook duas vezes. O `router.js` não tem idempotência — chama `handleRecepcionista` duas vezes com `etapa=null`, gerando duas respostas idênticas.

**Arquivo:** `src/router.js`

**O que fazer:**

1. Adicionar no **topo do arquivo**, antes de qualquer import ou função:

```js
// Idempotência — descarta eventos duplicados da Z-API
const processedMessages = new Map();
const MESSAGE_TTL_MS = 30_000;

function isDuplicateMessage(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    for (const [id, ts] of processedMessages.entries()) {
        if (now - ts > MESSAGE_TTL_MS) processedMessages.delete(id);
    }
    if (processedMessages.has(messageId)) return true;
    processedMessages.set(messageId, now);
    return false;
}
```

2. Adicionar `messageId` como parâmetro de `routeMessage` e o guard logo no início:

```js
export async function routeMessage({ user, message, image, messageId }) {
    if (isDuplicateMessage(messageId)) {
        console.log(`⚠️  Mensagem duplicada ignorada: ${messageId}`);
        return null;
    }
    // ... resto do código inalterado
}
```

3. No webhook handler (arquivo que chama `routeMessage` — provavelmente `src/index.js` ou `src/webhook.js`):
   - Adicionar `console.log('📦 Z-API payload:', JSON.stringify(req.body, null, 2))` para logar o payload completo no Railway e identificar o campo correto do messageId
   - Por ora passar `messageId: null` na chamada — depois de confirmar o campo no log, atualizar para o valor real (candidatos: `req.body.messageId`, `req.body.message?.id`, `req.body.id`)

---

## BUG-020 — Primeira mensagem do usuário ignorada

**Causa raiz:** No `recepcionista.js`, o step `recep_boas_vindas` instrui o Claude a se apresentar e pedir o nome — mas não instrui a **reagir ao conteúdo da mensagem_inicial**. A regra fundamental ("nunca ignore o que o usuário disse") existe no prompt, mas a instrução específica de etapa vence e o Claude gera boas-vindas genérica.

**Arquivo:** `src/agentes/recepcionista.js`

**O que fazer:**

Dentro de `buildSystemPrompt`, localizar o bloco `SE etapa = 'recep_boas_vindas'` e **substituir** pelo seguinte:

```
SE etapa = 'recep_boas_vindas':

  Você está respondendo à PRIMEIRA mensagem que este usuário enviou para a Nami.
  Essa mensagem está em mensagem_inicial. Leia-a com atenção ANTES de responder.
  Você deve REAGIR ao conteúdo dela — não apenas se apresentar.

  Se CADASTRAR (usuário mencionou remédio, posologia, horário, tratamento):
    Mostre que você OUVIU. Cite o remédio ou situação mencionada pelo usuário.
    Apresente-se brevemente e peça o nome como passo natural para continuar.
    Exemplo: "Oi! Vi que você precisa tomar nimesulida de 12 em 12 horas —
    posso te ajudar a organizar isso direitinho! 💊 Sou a Nami, sua assistente
    de saúde pessoal. Como posso te chamar?"

  Se DESCOBRIR (usuário perguntou o que a Nami faz ou quem ela é):
    Responda à curiosidade com apresentação breve e envolvente. Peça o nome.

  Se NEUTRO (saudação simples, sem contexto):
    Apresente-se com calor. Peça o nome.

  Em todos os casos: termine pedindo o nome do usuário.
  NÃO mencione LGPD ou coleta de dados neste momento.
```

**Nenhuma mudança na lógica de estado** — o fluxo `null → recep_boas_vindas → recep_coleta_nome → recep_lgpd` continua idêntico. Só o prompt muda.

---

## BUG-021 — "Sim" de consentimento interpretado como confirmação de dose

**Causa raiz:** O prompt do step `recep_lgpd` não ancora semanticamente o significado do "Sim" naquele contexto. O Claude infere erroneamente que "Sim" é confirmação de dose, combinando a mensagem atual com o conteúdo de `mensagem_inicial` (que menciona horário de tomada).

**Arquivo:** `src/agentes/recepcionista.js`

**O que fazer:**

Dentro de `buildSystemPrompt`, localizar o bloco `SE etapa = 'recep_lgpd'` e adicionar este parágrafo **no início do bloco**, antes de qualquer instrução existente:

```
SE etapa = 'recep_lgpd':

  CONTEXTO OBRIGATÓRIO: o usuário está respondendo à pergunta de consentimento
  de dados (LGPD) que você fez no turno anterior. A mensagem atual ("Sim", "ok",
  "concordo", etc.) é EXCLUSIVAMENTE uma resposta de consentimento — NÃO é
  confirmação de dose tomada, NÃO é confirmação de cadastro, NÃO tem relação
  com medicamentos. Não importa o que esteja em mensagem_inicial — neste turno
  o usuário está apenas dizendo se concorda ou não com a coleta de dados.

  [manter o restante do bloco original abaixo desta âncora]
```

---

## Validação após as três correções

Simular exatamente o chat do Vitor na ordem abaixo e verificar cada resposta:

| # | Mensagem enviada | Resposta esperada |
|---|-----------------|-------------------|
| 1 | `Preciso tomar meu remedio nimesulida de 12 em 12 horas e tomei as 21:30 de ontem` | **Uma única resposta** que cite nimesulida e peça o nome |
| 2 | `Vitor` | Nami chama pelo nome e pede consentimento LGPD |
| 3 | `Sim` | Nami celebra e pergunta sobre o medicamento (não menciona dose tomada) |
| 4 | Verificar no Railway | Estado salvo como `adding_med` com `etapa: cad_nome` |

Após validar: confirmar no Railway que o log do payload Z-API mostra o campo correto do messageId e atualizar o `router.js` com o valor real.

---

**Refs:** BUG-019, BUG-020, BUG-021 | Relatório v5 (11/06/2026)