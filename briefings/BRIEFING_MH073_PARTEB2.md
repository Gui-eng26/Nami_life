# BRIEFING — MH-073 Parte B.2: fronteira entre decisão determinística e geração de texto

**Sessão:** v34 · **Data:** 20/08/2026
**Item de backlog:** MH-073, parte B.2
**Origem:** bateria de validação em produção da Parte B (20/08, 13:20–14:45 BRT)
**Corrige:** BUG-90, BUG-91, BUG-92, BUG-93
**Arquivos tocados:** `src/agentes/cadastro.js` (reestruturação), `src/observabilidade.js`
**Migration nova:** nenhuma.

---

## 1. O que a validação da Parte B provou que FUNCIONA

Antes de mexer em qualquer coisa: a coleta, a derivação de unidades e a persistência da Parte B
estão corretas. Confirmado por leitura direta de `medications` e `schedules`:

| Caso | Resultado no banco |
|---|---|
| Voltaren colírio | `gota`/`ml`/`20`, `quantidade_por_dose = 4` (multiplicador "em cada olho" aplicado) |
| Rivotril gotas | `gota`/`ml`/`20`, `quantidade_por_dose = 20`, estoque `20` (1 frasco × 20ml) |
| Pantoprazol | posologia variável real: 06:00→2, 14:00→2, 22:00→1 |
| Atenolol | `quantidade_por_dose = 2`, baixa de 2 unidades correta em `stock_movements` |

⚠️ **Nada na seção 5 abaixo pode regredir esses resultados.** São a entrega da Parte B.

---

## 2. Causa raiz única — BUG-90

> **O estado é decidido em código, mas o texto é gerado livremente pelo LLM, e os dois divergem.**

`proximaEtapaForcada` governa a máquina de estados corretamente. Mas:

1. `buildSystemPrompt(etapa, ...)` monta **todas as instruções de todas as etapas num único bloco
   de texto** — o "Etapa atual" apenas sinaliza qual está ativa, não isola instrução nenhuma
   (**Princípio 44**, registrado na v33 e reincidente aqui).
2. A decisão do código chega ao LLM como **dado** dentro de um JSON (`acaoPosologia`,
   `proximaEtapaCalculada`, `resumoRenderizado`), não como **instrução vinculante**.
3. O LLM escolhe qual bloco de etapa seguir olhando o histórico da conversa — e erra.

### Prova documental (Rivotril, 13:47:12)

O usuário respondeu `"20ml"` na etapa `cad_estoque_volume`. `processarEstoque` executou
`finalizarComEstoque(1 × 20)` — **sabemos que executou porque `medications.estoque_atual = 20`
está gravado no banco**. O estado avançou para `cad_confirmacao`.

**O texto entregue repetiu a pergunta do volume**, com exemplos diferentes da primeira vez
("ex: 10ml, 20ml" → "ex: 10ml, 100ml") — duas gerações independentes, não um reenvio.

### Sintomas que a mesma causa explica, sem mecanismo adicional

| Sintoma observado | Etapa forçada pelo código | Bloco de instrução que o LLM usou |
|---|---|---|
| "Quantas **UNIDADES** de Claritin você tem?" (era líquido) | ramo `ml` de `cad_estoque` | ramo sólido |
| Resumo completo exibido logo após corrigir horários | `cad_quantidade_por_dose` | `cad_confirmacao` |
| Pergunta de volume repetida (Rivotril) | `cad_confirmacao` | `cad_estoque_volume` |
| **"Claritin foi cadastrado com sucesso" — falso, 2×** | `cad_quantidade_por_dose` | `cad_salvo` |

O último é o mais grave: `processarAcao` só roda quando `proximaEtapa === 'cad_salvo'`, e em
`cad_quantidade_por_dose` a etapa forçada **nunca** pode ser `cad_salvo`. A Nami afirmou sucesso
duas vezes sobre um cadastro que não existia — **afirmação falsa sobre estado de saúde**.

---

## 3. BUG-91 — o LLM apaga estado determinístico

A cadeia `if/else if` de `handleCadastro` cobre `cad_horarios`, `cad_quantidade_por_dose`,
`cad_confirma_forma`, `cad_estoque` e `cad_estoque_volume`. **Ficaram de fora `cad_nome`,
`cad_dosagem`, `cad_tipo_tratamento` e `cad_confirmacao`.**

Nessas quatro, `contextUpdatesForcados` é `null` e a linha de merge aceita o que o LLM escreveu:

```js
let novoContext = { ...(context||{}), ...(claudeResponse.novoContext||{}), ...(contextUpdatesForcados||{}) };
```

