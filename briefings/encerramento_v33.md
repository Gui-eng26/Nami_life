# ENCERRAMENTO — Sessão v33

**Período:** 19/08/2026
**Entregas:** MH-073 Parte A (separação entre unidade de estoque e unidade de dose)
**Executor:** Claude Code

---

## 0. PENDÊNCIA CRÍTICA — executar primeiro

**A migration da MH-073 Parte A foi aplicada no banco, mas o arquivo `.sql` NÃO foi
commitado.** O diretório `supabase/migrations/` termina em
`20260811000000_data_nascimento_users.sql`.

Consequência: o histórico de migrations do repositório deixou de refletir o schema real.
Um ambiente novo montado a partir do repo não teria `quantidade_por_dose`,
`unidade_dose`, `unidade_estoque`, `gotas_por_ml`, `dose_logs.schedule_id`, nem os tipos
`numeric` — e o código commitado quebraria contra ele.

**Ação:** criar `supabase/migrations/20260819000000_mh073_parteA_unidades_dose.sql` com o
script exatamente como executado no SQL Editor (seção 4.1 de
`briefings/BRIEFING_MH073_PA.md`), commitar e fazer push.

> Se o script executado divergiu do briefing em qualquer ponto, **commitar o que foi
> realmente executado**, não o do briefing, e relatar a divergência. O arquivo precisa
> refletir o banco, não a intenção.

**Verificação:** o estado real do banco a reproduzir está documentado na seção 2 deste
arquivo.

---

## 1. Ações para o Claude Code

### 1.1 CONTEXT.md

**Atualizar a linha de cabeçalho** (primeiras 3 linhas do arquivo).

De:
```
# 🌿 NAMI — Contexto do Projeto (v32 — FECHADA: MH-076 aviso de desenvolvimento/testes
na abertura e nas capacidades, remoção de promessa de cuidador (funcionalidade sem
interface), orientação de contato do desenvolvedor — validado em produção — 18/08/2026)
```

Para:
```
# 🌿 NAMI — Contexto do Projeto (v33 — FECHADA: MH-073 Parte A — separação entre unidade
de estoque e unidade de dose; quantidade_por_dose na posologia; dose_logs.schedule_id;
correção de subcontabilização de estoque em doses multi-unidade — 19/08/2026)
```

Inserir a seção 3 deste arquivo **imediatamente antes** de
`## Backlog (BUG/FIX/MH/ACH)`, ou seja, logo após o fim da seção `## Sessão v32`.

Acrescentar os princípios 45 e 46 (seção 4) ao fim da lista em
`## Princípios de Engenharia`.

**Verificação obrigatória após editar:** `grep -c "^## Sessão" CONTEXT.md` deve ter
aumentado em exatamente 1 (de 16 para 17). Relatar o número antes e depois.

### 1.2 Renomear o briefing da Parte A

O briefing foi salvo como `briefings/BRIEFING_MH073_PA.md`. Renomear para
`briefings/BRIEFING_MH073_PARTEA.md`, alinhando com a convenção já usada em
`BRIEFING_MH072_PARTEA.md`. Não alterar o conteúdo.

### 1.3 Escritas no backlog

Todas via `src/backlog.js` — **nunca SQL direto**.

**a) Fechar MH-073 Parte A**

O item `MH-073` existe hoje com `parte = ''`. Convertê-lo na Parte A e fechá-lo:

| Campo | Valor |
|---|---|
| `tipo` / `numero` | `MH` / `73` |
| `parte` | `A` |
| `titulo` | `Medicamentos líquidos — separação entre unidade de estoque e unidade de dose` |
| `status` | `em_validacao` |
| `prioridade` | `alta` |
| `sessao_fechamento` | `v33` |
| `data_fechamento` | `2026-08-19` |
| `notas` | `Modelagem entregue e validada parcialmente em produção (Nimesulida, delta -3 via degrau 1). Pendente: observar debito -2 em Omega 3 e primeira dose de medicamento liquido real (so existira apos Parte B).` |

**b) Abrir MH-073 Partes B a E** — todas `status = 'aberto'`, `sessao_criacao = 'v33'`,
`data_criacao = '2026-08-19'`, `relacionado = 'MH-073'`:

