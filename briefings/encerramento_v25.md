# ENCERRAMENTO — Sessão v25 (29/07/2026)

**Nota de formato:** o `CONTEXT.md` está com 1149 linhas. Em vez de reproduzir o arquivo inteiro
(propenso a perda silenciosa de conteúdo), este briefing especifica **edições cirúrgicas exatas**.
Aplicar na ordem. Cada edição indica o texto a localizar e o texto a colocar no lugar.

---

## 1. Limpeza de código pendente

`src/agentes/relatorios.js` — remover `getDosesHoje,` da lista de imports (linha 3). A função não é
mais usada neste arquivo desde a remoção do `relatorioTomeiHoje`.

⚠️ **Não remover a função `getDosesHoje` de `database.js`.** Ela está órfã (confirmado por grep:
nenhum consumidor, apenas menções em comentários), mas a remoção é deliberada e fica no MH-61.

---

## 2. CONTEXT.md — Edição 1: cabeçalho

**Localizar** (as duas primeiras linhas do arquivo):
```
# 🌿 NAMI — Contexto do Projeto (v24 — FECHADA: MH-054 Juiz Offline implementado e calibrado
(8/8 detecção, 8/8 categoria, convergência de fingerprint validada); BUG-069 registrado — 28/07/2026)
```

**Substituir por:**
```
# 🌿 NAMI — Contexto do Projeto (v25 — FECHADA: redesenho do fluxo de relatórios — balanco_do_dia,
canal de parâmetros, telemetria do Juiz Offline (MH-058); BUG-058 fechado após 3 semanas; 4 briefings
encadeados com 2 regressões próprias detectadas e corrigidas no mesmo dia — 29/07/2026)
```

---

## 3. CONTEXT.md — Edição 2: estrutura de arquivos

**Localizar:**
```
│   ├── nlp_helpers.js           → isCancelamento (v18: regex apertado — "para" solto removido, exige "para de/com"/"parar"; vocabulário ampliado), encontrarMedicamento (agora também exportada como normalizar) — compartilhados entre agentes (evita duplicação, lição do BUG-036)
```

**Substituir por:**
```
│   ├── nlp_helpers.js           → isCancelamento (v18: regex apertado — "para" solto removido, exige "para de/com"/"parar"; vocabulário ampliado), encontrarMedicamento (agora também exportada como normalizar) — compartilhados entre agentes (evita duplicação, lição do BUG-036)
│   ├── dataReferencia.js        → NOVO (v25): resolução determinística de data. O LLM devolve a EXPRESSÃO ("ontem", "domingo", "19/07"); o cálculo da data real acontece só aqui. extrairExpressaoData() (texto-primeiro, princípio 17) · resolverDataReferencia() · validarJanela() (30 dias) · diasAtras() · rotularData() · janelaDiaBRT() (offset fixo -03:00; Brasil sem DST desde 2019 — único arquivo a revisar se isso mudar)
```

**Localizar:**
```
│   │   └── estoqueTemplates.js → NOVO (v19, BUG-065): buildAlertaEstoquePosConfirmacao + buildAlertaEstoqueNaoInformado — únicas funções de texto de alerta de estoque pós-confirmação/pós-lembrete; substituem 3 cópias divergentes que existiam em router.js, principal.js e lembrete.js desde o commit f967a0c (MH-026, 15/06)
```

**Substituir por:**
```
│   │   ├── estoqueTemplates.js → NOVO (v19, BUG-065): buildAlertaEstoquePosConfirmacao + buildAlertaEstoqueNaoInformado — únicas funções de texto de alerta de estoque pós-confirmação/pós-lembrete; substituem 3 cópias divergentes que existiam em router.js, principal.js e lembrete.js desde o commit f967a0c (MH-026, 15/06)
│   │   └── balancoTemplates.js → NOVO (v25): núcleo factual determinístico do balanco_do_dia. montarBlocoFactual() (lista de doses, renderizada em código e inserida LITERALMENTE na mensagem) · montarCabecalhoData() (a data resolvida precisa de lugar determinístico porque o LLM é proibido de citá-la) · resumirSituacao() (contadores + cenário) · molduraPadrao() (fallback quando a chamada de moldura ao LLM falha)
```

**Localizar:**
```
│       ├── relatorios.js        → 6 tipos de relatório determinísticos (v15: + progresso_tratamento), sem Camada 3 de reclassificação
```

