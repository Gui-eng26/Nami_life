# BRIEFING — MH-073 Parte B: cadastro de medicamento com unidade de dose e posologia

**Sessão:** v34 · **Data:** 19/08/2026
**Item de backlog:** MH-073, parte B — *"Cadastro de medicamento liquido — frasco lacrado (caso exato)"*
**Depende de:** MH-073 Parte A (entregue na v33, migration `20260819000000_mh073_parteA_unidades_dose.sql`)
**Arquivos tocados:** `src/agentes/cadastro.js`, `src/database.js`, `src/observabilidade.js`
**Migration nova:** nenhuma. Toda a estrutura de banco já existe desde a Parte A.

---

## 1. Contexto — por que esta parte existe

A Parte A quebrou a equação implícita `1 schedule = 1 dose = 1 unidade de estoque` no
**núcleo de cálculo**: criou `schedules.quantidade_por_dose`, `medications.unidade_dose` /
`unidade_estoque` / `gotas_por_ml`, `dose_logs.schedule_id` e os helpers determinísticos
(`resolverQuantidadePorDose`, `converterDoseParaEstoque`, `calcularDeltaEstoqueDaDose`,
`calcularConsumoDiario`).

**Nada disso é alimentado pela conversa hoje.** Verificado em código:

- `saveMedication` (`database.js:110`) **não recebe** `unidade_dose`, `unidade_estoque` nem
  `gotas_por_ml` — todo cadastro novo nasce nos DEFAULT (`unidade`/`unidade`/20).
- `saveSchedule` (`database.js:305`) **recebe** `quantidadePorDose` (default 1), mas o único
  chamador no fluxo de cadastro (`cadastro.js:364`) **nunca passa o parâmetro** — todo horário
  novo nasce com quantidade 1.

Ou seja: o motor está pronto e o tanque está vazio. A Parte B é a coleta.

Consequência prática: **um medicamento líquido é hoje impossível de cadastrar corretamente**, e
um sólido de 2 comprimidos por dose continua debitando 1 por dose — o defeito de
subcontabilização de 50% que a Parte A diagnosticou no Ômega 3 se repetiria em todo cadastro
novo.

---

## 2. Decisões de arquitetura desta sessão (todas confirmadas por Guilherme)

### 2.1 A etapa `cad_forma` é REMOVIDA

`forma_farmaceutica` não governa comportamento nenhum (princípio 45 — verificado: lida em um
único ponto, `relatorios.js:336`, apenas para compor texto). Perguntá-la separadamente gasta um
turno com vocabulário de farmacêutico, e o público-alvo é idoso.

A unidade passa a ser **derivada da resposta sobre quanto se toma por vez** — pergunta que a
pessoa responde sem esforço ("20 gotas", "2 comprimidos") e cuja resposta natural já carrega a
unidade.

### 2.2 A inferência de forma NUNCA entra na pergunta — só na confirmação

Regra estrutural desta sessão. Muitos medicamentos existem em mais de uma apresentação
(dipirona: comprimido, gotas, xarope). Se a Nami inferir a forma pelo nome e perguntar *"quantos
comprimidos você toma?"*, ela **induz a resposta** de quem usa gotas — e o erro deixa de ser
cosmético e contamina `unidade_dose`, que é chave de comportamento.

Na confirmação, a mesma inferência é segura: é submetida ao usuário, que corrige.

> **Na pergunta, a inferência molda a resposta. Na confirmação, ela é submetida ao usuário.**

Não existe base de medicamentos no projeto (RAG sobre bulário da ANVISA foi avaliado e
descartado na v33). Qualquer inferência de forma vem de memória do LLM, sem verificação — por
isso ela só pode viver onde o usuário a valida.

### 2.3 `forma_farmaceutica` nunca é NULL — rótulo genérico derivado da unidade

⚠️ **Armadilha identificada nesta sessão.** `saveMedication` (`database.js:140`) faz
`forma_farmaceutica: forma || 'comprimido'` e `relatorios.js:336` repete o mesmo fallback na
leitura. Com a forma virando subproduto opcional, um **colírio cadastrado sem forma explícita
seria gravado e exibido como "comprimido"** — afirmação falsa ao usuário.

Decisão: quando a forma não for explicitada nem confirmada, gravar rótulo genérico derivado de
`unidade_dose`:

| `unidade_dose` | rótulo genérico |
|---|---|
| `unidade` | `unidade` |
| `gota` | `gotas` |
| `ml` | `líquido` |

Nunca afirma forma falsa, mantém a coluna sempre preenchida, e não deixa dívida para a Parte D.

### 2.4 Posologia variável por horário é ACEITA quando o usuário a expressar

`schedules.quantidade_por_dose` já é por linha desde a Parte A — o schema suporta "2 de manhã e
1 à noite" sem alteração. A Parte B passa a gravar isso quando o usuário expressar
espontaneamente, sem criar pergunta extra para quem não precisa.

### 2.5 Salto de etapa quando a resposta já traz tudo

Mesmo padrão do MH-072 (`extrairComponenteData` reconhece data completa na pergunta do dia): se
na pergunta de horários o usuário responder *"tomo 2 cps às 8 e 1 cp às 20"*, a posologia está
completa e a etapa de quantidade **não é perguntada**.

