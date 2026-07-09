# BRIEFING — BUG-032 + BUG-033
## Saída de emergência sistêmica no agente de configuração + escalada inteligente ao roteador

**Data:** 09/07/2026
**Origem:** Sessão de planejamento — revisão completa do `configuracao.js` antes da expansão beta
**Escopo:** `src/nlp_helpers.js`, `src/agentes/configuracao.js`, `src/router.js`, `src/database.js`
**Complexidade:** Média — sem migração de banco, mexe em 4 arquivos, adiciona um novo tipo de retorno em `handleConfiguracao`

---

## 1. Contexto

BUG-032 ("Encerramento de tratamento é fluxo sem saída") e BUG-033 ("Dead-end residual em configuracao.js") foram registrados em sessões diferentes, mas são **a mesma causa raiz**: o state machine do `configuracao.js` tem 12 etapas, e apenas 3 delas (`confirm_acao`, `reativ_confirmar`, `pos_alteracao`) verificam `isCancelamento()`. As outras 9 (contando `identif_intencao` quando reentra com medicamento já resolvido) não têm nenhuma saída — se o usuário tentar desistir e a mensagem não for reconhecida como a resposta esperada daquela etapa, a etapa repete a pergunta indefinidamente.

Esta correção substitui completamente esse comportamento por um modelo de 3 camadas, validado por evidência de código e por rastreamento de cenários reais de produção (ver seção 6).

---

## 2. Modelo de 3 camadas (aplica-se a todas as etapas corrigidas)

1. **Camada 1** — parser determinístico da própria etapa tenta reconhecer a resposta esperada (horário, medicamento, número de estoque, tipo de tratamento). Se reconhecer, o fluxo segue normalmente — **sem nenhuma mudança de comportamento aqui**.
2. **Camada 2** — se a Camada 1 falhar, verifica `isCancelamento(message)` (lista fixa, ver seção 3). Se bater, sai para `idle` com uma mensagem de despedida educada. **A ordem importa**: Camada 1 sempre roda primeiro, porque mensagens como "não, muda pra 15h" contêm "não" mas são uma correção, não uma desistência — o parser bem-sucedido tem precedência sobre a lista de cancelamento.
3. **Camada 3** — se as duas falharem, `handleConfiguracao` **não retorna mais uma mensagem de "não entendi"**. Em vez disso, retorna um sinal estruturado `{ escalarParaRoteador: true }`. O `router.js` recebe esse sinal e roda o classificador central (`classificarIntencaoComContexto`) para decidir o que fazer de fato com a mensagem — usando o `context` que o próprio roteador já tem em mãos (sem round-trip de banco).

**Isto elimina completamente as respostas de "não entendi, tente de novo" do agente de configuração.** Todo caso que antes travava agora é resolvido pelo classificador central, que já sabe rotear para qualquer agente do sistema.

---

## 3. Arquivo `src/nlp_helpers.js`

Apertar o gatilho de "para" (ambíguo entre preposição e verbo em português) e ampliar o vocabulário de desistência com os termos que surgiram durante a análise.

```js
// ANTES
export function isCancelamento(message) {
    return /\b(não|nao|cancela|cancelar|desiste|desistir|para|esquece|esquece isso)\b/.test(message.toLowerCase());
}

// DEPOIS
export function isCancelamento(message) {
    return /\b(não|nao|cancela|cancelar|desiste|desistir|para (de|com)|parar|esquece|esquece isso|deixa|deixa pra lá|deixa quieto|sair|chega|chega por hoje|não precisa mais|não precisa)\b/i.test(message.toLowerCase());
}
```

**Atenção:** o gatilho "para" sozinho (sem "de"/"com") foi removido de propósito — em `obter_horario`, `identif_schedule` e `obter_novos_horarios` os usuários digitam coisas como "muda para as 9h", onde "para" é preposição, não desistência. Manter o gatilho solto quebraria essas respostas legítimas.

