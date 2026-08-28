# BRIEFING — MH-081: exibir a quantidade da dose nos lembretes e follow-ups

**Sessão:** v37 · **Data:** 28/08/2026
**Item:** MH-081 (`backlog_items`, status `aberto`, prioridade `alta`)
**Relacionado:** MH-073 Parte D (recorte), MH-078 (fora de escopo)

---

## 0. Resumo em uma frase

Acrescentar a quantidade da dose (`schedules.quantidade_por_dose`) ao texto dos 4 lembretes
e follow-ups, com o rótulo de unidade derivado deterministicamente de `medications.unidade_dose`
e `medications.forma_farmaceutica`, através de um módulo novo que é ponto único.

**Não há migration. Não há chamada de LLM. Os 4 textos já são determinísticos puros.**

---

## 1. Contexto e decisões já tomadas (não relitigar)

### 1.1 Por que é um recorte do MH-073 Parte D

A descrição do MH-073 Parte D contém, textualmente: *"Inclui exibir quantidade_por_dose no texto
do lembrete (a RPC já expõe o campo)"*. Guilherme decidiu (v37) executar o MH-081 como **recorte**:
4 textos determinísticos, superfície de regressão pequena, validável numa bateria curta. O Parte D
continua aberto para os ~30 pontos restantes (`prompts.js`, `cadastro.js`, `estoqueTemplates.js`,
`relatorios.js`, `principal.js`, `configuracao.js`, `adesaoTemplates.js`) e **herdará o módulo
criado aqui** em vez de reimplementar a formatação.

### 1.2 Sítio de aplicação está FORA (MH-078)

`"2 gotas em cada olho"` é gravado como `quantidade_por_dose = 4`. O classificador
(`cadastro.js`, REGRA 2, linhas 872-879) devolve apenas `multiplicador_aplicado: true|false` —
um booleano, **nunca o nome do sítio**. `"em cada olho"` e `"nos dois ouvidos"` produzem saída
idêntica. Além disso `multiplicadorAplicado` (montado em `cadastro.js:1031`) **não tem nenhum
consumidor** no projeto inteiro e nunca é persistido.

Logo: **exibir o total (`Quantidade: 4 gotas`) é o comportamento correto deste item.** Exibir
`"2 gotas em cada olho"` exigiria criar o dado, e isso é o MH-078.

### 1.3 A quantidade é ADIÇÃO — nada é removido nem reordenado

Decisão explícita de Guilherme: a estrutura atual do lembrete permanece intacta. O campo
`med_dosagem` (concentração) **continua onde está**. Nenhuma linha existente é reescrita ou
reordenada.

**Formato da adição (decisão revista em 28/08, substitui a "opção B" discutida antes):** a
quantidade entra em **linha própria**, com o rótulo literal `Quantidade: `, imediatamente
abaixo da linha que nomeia o medicamento e **sem linha em branco entre as duas**. Motivo:
no WhatsApp o rótulo em linha separada é mais legível para o público-alvo do que um terceiro
trecho concatenado com travessão na mesma frase — que é o que a versão anterior deste briefing
propunha.

Exemplo alvo, dado por Guilherme:

```
⏰ Olá, Guilherme!

Hora do seu *Atenolol* — 50mg.
Quantidade: 2 cápsulas

Já tomou? Responda *SIM* ou *NÃO* 💊
```

O rótulo `Quantidade:` é **texto simples, sem negrito** — o negrito já está no nome do
medicamento e competiria com ele.

### 1.4 Fora de escopo, declarado

- `buildEstoqueZeradoMessage` (`scheduler.js:412`) — decisão de Guilherme: não entra.
- `relatorios.js:403` (`proximo_remedio`) — relatório sob demanda, não lembrete proativo → Parte D.
- Sanitização de `medications.dosagem` — não é este item.
- Notificação a cuidador (`lembrete.js`) — mensagem para outro telefone, não é lembrete de dose.

---

## 2. Dado disponível hoje — verificado, não suposto

### 2.1 Lembretes: completo, sem mudança de query

`get_pending_reminders()` (verificada em `pg_proc` em 28/08/2026) já retorna:

```
schedule_id, medication_id, user_id, phone, user_name, med_nome, med_dosagem,
horario, estoque_atual, estoque_minimo, quantidade_por_dose, unidade_dose,
unidade_estoque, gotas_por_ml, forma_farmaceutica
```

A MH-073 Parte A (v33) já pagou essa conta. **NÃO alterar esta função.**

### 2.2 Follow-ups: falta ampliar o `select`

`getPendingFollowUps()` (`database.js:574`) hoje seleciona apenas
`medications (id, nome, dosagem, forma_farmaceutica, user_id, users(...))` — não traz
`unidade_dose` e não entra em `schedules`.