### 2.6 O que fica FORA desta parte

| Fora | Onde vai |
|---|---|
| Blindagem de becos sem saída no `cadastro.js` (escalada ao roteador) | **Parte B.1** — briefing separado |
| Frasco já aberto / estimativa por frações | Parte C |
| ~34 pontos de texto com "unidades"/"comprimidos" hardcoded | Parte D |
| Recompra de frasco lacrado, revisão de `estoque_minimo` | Parte E |

**Por que B.1 é separada:** `cadastro.js` não tem escalada nenhuma hoje (verificado: `handleCadastro`
nunca retorna `{escalarParaRoteador:true}`, e o `router.js` o chama de **8 pontos** — linhas 549,
715, 786, 873, 965, 978, 990, 1046). Instrumentar isso é o trabalho que a v18 fez no
`configuracao.js`, com o risco conhecido do BUG-069 (1 de 6 call sites esquecido) e exigindo ponto
único de despacho (princípio 30). São riscos de regressão de natureza diferente dos desta parte
(schema/persistência × roteamento) — misturar torna impossível saber qual causou um defeito na
validação.

---

## 3. O fluxo novo — o que o usuário vê

### 3.1 Sequência de etapas

| # | Etapa | Muda? |
|---|---|---|
| 1 | `cad_nome` | não |
| 2 | `cad_dosagem` | só o texto (rótulo) |
| 3 | `cad_horarios` | **classificador novo + salto de etapa** |
| 4 | `cad_quantidade_por_dose` | **NOVA** |
| 5 | `cad_confirma_forma` | **NOVA (condicional)** |
| 6 | `cad_tipo_tratamento` | **muda de posição** (era antes dos horários) |
| 7 | `cad_estoque` | **ramifica por `unidade_estoque`** |
| 8 | `cad_estoque_volume` | **NOVA (condicional, só líquido)** |
| 9 | `cad_confirmacao` | resumo passa a incluir posologia e unidade |
| — | ~~`cad_forma`~~ | **REMOVIDA** |

Agrupamento conceitual explícito para o usuário: etapas 1–2 são **o MEDICAMENTO**;
etapas 3–5 são a **FORMA DE USO**.

### 3.2 Regras de texto obrigatórias em TODA pergunta após `cad_nome`

Estas duas regras são **fixas no prompt, nunca sugestão** — mesma decisão tomada no MH-072 Parte
B para `**DIA**`/`**MÊS**`/`**ANO**`, pelo mesmo motivo: no WhatsApp o negrito é o único recurso
tipográfico disponível, e para o público-alvo idoso ele separa "o que estão me pedindo agora" do
resto da frase.

1. **O nome do medicamento aparece na pergunta.** Nunca "qual a dosagem?", sempre "qual a
   dosagem do Losartana?". Comportamento que já existe hoje e **não pode regredir**.
2. **O rótulo do dado pedido vem em NEGRITO e MAIÚSCULA:** `**NOME**`, `**DOSAGEM**`,
   `**HORÁRIOS**`, `**QUANTO**`, `**CONTÍNUO**`/`**TEMPORÁRIO**`, `**FRASCOS**`, `**VOLUME**`.

### 3.3 Texto de referência de cada etapa

Estes textos são **referência de conteúdo e tom**, não template literal — a geração continua
livre (só dado de saúde usa template determinístico, princípios 13/28). As regras da seção 3.2 e
os rótulos em negrito, essas sim, são obrigatórias.

**`cad_nome`**
> Vamos cadastrar seu **MEDICAMENTO**! Qual o **NOME** dele?

**`cad_dosagem`**
> Ótimo! Agora a **DOSAGEM** do {nome} — geralmente vem no rótulo (ex: 50mg, 0,5%, 100mg/ml).

**`cad_horarios`**
> Agora vamos à **FORMA DE USO**. Em quais **HORÁRIOS** você toma ou usa o {nome}?

⚠️ O verbo é **"toma ou usa"**, nunca só "toma" — pomada e colírio não são ingeridos.
Vale para todas as etapas de forma de uso.

**`cad_quantidade_por_dose`**
> Ainda sobre a **FORMA DE USO**: **QUANTO** de {nome} você toma ou usa em cada horário?
> (ex: 2 comprimidos, 1 cápsula, 20 gotas, 5ml)

**`cad_tipo_tratamento`**
> O {nome} é de uso **CONTÍNUO** (sem previsão de parada) ou **TEMPORÁRIO**, com prazo definido —
> como um antibiótico ou anti-inflamatório?

**`cad_estoque`** — sólido (`unidade_estoque = 'unidade'`)
> Quantas unidades de {nome} você tem agora?

**`cad_estoque`** — líquido (`unidade_estoque = 'ml'`)
> Quantos **FRASCOS** fechados de {nome} você tem agora?

**`cad_estoque_volume`** — só líquido
> E qual o **VOLUME** de cada frasco, em ml? (está no rótulo — ex: 10ml, 100ml)

⚠️ A palavra **"fechados"** é obrigatória na pergunta de frascos. Frasco já aberto é escopo da
Parte C e não pode ser silenciosamente tratado como cheio.

