# BRIEFING — MH-073 Parte B.3: conteúdo determinístico e exaustividade das decisões

**Sessão:** v34 · **Data:** 20/08/2026
**Item de backlog:** MH-073, parte B.3
**Origem:** segunda bateria de validação em produção (20/08, 15:46–16:28 BRT)
**Corrige:** BUG-94, BUG-95, BUG-96, BUG-97, BUG-98, BUG-99 · **Implementa:** MH-80
**Arquivos:** `src/agentes/cadastro.js`, `src/observabilidade.js`
**Migration:** nenhuma.

---

## 1. O que a Parte B.2 resolveu (não pode regredir)

| Verificação | Evidência |
|---|---|
| BUG-92 — estado volta a `idle` | Lembrete do tobradex às 16:06 chegou e foi confirmado sem passar pelo cadastro |
| BUG-93 — rótulo da dose | Resumos exibiram `5 ml`, `4 gotas`, `1 comprimido` — nenhum "5 líquido" |
| Baixa de dose líquida | `stock_movements`: tobradex `10 → 9.8` (4 gotas ÷ 20) e Claritin `100 → 95` (5ml) |

⚠️ A baixa líquida é o **primeiro registro real do projeto** — pendência declarada no fechamento
da Parte A. A cadeia coleta → schema → conversão → débito está provada. Nada aqui pode quebrá-la.

---

## 2. TEMA 1 — A mensagem afirma dado de saúde que não está no estado (BUG-94)

A Parte B.2 tirou do LLM a decisão de **estado**. Não tirou a de **conteúdo**. Quando o código
decide `indeterminado`, "avança" ou "volta para a etapa X", o bloco de prompt daquela etapa
deixa o LLM compor texto livre — e ele preenche as lacunas com o que leu na conversa.

### Evidência — cinco ocorrências, todas confrontadas com o banco

| Hora | A Nami afirmou | O estado continha |
|---|---|---|
| 15:53:05 | "5 ml às 16:00, às 00:00 e às 08:00" | 06:00, 14:00, 22:00 |
| 15:56:28 | "os HORÁRIOS seriam 16:00, 00:00 e 08:00" | 14:00, 16:00, 22:00 |
| 15:56:45 | "vou te lembrar nos horários certinhos: 16:00, 00:00 e 08:00" | **gravou 14:00, 16:00, 22:00** |
| 16:10:58 | "Com 60 unidades e 3 comprimidos por dia... 20 dias" | estoque = 0 |
| 16:27:24 | "Com 30 comprimidos e 1 por dia... 30 dias" | estoque = 0 (`diovan`) |

### Correção

**Aplicar o Princípio 28 sem exceção: toda mensagem que afirme posologia, horários, quantidade
ou estoque é renderizada em código; o LLM escreve apenas a moldura em volta.**

Hoje isso existe em `resumoRenderizado` e `blocoConfirmaForma`. Falta em:

| Etapa / caminho | O que precisa ser renderizado |
|---|---|
| `cad_tipo_tratamento` | nada de posologia deve ser repetido — o bloco de prompt precisa proibir explicitamente citar horários/quantidade |
| `cad_estoque` (pergunta) | idem; a pergunta é só "quantos X você tem" |
| `cad_estoque` (alerta) | linha de alerta renderizada em código a partir de `alerta_estoque_baixo` — nunca frase livre com números |
| `cad_salvo` | a mensagem de sucesso pode citar horários **apenas** a partir de bloco renderizado em código; se não houver bloco, não cita nada |
| qualquer caminho `indeterminado` | o que já foi coletado só aparece via bloco renderizado |

Regra para o prompt, em todos os blocos:

> Você NUNCA escreve horário, quantidade, unidade ou número de estoque. Esses valores chegam
> prontos em `context.blocoRenderizado` e devem ser inseridos literalmente. Se o bloco não
> existir no contexto, não mencione nenhum desses dados.

### Tom (mesma raiz)

O bloco do caminho `indeterminado` produziu, às 15:55:50:

> "Não entendi bem o que você quer corrigir nos **HORÁRIOS** do Claritin. Pode me dizer quais são
> os horários corretos?"

Seco e levemente ríspido — não é a voz da Nami. O bloco de instrução é telegráfico e o LLM
reproduz o registro. Reescrever os blocos de `indeterminado` pedindo acolhimento antes da
repergunta ("Desculpe, não peguei direito 😊 ..."), mantendo a proibição de citar números.

---

## 3. TEMA 2 — Funções de decisão não cobrem todas as categorias do classificador