O FK `dose_logs_schedule_id_fkey` existe (verificado em `pg_constraint`), então o embed
aninhado funciona.

### 2.3 Conjunto fechado de `unidade_dose`

CHECK verificado em `pg_constraint`:

```sql
medications_unidade_dose_check: unidade_dose IN ('unidade', 'ml', 'gota')
```

Determinístico e confiável. **É ele que governa a categoria do rótulo.**

`forma_farmaceutica` **não** é conjunto fechado e já tem deriva em produção (`capsula` e
`cápsula` convivendo, além de `efervescente`). Pelo Princípio 45 ela é descritiva —
aqui ela escolhe **apenas o substantivo**, nunca o número nem a categoria. Divergência
produz texto estranho, jamais quantidade errada.

---

## 3. Arquivo novo — `src/templates/dose.js`

Ponto único de formatação (Princípio 30). Módulo **puro**: sem I/O, sem `await`, sem import de
`database.js` nem de `observabilidade.js`. Isso é o que o torna testável isoladamente e
reutilizável pela Parte D.

Criar o arquivo com **exatamente** este conteúdo:

```js
// ============================================================
// QUANTIDADE DA DOSE — ponto único de formatação (MH-081, Princípio 30).
//
// Regra de categoria: unidade_dose (conjunto fechado, CHECK no schema) decide o TIPO
// do rótulo. forma_farmaceutica escolhe apenas o SUBSTANTIVO quando a dose é contável,
// e só isso — ela é descritiva e tem deriva conhecida em produção (Princípio 45).
// Divergência de forma produz texto estranho, nunca quantidade errada.
//
// Módulo puro: sem I/O. A decisão de registrar degradação quando a quantidade não pode
// ser resolvida pertence ao call site (ver seção 6 do BRIEFING_MH081.md).
// ============================================================

// Normaliza para comparação: minúsculas, sem acento, sem espaço nas pontas.
// Produção tem 'capsula' e 'cápsula' na mesma base — sem isso, uma das duas cairia
// no fallback genérico.
function normalizarForma(forma) {
    if (typeof forma !== 'string') return '';
    return forma
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

// Substantivo para dose CONTÁVEL (unidade_dose === 'unidade').
// Conjunto fechado e deliberadamente curto: só formas cujo substantivo é inequívoco.
// Qualquer outra forma (pomada, injetavel, efervescente, null...) cai em 'unidade(s)' —
// texto genérico, nunca errado. Refinar formas adicionais é escopo do MH-073 Parte D.
const SUBSTANTIVO_CONTAVEL = {
    'comprimido': { singular: 'comprimido', plural: 'comprimidos' },
    'capsula':    { singular: 'cápsula',    plural: 'cápsulas' }
};

const SUBSTANTIVO_CONTAVEL_PADRAO = { singular: 'unidade', plural: 'unidades' };

// Formata o número em pt-BR: inteiro sem casas decimais, fracionário com vírgula
// e sem zeros à direita. 2 -> "2" · 2.0 -> "2" · 0.5 -> "0,5" · 2.50 -> "2,5"
function formatarNumero(n) {
    if (Number.isInteger(n)) return String(n);
    return String(n).replace(/0+$/, '').replace('.', ',');
}

/**
 * Devolve o rótulo da quantidade da dose, ou null quando não é possível formatar.
 *
 * null significa "não sei", e o chamador OMITE o trecho — nunca substitui por 1.
 * Colapsar "não sei" com uma quantidade legítima é o Princípio 49.
 *
 * @returns {string|null} ex: "2 comprimidos" · "1 cápsula" · "5 ml" · "4 gotas" · "0,5 comprimido"
 */
export function formatarQuantidadeDose({ quantidade, unidade_dose, forma_farmaceutica }) {
    // Number(null) === 0 e Number(undefined) === NaN — os dois precisam cair fora,
    // e quantidade 0 não é dose válida (CHECK schedules_quantidade_por_dose_check > 0).
    if (quantidade === null || quantidade === undefined) return null;
    const n = Number(quantidade);
    if (!Number.isFinite(n) || n <= 0) return null;

    const numero = formatarNumero(n);

    // 'ml' é símbolo de unidade: nunca pluraliza. "1 ml", "5 ml", "2,5 ml".
    if (unidade_dose === 'ml') return `${numero} ml`;

    if (unidade_dose === 'gota') {
        return `${numero} ${n > 1 ? 'gotas' : 'gota'}`;
    }

    // unidade_dose === 'unidade' (ou ausente/desconhecido — mesmo tratamento seguro)
    const chave = normalizarForma(forma_farmaceutica);
    const termo = SUBSTANTIVO_CONTAVEL[chave] || SUBSTANTIVO_CONTAVEL_PADRAO;
    return `${numero} ${n > 1 ? termo.plural : termo.singular}`;
}

/**
 * Devolve a LINHA pronta para concatenar na mensagem — quebra de linha + rótulo —
 * ou string vazia quando não há quantidade a exibir.
 *
 * Existe para que os 4 call sites não repitam o mesmo ternário: se o rótulo, o
 * separador ou o recuo mudarem, mudam em um lugar só (Princípio 30).
 *
 * @param {string} [opcoes.indentacao] recuo aplicado antes do rótulo. Usado só nas
 *        mensagens agrupadas, onde a quantidade é sub-linha de um item de lista.
 *
 * @returns {string} ex: "\nQuantidade: 2 cápsulas" · "\n  Quantidade: 5 ml" · ""
 */
export function linhaQuantidadeDose(args, { indentacao = '' } = {}) {
    const rotulo = formatarQuantidadeDose(args);
    return rotulo ? `\n${indentacao}Quantidade: ${rotulo}` : '';
}
```

