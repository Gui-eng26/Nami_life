# BRIEFING — v43 Bloco C, Adendo 1: estoque não informado é um estado, não zero

**Sessão:** v43 (18/09/2026)
**Branch:** `staging`
**Arquivos:** `src/database.js`, `src/templates/estoqueTemplates.js`,
`src/agentes/relatorios.js`, `src/agentes/principal.js`, `src/agentes/lembrete.js`,
`src/agentes/data_nascimento.js`, `src/agentes/cadastro.js`
**Depende de:** Bloco C, implementado e validado em staging

Auto-contido.

---

## 0. Evidência e causa raiz

**Teste real, staging 18/09 08:58.** Losartana cadastrada sem estoque (o usuário respondeu "não
sei"). Na primeira confirmação de dose, a Nami respondeu:

> ⚠️ *Atenção:* você acabou de tomar a última dose do *Losartana* disponível. Não esqueça de
> providenciar a recompra!

O usuário nunca informou estoque nenhum. A Nami afirmou que ele acabou.

**Causa raiz: o Bloco C criou um estado novo e legítimo — `medications.estoque_atual = NULL`,
"não informado" — e nenhum consumidor da coluna foi ensinado sobre ele.** Antes do Bloco C esse
estado não existia, porque `saveMedication` sempre gravava um número. O código a jusante é de
antes dessa possibilidade.

A cadeia, em `database.js:1689`:

```js
const diasRestantes = Math.floor(Number(med.estoque_atual) / consumoDiario);
```

`Number(null)` é `0`. Daí em diante tudo é internamente coerente e tudo está errado:
`diasRestantes = 0` → `calcularAlertaEstoque` devolve `true` (regra do "último comprimido") →
`classificarNivelEstoquePorDias` recebe `novoEstoque = null`, e `null <= 0` é `true` → nível
`zerado` → template da última dose.

Isto é o **P49** literal: nulo colapsado em zero. O princípio já existia; o código que o viola é
anterior ao nulo ser possível.

**Não é um bug isolado.** Cinco consumidores tratam `NULL` como zero. Quatro ainda não
apareceram porque esses caminhos não foram testados:

| Arquivo | Linha | Comportamento hoje com NULL |
|---|---|---|
| `database.js` `getEstoqueInfoParaAlerta` | 1689, 1694 | "última dose" — **o caso observado** |
| `database.js` `getEstoqueStatusSimples` | 1715 | classifica como esgotado |
| `relatorios.js` | 371 | lista o remédio como acabado no relatório de estoque |
| `principal.js` | 221 | injeta `estoque: null` no prompt |
| `lembrete.js` → `buildAlertaEstoqueNaoInformado` | 174 | "Seu estoque atual é de *null* unidades" |

---

## 1. Correção arquitetural — um único portão

Em vez de cada consumidor testar nulo por conta própria (o que garante que o sexto consumidor,
escrito daqui a dois meses, vai esquecer), **`getEstoqueInfoParaAlerta` passa a distinguir o
estado na origem** e a devolvê-lo explicitamente.

`database.js:1680` em diante:

```js
    if (!med) return null;

    const { consumoDiario, dosesPerDia } = await calcularConsumoDiario(medicationId);
    if (dosesPerDia === 0 || consumoDiario <= 0) return null;

    // P49: NULL é "nunca informado", não "acabou". Nunca colapsar num número —
    // Number(null) é 0 e produz o alerta de última dose para quem nunca contou
    // o estoque. Quem consome este retorno decide pelo estoqueDesconhecido,
    // nunca por diasRestantes.
    const estoqueDesconhecido = med.estoque_atual === null || med.estoque_atual === undefined;

    return {
        medNome: med.nome,
        medForma: med.forma_farmaceutica,
        estoqueDesconhecido,
        novoEstoque: estoqueDesconhecido ? null : med.estoque_atual,
        dosesPerDia,
        consumoDiario,
        diasRestantes: estoqueDesconhecido ? null : Math.floor(Number(med.estoque_atual) / consumoDiario),
        tipo_tratamento: med.tipo_tratamento || 'continuo',
        tratamento_dias: med.tratamento_dias || null
    };
```

**Barreira em `classificarNivelEstoquePorDias`** (`database.js:1743`), para que nenhum chamador
futuro consiga produzir "zerado" a partir de nulo:

```js
export function classificarNivelEstoquePorDias({ novoEstoque, diasRestantes }) {
    if (novoEstoque === null || novoEstoque === undefined) return 'desconhecido';  // P49
    if (novoEstoque <= 0) return 'zerado';
    if (diasRestantes === 0) return 'urgente';
    return 'ok';
}
```

---

## 2. A nova mensagem — convite, não alerta

Novo template em `src/templates/estoqueTemplates.js`:

```js
// Estoque nunca informado (MH-094 / P49). NÃO é alerta de falta: a Nami não sabe
// quanto existe, então não afirma nada sobre a quantidade. É um convite a completar
// o cadastro, com o benefício explícito.
export function buildConviteEstoqueNaoCadastrado({ medNome, medForma }) {
    const rotulo = rotuloDaUnidade(medForma, 2);   // "comprimidos", "frascos", "sachês"
    return (
        `\n\n📦 Ainda não tenho o estoque do *${medNome}* cadastrado.\n` +
        `Me diz quantos ${rotulo} você tem em casa e eu te aviso quando estiver acabando, ` +
        `pra você comprar antes de ficar sem.`
    );
}
```

Reaproveitar o rótulo de unidade que já existe em `templates/dose.js` — **não reimplementar**.
Se a função exportada tiver outro nome, usar a de lá.

O guia de composição (`composicao.js`) governa o formato: um item, um emoji, sem negrito
excessivo.

---

## 3. Onde o convite entra, e com que frequência

Três chamadores de `getEstoqueInfoParaAlerta` emitem alerta pós-confirmação: `principal.js:355`
e `:390`, e `router.js:99` e `:675`. Em todos, o ramo novo vem **antes** do cálculo de alerta:

```js
                const estoqueInfo = await getEstoqueInfoParaAlerta(medId);
                if (estoqueInfo?.estoqueDesconhecido) {
                    const confirmacoesDoDia = await contarConfirmacoesHoje(medId);
                    if (confirmacoesDoDia <= 1) {
                        alertaEstoque = buildConviteEstoqueNaoCadastrado(estoqueInfo);
                    }
                } else if (estoqueInfo) {
                    // ...cálculo de alerta como hoje...
                }
```

**Frequência: só na primeira confirmação do dia.** Reaproveita `contarConfirmacoesHoje`, que já
é importada nesses arquivos e já governa a mesma decisão para a faixa de 1 a 5 dias. Quem toma
duas doses por dia recebe o convite uma vez, não duas.

**Decisão fechada (Guilherme, v43):** o convite sai na primeira confirmação de dose de cada dia
e **persiste enquanto `estoque_atual` for `NULL`** — não é uma aparição única. No momento em que
o estoque recebe um valor, o convite cessa e o fluxo normal de alerta de estoque passa a valer,
sem nenhum tratamento especial.

O convite vive apenas no caminho da **confirmação de dose**. Não entra no lembrete agendado, não
entra na cobrança de dose não confirmada.

---

## 4. Os outros quatro consumidores

**`getEstoqueStatusSimples`** (`database.js:1715`):

```js
    if (med.estoque_atual === null || med.estoque_atual === undefined) {
        return { medNome: med.nome, estoqueAtual: null, status: 'desconhecido' };
    }
```

Quem consumir `status` precisa tratar `'desconhecido'` sem afirmar quantidade.

**`relatorios.js:371`**, no relatório de estoque — ramo próprio antes dos demais:

```js
        if (m.estoque_atual === null || m.estoque_atual === undefined) {
            msg += `📦 *${m.nome}* — estoque não informado (me diga quantos você tem e eu acompanho)\n`;
        } else if (m.estoque_atual <= 0) {
```

**`principal.js:221`**, na lista de medicamentos injetada no prompt:

```js
            const estoqueTexto = (m.estoque_atual === null || m.estoque_atual === undefined)
                ? 'estoque: não informado'
                : `estoque: ${m.estoque_atual}`;
```

E acrescentar ao prompt do `principal`, junto das restrições:

```
Quando o estoque de um medicamento aparecer como "não informado", você NUNCA diz que ele
acabou, está baixo ou está em falta — você não sabe a quantidade. Se for relevante,
convide a pessoa a informar quantos ela tem em casa.
```

**`lembrete.js:174`** — `buildAlertaEstoqueNaoInformado` (a mensagem de dose não confirmada)
não pode citar quantidade quando não há. Quando `estoqueInfo.estoqueDesconhecido` for `true`,
usar a mensagem de dose não confirmada **sem** o bloco de estoque. O convite do item 2 não entra
aqui: a pessoa não confirmou a dose, não é hora de pedir outro dado.

---

## 5. Ajuste de copy — dosagem no exemplo

Em `data_nascimento.js`, no bloco `nasc_fechamento`, e em `cadastro.js`, onde o exemplo do
primeiro medicamento aparece, o exemplo passa de:

```
Por exemplo: Losartana, 1 comprimido, 8h e 20h
```

para:

```
Por exemplo: Losartana 50mg, 1 comprimido, 8h e 20h
```

A dosagem continua **nice-to-have** — nada passa a exigi-la, nada bloqueia sem ela. O exemplo só
mostra que ela cabe, e o extrator multi-campo já a captura quando vem.

---

## 6. Ajuste de copy — a pergunta de estoque perdeu o porquê

Evidência, staging 08:52 e 08:54: a pergunta saiu como "Quantas unidades de Omega 3 você tem
agora?". O desenho acordado na v43 era proativo e explicava o benefício, e o rótulo deve ser da
forma farmacêutica, não "unidades".

O bloco da etapa de estoque, no primeiro pedido, passa a instruir:

```
  Peça o estoque explicando o BENEFÍCIO na mesma frase, e use o rótulo da forma
  farmacêutica (comprimidos, frascos, sachês, gotas), nunca a palavra "unidades".
  Exemplo: "Me fala quantos comprimidos de Losartana você tem em casa hoje? Assim eu te
  aviso quando estiver acabando, pra você comprar antes de ficar sem."
```

---

## 7. O que este adendo NÃO faz

- Não cria coluna, tabela nem migração.
- Não muda quando o medicamento é gravado nem o que é have-to-have.
- Não toca no scheduler: ele já testa `estoque_atual !== null` corretamente, desde antes.
- Não altera `registrarMovimentoEstoque`: continua sendo o ponto único de escrita de estoque, e
  o primeiro valor informado gera o movimento `cadastro_inicial` normalmente.

---

## 8. Validação em staging

| # | Teste | Esperado |
|---|---|---|
| 1 | Cadastrar remédio, responder "não sei" no estoque, confirmar a dose | convite para informar o estoque. **Nunca** "última dose" |
| 2 | Confirmar a segunda dose do mesmo dia | sem convite repetido |
| 2b | Primeira confirmação do dia seguinte, estoque ainda nulo | convite aparece de novo — ele persiste |
| 3 | Cadastrar com 30 comprimidos e confirmar dose | alerta normal, como sempre foi |
| 4 | Cadastrar com 1 comprimido e confirmar dose | "última dose" — este alerta continua existindo e correto |
| 5 | "quais meus remédios?" com estoque nulo | "estoque não informado", nunca zero nem acabado |
| 6 | Relatório de estoque com um remédio nulo e outro com 30 | dois ramos distintos, nenhum falso "acabou" |
| 7 | Não confirmar uma dose de remédio com estoque nulo, esperar o follow-up | cobrança da dose **sem** frase de estoque, sem "null" |
| 8 | Informar o estoque depois ("comprei 30") | grava, gera movimento `cadastro_inicial`, alertas voltam ao normal |
| 9 | Fechamento da data de nascimento | exemplo agora com "Losartana 50mg" |
| 10 | Pergunta de estoque | explica o benefício e usa "comprimidos", não "unidades" |

O teste 4 é o que protege contra o conserto exagerado: o alerta de última dose **precisa**
continuar funcionando para quem tem estoque de verdade.

---

## 9. Backlog

- **MH-094** permanece em validação até este adendo passar — o estado nulo é parte da mesma
  entrega, não item novo.
- Registrar, se Guilherme autorizar: **P58 — todo estado novo de coluna exige varredura dos
  consumidores existentes antes do merge.** O Bloco C introduziu `NULL` corretamente e cinco
  leitores ficaram para trás; a lição não é sobre estoque, é sobre a varredura.