| Parte | Título | Prioridade |
|---|---|---|
| `B` | `Cadastro de medicamento liquido — frasco lacrado (caso exato)` | `alta` |
| `C` | `Estoque aproximado de frasco ja aberto — escala visual por fracoes` | `alta` |
| `D` | `Apresentacao — unidade correta em todos os textos (~34 pontos)` | `alta` |
| `E` | `Reposicao de frasco lacrado e revisao do limiar de alerta` | `alta` |

Descrições:
- **B:** coleta de `unidade_dose` (conjunto fechado: comprimido/cápsula · gotas · ml),
  `quantidade_por_dose`, `gotas_por_ml` quando aplicável, e estoque de frasco lacrado
  (volume × quantidade = valor exato). Substitui a etapa `cad_forma` por
  `cad_unidade_dose` e acrescenta `cad_quantidade_por_dose`. `forma_farmaceutica` deixa de
  ter pergunta própria e passa a ser derivada. Inclui `cadastro.js:406-431`, deixado
  explicitamente fora da Parte A por depender da coleta.
- **C:** escala visual por frações para frasco já aberto (acabei de abrir / ~3/4 /
  ~metade / ~1/4 / quase acabando) → conversão para ml, marcada como estimativa em
  `stock_movements.origem`/`motivo`. Isolada por ser o maior risco de UX.
- **D:** ~34 pontos com `unidade`/`unidades`/`comprimidos` hardcoded — 7 em
  `estoqueTemplates.js`, 8 em `cadastro.js`, 6 em `prompts.js`, restante em
  `relatorios.js`, `principal.js`, `configuracao.js`, `scheduler.js`,
  `adesaoTemplates.js`. Inclui exibir `quantidade_por_dose` no texto do lembrete
  (a RPC já expõe o campo).
- **E:** recompra de frasco lacrado reancorando o estoque em valor exato — é o momento
  em que a imprecisão acumulada da Parte C é zerada, por desenho e não por acaso. Inclui
  revisão de `estoque_minimo` (default 7 não significa nada em ml) e de
  `calcularAlertaEstoque` para unidade fracionária.

**c) Abrir MH-077 — recorrência de posologia**

| Campo | Valor |
|---|---|
| `tipo` / `numero` | `MH` / `77` |
| `titulo` | `Recorrencia de posologia — 1x por semana, dia sim dia nao, dias especificos` |
| `status` | `aberto` |
| `prioridade` | `media` |
| `sessao_criacao` / `data_criacao` | `v33` / `2026-08-19` |

Descrição: a Nami não capta dinâmicas de recorrência. `schedules.dias_semana` existe e é
corretamente respeitada por `get_pending_reminders`, mas **nenhum fluxo do código jamais
escreve nela** — verificado: 42 de 42 registros com o default de 7 dias, e a coluna aparece
em um único `select` (`database.js:232`). Infraestrutura pronta, coleta inexistente.
Adicionalmente, **"dia sim dia não" não é representável** no modelo atual: `dias_semana` é
array de dias fixos, e um ciclo de N dias desliza pela semana — exige uma segunda forma de
recorrência (cadência por intervalo). Ortogonal a líquidos; deliberadamente fora da MH-073.

**d) Abrir ACH-01 — reversão usa quantidade atual, não a histórica**

| Campo | Valor |
|---|---|
| `tipo` / `numero` | `ACH` / próximo livre |
| `titulo` | `Reversao de dose devolve a quantidade atual, nao a efetivamente debitada` |
| `status` | `aberto` · `prioridade` `baixa` |
| `relacionado` | `MH-073` |

`reverterConfirmacao` chama `calcularDeltaEstoqueDaDose`, que lê a `quantidade_por_dose`
**vigente**. Se ela mudar entre a confirmação e a reversão, a devolução diverge do débito.
O valor exato está em `stock_movements.quantidade_delta` na linha com o mesmo
`dose_log_id`; ler de lá exige tratar o caso de múltiplos movimentos por dose. Não
implementado na Parte A por decisão explícita.

**e) Abrir ACH-02 — portão de estoque só cobre estoque zerado**