---

## 4. Alteração 1 — `src/database.js`, `getPendingFollowUps()`

**Localização:** linha 574.

Substituir o `select` e o bloco de normalização. Estado atual:

```js
        .select(`
            *,
            medications (
                id, nome, dosagem, forma_farmaceutica, user_id,
                users (id, phone, name)
            )
        `)
```

Passa a ser:

```js
        .select(`
            *,
            medications (
                id, nome, dosagem, forma_farmaceutica, unidade_dose, user_id,
                users (id, phone, name)
            ),
            schedules!dose_logs_schedule_id_fkey (
                quantidade_por_dose
            )
        `)
```

E o `return` normalizado, hoje:

```js
    return (data || []).map(log => ({
        ...log,
        med_nome: log.medications?.nome,
        med_dosagem: log.medications?.dosagem,
        med_forma: log.medications?.forma_farmaceutica,
        user_id: log.medications?.user_id,
        phone: log.medications?.users?.phone,
        user_name: log.medications?.users?.name
    }));
```

Passa a ser:

```js
    return (data || []).map(log => ({
        ...log,
        med_nome: log.medications?.nome,
        med_dosagem: log.medications?.dosagem,
        med_forma: log.medications?.forma_farmaceutica,
        med_unidade_dose: log.medications?.unidade_dose ?? null,
        // MH-081: null quando dose_logs.schedule_id é nulo (ver seção 6).
        // NUNCA usar ?? 1 aqui — null e 1 têm significados diferentes (Princípio 49).
        quantidade_por_dose: log.schedules?.quantidade_por_dose ?? null,
        user_id: log.medications?.user_id,
        phone: log.medications?.users?.phone,
        user_name: log.medications?.users?.name
    }));
```

⚠️ **Ponto de verificação obrigatório (seção 8, item V1).** O hint explícito
`!dose_logs_schedule_id_fkey` está ali porque `dose_logs` tem dois FKs e a inferência
automática do PostgREST pode ficar ambígua. Se o embed retornar erro, **NÃO** improvisar
uma segunda query dentro do `map` (seriam N queries por ciclo de cron): reportar e parar.

⚠️ **Consumidor único confirmado:** `getPendingFollowUps` é chamada apenas em
`scheduler.js:checkAndSendFollowUps`. Ampliar o `select` é aditivo. Confirmar com o grep V2.

---

## 5. Alteração 2 — os 4 textos

### Invariante de posicionamento

**A quantidade aparece sempre em linha própria, com o rótulo `Quantidade: `, imediatamente
abaixo da linha que nomeia o medicamento, sem linha em branco entre as duas.**

Nas mensagens agrupadas (lista de bullets), a mesma regra vale por item, com recuo de 2
espaços — a quantidade é sub-linha do item, nunca um bullet próprio.

Nenhuma linha existente é reescrita, reordenada ou removida. A quebra de linha já vem embutida
no retorno de `linhaQuantidadeDose` — **não acrescentar `\n` no call site**, senão sobra uma
linha em branco quando a quantidade é omitida.

### 5.1 `src/scheduler.js` — `buildReminderMessage` (linha 400)

Import no topo do arquivo (junto do import de `verbos.js` que já existe):

```js
import { linhaQuantidadeDose } from './templates/dose.js';
```

Função, estado atual:

```js
function buildReminderMessage(firstName, reminder) {
    const dosagem = reminder.med_dosagem
        ? ` — ${reminder.med_dosagem}`
        : '';
    const verbo = verboDoMedicamento(reminder.forma_farmaceutica);

    return `⏰ Olá, ${firstName}!\n\nHora do seu *${reminder.med_nome}*${dosagem}.\n\n${verbo.imperativoPergunta} Responda *SIM* ou *NÃO* 💊`;
}
```

