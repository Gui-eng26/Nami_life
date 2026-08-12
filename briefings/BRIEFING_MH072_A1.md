# BRIEFING — MH-072 Parte A.1: correções pós-validação da coleta de data de nascimento

**Sessão:** v30
**Data:** 12/08/2026
**Executor:** Claude Code
**Item de backlog:** MH-072 (Parte A.1)

> Nota de nomenclatura: a governança da v29 prevê Partes A/B/C. Esta é uma sub-parte
> corretiva da Parte A já entregue (commit `037c061`), não um escopo novo — daí `A.1`.
> A Parte B (reestruturação do recepcionista + BUG-030 + MH-074) permanece intocada.

---

## 1. Origem

A Parte A foi validada em produção em 12/08/2026. Resultado: **12 cenários aprovados,
1 reprovado, 2 com ressalva**. O objetivo central foi atingido — a data chega ao banco
corretamente, inclusive com erros de digitação e correções no meio do fluxo.

Este briefing corrige os defeitos encontrados. Nenhum deles é de robustez: em todos os
caminhos testados houve saída, o usuário nunca ficou preso. São defeitos de **corrupção
silenciosa de dado** (item 0, grave) e de **qualidade de conversa** (demais itens).

Evidência: transcripts de WhatsApp de 12/08, logs do Railway de 15:39–16:18 UTC, e
reprodução controlada do item 0 confirmada por print.

---

## 2. Fora do escopo

- `pareceNome()`, pergunta dupla do recepcionista, caminho DESCOBRIR → **Parte B**
  (BUG-030 e MH-074). Não tocar.
- Editar data de nascimento após o onboarding → **MH-075**. Não implementar.
- Nenhuma alteração de schema. A migration da Parte A está aplicada e correta.

---

## 3. Item 0 — Levenshtein em abreviações de mês (CRÍTICO)

### 3.1 Sintoma

Usuário em `nasc_mes`, com `dia = 10` já preenchido, escreve:

> "Nossa que chato nao quero mais"

A Nami segue para o ano e grava **10/05/1989**. A reclamação virou "maio".

### 3.2 Causa raiz — confirmada, não é hipótese

Em `src/dataNascimento.js`, `extrairMes()` aplica distância de Levenshtein ≤ 1 contra
`MESES` **e** `MESES_ABREV`. As abreviações têm 3 caracteres; uma janela de erro de 1
sobre tokens tão curtos colide com vocabulário funcional do português:

| Token do usuário | Vira | Colisão |
|---|---|---|
| `mais` | maio (5) | nome completo, distância 1 |
| `mas` | março (3) | abrev `mar` |
| `sei` | setembro (9) | abrev `set` |
| `ser` | setembro (9) | abrev `set` |

Verificação independente: nos logs do Railway **não existe linha de classificador** para
essa mensagem, enquanto existe para todas as outras mensagens indeterminadas da mesma
janela. Prova de que o extrator reconheceu um componente e o classificador nunca rodou.

**A falha de especificação foi minha, não da implementação.** O briefing da Parte A pediu
tolerância "contra a lista dos 12 nomes e das 12 abreviações". Em `novembro` (8 chars) a
distância 1 é segura; em `mai` (3 chars) é promíscua.

### 3.3 Correção

Em `extrairMes()`, o laço de tolerância passa a percorrer **apenas `MESES`** (nomes
completos). `MESES_ABREV` continua funcionando por igualdade exata, no laço anterior.

Reforço adicional: exigir `tok.length >= 5` para entrar na tolerância. `maio` tem 4
caracteres e é o nome completo mais curto — a distância 1 sobre ele ainda alcança `mais`.
Com o piso em 5, `mais` (4) nem entra no laço.

```js
for (const tok of tokens) {
    if (tok.length < 5) continue;                 // era: < 3
    for (const [nome, num] of Object.entries(MESES)) {
        if (levenshtein(tok, nome) <= 1) return num;
    }
    // laço contra MESES_ABREV REMOVIDO
}
```

Isso preserva 100% do ganho comprovado: `Nvembro`, `Novembto`, `Novenbro`, `Novmbro`,
`Novenbro` — todos casam com o nome completo `novembro`.