---

## 4. `classificarPosologia` — o classificador único

### 4.1 Por que um só classificador para duas etapas

Horário e quantidade são **o mesmo fato de posologia**, expresso junto na fala natural
("2 comprimidos às 8h"). Dois classificadores separados permitiriam estados incoerentes e
impediriam o salto de etapa da seção 2.5.

A forma segue o `extrairComponenteData` do MH-072: a pergunta que o código faz é **"o que é
isso?"**, nunca **"isso serve para o campo que eu esperava?"** — evitando a falácia
formato-≠-pertencimento (BUG-030, BUG-086).

### 4.2 Onde roda

Em `handleCadastro`, **antes** de `buildSystemPrompt`/`callClaude`, quando
`etapaAtual === 'cad_horarios'` ou `etapaAtual === 'cad_quantidade_por_dose'`.

Este é o mesmo lugar arquitetural onde o pré-cálculo de `alerta_estoque_baixo` já roda hoje
(`cadastro.js:409-431`): decide primeiro em código, injeta a decisão no `context`, e o LLM de
geração só fraseia o que já foi decidido. **Não é padrão novo para o arquivo.**

### 4.3 Assinatura

```js
export async function classificarPosologia({
    message,
    campoEsperado,        // 'horarios' | 'quantidade'
    nomeMedicamento,
    horariosJaColetados,  // array de "HH:MM" — presente quando campoEsperado='quantidade'
    historicoConversa
})
```

### 4.4 Contrato de retorno

```js
{
  categoria: 'posologia_completa' | 'horarios_apenas' | 'quantidade_apenas'
           | 'frequencia_intervalo' | 'indeterminado',
  pares: [{ horario: 'HH:MM', quantidade: <number> }],  // [] quando não aplicável
  quantidadeUnica: <number> | null,     // categoria='quantidade_apenas'
  intervaloHoras: <number> | null,      // categoria='frequencia_intervalo'
  horarioInicio: 'HH:MM' | null,        // categoria='frequencia_intervalo'
  unidadeDose: 'unidade' | 'gota' | 'ml' | null,
  formaExplicita: 'comprimido'|'capsula'|'colirio'|'gotas'|'pomada'|'injetavel'|'xarope' | null,
  multiplicadorAplicado: <boolean>
}
```

### 4.5 System prompt — TEXTO LITERAL

```
Você é um classificador de posologia para uma assistente de saúde via WhatsApp (a Nami), que
ajuda pessoas a tomarem seus medicamentos corretamente.

A Nami está cadastrando o medicamento "{nomeMedicamento}" e perguntou sobre {campoEsperadoTexto}.
Sua tarefa é extrair da mensagem TUDO o que ela contiver sobre a posologia — mesmo o que não foi
perguntado.

CATEGORIAS (escolha exatamente UMA):

- posologia_completa: a mensagem traz horário(s) E quantidade(s). Ex: "2 comprimidos às 8 e 1 às
  20", "20 gotas de manhã", "5ml às 7h e às 19h".
- horarios_apenas: só horários, sem quantidade. Ex: "às 8 e às 20", "de manhã e à noite",
  "8h, 14h e 22h".
- quantidade_apenas: só quantidade, sem horário. Ex: "2 comprimidos", "20 gotas", "5ml", "2 por
  vez", "duas".
- frequencia_intervalo: frequência regular sem horários explícitos. Ex: "de 8 em 8 horas",
  "3 vezes ao dia", "12/12h".
- indeterminado: nada de posologia foi dito, ou a resposta é confusa, ou fora de contexto.

REGRA 1 — HORÁRIO NÃO É QUANTIDADE (crítica).
Números precedidos de "às", "as", "ás" são HORÁRIOS, nunca quantidades.
  "tomo às 8"        -> horarios_apenas, horário 08:00. NÃO é quantidade 8.
  "tomo 2 às 8"      -> posologia_completa, quantidade 2, horário 08:00.
  "tomo 8"           -> quantidade_apenas, quantidade 8 (sem preposição de hora).
Expressões de período viram horário convencional: "de manhã" -> 07:00, "à tarde" -> 14:00,
"à noite" -> 21:00, "meio-dia" -> 12:00, "antes de dormir" -> 22:00.
Horários sempre no formato 24h "HH:MM". "8 da noite" -> "20:00".

REGRA 2 — MULTIPLICADOR DE APLICAÇÃO (crítica).
Quando a dose é aplicada em mais de um sítio, a quantidade devolvida é a dose TOTAL por horário,
já multiplicada — nunca a quantidade por sítio.
  "2 gotas em cada olho"      -> quantidade 4, multiplicador_aplicado: true
  "1 gota em cada narina"     -> quantidade 2, multiplicador_aplicado: true
  "3 gotas no olho direito"   -> quantidade 3, multiplicador_aplicado: false
  "2 gotas nos dois ouvidos"  -> quantidade 4, multiplicador_aplicado: true
Em qualquer outro caso, multiplicador_aplicado: false.

REGRA 3 — UNIDADE DA DOSE.
Derive unidade_dose do que a pessoa disse:
  comprimido, cápsula, cápsulas, cp, cps, drágea, pastilha, sachê, tubo, ampola, adesivo,
  aplicação, "por vez", "unidade"  -> unidade
  gota, gotas, gts                                                          -> gota
  ml, mL, mililitro, "medida", "colher de chá" (=5ml), "colher de sopa" (=15ml) -> ml
Colher vira ml com a quantidade convertida: "1 colher de chá" -> quantidade 5, unidade ml.
Se a pessoa não indicar unidade nenhuma ("2 por vez", "duas"), unidade_dose = "unidade" e
forma_explicita = null.

REGRA 4 — FORMA EXPLÍCITA.
forma_explicita só é preenchida quando a pessoa NOMEOU a forma. NUNCA infira pelo nome do
medicamento nem pela unidade.
  "2 comprimidos"  -> comprimido
  "20 gotas"       -> gotas
  "5ml de xarope"  -> xarope
  "2 por vez"      -> null
  "20 gotas no olho" -> colirio
Valores permitidos: comprimido, capsula, colirio, gotas, pomada, injetavel, xarope, null.

REGRA 5 — CONCENTRAÇÃO NÃO É QUANTIDADE.
Resposta em mg, mcg, g, % ou mg/ml é DOSAGEM (concentração do remédio), não quantidade por dose.
  "50mg"  -> indeterminado
  "0,5%"  -> indeterminado
Exceção: "5ml" É quantidade (volume administrado, não concentração).

REGRA 6 — NÚMEROS POR EXTENSO contam normalmente: "duas gotas" -> 2, "meio comprimido" -> 0.5.

CONVERSA RECENTE:
{historicoTexto}

HORÁRIOS JÁ COLETADOS: {horariosJaColetados ou "nenhum"}

MENSAGEM ATUAL: "{message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{
  "categoria": "...",
  "pares": [{"horario": "HH:MM", "quantidade": 0}],
  "quantidade_unica": null,
  "intervalo_horas": null,
  "horario_inicio": null,
  "unidade_dose": null,
  "forma_explicita": null,
  "multiplicador_aplicado": false
}
```

