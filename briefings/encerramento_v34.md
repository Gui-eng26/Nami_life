# ENCERRAMENTO v34 — MH-073 Partes B, B.2, B.3 + MH-80 + BUG-100

**Sessão:** v34 · **Período:** 19–25/08/2026
**Instrução para o Claude Code:** este documento contém (1) o bloco a inserir no `CONTEXT.md`,
(2) as alterações pontuais no `CONTEXT.md` existente, (3) os princípios novos, e (4) a lista
completa de escritas em `backlog_items`. Executar na ordem, commitar e fazer push.

---

## PARTE 1 — Alterações pontuais no `CONTEXT.md` existente

### 1.1 Cabeçalho (linhas 1-3)

Substituir por:

```
# 🌿 NAMI — Contexto do Projeto (v34 — FECHADA: MH-073 Partes B, B.2 e B.3 — cadastro de
medicamento com unidade de dose, posologia por horário e fronteira entre decisão determinística
e geração de texto; MH-80 (aproveitamento de mensagem completa); BUG-100 (verbo de administração
por forma farmacêutica) — 25/08/2026)
```

### 1.2 Linha 188 — ambiguidade sobre quem aplica migrations

⚠️ **Correção de processo desta sessão.** O texto atual diz que migrations são aplicadas
"manualmente", sem dizer por quem. Isso fez o BUG-100 ficar meio implementado por dois dias: o
código estava em produção, a migration não, e o sistema operava no fallback sem que ninguém
percebesse.

Substituir o parágrafo de migrations por:

```
⚠️ **Migrations NÃO são aplicadas por deploy.** Toda mudança de schema é aplicada **pelo Claude
Code via Supabase MCP**, ANTES do deploy do código que a utiliza, e confirmada por consulta a
`pg_proc` / `information_schema`. DDL sempre envolvido em `BEGIN; ... COMMIT;` — `DROP FUNCTION`
+ `CREATE FUNCTION` deixa uma janela em que a função não existe, e o cron lê
`get_pending_reminders` a cada 2 minutos.
```

---

## PARTE 2 — Bloco novo do `CONTEXT.md` (inserir antes de `## Backlog (BUG/FIX/MH/ACH)`)