**Substituir por:**
```
│       ├── relatorios.js        → 6 subtipos, sem Camada 3 de reclassificação. v25: tomei_hoje SUBSTITUÍDO por balanco_do_dia (status das doses de QUALQUER dia, filtrado por scheduled_at); handleRelatorios recebe params {medicamento, expressaoData}; resolverMedicamento() aplica princípio 17; gerarMoldura() é a única chamada de LLM do arquivo — devolve só {abertura, fechamento} em JSON e é proibida de citar dado factual
```

**Localizar** (dentro do bloco de migrations):
```
│       └── 20260707000000_adesao_tratamento.sql          → tratamento_fim populado + tabela adesao_estado (v15), aplicada manualmente
```

**Substituir por:**
```
│       ├── 20260707000000_adesao_tratamento.sql          → tratamento_fim populado + tabela adesao_estado (v15), aplicada manualmente
│       └── 20260729000000_juiz_offline_execucoes.sql     → tabela juiz_offline_execucoes (MH-058, v25), aplicada manualmente
```

---

## 4. CONTEXT.md — Edição 3: nova seção da sessão v25

**Localizar** a linha:
```
## Backlog (BUG/FIX/MH)
```

**Inserir ANTES dela** o bloco abaixo (mantendo o `## Backlog` intacto depois):

