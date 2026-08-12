# BRIEFING — MH-072 Parte A.2: correção do ramo de negação e categoria saudação

**Sessão:** v30
**Data:** 12/08/2026
**Executor:** Claude Code
**Item de backlog:** MH-072 (Parte A.2)

> Base: commit `04f9b73` (Parte A.1), validado em produção em 12/08. Dos 11 cenários
> A–K da seção 11.2 do briefing A.1, **9 passaram**. Este briefing trata os 2 restantes.

---

## 1. O que a A.1 resolveu (confirmado, não mexer)

Comparação lado a lado no mesmo transcript, antes (16:44) e depois (17:23+):

| Cenário | Antes | Depois |
|---|---|---|
| A | "Nossa que chato nao quero mais" → gravou **10/05/1989** | Recusa reconhecida, encerra e retoma |
| B | `06` aceito → *"Boa tentativa com o número!"* | *"Ótimo, dia 10 anotado!"* |
| C | `89` → *"você quis dizer 1989? Pode confirmar?"* → laço | *"preciso do ano completo — por exemplo, 1990"* |
| D | `Issi` → voltava a pedir o dia | Confirma e grava |
| J | *"Essa é a última perguntinha, prometo"* | Nenhuma promessa de brevidade |

Regressão determinística de `extrairMes()` rodada contra o código publicado: **32 casos,
todos passaram**. Não alterar `src/dataNascimento.js` nesta parte.

---

## 2. Fora do escopo

- `pareceNome()`, pergunta dupla, caminho DESCOBRIR → **Parte B** (BUG-030, MH-074)
- Editar data de nascimento após o onboarding → **MH-075**
- `src/dataNascimento.js` → não tocar, está validado
- Nenhuma alteração de schema

---

## 3. Item 1 — `nasc_negacao` descarta o valor informado (CRÍTICO)

### 3.1 Sintoma observado

```
Nami:  Deixa eu confirmar: você nasceu em 06/11/1989, certo?
User:  Ta errado
Nami:  Poxa, desculpa! O que ficou errado — o dia, o mês ou o ano?
User:  O correto e dia 10
Nami:  Ótimo! Então você nasceu no dia 10. ✅
       Só para confirmar: sua data de nascimento é 10/11/1989, certo?     ← MENTIRA
User:  Sim
Nami:  Boa notícia: já temos o mês e o ano! Só falta o dia...             ← estado real
User:  Dia 10
Nami:  ...você nasceu em 10/11/1989, isso está certo?
User:  Esta certo
       → grava 1989-11-10
```

Dado final correto, mas **2 turnos de retrabalho** e uma mensagem que afirma um estado
que não existe.

### 3.2 Causa raiz — confirmada em código

`src/agentes/data_nascimento.js`, ramo `etapa === 'nasc_negacao'`:

```js
const campoErrado = /\bdia\b/.test(msgNorm) ? 'dia'
    : /\bm[eê]s\b/.test(msgNorm) ? 'mes'
    : /\bano\b/.test(msgNorm) ? 'ano'
    : null;

if (campoErrado) {
    const novoContext = { ...context, [campoErrado]: null, etapa: proximaEtapa, ... };
```

O regex extrai **apenas qual campo** está errado. A mensagem "O correto e dia 10" carrega
o campo **e o valor novo** — o `10` é descartado, `dia` vira `null`, e a Nami repergunta.

Em seguida a LLM, gerando o template `nasc_dia`, lê "dia 10" no histórico e **improvisa
uma confirmação da data completa** — encobrindo o estado real (`dia = null`).

Vale registrar: a mensagem seguinte (*"só falta o dia"*) estava **correta**. Quem mentiu
foi a anterior. O usuário se confundiu por causa da mensagem inventada, não do estado.

**Esta é a mesma família do item 1 da A.1** (prompt de geração sem o estado
determinístico → LLM preenche a lacuna inventando). O caminho de negação simplesmente
não foi coberto naquela correção.

### 3.3 Correção

No ramo `nasc_negacao`, depois de identificar `campoErrado`, **tentar extrair também o
valor** da mesma mensagem, usando `extrairComponenteData(message, campoErrado)`:

**Caso A — veio campo + valor** (`"o correto e dia 10"`, `"o mês é novembro"`,
`"o ano é 1989"`):
- Aplicar o valor diretamente via `aplicarPreenchimento` com `foiCorrecao: true`
- **Nunca zerar o campo**
- Como os três campos seguem preenchidos, `proximaEtapaFaltante` devolve
  `nasc_confirmacao` → relê a data corrigida e pede confirmação
- Resultado esperado: **um turno**, não três

**Caso B — veio só o campo** (`"o dia"`, `"tá errado o mês"`):
- Comportamento atual, que está correto: zera o campo, `etapa` vai para o campo
  correspondente, repergunta

**Caso C — não esclareceu** (`"sei lá"`, `"tudo"`):
- Comportamento atual: repete a pergunta `nasc_negacao`

Atenção ao desempate no Caso A: a mensagem menciona o campo por nome **e** traz um
número. `extrairComponenteData(message, campoErrado)` já resolve isso, porque o
`campoEsperado` passa a ser o campo que o usuário nomeou — a regra de desempate da Parte A
prioriza o campo esperado quando o valor cabe nele.

Logar a distinção para observabilidade:
```
🎂 [DATA-NASCIMENTO] Negação com valor — corrigindo {campo}={valor} direto — {phone}
🎂 [DATA-NASCIMENTO] Negação sem valor — reabrindo {campo} — {phone}
```

---

## 4. Item 2 — Template do campo reaberto não pode confirmar valor inexistente

### 4.1 Escopo

Mesmo com o item 1 resolvido, o **Caso B** continua zerando um campo. O template gerado
nesse caminho precisa saber disso, senão a LLM repete a invenção.