### Prova documental (Claritin) — `conversation_state` no momento desta análise

```json
{"nome":"Claritin","horarios":["14:40","20:00"],"unidade_dose":"ml",
 "pares_posologia": null,                      ← APAGADO
 "acaoPosologia":"indeterminado","etapa":"cad_quantidade_por_dose"}
```

`pares_posologia` existia com quantidade 5 em cada horário — o resumo das 14:29, renderizado em
código a partir dele, provou isso. No turno das 14:31:31 (etapa `cad_confirmacao`, **sem ramo
determinístico**) o LLM devolveu `pares_posologia: null` e o merge aceitou.

Sem os pares, `cad_horarios` reclassificou como `horarios_apenas` → foi para
`cad_quantidade_por_dose` → `"agora sim"` não é quantidade → `indeterminado` → **laço infinito**.
É a razão de o Claritin nunca ter sido gravado.

A "REGRA DE PERSISTÊNCIA DE CONTEXTO (CRÍTICA)" existe no prompt e **não impediu nada** — é
instrução, e instrução não é barreira. Violação direta do **Princípio 38**.

---

## 4. BUG-92 — o estado nunca volta para `idle` após salvar

```js
const novoState = proximaEtapa === 'idle' ? 'idle' : 'adding_med';
```

Com `proximaEtapa === 'cad_salvo'`, o estado fica `adding_med` / etapa `cad_salvo`. O bloco
`cad_salvo` do prompt instrui `proximaEtapa: "idle"`, mas isso só é lido **no turno seguinte** —
ou seja, o usuário fica preso em `adding_med` até mandar mais uma mensagem.

### Consequências confirmadas

- **Voltaren (13:42) não detectou os cadastros encerrados.** `verificarMedicamentoExistente` não
  filtra por `ativo` e teria encontrado as duas linhas de junho. Mas a checagem está condicionada
  a `etapaAtual === 'cad_nome'`, e a mensagem chegou em `etapaAtual = 'cad_salvo'` (log Railway
  17:27:13 mostra o mesmo padrão com o Claritin). **Rivotril funcionou apenas porque veio depois
  de um "Cancelar"**, que zerou o estado.
- **Lembrete do Atenolol preso no fluxo de cadastro** — `router.js` despacha tudo para
  `handleCadastro` enquanto o estado for `adding_med`.

⚠️ O item 9.1 da Parte B foi implementado corretamente. O defeito é que o **gatilho** é uma
suposição posicional sobre a máquina de estados, não o fato "um nome acabou de ser coletado".

---

## 5. BUG-93 — rótulo da posologia usa forma farmacêutica

```js
renderizarListaPosologia(pares, forma)   // forma = 'líquido'
```

Produz **"08:00 — 5 líquido"**. O rótulo da quantidade tem que vir de `unidade_dose`; `forma` só
serve para a linha `💉 Forma:`.

---

## 6. A CORREÇÃO — arquitetura

O princípio que amarra as quatro correções:

> **O LLM devolve apenas `message`. Todo o resto — próxima etapa, contexto, ação — é do código.**

Isso não é um endurecimento de prompt. É remover do LLM a capacidade de decidir, em vez de pedir
que ele não decida. É o mesmo movimento que a v31 fez no `recepcionista.js` (MH-072 Parte A:
separar classificação de geração), agora aplicado ao `cadastro.js`.

### 6.1 Toda etapa passa a ter ramo determinístico

Quatro etapas ganham decisão em código. Três classificadores novos, todos no padrão já
estabelecido (categoria fechada, `max_tokens` baixo, extrator tolerante de JSON, `degradar()` no
catch, validação determinística pós-parse):

| Etapa | Classificador | Categorias |
|---|---|---|
| `cad_nome` | `extrairCampoSimples({campo:'nome'})` | `valor` / `indeterminado` |
| `cad_dosagem` | `extrairCampoSimples({campo:'dosagem'})` | `valor` / `indeterminado` |
| `cad_tipo_tratamento` | `classificarTipoTratamento` | `continuo` / `temporario` / `dias` / `indeterminado` |
| `cad_confirmacao` | `classificarConfirmacaoCadastro` | `confirma` / `corrige` / `indeterminado` |

`extrairCampoSimples` é **um** classificador com dois usos (parâmetro `campo`), não dois.

### 6.2 `buildSystemPrompt` isola a instrução — mata o Princípio 44 na fonte

Duas mudanças:

1. **Recebe a etapa cuja PERGUNTA deve ser escrita** — isto é, a `proximaEtapa` já decidida pelo
   código, não a etapa de entrada. Hoje o parâmetro é a etapa de entrada e o LLM tem que inferir
   que deve perguntar a *próxima* coisa; essa ambiguidade é metade do BUG-90.
2. **Inclui SOMENTE o bloco daquela etapa.** As "REGRAS GERAIS", a regra de persistência e a
   lista de todas as etapas saem do prompt. O que sobra: identidade da Nami, regras de texto da
   seção 3.2 da Parte B (nome do medicamento + rótulo em negrito + "toma ou usa"), o bloco da
   etapa alvo, e os dados já resolvidos que ela precisa fraseiar.

Assinatura nova:

```js
function buildSystemPrompt(etapaDaPergunta, contextResolvido, userName, historicoConversa)
```

⚠️ A "REGRA ANTI-LOOP" do prompt atual **sai daqui** e vira responsabilidade da Parte B.1
(escalada ao roteador). Instrução de prompt não resolve laço — o Claritin é a prova: o laço
girou 5 turnos com a regra anti-loop ativa no prompt.

### 6.3 Formato de resposta do LLM

```json
{ "message": "mensagem para o usuário" }
```

Só isso. `proximaEtapa`, `novoContext` e `action` **saem do contrato**. Consequências no código:

```js
// ANTES
let proximaEtapa = proximaEtapaForcada || claudeResponse.proximaEtapa || 'cad_nome';
let novoContext = { ...(context||{}), ...(claudeResponse.novoContext||{}), ...(contextUpdatesForcados||{}) };

// DEPOIS
const proximaEtapa = decisao.proximaEtapa;                      // sempre do código
const novoContext = { ...(context||{}), ...decisao.contextUpdates }; // sempre do código
```

O `fallback` de `degradar()` em `callClaude` acompanha: passa a devolver só `{ message }`.

⚠️ **BUG-91 morre por construção com esta mudança** — não existe mais caminho pelo qual o LLM
escreva em `pares_posologia`.

### 6.4 Correção parcial preserva o que não foi corrigido

O Claritin expôs um segundo problema dentro do BUG-91: corrigir **só os horários** descartou a
quantidade já coletada. Mesmo com o merge consertado, `decidirCadHorarios` receberia
`horarios_apenas` e reperguntaria a quantidade sem necessidade.

`classificarConfirmacaoCadastro` devolve `campoAlvo` e, quando o alvo é posologia, delega a
`classificarPosologia` (já existe). Regra determinística de remapeamento:

```js
// Corrigir horários preserva as quantidades quando a contagem bate.
// "o primeiro horário é 14:40, não 8h" com pares [{08:00,5},{20:00,5}]
//   -> [{14:40,5},{20:00,5}]  — NÃO repergunta a quantidade.
function remapearParesParaNovosHorarios(paresAntigos, novosHorarios) {
    if (!paresAntigos?.length) return null;
    if (paresAntigos.length !== novosHorarios.length) return null;  // ambíguo -> repergunta
    const ordenados = [...paresAntigos].sort((a,b) => a.horario.localeCompare(b.horario));
    return [...novosHorarios].sort().map((h, i) => ({ horario: h, quantidade: ordenados[i].quantidade }));
}
```

Quando a contagem **não** bate (usuário passou de 2 para 3 horários), devolve `null` e o fluxo
repergunta a quantidade — comportamento correto, não regressão.

### 6.5 `cad_salvo` conclui no mesmo turno (BUG-92)

```js
if (proximaEtapa === 'cad_salvo') {
    const resultado = await processarAcao(action, user);
    // O cadastro terminou AGORA. Não existe turno seguinte de "cad_salvo":
    // o estado precisa sair de adding_med imediatamente, senão a próxima
    // mensagem do usuário (inclusive confirmação de dose) é sequestrada
    // pelo fluxo de cadastro (BUG-92).
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return resultado?.messageOverride || mensagemFinal;
}
```

O bloco `cad_salvo` do prompt deixa de mencionar `proximaEtapa: "idle"` (não existe mais campo).

### 6.6 Gate de duplicata deixa de ser posicional

```js
// ANTES: assume que cad_nome -> cad_dosagem é a única transição possível após coletar o nome.
if (etapaAtual === 'cad_nome' && novoContext.nome && proximaEtapa === 'cad_dosagem') {

// DEPOIS: o gatilho é o FATO "o nome acabou de ser coletado", não a posição na máquina.
const nomeRecemColetado = !context?.nome && !!novoContext.nome;
if (nomeRecemColetado) {
```

