# Briefing V2 — Nami: Router + Agente Recepcionista

Este documento é um briefing de implementação para o Claude Code.
Leia o CONTEXT.md do projeto antes de começar.

---

## Contexto geral

A Nami está evoluindo de um agente único (prompt único) para uma arquitetura
multi-agente. Este briefing cobre a Fase 1 dessa evolução:

1. Criar um `router.js` — responsável por ler o estado do usuário e decidir
   qual agente deve responder
2. Criar `src/agentes/recepcionista.js` — responsável por acolher novos usuários,
   apresentar a Nami e coletar o aceite LGPD
3. Refatorar o `agent.js` para delegar ao router em vez de processar tudo

---

## Observações sobre o `agent.js` atual

Leia com atenção antes de implementar:

**1. Não existe lógica de onboarding no `agent.js`**
O agente atual trata todos os usuários igual — não há verificação de `onboarded`.
O onboarding estava apenas no system prompt (`prompts.js`). Portanto não há
conflito a resolver — basta inserir a chamada ao router no lugar certo.

**2. Ponto de inserção do router**
A chamada ao `routeMessage` deve entrar logo após o `getOrCreateUser`, antes
de qualquer outra lógica. O trecho atual:

```javascript
const user = await getOrCreateUser(phone);
// ... áudio check ...
const state = await getConversationState(user.id);
// ... resto do fluxo ...
```

Deve se tornar:

```javascript
const user = await getOrCreateUser(phone);
// ... áudio check ...
const response = await routeMessage({ user, message: text });
await sendTextMessage(phone, response);
return;
```

A lógica existente (getConversationState, buildUserMessage, callClaude, etc.)
permanece no `agent.js` mas encapsulada numa função `handlePrincipal({ user, message })`
chamada pelo router quando `user.onboarded === true` e `state === 'idle'`.

**3. Nome hardcoded — corrigir durante a refatoração**
Em `processAction`, há um nome fixo que deve ser corrigido:

```javascript
// ANTES (errado)
`Guilherme, já tenho o *${med.nome}* cadastrado!`

// DEPOIS (correto)
`${user.name || 'Oi'}, já tenho o *${med.nome}* cadastrado!`
```

Para isso, `processAction` precisa receber `user` como parâmetro — já recebe,
então é só corrigir a string.

---

## Schema do banco de dados (Supabase)

### Tabela `users`
```
id                    uuid (PK)
phone                 text (unique)
name                  text
onboarded             bool (default false)
lgpd_accepted         bool (default false)
lgpd_accepted_at      timestamptz
created_at            timestamptz
updated_at            timestamptz
```

### Tabela `conversation_state`
```
id                    uuid (PK)
user_id               uuid (FK → users.id)
state                 text (nome do agente atual)
context               jsonb (dados coletados parcialmente)
updated_at            timestamptz
```

### Tabela `agent_logs`
```
id                    uuid (PK)
user_id               uuid (FK → users.id)
agent                 text
user_message          text
agent_response        text
created_at            timestamptz
```

### Tabelas existentes (não modificar)
- `medications` — medicamentos cadastrados por usuário
- `schedules` — horários de cada medicamento
- `dose_logs` — registro de doses enviadas e confirmadas
- `message_logs` — histórico de mensagens

---

## Arquitetura do router

### Lógica de decisão

```
mensagem chega do WhatsApp
        ↓
getOrCreateUser(phone) → obtém ou cria usuário
        ↓
getConversationState(user_id) → lê estado atual
        ↓
usuario.onboarded === false?
    → sim → agente_recepcionista
    → não → lê state da conversation_state
              ↓
          state === 'cadastro'     → agente_cadastro (futuro)
          state === 'lembrete'     → agente_lembrete (futuro)
          state === null ou 'idle' → agente_principal (atual agent.js)
```

### Arquivo: `src/router.js`

Criar este arquivo com a seguinte responsabilidade:
- Receber `{ user, message, phone }` 
- Ler `conversation_state` do banco
- Decidir qual agente chamar
- Retornar a resposta do agente
- Salvar log em `agent_logs`

```javascript
// Estrutura esperada do router.js

import { getConversationState, saveConversationState, logAgentInteraction } from './database.js';
import { handleRecepcionista } from './agentes/recepcionista.js';
// futuramente: import { handleCadastro } from './agentes/cadastro.js';

export async function routeMessage({ user, message }) {
  const state = await getConversationState(user.id);
  const currentState = state?.state || 'idle';

  let response;
  let agentName;

  // Usuário novo: ainda não passou pelo onboarding
  if (!user.onboarded) {
    agentName = 'recepcionista';
    response = await handleRecepcionista({ user, message, context: state?.context || {} });
  }
  // Estados futuros
  else if (currentState === 'cadastro') {
    // agentName = 'cadastro';
    // response = await handleCadastro(...)
  }
  else {
    // Estado idle ou principal — usa o agent.js atual
    agentName = 'principal';
    response = await handlePrincipal({ user, message });
  }

  // Salvar log
  await logAgentInteraction({
    userId: user.id,
    agent: agentName,
    userMessage: message,
    agentResponse: response
  });

  return response;
}
```

---

## Agente Recepcionista

### Responsabilidade
- Primeira interação com usuários novos
- Apresentar a Nami de forma acolhedora
- Explicar o que a Nami faz
- Coletar o nome do usuário
- Apresentar os termos LGPD de forma simples e humana
- Registrar o aceite
- Marcar `onboarded = true` e `lgpd_accepted = true` ao finalizar
- Passar o controle para o agente principal

### Fluxo de etapas (field `state` na conversation_state)

