# BRIEFING v36 #1 — `classificarPosologia`: intervalo + início na mesma mensagem, e observabilidade

**Sessão:** v36 · **Arquivo único:** `src/agentes/cadastro.js` · **Sem migration.**
**Ordem:** este briefing é o PRIMEIRO da sessão. O Briefing #2 (fluxo do cadastro / MH-073 Parte C.1)
vem depois e não depende deste em código — a ordem existe porque todo cadastro passa por posologia
antes de chegar em estoque, e testar o #2 com a posologia instável mistura os dois defeitos.

**Nada aqui é regressão da Parte C.** Os dois defeitos são pré-existentes; a bateria de testes de
líquidos da v36 só os expôs de forma sistemática.

---

## 1. Evidência (sessão de testes 26/08, logs Railway + estado final no banco)

Três mensagens com o MESMO conteúdo semântico (quantidade + intervalo + horário de início)
produziram três resultados diferentes:

| Hora | Mensagem | Resultado observado | Categoria inferida |
|---|---|---|---|
| 17:43 | "5ml de 12/12 hrs. Comecei as 17hrs" | ✅ 2 horários corretos (05:00, 17:00) | `frequencia_intervalo` **com** `horario_inicio` |
| 17:45 | "5ml 8/8hrs. Tomo as 20hrs agora" | ❌ 1 horário só (20:00) — intervalo perdido | `posologia_completa` |
| 17:54 | "5ml de 8 em 8hrs comecei as 17hrs" | ❌ repergunta ("As 17hrs" às 17:55) | `frequencia_intervalo` **sem** `horario_inicio` |

E a correção pós-resumo (17:47:53, "Eu tomo 5 ml de 8 em 8hrs") custou DOIS turnos extras
(17:48:01 "20hrs" + 17:48:15 "5ml") para reinformar horário e quantidade que a Nami já tinha
confirmado com o usuário às 17:45.

---

## 2. Causa raiz — DOIS defeitos independentes que produzem o mesmo sintoma

### 2.1 Taxonomia de categorias não cobre o caso real (prompt) — `buildPosologiaSystemPrompt`

As categorias são mutuamente exclusivas por construção:

- `posologia_completa` = "a mensagem traz horário(s) **E** quantidade(s)"
- `frequencia_intervalo` = "frequência regular **sem horários explícitos**"

Uma mensagem com quantidade + intervalo + início **satisfaz a primeira e é explicitamente excluída
pela segunda**. O classificador precisa escolher uma das duas, e a escolha oscila com o fraseado.

Agravante: `intervalo_horas` e `horario_inicio` existem no JSON de saída e são normalizados em
`validarClassificacaoPosologia` (linhas ~1477-1481), mas **nenhuma regra do prompt diz quando
preenchê-los**. Ficam ao acaso da inferência.

### 2.2 O código descarta o intervalo mesmo quando ele VEM preenchido (4 pontos)

Independente do prompt: em `decidirCadHorarios`, `case 'posologia_completa'` usa apenas
`classificacao.pares` e **nunca lê `classificacao.intervaloHoras`**. Ou seja, mesmo que o
classificador acertasse e devolvesse `pares: [{20:00, 5}]` + `intervalo_horas: 8`, a grade não
seria expandida. Os quatro pontos com o mesmo buraco:

1. `decidirCadHorarios` → `case 'posologia_completa'`
2. `decidirCadQuantidade` → `case 'posologia_completa'`
3. `decidirCadConfirmaForma` → ramo `posologia_completa` (primeiro `if` da função)
4. `corrigirPosologiaEmConfirmacao` → `if (classificacao.categoria === 'posologia_completa')`

**Corrigir os quatro com uma função compartilhada, não com quatro remendos** (princípio
sistêmico vs. patch). Ver seção 3.2.

### 2.3 Correção por intervalo descarta o início já confirmado

Em `corrigirPosologiaEmConfirmacao`, ramo `frequencia_intervalo`:
`recalcularGradePorIntervalo(...)` só é chamado **se `classificacao.horarioInicio` vier na
mensagem**. Mas o contexto já tem `pares_posologia` (e frequentemente `horario_inicio`) de uma
confirmação anterior — o primeiro horário confirmado é um início legítimo. O código descarta o que
já sabe e volta a `cad_horarios`. Violação direta do Princípio 1.

`decidirCadConfirmaForma` tem exatamente o mesmo buraco no seu ramo `frequencia_intervalo`.

---

## 3. Correções

### 3.1 Prompt — regra nova de intervalo (em `buildPosologiaSystemPrompt`)

**a)** Reescrever a definição de `frequencia_intervalo` para remover a exclusão que causa o
conflito. Trocar "frequência regular **sem horários explícitos**" por: frequência regular expressa
como intervalo ou vezes-ao-dia, **com ou sem** horário de início mencionado.

**b)** Acrescentar uma REGRA nova (numerada após as existentes), com este conteúdo:

