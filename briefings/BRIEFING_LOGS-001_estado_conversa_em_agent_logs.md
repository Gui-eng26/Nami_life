# BRIEFING: LOGS-001 — Registrar estado e contexto da conversa em agent_logs

**Data:** 19/06/2026  
**Sessão:** v9  
**Prioridade:** Alta — habilita diagnóstico antes da implementação do classificador LLM  
**Arquivos afetados:** `src/database.js`, `src/router.js`  
**Ação manual necessária no Supabase ANTES da implementação:** sim — ver Passo 0

---

## Contexto e motivação

Hoje, quando um bug de fluxo acontece em produção, o diagnóstico exige cruzar dois sistemas separados:
- **Railway logs** — para ver qual agente foi acionado e o que respondeu
- **Supabase** — para ver o `conversation_state` atual do usuário

O problema: o `conversation_state` é sobrescrito a cada mensagem. No momento do diagnóstico, o estado que existia durante o bug já foi substituído pelo estado da mensagem seguinte. O diagnóstico fica incompleto.

A solução é registrar o `estado_conversa` e o `contexto_conversa` diretamente no `agent_logs` no momento exato em que cada agente processa uma mensagem — criando um histórico auditável de estados por interação.

---

## Passo 0 — Ação manual no Supabase (EXECUTAR ANTES DO CÓDIGO)

Acessar o **SQL Editor** no Supabase e executar:

```sql
ALTER TABLE agent_logs 
ADD COLUMN estado_conversa text,
ADD COLUMN contexto_conversa jsonb;
```

Verificar que as colunas foram criadas na tabela `agent_logs` antes de prosseguir.

---

## Mudança 1 — `src/database.js`

Atualizar a função `logAgentInteraction` para aceitar e persistir os dois novos campos.

**Localizar:**
```javascript
export async function logAgentInteraction({ userId, agent, userMessage, agentResponse }) {
    const { error } = await supabase
        .from('agent_logs')
        .insert({
            user_id: userId,
            agent,
            user_message: userMessage,
            agent_response: agentResponse
        });

    if (error) console.error(`Erro ao salvar log de agente: ${error.message}`);
}
```

**Substituir por:**
```javascript
export async function logAgentInteraction({ userId, agent, userMessage, agentResponse, estadoConversa = null, contextoConversa = null }) {
    const { error } = await supabase
        .from('agent_logs')
        .insert({
            user_id: userId,
            agent,
            user_message: userMessage,
            agent_response: agentResponse,
            estado_conversa: estadoConversa,
            contexto_conversa: contextoConversa
        });

    if (error) console.error(`Erro ao salvar log de agente: ${error.message}`);
}
```

---

## Mudança 2 — `src/router.js` — Ponto 1 (fast-path)

O fast-path executa antes de `getConversationState` ser chamado. O estado não está disponível neste ponto. Registrar `null` nos dois campos — o fast-path é determinístico e não é onde bugs de fluxo acontecem.

**Localizar:**
```javascript
await logAgentInteraction({
    userId: user.id,
    agent: 'fast_path_reference',
    userMessage: message,
    agentResponse: `Dose confirmada: ${nomeRemedio}`
});
```

**Substituir por:**
```javascript
await logAgentInteraction({
    userId: user.id,
    agent: 'fast_path_reference',
    userMessage: message,
    agentResponse: `Dose confirmada: ${nomeRemedio}`,
    estadoConversa: null,
    contextoConversa: null
});
```

---

## Mudança 3 — `src/router.js` — Ponto 2 (final do roteamento)

Este é o ponto principal. Aqui `currentState` (string do estado) e `state` (objeto com `state` e `context`) já estão disponíveis na memória — foram buscados via `getConversationState` no início do `routeMessage`.

**Localizar:**
```javascript
await logAgentInteraction({
    userId: user.id,
    agent: agentName,
    userMessage: message,
    agentResponse: response
});
```

**Substituir por:**
```javascript
await logAgentInteraction({
    userId: user.id,
    agent: agentName,
    userMessage: message,
    agentResponse: response,
    estadoConversa: currentState || null,
    contextoConversa: state?.context || null
});
```

---

## Verificação pós-implementação

Após deploy no Railway, enviar qualquer mensagem via WhatsApp e verificar no Supabase — tabela `agent_logs` — que o registro mais recente contém:

- `estado_conversa`: o estado que estava ativo no momento (ex: `"idle"`, `"adding_med"`, `"configurando"`)
- `contexto_conversa`: o objeto JSONB de contexto (ex: `{}` ou `{"etapa": "cad_nome"}`)

O fast-path deve registrar `null` nos dois campos — isso é correto e esperado.

---

## Notas

- Campos com `DEFAULT NULL` no banco — nenhuma migração de dados históricos necessária. Registros anteriores ficam com `null`, o que é correto.
- Nenhuma alteração de schema em outras tabelas.
- Esta implementação é pré-requisito para o classificador LLM no roteador (próximo briefing), pois garante visibilidade diagnóstica antes de adicionar nova camada de decisão ao sistema.