Passa a ser:

```js
function buildReminderMessage(firstName, reminder) {
    const dosagem = reminder.med_dosagem
        ? ` — ${reminder.med_dosagem}`
        : '';
    // MH-081: get_pending_reminders faz JOIN direto em schedules — a quantidade
    // vem sempre nos lembretes, por construção. Não há caso de omissão aqui.
    // A quebra de linha já vem de linhaQuantidadeDose — não acrescentar \n aqui.
    const quantidade = linhaQuantidadeDose({
        quantidade: reminder.quantidade_por_dose,
        unidade_dose: reminder.unidade_dose,
        forma_farmaceutica: reminder.forma_farmaceutica
    });
    const verbo = verboDoMedicamento(reminder.forma_farmaceutica);

    return `⏰ Olá, ${firstName}!\n\nHora do seu *${reminder.med_nome}*${dosagem}.${quantidade}\n\n${verbo.imperativoPergunta} Responda *SIM* ou *NÃO* 💊`;
}
```

⚠️ O `${quantidade}` entra **depois do ponto final** da frase do medicamento e **antes** do
`\n\n` que já existia. O ponto final não se move e nenhuma outra pontuação muda.

### 5.2 `src/scheduler.js` — `buildGroupedReminderMessage` (linha 243)

Alterar **apenas** o `map` da lista. Estado atual:

```js
    const lista = grupo.map(r => {
        const dosagem = r.med_dosagem ? ` — ${r.med_dosagem}` : '';
        return `• *${r.med_nome}*${dosagem}`;
    }).join('\n');
```

Passa a ser:

```js
    const lista = grupo.map(r => {
        const dosagem = r.med_dosagem ? ` — ${r.med_dosagem}` : '';
        // MH-081: sub-linha do item, recuo de 2 espaços — nunca um bullet próprio.
        const quantidade = linhaQuantidadeDose({
            quantidade: r.quantidade_por_dose,
            unidade_dose: r.unidade_dose,
            forma_farmaceutica: r.forma_farmaceutica
        }, { indentacao: '  ' });
        return `• *${r.med_nome}*${dosagem}${quantidade}`;
    }).join('\n');
```

⚠️ **NÃO tocar** em `verboDoGrupo`, na chave de agrupamento, nem no restante da mensagem.

### 5.3 `src/agentes/lembrete.js` — `buildFollowUpMessage` (linha 19)

Aqui a quantidade **pode** ser nula (seção 6). Por isso ela é resolvida no handler `async`
e chega pronta como parâmetro — a função de texto continua síncrona e pura.

Import no topo:

```js
import { linhaQuantidadeDose } from '../templates/dose.js';
import { degradar } from '../observabilidade.js';
```

Assinatura e corpo, estado atual:

```js
function buildFollowUpMessage(tentativa, reminder) {
    const nome = reminder.user_name
        ? reminder.user_name.split(' ')[0]
        : 'você';
    const remedio = reminder.med_nome || 'seu remédio';
    const verbo = verboDoMedicamento(reminder.med_forma);

    if (tentativa === 2) {
        return (
            `⏰ ${nome}, só passando para lembrar!\n\n` +
            `Ainda não vi sua confirmação do *${remedio}*.\n` +
            `${verbo.imperativoPergunta} Responda *SIM* ou *NÃO* 💊`
        );
    }

    if (tentativa === 3) {
        return (
            `💊 ${nome}, último aviso de hoje!\n\n` +
            `Seu *${remedio}* ainda está aguardando confirmação.\n` +
            `${capitalize(verbo.passado)}? É só responder *SIM* ou *NÃO* 🌿`
        );
    }

    // Fallback seguro (não deveria ser chamado fora de tentativa 2 ou 3)
    return `💊 ${nome}, lembrete do *${remedio}*. ${verbo.imperativoPergunta} Responda *SIM* ou *NÃO*`;
}
```

Passa a ser (novo 3º parâmetro `quantidade`, com default `''` para não quebrar
nenhum chamador que ainda não passe):