```
REGRA 7 — INTERVALO E HORÁRIO DE INÍCIO (crítica).
Sempre que a mensagem mencionar um intervalo regular ("de 8 em 8 horas", "8/8hrs", "12/12",
"3 vezes ao dia"), preencha "intervalo_horas" — INDEPENDENTE da categoria escolhida.
Sempre que a mensagem indicar quando a pessoa toma/tomou a primeira dose ("comecei às 17h",
"tomo às 20hrs agora", "a primeira é 8h"), preencha "horario_inicio" no formato "HH:MM" —
INDEPENDENTE da categoria escolhida.
Estes dois campos são INDEPENDENTES da categoria: uma mensagem pode ser posologia_completa E
trazer intervalo_horas; pode ser frequencia_intervalo E trazer horario_inicio.
  "5ml 8/8hrs. Tomo as 20hrs agora"     -> posologia_completa, pares [{20:00, 5}],
                                            intervalo_horas 8, horario_inicio "20:00"
  "5ml de 8 em 8hrs comecei as 17hrs"   -> posologia_completa, pares [{17:00, 5}],
                                            intervalo_horas 8, horario_inicio "17:00"
  "de 8 em 8 horas"                     -> frequencia_intervalo, intervalo_horas 8,
                                            horario_inicio null
NUNCA calcule você mesmo os demais horários da grade a partir do intervalo — devolva apenas o
início. A grade inteira é calculada em código (dado de saúde, Princípio 28).
```

A última frase é obrigatória: sem ela, o classificador passa a devolver a grade inteira inventada,
o que é exatamente o que o BUG-98 já corrigiu uma vez.

### 3.2 Código — resolver compartilhado (ponto único, Princípio 30)

Criar UMA função nova, usada pelos quatro pontos da seção 2.2:

```js
// v36 Briefing #1: intervalo e início são independentes da categoria (REGRA 7 do prompt).
// Quando a mensagem traz UM horário e um intervalo, o horário é o INÍCIO da grade, não a
// grade inteira — expandir em código, nunca no LLM (Princípio 28).
// Devolve null quando não há intervalo aplicável, e o chamador segue com os pares originais.
function expandirParesPorIntervalo(classificacao) {
    const { pares, intervaloHoras } = classificacao;
    if (!intervaloHoras || !Array.isArray(pares) || pares.length !== 1) return null;

    const inicio = classificacao.horarioInicio || pares[0].horario;
    const horarios = calcularHorariosPorIntervalo(inicio, intervaloHoras);
    if (horarios.length <= 1) return null;

    return {
        pares: montarParesPosologia(horarios, pares[0].quantidade),
        horarios,
        intervalo_horas: intervaloHoras,
        horario_inicio: inicio
    };
}
```