### 3.4 Princípio a registrar no CONTEXT.md

> **Tolerância a erro de digitação exige comprimento mínimo do token.** Distância de
> edição sobre tokens curtos (≤ 4 caracteres) engole vocabulário funcional da língua e
> transforma frases comuns em dados válidos. Quanto menor o token, menor deve ser a
> janela — e em vocabulários de 3 letras, a janela correta é zero.

---

## 4. Item 1 — Prompt de geração não recebe o estado determinístico

### 4.1 Sintomas (três, mesma causa)

**a)** Dia aceito corretamente, e a Nami trata a resposta certa como tentativa falha:
> `06` (aceito como dia 6) → *"**Boa tentativa** com o número! 😄 Mas aqui eu preciso do
> nome do mês mesmo"*

**b)** Ano de 2 dígitos corretamente rejeitado, e a Nami propõe o valor que o sistema
**não** tem:
> `89` → *"Só preciso do ano completo — por exemplo, **1989**. Pode me confirmar?"*
> `Isso` → *"Não consegui entender essa resposta"* — laço criado pela própria mensagem.

**c)** Pergunta do dia com exemplo de data completa:
> *"qual é o **dia** do seu nascimento? Pode me dizer assim: **DD/MM/AAAA**"*

### 4.2 Causa raiz

`buildSystemPrompt` recebe `motivo` mas **só o usa em `nasc_ruido`**. Nas etapas de
avanço (`nasc_dia`/`nasc_mes`/`nasc_ano`) a única informação de estado comunicada à LLM é
`correcaoAplicada`. A LLM não sabe **o que acabou de ser aceito**, **qual valor foi
rejeitado**, nem **por quê** — então lê o histórico bruto e improvisa uma interpretação.

Este é o mesmo defeito de fundo do princípio 24: divergência entre o que o sistema sabe e
o que ele diz.

### 4.3 Correção

`buildSystemPrompt` passa a receber e injetar um bloco de estado explícito em **todas** as
etapas:

- `valorAceito` — campo e valor capturados no turno anterior (ex: `dia = 6`)
- `valorRejeitado` — o que foi descartado e o motivo (ex: `"89" — ano precisa de 4 dígitos`)
- `camposPreenchidos` — o que já está no contexto
- `campoPendente` — o que está sendo pedido agora

Regras obrigatórias no prompt base, aplicáveis a todos os templates:

1. **Nunca propor, sugerir ou confirmar um valor que não esteja em `camposPreenchidos`.**
   Se o usuário mandou algo inválido, peça de novo — não adivinhe o que ele quis dizer.
2. **Nunca tratar como erro do usuário um valor que foi aceito.** Se `valorAceito` está
   presente, reconheça-o antes de pedir o próximo campo.
3. **O exemplo de formato deve corresponder ao `campoPendente`** — pedir o dia usa
   exemplo de dia (`7`), nunca de data completa.

---

## 5. Item 2 — Proibição global de insistir, minimizar ou negociar

### 5.1 Sintoma

Após "Nossa que chato nao quero mais":
> *"Entendo que pode parecer muita coisa de uma vez! **Essa é a última perguntinha,
> prometo.**"*

### 5.2 Causa raiz e por que o item 0 não basta

Essa frase **não veio do template de recusa** — veio do template de avanço para o ano,
porque o sistema achava que o mês tinha sido informado (item 0). Corrigido o Levenshtein,
esse caminho específico deixa de existir.

Mas a LLM adotou aquele tom **por conta própria**, lendo o desconforto no histórico. Nada
no prompt a impedia. Se amanhã o classificador errar, ou se a reclamação cair em `ruido`,
a mesma frase reaparece em outro template.

Hoje a proibição de insistir existe **apenas** em `nasc_recusa`. A LLM não sabe em qual
template está quando decide adotar um tom conciliatório.

### 5.3 Correção

Mover a proibição para o **prompt base**, aplicável a todos os templates do módulo:

> Nunca insista, negocie ou minimize. Proibido: "só mais uma", "é rapidinho", "prometo
> que é a última", "é só uma informação", "não vai demorar", ou qualquer promessa de
> brevidade. Se a pessoa demonstrar desconforto, acolha e ofereça a saída — nunca tente
> convencer.