Onde `{campoEsperadoTexto}` é `"em quais horários a pessoa toma ou usa o medicamento"` quando
`campoEsperado === 'horarios'`, e `"quanto a pessoa toma ou usa em cada horário"` quando
`campoEsperado === 'quantidade'`.

### 4.6 Parse e degradação

- `max_tokens: 400`.
- **Extrator tolerante de JSON obrigatório** (princípio 27): remover cercas markdown e isolar o
  primeiro objeto, exatamente como `parseJulgamento` em `juizOffline.js`. Este classificador
  devolve JSON estruturado, não uma palavra — é o formato que já causou 29% de descarte
  silencioso na v25 (C-3).
- Falha de API ou de parse → `degradar()` com `fallback: { categoria: 'indeterminado', ... }`.
  **Nunca** uma quantidade ou unidade chutada: `unidade_dose` tem CHECK no schema e
  `quantidade_por_dose` é aritmética de saúde.
- Validação determinística **após** o parse, em código:
  - `categoria` fora do conjunto → `indeterminado`;
  - `unidade_dose` fora de `{unidade, gota, ml}` → `null` (e a etapa reperunta);
  - `quantidade <= 0` ou não numérica → descarta o par;
  - `horario` fora de `/^\d{2}:\d{2}$/` ou hora > 23 / minuto > 59 → descarta o par;
  - se todos os pares forem descartados → `indeterminado`.

### 4.7 Entrada nova em `observabilidade.js` — catálogo `DEGRADACOES`

```
'cadastro:classificador_posologia_falhou'  → severidade: media
```

Justificativa (princípio 29, corolário): a degradação devolve `indeterminado`, que faz a etapa
repetir a pergunta. Do ponto de vista do `agent_logs`, é uma interação saudável — invisível sem
instrumentação explícita.

---

## 5. Derivação determinística em código

**Nenhuma destas três funções chama LLM.** Ficam em `cadastro.js`, junto de
`calcularHorariosPorIntervalo`.

### 5.1 `derivarUnidades(unidadeDose)`

```js
// unidade_dose é chave de comportamento (princípio 45) e tem CHECK no schema.
// Esta tabela é a ÚNICA fonte das outras duas colunas — nenhuma combinação
// inválida é representável, então os CHECKs de coerência da Parte A
// (medications_coerencia_unidades_check, medications_gotas_por_ml_exigido_check)
// são satisfeitos por construção, não por sorte.
function derivarUnidades(unidadeDose) {
    switch (unidadeDose) {
        case 'gota': return { unidade_dose: 'gota', unidade_estoque: 'ml',      gotas_por_ml: 20 };
        case 'ml':   return { unidade_dose: 'ml',   unidade_estoque: 'ml',      gotas_por_ml: null };
        default:     return { unidade_dose: 'unidade', unidade_estoque: 'unidade', gotas_por_ml: null };
    }
}
```

⚠️ **`gotas_por_ml = 20` é convenção, e o fluxo não tem momento de edição.** Decisão da Parte A
("convenção + campo editável"), mantida aqui: perguntar *"quantas gotas tem 1 ml do seu
remédio?"* seria absurdo para o público-alvo. O campo permanece editável no banco; a interface de
edição fica para quando houver demanda real. Registrado explicitamente para não parecer omissão.