⚠️ Com 6.5 aplicado, o caso Voltaren já não se reproduz (o estado volta a `idle` e o cadastro
recomeça em `cad_nome`). Esta mudança é a **barreira redundante**: o gate passa a não depender de
qual etapa antecede a coleta do nome — se uma etapa nova for inserida antes de `cad_dosagem` no
futuro, a checagem continua funcionando.

### 6.7 Rótulo da posologia (BUG-93)

```js
// O rótulo da QUANTIDADE vem da unidade de dose. A forma farmacêutica só
// descreve o medicamento (linha "Forma:"), nunca conta a dose.
const ROTULO_DOSE = { ml: 'ml', gota: 'gota' };   // 'gota' pluraliza para 'gotas'

function rotuloDaDose(unidadeDose, forma) {
    if (ROTULO_DOSE[unidadeDose]) return ROTULO_DOSE[unidadeDose];
    // unidade_dose = 'unidade': usa a forma quando ela é contável, senão "unidade"
    return ['comprimido','cápsula'].includes(forma) ? forma : 'unidade';
}
```

`renderizarResumo` passa a chamar `renderizarListaPosologia(pares, rotuloDaDose(...))`.
`pluralizarRotulo` ganha `gota → gotas`.

⚠️ `renderizarBlocoPosologia` (usado em `cad_confirma_forma`) tem o mesmo defeito e recebe a
mesma correção — ponto único, não dois.

---

## 7. Observabilidade (Princípio 29)

Entradas novas no catálogo `DEGRADACOES` de `observabilidade.js`:

```
'cadastro:classificador_campo_simples_falhou'   → severidade: media
'cadastro:classificador_tipo_tratamento_falhou' → severidade: media
'cadastro:classificador_confirmacao_falhou'     → severidade: alta
```

A última é `alta`: falha na confirmação significa que o usuário confirmou e o cadastro não
avançou — o modo de falha exato que produziu o Claritin fantasma.

⚠️ **Instrumentação nova exigida por BUG-90**, sem a qual a divergência estado×texto continua
invisível. Ao final de cada turno, quando `proximaEtapa` for `cad_salvo`, registrar em
`system_events` se `pares_posologia` está vazio ou `estoque_resolvido` é nulo:

```
'cadastro:salvamento_com_estado_incompleto'     → severidade: critica
```

Nenhum dos 17 cenários de validação da Parte B teria pegado o Claritin fantasma sem isso — a
conversa parecia saudável em `agent_logs` (**Princípio 24**: `agent_logs` registra a resposta
pretendida, não o efeito real).

---

## 8. Checklist de verificação

```bash
# 1. O LLM não decide mais etapa nem contexto
grep -n "claudeResponse.proximaEtapa\|claudeResponse.novoContext" src/agentes/cadastro.js
# esperado: nenhuma linha

# 2. Nenhuma etapa sem ramo determinístico
grep -n "etapaAtual === " src/agentes/cadastro.js
# esperado: cad_nome, cad_dosagem, cad_horarios, cad_quantidade_por_dose,
# cad_confirma_forma, cad_tipo_tratamento, cad_estoque, cad_estoque_volume,
# cad_confirmacao, cad_reencadastro_confirmar — todas presentes

# 3. Forma farmacêutica não é mais rótulo de quantidade
grep -n "renderizarListaPosologia\|renderizarBlocoPosologia" src/agentes/cadastro.js
# esperado: toda chamada recebe rotuloDaDose(...), nunca `forma`

# 4. O prompt não lista mais todas as etapas
grep -c "^cad_" src/agentes/cadastro.js
# esperado: contagem compatível com blocos isolados, não com a lista monolítica

# 5. Sintaxe
node --check src/agentes/cadastro.js && node --check src/observabilidade.js
```

---

## 9. Cenários de validação

### Não-regressão da Parte B (obrigatórios — reexecutar os que já passaram)

1. Sólido 1 un/dose, 1 horário → grava igual a hoje.
2. Sólido multi-unidade ("2 comprimidos") → `quantidade_por_dose = 2`.
3. Posologia completa em `cad_horarios` ("2 cps às 8 e 1 cp às 20") → 2 schedules, 2 e 1.
4. Colírio "2 gotas em cada olho" → `quantidade_por_dose = 4`.
5. Frasco lacrado em dois turnos → `frascos × volume`.
6. Frasco lacrado numa resposta só ("2 frascos de 10ml") → salta `cad_estoque_volume`.

### BUG-90 — texto casa com o estado

7. **Reprodução exata do Rivotril:** líquido → "1 frasco" → "20ml" → ✅ o resumo aparece
   **imediatamente**, sem repetir a pergunta do volume.
