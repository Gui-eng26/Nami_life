# BRIEFING — MH-073 Parte B.1

**Blindagem de becos sem saída no `cadastro.js` — escalada ao roteador via ponto único de despacho**

Sessão v35 · 25/08/2026 · Prioridade: alta

---

## ⚠️ AÇÕES BLOQUEANTES

**Nenhuma.** Não há migration nesta parte. Não há alteração de schema. Não há ação manual
de Guilherme antes do deploy.

---

## 1. O PROBLEMA

O `cadastro.js` é o único agente de fluxo do projeto **sem escalada ao roteador**.

Verificado no `main` em 25/08/2026:

```
grep -c "escalarParaRoteador" src/agentes/cadastro.js      -> 0
grep -c "escalarParaRoteador" src/agentes/configuracao.js  -> 12
grep -c "escalarParaRoteador" src/agentes/data_nascimento.js -> 1
```

`handleCadastro` nunca devolve `{ escalarParaRoteador: true }`, e o `router.js` não
intercepta esse sinal para ele — embora já intercepte para `configuracao` e
`data_nascimento` em seis pontos (L697, L802, L889, L927, L948, L1062).

**Consequência prática:** durante um cadastro em andamento, se o usuário disser "quero ver
meus remédios", "qual meu estoque de Atenolol" ou qualquer outra intenção fora do fluxo, ela
não tem para onde ir. A única saída existente é `TERMOS_CANCELAMENTO`
(`cadastro.js:1540`) — lista fixa que cobre "cancela", "deixa pra lá", "esquece", mas não
cobre outra intenção legítima.

Viola o princípio de produto declarado no CONTEXT.md: *"o usuário nunca deve ficar preso em
um fluxo; todo fluxo precisa de saída de emergência."*

**Por que a Parte B.2 não resolveu isso:** a B.2 mudou o contrato do LLM (passou a devolver
só `message`) e deu ramo determinístico a todas as etapas. Não tocou em escalada — nenhuma
linha. São coisas diferentes: a B.2 governa **como a etapa decide**; a B.1 governa **como o
usuário sai da etapa**.

**O que já foi resolvido de lado:** o BUG-92 eliminou a causa mais comum de sequestro de
mensagem (estado não retornava a `idle` após `cad_salvo`). O que resta é estritamente:
intenção fora do fluxo **durante** um cadastro em andamento.

---

## 2. MODELO CANÔNICO DE ESCALADA (decisão de arquitetura da v35)

A investigação da v35 constatou que o projeto tem hoje **três formas diferentes** de
escalar, nenhuma declarada como padrão:

1. **`configuracao.js`, ~9 de 12 etapas** — parser determinístico → `isCancelamentoGenuino`
   → escala **direto**, sem nenhuma classificação semântica no meio.
2. **`configuracao.js`, `identif_intencao`** — parser → `isCancelamentoGenuino` →
   `processarIntencaoOuEscalar`, que roda um **classificador LLM de domínio próprio**
   (`classificarIntencao`, com 10 ações de configuração) → só escala se ele devolver
   `nao_suportado`.
3. **`data_nascimento.js`** — parser determinístico (`extrairComponenteData`, sem LLM) → se
   falhar, `classificarIndeterminado`, que julga **tipo de falha**
   (`recusa | duvida | nova_intencao | saudacao | ruido`) → só `nova_intencao` escala.

**Avaliação:** a diferença entre (3) e os outros é justificada pela natureza do fluxo
(coleta de um dado só, sem domínio de ações). A diferença entre (1) e (2), dentro do mesmo
arquivo e do mesmo domínio, é dívida acidental — histórica, não intencional.

**Modelo canônico declarado (v35), a seguir daqui em diante:**

```
Camada 1 — parser/classificador determinístico ou de domínio da própria etapa.
           Reconheceu? resolve ali.
Camada 2 — classificador local de "por que não reconheci", com categorias fechadas
           e uniformes: recusa | duvida | nova_intencao | ruido.
           Só nova_intencao escala. As outras três se resolvem dentro do agente.
Camada 3 — escalada ao roteador, via ponto único de despacho por agente.
```