### 5.2 `derivarFormaFarmaceutica(formaExplicita, formaConfirmada, unidadeDose)`

```js
// Ordem de confiança (princípio 17): o que o usuário disse literalmente >
// o que ele confirmou quando perguntado > rótulo genérico derivado da unidade.
// NUNCA retorna null e NUNCA retorna 'comprimido' por default — ver seção 2.3.
const ROTULO_CANONICO = {
    comprimido: 'comprimido', capsula: 'cápsula',   colirio: 'colírio',
    gotas: 'gotas',           pomada: 'pomada',     injetavel: 'injetável',
    xarope: 'xarope'
};
const ROTULO_GENERICO = { unidade: 'unidade', gota: 'gotas', ml: 'líquido' };

function derivarFormaFarmaceutica(formaExplicita, formaConfirmada, unidadeDose) {
    return ROTULO_CANONICO[formaExplicita]
        ?? ROTULO_CANONICO[formaConfirmada]
        ?? ROTULO_GENERICO[unidadeDose]
        ?? 'unidade';
}
```

Efeito colateral positivo: a deriva de `forma_farmaceutica` registrada no princípio 45
(`cápsula`/`capsula`/`efervescente`) é fechada de brinde — a string gravada passa a vir sempre
desta tabela, nunca da normalização livre do LLM.

### 5.3 `montarParesPosologia(horarios, quantidadePorHorario)`

Recebe a lista de horários e ou (a) uma quantidade única aplicada a todos, ou (b) o mapa de
quantidades por horário vindo de `posologia_completa`. Devolve sempre
`[{horario, quantidade}]` ordenado por horário, sem duplicatas de horário.

⚠️ **`normalizarHorario` (`configuracao.js:215`) NÃO é reaproveitável aqui.** Ela resolve horário
casando contra `schedulesDisponiveis` — schedules que já existem. No cadastro eles ainda não
existem. Os contratos são diferentes (casar contra lista conhecida × extrair do zero), então isto
**não** é a duplicação que o princípio 30 condena. Registrado para não parecer descuido em revisão
futura.

---

## 6. Máquina de etapas — comportamento detalhado

### 6.1 `cad_horarios`

1. Roda `classificarPosologia({ campoEsperado: 'horarios' })`.
2. Decide em código:

| categoria | ação | próxima etapa |
|---|---|---|
| `posologia_completa` | grava `pares`, `unidadeDose`, `formaExplicita` no context | **pula para `cad_confirma_forma`** (ou `cad_tipo_tratamento`, ver 6.3) |
| `horarios_apenas` | grava horários no context | `cad_quantidade_por_dose` |
| `frequencia_intervalo` com `horarioInicio` | calcula horários via `calcularHorariosPorIntervalo` (BUG-041, **preservado**) | `cad_quantidade_por_dose` |
| `frequencia_intervalo` sem `horarioInicio` | grava `intervaloHoras` | permanece em `cad_horarios`, pergunta o horário da primeira dose |
| `quantidade_apenas` | grava a quantidade | permanece em `cad_horarios`, reperunta os horários (a quantidade já está guardada e **não será perguntada de novo**) |
| `indeterminado` | — | permanece em `cad_horarios`, reformula a pergunta |

3. O LLM de geração recebe no context o que foi extraído e **só fraseia** — nunca decide horário
   nem quantidade.

⚠️ **O cálculo determinístico do BUG-041 não pode ser removido nem substituído pelo
classificador.** Ele continua sendo a única fonte de horários quando há intervalo + início
(princípio 4).

### 6.2 `cad_quantidade_por_dose`

Roda `classificarPosologia({ campoEsperado: 'quantidade', horariosJaColetados })`.

| categoria | ação | próxima etapa |
|---|---|---|
| `quantidade_apenas` | aplica a quantidade a **todos** os horários | `cad_confirma_forma` / `cad_tipo_tratamento` |
| `posologia_completa` | usa os pares (o usuário deu quantidade por horário aqui) | idem |
| `horarios_apenas` | **corrigiu os horários** — substitui os horários coletados | permanece, pergunta a quantidade |
| `indeterminado` | — | permanece, reformula |

Quando `indeterminado` **e a mensagem contém mg/%/mg/ml**, a reformulação deve distinguir
explicitamente concentração de quantidade — é a confusão prevista entre `cad_dosagem` e esta
etapa:

> "Essa é a dosagem do remédio (a concentração). O que eu preciso saber agora é **QUANTO** você
> toma de cada vez — por exemplo, 1 comprimido, 2 comprimidos, 20 gotas."

### 6.3 `cad_confirma_forma` — condicional

**Só roda quando `formaExplicita === null`.** Se o usuário nomeou a forma, esta etapa é pulada
inteira e o fluxo segue para `cad_tipo_tratamento`.

A Nami propõe, usando o nome do medicamento como palpite (única inferência permitida, seção 2.2),
e **expõe a distribuição por horário**:

> "{Nome}, só confirmando: **2 comprimidos** às 08:00 e **2 comprimidos** às 20:00?"

