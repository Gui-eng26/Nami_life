# BRIEFING — BUG-026
## Perda de contexto pós-LGPD: "Sim" vai para agente_principal sem âncora

**Data:** 13/06/2026  
**Origem:** Análise de logs Railway + revisão de código  
**Escopo:** `src/agentes/recepcionista.js`, `src/router.js`  
**Complexidade:** Baixa — duas mudanças cirúrgicas, nenhuma alteração de banco

---

## 1. Contexto

Quando um usuário chega com uma saudação simples ("Olá", "Oi", "Bom dia"), a recepcionista conclui o onboarding/LGPD e pergunta algo como "Por onde quer começar?" ou "Quer cadastrar um remédio agora?". O usuário responde "Sim".

Esse "Sim" chega ao router com estado `idle` — e o router não tem como saber que é resposta àquela pergunta específica. Sem keyword explícita de cadastro e sem dose pendente, o router manda para o `agente_principal`, que trata o "Sim" como mensagem solta e responde fora de contexto.

**Impacto observado nos testes:**
- Nami se reapresenta desnecessariamente (até 3 vezes nos testes)
- Pergunta o nome do usuário de novo (já coletado no onboarding)
- Frase "é bom te ter aqui" repetida 2 vezes
- Usuário precisa mandar "Cadastrar remédio" explicitamente para entrar no fluxo

---

## 2. Causa Raiz

Em `recepcionista.js`, após aceite do LGPD, o código decide o próximo estado com base na `mensagem_inicial`:

```js
const querCadastrar = [
    'cadastrar', 'remédio', 'remedios', 'remedio', 'medicamento',
    'registrar', 'me ajuda', 'ajuda'
].some(t => mensagemInicial.toLowerCase().includes(t));

if (querCadastrar) {
    await saveConversationState(user.id, { state: 'adding_med', context: { etapa: 'cad_nome' } });
} else {
    await saveConversationState(user.id, { state: 'idle', context: {} }); // ← PROBLEMA
}
```

Para `mensagem_inicial` = "Olá", `querCadastrar` é `false` → estado vai para `idle`.

A recepcionista ainda pergunta "por onde quer começar?" no turno seguinte, mas quando o usuário responde "Sim", o estado já é `idle` e o router perde o vínculo com a pergunta anterior.

---

## 3. Solução

### 3.1 — Novo estado: `post_onboarding`

Em vez de setar `idle` para usuários NEUTRO/DESCOBRIR após LGPD, setar `post_onboarding`. O router reconhece esse estado e sabe que o próximo "Sim" significa "sim, quero cadastrar".

**Fluxo corrigido:**
```
Usuário diz "Olá"
→ Recepcionista coleta nome + aceite LGPD
→ Estado setado: post_onboarding  (antes: idle)
→ Recepcionista pergunta: "Por onde quer começar?"

Usuário diz "Sim"
→ Router vê estado post_onboarding + mensagem afirmativa
→ Rota direto para cadastro (cad_nome)
→ Nami pergunta: "Qual é o nome do medicamento?"
```

---

## 4. Mudanças por Arquivo

### 4.1 — `src/agentes/recepcionista.js`

Localizar o bloco de `lgpdAccepted` (ao final da função `handleRecepcionista`). Trocar `state: 'idle'` por `state: 'post_onboarding'`:

```js
// ANTES
if (querCadastrar) {
    await saveConversationState(user.id, {
        state: 'adding_med',
        context: { etapa: 'cad_nome' }
    });
    console.log(`✅ Recepcionista: onboarding concluído — roteando para cadastro (${user.phone})`);
} else {
    await saveConversationState(user.id, { state: 'idle', context: {} });
    console.log(`✅ Recepcionista: onboarding concluído para ${user.phone}`);
}

// DEPOIS
if (querCadastrar) {
    await saveConversationState(user.id, {
        state: 'adding_med',
        context: { etapa: 'cad_nome' }
    });
    console.log(`✅ Recepcionista: onboarding concluído — roteando para cadastro (${user.phone})`);
} else {
    await saveConversationState(user.id, { state: 'post_onboarding', context: {} });
    console.log(`✅ Recepcionista: onboarding concluído — aguardando intenção (${user.phone})`);
}
```

**Apenas essa linha muda.** Todo o resto da recepcionista permanece intacto.

---

### 4.2 — `src/router.js`

**Mudança 1: nova função `isAffirmativeSimple()`**

