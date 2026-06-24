# BRIEFING 3 — Arquitetural: Continuidade conversacional + `nao_suportado` em três camadas

**Sessão:** v10 — 23/06/2026  
**Arquivos afetados:** `src/router.js`, `src/agentes/principal.js`, `src/agentes/relatorios.js`, `src/database.js`, `src/prompts.js`

---

## Contexto

Este é o briefing mais arquitetural da sessão. Resolve três problemas entrelaçados identificados em testes reais, todos com causa raiz confirmada em código:

1. **Perda de continuidade conversacional** (Pontos 3 e 6 dos testes): pronomes como "dele" e reações como "ok" chegam aos agentes sem o contexto da conversa, e são mal interpretados.
2. **Intenções não suportadas travam ou derivam para fluxos errados** ("alterar tempo de tratamento" foi para cadastro, depois pausar/encerrar).
3. **`idle` descarta contexto** — cada mensagem em idle é tratada quase isoladamente.

---

## DECISÃO ARQUITETURAL REGISTRADA (Pergunta levantada na v10)

**Roteador + principal permanecem separados — NÃO unificados.** Avaliou-se unificar tudo em um único `principal` que absorve contexto e orquestra os especialistas. Decisão: manter separados nesta fase. O roteador determinístico é barato, rápido e previsível para intenções claras (confirmação de dose, pausar) sem custo de LLM, e essa previsibilidade tem valor clínico em adesão. O problema real sentido nos testes não era a existência da fronteira roteador/principal, mas a **perda de contexto ao atravessá-la** — corrigida na Parte 1 deste briefing. Gatilho para reavaliar a unificação no futuro: quando as interações exigirem raciocínio conversacional rico que o roteador determinístico não comporte (Fase 3+: áudio, RAG ANVISA, rede de cuidado com cuidadores).

---

## DIAGNÓSTICO REVISADO — causa raiz confirmada (corrige análise anterior)

Ao reler o código atual, o diagnóstico inicial foi **revisado**. A análise anterior supôs que o roteador não tinha histórico. Não é o caso:

**O roteador JÁ tem `classificarIntencaoComContexto` que lê `getHistoricoRecente(userId, 3)`** e passa o histórico ao LLM classificador. Mas há duas limitações estruturais confirmadas:

**Limitação 1 — O histórico só é usado para ESCOLHER o agente, não é PROPAGADO ao agente escolhido.**

Confirmado nas assinaturas:
- `handlePrincipal({ user, message, image })` — não recebe histórico
- `handleRelatorios({ user, message })` — não recebe histórico

O classificador usa o histórico para decidir "isso é relatório", mas quando `handleRelatorios` executa, ele resolve "dele" sozinho, sem o histórico. Por isso o "dele" (Nimesulida) virou Dipirona — o agente nunca viu que se falava de Nimesulida.

**Limitação 2 — O classificador contextual só é chamado no `else` final (caso 6).**

As condições determinísticas anteriores (cadastro, confirmação de dose, relatórios) capturam a mensagem ANTES de chegar ao classificador com histórico. O "ok" do Ponto 6 foi capturado pela condição 4 (`detectarConfirmacaoDose` + `temDosePendente`) e roteado direto ao `principal` — que recebeu "ok" sem nenhum histórico e o tratou como nova conversa.

**Causa raiz real e confirmada:** o histórico conversacional existe no roteador mas **não é propagado aos agentes que executam**. A continuidade quebra no momento em que o agente recebe a mensagem sem o contexto que a torna interpretável.

---

## SOLUÇÃO — Parte 1: Propagar histórico conversacional de forma SISTÊMICA

**Princípio que guia esta parte:** continuidade conversacional é um comportamento sistêmico, não um remendo pontual onde o bug apareceu. Em vez de cada agente buscar o histórico por conta própria (várias queries para a mesma informação, lógica duplicada, acoplamento espalhado), o histórico é **buscado uma única vez no roteador** e **propagado uniformemente** a todos os agentes que usam LLM.

**Quais agentes recebem o histórico:**

| Agente | Recebe histórico? | Justificativa |
|---|---|---|
| `principal` | Sim | LLM-puro, interpreta linguagem natural, resolve "ok"/"dele" |
| `relatorios` | Sim | Híbrido com LLM, resolve pronomes em consultas |
| `configuracao` | Sim | Híbrido com LLM, resolve "muda o horário dele", "pausa esse" |
| `cadastro` | Sim | Híbrido com LLM, resolve "cadastra ele também" |
| `recepcionista` | Sim | Por consistência sistêmica (custo nulo se não usar) |
| `lembrete` | Não | Determinístico puro, template fixo, sem LLM — nada a interpretar |

### 1.1 — Roteador busca o histórico uma vez e propaga

