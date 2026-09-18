# BRIEFING — v43 Bloco C: verdade no roteamento + níveis de campo (BUG-104, MH-090, MH-094)

**Sessão:** v43 (18/09/2026)
**Branch:** `staging`
**Arquivos:** `src/router.js`, `src/agentes/principal.js`, `src/agentes/cadastro.js`,
`src/database.js`
**Depende de:** Blocos A e B com seus adendos, todos validados em staging

Auto-contido. Este é o maior dos três blocos e o único que mexe em persistência.

---

## 0. Evidência e causa raiz

**BUG-104, produção:** a Nami disse "Tudo cadastrado!" prometendo registrar quatro
medicamentos. Zero linhas em `medications`.

**Cinco causas encadeadas, todas confirmadas por leitura de código:**

1. `detectarIntencaoCadastro` (`router.js`) é uma lista de substrings. "Bariatron 12:00 /
   Fluoxetina 08:00" não casa com nenhuma delas e cai no `principal`.
2. O `principal` tem vocabulário de ações (`CONFIRM_DOSE`, `UPDATE_STOCK`,
   `REGISTER_NAO_TOMADO`, `REVERSE_CONFIRMATION`) — **nenhum verbo de cadastro** — e nenhuma
   regra o proíbe de prometer um. Ele prometeu em prosa.
3. No bloco `post_onboarding`, `despacharCadastro` é chamado com
   `context: { etapa: 'cad_nome' }` **literal** (`router.js:758-761`). A mensagem que carregava
   os dados é descartada.
4. O extrator multi-campo `extrairCadastroCompleto` (MH-80) **já existe** e puxa 14 campos numa
   chamada — mas está travado atrás de `etapaAtual === 'cad_nome'`. Fora dessa etapa, nunca roda.
5. A gravação só acontece em `cad_confirmacao`, depois de 7 a 10 turnos. Quem abandona antes não
   deixa nada.

**Evidência de fluxo, staging 18/09 01:59:** "Quero cadastrar o ômega 3, eu tomo 1 cp as 13 e
1 cp as 21hrs" — mensagem com nome, quantidade e horários — foi respondida com "Qual é a
*DOSAGEM* do Ômega 3?". Três campos dados, zero aproveitados, dosagem pedida antes de qualquer
coisa ser salva.

**Princípios que governam este bloco:**
- **P56** — toda mensagem que afirma persistência é construída a partir de leitura pós-escrita.
- **P57** — descartar dado que a pessoa já deu é regressão de fluidez.

---

## 1. Decisões fechadas (Guilherme, v43)

| Decisão | Valor |
|---|---|
| Have-to-have | nome + quantidade por dose + horário |
| Nice-to-have | dosagem, estoque, tipo de tratamento |
| Momento da gravação | assim que os have-to-have existem, **antes** do estoque |
| `dosagem` não informada | grava `NULL` |
| `estoque` não informado | grava `NULL`, **nunca `0`** |
| Forma farmacêutica | derivada da unidade da dose, nunca perguntada |
| Resumo | **depois** do estoque, lido do banco, com "está tudo certo?" |
| Correção no resumo | continua dentro do fluxo |

---

## PARTE 1 — O roteamento para de descartar dados

### 1.1 `detectarIntencaoCadastro` ganha sinal estrutural

Hoje é só lista de substrings. Passa a reconhecer também a **forma** de uma posologia, de modo
determinístico — sem LLM, sem custo:

```js
// Sinal estrutural: uma linha que combina palavra + horário é posologia, mesmo sem
// nenhum verbo de cadastro. Cobre "Bariatron 12:00", "Fluoxetina 08:00 e 20:00",
// "losartana 8h", "omega 3 1cp as 13h" — o padrão real de quem chega listando remédios.
function pareceLinhaDePosologia(message) {
    const linhas = String(message).split('\n');
    const padraoHorario = /\b([01]?\d|2[0-3])\s*(:|h|hs|hrs|horas)\s*([0-5]\d)?\b/i;
    return linhas.some(linha => {
        const temHorario = padraoHorario.test(linha);
        const temPalavra = /[a-zà-ú]{4,}/i.test(linha);
        return temHorario && temPalavra;
    });
}
```