| Campo | Valor |
|---|---|
| `tipo` / `numero` | `ACH` / próximo livre |
| `titulo` | `Portao de estoque do scheduler dispara so em <= 0, nao em insuficiente para a dose` |
| `status` | `aberto` · `prioridade` `media` |
| `relacionado` | `MH-073` |

`scheduler.js:65-66` e `:322` testam `estoque_atual <= 0`. Com dose fracionária ou
multi-unidade, o lembrete é enviado mesmo quando o estoque não cobre **aquela dose**
(ex: 1 ml restante para dose de 5 ml; 1 comprimido para dose de 3). O usuário confirma, o
`registrarMovimentoEstoque` faz clamp em 0 e o consumo real fica subregistrado. Escopo
natural da Parte E.

**f) Abrir ACH-03 — cadastro cria horários duplicados**

| Campo | Valor |
|---|---|
| `tipo` / `numero` | `ACH` / próximo livre |
| `titulo` | `Cadastro cria schedules duplicados no mesmo horario — saveSchedule sem guarda` |
| `status` | `aberto` · `prioridade` `media` |

**Evidência de produção:** medicamento `Nimesulida` (ativo) tem **três** schedules ativos —
`08:00` (id `6db766be…`), `08:00` (id `1b682bf1…`) e `22:00` — criados em sequência em
18/08 19:02:56-57, no mesmo instante do `cadastro_inicial`. `adicionarSchedule` protege
contra duplicata (`HORARIO_DUPLICADO`), mas `saveSchedule` — usado por `processarAcao` do
`cadastro.js` e por `replaceMedication` — **não tem guarda alguma**: itera sobre
`action.horarios` e insere o que vier do LLM.

Impacto (anterior à Parte A, não regressão): infla `dosesPerDia`, distorcendo
`diasRestantes` e o progresso de tratamento. Após a Parte A, também torna o degrau 2 de
`resolverQuantidadePorDose` ambíguo para doses sem `schedule_id` naquele horário — o
degrau 4 cobre com `system_event`, mas o dado de origem segue errado.

---

## 2. Estado real do banco após a v33

Reproduzido aqui como fonte de conferência para o arquivo de migration da seção 0.

**Colunas alteradas / criadas**

| Tabela | Coluna | Tipo | Null | Default |
|---|---|---|---|---|
| `medications` | `estoque_atual` | `numeric` | sim | `0` |
| `medications` | `estoque_minimo` | `numeric` | sim | `7` |
| `medications` | `unidade_estoque` | `text` | **não** | `'unidade'` |
| `medications` | `unidade_dose` | `text` | **não** | `'unidade'` |
| `medications` | `gotas_por_ml` | `numeric` | sim | `20` |
| `schedules` | `quantidade_por_dose` | `numeric` | **não** | `1` |
| `dose_logs` | `schedule_id` | `uuid` | sim | — |
| `stock_movements` | `quantidade_delta` | `numeric` | não | — |
| `stock_movements` | `estoque_anterior` | `numeric` | sim | — |
| `stock_movements` | `estoque_novo` | `numeric` | não | — |

**Constraints criadas**

- `medications_unidade_estoque_check` — `IN ('unidade','ml')`
- `medications_unidade_dose_check` — `IN ('unidade','ml','gota')`
- `medications_gotas_por_ml_check` — `NULL OR > 0`
- `medications_gotas_por_ml_exigido_check` — `unidade_dose <> 'gota' OR gotas_por_ml IS NOT NULL`
- `medications_coerencia_unidades_check` — dose `unidade`↔estoque `unidade`; dose `ml`/`gota`↔estoque `ml`
- `schedules_quantidade_por_dose_check` — `> 0`
- `dose_logs_schedule_id_fkey` — `REFERENCES schedules(id) ON DELETE SET NULL`

**Função** `get_pending_reminders()` recriada com 14 colunas de retorno: as 10 originais
(`estoque_atual`/`estoque_minimo` agora `numeric`) mais `quantidade_por_dose`,
`unidade_dose`, `unidade_estoque`, `gotas_por_ml`.

**Backfill:** 0 medicamentos com `unidade_*` nula, 0 schedules com `quantidade_por_dose`
nula. `Omega 3` (`af219595-9f67-48ba-b77e-6b5eceb8eae8`) com `quantidade_por_dose = 2` nos
dois horários.