```js
function buildFollowUpMessage(tentativa, reminder, quantidade = '') {
    const nome = reminder.user_name
        ? reminder.user_name.split(' ')[0]
        : 'você';
    const remedio = reminder.med_nome || 'seu remédio';
    const verbo = verboDoMedicamento(reminder.med_forma);

    if (tentativa === 2) {
        return (
            `⏰ ${nome}, só passando para lembrar!\n\n` +
            `Ainda não vi sua confirmação do *${remedio}*.${quantidade}\n` +
            `${verbo.imperativoPergunta} Responda *SIM* ou *NÃO* 💊`
        );
    }

    if (tentativa === 3) {
        return (
            `💊 ${nome}, último aviso de hoje!\n\n` +
            `Seu *${remedio}* ainda está aguardando confirmação.${quantidade}\n` +
            `${capitalize(verbo.passado)}? É só responder *SIM* ou *NÃO* 🌿`
        );
    }

    // Fallback seguro (não deveria ser chamado fora de tentativa 2 ou 3)
    return `💊 ${nome}, lembrete do *${remedio}*.${quantidade} ${verbo.imperativoPergunta} Responda *SIM* ou *NÃO*`;
}
```

⚠️ Em todos os ramos o `${quantidade}` entra **depois do ponto final** da frase e **antes**
do `\n` que já separava aquela linha da pergunta. Quando a quantidade é omitida (`''`), a
mensagem fica byte a byte idêntica à atual.

Em `handleFollowUp`, dentro do ramo `if (tentativa <= 3)`, **antes** da linha
`const message = buildFollowUpMessage(...)`, inserir a resolução da quantidade e trocar
a chamada:

```js
        if (tentativa <= 3) {
            // MH-081: a quantidade vem de dose_logs.schedule_id. Quando o vínculo é nulo
            // (recadastro do medicamento via replaceMedication apaga e recria os schedules,
            // e o FK é ON DELETE SET NULL), OMITIMOS o trecho em vez de assumir 1.
            // Assumir 1 afirmaria posologia que o sistema não pode sustentar (Princípio 49).
            let quantidade = linhaQuantidadeDose({
                quantidade: reminder.quantidade_por_dose,
                unidade_dose: reminder.med_unidade_dose,
                forma_farmaceutica: reminder.med_forma
            });
            if (!quantidade) {
                quantidade = await degradar({
                    origem: 'lembrete',
                    motivo: 'quantidade_dose_indisponivel',
                    agent: 'lembrete',
                    userId: reminder.user_id ?? null,
                    detalhe: {
                        dose_log_id: doseLog.id,
                        medication_id: doseLog.medication_id,
                        schedule_id: doseLog.schedule_id ?? null,
                        horario_agendado: doseLog.horario_agendado ?? null
                    },
                    fallback: ''
                });
            }

            const message = buildFollowUpMessage(tentativa, reminder, quantidade);
```

O restante do bloco (`sendTextMessage`, `updateDoseLogTentativa`, `updateDoseLogZapiMessageId`,
`registrarEventoProativo`, `console.log`) fica **exatamente como está**.

⚠️ `degradar()` devolve o `fallback` na mesma chamada que registra o evento — é assim que o
Princípio 31 é respeitado. Não substituir por `console.warn` + `''`.

### 5.4 `src/scheduler.js` — `buildGroupedFollowUpMessage` (linha 302)

Mesma situação da 5.3: a quantidade pode ser nula, e o handler é `async`.

Assinatura e lista, estado atual:

```js
function buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo) {
    const verbo = verboDoGrupo(grupo.map(r => r.med_forma));
    const lista = grupo.map(r => `• *${r.med_nome}*`).join('\n');
```

Passa a ser (recebe um `Map` de `dose_log id → trecho de quantidade`):

```js
function buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo, quantidadePorItem = new Map()) {
    const verbo = verboDoGrupo(grupo.map(r => r.med_forma));
    const lista = grupo.map(r => `• *${r.med_nome}*${quantidadePorItem.get(r.id) || ''}`).join('\n');
```

O restante do corpo da função fica inalterado.

Em `handleGroupedFollowUp`, **antes** da linha `const message = buildGroupedFollowUpMessage(...)`,
montar o mapa e trocar a chamada:

```js
        // MH-081: omissão é POR ITEM — se 2 de 3 resolverem, os 2 exibem e o terceiro
        // fica só com o nome. Nunca assumir 1 para o item que não resolveu.
        const quantidadePorItem = new Map();
        for (const item of grupo) {
            let trecho = linhaQuantidadeDose({
                quantidade: item.quantidade_por_dose,
                unidade_dose: item.med_unidade_dose,
                forma_farmaceutica: item.med_forma
            }, { indentacao: '  ' });
            if (!trecho) {
                trecho = await degradar({
                    origem: 'lembrete',
                    motivo: 'quantidade_dose_indisponivel',
                    agent: 'scheduler',
                    userId: item.user_id ?? null,
                    detalhe: {
                        dose_log_id: item.id,
                        medication_id: item.medication_id,
                        schedule_id: item.schedule_id ?? null,
                        horario_agendado: item.horario_agendado ?? null,
                        agrupado: true
                    },
                    fallback: ''
                });
            }
            quantidadePorItem.set(item.id, trecho);
        }

        const message = buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo, quantidadePorItem);
```