Esta função é usada em três arquivos (`router.js`, `relatorios.js`, `configuracao.js`) — o aperto e a ampliação valem para todos os usos, sem necessidade de mudança em nenhum outro lugar.

---

## 4. Arquivo `src/agentes/configuracao.js`

### 4.1 — Oito etapas recebem o modelo de 3 camadas

Em cada uma das etapas abaixo, o bloco "parse falhou → retorna mensagem de retry" é substituído por: checa cancelamento → se não, escala. **A mensagem de retry antiga é removida** (ela deixa de existir no código).

#### `identif_medicamento`
```js
// ANTES
if (etapa === 'identif_medicamento') {
    const med = encontrarMedicamento(message, medicationsAtivos);
    const listaParaMostrar = context.acao === 'reativar' ? medicamentosPausados : medicamentosComSchedule;

    if (!med) {
        const lista = listaParaMostrar.map(m => `• ${m.nome}`).join('\n');
        return `Não encontrei esse medicamento, ${firstName}. Seus medicamentos:\n\n${lista}\n\nQual deles?`;
    }

    const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);
    const { acao, novoHorario } = context;
    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, schedulesAtivos });
}

// DEPOIS
if (etapa === 'identif_medicamento') {
    const med = encontrarMedicamento(message, medicationsAtivos);
    const listaParaMostrar = context.acao === 'reativar' ? medicamentosPausados : medicamentosComSchedule;

    if (!med) {
        if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        return { escalarParaRoteador: true };
    }

    const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);
    const { acao, novoHorario } = context;
    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, schedulesAtivos });
}
```

#### `identif_schedule`
```js
// ANTES (dentro do if (etapa === 'identif_schedule') { ... })
if (!schedule) {
    const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
    return `Não reconheci esse horário. Os lembretes cadastrados são:\n\n${lista}\n\nMe responda com um desses exatamente — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
}