O classificador devolve N categorias; a função de decisão trata M < N; o restante cai num
fallback que **descarta a informação do usuário em silêncio**.

### 3.1 BUG-95 — `decidirCadConfirmaForma`

Trata `posologia_completa` e `formaExplicita`. **Não trata `horarios_apenas` nem
`frequencia_intervalo`** → caem no `return` final ("avança para `cad_tipo_tratamento`").

**Evidência:** 15:53:05, o usuário respondeu *"Na vdd não vai começar as 6, vai começar às 16hrs"*
na etapa `cad_confirma_forma`. A correção foi descartada; o resumo das 15:54 exibiu 06:00/14:00/22:00.

**Correção:** acrescentar os dois ramos.
- `horarios_apenas` → remapear via `remapearParesParaNovosHorarios`; se remapear, permanece o
  fluxo normal; se não, vai para `cad_quantidade_por_dose`.
- `frequencia_intervalo` → ver 3.2 (mesmo tratamento).

⚠️ A etapa continua **nunca bloqueando** (seção 6.3 da Parte B) — os ramos novos avançam ou
corrigem, nunca travam.

### 3.2 BUG-96 — `corrigirPosologiaEmConfirmacao`

Trata `posologia_completa`, `horarios_apenas` e `quantidade_apenas`. **Não trata
`frequencia_intervalo`** → cai em `indeterminado` com `contextUpdates: {}`.

**Evidência:** 15:56:28, *"Vou tomar de 8 em 8hrs começando as 16hrs"* → nada mudou no estado; o
LLM narrou "16:00, 00:00 e 08:00" (BUG-94) e o cadastro salvou 14:00/16:00/22:00.

**Correção:** ramo `frequencia_intervalo` com `horarioInicio` → recalcular via
`calcularHorariosPorIntervalo` e remapear as quantidades. Sem `horarioInicio` → permanecer em
`cad_confirmacao` perguntando o horário da primeira dose.

### 3.3 BUG-97 — estoque sólido perde o número quando vem em frase ⚠️ CRÍTICO

```js
// cadastro.js:252
const estoque = parseInt(message) || 0;
```

`parseInt("Tenho 30 cps")` → `NaN` → `0`. `parseInt("Caixa com 60")` → `NaN` → `0`.

**Evidência — dois casos independentes, ambos gravados errado:**

| Medicamento | Resposta do usuário | `estoque_atual` no banco |
|---|---|---|
| lipitor | "Caixa com 60" | **0** |
| diovan | "Tenho 30 cps" | **0** |

`stock_movements` confirma: `cadastro_inicial, 0 → 0`.

#### ⚠️ Isto é REGRESSÃO INTRODUZIDA PELA PARTE B, e a origem é o briefing

A seção 6.5 do briefing da Parte B especificou literalmente:

> **`unidade`** → exatamente como hoje: um número. `estoque = parseInt(message)`.

Antes da Parte B a extração era feita pelo LLM, dentro de `action.estoque` do `SAVE_MEDICATION`,
e absorvia frase natural sem esforço. A Parte B substituiu extração por LLM por parse ingênuo e
a capacidade foi perdida. **Registrar como regressão, não como defeito descoberto** — a lição é
"não substituir extração por LLM sem extrator equivalente".

Severidade **crítica**: não é caso de borda. "Tenho 30 comprimidos" é a resposta natural do
público-alvo; a resposta em número puro é a exceção.

#### Correção — três camadas, todas necessárias

**(a) Classificador dedicado de estoque sólido.** Regex de primeiro número não resolve:
`"1 caixa com 30"` devolveria `1` — errado com valor plausível, pior que zero. Padrão dos demais
classificadores do projeto:

```js
classificarEstoqueSolido({ message, nomeMedicamento, historicoConversa })
// → { categoria: 'quantidade' | 'indeterminado', quantidade: <number|null> }
```

Regras obrigatórias no prompt:
- Devolve o total em **unidades**, já multiplicado: "2 caixas de 30" → `60`; "1 caixa com 30" → `30`;
  "3 cartelas de 10" → `30`; "tenho 30 cps" → `30`; "meia caixa de 20" → `10`.
- Zero é resposta válida: "não tenho nenhum", "acabou", "zero" → `quantidade: 0`.
- Sem número reconhecível ("tenho bastante", "uma caixa" sem saber o conteúdo) → `indeterminado`.
- `degradar()` no catch com fallback `indeterminado` — **nunca** um número chutado.