⚠️ O bloco de horários e quantidades da pergunta é **renderizado em código e inserido
literalmente** — o LLM escreve só a moldura em volta (princípio 28). Horário e quantidade são
dado de saúde.

Classificação da resposta (reusa o mesmo `classificarPosologia` com `campoEsperado: 'quantidade'`,
mais checagem determinística de confirmação simples):

| resposta | ação |
|---|---|
| confirma ("sim", "isso") | grava a forma sugerida, avança |
| corrige a forma ("é cápsula") | `formaExplicita` da nova classificação, avança |
| corrige a quantidade ("2 de manhã e 1 à noite") | grava **pares variáveis**, avança |
| qualquer outra coisa | **avança mesmo assim**, com rótulo genérico (seção 2.3) |

⚠️ **Esta etapa NUNCA bloqueia.** Forma é cosmética (princípio 45); travar o cadastro por ela
seria desproporcional. Não existe contador de tentativas aqui — o laço não pode girar sem o
usuário e ele já respondeu (princípio 42).

### 6.4 `cad_tipo_tratamento`

Sem mudança de lógica. Só muda de posição (passa a vir depois da posologia) e ganha o rótulo em
negrito + nome do medicamento.

### 6.5 `cad_estoque` / `cad_estoque_volume`

Ramifica por `unidade_estoque`, que **já está resolvido** neste ponto do fluxo (veio da unidade
da dose, três etapas antes).

- **`unidade`** → exatamente como hoje: um número. `estoque = parseInt(message)`.
- **`ml`** → dois turnos:
  1. `cad_estoque` pergunta **FRASCOS fechados** → guarda `frascos`;
  2. `cad_estoque_volume` pergunta **VOLUME em ml** → guarda `volumeFrasco`;
  3. `estoque = frascos * volumeFrasco`, **calculado em código** (princípio 4 — nunca pelo LLM).

Se em qualquer um dos dois turnos a resposta não for numérica, a etapa reperunta. Se o usuário
responder os dois de uma vez ("2 frascos de 10ml"), aceite e pule `cad_estoque_volume` — mesmo
princípio de salto da seção 2.5.

### 6.6 `cad_confirmacao`

O resumo passa a incluir posologia e unidade correta. **Bloco factual renderizado em código**
(princípio 28) — o LLM escreve só abertura e fechamento:

```
💊 Remédio: {nome}
📏 Dosagem: {dosagem}
💉 Forma: {forma_farmaceutica}
⏰ Posologia:
   • 08:00 — 2 comprimidos
   • 20:00 — 1 comprimido
🔄 Tratamento: {contínuo | X dias}
📦 Estoque: {estoque} {unidade_estoque}
```

Para líquido em frasco, a linha de estoque exibe também a origem do cálculo:
`📦 Estoque: 20 ml (2 frascos de 10ml)`.

A lista de expressões de confirmação/correção que hoje vive no prompt (`cadastro.js:235-244`)
**permanece como está nesta parte** — é geração de texto, não decisão de fluxo crítica, e mexer
nela sem necessidade abriria risco de regressão. Fica no radar da Parte B.1.

---

## 7. Correção de bug incluída nesta parte

### `cadastro.js:409-431` — pré-cálculo de `alerta_estoque_baixo` ignora `quantidade_por_dose`

**Causa raiz confirmada por leitura de código** (não hipótese). O bloco calcula:

```js
const dosesPerDia = context?.doses_por_dia || horarios.length || 1;
const diasRestantes = Math.floor(estoque / dosesPerDia);
```

Divide o estoque pelo **número de horários**, tratando 1 unidade por dose como universal. É a
mesma classe do BUG-065 (métrica derivada afirmando fato sobre a métrica bruta, princípio 19) e
da subcontabilização que a Parte A corrigiu — aqui na etapa de cadastro em vez da de confirmação.

Este bloco foi deixado **explicitamente fora da Parte A** por operar sobre contexto
pré-salvamento, sem `medication_id`. Com a posologia coletada antes do estoque, o dado agora
existe no `context`.

**Correção — reaproveitar a função existente, nunca reimplementar a conversão:**

```js
import { converterDoseParaEstoque } from '../database.js';

const pares = context?.pares_posologia || [];
const somaDoses = pares.reduce((acc, p) => acc + Number(p.quantidade), 0);
const consumoDiario = converterDoseParaEstoque({
    quantidade: somaDoses,
    unidade_dose: context?.unidade_dose,
    unidade_estoque: context?.unidade_estoque,
    gotas_por_ml: context?.gotas_por_ml
});
const diasRestantes = consumoDiario > 0 ? Math.floor(estoque / consumoDiario) : 0;
```

`converterDoseParaEstoque` é função pura já exportada de `database.js` (linha 427) e documentada
na Parte A como *"existe para que as Partes B–E não precisem tocar o núcleo"* — princípio 27.

⚠️ Os textos de aviso dos CASOS 1-5 (`cadastro.js:151-222`) dizem "comprimido(s)" literalmente.
**Não corrigir aqui** — são parte dos ~34 pontos da **Parte D**. O que muda nesta parte é só a
aritmética, não o texto.

---

## 8. Mudanças em `database.js`