// DEPOIS
if (!schedule) {
    if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
```

#### `identif_schedule_remocao`
```js
// ANTES
if (!schedule) {
    const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
    return `Não reconheci esse horário. Os lembretes cadastrados são:\n\n${lista}\n\nMe responda com um desses — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
}

// DEPOIS
if (!schedule) {
    if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
```

#### `obter_novos_horarios`
```js
// ANTES
if (matches.length === 0) {
    return `Não reconheci os horários, ${firstName}. Me diga os novos horários das doses — por exemplo: *06:00, 14:00 e 22:00*`;
}

// DEPOIS
if (matches.length === 0) {
    if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
```

#### `obter_horario`
```js
// ANTES
if (!novoHorario) {
    return `Não reconheci esse horário, ${firstName}. Me diga o horário — pode ser assim: *15:00*, *3 da tarde* ou *15h* 😊`;
}

// DEPOIS
if (!novoHorario) {
    if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
```

#### `reativ_tipo_tratamento`
```js
// ANTES
if (!tipo_tratamento) {
    return `Não entendi, ${firstName}. É uso *contínuo* (sem previsão de parada) ou *temporário* (tem um prazo determinado)?`;
}

// DEPOIS
if (!tipo_tratamento) {
    if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
```

#### `reativ_estoque`
```js
// ANTES
if (!confirmouEstoque) {
    const numMatch = message.match(/\d+/);
    if (numMatch) {
        novoEstoque = parseInt(numMatch[0]);
    } else {
        return `Não entendi, ${firstName}. Qual a quantidade atual em estoque? (ex: *20*)`;
    }
}

// DEPOIS
if (!confirmouEstoque) {
    const numMatch = message.match(/\d+/);
    if (numMatch) {
        novoEstoque = parseInt(numMatch[0]);
    } else {
        if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        return { escalarParaRoteador: true };
    }
}
```

#### `reativ_horarios`
```js
// ANTES
if (matches.length === 0) {
    return `Não entendi os horários, ${firstName}. Me diga os horários das doses — por exemplo: *08:00 e 20:00*`;
}

// DEPOIS
if (matches.length === 0) {
    if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
```

### 4.2 — `identif_intencao`, dois ajustes

**Ajuste A** — quando essa etapa é reencontrada **com `context.medicationId` já preenchido** (ou seja, é o retorno da pergunta "pausar ou encerrar?", não uma entrada fresca), checar cancelamento **antes** de chamar o classificador LLM local — evita depender do LLM adivinhar corretamente e economiza uma chamada.

**Ajuste B (correção de revisão — obrigado, Claude Code, por pegar isso)** — o branch `acao === 'nao_suportado'`, que já existe hoje logo depois da chamada a `classificarIntencao()`, responde direto "essa funcionalidade não está disponível" sem nunca passar pela Camada 3. Isso é um problema real: o `classificarIntencao()` usado aqui é o classificador **interno** do agente de configuração — só entende pausar/reativar/encerrar/horários — e joga no balde `nao_suportado` qualquer coisa que não reconheça, **inclusive pedidos que são perfeitamente suportados por outro agente** (ex: "quero saber o estoque do Losartana" é suportado, só que por `relatorios`, não por `configuracao`). Antes da nossa correção isso não importava, porque a resposta era sempre a mesma independentemente do motivo. Agora importa: precisamos que o classificador **central** (que conhece todos os agentes) decida se é genuinamente não suportado ou se é de outro agente — não o classificador interno, que só vê metade do mapa.

```js
// ANTES
if (etapa === 'identif_intencao') {
    const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos, historicoConversa);

    if (medicationsAtivos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
    }

    // Rede de segurança — intenção não suportada que escorregou para configuração
    if (acao === 'nao_suportado') {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        await registrarIntencaoNaoSuportada(user.id, message);
        return `Essa funcionalidade ainda não está disponível, ${firstName} — está no nosso radar de melhorias 🌱\n\nMas posso te ajudar com: cadastrar um remédio, alterar horários de lembrete, pausar ou encerrar um tratamento, ou ver seus relatórios. O que você precisa?`;
    }
    ...

// DEPOIS
if (etapa === 'identif_intencao') {
    if (context.medicationId && isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }

    const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos, historicoConversa);

    if (medicationsAtivos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
    }

    // Rede de segurança do classificador interno — não decide mais sozinho se é
    // "não suportado de verdade" ou "suportado por outro agente". Escala pro
    // classificador central em vez de responder direto.
    if (acao === 'nao_suportado') {
        return { escalarParaRoteador: true };
    }
    ...
```

**Importante — mudança real de comportamento, não só limpeza de código:** `registrarIntencaoNaoSuportada` não desaparece — ela continua sendo chamada, só que agora do lado do `despacharEscalada()` (seção 5.1), no branch `agenteSelecionado === 'nao_suportado'` do classificador central, que despacha pra `handlePrincipal` com `intencaoNaoSuportada: true`. **Isso não é a mesma mensagem reaproveitada** — hoje o `configuracao.js` responde com uma string fixa ("Essa funcionalidade ainda não está disponível... está no nosso radar de melhorias 🌱"); o caminho do `principal.js` (`prompts.js`/`principal.js` linha 283-290) **gera a resposta livremente via LLM**, a partir da instrução "responda com honestidade e gentileza, explique que está em desenvolvimento, não invente que consegue fazer". Ou seja: a partir desta correção, pedidos não suportados que passam por `configuracao.js` deixam de ter uma frase fixa e passam a ter texto gerado pelo Claude, dentro dos limites dessa instrução. Isso provavelmente é desejável (resposta mais natural e contextual), mas é uma mudança de comportamento real, não neutra — melhor você estar ciente disso antes de aprovar, e vale validar esse cenário especificamente depois do deploy (ver Cenário 7 na seção 8).

**Não aplicar** o Ajuste A quando `context.medicationId` não existir (entrada fresca) — nesse caso a frase inteira precisa ir pro classificador local, que já sabe interpretá-la livremente (princípio já estabelecido: nunca lista de exclusão quando o classificador central resolve).

**Não tocar** em `isConfirmacao()` nem nas listas inline de `reativ_estoque`/`reativ_horarios` (`['sim','s','ok','continua',...]`) — essa divergência é o BUG-036, já registrado, tratado em sessão separada.

---

## 5. Arquivo `src/router.js`

### 5.1 — Nova função compartilhada `despacharEscalada`

Adicionar próximo a `classificarIntencaoComContexto` (mesma seção do arquivo):

```js
// ============================================================
// DESPACHO DE ESCALADA — usado quando um agente devolve
// { escalarParaRoteador: true } em vez de uma resposta de texto
// ============================================================

async function despacharEscalada({ user, message, image, contextoPreservado, historicoConversa }) {
    const { agente: agenteSelecionado, subtipoRelatorio } = await classificarIntencaoComContexto({
        message, currentState: 'configurando', historicoConversa
    });

    let agentName = agenteSelecionado;
    let response;

    if (agenteSelecionado === 'configuracao') {
        console.log(`⚙️ [ESCALADA] Ainda é configuração — reentra preservando medicamento — ${user.phone}`);
        response = await handleConfiguracao({
            user, message, historicoConversa,
            state: { state: 'configurando', context: { etapa: 'identif_intencao' } },
            context: {
                etapa: 'identif_intencao',
                medicationId: contextoPreservado?.medicationId || null,
                medicationNome: contextoPreservado?.medicationNome || null,
                schedulesAtivos: contextoPreservado?.schedulesAtivos || []
            }
        });
    } else {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        const idleState = { state: 'idle', context: {} };

        if (agenteSelecionado === 'cadastro') {
            console.log(`💊 [ESCALADA] Roteando para cadastro — ${user.phone}`);
            response = await handleCadastro({
                user, message, state: idleState, historicoConversa,
                context: { etapa: 'cad_nome' }
            });
        } else if (agenteSelecionado === 'relatorios') {
            console.log(`📊 [ESCALADA] Roteando para relatorios (${subtipoRelatorio}) — ${user.phone}`);
            response = await handleRelatorios({ user, message, subtipo: subtipoRelatorio, state: idleState });
            if (!response) {
                agentName = 'principal';
                response = await handlePrincipal({ user, message, image, historicoConversa });
            }
        } else if (agenteSelecionado === 'nao_suportado') {
            agentName = 'principal';
            console.log(`🚧 [ESCALADA] Intenção não suportada — ${user.phone}`);
            await registrarIntencaoNaoSuportada(user.id, message);
            response = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true });
        } else {
            agentName = 'principal';
            console.log(`🤖 [ESCALADA] Roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });
        }
    }

    return { agentName, response };
}
```

Este é o mesmo padrão já usado nos blocos `aguardando_periodo_adesao`/`aguardando_escolha_tratamento` (linhas 486-520 e 553-587 do arquivo atual) — só extraído para reuso, já que agora temos um terceiro lugar (`configuracao.js`) que precisa da mesma lógica de "classificar e despachar".

### 5.2 — Os 5 pontos que chamam `handleConfiguracao` passam a checar o sinal

Padrão idêntico nos 5 lugares — mostro os dois mais diferentes por completo, e a mesma transformação vale para os outros 3.

**Ponto 1 — linha ~594, estado `configurando` (o caso mais comum, mensagem no meio de um fluxo):**
```js
// ANTES
} else if (currentState === 'configurando') {
    agentName = 'configuracao';
    console.log(`⚙️ Roteando para configuração (estado configurando) — ${user.phone}`);
    response = await handleConfiguracao({
        user, message, state, historicoConversa,
        context: state?.context || {}
    });

// DEPOIS
} else if (currentState === 'configurando') {
    agentName = 'configuracao';
    console.log(`⚙️ Roteando para configuração (estado configurando) — ${user.phone}`);
    const resultadoConfig = await handleConfiguracao({
        user, message, state, historicoConversa,
        context: state?.context || {}
    });
    if (resultadoConfig?.escalarParaRoteador) {
        const escalada = await despacharEscalada({
            user, message, image, historicoConversa,
            contextoPreservado: state?.context
        });
        agentName = escalada.agentName;
        response = escalada.response;
    } else {
        response = resultadoConfig;
    }
```

**Ponto 2 — linha ~710, dentro do classificador central geral (`agenteSelecionado === 'configuracao'`):**
```js
// ANTES
} else if (agenteSelecionado === 'configuracao') {
    console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao — ${user.phone}`);
    response = await handleConfiguracao({
        user, message, state, historicoConversa,
        context: { etapa: 'identif_intencao' }
    });

// DEPOIS
} else if (agenteSelecionado === 'configuracao') {
    console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao — ${user.phone}`);
    const resultadoConfig = await handleConfiguracao({
        user, message, state, historicoConversa,
        context: { etapa: 'identif_intencao' }
    });
    if (resultadoConfig?.escalarParaRoteador) {
        const escalada = await despacharEscalada({
            user, message, image, historicoConversa,
            contextoPreservado: null // entrada fresca, não há medicamento prévio pra preservar
        });
        agentName = escalada.agentName;
        response = escalada.response;
    } else {
        response = resultadoConfig;
    }