No `routeMessage` (`router.js`), buscar o histórico no início, antes do bloco de roteamento, e passá-lo como parâmetro a cada `handle*` chamado:

```javascript
export async function routeMessage({ user, message, image, messageId, referenceMessageId }) {
    // ... código inicial ...

    // Histórico conversacional — buscado UMA vez, propagado a todos os agentes LLM
    const historicoConversa = await getHistoricoRecente(user.id, 3);

    // Nas chamadas dos agentes, passar historicoConversa:
    // handlePrincipal({ user, message, image, historicoConversa })
    // handleRelatorios({ user, message, historicoConversa })
    // handleConfiguracao({ user, message, state, context, historicoConversa })
    // handleCadastro({ user, message, state, context, historicoConversa })
    // handleRecepcionista({ ..., historicoConversa })
    // handleLembrete — NAO recebe (deterministico)
}
```

**Nota de eficiencia:** o `classificarIntencaoComContexto` hoje busca o historico internamente. Apos esta mudanca, o historico ja estara disponivel no escopo do `routeMessage` — passar como parametro ao classificador tambem, eliminando a busca duplicada. Uma query em vez de duas.

### 1.2 — Cada agente LLM aceita `historicoConversa` e o inclui no prompt

Padrao uniforme em todos os agentes que recebem o historico. Exemplo no `handlePrincipal`:

```javascript
export async function handlePrincipal({ user, message, image, historicoConversa = [] }) {
    const state = await getConversationState(user.id);
    const medications = await getUserMedications(user.id);
    const recentDoses = await getRecentDoses(user.id, 3);

    const userMessage = buildUserMessage({
        text: message, image, user, state, medications, recentDoses,
        historicoConversa
    });
    // ... resto inalterado
}
```

**Funcao utilitaria compartilhada** para formatar o historico — criar uma vez e reusar em todos os agentes, evitando duplicacao:

```javascript
// Em modulo utilitario compartilhado (ex: utils.js ou no proprio database.js)
export function formatarHistoricoConversa(historicoConversa) {
    if (!historicoConversa || historicoConversa.length === 0) {
        return 'Sem conversa anterior recente.';
    }
    return historicoConversa
        .map(h => `Usuario: ${h.user_message}\nNami: ${h.agent_response}`)
        .join('\n\n');
}
```

Cada agente usa `formatarHistoricoConversa(historicoConversa)` ao montar seu prompt — uma unica implementacao da formatacao, sem repeticao.

### 1.3 — Instrucao de continuidade nos prompts

No `NAMI_SYSTEM_PROMPT` (`prompts.js`) e nos prompts dos agentes que interpretam linguagem natural, adicionar a secao de continuidade — idealmente como bloco de texto compartilhado para nao divergir entre agentes:

```
CONTINUIDADE DA CONVERSA:
Use a secao "CONVERSA RECENTE" para entender referencias ao que acabou de ser dito.
- Pronomes ("dele", "desse", "esse mesmo") referem-se ao ultimo medicamento/assunto mencionado na conversa recente.
- Reacoes curtas ("ok", "entendi", "obrigado", "ta bom", "beleza") apos uma resposta da Nami sao fechamentos de conversa — responda de forma acolhedora e breve, sem reiniciar nem perguntar "como posso ajudar" como se fosse uma nova conversa.
- Se a mensagem atual claramente inicia um assunto novo sem relacao com a conversa recente, trate como nova intencao normalmente.
```

**Onde incluir o historico no contexto de cada agente:** na secao de contexto que ja e montada para o LLM (como `buildUserMessage` no principal), adicionar o bloco "CONVERSA RECENTE" com `formatarHistoricoConversa(historicoConversa)`.

---

## SOLUÇÃO — Parte 2: Redefinir o papel do `idle`

### Decisão arquitetural

O `idle` NÃO é eliminado como estado. Ele é **ressignificado**: deixa de significar "sem contexto" e passa a significar "sem fluxo estruturado em andamento, mas com memória da conversa recente".

Na prática, isso já é alcançado pela Parte 1 — o histórico é sempre buscado e propagado, independente do estado ser `idle`. O `idle` continua indicando que nenhum fluxo (cadastro, configuração, confirmação) está ativo, mas os agentes sempre têm acesso ao histórico recente via `getHistoricoRecente`.

**Não há mudança de lógica de estado** — a continuidade vem da propagação do histórico, não de manter contexto de fluxo indefinidamente. Isso evita o risco de contexto de fluxo obsoleto contaminar intenções novas: o histórico é informativo (o LLM decide se é relevante), enquanto o estado de fluxo permanece preciso.

### Por que não manter o último contexto de fluxo em vez de idle

Considerado e descartado: manter o contexto de fluxo (ex: `configurando` com medicamento X) após a conclusão criaria risco de a próxima mensagem ser interpretada dentro daquele fluxo encerrado. O histórico conversacional informativo é mais seguro — dá continuidade sem prender o usuário a um fluxo que já terminou. O LLM vê o histórico e decide a relevância, exatamente como em uma conversa natural.

