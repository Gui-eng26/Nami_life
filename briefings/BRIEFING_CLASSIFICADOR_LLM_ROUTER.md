# BRIEFING: Classificador LLM no roteador — resolução estrutural do problema de contexto conversacional

**Data:** 19/06/2026  
**Sessão:** v9  
**Prioridade:** Alta — resolve a classe inteira de falhas de roteamento por mensagens contextuais  
**Arquivos afetados:** `src/router.js`, `src/database.js`  
**Sem alteração de banco de dados necessária**

---

## Contexto e problema

O roteador atual é determinístico: uma série de `if/else` que verificam o estado atual e palavras-chave na mensagem. Funciona bem para casos explícitos — usuário em `adding_med`, `configurando`, ou mensagem contendo "cadastrar", "pausar", etc.

Quebra quando o usuário está em `idle` e envia uma mensagem contextual curta — "sim", "pode", "quero", "bora" — em resposta a algo que a Nami acabou de perguntar. O roteador não tem acesso ao que foi perguntado antes, então não sabe para onde ir e cai no `agente_principal` por default.

Exemplos reais do problema:
- Nami: "Quer que eu cadastre esse medicamento?" → Usuário: "sim" → vai para principal (errado)
- Nami: "Quer ver seu relatório de adesão?" → Usuário: "pode" → vai para principal (errado)
- Nami: "Posso ajudar com mais alguma coisa?" → Usuário: "quero pausar o voltaren" → vai para principal em vez de configuração

A solução correta não é adicionar mais palavras-chave às listas existentes — "sim" e "pode" são ambíguos demais para qualquer lista. A solução é dar ao roteador acesso ao histórico recente da conversa e usar um LLM para classificar a intenção quando o determinístico não consegue decidir.

---

## Solução: classificador LLM no `else` final do roteador

O classificador é inserido **apenas no bloco `else` final** — o único ponto onde o roteador hoje admite que não sabe o que fazer. Todos os outros blocos (`adding_med`, `configurando`, `post_onboarding`, etc.) permanecem intactos e continuam sendo determinísticos.

O classificador recebe:
- A mensagem atual do usuário
- As últimas 3 interações da conversa (de `agent_logs`) — o que o usuário disse e o que a Nami respondeu
- O estado atual
- A lista de agentes disponíveis e o que cada um faz

E retorna apenas: qual agente deve receber esta mensagem.

---

## Implementação — 3 mudanças

### Mudança 1 — `src/database.js`: nova função `getHistoricoRecente`

Adicionar ao final do arquivo, antes do último `export`:

```javascript
// ============================================================
// HISTÓRICO RECENTE — para classificador LLM do roteador
// ============================================================

export async function getHistoricoRecente(userId, limite = 3) {
    const { data, error } = await supabase
        .from('agent_logs')
        .select('user_message, agent_response, agent, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limite);

    if (error) {
        console.error('Erro ao buscar histórico recente:', error.message);
        return [];
    }

    // Retorna em ordem cronológica (mais antigo primeiro) para o prompt fazer sentido
    return (data || []).reverse();
}
```

### Mudança 2 — `src/router.js`: importar a nova função

**Localizar a linha de imports do database.js:**
```javascript
import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque,
    saveConversationState } from './database.js';
```

**Substituir por:**
```javascript
import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque,
    saveConversationState, getHistoricoRecente } from './database.js';
```

### Mudança 3 — `src/router.js`: substituir o bloco `else` final pelo classificador LLM

**Localizar o bloco `else` final do `routeMessage`:**
```javascript
    // 6. Demais casos → agente_principal
    } else {
        agentName = 'principal';
        console.log(`🤖 Roteando para principal — ${user.phone}`);
        response = await handlePrincipal({ user, message, image });
    }
```