```

**Pontos 3, 4 e 5** — linha ~506 (dentro de `aguardando_periodo_adesao`), linha ~573 (dentro de `aguardando_escolha_tratamento`) e linha ~603 (`idle` + `detectarIntencaoConfiguracao`): aplicar exatamente a mesma transformação — capturar o retorno de `handleConfiguracao` numa variável, checar `resultadoConfig?.escalarParaRoteador`, e se verdadeiro chamar `despacharEscalada` com `contextoPreservado: state?.context` (ou `null` quando a chamada original já usava `context: { etapa: 'identif_intencao' }` sem medicamento prévio, como nos pontos 2, 4 e 5).

**Importante:** em nenhum desses 5 pontos o `agent_logs` deve ganhar uma segunda escrita — a escrita final continua sendo a única, no fim do `routeMessage` (linha 727-734), usando o `agentName`/`response` que `despacharEscalada` já resolveu corretamente.

---

## 6. Arquivo `src/database.js` — mecanismo complementar (resolução de referência em mensagens futuras)

Este item é **independente** do restante da correção — resolve um cenário diferente: uma mensagem nova, numa conversa futura, já em `idle`, sem nenhum `context` vivo, onde o usuário usa uma referência ambígua ("ele", "aquilo") a um assunto de configuração que não foi resolvido antes.

```js
// ANTES — getHistoricoRecente()
export async function getHistoricoRecente(userId, limite = 3) {
    const { data, error } = await supabase
        .from('agent_logs')
        .select('user_message, agent_response, agent, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limite);
    ...
}

// DEPOIS
export async function getHistoricoRecente(userId, limite = 3) {
    const { data, error } = await supabase
        .from('agent_logs')
        .select('user_message, agent_response, agent, estado_conversa, contexto_conversa, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limite);
    ...
}
```

E em `router.js`, dentro de `classificarIntencaoComContexto`:
```js
// ANTES
const historicoTexto = historicoConversa.length > 0
    ? historicoConversa.map(h =>
        `Usuário: ${h.user_message}\nNami: ${h.agent_response}`
      ).join('\n\n')
    : 'Sem histórico recente.';

// DEPOIS
const historicoTexto = historicoConversa.length > 0
    ? historicoConversa.map(h => {
        const contextoResumo = h.contexto_conversa?.medicationNome
            ? ` [em andamento: configuração sobre ${h.contexto_conversa.medicationNome}, etapa ${h.contexto_conversa.etapa}]`
            : '';
        return `Usuário: ${h.user_message}\nNami: ${h.agent_response}${contextoResumo}`;
      }).join('\n\n')
    : 'Sem histórico recente.';
```

Isso é estritamente aditivo — nenhum agente que já consome `historicoConversa` quebra por causa dessas duas colunas a mais no retorno.

---

## 7. Ordem de execução

1. `nlp_helpers.js` — apertar e ampliar `isCancelamento()`.
2. `configuracao.js` — aplicar o modelo de 3 camadas nas 8 etapas + caso especial de `identif_intencao`.
3. `router.js` — criar `despacharEscalada()`, atualizar os 5 pontos de chamada de `handleConfiguracao`.
4. `database.js` — enriquecer `getHistoricoRecente()`.
5. `router.js` — enriquecer `classificarIntencaoComContexto()` com o resumo de `contexto_conversa`.
6. Deploy.
7. Validar (seção 8).

---

## 8. Validação pós-deploy

**Cenário 1 — cancelamento reconhecido pela lista fixa (Camada 2):**
Forçar estado `configurando`, etapa `obter_horario`, com um medicamento no contexto. Enviar "deixa quieto". Esperado: sai para `idle`, mensagem "Tudo bem! Nada foi alterado...". `agent_logs` deve mostrar a etapa correta antes da saída.

**Cenário 2 — correção de horário não deve ser confundida com cancelamento:**
Mesmo estado acima. Enviar "não, muda pra 15h". Esperado: Camada 1 reconhece "15h" primeiro, segue pro `confirm_acao` normalmente — **não** deve sair pra idle.

**Cenário 3 — escalada pra outro agente (Camada 3), preservando referência:**
Estado `configurando`, `identif_intencao` com `medicationId` do Losartana (retorno de "pausar ou encerrar?"). Enviar "quero saber o estoque do Losartana" (ou, se o BUG-058 já estiver corrigido, testar com "quero saber o estoque dele"). Esperado: `agent_logs` mostra `agent: relatorios`, resposta correta sobre o estoque do Losartana.

**Cenário 4 — escalada de volta pra configuração, contexto preservado:**
Mesmo estado do cenário 3. Enviar "na real quero só mudar o horário dele". Esperado: reentra em `identif_intencao` com `medicationId` do Losartana já preenchido — o usuário não precisa repetir o nome do medicamento. `classificarIntencao` interno deve resolver `acao: 'alterar_horario'` e seguir o fluxo normalmente a partir daí.

**Cenário 5 — nenhum vazamento de contexto entre conversas não relacionadas:**
Repetir o cenário 3 ou 4, deixar a conversa terminar (voltar a `idle`), fazer uma interação completamente não relacionada (ex: cadastrar um medicamento novo do início ao fim), e só então pedir para alterar o horário de um terceiro medicamento. Esperado: `identif_intencao` entra **sem** `medicationId` nenhum — nada do Losartana deve aparecer.

**Cenário 6 — as 7 etapas restantes (`identif_schedule`, `identif_schedule_remocao`, `obter_novos_horarios`, `reativ_tipo_tratamento`, `reativ_estoque`, `reativ_horarios`, `identif_intencao` com medicationId):**
Repetir uma variação do cenário 1 em cada uma, forçando o estado/etapa diretamente no Supabase antes de enviar a mensagem de desistência.

**Cenário 7 — pedido genuinamente não suportado, agora com resposta gerada pelo LLM em vez de string fixa:**
Estado `configurando`, `identif_intencao`, sem medicamento no contexto. Enviar "quero mudar a dosagem do Losartana" (exemplo de algo que nem o classificador interno nem o central suportam). Esperado: classificador interno retorna `nao_suportado` → escala → classificador central também retorna `nao_suportado` → `handlePrincipal` gera a resposta explicando que a funcionalidade está em desenvolvimento. Conferir que o texto gerado não inventa que a ação foi feita e não deriva pra pausar/encerrar/cadastrar (a instrução em `principal.js` linha 285-289 já proíbe isso, mas vale confirmar na prática com um caso real).