**(b) Falha de extração devolve `null`, nunca `0`.**

⚠️ **Zero é valor legítimo** — a pessoa pode cadastrar o medicamento antes de comprar. A regra
não é "proibir zero"; é **não colapsar "não consegui ler" e "o usuário disse zero" no mesmo
valor**. Foi exatamente esse colapso que deixou lipitor e diovan passarem despercebidos.

- `categoria: 'quantidade'` com `quantidade: 0` → segue normalmente, grava 0, alerta dispara.
- `categoria: 'indeterminado'` → permanece em `cad_estoque` e reformula a pergunta.
- `finalizarComEstoque(0)` **não pode ser alcançável a partir de falha de extração**.

**(c) A linha de estoque e o alerta são renderizados em código** — Tema 1. Sem isso, mesmo com a
extração certa o LLM continua narrando o número que leu na mensagem do usuário, como fez no
diovan.

#### Ramo líquido — não tocar

`extrairFrascosEVolume` funcionou em todos os testes de líquido ("1 vidro de 100ml", "1 de 10ml",
"1 frasco" + "10ml"). **Não substituir por classificador nesta parte** — seria trocar código que
funciona por código novo sem evidência de defeito. A única mudança no ramo líquido é (b): quando
o volume não for reconhecido, repergunta em vez de assumir `0`.

### 3.4 Auditoria dos demais parses (escopo fechado)

| Local | Método | Ação |
|---|---|---|
| `cadastro.js:252` | `parseInt(message)` | substituir (3.3) |
| `extrairNumero:167` | regex primeiro número | manter; aplicar (b) no consumo |
| `extrairFrascosEVolume:174` | regex com `ml` explícito | manter |

⚠️ `respostaConfirmaSimples:1035` foi **verificado e está correto** — usa `===` e
`startsWith(t + ' ')`, sem `includes`, e nenhum termo de uma letra. Não é da família do BUG-88 e
não precisa de mudança.

---

## 4. Defeitos individuais

### 4.1 BUG-98 — correção do primeiro horário não recalcula o intervalo

**Evidência:** posologia definida como "de 8 em 8h começando às 6h" → 06:00/14:00/22:00. O
usuário corrigiu "o primeiro horário é às 16hrs". O sistema trocou 06:00 por 16:00 e ordenou:
**14:00, 16:00, 22:00**. O esperado, mantendo o intervalo declarado, era **16:00, 00:00, 08:00**.

`context.intervalo_horas` existe e é ignorado em `corrigirPosologiaEmConfirmacao`.

**Correção:** quando `context.intervalo_horas` estiver preenchido e a correção alterar o horário
mais cedo, recalcular a grade inteira via `calcularHorariosPorIntervalo` a partir do novo início,
e remapear as quantidades. Quando não houver intervalo declarado, manter o remapeamento atual.

⚠️ Mecanicamente o remapeamento estava certo; o que se perdeu foi a **semântica** de que aqueles
horários eram derivados de um intervalo, não escolhidos um a um.

### 4.2 BUG-99 — `forma_farmaceutica` aceita palpite incompatível com `unidade_dose`

**Evidência:** Claritin gravado com `unidade_dose = 'ml'` e `forma_farmaceutica = 'comprimido'`.
O palpite de `sugerirFormaFarmaceutica` foi aceito sem checagem de coerência.

**Correção:** o palpite só é aceito se compatível com a unidade já resolvida:

```js
const FORMAS_COMPATIVEIS = {
    unidade: ['comprimido', 'capsula', 'pomada', 'injetavel'],
    gota:    ['colirio', 'gotas'],
    ml:      ['xarope', 'colirio', 'gotas']
};
// Palpite incompatível é DESCARTADO (vira null) — nunca corrigido para outra forma.
// derivarFormaFarmaceutica cai então no rótulo genérico, que nunca mente.
```

⚠️ Aplicar a checagem **sobre o palpite**, nunca sobre `forma_explicita`. Se o usuário disse
"comprimido" e a unidade ficou `ml`, quem está errado é a unidade — descartar a fala do usuário
seria pior. Nesse caso, manter o que ele disse e registrar degradação para investigação.

---

## 5. MH-80 — aproveitar os dados dados na primeira mensagem

**Evidência:** 16:16:00, o usuário escreveu *"Quero cadastrar o xarope expec, vou tomar 5ml as
17hrs, tenho 1 vidro de 100ml"*. Só o nome foi aproveitado; horário, quantidade, unidade e
estoque foram todos reperguntados.