`detectarIntencaoCadastro` passa a devolver `termos.some(...) || pareceLinhaDePosologia(message)`.

**Falso positivo conhecido e aceito:** "me lembra da consulta às 14h" casaria. O custo é entrar
no cadastro e a pessoa dizer que não é remédio — o fluxo de recusa já existe e funciona. O custo
do falso negativo é o BUG-104.

### 1.2 O bloco `post_onboarding` para de passar contexto literal

Duas correções em `router.js:757-782`.

**(a) Quando a mensagem já traz os dados**, o contexto deixa de ser literal e a mensagem segue
inteira para o cadastro — que agora sabe extrair (Parte 4):

```js
    if (detectarIntencaoCadastro(message)) {
        const rCad = await despacharCadastro({
            user, message, image, state, historicoConversa, contextoProativo,
            context: { etapa: 'cad_nome', ...(state?.context?.rascunho_cadastro || {}) }
        });
```

**(b) Quando a mensagem é só um "sim"**, o dado estava na mensagem **anterior**. O `principal`
passa a guardar essa mensagem, e o "sim" a recupera:

```js
    } else if (isAffirmativeSimple(message)) {
        const mensagemRica = state?.context?.mensagem_rica || null;
        console.log(`💊 Roteando para cadastro (pós-onboarding, aceite)`
            + `${mensagemRica ? ' com mensagem rica preservada' : ''} — ${user.phone}`);
        const rCad = await despacharCadastro({
            user, message: mensagemRica || message, image, state, historicoConversa,
            contextoProativo, context: { etapa: 'cad_nome' }
        });
```

E no ramo do `principal`, guardar a mensagem quando ela tiver cara de posologia:

```js
            const exchanges = state?.context?.exchanges || 0;
            if (exchanges < 1) {
                await saveConversationState(user.id, {
                    state: 'post_onboarding',
                    context: {
                        exchanges: exchanges + 1,
                        mensagem_rica: pareceLinhaDePosologia(message) ? message : null
                    }
                });
            }
```

**Isto é o P57 em código:** a pessoa disse os remédios uma vez; o "sim" seguinte não pode fazê-la
repetir.

### 1.3 O rascunho sobrevive à saída do fluxo

`router.js:540` passa `contextoPreservado: null` ao escalar para fora do cadastro — é onde o
rascunho morre hoje. Passa a levar o contexto:

```js
    const escalada = await despacharEscalada({
        user, message, image, historicoConversa, contextoProativo,
        contextoPreservado: context || null,
        classificacaoPreResolvida: classificacao
    });
```

---

## PARTE 2 — O `principal` não promete o que não faz (MH-090, P56)

Acrescentar ao `buildSystemPrompt` de `src/agentes/principal.js`, no bloco de restrições:

```
VOCÊ NÃO CADASTRA MEDICAMENTOS. Não existe ação de cadastro no seu vocabulário.

Se a pessoa pedir para cadastrar um remédio, ou listar remédios com horários, você NUNCA
afirma que cadastrou, registrou, salvou, anotou ou organizou. Dizer que gravou algo que
você não gravou é a pior falha possível nesta conversa — a pessoa vai embora achando que
está protegida e não vai receber lembrete nenhum.

Nesse caso, faça exatamente isto: reconheça o que ela trouxe, cite os remédios que ela
listou, e ofereça começar o cadastro. Termine com uma pergunta de aceite.
Exemplo: "Vi que você toma Bariatron às 12h e Fluoxetina às 8h 💊 Quer que eu organize os
lembretes dos dois agora?"
```

O mesmo vale para qualquer agente: **nenhuma mensagem afirma persistência sem leitura
pós-escrita**. No cadastro isso vira código na Parte 3.