### 4.2 Correção

Estender o mecanismo do item 1 da A.1 (estado determinístico no prompt) ao caminho de
negação. `buildSystemPrompt` passa a receber, nas etapas alcançadas via `nasc_negacao`:

- `campoZerado` — qual campo foi limpo e precisa ser informado de novo
- `camposPreenchidos` — os que continuam válidos

Instrução explícita no template:

> O campo `{campoZerado}` foi apagado a pedido da pessoa e **não existe mais no sistema**.
> Não confirme, não repita e não sugira nenhum valor para ele — nem que a pessoa o tenha
> mencionado antes. Peça o valor novo. Os demais campos seguem válidos e não devem ser
> perguntados de novo.

---

## 5. Item 3 — Categoria `saudacao` no classificador

### 5.1 Sintoma

Ao testar o cenário H, o pulo automático disparou na 3ª tentativa — mas só **duas**
mensagens ininteligíveis tinham sido enviadas:

```
17:29  Ola                    → tentativa 1   (log: "Oi" -> ruido)
17:30  Sssssssss              → tentativa 2
17:30  Anhukbrjtvwbddgvaioo   → tentativa 3 → pulou
```

Os logs do Railway mostram **quatro** ocorrências de `"Oi" -> ruido` na janela. Toda
saudação cai no balde de ininteligível.

### 5.2 Por que corrigir

Contraria o invariante do item 7 da A.1 no espírito: *o contador conta exclusivamente
mensagens ininteligíveis*. Uma saudação não é uma tentativa fracassada de informar a data
— é a pessoa reabrindo a conversa.

Consequência prática: quem abandona e volta duas vezes dizendo "oi" queima 2 das 3
tentativas **antes de tentar responder uma única vez**, e é pulado no primeiro erro real.
Isso é especialmente provável no público-alvo (idosos) e no cenário de retomada, que é
justamente onde a saudação aparece.

### 5.3 Correção

Nova categoria no vocabulário de `classificarIndeterminado`, em **todas** as etapas (não
só `nasc_confirmacao`):

```
- saudacao: o usuário está apenas cumprimentando ou retomando a conversa, sem
  responder à pergunta e sem recusar. Ex: "oi", "olá", "bom dia", "tudo bem?",
  "voltei", "alô".
```

Tratamento no `handleDataNascimento`: **não consome tentativa**, `tentativas_indeterminado`
permanece inalterado. Reapresenta a pergunta da etapa atual com o exemplo de formato,
reconhecendo a saudação brevemente.

Adicionar `'saudacao'` à lista `validos` nos dois ramos (com e sem `naConfirmacao`).

Atualizar o comentário do invariante (linha ~480) para refletir que `saudacao` também não
consome tentativa.

---

## 6. Item 4 — Decisão sobre o limite de tentativas

Com `saudacao` fora do contador, `MAX_TENTATIVAS_INDETERMINADO = 3` passa a significar
**3 tentativas reais de resposta ininteligível** — que é o que o desenho original queria.
Manter em 3. Nenhuma alteração de valor.

Registrar em comentário que o número só é significativo porque saudação e declarações
explícitas estão excluídas do contador.

---

## 7. Critérios de aceite

| # | Entrada | Esperado |
|---|---|---|
| 1 | Confirmação → `"Ta errado"` → `"O correto e dia 10"` | Corrige e relê `10/11/1989` em **um** turno. Nenhuma mensagem dizendo que falta o dia |
| 2 | Confirmação → `"Ta errado"` → `"o mês é novembro"` | Corrige o mês direto, relê a data |
| 3 | Confirmação → `"Ta errado"` → `"o dia"` (sem valor) | Zera só o dia, pergunta o dia. **Não** confirma nenhum valor de dia |
| 4 | Confirmação → `"Ta errado"` → `"sei lá"` | Repete a pergunta de qual campo está errado |
| 5 | `"Oi"` em qualquer etapa | Reapresenta a pergunta. Log **não** registra incremento de tentativa |
| 6 | `"Oi"`, `"Olá"`, `"Bom dia"`, depois 3 ininteligíveis | Pula só na 3ª **ininteligível** — as saudações não contam |
| 7 | Regressão A: "Nossa que chato nao quero mais" em `nasc_mes` | Recusa, encerra, retoma. Nada de maio |
| 8 | Regressão K: fluxo feliz completo | Grava correto e emenda no pedido original |
| 9 | Regressão D: `"Issi"` na confirmação | Confirma e grava |

Os cenários 7, 8 e 9 são regressão da A.1 — precisam continuar passando.

---

## 8. Itens de backlog

**Registrar:**
- `MH-072` Parte A.2 — "Negação na confirmação preserva o valor informado; saudação não
  consome tentativa" — prioridade `alta`, status `em_validacao` após deploy

**Atualizar:**
- `MH-072` Parte A.1 → `resolvido` (9 de 11 cenários aprovados; os 2 restantes viram A.2)

**Princípio a registrar no CONTEXT.md** (extensão do princípio da A.1 sobre estado
determinístico no prompt):

> Quando o código apaga ou invalida um dado, o prompt de geração precisa ser informado
> explicitamente. A LLM lê o histórico da conversa, não o estado do banco — e se o
> histórico contém um valor que o sistema descartou, ela vai confirmá-lo. Todo caminho
> que zera um campo deve declarar isso ao gerador.

---

## 9. Ordem de execução

1. Item 1 (`nasc_negacao` com extração de valor) — maior impacto
2. Item 2 (`campoZerado` no prompt) — depende do 1 para fazer sentido
3. Item 3 (categoria `saudacao`)
4. Item 4 (comentários)
5. Deploy + cenários da seção 7
6. Escritas de backlog da seção 8