### 8.1 `saveMedication` — aceitar as unidades

```js
export async function saveMedication({
    userId, nome, dosagem, instrucoes, estoque,
    forma, tipo_tratamento, tratamento_dias,
    unidade_dose = 'unidade',        // NOVO
    unidade_estoque = 'unidade',     // NOVO
    gotas_por_ml = null              // NOVO
}) {
```

No `.insert({...})`, acrescentar:
```js
    forma_farmaceutica: forma || 'unidade',   // era: forma || 'comprimido' — ver seção 2.3
    unidade_dose,
    unidade_estoque,
    gotas_por_ml: unidade_dose === 'gota' ? (gotas_por_ml ?? 20) : gotas_por_ml,
```

⚠️ O ternário de `gotas_por_ml` existe para satisfazer
`medications_gotas_por_ml_exigido_check` mesmo se o chamador esquecer — barreira redundante
proposital numa coluna com CHECK (princípio 41).

⚠️ A troca do default `'comprimido'` → `'unidade'` é a correção da armadilha da seção 2.3. Como
`derivarFormaFarmaceutica` nunca devolve `null`, este default nunca deveria ser alcançado — ele
é rede de segurança para chamadores futuros.

### 8.2 `relatorios.js:336` — remover o fallback falso

```js
const forma = med.forma_farmaceutica || 'unidade';   // era: || 'comprimido'
```

Único ponto de leitura de `forma_farmaceutica` no projeto (verificado por grep). Mudança de uma
palavra; sem ela, medicamentos anteriores à Parte B com forma nula continuariam exibindo
"comprimido".

### 8.3 `cadastro.js` — `processarAcao` grava os pares

O loop atual (`cadastro.js:358-366`) chama `saveSchedule({ medicationId, horario })` sem
quantidade. Passa a iterar sobre os pares:

```js
for (const par of action.pares) {
    await saveSchedule({
        medicationId: med.id,
        horario: par.horario,
        quantidadePorDose: par.quantidade
    });
}
```

O parâmetro `quantidadePorDose` **já existe** na assinatura de `saveSchedule` desde a Parte A
(`database.js:305`) e nunca foi usado pelo cadastro — nenhuma mudança necessária lá.

### 8.4 Contrato de `action` no prompt de `cad_salvo`

```json
{
  "type": "SAVE_MEDICATION",
  "nome": "",
  "forma": "",
  "dosagem": "",
  "tipo_tratamento": "continuo | temporario",
  "tratamento_dias": null,
  "pares": [{"horario": "HH:MM", "quantidade": 0}],
  "estoque": 0,
  "unidade_dose": "unidade | gota | ml",
  "unidade_estoque": "unidade | ml",
  "gotas_por_ml": null
}
```

⚠️ O campo `horarios` sai e entra `pares`. **Todos** os valores acima vêm do `context` já
resolvido deterministicamente — o prompt deve instruir explicitamente: *"copie os valores de
`pares`, `unidade_dose`, `unidade_estoque` e `gotas_por_ml` exatamente como estão no contexto;
nunca recalcule, nunca invente"* (princípio 38).

---

## 9. Pontos de código que a remoção de `cad_forma` quebra silenciosamente

⚠️ Os dois casos abaixo **não geram erro** — apenas param de funcionar. Ambos foram encontrados
por leitura de código nesta sessão.

### 9.1 `cadastro.js:455` — detecção de medicamento duplicado

```js
if (etapaAtual === 'cad_nome' && novoContext.nome && proximaEtapa === 'cad_forma') {
```

Com `cad_forma` extinta, a condição **nunca seria verdadeira** e toda a verificação de duplicata /
reencadastro / reativação (linhas 455-509) morreria em silêncio. Trocar para `'cad_dosagem'`.

### 9.2 `cadastro.js:390` — reencadastro após encerramento

```js
const systemPrompt = buildSystemPrompt('cad_forma', { nome: context.nome }, ...);
const proximaEtapa = claudeResponse.proximaEtapa || 'cad_forma';
```

Trocar as duas ocorrências para `'cad_dosagem'`.

---

## 10. Instrumentação de observabilidade declarada (princípio 29)

| Ponto | Registro |
|---|---|
| `classificarPosologia` — falha de API ou parse | `degradar()`, `cadastro:classificador_posologia_falhou`, severidade `media` |
| `classificarPosologia` — pares descartados na validação determinística (seção 4.6) | `degradar()` só quando **todos** os pares forem descartados (vira `indeterminado`) |
| `callClaude` de geração | já instrumentado (`cadastro:parse_json_falhou`), sem mudança |

Nenhuma peça nova herda observabilidade automaticamente — por isso a declaração explícita.

---

## 11. Checklist de verificação (princípio 31, corolário)

Comandos que **varrem o projeto**, não a lista de pontos que o autor enumerou. Se algum não
voltar limpo, o trabalho não está concluído.