```
## Sessão v25 (29/07/2026) — MH-058 (telemetria do Juiz Offline) + redesenho do fluxo de relatórios

Sessão longa, com 4 briefings encadeados. Dois deles corrigiram regressões introduzidas pelos
briefings anteriores da MESMA sessão — registrado aqui na íntegra porque as duas causas são
lições reutilizáveis, não acidentes.

### MH-058 — Telemetria de execução do Juiz Offline

Problema: o Juiz Offline (MH-054, v24) só deixa rastro quando ENCONTRA desvio. Um dia sem desvios
— o caso comum — é indistinguível de "o cron nunca rodou".

Tabela nova `juiz_offline_execucoes` (append-only, um insert por invocação): `data_avaliada`
(dia avaliado, não data de execução), contadores brutos, `status`
(`sucesso`/`falha_parcial`/`falha_total`) e `erro_resumo`. Escrita por ponto único
(`registrarExecucaoJuizOffline` em `observabilidade.js`).

Decisões de desenho:
- **Contadores incrementados dentro do loop**, nunca calculados no fim — é isso que permite
  distinguir `falha_parcial` (exceção no meio, sobrou episódio nunca tentado) de `sucesso`.
- **`turnos_totais`/`episodios_totais` ficam NULL** quando a coleta falha antes de rodar — é o
  sinal de `falha_total`.
- **Percentuais NÃO são colunas** — calculados na leitura, a partir dos brutos. Guardar derivada
  junto do bruto cria dois lugares para a mesma informação divergir (princípio 19).
- **Tabela separada de `system_events` de propósito**: `system_events` guarda sinal que precisa de
  triagem; telemetria de execução é prova de vida operacional que ninguém tria. Um `tipo` novo
  dentro de `system_events` poluiria a fila de triagem com uma linha por dia.
- **Escopo restrito de `episodios_pulados_idempotencia`**: conta só episódios que já geraram
  `system_events` de desvio em execução anterior. Episódios julgados e LIMPOS não deixam rastro
  hoje, então são reavaliados a cada nova execução do mesmo dia — esperado, não bug.
- **Cenário "o cron nunca rodou" não é coberto pela tabela** (um heartbeat escrito pelo próprio
  processo não prova a própria ausência). Decisão: query manual / futuro item do dashboard (MH-9),
  sem monitor externo por ora.

### Redesenho do fluxo de relatórios — diagnóstico

O gatilho foi o BUG-058 (estoque não filtrava por medicamento nomeado), aberto desde a v15 sem
investigação. A causa raiz revelou algo maior:

- `relatorioEstoque` **nunca** recebeu `message` — desde o commit `d7fc32d` que o criou. Não era
  regressão. Funcionava antes da v15 porque a pergunta VAZAVA para o `principal`, que respondia
  bem por acaso. A v15 corrigiu esse vazamento (BUG-055) e expôs a lacuna real.
- **Lição transversal:** um comportamento que "funcionava" pode estar apoiado em outro defeito.
  Consertar o defeito revela a lacuna — e isso não é regressão, é dívida aparecendo.

Investigando os outros subtipos com dados reais de produção, apareceram 4 causas raiz:

1. **`getDosesHoje` filtrava por `taken_at`, não por `scheduled_at`.** Evidência: às 10:26 BRT o
   relatório "de hoje" mostrou 6 doses, das quais **5 eram de ontem**, confirmadas retroativamente
   naquela manhã. O CONTEXT.md já documentava a regra correta desde a v15 — mas aplicada só a
   `calcularAdesao`. Mesma classe do BUG-035 (duas definições divergentes convivendo).
2. **O bloco `pendentes` não consultava `dose_logs`** — derivado de `medications`+`schedules`, com
   `schedules[0]` só, e suprimido inteiro se houvesse qualquer dose confirmada no dia. Não
   conseguia representar `nao_tomado`/`nao_informado`/`sem_estoque`.
3. **Lacuna de inventário**: não existia "status das doses de um dia específico". `tomei_hoje` era
   fixo em hoje; `adesao` fixo em agregado 7/15/30. Perguntas equivalentes caíram em 3 destinos
   diferentes — o classificador arredondava para a categoria existente mais próxima.
4. **Não existia canal de parâmetros**: `handleRelatorios` recebia `subtipo` como string nua, então
   "dipirona" ou "ontem" morriam na fronteira do roteador. Generalização do BUG-058.

### Redesenho — arquitetura entregue

Três peças separadas, cada uma fazendo o que sabe fazer:

1. **Entender o pedido (LLM)** — o classificador central passa a devolver
   `params: {medicamento, expressaoData}` como campo paralelo (princípio 22). Devolve a
   EXPRESSÃO, nunca a data calculada.
2. **Buscar os fatos (código)** — `getDosesDoDia(userId, dataISO, medicationId?)` filtra por
   `scheduled_at`, sem janela de 3 dias e sem corte de registros, para qualquer data.
3. **Escrever (LLM, com moldura)** — `gerarMoldura` devolve só `{abertura, fechamento}`; o bloco
   factual é renderizado em código e inserido literalmente entre os dois.

Complementos:
- `detectarConfirmacaoDose` reescrita (pré-requisito): termos fracos removidos, word boundary via
  `contemPalavraLivre`, guarda de interrogativa (pontuação **e** abertura interrogativa).
- `despacharRelatorio` — ponto único, substituiu **8** call sites de `handleRelatorios`.
- Regra de janela: ≤2 dias oferece confirmação retroativa; acima disso é leitura pura.
- Data resolvida afirmada direto na resposta, **sem estado conversacional novo** — a correção do
  usuário ("não, o outro domingo, 19") chega em `idle` e é reclassificada com histórico. Menos
  superfície de beco sem saída.

### Medição que fundamentou a limpeza de `detectarConfirmacaoDose`

Contra TODO o histórico de `agent_logs`: os termos `tá`, `foi`, `pode`, `ok`, `claro` e `feito`
tiveram **zero ocorrências** em confirmações reais — só geravam falso positivo (`'tá'` casava
dentro de "está", fazendo "como está meu estoque" ser lido como confirmação de dose). Removidos
com base em dado, não em palpite. Se o usuário responder com uma dessas palavras, a mensagem cai
no classificador e chega ao `principal`, cujo system prompt já trata todas elas como CONFIRM_DOSE
— custa uma chamada de LLM a mais, não perde a confirmação.

Residuais aceitos e documentados: `"Simsim"` deixa de casar no fast-path (o classificador resolve);
`"tomei X hoje"` sem "?" e sem abertura interrogativa continua ambíguo — é estruturalmente idêntico
a uma declaração real ("Tomei de hoje e de ontem" é confirmação verdadeira do histórico).

### As DUAS regressões próprias — causas e lições

**C-3 — `JSON.parse` do classificador sem remover cercas markdown.** Ao acrescentar `params`, o
JSON ficou mais longo e o modelo passou a devolvê-lo como bloco de código. O parse falhava e caía
no `fallback` = `principal`. Medição: **0 falhas em 19 chamadas antes / 5 em 17 (29%) depois**.
A proteção já existia no projeto (`parseJulgamento` em `juizOffline.js`) e foi até replicada em
`gerarMoldura` no mesmo briefing — mas não no classificador, que era o ponto alterado.
Consequência: o `principal` respondia com contexto truncado e **afirmou fato falso sobre saúde**
("Vitamina C e Cataflam não tinham doses agendadas para ontem" — tinham) e alucinou um contato
telefônico. Origem do princípio 27.

**C-1 — contradição entre duas seções do próprio briefing.** A seção 2.2 acrescentou frases com
data à Camada 1 (`'faltou algum remédio'`); a seção 2.4 estabelecia que a Camada 1 passa `params`
vazio. Resultado: as frases que carregam data eram exatamente as que perdiam a data.
Correção **sistêmica**, não reversão: `extrairExpressaoData` passa a extrair a data do TEXTO
deterministicamente, com o `params` do classificador como fallback (princípio 17). A Camada 1
volta a ser atalho inofensivo e o fluxo deixa de ter ponto único de falha para a data.

### Achados residuais da validação (N-1 a N-4, A-1 a A-4)

- **`dose_logs` só nasce quando o scheduler envia o lembrete** (~2 min antes do horário). Doses
  futuras do dia não existem no banco — "tomei dipirona hoje?" às 14:20 respondia "não encontrei
  nenhuma dose" com as doses das 16:00 e 20:00 por vir. Correção: complementar **só o dia de hoje**
  com horários sem linha (status sintético `agendado`). Dias passados não podem ser reconstruídos
  com segurança porque os `schedules` podem ter mudado.
- **O status `pendente` significa "lembrete enviado, aguardando resposta"**, não "dose futura" — o
  texto inicial dizia "ainda não chegou o horário", afirmação falsa. Três estados distintos hoje:
  `confirmado` / `aguardando sua confirmação` / `ainda não chegou o horário`.
- **`proximo_remedio` contradizia o `balanco_do_dia`** sobre o mesmo dado: dose confirmada era
  anunciada como "está na hora de tomar". Três causas: a linha "agora" ignorava `confirmado`; a
  confirmação era resolvida por MEDICAMENTO e não por dose/horário; e a função ainda consumia
  `getDosesHoje` (o `taken_at`). Correção sistêmica: `getProximosMedicamentos` passa a consumir
  `getDosesDoDia`, casando por `medicationId + horario` — os dois relatórios passam a ler a mesma
  fonte, eliminando a possibilidade de divergirem.
- **A data resolvida não chegava ao usuário**: o LLM parafraseava "quarta-feira (15/07)" como
  "desta quarta-feira" e a data desaparecia. Como o bloco factual só tem horários, a data não
  existia em lugar nenhum. Origem do princípio 28 (corolário).
- **Precedência invertida em `extrairExpressaoData`**: "o outro domingo, 19" resolvia para o
  domingo mais recente, porque número solto só era aceito com prefixo "dia" e o dia da semana
  vencia apesar de ser menos específico. Corrigido aceitando número **adjacente** ao dia da semana
  — a proteção contra "tomei 2 comprimidos" continua valendo.
- Ordenação: estoque por **unidades crescente** (com desempate por nome para estabilidade) — o que
  está acabando aparece primeiro. Aproximação consciente até o MH-60 (dias de cobertura).
  `meus_remedios` em ordem alfabética, feita **localmente** no handler porque
  `getUserMedications` tem 7 consumidores.

### Descoberta sobre o alcance da observabilidade (origem do princípio 29)

A falha de parse do C-3 rodou por horas em produção **sem gerar nenhum `system_events`**. Motivo:
não era exceção — era um `catch` local que devolvia fallback. Do ponto de vista do `catch_global`
do `agent.js`, nada deu errado: a mensagem foi roteada e respondida. O Juiz Offline também não
pegou, porque `agent_logs` registrava `principal` respondendo coerentemente.

Mapeamento dos 15 pontos de `registrarEvento` no código: **um único é genérico** (o `catch_global`);
os outros 14 são instrumentações manuais. Conclusão registrada: **a observabilidade é opt-in, não
orgânica.** Uma peça nova herda só `agent_logs` (se passar pelo `routeMessage`), o `catch_global`
(só exceção não tratada) e o Juiz Offline. NÃO herda registro de degradação silenciosa nem de
exceção capturada localmente — e nada, se rodar fora do `routeMessage` (foi por isso que o
`scheduler.js` precisou de 6 instrumentações manuais, e o `enviarResumoSemanal` até hoje não gera
`agent_logs`).

### Validação em produção

Todos os cenários validados no mesmo dia, com evidência cruzada de `agent_logs`, `dose_logs` e
logs do Railway. Destaques:
- 0 falhas de parse em 11 classificações (era 29%)
- `proximo_remedio` e `balanco_do_dia` consultados com 33s de diferença concordaram sobre o status
  de todas as doses; resolução por dose confirmada (Dipirona 16:00 não contaminou a das 20:00)
- data resolvida correta nos 4 formatos: `quarta-feira (15/07)`, `ontem (28/07)`,
  `domingo (26/07)`, `domingo (19/07)`
- mensagens interceptadas pela Camada 1 (sem `params`) resolveram a data corretamente via extração
  determinística — prova de que o ponto único de falha foi eliminado

---
```