```markdown
## Sessão v34 (19-25/08/2026) — MH-073 Partes B / B.2 / B.3, MH-80, BUG-100

Sessão longa, com sete ciclos de implementação e validação em produção. Fecha a coleta
conversacional de medicamentos líquidos e a fronteira entre decisão determinística e geração de
texto no `cadastro.js`.

### MH-073 Parte B — cadastro com unidade de dose e posologia

A Parte A (v33) criou o schema; a Parte B alimenta-o pela conversa.

**Mudança estrutural do fluxo:** a etapa `cad_forma` foi **removida**. A unidade passou a ser
derivada da resposta sobre *quanto se toma por vez* — pergunta que a pessoa responde sem esforço
e cuja resposta natural já carrega a unidade ("20 gotas", "2 comprimidos"). O fluxo ficou:

`cad_nome` → `cad_dosagem` → `cad_horarios` → `cad_quantidade_por_dose` →
`cad_confirma_forma` (condicional) → `cad_tipo_tratamento` → `cad_estoque` /
`cad_estoque_volume` → `cad_confirmacao`

**Decisão de arquitetura permanente:** a inferência de forma farmacêutica **nunca entra na
pergunta, só na confirmação**. Muitos medicamentos existem em mais de uma apresentação (dipirona:
comprimido, gotas, xarope). Perguntar "quantos comprimidos você toma?" induz a resposta de quem
usa gotas, e o erro deixa de ser cosmético e contamina `unidade_dose`. Na confirmação a mesma
inferência é segura porque é submetida ao usuário.

**`classificarPosologia`** — classificador único para horários e quantidade, no padrão do
`extrairComponenteData` (MH-072): pergunta "o que é isso?", nunca "isso serve para o campo que eu
esperava?". Trata `posologia_completa`, `horarios_apenas`, `quantidade_apenas`,
`frequencia_intervalo`, `indeterminado`. Reconhece multiplicador de sítio ("2 gotas em cada olho"
→ quantidade 4) e distingue horário de quantidade por preposição ("tomo às 8" ≠ "tomo 8").

**Marco:** primeira baixa de dose líquida real do projeto — `stock_movements` registrou
`10 → 9.8` no tobradex (4 gotas ÷ 20 gts/ml) e `100 → 95` no Claritin (5ml). Pendência declarada
no fechamento da Parte A, agora fechada.

### MH-073 Parte B.2 — fronteira entre decisão e geração

A validação da Parte B revelou uma família de defeitos com causa raiz única: **o estado era
decidido em código, mas o texto era gerado livremente, e os dois divergiam.**

`buildSystemPrompt` montava todas as instruções de todas as etapas num bloco só (Princípio 44) e
nada obrigava o LLM a escrever o texto da etapa que o código havia decidido. Sintomas: pergunta
de volume repetida com o estoque já gravado, "quantas unidades" para um líquido, e — o mais grave
— **"cadastrado com sucesso" afirmado duas vezes sobre um cadastro que não existia**.

Em paralelo, quatro etapas não tinham ramo determinístico (`cad_nome`, `cad_dosagem`,
`cad_tipo_tratamento`, `cad_confirmacao`), e nelas o `novoContext` do LLM entrava sem guarda. Num
turno de `cad_confirmacao` o LLM devolveu `pares_posologia: null` e apagou a posologia já
coletada, produzindo um laço infinito.

**Correção estrutural: o LLM devolve apenas `message`.** `proximaEtapa`, `novoContext` e `action`
saíram do contrato de resposta. Toda etapa ganhou ramo determinístico, e `buildSystemPrompt`
passou a receber a etapa cuja **pergunta** deve ser escrita, incluindo somente o bloco daquela
etapa.

⚠️ A "REGRA DE PERSISTÊNCIA DE CONTEXTO (CRÍTICA)" existia no prompt, em maiúsculas, e não
impediu nada. **Instrução não é barreira.** Enquanto existir caminho pelo qual o LLM escreve
estado, ele será percorrido.

### MH-073 Parte B.3 — conteúdo determinístico e exaustividade

Segunda bateria revelou duas famílias:

**Tema 1 — a mensagem afirmava dado de saúde ausente do estado.** A B.2 tirou do LLM a decisão de
*estado*, não a de *conteúdo*. Cinco ocorrências confrontadas com o banco, incluindo "Com 60
unidades... 20 dias" sobre um estoque igual a zero. Correção: **toda mensagem que afirme
posologia, horários, quantidade ou estoque é renderizada em código**; o LLM escreve só a moldura.

**Tema 2 — funções de decisão não cobriam todas as categorias do classificador.** O classificador
devolvia N categorias, a decisão tratava M < N, e o restante caía num fallback que **descartava a
informação do usuário em silêncio**. `decidirCadConfirmaForma` não tratava `horarios_apenas` nem
`frequencia_intervalo`; `corrigirPosologiaEmConfirmacao` não tratava `frequencia_intervalo`.

**BUG-97 (crítico) — regressão introduzida pela própria Parte B.** `parseInt("Tenho 30 cps")` →
`NaN` → `0`. Dois medicamentos gravados com estoque zero. A seção 6.5 do briefing da Parte B
especificava literalmente `estoque = parseInt(message)`; antes disso a extração era feita pelo
LLM e absorvia frase natural. Corrigido com `classificarEstoqueSolido` e com a separação entre
`null` (falha de extração) e `0` (estoque legítimo).

### MH-80 — aproveitar dados completos na primeira mensagem

*"Quero cadastrar o Seki xarope. Vou tomar 5ml de 12/12 hrs por 6 dias. Tenho 1 vidro de 100ml"*
→ a Nami pergunta apenas dosagem e horário da primeira dose, e vai direto ao resumo.

Exigiu três ciclos de correção, todos com a mesma forma: **campos independentes acoplados a
`pares`**. Estoque líquido, unidade de dose e frequência não dependem de haver horário explícito,
mas o código exigia `pares.length > 0` para gravar qualquer um deles.

**`primeiraEtapaFaltante(context)`** — ponto único de decisão de avanço (Princípio 30). A ordem
canônica do cadastro existia em três cópias: a cascata do salto, o ternário
`formaExplicita ? 'cad_tipo_tratamento' : 'cad_confirma_forma'` em quatro pontos, e os destinos
cravados nas transições. Agora existe uma vez.

**`garantirResumo`** — `cad_confirmacao` tem uma pré-condição (resumo montado) e ela é garantida
no **ponto de entrada da etapa**, no `decidirEtapa`, cobrindo todos os retornos por construção.
Sem isso, o prompt caía no ramo de "correção não compreendida" e produzia laço: 3 turnos num
cadastro, 4 em outro, com o medicamento salvo **sem o usuário jamais ter visto o resumo**.

### BUG-100 — verbo de administração por forma farmacêutica

Colírio não se toma. Pomada não se toma. Para o público-alvo, verbo errado não é deslize de
estilo — é instrução ambígua sobre administração de medicamento.

**O discriminador é `forma_farmaceutica`, NÃO `unidade_dose`.** tobradex colírio e Rivotril gotas
têm ambos `unidade_dose = 'gota'` e verbos opostos. Derivar da unidade consertaria o colírio e
quebraria o Rivotril.

`src/templates/verbos.js` — ponto único, oito pontos de texto corrigidos, migration acrescentando
`forma_farmaceutica` ao `get_pending_reminders`. Mensagens sobre **vários** medicamentos usam
`verboDoGrupo`: verbo comum quando todos compartilham, neutro ("tomou ou usou") só quando há
mistura. Validado em produção nos dois ramos, incluindo grupo com cápsula + comprimidos (mesmo
verbo) e colírio + comprimidos (neutro), e cadastro antigo com forma fora da tabela
(`efervescente` → neutro).

### Lições de processo desta sessão

⚠️ **Nos últimos três ciclos, o defeito veio da especificação, não da implementação.** BUG-97
(`parseInt` prescrito no briefing), `?? ''` falsy no ADENDO 1, e a pré-condição não declarada de
`cad_confirmacao` no mesmo adendo. Ver Princípio 47.

⚠️ **O Claude Code encontrou e corrigiu três defeitos no texto dos briefings antes de
implementar** (o "modo correção" ausente no classificador, o `?? ''` falsy, e o cenário 2 do
ADENDO 2 que pedia um default inventado). Comportamento correto e a ser mantido: **não copiar
snippet de briefing verbatim quando detectar defeito — corrigir e reportar.**

⚠️ **Ação bloqueante enterrada em briefing não é executada.** Guilherme não lê os briefings por
completo — eles são o contrato com o Claude Code. Toda ação que dependa dele vai no topo da
mensagem de chat, em bloco separado. Ver Parte 1.2 acima.
```