Escolhido o modelo (3) e **não** o (2) por razão estrutural: um classificador de domínio
local é uma **terceira definição** do que cada agente sabe fazer (o classificador central já
é uma; o inventário do prompt é outra). O Princípio 5 existe para impedir inventários
divergentes, e isso já custou caro uma vez — o BUG-084 ocorreu porque o classificador local
de `configuracao` decidiu `remover_horario` sem ter a informação que a etapa tinha.

**Escopo de aplicação nesta parte: SOMENTE `cadastro.js`.** O `configuracao.js` NÃO é
migrado agora. Ele foi reescrito na v18 e recebeu cinco correções validadas em produção
(BUG-082/083/084/085); migrar suas 12 etapas reabriria superfície de teste em um arquivo
caro de estabilizar, sem nenhum defeito aberto que justifique. Ele converge quando houver
motivo para tocá-lo (provavelmente no próprio BUG-86).

---

## 3. DESENHO — DOIS ACHADOS QUE MUDARAM O ESCOPO INICIAL

### 3.1 Ponto único de classificação de falha, não seis prompts alterados

O desenho preliminar da sessão previa acrescentar as categorias novas aos **6 classificadores
existentes** do `cadastro.js`. A leitura completa do código mostrou que isso é pior e
desnecessário.

Os classificadores atuais e suas categorias:

| Etapa(s) | Função | Linha | Categorias hoje |
|---|---|---|---|
| `cad_nome`, `cad_dosagem` | `extrairCampoSimples` | 732 | `valor` / `indeterminado` |
| `cad_horarios`, `cad_quantidade_por_dose`, `cad_confirma_forma`, correções em `cad_confirmacao` | `classificarPosologia` | 643 | `posologia_completa` / `horarios_apenas` / `quantidade_apenas` / `frequencia_intervalo` / `indeterminado` |
| `cad_tipo_tratamento` | `classificarTipoTratamento` | 804 | `continuo` / `temporario` / `dias` / `indeterminado` |
| `cad_confirmacao` | `classificarConfirmacaoCadastro` | 931 | `confirma` / `corrige` / `indeterminado` |
| `cad_estoque` (sólido) | `classificarEstoqueSolido` | 337 | `quantidade` / `indeterminado` |
| `cad_estoque` (líquido), `cad_estoque_volume` | `extrairFrascosEVolume` / `extrairNumero` | 251 / 245 | regex puro, **sem LLM** |