---

## 5. CONTEXT.md — Edição 4: princípios novos

**Localizar** o fim do princípio 26 (últimas linhas da lista de princípios):
```
26. **Taxonomia de observabilidade classifica sintoma, nunca causa (v24, MH-054).**
    Categorizar por causa provável exige que o LLM infira causa — justamente o que ele não faz com
    confiabilidade, e que é trabalho humano com evidência de código. Categorias de causa também
    refragmentam o agrupamento: dois episódios com o mesmo sintoma e causas diferentes receberiam
    fingerprints distintos.
```

**Substituir por** (mantendo o 26 e acrescentando 27 a 30):
```
26. **Taxonomia de observabilidade classifica sintoma, nunca causa (v24, MH-054).**
    Categorizar por causa provável exige que o LLM infira causa — justamente o que ele não faz com
    confiabilidade, e que é trabalho humano com evidência de código. Categorias de causa também
    refragmentam o agrupamento: dois episódios com o mesmo sintoma e causas diferentes receberiam
    fingerprints distintos.
27. **Proteção que já existe no projeto é replicada, nunca reimplementada pela metade (v25, C-3).**
    Ao criar um ponto novo que pertence a uma classe de problema já resolvida em outro lugar do
    código, a proteção existente é reaproveitada — não reescrita parcialmente nem esquecida. Caso
    concreto: extração tolerante de JSON de LLM já existia em `parseJulgamento` (`juizOffline.js`);
    ao acrescentar `params` ao classificador, a proteção foi replicada em `gerarMoldura` mas NÃO no
    classificador, que era justamente o ponto alterado — 29% das classificações passaram a ser
    descartadas silenciosamente. **Corolário operacional:** toda saída de LLM parseada como JSON
    passa por extrator tolerante (cercas markdown + isolamento do primeiro objeto), e o `max_tokens`
    é revisto sempre que o formato de saída cresce — truncamento produz o mesmo sintoma.
28. **Comunicação de dado de saúde pode ser escrita por LLM, desde que o dado não passe por ele
    (v25) — refinamento do princípio 13.** O princípio 13 proíbe geração livre para apresentação de
    dado de saúde. A v25 estabelece o desenho que preserva a intenção sem sacrificar a qualidade da
    conversa: **núcleo factual determinístico + moldura pelo LLM**. O bloco de fatos (nomes,
    horários, status) é renderizado em código e inserido LITERALMENTE na mensagem; o LLM escreve
    apenas abertura e fechamento, a partir de contadores estruturais, com proibição explícita de
    citar qualquer dado factual. O montador da mensagem final é código, nunca o LLM.
    **Corolário (N-1):** se o LLM é proibido de citar um dado, esse dado precisa ter um lugar
    determinístico próprio na mensagem. Proibir sem criar o lugar faz o dado desaparecer — foi o que
    aconteceu com a data resolvida, que o LLM parafraseou como "desta quarta-feira" enquanto o bloco
    factual só continha horários.
29. **Degradação silenciosa exige instrumentação explícita — a observabilidade é opt-in, não
    orgânica (v25).** O `catch_global` do `agent.js` só captura exceção NÃO TRATADA. Todo caminho de
    degradação controlada — `catch` local que devolve fallback, valor default assumido, parse que
    falha, sinal não interceptado — é invisível por construção: o código não quebra, ele piora, e
    tanto `agent_logs` quanto o Juiz Offline registram uma interação aparentemente saudável. Esses
    caminhos devem registrar em `system_events`. **Corolário de processo:** todo agente, fluxo ou
    função nova declara explicitamente seus pontos de instrumentação no briefing que a cria — do
    mesmo modo que o princípio 5 exige atualizar o inventário do classificador. Peça nova NÃO herda
    observabilidade automaticamente: fora do `routeMessage` não há nem `agent_logs` (é por isso que
    `scheduler.js` tem 6 instrumentações manuais e `enviarResumoSemanal` não gera log nenhum).
30. **Contrato de chamada que muda precisa de ponto único de despacho (v25) — aplicação do
    princípio 1.** Quando um handler é chamado de vários lugares e o contrato dele muda (ex:
    acrescentar `params`), a mudança vai para uma função de despacho única em vez de ser replicada
    em cada call site. Motivo: o modo de falha é **degradação silenciosa** — o call site esquecido
    recebe `undefined`, volta ao comportamento antigo e não gera erro nem log. Precedentes no
    projeto: BUG-069 (1 de 6 call sites do `configuracao` sem interceptar escalada), BUG-065 (3
    cópias divergentes de alerta de estoque), BUG-036 (3 listas divergentes de termos de
    confirmação). O padrão comum é sempre o mesmo: **a cópia nasce por falta de um lugar comum, e
    depois diverge.**
```