Imports a acrescentar no topo de `scheduler.js`:

```js
import { linhaQuantidadeDose } from './templates/dose.js';
```

(um único import, compartilhado pelas seções 5.1, 5.2 e 5.4)

E `degradar` no import já existente de `./observabilidade.js` (que hoje traz
`registrarEvento, tituloEstavel`):

```js
import { registrarEvento, tituloEstavel, degradar } from './observabilidade.js';
```

---

## 6. Alteração 3 — catálogo de degradação

Em `src/observabilidade.js`, dentro do objeto `DEGRADACOES` (começa na linha 62), acrescentar
a entrada nova. Colocar após `'contexto_proativo:query_falhou'`:

```js
    'lembrete:quantidade_dose_indisponivel': {
        severidade: 'baixa',
        titulo: 'Quantidade da dose indisponível no follow-up — trecho omitido da mensagem'
    },
```

**Por que `baixa`:** o usuário recebe exatamente a mensagem que recebia antes do MH-081.
Não há perda de função nem risco de saúde — o valor do evento é sinalizar que
`dose_logs.schedule_id` foi anulado, o que hoje só acontece via `replaceMedication`
(`database.js:211`, `delete().eq('medication_id', ...)` seguido de recriação).

**Por que existe evento e não só omissão silenciosa:** Princípio 29 — caminho que entrega ao
usuário um texto diferente do pretendido registra. Sem isso, a omissão seria invisível.

---

## 7. Saída esperada — dados reais de produção (28/08/2026)

Renderizações que a bateria de validação deve produzir. Os 4 primeiros são medicamentos ativos
reais no banco hoje.

### 7.1 Rótulo por medicamento

Os 4 primeiros são medicamentos ativos reais no banco hoje.

| Medicamento | `dosagem` | `forma` | `unidade_dose` | `qtd` | Linha de quantidade |
|---|---|---|---|---|---|
| Fortix | `2mg` | `cápsula` | `unidade` | 2 | `Quantidade: 2 cápsulas` |
| Betaistina | `48mg` | `capsula` (sem acento) | `unidade` | 1 | `Quantidade: 1 cápsula` |
| Elani | `0,03mg` | `comprimido` | `unidade` | 1 | `Quantidade: 1 comprimido` |
| Ômega 3 (13:00) | `null` | `comprimido` | `unidade` | 1 | `Quantidade: 1 comprimido` |
| Xarope (líquido) | — | `xarope` | `ml` | 5 | `Quantidade: 5 ml` |
| Colírio (líquido) | — | `colírio` | `gota` | 4 | `Quantidade: 4 gotas` |

⚠️ **Betaistina é o caso que prova a normalização.** A forma está gravada como `capsula`, sem
acento. Sem `normalizarForma`, ela cairia no fallback e sairia `1 unidade` em vez de `1 cápsula`.

### 7.2 Mensagens completas

Lembrete individual, com concentração:

```
⏰ Olá, Guilherme!

Hora do seu *Fortix* — 2mg.
Quantidade: 2 cápsulas

Já tomou? Responda *SIM* ou *NÃO* 💊
```

Lembrete individual, sem concentração (`dosagem` nula):

```
⏰ Olá, Guilherme!

Hora do seu *Ômega 3*.
Quantidade: 1 comprimido

Já tomou? Responda *SIM* ou *NÃO* 💊
```

Follow-up individual, tentativa 2:

```
⏰ Guilherme, só passando para lembrar!

Ainda não vi sua confirmação do *Fortix*.
Quantidade: 2 cápsulas
Já tomou? Responda *SIM* ou *NÃO* 💊
```

Follow-up individual, tentativa 3:

```
💊 Guilherme, último aviso de hoje!

Seu *Vitamina C* ainda está aguardando confirmação.
Quantidade: 1 comprimido
Tomou ou usou? É só responder *SIM* ou *NÃO* 🌿
```

Lembrete agrupado (2 medicamentos, mesmo horário) — quantidade como **sub-linha recuada** de
cada item, nunca bullet próprio:

```
⏰ Guilherme, hora dos seus remédios das *07:00*! 💊

• *Elani* — 0,03mg
  Quantidade: 1 comprimido
• *Repoflor* — 2mg
  Quantidade: 1 cápsula

✅ Já tomou todos? Responda *SIM*
💬 Tomou só alguns? Me diga quais (ex: "só o Elani")
```

Follow-up agrupado:

```
⏰ Guilherme, só passando para lembrar!

Ainda não vi sua confirmação dos remédios das *07:00*:
• *Elani*
  Quantidade: 1 comprimido
• *Repoflor*
  Quantidade: 1 cápsula

✅ Já tomou todos? Responda *SIM*
💬 Tomou só alguns? Me diga quais 🌿
```