8. **Reprodução exata do Claritin:** líquido → na pergunta de estoque, ✅ a Nami pergunta
   **FRASCOS**, nunca "quantas unidades".
9. **Sucesso nunca é anunciado sem gravação:** em qualquer ponto do fluxo, se a Nami disser
   "cadastrado com sucesso", o registro existe em `medications`. Conferir no banco, não na tela.

### BUG-91 — estado determinístico sobrevive à correção

10. **Reprodução exata do Claritin:** cadastrar líquido "5ml às 8 e às 20" → no resumo, responder
    *"Na verdade o primeiro horário é às 14:40, não as 8hrs"* →
    ✅ a Nami **não repergunta a quantidade**; o resumo volta com `14:40 — 5ml` e `20:00 — 5ml`.
    ✅ `conversation_state.context.pares_posologia` nunca fica `null`.
11. Corrigir aumentando o número de horários (2 → 3) → ✅ repergunta a quantidade (contagem não
    bate; comportamento correto).
12. Corrigir a dosagem no resumo → ✅ volta a `cad_dosagem`, mantém posologia e estoque.

### BUG-92 — estado volta a `idle`

13. Concluir um cadastro e conferir `conversation_state` → ✅ `state = 'idle'`, `context = {}`
    **no mesmo turno**.
14. Concluir um cadastro e, na mensagem seguinte, cadastrar um medicamento **encerrado**
    (ex: Voltaren) → ✅ a Nami reconhece o cadastro anterior e oferece reencadastro.
15. Concluir um cadastro e receber um lembrete → ✅ responder "tomei" dá baixa normalmente, sem
    passar pelo fluxo de cadastro.

### BUG-93 — rótulo

16. Xarope 5ml → ✅ resumo mostra `08:00 — 5ml`, nunca `5 líquido`.
17. Colírio → ✅ `07:00 — 4 gotas`. Comprimido → `08:00 — 2 comprimidos`.

### Observabilidade

18. `SELECT * FROM system_events WHERE tipo LIKE 'cadastro:%'` durante a bateria →
    ✅ nenhum `salvamento_com_estado_incompleto`, nenhum `classificador_confirmacao_falhou`.

---

## 10. Fora de escopo (registrado, não implementado aqui)

| Item | Motivo |
|---|---|
| **MH-073 Parte B.1** — escalada ao roteador (intenção fora do fluxo), ponto único de despacho | Frente própria já autorizada; BUG-92 remove a causa mais comum, mas não a estrutural |
| **ACH-4** — `cad_dosagem` aceita "20" sem validação (Vaslip gravou `dosagem = "20"`) | Achado, não confirmado como bug — dosagem é campo livre por design |
| **MH-78** — exibir dose por sítio de aplicação ("2 gotas em cada olho" em vez de "4 gotas") | Melhoria de interface; o campo `olhos` já é capturado no context, só não é usado na renderização |
| **MH-79** — cadastrar apresentação diferente do mesmo medicamento (Rivotril cps × gotas) com aviso em vez de bloqueio | Melhoria de fluxo, escopo próprio |
| ~34 pontos de texto com unidade hardcoded | Parte D |

---

## 11. Escritas em `backlog_items`

Este chat é **read-only** no Supabase. Escritas via `src/backlog.js` (Princípio 16), autorizadas
por Guilherme nesta sessão:

**INSERT**
- `BUG-90` — *"Texto gerado pelo LLM diverge da etapa decidida em código no fluxo de cadastro"* — `alta`
- `BUG-91` — *"novoContext do LLM sobrescreve estado determinístico em etapas sem ramo de decisão"* — `alta`
- `BUG-92` — *"Estado não retorna a idle após cad_salvo — cadastro sequestra mensagens seguintes"* — `alta`
- `BUG-93` — *"Lista de posologia usa forma farmacêutica como rótulo da quantidade"* — `media`
- `ACH-4` — *"cad_dosagem aceita valor sem validação de formato"* — `baixa`, `relacionado: 'MH-073'`
- `MH-78` — *"Exibir dose por sítio de aplicação na interface, mantendo total no cálculo"* — `media`, `relacionado: 'MH-073'`
- `MH-79` — *"Permitir cadastro de apresentação diferente do mesmo medicamento"* — `media`, `relacionado: 'MH-073'`
- `MH-073 parte B.2` — este briefing — `alta`

**UPDATE**
- `MH-073 parte B` → `em_validacao` (mantém; a coleta está validada, os defeitos são de fronteira)
- `MH-073 parte B.2` → `em_validacao` ao fim da implementação