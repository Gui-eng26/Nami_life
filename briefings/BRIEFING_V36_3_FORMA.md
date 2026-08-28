# BRIEFING v36 #3 — correção de forma farmacêutica no resumo

**Sessão:** v36 · **Arquivo único:** `src/agentes/cadastro.js` · **Sem migration.**
Terceiro e último briefing da sessão. Os #1 (posologia) e #2 (fluxo de estoque) já estão em
produção e validados.

---

## 0. Evidência

Bateria de 27/08, cadastro do Vivix:

```
17:30:49  Nami exibe resumo:  💉 Forma: cápsula
17:31:08  Usuário:            "Não é cápsula é comprimido"
17:31:18  classificarConfirmacaoCadastro -> corrige (campoAlvo: dosagem)
17:31:20  Nami:               "Anotado, comprimido! E qual é a DOSAGEM do Vivix?"
17:31:40  Nami exibe resumo:  💉 Forma: comprimido
17:31:47  Usuário:            "Sim"
17:31:56  Nami:               "Vivix foi cadastrado com sucesso"
```

**No banco:** `Vivix, forma_farmaceutica = "cápsula"`.

O usuário corrigiu a forma, viu a forma corrigida no resumo, confirmou — e o valor salvo é o
antigo. Divergência silenciosa entre o que foi mostrado e o que foi persistido; não há como o
usuário perceber.

(A troca de dosagem 5mg → 2mg no mesmo cadastro foi **intencional** do Guilherme, não é defeito.)

---

## 1. Causa raiz — três defeitos encadeados

### 1.1 `campoAlvo` não tem a categoria `forma` (Princípio 5 aplicado a outro inventário)

`classificarConfirmacaoCadastro` valida `campoAlvo` contra um conjunto fechado (linha ~1373):

```js
const camposValidos = new Set(['nome', 'dosagem', 'horarios', 'quantidade', 'tipo_tratamento', 'estoque']);
```

`forma` não está nele, e o prompt (linhas ~1311-1322) também não a lista. Mas o resumo **exibe**
a forma (`💉 Forma: ...`) — ou seja, o usuário vê um campo que não pode corrigir. O classificador
foi obrigado a escolher o vizinho mais próximo e devolveu `dosagem`.

Mesma disciplina do Princípio 5 (inventário do classificador central atualizado junto com toda
capacidade nova), aqui aplicada ao inventário de campos corrigíveis: **todo campo exibido no
resumo precisa existir no conjunto de campos corrigíveis.**

### 1.2 A correção foi roteada para `cad_dosagem` sem gravar nada

O `switch (classificacao.campoAlvo)` (linha ~2380) tem `case 'dosagem': return { proximaEtapa:
'cad_dosagem', contextUpdates: {} }`. Nenhum campo de forma foi tocado. A resposta *"Anotado,
comprimido!"* é invenção do LLM — nada foi anotado.

### 1.3 O LLM pode reescrever linhas não-numéricas do resumo

Verificado: entre os dois resumos, o único código executado foi `cad_dosagem`, que grava
exclusivamente `{ dosagem: c.valor }`. Nenhum caminho escreve `forma_explicita` ou
`forma_confirmada`. Como `renderizarResumo` deriva a forma só desses dois campos
(`derivarFormaFarmaceutica`, linha ~92), o texto renderizado em código dizia "cápsula" nas duas
vezes — **quem trocou para "comprimido" foi o LLM gerador.**

A instrução do `cad_confirmacao` (linha ~2612) diz *"nunca reescreva os números"*. Protege os
números, não as demais linhas. O LLM editou a linha da forma para acompanhar a correção do
usuário.

⚠️ Este ponto é **hipótese fortemente sustentada**, não fato provado: é a única origem possível
(nenhum código escreveu no campo), mas não temos o `resumoRenderizado` bruto daquele turno para
comparação direta. A correção 2.3 é barata e correta independentemente disso.

---

## 2. Correções

### 2.1 Acrescentar `forma` ao inventário de campos corrigíveis

Em `classificarConfirmacaoCadastro`:

```js
const camposValidos = new Set(['nome', 'dosagem', 'horarios', 'quantidade',
                               'tipo_tratamento', 'estoque', 'forma']);
```

E no prompt, na lista de campos e nos exemplos:

```
  nome, dosagem, horarios, quantidade, tipo_tratamento, estoque, forma
...
  "não é cápsula, é comprimido" -> forma
  "isso não é xarope" -> forma
```

Acrescentar também ao prompt a distinção explícita, porque `dosagem` e `forma` são justamente o
par que colidiu:

```
ATENÇÃO — dosagem e forma são campos DIFERENTES:
  dosagem = a concentração do medicamento (50mg, 0,5%, 100mg/ml)
  forma   = o formato farmacêutico (comprimido, cápsula, xarope, colírio, gotas, pomada, injetável)
"não é cápsula, é comprimido" corrige a FORMA, nunca a dosagem.
```

### 2.2 Tratar a correção de forma aproveitando a própria mensagem

Acrescentar ao `switch (classificacao.campoAlvo)`:

