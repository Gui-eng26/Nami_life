# BRIEFING — BUG-034 + BUG-035
## Qualidade conversacional: post_onboarding + confirmação de cadastro

**Data:** 17/06/2026  
**Escopo:** `src/router.js`, `src/agentes/cadastro.js`  
**Complexidade:** Baixa — dois arquivos, mudanças cirúrgicas  
**Nenhuma alteração de banco necessária**

---

## BUG-034 — post_onboarding consumido por resposta não-cadastro

### Causa raiz

Quando o usuário está em `post_onboarding` e responde com algo que não é um afirmativo nem intenção de cadastro (ex: "Receber lembretes"), o handler roteia para `handlePrincipal`. O principal responde e seta `newState: idle`. O `post_onboarding` foi consumido. Quando o usuário então diz "sim" (respondendo à pergunta do principal), o estado já é `idle` — nenhum contexto, sem âncora.

```
post_onboarding: "Receber lembretes"
→ handlePrincipal → responde + seta state: idle
→ usuário diz "sim"
→ idle + "sim" → principal sem contexto → resposta errada
```

### Solução — preservar `post_onboarding` com contador de trocas

Quando o principal for chamado a partir do `post_onboarding`, forçar o estado de volta para `post_onboarding` após a resposta — mas com um contador `exchanges` que limita isso a **1 troca**. Após 1 troca, o estado transita naturalmente para idle.

Isso garante:
- 1ª resposta não-cadastro → principal responde + estado volta para `post_onboarding`
- Usuário diz "sim" após isso → capturado pelo `post_onboarding` → roteado para cadastro ✓
- Usuário continua com outra coisa → 2ª troca → estado vai para idle (normal)

### Mudanças em `src/router.js`

**Mudança 1: adicionar `saveConversationState` ao import de database.js**

```js
// ANTES
import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque } from './database.js';

// DEPOIS
import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque,
    saveConversationState } from './database.js';
```

**Mudança 2: atualizar o handler `post_onboarding`**

```js
// ANTES
} else if (currentState === 'post_onboarding') {
    if (detectarIntencaoCadastro(message) || isAffirmativeSimple(message)) {
        agentName = 'cadastro';
        console.log(`💊 Roteando para cadastro (pós-onboarding) — ${user.phone}`);
        response = await handleCadastro({
            user, message, state,
            context: { etapa: 'cad_nome' }
        });
    } else {
        agentName = 'principal';
        console.log(`🤖 Roteando para principal (pós-onboarding) — ${user.phone}`);
        response = await handlePrincipal({ user, message, image });
    }

// DEPOIS
} else if (currentState === 'post_onboarding') {
    if (detectarIntencaoCadastro(message) || isAffirmativeSimple(message)) {
        agentName = 'cadastro';
        console.log(`💊 Roteando para cadastro (pós-onboarding) — ${user.phone}`);
        response = await handleCadastro({
            user, message, state,
            context: { etapa: 'cad_nome' }
        });
    } else {
        agentName = 'principal';
        console.log(`🤖 Roteando para principal (pós-onboarding) — ${user.phone}`);
        response = await handlePrincipal({ user, message, image });

        // Preserva post_onboarding por mais 1 troca para capturar o "sim" seguinte.
        // Após 1 troca (exchanges >= 1), deixa o principal gerenciar o estado normalmente.
        const exchanges = state?.context?.exchanges || 0;
        if (exchanges < 1) {
            await saveConversationState(user.id, {
                state: 'post_onboarding',
                context: { exchanges: exchanges + 1 }
            });
            console.log(`🔄 post_onboarding preservado (exchanges: ${exchanges + 1}) — ${user.phone}`);
        }
    }
```

---

## BUG-035 — `cad_confirmacao` não reconhece confirmações informais

### Causa raiz

A etapa `cad_confirmacao` do agente de cadastro usa Claude para decidir se o usuário confirmou ou quer corrigir. O prompt descreve o formato da mensagem a exibir mas **não lista o que conta como confirmação**. Quando o usuário responde "está", "beleza" ou "é isso", o Claude não tem certeza se é confirmação — em vez de avançar para `cad_salvo`, repete a pergunta de confirmação.

### Solução — adicionar lista de expressões de confirmação ao prompt

Uma instrução explícita no prompt elimina a ambiguidade para o Claude.

### Mudança em `src/agentes/cadastro.js`

Localizar a seção `cad_confirmacao:` no prompt do agente e adicionar o bloco de expressões logo após a descrição do formato:

```js
// ANTES — seção cad_confirmacao no prompt
cad_confirmacao:
  Exibe o resumo completo UMA ÚNICA VEZ e pergunta se está tudo certo.
  Use exatamente este formato:
  "Deixa eu confirmar tudo antes de salvar:
  ...
  Está tudo certinho?"

// DEPOIS — adicionar após o formato
cad_confirmacao:
  Exibe o resumo completo UMA ÚNICA VEZ e pergunta se está tudo certo.
  Use exatamente este formato:
  "Deixa eu confirmar tudo antes de salvar:
  ...
  Está tudo certinho?"

  EXPRESSÕES QUE CONTAM COMO CONFIRMAÇÃO (avance para cad_salvo):
  "sim", "é isso", "está", "tá", "tá bom", "ok", "pode", "salva", "salvar",
  "confirmar", "confirmo", "perfeito", "certo", "correto", "isso mesmo",
  "beleza", "pode salvar", "pode cadastrar", "isso", "está certo",
  "está certinho", "tudo certo", "certinho", "pode sim", "vai", "vamos"

  EXPRESSÕES QUE INDICAM CORREÇÃO (mantenha em cad_confirmacao ou volte à etapa relevante):
  "não", "errado", "muda", "altera", "quero mudar", "não está certo",
  "não é isso", "corrige", "tem erro"
```

**Atenção:** esta adição deve ser inserida como texto dentro da string do systemPrompt, respeitando a indentação e formatação do arquivo. Não é um comentário JS — é parte do prompt enviado ao Claude.

---

## Ordem de execução

1. `src/router.js` — import de `saveConversationState` + atualização do handler `post_onboarding`
2. `src/agentes/cadastro.js` — adicionar expressões de confirmação ao prompt do `cad_confirmacao`
3. Deploy

---

## Validação pós-deploy

### BUG-034
Resetar um usuário de teste para onboarding limpo (Supabase):
```sql
UPDATE users SET onboarded = false, lgpd_accepted = false WHERE phone = '+5511941065858';
DELETE FROM conversation_states WHERE user_id = (SELECT id FROM users WHERE phone = '+5511941065858');
```

Sequência de teste:
1. Enviar "Olá" → nome → aceitar LGPD
2. Nami pergunta "por onde quer começar?"
3. Enviar **"Receber lembretes"** (não é afirmativo, não é cadastro)
4. Nami responde sobre lembretes/cadastro
5. Enviar **"sim"**

Esperado: Nami pergunta o nome do medicamento.  
Log esperado: `🔄 post_onboarding preservado (exchanges: 1)`  
Depois: `💊 Roteando para cadastro (pós-onboarding)`

### BUG-035
Iniciar um cadastro normalmente até a etapa de confirmação, então responder com:
- "está" → deve salvar ✓
- "beleza" → deve salvar ✓  
- "é isso" → deve salvar ✓
- "errado, muda o horário" → deve voltar à etapa de horários ✓