---

## 6. Item 3 — `nasc_ruido` não trata `nasc_confirmacao`

### 6.1 Sintoma

> *"você nasceu em 10/11/1989, certo?"* → `Issi` → *"Pode me dizer o **dia** em que você
> nasceu?"*

O usuário volta ao início por causa de um erro de digitação de uma letra.

### 6.2 Causa raiz

Linha 179 de `data_nascimento.js`:

```js
const campo = { nasc_dia: 'dia', nasc_mes: 'mês', nasc_ano: 'ano' }[context.etapa] || 'dia';
```

`nasc_confirmacao` não está no mapa → **fallback silencioso para `'dia'`**. Qualquer
resposta não reconhecida na tela de confirmação joga o usuário para o começo.

### 6.3 Correção

O template `nasc_ruido` passa a ter ramo próprio para `nasc_confirmacao`: **releia a data
montada** e peça confirmação de novo, sem reabrir nenhum campo.

Eliminar o `|| 'dia'`. Se a etapa não for reconhecida, é bug — logar em
`system_events` em vez de degradar silenciosamente (alinhado ao MH-064).

---

## 7. Item 4 — Confirmação com erro de digitação

### 7.1 Correção proposta — **mudança em relação ao que foi discutido**

Na conversa de planejamento eu sugeri aplicar Levenshtein a `respostaAfirmativaSimples`.
**Retiro essa proposta.** Aplicar tolerância de edição a `sim` (3), `ok` (2), `pode` (4)
recria exatamente a classe de falso positivo do item 0 — `sem` → `sim` tem distância 1.

Correção correta, alinhada ao princípio 14 (classificação semântica, não lista de
palavras): quando `etapa === 'nasc_confirmacao'` e a extração devolve `indeterminado`, o
classificador **já é chamado de qualquer forma**. Basta estender o vocabulário dele nesse
contexto:

`recusa | duvida | nova_intencao | confirmacao | negacao | ruido`

- `confirmacao` → grava e fecha (cobre "Issi", "isso ai", "eh isso mesmo", "ta certo")
- `negacao` → a data está errada, mas não sabemos qual campo: perguntar o que está errado,
  **sem** reabrir tudo
- demais categorias → comportamento atual

`respostaAfirmativaSimples` permanece como está, atuando como caminho rápido por
igualdade exata antes da chamada ao classificador. Sem custo adicional no caso comum.

---

## 8. Item 5 — `duvida` deve oferecer saída explícita

### 8.1 Situação atual

`duvida` (linha 356) explica e permanece no fluxo. Não oferece saída.

### 8.2 Correção

O template `nasc_duvida` passa a **sempre** oferecer a saída explicitamente, na mesma
mensagem em que explica a finalidade. E o contexto marca `oferta_pular_ativa = true`, de
modo que uma reafirmação de recusa no turno seguinte encerre por
`fecharSemDado`.

Conteúdo da explicação (uma frase, sem insistir): serve para entender a idade média de
quem usa a Nami, de forma agregada — não afeta o uso.

---

## 9. Item 6 — Após 3 tentativas de ruído, pular automaticamente

### 9.1 Mudança de especificação (não é bug)

A Parte A implementou o que o briefing pediu: ao atingir `MAX_TENTATIVAS_INDETERMINADO`,
**oferecer** pular. Funcionou. A decisão de produto mudou: depois de 3 tentativas
ininteligíveis, perguntar "quer pular?" só empurra a fricção adiante.

### 9.2 Correção

Ao atingir a 3ª tentativa de **ruído**, não oferecer — **executar**:

1. Encerrar a coleta sem o dado (`fecharSemDado`)
2. Informar de forma leve que não foi possível entender a data e que seguiremos sem ela
3. Retomar a `mensagem_inicial`. Se ela indicava cadastro de remédio, ir direto para o
   cadastro; se era saudação genérica, seguir o fluxo pós-onboarding atual

`oferta_pular_ativa` deixa de ser necessária para este caminho. Manter apenas se o item 5
(dúvida) continuar usando o mesmo mecanismo.

---

## 10. Item 7 — Invariante do contador (documentar, não alterar)