---

## SOLUÇÃO — Parte 3: `nao_suportado` em três camadas

### Camada 1 — Inventário de capacidades no roteador

O `classificarIntencaoComContexto` ganha conhecimento explícito do que cada agente faz E não faz, e uma nova categoria de saída `nao_suportado`:

```javascript
const prompt = `Você é o classificador de intenções da Nami, um assistente de saúde via WhatsApp.

Identifique para qual agente a mensagem deve ir, considerando o contexto da conversa.

AGENTES E SUAS CAPACIDADES:
- cadastro: cadastrar novo medicamento, iniciar novo tratamento
- relatorios: consultar doses tomadas, adesão, estoque, próximos remédios, horários cadastrados
- configuracao: pausar, reativar, encerrar tratamento; alterar/remover/adicionar/redefinir horário de lembrete
- principal: conversa geral, dúvidas, saudações, reações ("ok", "obrigado"), fechamentos

FUNCIONALIDADES QUE A NAMI AINDA NÃO TEM (classifique como "nao_suportado"):
- alterar tempo/duração de tratamento
- alterar dosagem de um medicamento
- alterar nome de um medicamento
- registrar sintomas, pressão, glicemia ou outros dados de saúde
- falar com médico, agendar consulta
- exportar histórico em arquivo

ESTADO ATUAL: ${currentState}

HISTÓRICO RECENTE:
${historicoTexto}

MENSAGEM ATUAL: "${message}"

Responda APENAS com uma destas opções exatas:
cadastro
relatorios
configuracao
principal
nao_suportado`;
```

Adicionar `nao_suportado` à lista de agentes válidos:

```javascript
const agentesValidos = ['cadastro', 'relatorios', 'configuracao', 'principal', 'nao_suportado'];
```

### Camada 2 — Tratamento centralizado no `principal`

Quando o roteador classifica como `nao_suportado`, encaminha ao `principal` com uma flag indicando isso. O `principal` responde com honestidade, registra no banco e pergunta como ajudar.

No roteador, no bloco do classificador (caso 6):

```javascript
} else if (agenteSelecionado === 'nao_suportado') {
    agentName = 'principal';
    console.log(`🚧 [CLASSIFICADOR] Intenção não suportada — ${user.phone}`);
    await registrarIntencaoNaoSuportada(user.id, message); // registro no banco
    response = await handlePrincipal({ user, message, image, intencaoNaoSuportada: true });
}
```

`handlePrincipal` recebe a flag e instrui o LLM a dar a resposta adequada:

```javascript
export async function handlePrincipal({ user, message, image, intencaoNaoSuportada = false }) {
    // ... busca contexto e histórico ...
    const userMessage = buildUserMessage({
        text: message, image, user, state, medications, recentDoses, historicoConversa,
        intencaoNaoSuportada // ← novo
    });
    // ...
}
```

Em `buildUserMessage`, quando `intencaoNaoSuportada` é true, adicionar instrução:

```javascript
${intencaoNaoSuportada ? `
=== ATENÇÃO: INTENÇÃO NÃO SUPORTADA ===
O usuário pediu algo que a Nami AINDA NÃO faz. Responda com honestidade e gentileza:
- Explique que essa funcionalidade ainda está em desenvolvimento
- NÃO invente que consegue fazer
- NÃO derive para pausar/encerrar/cadastrar
- Pergunte se pode ajudar com outra coisa (cadastrar, consultar, alterar horários, pausar/reativar)
` : ''}
```

### Camada 3 — Rede de segurança nos agentes

Caso o roteador erre e encaminhe uma intenção não suportada a um agente especializado, o agente precisa de uma saída que devolva ao `principal` em vez de travar.

Para o `agente_configuracao`: o `classificarIntencao` já ganhou a categoria `nao_suportado` no Briefing 2? **Não** — o Briefing 2 tratou apenas `esclarecer_pausar_encerrar`. Adicionar agora a categoria `nao_suportado` ao `classificarIntencao` do configuracao, e quando ela aparecer, encerrar o fluxo de configuração e sinalizar retorno ao principal:

```javascript
// No handler do configuracao, quando acao === 'nao_suportado':
if (acao === 'nao_suportado') {
    await saveConversationState(user.id, { state: 'idle', context: {} });
    await registrarIntencaoNaoSuportada(user.id, message);
    return `Essa funcionalidade ainda não está disponível, ${firstName} — está no nosso radar de melhorias 🌱\n\nMas posso te ajudar com: cadastrar um remédio, alterar horários de lembrete, pausar ou encerrar um tratamento, ou ver seus relatórios. O que você precisa?`;
}
```