---

## PARTE 3 — Níveis de campo e gravação antecipada (MH-094)

### 3.1 Nova ordem em `primeiraEtapaFaltante`

`cadastro.js:1252`. O ramo líquido do estoque (MH-073 Parte C) fica **inteiro como está** —
só muda de posição na fila.

```js
function primeiraEtapaFaltante(ctx) {
    // HAVE-TO-HAVE: sem estes dois não existe lembrete.
    if (!ctx?.nome) return 'cad_nome';
    if (!ctx?.pares_posologia?.length) return 'cad_horarios';

    // Gravação acontece aqui, antes de qualquer campo opcional (MH-094).
    if (!ctx?.medication_id) return 'cad_gravar';

    // NICE-TO-HAVE: a partir daqui o medicamento já existe e já gera lembrete.
    if (ctx?.estoque_resolvido === null || ctx?.estoque_resolvido === undefined) {
        if (ctx?.unidade_estoque !== 'ml') return 'cad_estoque';
        if (!ctx?.status_frasco) return 'cad_estoque';
        if (ctx?.status_frasco === 'fechado') {
            return (ctx?.frascos && !ctx?.volume_frasco) ? 'cad_estoque_volume' : 'cad_estoque';
        }
        const fracaoOuValorConhecido = !!ctx?.estoque_fracao_pendente
            || (ctx?.estoque_valor_exato_pendente !== undefined && ctx?.estoque_valor_exato_pendente !== null);
        return (fracaoOuValorConhecido && !ctx?.volume_frasco) ? 'cad_estoque_volume' : 'cad_estoque_fracao';
    }

    return 'cad_confirmacao';
}
```

**Saem do caminho obrigatório:** `cad_dosagem`, `cad_confirma_forma`, `cad_tipo_tratamento`. As
três etapas continuam existindo no código — são alcançáveis por correção no resumo — mas nunca
são perguntadas por iniciativa da Nami.

- `forma_farmaceutica`: `derivarFormaFarmaceutica` já deriva da unidade da dose. Manter.
- `tipo_tratamento`: default `'continuo'`, que já é o default da coluna.
- `dosagem`: `NULL`.

### 3.2 `cad_gravar` não é etapa de conversa

É ação interna. Ao alcançá-la, o cadastro grava e **no mesmo turno** responde com a pergunta de
estoque. A pessoa nunca vê uma etapa chamada `cad_gravar`.

A mensagem desse turno é montada a partir da **leitura de volta** do registro criado, não do
rascunho (P56). Rascunho:

> Anotei a *Losartana* 💊
>
> Me fala quantos comprimidos você tem em casa hoje? Assim eu te aviso quando estiver
> acabando, pra você comprar antes de ficar sem.

O rótulo da unidade ("comprimidos", "frascos", "sachês", "gotas") vem de `templates/dose.js`,
que já sabe fazer isso. Não reimplementar.

### 3.3 `processarAcao` e `saveMedication` aceitam ausência

`cadastro.js:2835` passa `estoque: action.estoque || 0`. Com `|| 0`, "não informado" vira zero —
exatamente o colapso que o **P49** proíbe. Passa a ser:

```js
        dosagem: action.dosagem ?? null,
        estoque: action.estoque ?? null,
```

E `database.js:110`, em `saveMedication`:

```js
    const estoqueInformado = estoque !== null && estoque !== undefined;

    // ... no insert:
            estoque_atual: estoqueInformado ? 0 : null,
```

```js
    // O movimento de estoque só existe se houve estoque. Sem valor informado, não há
    // movimento a registrar e estoque_atual permanece NULL — "não sei" é diferente de
    // "acabou" (P49). O scheduler já testa `estoque_atual !== null` antes de bloquear.
    if (!estoqueInformado) {
        return { ...data, estoque_atual: null };
    }

    const { estoqueNovo } = await registrarMovimentoEstoque({ /* ...como hoje... */ });
    return { ...data, estoque_atual: estoqueNovo };
```