---

## 3. Seção a inserir no CONTEXT.md

```markdown
## Sessão v33 — MH-073 Parte A: separação entre unidade de estoque e unidade de dose

**Data:** 19/08/2026 · **Status:** entregue, em validação

### O problema

Todo o sistema de estoque repousava sobre uma equação implícita que nunca foi escrita em
lugar nenhum:

    1 schedule disparado = 1 dose = 1 unidade de estoque

Ela estava distribuída em quatro `delta: ±1` hardcoded (`confirmDose`,
`confirmDoseByLogId`, `confirmarDoseRetroativa`, `reverterConfirmacao`) e em três cálculos
de `estoque ÷ número_de_schedules`. `dosesPerDia` nunca foi um dado armazenado — era
sempre derivado de `COUNT(schedules ativos)`.

A equação é falsa para líquidos (dose em gotas/ml, estoque em ml) e **já era falsa para
sólidos**.

### Evidência que motivou o desenho

Medicamento `Omega 3` em produção: `dosagem = "4 comprimidos por dia (2 às 10:00 e 2 às
21:30)"`, 2 horários ativos, 15 confirmações, soma dos deltas **−15**. O usuário toma 2
por dose; o sistema debitava 1. **Subcontabilização de 50%, em medicamento sólido.**

Duas conclusões estruturais:
1. A lacuna "quantidade por dose" nunca foi exclusiva de líquidos — líquidos apenas
   tornaram impossível continuar ignorando.
2. `dosagem` virou lixeira semântica: sem campo estruturado para "quanto se toma por vez",
   o LLM despejou a posologia inteira num `text` que nenhum cálculo consome. Campo faltando,
   não prompt ruim.

### O que foi entregue

- `schedules.quantidade_por_dose` (numeric, NOT NULL, default 1, CHECK > 0)
- `medications.unidade_estoque` · `unidade_dose` · `gotas_por_ml`, com CHECKs de conjunto
  fechado e de coerência entre os dois eixos
- `estoque_atual`, `estoque_minimo` e as três colunas de `stock_movements` → `numeric`
- `dose_logs.schedule_id` — o vínculo dose↔posologia, que **não existia**
- `get_pending_reminders` recriada (o `RETURNS TABLE` declarava `estoque_atual int`; sem
  recriar, quebraria na primeira execução do cron, não na migration)
- Helpers determinísticos em `database.js`: `resolverQuantidadePorDose`,
  `converterDoseParaEstoque`, `calcularDeltaEstoqueDaDose`, `calcularConsumoDiario`
- Blindagem de `replaceMedication`, `reativarComAtualizacao` e `adicionarSchedule` contra
  perda silenciosa da posologia
- `getEstoqueInfoParaAlerta` e `calcularProgressoTratamento` passam a usar **consumo
  diário** (soma das quantidades) em vez de contagem de horários

Nenhuma alteração de fluxo conversacional nem de texto ao usuário. Comportamento externo
idêntico ao anterior para medicamentos de 1 unidade por dose.

### Decisões de arquitetura

**Quantidade por dose mora em `schedules`, não em `medications`.** Posologia é um conjunto
de tuplas `(quanto, quando)`, não um escalar — um campo único não representaria "2 de manhã
e 1 à noite", realidade clínica confirmada em campo. `schedules` já é a tabela de posologia:
guarda `horario` e `dias_semana`, ambos fatos de prescrição, não de agendamento. O disparo
real é `get_pending_reminders` + node-cron.

**A tabela `schedules` NÃO foi renomeada para `posologia`.** Avaliado e descartado. O ganho
era só de clareza conceitual; o custo eram dois riscos desproporcionais: a chave do join
aninhado do Supabase mudaria `med.schedules` → `med.posologia` em **10 pontos de leitura**
que um grep por `from('schedules')` não encontra, e haveria janela de indisponibilidade
entre migration e deploy com o cron rodando a cada minuto. **Não relitigar sem motivo novo.**

**`forma_farmaceutica` é descritiva; `unidade_*` é chave de comportamento.** Ver princípio 45.