**Substituir por:**
```javascript
    // 6. Demais casos → classificador LLM com contexto conversacional
    } else {
        const agenteSelecionado = await classificarIntencaoComContexto({
            userId: user.id,
            message,
            currentState
        });

        agentName = agenteSelecionado;

        if (agenteSelecionado === 'cadastro') {
            console.log(`💊 [CLASSIFICADOR] Roteando para cadastro — ${user.phone}`);
            response = await handleCadastro({
                user, message, state,
                context: { etapa: 'cad_nome' }
            });
        } else if (agenteSelecionado === 'relatorios') {
            console.log(`📊 [CLASSIFICADOR] Roteando para relatorios — ${user.phone}`);
            response = await handleRelatorios({ user, message });
            if (!response) {
                agentName = 'principal';
                response = await handlePrincipal({ user, message, image });
            }
        } else if (agenteSelecionado === 'configuracao') {
            console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao — ${user.phone}`);
            response = await handleConfiguracao({
                user, message, state,
                context: { etapa: 'identif_intencao' }
            });
        } else {
            // 'principal' — resposta geral ou intenção não identificada
            agentName = 'principal';
            console.log(`🤖 [CLASSIFICADOR] Roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image });
        }
    }
```

### Mudança 4 — `src/router.js`: adicionar a função `classificarIntencaoComContexto`

Adicionar esta função **antes** da função `routeMessage` (junto com as outras funções auxiliares do router):

```javascript
// ============================================================
// CLASSIFICADOR LLM — contexto conversacional para o else final
// ============================================================

async function classificarIntencaoComContexto({ userId, message, currentState }) {
    try {
        const historico = await getHistoricoRecente(userId, 3);

        // Monta o histórico como texto legível para o LLM
        const historicoTexto = historico.length > 0
            ? historico.map(h =>
                `Usuário: ${h.user_message}\nNami: ${h.agent_response}`
              ).join('\n\n')
            : 'Sem histórico recente.';

        const prompt = `Você é o classificador de intenções da Nami, um assistente de saúde via WhatsApp.

Sua única função é identificar para qual agente a mensagem atual do usuário deve ser direcionada, considerando o contexto da conversa.

AGENTES DISPONÍVEIS:
- cadastro: cadastrar um novo medicamento ou iniciar um novo tratamento
- relatorios: consultar doses tomadas, adesão, estoque, próximos remédios
- configuracao: pausar, reativar, encerrar tratamento, alterar horário de lembrete
- principal: qualquer outra coisa — conversa geral, dúvidas, saudações, situações ambíguas

ESTADO ATUAL DA CONVERSA: ${currentState}

HISTÓRICO RECENTE (últimas interações):
${historicoTexto}

MENSAGEM ATUAL DO USUÁRIO: "${message}"

Analise o histórico e a mensagem atual. Responda APENAS com uma das quatro opções exatas, sem explicação:
cadastro
relatorios
configuracao
principal`;

        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 10,
            messages: [{ role: 'user', content: prompt }]
        });

        const agente = resposta.content[0]?.text?.trim().toLowerCase();
        const agentesValidos = ['cadastro', 'relatorios', 'configuracao', 'principal'];

        if (agentesValidos.includes(agente)) {
            console.log(`🧠 [CLASSIFICADOR] Intenção classificada como: ${agente} — mensagem: "${message}"`);
            return agente;
        }

        // Resposta inesperada do LLM — fallback seguro
        console.warn(`⚠️ [CLASSIFICADOR] Resposta inesperada do LLM: "${agente}" — usando principal`);
        return 'principal';

    } catch (error) {
        // Erro na chamada LLM — fallback seguro, não interrompe o usuário
        console.error(`❌ [CLASSIFICADOR] Erro ao classificar intenção: ${error.message} — usando principal`);
        return 'principal';
    }
}
```

---

## Por que `max_tokens: 10`

O classificador precisa retornar apenas uma palavra: `cadastro`, `relatorios`, `configuracao` ou `principal`. A palavra mais longa tem 12 caracteres — menos de 5 tokens. Usar `max_tokens: 10` força o LLM a ser direto e reduz o custo da chamada ao mínimo possível.

---

## Por que o fallback sempre é `principal`

Se o classificador falhar (erro de rede, timeout, resposta inesperada), o usuário recebe a resposta do agente_principal — que é o comportamento atual do sistema. O fallback não piora nada, apenas mantém o status quo. Isso é importante: o classificador não pode ser um ponto de falha que interrompe o fluxo do usuário.

---

## O que NÃO muda

- Todos os blocos determinísticos existentes permanecem intactos (`adding_med`, `configurando`, `post_onboarding`, `idle + cadastro explícito`, `idle + configuração explícita`, `idle + confirmação de dose`, `idle + relatório`)
- O classificador só é chamado quando nenhum dos casos anteriores se aplica
- O fast-path de confirmação por referência de mensagem não é afetado

---

## Verificação pós-implementação

**Teste 1 — caso principal do FIX-004:**
1. Estado `idle`, enviar: "preciso tomar nimesulida de 12 em 12 horas"
2. Nami responde com convite ao cadastro
3. Enviar: "sim"
4. **Esperado:** Nami inicia o cadastro
5. **Log Railway esperado:** `🧠 [CLASSIFICADOR] Intenção classificada como: cadastro`

**Teste 2 — relatório via "sim":**
1. Estado `idle`, enviar: "quer ver sua adesão dessa semana?"  
   *(Nami deve responder perguntando se quer o relatório)*
2. Enviar: "pode"
3. **Esperado:** Nami retorna o relatório de adesão
4. **Log Railway esperado:** `🧠 [CLASSIFICADOR] Intenção classificada como: relatorios`

**Teste 3 — fallback correto:**
1. Estado `idle`, enviar: "oi tudo bem?"
2. **Esperado:** Nami responde normalmente via principal
3. **Log Railway esperado:** `🧠 [CLASSIFICADOR] Intenção classificada como: principal`

**Teste 4 — caso sem histórico:**
1. Usuário novo ou primeira mensagem do dia
2. Enviar: "sim"
3. **Esperado:** Nami responde via principal (sem contexto, não há como classificar)
4. O classificador recebe `historicoTexto = 'Sem histórico recente.'` e deve retornar `principal`

---

## Notas

- O classificador usa o mesmo modelo (`claude-sonnet-4-6`) já utilizado pelos demais agentes — sem nova dependência.
- A instância do `Anthropic` é criada dentro da função para evitar dependência circular com o restante do código. Se o projeto já instancia o cliente Anthropic em um módulo compartilhado, usar o padrão existente.
- Sem alteração de banco de dados — `getHistoricoRecente` lê `agent_logs` que já existe e já tem dados.