```
etapa 1: 'recep_boas_vindas'
  → Nami se apresenta e pergunta o nome

etapa 2: 'recep_coleta_nome'
  → Usuário responde com o nome
  → Nami salva o nome, apresenta o que faz e pede aceite LGPD

etapa 3: 'recep_lgpd'
  → Usuário responde "sim" ou equivalente
  → Nami registra aceite, marca onboarded=true, encerra recepcionista
  → Passa para agente principal com mensagem de boas-vindas final
```

### Arquivo: `src/agentes/recepcionista.js`

Criar a pasta `src/agentes/` e o arquivo `recepcionista.js`.

O agente deve usar a Claude API com o seguinte system prompt:

```
Você é a Nami, uma assistente de saúde pessoal que ajuda pessoas a não
esquecerem seus medicamentos de uso contínuo.

Você está no momento de boas-vindas com um novo usuário.

Seu tom é: acolhedor, caloroso, humano, responsável e confiável.
Use linguagem natural e próxima. Não seja robótica nem excessivamente formal.
Use emojis com moderação para tornar a conversa mais leve.

Etapa atual: {etapa}
Contexto coletado até agora: {contexto}

Instruções por etapa:

SE etapa = 'recep_boas_vindas':
  - Cumprimente o usuário com entusiasmo e calor
  - Se apresente como Nami, assistente de saúde pessoal
  - Pergunte o nome do usuário
  - Seja breve — não explique tudo ainda

SE etapa = 'recep_coleta_nome':
  - Chame o usuário pelo nome que ele informou
  - Explique brevemente o que a Nami faz:
    * Lembra dos medicamentos nos horários certos
    * Registra quando foram tomados
    * Avisa quando o estoque está acabando
    * Tudo pelo WhatsApp, sem precisar baixar nenhum app
  - Apresente os termos de uso de forma simples:
    "Para continuar, preciso guardar algumas informações suas (nome e telefone)
     para personalizar seus lembretes. Seus dados são usados só para isso e
     ficam protegidos. Você concorda?"
  - Aguarde confirmação

SE etapa = 'recep_lgpd':
  - Se o usuário confirmar: agradeça, diga que está tudo pronto
  - Diga que agora pode começar a cadastrar os medicamentos
  - Pergunte se quer começar agora
  - Se o usuário recusar: agradeça pela honestidade, diga que entende e
    que ele pode voltar quando quiser

Responda APENAS com a mensagem que deve ser enviada ao usuário.
Sem explicações, sem prefixos, sem aspas.
```

### Lógica de detecção de etapa

O `context` jsonb da `conversation_state` armazena:
```json
{
  "etapa": "recep_boas_vindas",
  "nome_coletado": null
}
```

A cada mensagem:
1. Lê o context atual
2. Determina a próxima etapa com base na resposta do usuário
3. Atualiza o context no banco
4. Chama Claude com o system prompt da etapa correta

### Detecção de aceite LGPD

Considerar como aceite qualquer variação positiva:
`sim`, `s`, `pode`, `concordo`, `aceito`, `ok`, `claro`, `com certeza`, `yes`

Ao detectar aceite:
```javascript
await updateUser(user.id, {
  name: context.nome_coletado,
  onboarded: true,
  lgpd_accepted: true,
  lgpd_accepted_at: new Date().toISOString()
});

await saveConversationState(user.id, { state: 'idle', context: {} });
```

---

## Funções novas necessárias no `database.js`

Adicionar as seguintes funções (verificar se alguma já existe antes de criar):

```javascript
// Buscar estado de conversa
export async function getConversationState(userId) {
  const { data } = await supabase
    .from('conversation_state')
    .select('*')
    .eq('user_id', userId)
    .single();
  return data;
}

// Salvar/atualizar estado de conversa
export async function saveConversationState(userId, { state, context }) {
  await supabase
    .from('conversation_state')
    .upsert({
      user_id: userId,
      state,
      context,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
}

// Atualizar campos do usuário
export async function updateUser(userId, fields) {
  await supabase
    .from('users')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', userId);
}

// Registrar log de agente
export async function logAgentInteraction({ userId, agent, userMessage, agentResponse }) {
  await supabase
    .from('agent_logs')
    .insert({
      user_id: userId,
      agent,
      user_message: userMessage,
      agent_response: agentResponse
    });
}
```

---

## Refatoração do `agent.js`

O `agent.js` atual processa tudo diretamente. Após essa implementação:

1. A função `handleIncomingMessage` deve chamar `routeMessage` do `router.js`
   em vez de chamar Claude diretamente
2. A lógica Claude existente no `agent.js` passa a ser o `handlePrincipal`
   — pode ficar no próprio `agent.js` ou ser movida para `src/agentes/principal.js`

---

## Estrutura de arquivos esperada após implementação

```
nami-backend/
├── src/
│   ├── index.js
│   ├── agent.js          (refatorado — chama router)
│   ├── router.js         (novo)
│   ├── database.js       (com novas funções)
│   ├── whatsapp.js
│   ├── scheduler.js
│   ├── prompts.js
│   └── agentes/
│       └── recepcionista.js  (novo)
├── CONTEXT.md
├── BRIEFING_V2.md        (este arquivo)
└── package.json
```

---

## Ordem de implementação sugerida

1. Adicionar funções novas ao `database.js`
2. Criar `src/agentes/recepcionista.js`
3. Criar `src/router.js`
4. Refatorar `agent.js` para chamar o router
5. Testar com mensagem de um número novo
6. Testar com mensagem de um número já cadastrado

---

## Critérios de sucesso

- Usuário novo → recebe boas-vindas da Nami, passa pelo fluxo de 3 etapas,
  tem nome e aceite LGPD registrados no banco, `onboarded = true`
- Usuário existente → comportamento idêntico ao atual (sem regressão)
- Logs de agente sendo gravados em `agent_logs`
- Nenhum erro no Railway após deploy