**Verificado: o código já está correto.** `tentativas_indeterminado` só incrementa no ramo
`ruido` (linha 363); `recusa`, `duvida` e `nova_intencao` retornam antes e nunca tocam o
contador.

Registrar como **invariante em comentário no código e no CONTEXT.md**, para que uma
refatoração futura não "unifique" os ramos:

> O contador de tentativas conta **exclusivamente** mensagens ininteligíveis. Declaração
> explícita do usuário — recusa, dúvida ou nova intenção — nunca consome tentativa e
> nunca é tratada como ruído. Uma pessoa que diz claramente que não quer informar não
> está errando: ela está decidindo.

---

## 11. Critérios de aceite

### 11.1 Regressão determinística (obrigatória — pode rodar sem WhatsApp)

Teste unitário de `extrairMes()`. **Nenhuma** das frases abaixo pode devolver mês:

```
"nossa que chato nao quero mais"   "nao quero mais"      "mas nao sei"
"nao sei"                          "pode ser"            "sei la"
"nem sei"                          "ate mais"            "deixa pra la"
"prefiro nao dizer"                "tanto faz"           "quero ver"
```

E **todas** as abaixo devem continuar devolvendo novembro (11):

```
"novembro"   "Nvembro"   "Novembto"   "Novenbro"   "Novmbro"   "nov"   "Nov"
```

Cobrir também: `março`/`marco`/`mar`, `maio`/`mai`, `setembro`/`set`, `dezembro`/`dez`.

### 11.2 Cenários em produção (WhatsApp)

| # | Entrada | Esperado |
|---|---|---|
| A | Em `nasc_mes`, "Nossa que chato nao quero mais" | Classificado como `recusa`, encerra sem o dado, retoma a `mensagem_inicial`. **Nada de maio** |
| B | Em `nasc_mes`, após `dia` aceito | Mensagem reconhece o dia capturado; **nenhum** "boa tentativa" |
| C | Em `nasc_ano`, "89" | Repergunta com exemplo de 4 dígitos. **Não** propõe "1989" nem pede confirmação de valor inexistente |
| D | Em `nasc_confirmacao`, "Issi" | Confirma e grava. **Não** volta a pedir o dia |
| E | Em `nasc_confirmacao`, "não, está errado" | Pergunta o que está errado, sem reabrir todos os campos |
| F | "Pra que vc precisa disso?" | Explica em uma frase **e oferece a saída** na mesma mensagem |
| G | Após F, "não quero mesmo" | Encerra sem o dado |
| H | 3 mensagens ininteligíveis seguidas | Na 3ª, **pula automaticamente** e retoma o pedido original. Não pergunta se quer pular |
| I | Recusa + dúvida + nova intenção intercaladas | Contador nunca incrementa; nenhuma dessas consome tentativa |
| J | Qualquer caminho de desconforto | **Nenhuma** promessa de brevidade em nenhuma mensagem |
| K | Regressão do fluxo feliz | `06` → `Novembro` → `1989` → confirma → grava `1989-11-06` |

---

## 12. Itens de backlog

**Registrar:**
- `MH-072` Parte A.1 — "Correções pós-validação da coleta de data de nascimento" —
  prioridade `alta`, status `em_validacao` após deploy

**Atualizar:**
- `MH-072` Parte A → `resolvido`. A entrega original está correta no essencial; os
  defeitos encontrados viram A.1, não reabertura de A

**Registrar como princípios no CONTEXT.md:**
- Tolerância a erro de digitação exige comprimento mínimo de token (seção 3.4)
- Contador de tentativas conta exclusivamente ruído (seção 10)
- Prompt de geração deve receber o estado determinístico; a LLM nunca propõe valor que o
  sistema não possui (seção 4.3)

---

## 13. Ordem de execução

1. **Item 0 primeiro, isolado, com o teste de regressão da seção 11.1 passando** — é o
   único que corrompe dado
2. Itens 1 e 2 juntos (ambos em `buildSystemPrompt`)
3. Itens 3 e 4 juntos (ambos em `nasc_confirmacao`)
4. Itens 5 e 6 (fluxo de saída)
5. Item 7 (comentários e CONTEXT.md)
6. Deploy + cenários da seção 11.2
7. Escritas de backlog da seção 12