Alterar seis prompts significa seis definições do que é `nova_intencao`, que divergem com o
tempo — exatamente o antipadrão do Princípio 30 ("a cópia nasce por falta de um lugar comum,
e depois diverge"). Além disso, alteraria prompts validados em produção na v34, aumentando o
raio de regressão sem necessidade.

**Desenho adotado — espelha o `data_nascimento.js`:** uma função nova
`classificarIndeterminadoCadastro`, chamada **só quando a camada 1 já falhou**. Nenhum dos 6
classificadores existentes tem prompt, validação ou contrato alterado.

Vantagens:
- Uma única definição das categorias de falha (Princípio 30).
- Zero alteração nos prompts validados na v34.
- Custo: uma chamada de LLM **adicional apenas no caminho de falha** (hoje já raro), nunca
  no caminho feliz.
- Resolve uniformemente o ramo líquido de estoque, que é regex puro e não tinha como
  reconhecer intenção nenhuma.

### 3.2 `cad_confirma_forma` NÃO recebe escalada — é decisão deliberada, não lacuna

`decidirCadConfirmaForma` (linha 1451) termina com um ramo que aceita **qualquer** resposta e
avança. O comentário no código (linha ~1447) é explícito:

> `// Etapa cad_confirma_forma NUNCA bloqueia (seção 6.3) — qualquer resposta avança.`

Isso é decisão de produto da Parte B, não defeito. Como a etapa nunca fica presa, **não há
beco sem saída para blindar**. Acrescentar escalada ali contrariaria uma decisão validada.

⚠️ **Instrução ao implementador:** NÃO adicionar tratamento de `nova_intencao` a
`decidirCadConfirmaForma`. Manter o comportamento atual íntegro.

### 3.3 Regra de reentrada — cadastro que volta para cadastro NÃO reinicia

Em `despacharEscalada`, `contextoPreservado` só é consumido no branch de `configuracao`;
para todos os outros destinos a função faz `saveConversationState(idle)` e descarta o
contexto. Isso significa que a preservação só importa no caso **cadastro → cadastro**.

Se o classificador central, ao reclassificar a mensagem, devolver `cadastro` de novo, ele
está **concordando** que o usuário não saiu do fluxo. Não há motivo para reiniciar nada.

**Regra adotada:**

- Classificador central devolve `cadastro` → **não reentra**. Mantém etapa e contexto
  exatamente como estão e repete a pergunta pendente.
- Classificador central devolve qualquer outro agente → comportamento atual de
  `despacharEscalada` (estado vai a `idle`, contexto descartado).

Com isso, nenhum dado coletado é perdido em nenhum caminho, e não é preciso mexer em
`contextoPreservado` para cadastro.

### 3.4 Delimitação estreita de `nova_intencao` (crítico)

`nova_intencao` significa **"o usuário quer fazer algo fora do cadastro"**.

Correções **dentro** do cadastro — inclusive trocar de medicamento ("não é esse remédio, é
outro") — **NÃO** são `nova_intencao`. Caem em `ruido` e a etapa repete a pergunta,
exatamente como hoje.

Motivo: o `case 'nome'` de `cad_confirmacao` (linha ~1798) hoje faz `contextUpdates: {}` e
**mantém** dosagem, horários, pares de posologia e estoque do medicamento anterior. Enquanto
isso não for corrigido (registrado como MH próprio, ver seção 8), tratar troca de remédio
como escalada propagaria dado errado. Manter em `ruido` preserva o comportamento atual, que
funciona.

---

## 4. IMPLEMENTAÇÃO

### 4.1 Nova função `classificarIndeterminadoCadastro` (`src/agentes/cadastro.js`)

Inserir na seção de classificadores, antes de `calcularDecisaoEtapa`.

```javascript
// ============================================================
// MH-073 Parte B.1 — CLASSIFICADOR DE FALHA (camada 2 do modelo canônico)
// ============================================================
//
// Roda SÓ quando a camada 1 (classificador de campo/parser da etapa) já falhou.
// Não julga domínio — julga POR QUE a mensagem não foi reconhecida. Mesma forma do
// classificarIndeterminado de data_nascimento.js (MH-072), agora declarada como
// modelo canônico de escalada do projeto (v35).
//
// Ponto ÚNICO de definição das categorias de falha (Princípio 30): nenhum dos 6
// classificadores de campo existentes tem prompt ou contrato alterado por esta parte.
//
// nova_intencao é DELIBERADAMENTE ESTREITA: só "quer fazer algo FORA do cadastro".
// Correção dentro do cadastro — inclusive trocar de medicamento — é 'ruido', e a
// etapa repete a pergunta. Ver seção 3.4 do briefing e o MH de reset parcial.

async function classificarIndeterminadoCadastro({ message, etapa, nomeMedicamento, historicoConversa = [] }) {
    const systemPrompt = `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami),
que está no meio do cadastro de um medicamento${nomeMedicamento ? ` ("${nomeMedicamento}")` : ''} e fez
uma pergunta ao usuário. A mensagem do usuário NÃO foi reconhecida como resposta a essa pergunta.

Classifique-a em UMA destas categorias:

- recusa: o usuário não quer continuar o cadastro agora, está incomodado, ou pede para parar.
  Ex: "não quero mais", "chega", "deixa isso pra depois", "para com isso".
- duvida: o usuário pergunta o motivo da pergunta ou questiona a necessidade dela, sem recusar
  e sem mudar de assunto. Ex: "pra que você precisa disso?", "por que essa pergunta?",
  "isso é obrigatório?".
- nova_intencao: o usuário quer fazer OUTRA COISA, FORA do cadastro de medicamento.
  Ex: "quero ver meus remédios", "qual meu estoque de atenolol?", "tomei o remédio das 8",
  "quero pausar os lembretes da dipirona", "quanto tempo falta pro meu tratamento acabar".
  ATENÇÃO — o seguinte NÃO é nova_intencao, é ruido:
    * corrigir qualquer informação DO PRÓPRIO cadastro em andamento (nome do remédio,
      dosagem, horário, quantidade, estoque);
    * dizer que o medicamento está errado ou que quer cadastrar outro
      (ex: "não é esse remédio, é outro", "na verdade é o losartana");
    * qualquer coisa que continue sendo sobre o cadastro que está acontecendo agora.
- ruido: a mensagem não se encaixa em nenhuma das anteriores — resposta confusa,
  incompreensível, fora de contexto, ou que simplesmente não responde à pergunta.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

ETAPA ATUAL DO CADASTRO: ${etapa}

MENSAGEM ATUAL: "${message}"

Responda APENAS com uma palavra: recusa, duvida, nova_intencao ou ruido.
Sem pontuação, sem explicação.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: systemPrompt,
            messages: [{ role: 'user', content: message || '' }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        const validos = ['recusa', 'duvida', 'nova_intencao', 'ruido'];
        const achado = validos.find(v => texto.includes(v));
        console.log(`💊 [CADASTRO] Classificador de falha (etapa ${etapa}): "${message}" -> ${achado || 'ruido (fallback)'}`);
        return achado || 'ruido';
    } catch (e) {
        console.error(`❌ [CADASTRO] Erro no classificador de falha: ${e.message} — assumindo ruido`);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_falha_indeterminado',
            agent: 'cadastro',
            detalhe: { erro: e.name, status: e?.status ?? null, etapa },
            fallback: 'ruido'
        });
    }
}
```

⚠️ O fallback é `'ruido'`, **nunca** `'nova_intencao'`: falha do classificador não pode
derrubar um cadastro em andamento (mesma disciplina do `classificarConsentimentoLgpd`, cujo
fallback nunca é `aceite`).

⚠️ Acrescentar a entrada `cadastro:classificador_falha_indeterminado` ao catálogo
`DEGRADACOES` em `src/observabilidade.js`, severidade `baixa` (a degradação devolve ao
comportamento anterior à B.1, que é repetir a pergunta).

### 4.2 Marcador uniforme de falha nas funções de decisão

Hoje três ramos de falha **não emitem** campo `acao`, o que impede um hook central. Uniformizar:

**Em `calcularDecisaoEtapa`, ramo `cad_nome`** — a linha atual
```javascript
        return { proximaEtapa: 'cad_nome', contextUpdates: {} };
