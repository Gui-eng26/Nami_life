# BASELINE do corpus — v45 P0 (a régua do principal como porta)

**Data:** 26/09/2026
**Modelo da porta atual:** `claude-sonnet-4-6` (`src/porta.js`)
**Itens:** 71 — `dose` 25 · `delegacao` 15 · `horario` 12 · `recorrencia` 8 · `multi_med` 6 · `estoque` 5
**Substitui** o baseline do E0 (22/09, 61 itens só de extração). O formato do item mudou (P0 §2).

```bash
npm run corpus -- --adaptador=producao_observada   # dose + delegacao, custo zero
npm run corpus -- --adaptador=porta_atual          # extração, 31 chamadas (~30 s)
npm run corpus -- --adaptador=principal_p1         # o principal (P1) — ver §5
npm run corpus -- --adaptador=principal_p1 --modelo=claude-sonnet-5
```

Filtros: `--categoria=dose`, `--item=D-02`, `--json=saida.json`. O corpus sai sempre com código 0 e
**nunca** entra no portão de merge.

---

## Como ler

Cada item é **um turno real**, com o contexto estruturado em que chegou (pendência aberta, doses com
referência curta `D1…Dn` por recência, rótulo de dia, status em linguagem de negócio, último lembrete,
mensagem citada), o que o sistema **fez de fato** (`observado_producao`) e o que **deveria** ter feito
(`esperado`).

- **`correto`** é o item inteiro. No `producao_observada` é o veredito registrado na coleta; no
  `porta_atual` é "todos os campos que a porta representa estão certos".
- **Por campo**, o placar é binário: o conjunto esperado tem que bater inteiro.
- Na porta atual, `relacao_pendencia`, quantidade, dias da semana, dosagem, cadência, forma, correção,
  estoque e "não representável" **não existem** no schema. Aparecem como
  `nao_suportado_pela_porta_atual` e nunca como erro: são o buraco que o P1 precisa fechar.

---

## 1. `producao_observada` — dose e delegação (custo zero)

| Categoria | Itens | Correto | Campos |
|---|---|---|---|
| `dose` | 25 | **9/25 (36%)** | tipo 12/25 · doses 10/22 · candidatas 1/2 · outra 0/2 |
| `delegacao` | 15 | **7/15 (47%)** | tipo 14/15 · especialista 13/14 · relação com a pendência 10/14 · subtipo 1/2 |
| **total** | **40** | **16/40 (40%)** | |

Sem os itens marcados para revisão: `dose` 6/16, `delegacao` 7/14.

### O que a produção erra em `dose`

1. **Dose esgotada deixa de existir.** "Yes" 13 min depois da última cobrança (D-01) recebeu "não há
   nenhuma dose pendente". Julho já mostrava o mesmo (D-23: "já passou do prazo de registro").
2. **"Ontem" cai na dose de hoje.** D-02 ("Ontem eu tomei", três doses esgotadas): o
   `fast_path_resposta_tardia` confirmou D1 (hoje). É o atalho que não lê a referência de dia.
3. **Pendência aberta engole a confirmação.** D-05 e D-06: "Yes" durante `cad_estoque` — com e sem o
   lembrete citado — virou resposta a "quantas unidades de Aerolin spray?". A citação não mudou nada.
4. **`sem_estoque` nunca recebe "Sim".** D-07/08/09: cinco dias seguidos de "Sim" ao aviso de estoque
   zerado, nenhum registro. (Marcados para revisão: ver §4.)
5. **Turno com duas partes perde uma.** D-10 (recompra + "Sim") e D-11 (tomei + "providenciei mais"): a
   produção trata só a dose, e no D-10 a dose errada (a do lembrete do mesmo minuto, não a citada).