**Guardas deliberadas, não acidentais:**
- `pares.length !== 1` → quando o usuário listou vários horários explicitamente ("5ml às 8 e às
  20"), a lista explícita vence; não há o que expandir e um intervalo mencionado junto seria
  ambíguo. Só o caso de horário único é inequivocamente "início de grade".
- `horarios.length <= 1` → intervalo de 24h (1 dose/dia) não muda nada; devolver null evita
  reescrever a grade à toa.
- `pares[0].quantidade` propagada para todos os horários — a quantidade por dose é a mesma em toda
  a grade; é o que `montarParesPosologia` já faz nos outros chamadores.

**Nos quatro pontos**, dentro do ramo `posologia_completa`, aplicar antes de montar `upd`:

```js
const expandido = expandirParesPorIntervalo(classificacao);
const paresFinais = expandido ? expandido.pares : classificacao.pares;
// ...e, quando expandido, acrescentar a upd/contextUpdates:
//   intervalo_horas: expandido.intervalo_horas,
//   horario_inicio: expandido.horario_inicio
```

Persistir `intervalo_horas`/`horario_inicio` é necessário — é o que permite que uma correção
posterior por intervalo recalcule a grade (BUG-98) em vez de remapear às cegas.

### 3.3 Início herdado do contexto na correção por intervalo

Em `corrigirPosologiaEmConfirmacao`, ramo `campoAlvo === 'horarios' && categoria ===
'frequencia_intervalo'`, e no ramo equivalente de `decidirCadConfirmaForma`, trocar a condição
`if (classificacao.horarioInicio)` por um início resolvido em cascata:

```js
const inicio = classificacao.horarioInicio
    || context?.horario_inicio
    || (context?.pares_posologia?.[0]?.horario ?? null);
if (inicio) {
    const grade = recalcularGradePorIntervalo(context?.pares_posologia, inicio, classificacao.intervaloHoras);
    // ... resto igual, com extra: { intervalo_horas: ..., horario_inicio: inicio }
}
```

⚠️ **Assunção que preciso que o Guilherme confirme na revisão:** a ordem da cascata assume que
`context.horario_inicio` (quando existe) é um início mais confiável que o primeiro par, e que
`pares_posologia[0]` é o início quando não há nada registrado. `pares_posologia` vem de
`montarParesPosologia`, que ordena (`unicos.sort()`), então `[0]` é o horário mais cedo do dia —
NÃO necessariamente a primeira dose cronológica do tratamento. No caso testado (grade de um único
horário) isso é indistinguível; em grades maiores pode escolher um início diferente do que o
usuário pensou. Só cai nesse ramo quando `horario_inicio` não está no contexto.

### 3.4 Instrumentação dos classificadores (candidato 7)

Nenhum dos classificadores de campo do `cadastro.js` loga a categoria devolvida — só o
classificador central de intenção loga. Foi por isso que dois dos cinco pontos reportados nesta
sessão precisaram de um segundo dump de logs e de consultas ao banco para serem fechados.

Acrescentar UMA linha de log ao final de cada um dos classificadores abaixo, imediatamente antes
do `return` do caminho de sucesso (o caminho de falha já passa por `degradar()`):

| Linha | Função | Campos a logar além da categoria |
|---|---|---|
| 380 | `classificarEstoqueSolido` | `quantidade` |
| 448 | `classificarStatusFrasco` | — |
| 528 | `classificarFracaoEstoque` | — |
| 923 | `classificarPosologia` | `campoEsperado`, `pares.length`, `intervaloHoras`, `horarioInicio` |
| 1012 | `extrairCampoSimples` | `campo` |
| 1084 | `classificarTipoTratamento` | `dias` |
| 1220 | `classificarConfirmacaoCadastro` | `campoAlvo` |
| 1506 | `extrairCadastroCompleto` | quais campos vieram preenchidos (só as CHAVES, ver abaixo) |
| 2042 | `classificarIndeterminadoCadastro` | `etapa` |

Formato único, no padrão dos logs existentes (`🧠 [CLASSIFICADOR]` já é usado pelo classificador
central de intenção — usar prefixo distinto para não confundir a triagem):

```js
console.log(`🔎 [CAD-CLASSIF] classificarPosologia -> ${resultado.categoria} `
    + `(campo: ${campoEsperado}, pares: ${resultado.pares.length}, `
    + `intervalo: ${resultado.intervaloHoras}, inicio: ${resultado.horarioInicio})`);
```

**Nunca logar o conteúdo da mensagem do usuário nem valores de saúde** (nome de medicamento,
dosagem, quantidade por dose): os logs do Railway não são um destino autorizado para dado pessoal
de saúde, e o objetivo aqui é saber qual ramo executou, não o que o usuário tem. Para
`extrairCadastroCompleto`, logar apenas quais chaves vieram não-nulas, nunca os valores.

---

## 4. Fora de escopo deste briefing

- Tudo do Briefing #2 (`forma_confirmada`/`primeiraEtapaFaltante`, `blocoConfirmaForma`,
  "quantos frascos" indeterminado, MH-073 Parte C.1).
- Recorrência não-diária (MH-77, "1x por semana", "dia sim dia não") — `intervalo_horas` continua
  assumindo grade diária.
- `remapearParesParaNovosHorarios` e o comportamento de ambiguidade do BUG-98 — inalterados.

---

## 5. Verificação após implementar

```bash
node --check src/agentes/cadastro.js
grep -n "expandirParesPorIntervalo" src/agentes/cadastro.js   # 1 definição + 4 usos = 5 linhas
grep -c "CAD-CLASSIF" src/agentes/cadastro.js                 # deve ser 9
grep -n "REGRA 7" src/agentes/cadastro.js                     # regra nova presente
```

---

## 6. Cenários de validação em produção

Todos com medicamento líquido (unidade `ml`), que é onde o defeito aparece com mais frequência —
mas os cenários 1-3 valem igualmente para sólidos.

1. **"5ml 8/8hrs. Tomo as 20hrs agora"** em `cad_horarios` → esperado: 3 horários (20:00, 04:00,
   12:00), 5ml cada, SEM turno extra. Era o caso que falhava às 17:45.
2. **"5ml de 8 em 8hrs comecei as 17hrs"** → esperado: 3 horários (17:00, 01:00, 09:00), 5ml cada,
   SEM turno extra. Era o caso que falhava às 17:54.
3. **"5ml de 12/12 hrs. Comecei as 17hrs"** → esperado: 2 horários (17:00, 05:00) — não-regressão
   do caso que JÁ funcionava às 17:43.
4. **"5ml às 8 e 2ml às 20"** (dois horários explícitos, sem intervalo) → esperado: exatamente
   esses dois pares, quantidades diferentes preservadas. Não-regressão da guarda `pares.length !== 1`.
5. **Correção pós-resumo:** confirmar um cadastro com um horário só, depois responder no resumo
   "eu tomo de 8 em 8hrs" → esperado: grade recalculada a partir do horário já confirmado, SEM
   reperguntar horário nem quantidade. Era o caso que custava 2 turnos às 17:47.
6. **"de 8 em 8 horas"** sozinho, sem quantidade nem início → esperado: continua pedindo o horário
   da primeira dose (`frequencia_sem_inicio`) — não-regressão.
7. Conferir no Railway que as linhas `🔎 [CAD-CLASSIF]` aparecem para cada etapa do cadastro e que
   **nenhuma** contém texto da mensagem do usuário ou valor de saúde.