### 7.3 Caso de omissão (follow-up com `schedule_id` nulo)

A mensagem fica **byte a byte idêntica à de hoje** — sem linha em branco sobrando, sem rótulo
vazio:

```
⏰ Guilherme, só passando para lembrar!

Ainda não vi sua confirmação do *Fortix*.
Já tomou? Responda *SIM* ou *NÃO* 💊
```

---

## 8. Verificação obrigatória — comandos, não lista de pontos

Rodar **todos** e relatar a saída de cada um (Princípio 31, corolário).

**V1 — o embed do follow-up funciona.** Criar `scripts/verificar_mh081.js` (script de leitura,
não commitar mudança de comportamento):

```js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
    .from('dose_logs')
    .select(`
        id, schedule_id, horario_agendado,
        medications ( nome, forma_farmaceutica, unidade_dose ),
        schedules!dose_logs_schedule_id_fkey ( quantidade_por_dose )
    `)
    .not('schedule_id', 'is', null)
    .limit(5);

if (error) {
    console.error('❌ EMBED FALHOU:', error.message);
    process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
```

Critério: retorna linhas com `schedules.quantidade_por_dose` preenchido. Se falhar, **parar e
reportar** — não improvisar query dentro do `map`.

**V2 — `getPendingFollowUps` tem consumidor único.**
```
grep -rn "getPendingFollowUps" src/
```
Esperado: 2 linhas (a definição em `database.js`, o import+uso em `scheduler.js`).

**V3 — nenhum substantivo de unidade hardcoded nos 2 arquivos de mensagem.**
```
grep -nE "comprimido|cápsula|capsula|gotas?|\bml\b|unidades?" src/scheduler.js src/agentes/lembrete.js
```
Esperado: **zero ocorrências**. Todo substantivo vive em `src/templates/dose.js`.

**V3b — o rótulo `Quantidade:` existe em um lugar só.**
```
grep -rn "Quantidade:" src/
```
Esperado: **exatamente 1 ocorrência**, em `src/templates/dose.js`. Se aparecer nos call sites,
o rótulo foi duplicado e a próxima mudança de texto vai divergir (Princípio 30).

**V4 — `templates/dose.js` é puro.**
```
grep -nE "supabase|await|import .*database|import .*observabilidade" src/templates/dose.js
```
Esperado: zero ocorrências.

**V5 — nenhum `?? 1` ou `|| 1` introduzido nos caminhos de quantidade.**
```
grep -rnE "quantidade_por_dose\s*(\?\?|\|\|)\s*1" src/
```
Esperado: zero ocorrências. (Princípio 49 — `null` e `1` não podem colidir.)

**V6 — sintaxe.**
```
node --check src/templates/dose.js
node --check src/scheduler.js
node --check src/agentes/lembrete.js
node --check src/database.js
node --check src/observabilidade.js
```

**V7 — teste da função pura.** Criar `scripts/testar_dose_template.js` e rodar:

```js
import { formatarQuantidadeDose, linhaQuantidadeDose } from '../src/templates/dose.js';

const casos = [
    [{ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: 'cápsula' },   '2 cápsulas'],
    [{ quantidade: 1, unidade_dose: 'unidade', forma_farmaceutica: 'capsula' },   '1 cápsula'],
    [{ quantidade: 1, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' },'1 comprimido'],
    [{ quantidade: 3, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' },'3 comprimidos'],
    [{ quantidade: 0.5, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, '0,5 comprimido'],
    [{ quantidade: 5, unidade_dose: 'ml', forma_farmaceutica: 'xarope' },         '5 ml'],
    [{ quantidade: 1, unidade_dose: 'ml', forma_farmaceutica: 'xarope' },         '1 ml'],
    [{ quantidade: 2.5, unidade_dose: 'ml', forma_farmaceutica: 'xarope' },       '2,5 ml'],
    [{ quantidade: 4, unidade_dose: 'gota', forma_farmaceutica: 'colírio' },      '4 gotas'],
    [{ quantidade: 1, unidade_dose: 'gota', forma_farmaceutica: 'colírio' },      '1 gota'],
    [{ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: 'efervescente' }, '2 unidades'],
    [{ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: null },        '2 unidades'],
    [{ quantidade: '2', unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, '2 comprimidos'],
    [{ quantidade: null, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, null],
    [{ quantidade: undefined, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, null],
    [{ quantidade: 0, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, null]
];

// Formato da LINHA — a quebra vem embutida, o rótulo é fixo, e a omissão é string vazia.
const casosLinha = [
    [
        [{ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: 'cápsula' }, undefined],
        '\nQuantidade: 2 cápsulas'
    ],
    [
        [{ quantidade: 1, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, { indentacao: '  ' }],
        '\n  Quantidade: 1 comprimido'
    ],
    [
        [{ quantidade: null, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, undefined],
        ''
    ],
    [
        [{ quantidade: null, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, { indentacao: '  ' }],
        ''
    ]
];

let falhas = 0;
for (const [entrada, esperado] of casos) {
    const obtido = formatarQuantidadeDose(entrada);
    const ok = obtido === esperado;
    if (!ok) falhas++;
    console.log(`${ok ? '✅' : '❌'} ${JSON.stringify(entrada)} -> ${JSON.stringify(obtido)} (esperado ${JSON.stringify(esperado)})`);
}
for (const [[args, opcoes], esperado] of casosLinha) {
    const obtido = linhaQuantidadeDose(args, opcoes);
    const ok = obtido === esperado;
    if (!ok) falhas++;
    console.log(`${ok ? '✅' : '❌'} linha ${JSON.stringify(args)} ${JSON.stringify(opcoes || {})} -> ${JSON.stringify(obtido)} (esperado ${JSON.stringify(esperado)})`);
}
console.log(falhas === 0 ? '\n✅ 20/20' : `\n❌ ${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);
```

Critério: 20/20.

- Os três casos de `formatarQuantidadeDose` com `null`, `undefined` e `0` são o Princípio 49 —
  se algum devolver `'1 comprimido'` ou `'0 comprimidos'`, o trabalho não está concluído.
- Os dois últimos casos de `linhaQuantidadeDose` garantem que a omissão devolve **string vazia
  pura**, sem `\n` solto — é o que impede uma linha em branco sobrando na mensagem quando a
  quantidade não pôde ser resolvida.

---

## 9. Não-regressão — o que NÃO pode ser tocado

1. **`get_pending_reminders`** — nenhuma alteração. Nenhuma migration nesta entrega.
2. **`agruparPorUsuarioEHorario`** e a chave `(user_id + horário)` — a mudança é só na string
   de cada linha da lista. O BUG-066 (drift de timestamp) não é escopo e não pode ser tocado.
3. **`verboDoMedicamento` / `verboDoGrupo`** (BUG-100, validado v34) — o verbo continua vindo
   **só** de `forma_farmaceutica`. A quantidade entra em outro slot. **Não fundir os dois
   discriminadores.**
4. **`zapi_message_id`** — agrupados gravam `NULL` de propósito (MH-032). Inalterado.
5. **Ordem `sendTextMessage` → `createDoseLog` → `registrarEventoProativo`** — inalterada. A
   montagem da mensagem é anterior a tudo isso.
6. **`buildEstoqueZeradoMessage`** — fora de escopo por decisão de Guilherme. Não tocar.
7. **`medications.dosagem`** continua sendo exibida onde já é. Nada é removido.
8. **`resolverQuantidadePorDose`** (`database.js:388`) — **não alterar e não reusar aqui.**
   Ela existe para o débito de estoque, precisa ser total e por isso devolve 1 no degrau 4.
   Esse comportamento está correto para calcular e errado para exibir.

---

## 10. Checklist de conclusão

- [ ] `src/templates/dose.js` criado, puro, com `formatarQuantidadeDose` + `linhaQuantidadeDose`
- [ ] `getPendingFollowUps` com `unidade_dose` + embed de `schedules`, sem `?? 1`
- [ ] `buildReminderMessage` com a linha de quantidade após o ponto final
- [ ] `buildGroupedReminderMessage` com sub-linha recuada por item
- [ ] `buildFollowUpMessage` com 3º parâmetro + resolução em `handleFollowUp`
- [ ] `buildGroupedFollowUpMessage` com `Map` + resolução em `handleGroupedFollowUp`
- [ ] Entrada `lembrete:quantidade_dose_indisponivel` no catálogo `DEGRADACOES`
- [ ] V1 a V7 (incluindo V3b) rodados, saída de cada um relatada
- [ ] `git add/commit/push`

---

## 11. Instrução final ao Claude Code

Se algum trecho deste briefing estiver incorreto ou incompleto ao ser confrontado com o código
real, **corrija e reporte no resumo** em vez de copiar literalmente. Esse comportamento foi
correto nas v34, v35 e v36 e deve ser mantido — nas últimas quatro sessões o defeito nasceu da
especificação, não da implementação.

Ponto de atenção específico deste briefing: a sintaxe do embed `schedules!dose_logs_schedule_id_fkey`
não pôde ser testada no chat de planejamento (só há acesso a SQL direto, não ao SDK). O FK foi
verificado em `pg_constraint`, mas o comportamento do PostgREST é o item V1 justamente por isso.