Adicionar ao prompt do `classificarIntencao` do configuracao a categoria e exemplos:

```
- nao_suportado: pedidos que a configuração não faz — alterar tempo/duração de tratamento, alterar dosagem, alterar nome do medicamento.
  Ex: "mudar o tempo de tratamento", "alterar a dosagem", "trocar o nome do remédio"
```

### Registro no banco — `registrarIntencaoNaoSuportada`

Nova função em `database.js` que registra os pedidos não suportados para análise de demanda:

```javascript
export async function registrarIntencaoNaoSuportada(userId, mensagem) {
    const { error } = await supabase
        .from('intencoes_nao_suportadas')
        .insert({ user_id: userId, mensagem, created_at: new Date().toISOString() });
    if (error) console.error(`⚠️ Erro ao registrar intenção não suportada: ${error.message}`);
    else console.log(`📋 Intenção não suportada registrada: "${mensagem}"`);
}
```

**Nova tabela no Supabase (criar manualmente antes do deploy):**

```sql
create table public.intencoes_nao_suportadas (
  id uuid not null default gen_random_uuid(),
  user_id uuid null,
  mensagem text not null,
  created_at timestamp with time zone null default now(),
  revisado boolean null default false,
  constraint intencoes_nao_suportadas_pkey primary key (id),
  constraint intencoes_nao_suportadas_user_id_fkey foreign key (user_id) references users (id) on delete cascade
);
```

A coluna `revisado` permite a Guilherme marcar quais pedidos já foram avaliados para o backlog.

---

## PROCESSO PADRÃO — Atualização do inventário do roteador

**REGISTRAR NO CONTEXT.md E NA MEMÓRIA:**

> Sempre que uma funcionalidade de agente for adicionada ou removida (nova ação em configuração, novo tipo de consulta em relatórios, etc.), o **inventário de capacidades no prompt do `classificarIntencaoComContexto` (router.js) DEVE ser atualizado na mesma alteração**. O inventário lista o que cada agente faz E o que a Nami ainda não faz (`nao_suportado`). Um inventário desatualizado faz o roteador classificar incorretamente — roteando para um agente que não tem a capacidade, ou marcando como não suportado algo que passou a existir. Esta atualização é parte obrigatória de qualquer mudança de capacidade de agente.

---

## Sequência de implementação recomendada (dentro deste briefing)

1. Criar tabela `intencoes_nao_suportadas` no Supabase (manual)
2. `getHistoricoRecente` já existe — reutilizar
3. Parte 1 (propagação SISTÊMICA de histórico) — roteador busca uma vez e propaga; criar `formatarHistoricoConversa` compartilhada; adicionar `historicoConversa` a `handlePrincipal`, `handleRelatorios`, `handleConfiguracao`, `handleCadastro`, `handleRecepcionista` (lembrete fica fora); incluir bloco de continuidade nos prompts
4. Parte 3 Camada 1 (inventário + nao_suportado no roteador)
5. Parte 3 Camada 2 (tratamento no principal + flag)
6. Parte 3 Camada 3 (rede de segurança no configuracao + registrarIntencaoNaoSuportada)

---

## Validação esperada após implementação

**Continuidade conversacional:**
1. Usuário reativa Nimesulida → pergunta "quais os horários dele?" → Nami responde com horários da **Nimesulida** (não Dipirona) ✅
2. Nami confirma adição de horário → usuário diz "ok" → Nami responde de forma acolhedora e breve, sem reiniciar ✅
3. Usuário diz "obrigado" após uma ação → Nami fecha gentilmente, sem "como posso ajudar?" ✅

**Não suportado:**
4. "Quero alterar o tempo de tratamento do Dipirona" → Nami explica que não faz isso ainda, registra no banco, pergunta como ajudar ✅
5. "Mudar a dosagem" → mesma resposta ✅
6. Pedido não suportado que escapa para configuração → configuração devolve com mensagem adequada, não trava ✅
7. Registros aparecem na tabela `intencoes_nao_suportadas` para análise ✅

**Continuidade sistêmica (todos os agentes LLM):**
8. Em configuração: "muda o horário dele" após mencionar um medicamento → resolve o pronome corretamente ✅
9. Em cadastro: referência a medicamento mencionado antes → resolvida via histórico ✅

**Não regressão:**
10. Intenções suportadas continuam funcionando — cadastrar, consultar, alterar horário, pausar, reativar, encerrar ✅
11. Nova conversa sem relação com histórico recente → tratada como nova intenção normalmente ✅
12. `lembrete` continua determinístico, sem histórico, template fixo ✅

---

**Comando para Claude Code:**  
`Leia o briefings/BRIEFING_CONTINUIDADE_NAOSUPORTADO.md e implemente. IMPORTANTE: criar a tabela intencoes_nao_suportadas no Supabase antes do deploy.`