---

## PARTE 3 — Princípios novos (acrescentar à seção "Princípios de Engenharia")

```markdown
47. **Mudar o destino de uma transição exige declarar o que o destino pressupõe.** Estados de
    fluxo têm pré-condições implícitas, criadas por quem sempre chegava até eles por um caminho
    só. `cad_confirmacao` pressupunha um resumo renderizado, porque historicamente só era
    alcançada de dentro de `processarEstoque`. Quando o roteamento passou a alcançá-la
    diretamente, a pré-condição deixou de ser satisfeita e o prompt caiu num ramo de erro,
    produzindo laço silencioso e cadastro salvo sem revisão do usuário. A correção não é
    satisfazer a pré-condição em cada nova transição — é garanti-la **no ponto de entrada do
    estado**, onde nenhum caminho possa escapar. Corolário de processo: um briefing que muda
    destino de transição deve enumerar as pré-condições de cada estado envolvido.

48. **Substituir extração por LLM por parse determinístico exige extrator equivalente.** A Parte B
    trocou `action.estoque` (extraído pelo LLM, que absorvia "Tenho 30 comprimidos" sem esforço)
    por `parseInt(message)`. Dois medicamentos foram gravados com estoque zero em produção antes
    de alguém perceber, porque o zero era indistinguível de falha de leitura. Determinismo é
    superior quando o parse é de fato equivalente; quando não é, é regressão disfarçada de rigor.
    O caminho correto é classificador dedicado com categoria fechada — a mesma disciplina usada
    para posologia e consentimento.

49. **Valor de erro nunca pode colidir com valor legítimo.** Zero é estoque válido: a pessoa pode
    cadastrar o medicamento antes de comprar. `parseInt(...) || 0` colapsava "não consegui ler" e
    "o usuário disse zero" no mesmo valor, e por isso o BUG-97 passou despercebido. A regra não é
    proibir zero — é fazer o estado carregar a diferença: falha de extração devolve `null`,
    `null` repergunta, `0` segue normalmente. Aplica-se a toda checagem subsequente:
    `=== null || === undefined`, **nunca** `!valor`, porque `!0` é `true`.

50. **A ordem canônica de um fluxo existe uma vez.** No `cadastro.js` ela chegou a existir em três
    cópias — a cascata do salto do MH-80, o ternário `formaExplicita ? ... : ...` replicado em
    quatro pontos, e os destinos cravados em cada função de decisão. O salto acertava e o passo a
    passo errava, perguntando de novo o que o usuário já tinha dito. `primeiraEtapaFaltante(ctx)`
    é a única fonte de decisão de avanço; caminhos de repergunta continuam devolvendo a própria
    etapa, de propósito. Instância específica do Princípio 30.

51. **Função de decisão precisa cobrir todas as categorias que o classificador pode devolver.**
    Quando o classificador devolve N categorias e o `switch` trata M < N, o restante cai num
    fallback que **descarta a informação do usuário em silêncio** — sem erro, sem log, sem sinal.
    Foi assim que "na verdade começa às 16hrs" e "de 8 em 8 horas" sumiram durante a confirmação.
    Ao acrescentar categoria a um classificador, auditar todos os consumidores no mesmo change.
    Corolário do Princípio 5.
```