```
passa a
```javascript
        return { proximaEtapa: 'cad_nome', contextUpdates: {}, acao: 'indeterminado' };
```

**Ramo `cad_dosagem`** — a linha atual
```javascript
        return { proximaEtapa: 'cad_dosagem', contextUpdates: {} };
```
passa a
```javascript
        return { proximaEtapa: 'cad_dosagem', contextUpdates: {}, acao: 'indeterminado' };
```

**Ramo `cad_confirmacao`, retorno final (categoria `indeterminado`)** — a linha atual
```javascript
        return { proximaEtapa: 'cad_confirmacao', contextUpdates: {} };
```
passa a
```javascript
        return { proximaEtapa: 'cad_confirmacao', contextUpdates: {}, acao: 'indeterminado' };
```

⚠️ **NÃO** alterar o `default:` interno do `switch (classificacao.campoAlvo)` dentro do ramo
`corrige` — ali o usuário FOI entendido (quis corrigir), só não se sabe qual campo. Isso é
pedido de esclarecimento, não falha de reconhecimento. Deve continuar sem `acao`.

Os demais já emitem: `decidirCadHorarios` / `decidirCadQuantidade` /
`decidirCadTipoTratamento` devolvem `acao: 'indeterminado'` no `default:`;
`processarEstoque` devolve `acao: 'estoque_indeterminado'` e `acao: 'volume_indeterminado'`.

### 4.3 Hook central em `decidirEtapa` (ponto único)

`decidirEtapa` (linha 1872) já é o ponto único por onde toda decisão passa. Substituir o
corpo atual por:

```javascript
// Ações que significam "a camada 1 não reconheceu a mensagem". Ponto único de
// definição (Princípio 30) — acrescentar aqui, nunca espalhar checagens por etapa.
const ACOES_DE_FALHA = new Set(['indeterminado', 'estoque_indeterminado', 'volume_indeterminado']);