---

## 6. Escritas em `backlog_items` (via `src/backlog.js`, nunca SQL direto)

### 6.1 Atualizar status → `resolvido` (sessão v25)

| tipo | numero | nota |
|---|---|---|
| BUG | 70 | Corrigido pelo `getDosesDoDia` (filtra por `scheduled_at`). Validado 29/07: relatório do dia não mistura mais doses de outros dias. |
| BUG | 71 | Termos fracos removidos com base em medição (zero ocorrências reais), word boundary + guarda de interrogativa. Validado: "como tá meu estoque" com e sem "?" vai para o relatório. |
| BUG | 72 | Extrator tolerante de JSON + `max_tokens` 250. Validado: 0 falhas em 11 classificações (era 29%). |
| BUG | 73 | `extrairExpressaoData` texto-primeiro. Validado: mensagens interceptadas pela Camada 1 (sem params) resolveram a data corretamente. |
| BUG | 74 | Dia corrente complementado com horários sem linha em `dose_logs`. Validado: os três estados coexistem corretamente. |
| BUG | 76 | `getProximosMedicamentos` migrado para `getDosesDoDia` com casamento por dose. Validado 20:30 — os dois relatórios concordaram; Dipirona 16:00 não contaminou a das 20:00. |
| BUG | 77 | Cabeçalho de data determinístico. Validado nos quatro formatos. |