É a mesma lógica de salto que já existe em `cad_horarios` (`posologia_completa` pula
`cad_quantidade_por_dose`), ausente em `cad_nome`.

### Desenho

Classificador único, executado **apenas** em `cad_nome` e **apenas** quando a mensagem tiver
indício de conteúdo além do nome (contém dígito **ou** mais de 6 palavras) — evita uma chamada
extra em "Claritin".

```js
extrairCadastroCompleto({ message, historicoConversa })
// → { nome, dosagem, pares:[{horario,quantidade}], unidadeDose, formaExplicita,
//     estoqueQuantidade, frascos, volumeFrasco, tipoTratamento, tratamentoDias }
//   todos os campos independentes, null quando ausentes
```

Regras obrigatórias no prompt:
- **Só extrai o que está explícito na mensagem.** Campo ausente → `null`. Nunca inferir dosagem
  do nome, nem quantidade do estoque, nem forma do nome.
- Reaproveitar as regras já validadas do `classificarPosologia`: "às" indica horário e não
  quantidade; multiplicador de aplicação ("em cada olho") já multiplicado; mg/% é concentração.

Depois da extração, o código preenche o contexto e **salta para a primeira etapa faltante**, na
ordem canônica: `cad_dosagem` → `cad_horarios` → `cad_quantidade_por_dose` → `cad_confirma_forma`
→ `cad_tipo_tratamento` → `cad_estoque`/`cad_estoque_volume` → `cad_confirmacao`.

⚠️ **A verificação de duplicata (`nomeRecemColetado`) continua rodando normalmente** — o salto
não pode contorná-la.

⚠️ **Nenhum campo extraído aqui escapa das validações determinísticas existentes.** Os pares
passam pela mesma validação de `validarClassificacaoPosologia`; o estoque, pela regra (b) da
seção 3.3.

⚠️ Se a extração falhar (`degradar()`), o fluxo segue exatamente como hoje — pergunta a dosagem.
MH-80 é aceleração, nunca caminho obrigatório.

---

## 6. Observabilidade

Entradas novas em `observabilidade.js`:

```
'cadastro:classificador_estoque_falhou'        → severidade: alta
'cadastro:extracao_cadastro_completo_falhou'   → severidade: baixa
'cadastro:palpite_forma_incompativel'          → severidade: baixa
'cadastro:forma_explicita_incompativel'        → severidade: media
```

A terceira registra descarte de palpite (esperado, informativo). A quarta é o caso da seção 4.2
em que o **usuário** disse uma forma incompatível com a unidade — indica que a unidade pode ter
sido mal classificada, e vale investigar.

⚠️ `cadastro:salvamento_com_estado_incompleto` (crítica, já existe da B.2) **precisa passar a
cobrir estoque nulo por falha de extração** — hoje ele checa `estoque_resolvido === null`, e
com `parseInt || 0` o valor nunca era nulo, então **nunca disparou** nos casos lipitor e diovan.
Com a regra (b), passa a disparar. Confirmar que continua checando `null` e não `falsy` (`0` é
válido).

---

## 7. Checklist de verificação

```bash
# 1. Nenhum parse ingênuo de estoque sobrou
grep -n "parseInt(message)" src/agentes/cadastro.js
# esperado: nenhuma linha

# 2. Zero nunca é fallback de falha
grep -n "|| 0" src/agentes/cadastro.js
# esperado: nenhuma ocorrência em caminho de extração de estoque/quantidade

# 3. Funções de decisão cobrem todas as categorias do classificador
grep -n "categoria === \|case 'posologia_completa'\|case 'horarios_apenas'\|case 'quantidade_apenas'\|case 'frequencia_intervalo'" src/agentes/cadastro.js
# esperado: decidirCadConfirmaForma e corrigirPosologiaEmConfirmacao tratam as 4

# 4. Coerência forma × unidade
grep -n "FORMAS_COMPATIVEIS" src/agentes/cadastro.js
# esperado: aplicado sobre o palpite, não sobre forma_explicita

# 5. Sintaxe
node --check src/agentes/cadastro.js && node --check src/observabilidade.js
```

---

## 8. Cenários de validação

### Não-regressão da B/B.2 (executar primeiro — se falharem, parar)

1. Sólido simples, resposta em número puro ("30") → estoque 30.
2. Colírio "2 gotas em cada olho" → `quantidade_por_dose = 4`, baixa de 0.2ml na confirmação.
3. Frasco lacrado em dois turnos e em turno único → `frascos × volume`.
4. Posologia variável ("1 cp às 7 e 2 cps às 21") → schedules 1 e 2.
5. Cadastro concluído → `conversation_state.state = 'idle'` no mesmo turno.