async function decidirEtapa(etapaAtual, message, context, historicoConversa) {
    const resultado = await calcularDecisaoEtapa(etapaAtual, message, context, historicoConversa);

    // MH-073 Parte B.1 — camada 2 do modelo canônico. Só roda quando a camada 1 falhou;
    // no caminho feliz não há chamada de LLM adicional.
    if (ACOES_DE_FALHA.has(resultado.acao)) {
        const motivo = await classificarIndeterminadoCadastro({
            message,
            etapa: etapaAtual,
            nomeMedicamento: context?.nome,
            historicoConversa
        });

        if (motivo === 'nova_intencao') {
            return { escalarParaRoteador: true };
        }

        // recusa: encerra o cadastro pelo mesmo caminho já usado por ehCancelamento.
        if (motivo === 'recusa') {
            return { encerrarCadastro: true };
        }

        // duvida e ruido seguem o fluxo normal (repetem a pergunta da etapa), com
        // motivoFalha disponível para o gerador de texto fraseá-la adequadamente.
        resultado.contextParaPrompt = { ...(resultado.contextParaPrompt || {}), motivoFalha: motivo };
    }

    const contextCompleto = { ...context, ...resultado.contextUpdates };
    return {
        ...resultado,
        contextParaPrompt: await garantirResumo(resultado.proximaEtapa, contextCompleto, resultado.contextParaPrompt)
    };
}
```

### 4.4 `handleCadastro` — propagar os dois sinais

Em `handleCadastro` (linha 2125), logo após a chamada a `decidirEtapa`:

```javascript
    const decisao = await decidirEtapa(etapaAtual, message, context, historicoConversa);

    // MH-073 Parte B.1 — camada 3. O sinal sobe para o router, que despacha.
    if (decisao?.escalarParaRoteador) {
        console.log(`💊 [CADASTRO] Nova intenção fora do cadastro — escalando ao roteador — ${user.phone}`);
        return { escalarParaRoteador: true };
    }

    if (decisao?.encerrarCadastro) {
        console.log(`💊 [CADASTRO] Recusa explícita — encerrando cadastro — ${user.phone}`);
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, parei o cadastro por aqui 🌿 Se quiser retomar depois, é só me chamar!`;
    }
```

⚠️ Diferente de `data_nascimento.js`, o `cadastro.js` **NÃO** deve gravar
`saveConversationState(idle)` antes de devolver `escalarParaRoteador` — a regra 3.3 exige
que o estado sobreviva caso o classificador central devolva `cadastro`. Quem zera o estado é
o `despacharEscalada`, e só nos destinos que não são cadastro.

### 4.5 Bloco de texto para `motivoFalha` (`montarBlocoEtapa` / `buildSystemPrompt`)

`duvida` e `ruido` seguem repetindo a pergunta da etapa. Para `duvida`, o texto precisa
reconhecer a pergunta do usuário antes de repetir. Acrescentar em `buildSystemPrompt`
(linha 2006), no bloco base compartilhado, o seguinte trecho condicional:

```javascript
    const blocoMotivoFalha = context?.motivoFalha === 'duvida'
        ? `\n\nA pessoa perguntou POR QUE você precisa dessa informação. Antes de repetir a
pergunta, responda com honestidade e em uma frase curta: você precisa desse dado para
montar os lembretes certos e acompanhar o tratamento dela. Não insista, não negocie e não
minimize a pergunta dela.`
        : '';
```

E concatenar `blocoMotivoFalha` ao prompt base, junto dos blocos já existentes.

⚠️ Princípio 44: o prompt do `cadastro.js` inclui somente o bloco da etapa ativa desde a
B.2. Manter esse isolamento — `blocoMotivoFalha` entra no bloco base, não dentro de
`montarBlocoEtapa`.

### 4.6 `despacharCadastro` — ponto único no `router.js`

Criar imediatamente após `despacharRelatorio` (que termina na linha ~513), no mesmo molde:

```javascript
// ============================================================
// DESPACHO DE CADASTRO (MH-073 Parte B.1) — ponto ÚNICO de chamada de handleCadastro.
// Encapsula a interceptação de { escalarParaRoteador: true }, que antes não existia para
// este agente. Instrumentar call site a call site é a causa raiz do BUG-069 (1 de 6
// pontos esquecido) — Princípio 30.
//
// REGRA DE REENTRADA (seção 3.3 do briefing): quando o classificador central devolve
// 'cadastro' de novo, ele está CONCORDANDO que o usuário não saiu do fluxo — o estado e o
// contexto são mantidos como estão e a pergunta pendente é repetida. Nenhum dado coletado
// é descartado. Só destinos diferentes de cadastro passam pelo despacharEscalada.
// ============================================================
async function despacharCadastro({ user, message, image, state, context, historicoConversa,
                                   contextoProativo = null }) {
    const resultado = await handleCadastro({ user, message, state, context, historicoConversa });

    if (!resultado?.escalarParaRoteador) {
        return { agentName: 'cadastro', response: resultado };
    }

    const { agente: agenteSelecionado } = await classificarIntencaoComContexto({
        message,
        currentState: state?.state || 'adding_med',
        historicoConversa,
        contextoProativo
    });

    if (agenteSelecionado === 'cadastro') {
        // Ainda é cadastro — repete a pergunta pendente sem reiniciar nada.
        console.log(`💊 [ESCALADA-CADASTRO] Classificador confirmou cadastro — mantendo fluxo — ${user.phone}`);
        const retomada = await handleCadastro({
            user,
            message: '',
            state,
            context,
            historicoConversa
        });
        return { agentName: 'cadastro', response: retomada };
    }

    const escalada = await despacharEscalada({
        user, message, image, historicoConversa, contextoProativo,
        contextoPreservado: null
    });
    return {
        agentName: escalada.agentName,
        response: escalada.response,
        feedback: escalada.feedback,
        intencaoNaoSuportadaDetectada: escalada.intencaoNaoSuportadaDetectada
    };
}
```

⚠️ **Ponto de atenção para o implementador:** a chamada de retomada acima passa
`message: ''`. Verificar se `calcularDecisaoEtapa` lida bem com mensagem vazia em todas as
etapas — se qualquer classificador quebrar com string vazia, trocar a estratégia por uma
chamada direta a `buildSystemPrompt(etapaAtual, ...)` + `callClaude`, sem passar por
`decidirEtapa`. **Se detectar defeito nesta especificação, corrigir e reportar — não copiar
verbatim** (lição da v34).

⚠️ Note que `despacharCadastro` chama `classificarIntencaoComContexto` com o `currentState`
**real**, não com a string fixa `'configurando'` de `despacharEscalada`. Isso é deliberado e
não altera `despacharEscalada` — ver ACH registrado na seção 8.

### 4.7 Substituir os 8 call sites de `handleCadastro` no `router.js`

Todos os 8 pontos passam a chamar `despacharCadastro`. Linhas atuais: **549, 715, 786, 873,
965, 978, 990, 1046**.

Padrão de substituição (adaptar `state`/`context` de cada site, que diferem):

```javascript
// ANTES
response = await handleCadastro({ user, message, state, historicoConversa, context: { etapa: 'cad_nome' } });

// DEPOIS
const rCad = await despacharCadastro({ user, message, image, state, historicoConversa,
                                       contextoProativo, context: { etapa: 'cad_nome' } });
agentName = rCad.agentName;
response = rCad.response;
feedbackDetectado = rCad.feedback ?? feedbackDetectado;
if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
```

⚠️ Preservar o `state` e o `context` **exatos** de cada call site — eles não são iguais
entre si (uns passam `idleState`, outros `state`, outros `context: state?.context || {}`).
Não uniformizar isso nesta parte.

⚠️ O call site dentro de `despacharEscalada` (linha ~549) chama `handleCadastro`
diretamente. Mantê-lo chamando `handleCadastro`, **não** `despacharCadastro` — chamar o
despacho de dentro do despacho criaria recursão. Adicionar comentário explicando.

---

## 5. INSTRUMENTAÇÃO (Princípio 29 — declarar pontos no briefing que cria a peça)

| Ponto | Origem | Motivo | Severidade |
|---|---|---|---|
| `classificarIndeterminadoCadastro`, catch | `cadastro` | `classificador_falha_indeterminado` | baixa |

Nenhum outro ponto novo. A escalada em si não gera evento (consistente com
`configuracao.js` e `data_nascimento.js`; a lacuna geral está registrada no MH-48).

---

## 6. CRITÉRIO DE CONCLUSÃO — COMANDO DE VARREDURA

Princípio 31, corolário: o critério é um comando que varre o projeto, nunca a lista de
pontos que o autor enumerou.

```bash
# 1. Nenhuma chamada direta a handleCadastro no router fora de despacharEscalada.
#    Esperado: exatamente 2 ocorrências (a definição do import e a de despacharEscalada).
grep -n "handleCadastro(" src/router.js

# 2. cadastro.js passou a escalar. Esperado: >= 2 ocorrências.
grep -c "escalarParaRoteador" src/agentes/cadastro.js

# 3. Todo ramo de falha emite marcador. Esperado: nenhuma linha sem 'acao'.
grep -n "proximaEtapa: 'cad_nome', contextUpdates: {} }" src/agentes/cadastro.js
grep -n "proximaEtapa: 'cad_dosagem', contextUpdates: {} }" src/agentes/cadastro.js
grep -n "proximaEtapa: 'cad_confirmacao', contextUpdates: {} }" src/agentes/cadastro.js

# 4. cad_confirma_forma NÃO recebeu escalada (decisão deliberada, seção 3.2).
#    Esperado: nenhuma ocorrência.
sed -n '/function decidirCadConfirmaForma/,/^}/p' src/agentes/cadastro.js | grep -c "escalarParaRoteador"

# 5. Sintaxe.
node --check src/agentes/cadastro.js && node --check src/router.js
```

Se qualquer um não voltar como esperado, o trabalho não está concluído.

---

## 7. CENÁRIOS DE VALIDAÇÃO EM PRODUÇÃO (WhatsApp real)

| # | Cenário | Esperado |
|---|---|---|
| 1 | Iniciar cadastro; em `cad_dosagem` dizer "qual meu estoque de dipirona?" | Escala; responde o estoque; cadastro NÃO continua preso |
| 2 | Em `cad_horarios` dizer "quero ver meus remédios" | Escala para relatórios |
| 3 | Em `cad_estoque` (sólido) dizer "tomei o remédio das 8" | Escala para principal/confirmação de dose |
| 4 | Em `cad_estoque_volume` (líquido) dizer "quero pausar os lembretes da dipirona" | Escala para configuração (ramo regex, antes impossível) |
| 5 | Em `cad_dosagem` dizer "pra que você precisa disso?" | `duvida` — explica o motivo e repete a pergunta, sem escalar |
| 6 | Em `cad_horarios` dizer "não quero mais, deixa isso pra depois" | `recusa` — encerra o cadastro com mensagem gentil |
| 7 | Em `cad_dosagem` responder algo incompreensível ("asdf") | `ruido` — repete a pergunta (comportamento de hoje) |
| 8 | Em `cad_horarios` dizer "não é esse remédio, é outro" | `ruido` — repete a pergunta. **NÃO** escala (seção 3.4) |
| 9 | Cadastro completo do zero, sem interrupção (sólido) | Idêntico ao de hoje — não-regressão |
| 10 | Cadastro completo do zero, sem interrupção (líquido/gotas) | Idêntico ao de hoje — não-regressão |
| 11 | MH-80: mensagem inicial completa ("Quero cadastrar Seki xarope, 5ml de 12/12h por 6 dias, tenho 1 vidro de 100ml") | Salto preservado — não-regressão |
| 12 | Correção em `cad_confirmacao` ("o horário está errado, é 14h") | Corrige sem escalar — não-regressão |
| 13 | "cancela" em qualquer etapa | `TERMOS_CANCELAMENTO` — comportamento de hoje |
| 14 | Escalada em que o classificador central devolve `cadastro` | Repete a pergunta pendente; nome/dosagem/horários já coletados **preservados** |

Cenários 9 a 13 são de **não-regressão** e são os mais importantes: a B.1 não pode degradar
o cadastro que já funciona.

---

## 8. REGISTROS EM `backlog_items` (autorizados por Guilherme na v35)

Este chat é read-only no Supabase. As escritas abaixo são responsabilidade do Claude Code,
no encerramento da sessão.

**INSERT 1 — ACH**
- `tipo`: `ACH`
- `titulo`: `despacharEscalada passa currentState: 'configurando' fixo, independente do agente de origem`
- `status`: `aberto` · `prioridade`: `baixa` · `relacionado`: `BUG-86`
- `descricao`: `router.js:522 — despacharEscalada chama classificarIntencaoComContexto com currentState hardcoded como 'configurando'. A string entra no prompt do classificador central (linha "ESTADO ATUAL: ${currentState}") e não é lida por nenhum if em código — não altera nenhuma decisão determinística. Quando a escalada vem de data_nascimento (desde a v30) o valor é falso. Efeito: pode enviesar o classificador a favor de configuracao em mensagens AMBÍGUAS; mensagens auto-suficientes são resolvidas pelo texto e não sofrem. Origem: a função nasceu na v18 servindo só ao configuracao.js, onde o valor era sempre verdadeiro; ganhou um segundo chamador na v30 e a linha nunca foi revisitada. HIPÓTESE NÃO MEDIDA — nenhuma ocorrência de dano registrada. Não mensurável hoje: escalada não deixa rastro em agent_logs (ver MH-48). Menção original em MH-65 (superseded) e como complicação no BUG-86. MH-073 Parte B.1 NÃO alterou esta linha: despacharCadastro passa o currentState real por conta própria.`

**INSERT 2 — MH**
- `tipo`: `MH`
- `titulo`: `Trocar de medicamento no meio do cadastro mantém dosagem, horários e estoque do anterior`
- `status`: `aberto` · `prioridade`: `media` · `relacionado`: `MH-073`
- `descricao`: `Em cad_confirmacao, o case 'nome' de calcularDecisaoEtapa devolve { proximaEtapa: 'cad_nome', contextUpdates: {} } — volta a perguntar o nome mas NÃO limpa dosagem, horarios, pares_posologia, unidade_dose, unidade_estoque, gotas_por_ml, tipo_tratamento nem estoque_resolvido do medicamento anterior. Se o usuário trocar de remédio ali, o cadastro segue com os dados do remédio errado. Fora de cad_confirmacao (cad_dosagem, cad_horarios etc.) não existe nem o caminho de correção de nome — a frase cai em indeterminado e a etapa repete a pergunta. CAUSA RAIZ CONFIRMADA por leitura de código (v35). Decisão de Guilherme na v35: NÃO corrigir agora — o cadastro funciona bem e um reset mal delimitado arriscaria desfazer a captação de dados construída nas Partes B/B.2/B.3. Por isso a Parte B.1 classifica deliberadamente "não é esse remédio, é outro" como ruido, nunca como nova_intencao (seção 3.4 do BRIEFING_MH073_B1.md). Ao implementar este MH, revisar essa classificação junto.`

**UPDATE** — MH-073 Parte B.1 → `em_validacao` após deploy.

---

## 9. FORA DE ESCOPO (declarado)

- **`currentState` hardcoded em `despacharEscalada`** — ACH acima. Não alterar
  `despacharEscalada` nesta parte.
- **BUG-86** — problema de camada 0 (o parser **acerta** sintaticamente; `isConfirmacao("Sim")`
  é verdadeiro e o fluxo executa sem nunca falhar). O modelo canônico só governa o que
  acontece **quando o parser falha**, então não o alcança. O que a B.1 faz por ele é remover
  metade do bloqueio declarado no backlog (a reentrada que descartava o fluxo pendente).
- **Migrar `configuracao.js` para o modelo canônico** — ver seção 2.
- **Reset parcial ao trocar de medicamento** — MH acima.
- **`cad_confirma_forma`** — não bloqueia por decisão de produto (seção 3.2).