Adicionar logo após a função `detectarConfirmacaoDose()` existente:

```js
// ============================================================
// DETECÇÃO DE AFIRMAÇÃO SIMPLES (pós-onboarding)
// Separada de detectarConfirmacaoDose para não misturar contextos
// ============================================================

function isAffirmativeSimple(message) {
    if (!message) return false;
    const termos = ['sim', 'ok', 'pode', 'claro', 'quero', 'vamos', 'bora', 'vou', 's'];
    const msg = message.toLowerCase().trim();
    return termos.some(t => msg === t || msg.startsWith(t + ' '));
}
```

**Mudança 2: novo handler para `post_onboarding` no `routeMessage()`**

Inserir como novo caso **antes** do handler `adding_med` (caso 2 atual). Ficará assim na sequência:

```js
// 1. Usuário ainda não fez onboarding → recepcionista
if (!user.onboarded) {
    // ... (sem mudança)

// NOVO: 2. Usuário concluiu onboarding agora — respondendo "por onde quer começar?"
} else if (currentState === 'post_onboarding') {
    if (detectarIntencaoCadastro(message) || isAffirmativeSimple(message)) {
        // "Sim", "quero", "vamos", "pode" → vai direto para cadastro
        agentName = 'cadastro';
        console.log(`💊 Roteando para cadastro (pós-onboarding) — ${user.phone}`);
        response = await handleCadastro({
            user,
            message,
            state,
            context: { etapa: 'cad_nome' }
        });
    } else {
        // Usuário quer outra coisa — "quero ver meu histórico", "tenho uma dúvida"
        agentName = 'principal';
        console.log(`🤖 Roteando para principal (pós-onboarding) — ${user.phone}`);
        response = await handlePrincipal({ user, message, image });
    }

// 3. Usuário já está em fluxo de cadastro → agente_cadastro (sem mudança)
} else if (currentState === 'adding_med') {
    // ... (sem mudança)
```

**Atenção:** o `post_onboarding` não precisa ser limpo manualmente. Quando o `handleCadastro` executa, ele seta `state: 'adding_med'`. Quando o `handlePrincipal` executa, ele seta `state: 'idle'`. O estado se atualiza naturalmente no próximo turno.

---

## 5. Ordem de Execução

1. Implementar mudança em `recepcionista.js` (1 linha)
2. Implementar mudanças em `router.js` (nova função + novo handler)
3. Deploy
4. Validar com novo usuário de teste

---

## 6. Validação Pós-Deploy

Testar com um usuário que **ainda não fez onboarding** (ou limpar o usuário de teste no Supabase):

**Fluxo a testar:**
1. Enviar "Olá" → Nami pede nome
2. Informar nome → Nami apresenta LGPD
3. Responder "Concordo" → Nami pergunta por onde quer começar
4. Responder "Sim" → **esperado:** Nami pergunta "Qual é o nome do medicamento?"

**O que NÃO deve mais acontecer:**
- Nami se reapresenta
- Nami pergunta o nome de novo
- Nami diz "é bom te ter aqui" pela segunda vez

**Nos logs, deve aparecer:**
```
✅ Recepcionista: onboarding concluído — aguardando intenção (+55...)
💊 Roteando para cadastro (pós-onboarding) — +55...
```

Em vez do antigo:
```
✅ Recepcionista: onboarding concluído para +55...
🤖 Roteando para principal — +55...
```

---

## 7. Degradação Graciosa

| Mensagem do usuário | `isAffirmativeSimple` | `detectarIntencaoCadastro` | Rota |
|---|---|---|---|
| "Sim" | ✅ | ❌ | cadastro |
| "Quero cadastrar meu remédio" | ❌ | ✅ | cadastro |
| "Vamos lá" | ✅ | ❌ | cadastro |
| "Tenho uma dúvida" | ❌ | ❌ | principal |
| "Quero ver meu histórico" | ❌ | ❌ | principal |
| "Não, vou fazer isso depois" | ❌ | ❌ | principal |

---

## 8. Bugs Relacionados (NÃO cobertos por este briefing)

- **BUG-027:** Nome do medicamento mencionado espontaneamente antes do fluxo formal é perdido no `cad_nome`
- **BUG-028:** "ta bom" interpretado como pergunta em contexto idle (Ivete)
- **BUG-030:** `pareceNome()` não filtra respostas como "Sim, quero continuar" — salvas temporariamente como nome do usuário