### BUG-97 — estoque

6. **Reprodução do diovan:** sólido, responder "Tenho 30 cps" → ✅ `estoque_atual = 30`.
7. **Reprodução do lipitor:** responder "Caixa com 60" → ✅ `estoque_atual = 60`.
8. "2 caixas de 30" → ✅ `60`. "3 cartelas de 10" → ✅ `30`.
9. **Zero legítimo:** "não tenho nenhum ainda" → ✅ grava `0`, exibe alerta, **não repergunta**.
10. **Indeterminado:** "tenho bastante" → ✅ repergunta; **não grava 0**.
11. Conferir `system_events`: nenhum `salvamento_com_estado_incompleto` nos cenários 6-9.

### BUG-95 / BUG-96 / BUG-98 — correções de posologia

12. **Reprodução exata do Claritin:** "de 8 em 8hrs" → "às 6hrs" → "5ml" → na confirmação de
    forma responder *"na vdd vai começar às 16hrs"* → ✅ os horários mudam para 16:00/00:00/08:00
    (BUG-95 + BUG-98) e a quantidade 5ml é preservada.
13. No resumo final, corrigir *"de 8 em 8hrs começando às 16hrs"* → ✅ 16:00/00:00/08:00
    (BUG-96).
14. Corrigir só um horário em posologia **sem** intervalo declarado ("tomo às 8 e às 20" →
    "o primeiro é às 9") → ✅ 09:00 e 20:00, quantidades preservadas.
15. Corrigir aumentando o número de horários (2 → 3) → ✅ repergunta a quantidade.

### BUG-94 — mensagem nunca afirma o que não está no estado

16. Em **todos** os cenários acima: toda vez que a Nami citar horário, quantidade ou estoque,
    conferir contra `conversation_state.context` ou `medications`/`schedules`. ✅ Zero divergências.
17. Responder algo incompreensível na confirmação ("hmmm") → ✅ a Nami reformula com acolhimento
    e **sem citar números**.

### BUG-99 — coerência forma × unidade

18. Cadastrar "Claritin" com "5ml" → ✅ `unidade_dose = 'ml'` e `forma_farmaceutica` **não** é
    "comprimido" (esperado: "xarope" ou o genérico "líquido").
19. Cadastrar comprimido dizendo "2 por vez" → ✅ confirmação propõe "2 comprimidos" e a forma
    gravada é compatível.

### MH-80 — primeira mensagem completa

20. **Reprodução do expec:** *"Quero cadastrar o xarope expec, vou tomar 5ml as 17hrs, tenho 1
    vidro de 100ml"* → ✅ a Nami pergunta **apenas** dosagem e tipo de tratamento; horário,
    quantidade e estoque não são reperguntados.
21. *"Quero cadastrar o Claritin"* (só o nome) → ✅ fluxo idêntico ao de hoje, sem chamada extra.
22. Mensagem completa de um medicamento **já cadastrado e ativo** → ✅ detecção de duplicata
    dispara normalmente, antes de qualquer salto.

---

## 9. Escritas em `backlog_items`

Via `src/backlog.js` (princípio 16), autorizadas por Guilherme nesta sessão:

**INSERT**
- `BUG-94` — *"Mensagem do cadastro afirma posologia/estoque ausentes do estado — geração livre em caminhos sem renderização em código"* — `alta`
- `BUG-95` — *"decidirCadConfirmaForma descarta correção de horários e de frequência"* — `alta`
- `BUG-96` — *"corrigirPosologiaEmConfirmacao não trata correção por intervalo"* — `alta`
- `BUG-97` — *"REGRESSÃO (Parte B): estoque sólido perde o número quando informado em frase natural"* — `critica`
- `BUG-98` — *"Correção do primeiro horário não recalcula a grade quando há intervalo declarado"* — `media`
- `BUG-99` — *"forma_farmaceutica aceita palpite incompatível com unidade_dose"* — `media`
- `MH-80` — *"Aproveitar dados completos informados na primeira mensagem do cadastro"* — `media`, `relacionado: 'MH-073'`
- `MH-073 parte B.3` — este briefing — `alta`

**UPDATE**
- `MH-073 parte B.3` → `em_validacao` ao fim da implementação.
- ⚠️ **Nenhum item vai para `resolvido` antes da validação em produção.**