### 6.2 Inserir (não foram criados na execução anterior)

| tipo | numero | titulo | status | prioridade | data_criacao |
|---|---|---|---|---|---|
| BUG | 78 | extrairExpressaoData priorizava dia da semana sobre número adjacente, ignorando "o outro domingo, 19" | resolvido | media | 2026-07-29 |
| BUG | 79 | dosagem nula exibida literalmente como "null" no relatório de remédios cadastrados | resolvido | baixa | 2026-07-29 |
| MH | 63 | Janela "agora" de getProximosMedicamentos anuncia "está na hora de tomar" com até 30 min de antecedência, divergindo do enquadramento do balanco_do_dia | aberto | baixa | 2026-07-29 |
| MH | 64 | Auditar caminhos de degradação silenciosa: `catch` locais que devolvem fallback sem registrar em `system_events` | aberto | media | 2026-07-29 |

Descrição do MH-64: *"Origem: a falha de parse do classificador (BUG-72) rodou em produção
descartando 29% das classificações sem gerar um único `system_events`, porque era um `catch` local
que devolvia fallback — não uma exceção. O `catch_global` do `agent.js` só cobre exceção não
tratada. Auditar todos os `catch` locais e caminhos de valor default do código, avaliar quais
merecem registro e instrumentar. Não há estimativa de quantos são nem evidência de que algum outro
esteja escondendo problema agora — a auditoria é justamente para descobrir. Ver princípio 29."*

### 6.3 Condicional

**MH-58** (telemetria do Juiz Offline) — manter `em_validacao`. O cron das 03:00 BRT não rodou
desde a implantação. Fechar somente depois de conferir:
```sql
SELECT * FROM juiz_offline_execucoes ORDER BY created_at DESC LIMIT 5;
```

---

## 7. Checklist para o Claude Code

1. Remover `getDosesHoje,` do import em `src/agentes/relatorios.js` (seção 1).
2. Aplicar as 4 edições do `CONTEXT.md` (seções 2 a 5), na ordem.
3. `node --check src/agentes/relatorios.js`.
4. Conferir que o `CONTEXT.md` continua com a estrutura íntegra: `grep -c "^## " CONTEXT.md` deve
   ter aumentado em exatamente 1 (a nova seção da v25).
5. `git add -A && git commit && git push`.
6. Escritas em `backlog_items` (seção 6) via `src/backlog.js`.
7. Confirmar as escritas com query de leitura e relatar o resultado.