**Invariante preservado:** todo `medications.ativo = true` tem ao menos um `schedules` ativo. A
gravação só ocorre depois de `pares_posologia`, e `saveSchedule` roda no mesmo `processarAcao`.
Se o insert de schedules falhar, o medicamento precisa ser desativado — tratar o bloco inteiro
como uma unidade e, em caso de erro após o insert de `medications`, marcar `ativo = false` antes
de propagar o erro.

### 3.4 Os três ramos do estoque

| Resposta | Grava | Tom da resposta |
|---|---|---|
| "30 comprimidos" | `estoque_atual = 30`, movimento `cadastro_inicial` | confirma e diz que acompanha |
| "acho que uns 20" | `estoque_atual = 20`, `estoque_estimado = true` | aceita sem questionar, diz que dá pra ajustar depois é só pedir |
| "não sei" | `estoque_atual` permanece `NULL` | não insiste, explica o benefício em uma frase e segue |

`estoque_estimado` já existe como coluna e já é aceito por `saveMedication`. O classificador de
estoque já distingue valor exato de estimativa — **não criar classificador novo**.

### 3.5 O resumo é lido do banco

`cad_confirmacao` para de renderizar o rascunho e passa a ler o registro: o medicamento por
`medication_id` e seus `schedules` ativos. Se a leitura falhar, a Nami **não afirma** que gravou
— degrada com `degradar()` e pede para a pessoa conferir depois.

Rascunho:

> Ficou assim:
> 💊 *Losartana* — 1 comprimido
> ⏰ *8h e 20h*, todo dia
> 📦 *30 comprimidos* em casa
>
> Está tudo certo?

A linha de estoque só aparece se houver estoque. A linha de dosagem só aparece se houver
dosagem. O guia de composição do Adendo 2 já governa o formato.

---

## PARTE 4 — Correção passa a editar registro, não rascunho

**Este é o ponto de maior risco do bloco.** Hoje, corrigir no resumo altera o contexto e a
gravação acontece depois. Com a gravação antecipada, a linha já existe — corrigir o contexto
não muda mais nada no banco, e a Nami mostraria um resumo "corrigido" que não corresponde ao
registro. Seria o BUG-104 ao contrário.

**Novo ponto único de escrita em `database.js`:**

```js
// Atualiza campos simples de um medicamento já gravado. NUNCA escreve estoque_atual —
// estoque tem ponto único próprio (registrarMovimentoEstoque) e passar por aqui quebraria
// a trilha em stock_movements.
export async function atualizarMedicamentoCampos({ medicationId, campos }) {
    const permitidos = ['nome', 'dosagem', 'forma_farmaceutica', 'tipo_tratamento',
                        'tratamento_dias', 'tratamento_fim', 'unidade_dose',
                        'unidade_estoque', 'gotas_por_ml'];
    const patch = Object.fromEntries(
        Object.entries(campos).filter(([k, v]) => permitidos.includes(k) && v !== undefined)
    );
    if (!Object.keys(patch).length) return null;

    const { data, error } = await supabase
        .from('medications')
        .update(patch)
        .eq('id', medicationId)
        .select()
        .single();

    if (error) throw new Error(`Erro ao atualizar medicamento: ${error.message}`);
    return data;
}
```

No ramo `corrige` de `cad_confirmacao` (`cadastro.js:2455`), cada campo alvo passa a aplicar a
correção no registro:

| Campo alvo | Caminho |
|---|---|
| `nome`, `dosagem`, `tipo_tratamento` | `atualizarMedicamentoCampos` |
| horários e quantidade | `replaceMedication` com `horarios` — já existe e já refaz os schedules |
| `estoque` | `registrarMovimentoEstoque`, nunca update direto |

Depois de aplicar, **reler do banco** e remontar o resumo (P56). A pergunta "está tudo certo?"
se repete sobre o estado real.