```js
case 'forma': {
    // A mensagem de correção quase sempre JÁ contém a forma certa ("não é cápsula, é
    // comprimido"). Aproveitá-la evita um turno inteiro de repergunta — mesmo raciocínio
    // da MH-073 Parte C.1 e do Princípio 1.
    const forma = await extrairFormaDaMensagem(message, historicoConversa);
    if (forma) {
        return {
            proximaEtapa: 'cad_confirmacao',
            contextUpdates: { forma_explicita: forma, forma_confirmada: forma }
        };
    }
    // Sem forma reconhecível na mensagem, pergunta — sem inventar valor.
    return { proximaEtapa: 'cad_confirma_forma', contextUpdates: {} };
}
```

**Criar `extrairFormaDaMensagem(message, historicoConversa)`** — classificador dedicado, LLM,
conjunto fechado `FORMAS_VALIDAS` (`comprimido, capsula, colirio, gotas, pomada, injetavel,
xarope`) ou `null`. Mesmo padrão dos demais: `temperature: 0`, `max_tokens` baixo, `degradar()`
no catch com fallback `null`, e linha `🔎 [CAD-CLASSIF]` (v36 #1, seção 3.4). **Nunca lista de
palavras** — é a mensagem livre do usuário.

**Gravar nos DOIS campos** (`forma_explicita` e `forma_confirmada`): `derivarFormaFarmaceutica` lê
`forma_explicita` primeiro, e `SAVE_MEDICATION` (linha ~2926) persiste os dois. Gravar só um
deixaria o outro divergente para consultas futuras.

⚠️ **NÃO derivar nem alterar `unidade_dose` a partir da forma corrigida.** `forma_farmaceutica` é
puramente descritiva (decisão de arquitetura da v33); `unidade_dose`/`unidade_estoque` são as
chaves comportamentais e já foram resolvidas antes no fluxo. Uma correção de rótulo não pode
recalcular posologia nem estoque em silêncio. Se o usuário corrigir a forma para algo incoerente
com a unidade já coletada (ex: "é xarope" num cadastro com `unidade_dose = 'unidade'`), a forma é
gravada assim mesmo e a incoerência fica visível no resumo para ele corrigir — não silenciamos e
não inferimos.

### 2.3 Blindar o resumo inteiro, não só os números

Na instrução do `cad_confirmacao` (linha ~2612), trocar:

> "Insira EXATAMENTE este resumo (é dado de saúde renderizado em código, nunca reescreva os
> números)"

por:

> "Insira EXATAMENTE este resumo, palavra por palavra, sem alterar NENHUMA linha — nem números,
> nem nomes, nem a forma, nem o estoque. É dado de saúde renderizado em código. Se o usuário
> acabou de pedir uma correção, o resumo abaixo JÁ reflete o estado atual do sistema: não
> ajuste nada por conta própria."

A última frase existe porque foi exatamente esse o gatilho — o LLM "consertou" o resumo para
acompanhar a correção que o usuário tinha acabado de pedir.

---

## 3. Fora de escopo

- `cad_horarios` com pergunta renderizada em código (deferido do #2, próximo da fila).
- Correção pós-resumo descartando o conteúdo da mensagem nos **demais** campos (`estoque`,
  `nome`, `tipo_tratamento`) — o `case 'forma'` resolve só o campo desta correção. O padrão geral
  fica registrado como MH.
- Classificador unificado de estoque líquido (Frente 2).
- MH-073 Parte C.2 (ramo `indeterminado` do status de frasco).

---

## 4. Verificação após implementar

```bash
node --check src/agentes/cadastro.js
grep -n "extrairFormaDaMensagem" src/agentes/cadastro.js     # 1 def + 1 uso
grep -n "'forma'" src/agentes/cadastro.js                    # camposValidos + case
grep -c "CAD-CLASSIF" src/agentes/cadastro.js                # deve ser 10 (era 9)
grep -n "sem alterar NENHUMA linha" src/agentes/cadastro.js  # instrução nova
```

---

## 5. Cenários de validação em produção

1. **Cadastro de sólido, corrigir a forma no resumo** com "não é cápsula é comprimido" →
   esperado: resumo volta em UM turno com `Forma: comprimido`, sem perguntar dosagem; após
   confirmar, conferir no banco que `forma_farmaceutica = 'comprimido'`. **Este é o cenário
   central** — foi o que falhou com o Vivix.
2. **Corrigir a forma sem dizer qual** ("a forma está errada") → esperado: pergunta qual é
   (`cad_confirma_forma`), sem inventar valor.
3. **Corrigir a dosagem** ("na verdade é 10mg") → não-regressão: continua indo para
   `cad_dosagem`, não para forma.
4. **Corrigir forma num líquido** ("não é xarope, é gotas") → esperado: forma gravada como
   `gotas`; conferir que `unidade_dose` e `unidade_estoque` permanecem inalterados e que o
   estoque no resumo não muda de valor.
5. **Conferir no banco, em todos os cenários acima**, que `forma_farmaceutica` bate exatamente
   com a última linha `💉 Forma:` que o usuário confirmou. É a verificação que expôs o defeito.