6. **Retroativas em lote: lista incompleta e confirmação extra.** D-18 e D-25 omitiram uma dose da lista
   (Neosaldina 10:38; Ômega 3 07:58). D-03, D-19 e D-24 acharam as doses certas mas pediram confirmação.
   Se pedir confirmação de retroativa for aceito como política, `dose` sobe para **12/25** — D-18 e D-25
   continuam errados.

O que a produção **acerta**: "sim"/"tomei" simples com um único grupo pendente (D-04, D-12, D-13, D-14,
D-17), o "Não" no sentido de "ainda não" (D-15, D-16), a ambiguidade entre duas doses do mesmo remédio
(D-20) e a reversão "na vdd não tomei" (D-21).

### O que a produção erra em `delegacao`

- **Pedido novo durante coleta aberta vira resposta à coleta** (G-01, G-02, G-04): o cadastro repete o
  convite de estoque. É o padrão mais caro — 3 dos 8 erros — e é exatamente o que
  `relacao_pendencia` separa.
- **"Erro" vira resposta** (G-03) em vez de pergunta sobre o que saiu errado.
- **O valor dito na mensagem se perde**, mesmo com especialista e relação certos: G-08 ("Na verdade 9 no
  estoque" → perguntou de novo) e G-15 ("Não 05:30 para as 08" → "Nada foi alterado"). Os campos acertam,
  o veredito não — o executor lista esses dois como divergência manual.
- **Troca de alvo ignorada** (G-14) e **subtipo errado** (G-12, relatório de adesão em vez do balanço de
  ontem).

A escolha do **especialista** já é boa hoje (13/14). O que falta é a **relação com a pendência** (10/14) e
o **valor** chegar ao especialista.

---

## 2. `porta_atual` — extração (31 chamadas)

| Categoria | Itens | Correto | Especialista | Nomes citados | Horários citados | Meds a cadastrar | Horários resolvidos |
|---|---|---|---|---|---|---|---|
| `horario` | 12 | **12/12** | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| `recorrencia` | 8 | **5/8** | 6/8 | 8/8 | 8/8 | 7/8 | 7/8 |
| `multi_med` | 6 | **5/6** | 6/6 | 5/6 | 6/6 | 5/6 | 6/6 |
| `estoque` | 5 | **2/5** | 4/5 | 5/5 | 4/5 | 3/5 | 4/5 |
| **total** | **31** | **24/31 (77%)** | 28/31 (90%) | 30/31 (97%) | 30/31 (97%) | 27/31 (87%) | 29/31 (94%) |

### Campos ausentes da porta atual (`nao_suportado_pela_porta_atual`)

| Campo | Itens que exigem |
|---|---|
| `relacao_pendencia` | 31 |
| `quantidade` | 11 |
| `forma_unidade` | 10 |
| `dosagem` | 8 |
| `dias_semana` | 6 |
| `cadencia` | 5 |
| `estoque` | 4 |
| `correcoes` | 2 |
| `nao_representavel` | 1 |

### O que a porta atual mostra

1. **Horário está resolvido na leitura.** As 12 formas do §3 — `6h`, `7hrs`, `19hs`, `8 hrs`/`8 horas`,
   `07h`, `07:00`, `6:30h`, `6h30`, `17hs`, `12/12 hrs`, `meio dia`, `de manhã` — saem certas, inclusive o
   `de manhã` sem horário inventado. Confirma o E0: o 06:00 de 22/09 nasce no consumidor, não na porta.
2. **Número seco em etapa de estoque vira horário** (E-03, novo neste corpus): `"10"` respondendo "quantos
   comprimidos de Roacutan você tem?" saiu como horário `10`. Sem a pendência no contexto, a porta não tem
   como saber — é o argumento mais direto para entregar a pendência estruturada ao principal.
3. **Correção ou estoque vira "medicamento para cadastrar"** (R-01/E-01 "vitamina b12 … toda segunda", E-02
   "Puran T4 30"): o nome citado cai em `medicamentos`, o campo de cadastro, e a intenção fica `cadastro`
   em vez de `configuracao`. Mesma família de G-04 na produção.
4. **Não representável ainda é recusado pela porta errada** (R-07, "a cada 3 semanas" → `nao_suportado`),
   contra a regra da própria porta de deixar o cadastro responder com honestidade.
5. **Faixa vira horário decidido** (R-08: "entre 06:00 e 08:00" → dois horários).

A porta **acerta** o que declara entregar (nomes e horários como escritos: 97%). O que falta é tudo que
depende de saber **qual pergunta está aberta** e **o papel de cada nome** — e isso não existe no schema.

---

## 3. Composição e procedência

| Categoria | Itens | Obrigatórios do §3 |
|---|---|---|
| `dose` | 25 | "Yes" com dose esgotada (D-01) · "Ontem eu tomei" com três esgotadas (D-02) · "Yes" durante `cad_estoque` (D-05) · "Yes" citando o lembrete (D-06) · "Simmm"/"Simm"/"Sim" com `sem_estoque` (D-07/08/09) · "Comprei 60 comprimidos / Sim" (D-10) · "já tomei o Elani e já providenciei mais" (D-11) · "Não" = "ainda não" 26/09 12:50 (D-16) · "Ontem eu tomei também" (D-03) · "tomei todos de hoje e de ontem" (D-18) · "de ontem e de sábado" (D-19) · "tomei a dipirona ontem" (D-20) · "na vdd não tomei o dipirona" (D-21) · "sim" com um único grupo pendente (D-12, D-13) |
| `delegacao` | 15 | "Quero cadastrar mais um!" (G-01) e "Cadastrar medicamento semanal" (G-02) em `cad_estoque` · "Erro" (G-03) · b12 semanal em `cad_estoque_lote` (G-04) · "29" (G-05) e "Marevan 30, Kepra 29" (G-06) em convite de estoque · lista durante coleta aberta (G-07) |
| `horario` | 12 | as 12 formas do §3 (H-01…H-12) |
| `recorrencia` | 8 | "toda segunda" (R-01) · "as segundas-feiras" (R-02) · seg a sex + fim de semana (R-03) · 1x por semana + dia (R-04, R-05) · dia sim/dia não (R-06) · a cada 3 semanas (R-07) |
| `multi_med` | 6 | as três mensagens multi-medicamento reais do §3 (MM-01 de 22/09, MM-02 com horário em linha solta, MM-03 com quatro linhas) |
| `estoque` | 5 | "b12" (E-01) · "Puran T4 30" (E-02) · número seco (E-03) · frasco (E-04) · fração (E-05) |

| `fonte.origem` | Itens | O que é |
|---|---|---|
| `producao` | 44 | `agent_logs` de usuário real |
| `teste_interno` | 21 | conta de teste da equipe — fonte do gabarito das retroativas (P0 §4) |
| `sintetico` | 5 | forma exigida pelo §3 que não aparece em `agent_logs`: `07h` (H-05), `6h30` (H-08), dia sim/dia não (R-06), a cada 3 semanas (R-07), "Puran T4 30" (E-02) |
| `arnes` | 1 | "Marevan 30, Kepra 29" (G-06): frase do caso A32; o observado vem do arnês, não da produção |

A mesma mensagem da conversa de 22/09 ("A vitamina b12 é uma vez por semana…") aparece três vezes, com
gabaritos de focos diferentes: G-04 (delegação), R-01 (recorrência), E-01 (dígito no nome). A mensagem 1
dessa conversa aparece em H-07 (forma `6:30h`) e MM-01.

### Reconstrução do contexto de dose

Refeito a partir de `dose_logs` no instante da mensagem (janela: hoje, ontem, anteontem):

- `confirmada` se a confirmação (ou a confirmação retroativa) aconteceu **antes** da mensagem; a dose
  confirmada **pela própria** mensagem aparece com o status anterior;
- `aguardando_resposta` até 2 h depois do horário (lembrete + cobranças de 30 e 90 min + 30 min finais),
  `sem_resposta` depois disso;
- `sem_estoque` é gravado pelo scheduler no horário da dose; `nao_tomada` vem de `nao_tomado`.

Duas correções à mão: as doses de Roacutan de 24–26/09 (D-01/D-02) foram reescritas em 26/09 13:07 (correção manual
depois do D-02) e aparecem com o status que tinham **antes** dela; em D-21, as linhas duplicadas de
`dose_logs` daquela época ficaram como estão.

### Correções em relação ao E0

- Horários passam a usar a hora de Brasília (o E0 citava 10:58/10:59, em UTC, para as mensagens de
  07:58/07:59).
- "Não sei quanto eu tenho" era do Dormid, não do Magnen B6 (G-13).
- "Não 05:30 para as 08" era do Losartana, não do Puran (G-15).
- "Meio dia" em `obter_horario` era do Ômega 3, não da Dipirona (H-11).
- "1 frasco fechado de 100ml" respondia sobre o Respiratux, não o Fluir xarope (E-04).

### Privacidade

Nenhum nome de pessoa, telefone, data de nascimento ou identificador em `itens.json`. `fonte` guarda
data e origem. Mensagens citadas pela Nami foram reescritas sem o vocativo com o nome. Nomes de
medicamento e posologia ficam: são o objeto do teste.

---

## 4. Revisão do gabarito (§6)

15 itens marcados `revisar: true` — Guilherme revisa só estes:

`D-07, D-08, D-09, D-10, D-11, D-15, D-20, D-21, D-22, G-14, R-03, R-07, R-08, MM-03, MM-04`

Os que mais movem o placar:

- **D-07/08/09 (`sem_estoque`)** — o gabarito diz "tomou". A leitura alternativa é "ciente do
  aviso" (`responder`). Se virar `responder`, a produção passa a acertar os três.
- **D-10** — "Sim" vale só para o Regenesis (citado) ou também para o Ofolato D do mesmo
  minuto? E quem atualiza estoque no P1: `configuracao` ou o próprio principal?
- **D-11** — "providenciei mais" pede pergunta de quantidade ou é só registro da dose?
- **D-21** — `nao_tomou` ou `desfazer` para "na vdd não tomei" sobre dose já confirmada.
- **D-22** — "Tomei o ômega 3 de ontem" com todas as de ontem já confirmadas: perguntar (gabarito) ou
  registrar a de hoje (como a produção fez)?
- **G-14** — troca de alvo dentro do fluxo: `novo` (gabarito) ou `responde`?

Guidance para a amostra de 10 não marcados: os de maior risco de gabarito são D-18 (quais doses entram em
"todos de hoje e de ontem"), D-19 ("sábado" = anteontem), D-24 (anteontem **não** entra em "de ontem") e
G-04 (b12 semanal é `configuracao`, `novo`).

---

## Notas de execução

- `porta_atual` usa LLM: o placar oscila 1–2 itens entre execuções. Vale o perfil por categoria.
- O `porta_atual` passa à porta a mesma entrada do E0 (estado corrente, sem histórico): a pendência
  estruturada do item é o que o principal receberá no P1, e a porta de hoje não tem onde recebê-la.
- O banco fica neutralizado no `porta_atual` (credenciais inertes antes de importar `src/`); o
  `producao_observada` não importa `src/` nem lê `.env`.
- `principal_p1` recebe `item.contexto` como está, pelo mesmo renderizador do turno real (§5).

---

## 5. P1 — `principal_p1` (26/09/2026)

O principal como porta única, medido sobre o mesmo corpus. O adaptador monta o
contexto do item pelo **mesmo** renderizador do turno real (bloco único de doses
com refs, pendência, citação) e faz uma chamada por item. Gabarito com as três
decisões de 26/09 aplicadas: D-07/08/09 saíram da revisão ("Sim" depois de
lembrete é confirmação); a segunda parte do D-10 é `UPDATE_STOCK` do principal.

Fato relatado sobre dose que o banco já registra ("tomou" numa confirmada) não
conta no campo `doses`: o executor o ignora (ver "já registrada" no P1).

### Comparação com o baseline de produção (critério do §11: ≥ em dose e delegação)

| Categoria | Produção (P0) | `claude-sonnet-4-6` | `claude-sonnet-5` ¹ |
|---|---|---|---|
| `dose` | 9/25 | **21/25** | 23/25 |
| `delegacao` | 7/15 | **15/15** | 14/15 |
| `horario` | — | 11/12 | 9/12 |
| `recorrencia` | — | 6/8 | 4/8 |
| `multi_med` | — | 5/6 | 4/6 |
| `estoque` | — | 4/5 | 3/5 |
| **total** | 16/40 | **62/71** | 57/71 |

Porta atual (P0) nas categorias de extração, para referência: 24/31. Com
`claude-sonnet-4-6`, o principal fica em 26/31 nelas.

¹ **Rodada anterior** do `claude-sonnet-5`, feita antes de dois ajustes de código
(nome proposto que não aparece na mensagem é descartado; fato sobre dose já
registrada é ignorado). A rodada com o código final ficou inválida: a chave da
API ficou sem crédito no meio dela. Os dois ajustes só podem melhorar o placar
dele (D-18 e boa parte dos erros de `nomes_citados` eram exatamente isso).
Refazer antes da decisão de modelo.

### Por campo — `claude-sonnet-4-6`

| Campo | Acerto |
|---|---|
| `tipo` | 68/71 |
| `doses` | 20/22 |
| `candidatas` | 0/2 |
| `especialista` | 45/45 |
| `relacao_pendencia` | 44/45 |
| `subtipo` | 2/2 |
| `outra` | 1/2 |
| `nomes_citados` | 29/31 |
| `horarios_citados` | 31/31 |
| `medicamentos_a_cadastrar` | 29/31 |
| `horarios_resolvidos` | 30/31 |

Quantidade, dias da semana, dosagem, cadência, forma, correção, estoque e "não
representável" aparecem como `extracao_estruturada_no_P2`: são o escopo do P2.

### Os 9 erros do `claude-sonnet-4-6`

7 dos 9 estão em itens marcados para revisão — o gabarito é que está em dúvida:

- **D-10** 🔎 — o "Sim" confirmou o Ofolato D **e** o Regenesis (lembrados no mesmo minuto).
- **D-11** 🔎 — perguntou a quantidade da recompra sem registrar a dose junto.
- **D-20** 🔎 — "tomei a dipirona ontem": registrou as duas doses de Dipirona em vez de perguntar.
- **D-22** 🔎 — "tomei o ômega 3 de ontem" com as de ontem já confirmadas: não perguntou se era a de hoje.
- **R-07** 🔎 / **R-08** 🔎 / **MM-04** 🔎 — nome "injeção" como medicamento; faixa 06:00–08:00 como horários; relação `responde` em vez de `novo`.
- **H-11** — "Meio dia" na configuração do Ômega 3: o principal preencheu o campo `medicamento` (alvo da configuração) com "Ômega 3", que a régua de `nomes_citados` conta como citado. É o alvo certo; o gabarito de leitura literal é que não o espera.
- **E-02** — "Puran T4 30" no convite agregado: o nome foi para `medicamentos` (campo de cadastro) em vez de só estoque.

### O que muda de natureza em relação à produção

- **Dose:** dos 16 erros de produção, o principal acerta 12. Continuam errados só itens em revisão.
- **Delegação:** os 8 erros de produção — pedido novo engolido pela coleta, "Erro", B12
  semanal virando estoque, valor descartado — viram 15/15. O que faltava era a
  relação com a pendência, e ela chegou a 44/45.