---

## PARTE 4 — Escritas em `backlog_items`

⚠️ **Todas via `src/backlog.js`, nunca SQL direto** (Princípio 16).

### 4.1 UPDATE para `resolvido` (sessao_fechamento: 'v34', data_fechamento: hoje)

| Item | Título |
|---|---|
| `MH-073` parte `B` | Cadastro de medicamento líquido — frasco lacrado (caso exato) |
| `MH-073` parte `B.2` | Fronteira entre decisão determinística e geração de texto no cadastro.js |
| `MH-073` parte `B.3` | Conteúdo determinístico e exaustividade das decisões |
| `MH-80` | Aproveitar dados completos informados na primeira mensagem do cadastro |
| `BUG-94` | Mensagem do cadastro afirma posologia/estoque ausentes do estado |
| `BUG-95` | decidirCadConfirmaForma descarta correção de horários e de frequência |
| `BUG-96` | corrigirPosologiaEmConfirmacao não trata correção por intervalo |
| `BUG-97` | REGRESSÃO (Parte B): estoque sólido perde o número quando informado em frase natural |
| `BUG-98` | Correção do primeiro horário não recalcula a grade quando há intervalo declarado |
| `BUG-99` | forma_farmaceutica aceita palpite incompatível com unidade_dose |
| `BUG-100` | Lembrete e mensagens de estoque usam verbo de ingestão para medicamentos não ingeridos |

### 4.2 UPDATE de MH-073 Parte A

`MH-073` parte `A` está `em_validacao` desde a v33. As Partes B/B.2/B.3 exercitaram todo o núcleo
que a Parte A criou (`quantidade_por_dose`, `unidade_dose`, `converterDoseParaEstoque`,
`dose_logs.schedule_id`), com baixa de dose líquida confirmada em `stock_movements`.

→ **`resolvido`**, `sessao_fechamento: 'v34'`.

⚠️ A dívida declarada na Parte A permanece e **não** é fechada por isto: sem backfill retroativo
de `dose_logs.horario_agendado` (32% nulos) e estoque do Ômega 3 ainda inflado. Se ainda não
existir item para essa dívida, **não criar** — Guilherme não autorizou.

### 4.3 INSERT

| Tipo | Nº | Título | Prioridade | Relacionado |
|---|---|---|---|---|
| MH | 81 | Exibir a quantidade da dose nos lembretes e follow-ups | alta | MH-073 |
| MH | 82 | Encerrar tratamentos em lote: reconhecer "todos" e seleção múltipla no fluxo de encerramento | baixa | — |

⚠️ **MH-81** ganhou evidência nesta sessão: os lembretes agrupados exibem `Vaslip — 20` e
`Dramin — 50` (nome + dosagem), sem a quantidade por dose. Com posologia variável agora possível
(1 cp às 12h, 2 cps às 22h), a ausência é visível ao usuário.

### 4.4 Permanecem `aberto` (sem alteração)

- `MH-073` parte `B.1` — blindagem de becos sem saída no `cadastro.js`. **Criada nesta sessão,
  nunca implementada.** Parte do escopo foi resolvida de lado pelo BUG-92 (estado voltando a
  `idle`, que era a causa mais comum de sequestro de mensagem). O que resta: intenção fora do
  fluxo *durante* um cadastro em andamento ("quero ver meus remédios" no meio do cadastro) —
  `handleCadastro` nunca retorna `escalarParaRoteador` e o `router.js` o chama de 8 pontos,
  exigindo ponto único de despacho. **Recomendação: primeira frente da v35.**
- `MH-073` partes `C`, `D`, `E`
- `MH-78` — dose por sítio de aplicação ("2 gotas em cada olho" na interface, 4 no cálculo)
- `ACH-4` — `cad_dosagem` aceita valor sem validação de formato. Evidência nova: lembretes exibem
  `Vaslip — 20` e `diovan — 50`, dosagem sem unidade.
- `BUG-86`, `BUG-87`, e demais itens anteriores

---

## PARTE 5 — Verificação final

```bash
node --check src/agentes/cadastro.js && node --check src/database.js && \
node --check src/scheduler.js && node --check src/agentes/lembrete.js && \
node --check src/templates/verbos.js && node --check src/observabilidade.js

grep -c "Sessão v34" CONTEXT.md          # esperado: 1
grep -n "Princípio 51\|^51\." CONTEXT.md  # esperado: presente
```

Depois: `git add -A && git commit && git push`.