O sub-estado do ramo líquido continua sendo resetado na correção de estoque, exatamente como
hoje (MH-073 Parte C) — não simplificar isso.

---

## PARTE 5 — Destravar o extrator multi-campo (MH-80)

`cadastro.js:2339`, em `calcularDecisaoEtapa`, o extrator roda apenas quando
`etapaAtual === 'cad_nome'`. O portão cai:

```js
    // MH-94: o extrator roda em QUALQUER etapa do cadastro. O segundo portão (mensagem
    // com dígito ou mais de 6 palavras) permanece — é o que evita chamada de LLM em
    // resposta curta de campo único.
    const mensagemRica = /\d/.test(message) || message.trim().split(/\s+/).length > 6;
    if (mensagemRica) {
        // ...extrairCadastroCompleto como hoje...
    }
```

**Regra que substitui a Fase 6 nesta rodada — obrigatória:**

```
O extrator SÓ preenche campo que está vazio no contexto. NUNCA sobrescreve campo já
preenchido. Corrigir um campo já coletado continua sendo exclusividade do fluxo de
correção do resumo.
```

Sem essa regra, "não, o outro é às 20h" no meio do fluxo sobrescreveria silenciosamente um
campo confirmado. Corrigir e continuar no mesmo turno permanece **não resolvido** até a Fase 6 —
limitação conhecida, registrada, não mascarada.

---

## 6. O que este briefing NÃO faz

- Não implementa múltiplos medicamentos numa mensagem (Fase 5). "Bariatron 12h e Fluoxetina 8h"
  cadastra **um** e a Nami oferece o próximo em seguida.
- Não funde os classificadores em um call `{ intencao, campos }` (Fase 6).
- Não toca no onboarding nem na LGPD (Fase 7).
- Não cria tabela, coluna nem migração. `atualizarMedicamentoCampos` é função nova em
  `database.js`, não mudança de schema.

---

## 7. Validação em staging

Apagar o usuário de teste entre rodadas com `SELECT delete_user_account('<uuid>');`.

| # | Teste | Esperado |
|---|---|---|
| 1 | "Quero cadastrar o ômega 3, tomo 1 cp às 13h e 1 cp às 21h" | grava na hora, pergunta estoque. **Não** pergunta dosagem |
| 2 | Conferir `medications` do teste 1 | 1 linha, `dosagem` NULL, `estoque_atual` NULL, 2 `schedules` ativos |
| 3 | Responder "30 comprimidos" | resumo lido do banco + "está tudo certo?" |
| 4 | Responder "não sei" no estoque | não insiste; `estoque_atual` continua NULL |
| 5 | Confirmar com "sim" | fecha, com o aviso de "ainda sendo construída" no primeiro medicamento |
| 6 | No resumo, dizer "na verdade é às 20h" | corrige **no banco**; resumo remontado mostra 20h |
| 7 | Reler `schedules` após o teste 6 | horário atualizado, sem schedule órfão |
| 8 | "Bariatron 12:00" como mensagem solta, sem verbo | entra no cadastro (sinal estrutural) |
| 9 | Pós-onboarding: listar remédios, `principal` responder, dizer "sim" | cadastro recebe a **mensagem original**, sem pedir para repetir |
| 10 | Abandonar no estoque e mandar "quais meus remédios?" | o remédio aparece na lista, com lembrete ativo |
| 11 | Sair do cadastro no meio e voltar | rascunho preservado, retoma de onde parou |
| 12 | Verificar `medications.ativo = true` sem schedules | **zero linhas** — invariante intacto |

Os testes 2, 6, 7 e 12 são de banco, não de conversa. Rodar os quatro antes de promover.

---

## 8. Backlog

- **BUG-104** → `em_validacao` (Partes 1 e 2)
- **MH-090** → `em_validacao` (Parte 2)
- **MH-094** → `em_validacao` (Partes 3 e 4)
- **MH-80** → nova parte, destravamento do portão (Parte 5)

Fases 5, 6 e 7 permanecem abertas e fora desta rodada.