**Gotas por ml: convenção 20, editável por medicamento.** RAG sobre o bulário da ANVISA foi
avaliado e descartado — além do custo (scraping de PDF, normalização comercial→apresentação,
vector store), faria inferência de LLM alimentar aritmética de dose. Evolução prevista, se
houver demanda: tabela curada de 30-50 medicamentos versionada no repo — determinística e
auditável.

### Validação em produção

- `Nimesulida` com `quantidade_por_dose = 3` no horário das 22:00: dose confirmada gerou
  `stock_movements.quantidade_delta = -3` (28 → 25), resolvida pelo **degrau 1** de
  `resolverQuantidadePorDose` (`dose_logs.schedule_id` preenchido)
- Nenhum `system_event` de `degradacao_silenciosa` registrado
- Demais medicamentos (quantidade 1) seguem com delta −1 — sem regressão

**Ainda não observado:** débito de −2 no `Omega 3` (nenhuma dose confirmada desde a
migration) e primeira dose de medicamento líquido real — só existirá após a Parte B.

### Dívida deixada consciente

- `dose_logs.schedule_id` **sem backfill retroativo**: das 978 linhas existentes, 311 (32%)
  têm `horario_agendado` NULL, tornando impossível reconstruir o vínculo para um terço da
  base. Reconstruir só os 67% criaria dado parcialmente confiável — pior que ausência
  declarada. `NULL` significa, sem ambiguidade: dose anterior à Parte A, quantidade 1.
- **Estoque do `Omega 3` segue inflado** em ~15 unidades (15 doses debitadas com 1 quando
  deveriam ser 2). Não corrigido: a correção exige o valor real conferido pelo usuário, e
  alterar estoque sem essa evidência violaria o princípio de causa raiz confirmada.
- `cadastro.js:406-431` (pré-cálculo de `alerta_estoque_baixo`) **não tocado** — opera sobre
  contexto pré-salvamento, sem `medication_id`. Depende da coleta; é Parte B.
```

---

## 4. Princípios a acrescentar ao CONTEXT.md

```markdown
**45. Campo descritivo e chave de comportamento são papéis distintos — e só o segundo
precisa de barreira.** Um campo que apenas é renderizado como texto pode ser livre; um campo
sobre o qual o código faz `if`/`switch` precisa ser conjunto fechado, validado antes de
persistir. `forma_farmaceutica` é gerada por LLM em texto livre e já apresenta deriva em
produção (`cápsula` / `capsula` / `efervescente`, este último fora da lista sugerida no
prompt); é lida em **um único ponto** (`relatorios.js:336`) e apenas para compor texto.
Promovê-la a condicional de cálculo importaria toda a variabilidade do LLM para dentro da
aritmética de dose. Ela também não determina a unidade nem em teoria — colírio e xarope são
ambos líquidos mas dosam em gotas e ml respectivamente; "efervescente" é sólido apesar do
nome. Por isso o comportamento é governado por `unidade_dose`/`unidade_estoque` (conjunto
fechado, CHECK no schema) enquanto `forma_farmaceutica` permanece cosmética. Divergência
entre os dois produz **texto estranho, nunca cálculo errado** — falha barata por desenho.

**46. Quando o dado não basta, degradar com evidência registrada — nunca com valor padrão
silencioso.** `resolverQuantidadePorDose` percorre quatro degraus em ordem decrescente de
confiabilidade: vínculo direto (`dose_logs.schedule_id`), casamento por `horario_agendado`
apenas quando não ambíguo, quantidade uniforme entre todos os horários, e — só então —
fallback para 1 **acompanhado de `system_event`**. Cada degrau é uma fonte determinística,
nunca uma inferência. O quarto degrau existe porque a função precisa ser total, mas ele
nunca é atingido em silêncio: se um valor padrão vira dado de saúde, isso tem que aparecer
na observabilidade. Complementa o princípio 24 — registrar a intenção não basta, é preciso
registrar quando a intenção não pôde ser cumprida.
```

---

## 5. Relato esperado

1. Confirmação do commit do arquivo de migration (seção 0) e de qualquer divergência entre
   o script executado e o do briefing.
2. `grep -c "^## Sessão" CONTEXT.md` antes e depois.
3. Confirmação do rename do briefing (seção 1.2).
4. Lista dos itens de backlog escritos, com os números atribuídos aos três ACH.