```bash
# 1. Nenhuma referência sobrevivente a cad_forma
grep -rn "cad_forma" src/
# esperado: nenhuma linha

# 2. Nenhum default silencioso de 'comprimido' sobrou
grep -rn "|| 'comprimido'" src/
# esperado: nenhuma linha

# 3. Todo saveSchedule do fluxo de cadastro passa quantidade
grep -rn "saveSchedule(" src/
# esperado: toda chamada em cadastro.js traz quantidadePorDose

# 4. A conversão de dose não foi reimplementada
grep -rn "gotas_por_ml" src/ | grep -v "database.js"
# esperado: só passagem de valor; nenhuma divisão/multiplicação por gotas_por_ml
# fora de converterDoseParaEstoque

# 5. Sintaxe
node --check src/agentes/cadastro.js && \
node --check src/database.js && \
node --check src/agentes/relatorios.js && \
node --check src/observabilidade.js
```

---

## 12. Cenários de validação em produção

Executar no WhatsApp e conferir em `medications`, `schedules` e `stock_movements`.

### Sólido — não-regressão (o mais importante)

1. **Cadastro simples 1 un/dose.** "Losartana" → 50mg → "às 8h" → "1 comprimido" → contínuo →
   30 → confirmar.
   ✅ `unidade_dose='unidade'`, `unidade_estoque='unidade'`, `gotas_por_ml=NULL`,
   `forma_farmaceutica='comprimido'`, 1 schedule com `quantidade_por_dose=1`, estoque 30.
   **Comportamento externo deve ser indistinguível do de hoje, exceto pelos rótulos em negrito.**

2. **Multi-unidade por dose.** "2 comprimidos" em 2 horários → `quantidade_por_dose=2` nos dois.
   Confirmar uma dose depois e verificar `stock_movements.quantidade_delta = -2`.

3. **Posologia variável.** "tomo 2 cps às 8 e 1 cp às 20" na pergunta de **horários**.
   ✅ Salta `cad_quantidade_por_dose`; 2 schedules com quantidades 2 e 1.

4. **Forma não explicitada.** "2 por vez" → dispara `cad_confirma_forma` com palpite pelo nome →
   confirmar → forma gravada. Depois: `meus_remedios` exibe a forma correta.

5. **Forma não explicitada + resposta inútil.** "2 por vez" → confirmação → "sei lá" →
   ✅ avança mesmo assim, `forma_farmaceutica='unidade'`, **sem travar**.

### Líquido — caminho novo

6. **Colírio em gotas.** "Voltaren colírio" → 0,5% → "de manhã e à noite" → "2 gotas em cada
   olho".
   ✅ `unidade_dose='gota'`, `unidade_estoque='ml'`, `gotas_por_ml=20`,
   `forma_farmaceutica='colírio'`, `quantidade_por_dose=4` (**não 2** — multiplicador),
   estoque em ml.

7. **Xarope em ml.** "5ml às 8h e às 20h" → `unidade_dose='ml'`, `unidade_estoque='ml'`,
   `gotas_por_ml=NULL`.

8. **Estoque de frasco lacrado.** No cenário 6: "2 frascos" → "10ml cada" →
   ✅ `estoque_atual = 20`, `stock_movements` com `tipo='cadastro_inicial'`, delta 20.

9. **Frasco lacrado numa resposta só.** "2 frascos de 10ml" → ✅ pula `cad_estoque_volume`.

10. **Dose líquida confirmada.** Confirmar uma dose do cenário 6 →
    ✅ `quantidade_delta = -0.2` (4 gotas ÷ 20 gts/ml). **Primeira dose de medicamento líquido
    real do projeto** — a pendência declarada no fechamento da Parte A.

### Desambiguação e limites

11. **Horário confundido com quantidade.** "tomo às 8" na pergunta de horários →
    ✅ `horarios_apenas`, 08:00. **Não** quantidade 8.

12. **Concentração na pergunta de quantidade.** "50mg" → ✅ `indeterminado` + reformulação
    distinguindo dosagem de quantidade. **Não grava 50.**

13. **Duplicata ainda funciona.** Cadastrar medicamento já ativo → ✅ mensagem de duplicata
    (prova de que o item 9.1 foi corrigido).

14. **Reencadastro após encerramento.** Encerrar um tratamento e recadastrar → ✅ vai para
    `cad_dosagem`, não trava (item 9.2).

15. **Frequência por intervalo.** "de 8 em 8 horas" → "começando às 7h" →
    ✅ horários 07:00/15:00/23:00 calculados por `calcularHorariosPorIntervalo` (BUG-041
    preservado), depois pergunta a quantidade.

### Verificação transversal

16. `system_events` sem nenhum `cadastro:classificador_posologia_falhou` durante a bateria.
17. Todos os medicamentos criados satisfazem os CHECKs da Parte A — nenhum INSERT rejeitado.

---

## 13. Escritas em `backlog_items`

Este chat é **read-only** no Supabase. As escritas abaixo são responsabilidade do Claude Code, via
`src/backlog.js` (princípio 16):

- `UPDATE` MH-073 parte B → `em_validacao` ao fim da implementação.
- `INSERT` MH-073 **parte B.1** — *"Blindagem de becos sem saída no cadastro.js — escalada ao
  roteador via ponto único de despacho"*, `prioridade: alta`, `relacionado: 'MH-073'`,
  `sessao_criacao: 'v34'`. **Autorizado explicitamente por Guilherme nesta sessão.**