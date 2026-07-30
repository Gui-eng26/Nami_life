# BRIEFING — v26 #2: barreira de forma no ponto de envio

**Sessão:** v26 (30/07/2026)
**Escopo:** uma mudança, em um arquivo. `src/whatsapp.js`.
**Tipo:** captação. **Nenhum fluxo conversacional é alterado. Nenhuma correção de defeito.**

⚠️ **O BUG-069 NÃO é corrigido aqui e permanece `aberto`.** Este briefing instrumenta a classe de
defeito à qual ele pertence; não conserta o turno perdido. A correção da L473 do `router.js` foi
avaliada e **deliberadamente deixada de fora** — ver "Por que só a barreira" abaixo.

---

## O que se quer capturar

Ocorrência real, 28/07/2026 21:01 BRT (`agent_log e9cbd89b`): o objeto
`{ escalarParaRoteador: true }` chegou em `sendTextMessage` onde se esperava string. A Z-API
respondeu 400, `sendTextMessage` lançou, o catch global respondeu *"Desculpe, tive um probleminha
aqui. Pode repetir o que você disse?"* e o usuário perdeu o turno.

O que ficou registrado em `system_events`: **um evento dizendo `AxiosError 400`.** Nada sobre
estrutura interna ter alcançado o ponto de saída, nada sobre a forma do que vazou. Para quem for
triar depois, é indistinguível de uma instabilidade de rede da Z-API.

Precedente da mesma classe: BUG-067 (27/07), em arquivo diferente e por causa diferente. Dois casos
em dois dias de "estrutura de controle interna alcança o ponto de saída".

---

## Por que só a barreira, e não a correção da L473

Registrado aqui porque a decisão foi discutida e revista mais de uma vez nesta sessão.

| | o que muda para o usuário | risco de regressão |
|---|---|---|
| **Barreira** (este briefing) | **nada** — hoje o objeto já vira 400 → throw → catch global → mensagem educada; com a barreira o caminho é o mesmo, só barra antes | **zero** |
| **Interceptar a L473** (fora) | recebe resposta do principal e o estado vai para `idle` em vez de erro | real — se a escalada dupla for transitória, hoje o contexto da configuração sobrevive e repetir funciona; com a correção o contexto é descartado |

O fluxo de escalada do `configuracao` foi construído deliberadamente para resolver becos sem saída
(ex.: usuário corrige o medicamento no meio do fluxo — *"não, é do cataflam"*). Mexer nele exige
contrapartida de evidência que hoje não existe: **1 ocorrência em todo o histórico**
(`SELECT count(*) FROM agent_logs WHERE agent_response LIKE '%escalarParaRoteador%'` → 1).

A barreira resolve isso pela ordem certa: instrumenta primeiro, decide depois. Se ela disparar até
o beta, existe evidência para justificar o trade-off da L473. Se não disparar, o BUG-069 se
responde sozinho e pode ser fechado como irrelevante na prática.

---

## A edição

Em `src/whatsapp.js`, **localizar**:

```js
export async function sendTextMessage(phone, message) {
    try {
        const cleanPhone = phone.replace(/\D/g, '');
```

**Substituir por:**

```js
export async function sendTextMessage(phone, message) {
    // BARREIRA DE FORMA (v26) — instrumenta a classe "estrutura de controle interna alcança o
    // ponto de saída" (BUG-067 em 27/07, BUG-069 em 28/07, arquivos e causas diferentes).
    //
    // NÃO muda o comportamento: um valor não-string já falha hoje, com 400 na Z-API → throw →
    // catch global → mensagem educada ao usuário. A barreira produz o MESMO desfecho, só que
    // registrando a forma exata do que vazou em vez de um AxiosError 400 mudo.
    //
    // FORA do try de propósito: dentro, o catch da Z-API registraria um SEGUNDO evento para o
    // mesmo defeito, com fingerprint diferente, poluindo a fila de triagem.
    //
    // Rejeita APENAS não-string. String vazia NÃO é barrada: seria mudança de comportamento
    // real (hoje segue para a Z-API) e não há nenhuma evidência de que ocorra.
    if (typeof message !== 'string') {
        const forma = message === null ? 'null'
            : message === undefined ? 'undefined'
            : typeof message === 'object' ? `object:${Object.keys(message).join(',').slice(0, 100)}`
            : typeof message;

        console.error(`❌ [BARREIRA] sendTextMessage recebeu payload inválido — forma: ${forma}`);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            agent: 'whatsapp',
            origem: 'outro',
            titulo: 'Payload inválido em sendTextMessage (não-string)',
            payload: { forma, tipo_js: typeof message }
        });
        throw new TypeError(`sendTextMessage: message deve ser string (recebeu ${forma})`);
    }

    try {
        const cleanPhone = phone.replace(/\D/g, '');
```

### Três decisões embutidas

1. **Título fixo, não `tituloEstavel()`.** Aqui não existe objeto `Error` de onde derivar classe.
   O título já é estável por construção; a variação útil (`forma`) fica no `payload`, fora do
   fingerprint. Todas as ocorrências agrupam num fingerprint só — que é o desejado, porque a
   pergunta a responder é "isso está acontecendo?" e não "de quantos jeitos?".
2. **`severidade: 'alta'`.** O usuário perde o turno. Não é `critica` porque não há informação de
   saúde incorreta — ele recebe uma mensagem de erro honesta.
3. **`payload` guarda só a FORMA.** Tipo do valor e, se objeto, os **nomes das chaves**. Nunca o
   conteúdo: o texto de saída da Nami pode conter nome de usuário e de medicamento. Nomes de chave
   (`escalarParaRoteador`) não são dado pessoal e são exatamente o que identifica o defeito —
   invariante de LGPD da v22.

---

## Riscos

1. **`throw` em 7 call sites fora do `catch_global`** (4 em `scheduler.js`, 3 em `lembrete.js`).
   Verificado: `sendReminder` e `sendGroupedReminder` têm `try/catch` individual — um throw **não
   aborta o lote**. Contido por chamada.
2. **Lembrete não registrado se a barreira disparar no scheduler.** O throw ocorre antes do
   `createDoseLog`, então a dose não é gravada e o stored procedure devolve o mesmo medicamento no
   ciclo seguinte. **Idêntico ao que já acontece hoje** com o 400 da Z-API — não é comportamento
   novo.
3. **Evento duplo por incidente** no caminho do `agent.js`: a barreira registra um evento e o
   `catch_global` registra outro (`Exceção não tratada (agent): TypeError`). Aceito — precisão vale
   mais que economia de linha, e o volume histórico (1 ocorrência) não justifica engenharia para
   suprimir.
4. **`agent_logs` continua gravando o objeto serializado** quando isso acontecer, porque a barreira
   está depois do `logAgentInteraction` (princípio 24). Resíduo conhecido, não corrigido aqui.

---

## Checklist para o Claude Code

1. Aplicar a edição em `src/whatsapp.js`. Conferir que `registrarEvento` já está importado (está —
   é usado no catch da Z-API).
2. `node --check src/whatsapp.js`.
3. Conferir que **nenhum outro arquivo** foi tocado: `git diff --stat` deve mostrar exatamente 1
   arquivo. **Não alterar `router.js`.**
4. Conferir que a barreira ficou **fora** do bloco `try`: `grep -n "BARREIRA" -A 25 src/whatsapp.js`
   deve mostrar o `throw new TypeError` antes da linha `try {`.
5. `git add -A && git commit && git push`.
6. **Nenhuma escrita em `backlog_items`** — os registros entram no encerramento da v26.

---

## Validação

**Teste direto, opcional, com o número do próprio Guilherme.** Script temporário fora de `src/`:

```js
import 'dotenv/config';
import { sendTextMessage } from '../src/whatsapp.js';
try {
    await sendTextMessage('+55SEUNUMERO', { escalarParaRoteador: true });
    console.log('❌ FALHOU: a barreira não bloqueou');
} catch (e) {
    console.log('✅ barreira funcionou:', e.message);
}
```

Se a barreira estiver correta, **nada é enviado** e a exceção é `TypeError`. Se estiver quebrada,
chega uma mensagem estranha no WhatsApp do Guilherme — por isso o número dele, e não o de um
usuário. Conferir depois:

```sql
SELECT created_at, severidade, titulo, payload FROM system_events
WHERE titulo LIKE 'Payload inválido%' ORDER BY created_at DESC LIMIT 5;
```

Esperado: `payload.forma = 'object:escalarParaRoteador'`.

Apagar o script em seguida, não commitar.

**Não-regressão:** qualquer conversa normal pelo WhatsApp. Se as mensagens chegam, a barreira não
está barrando string legítima.

---

## Registrado para o encerramento da v26 (não executar aqui)

- **BUG-069** permanece `aberto`. Acrescentar às notas: a correção da L473 foi avaliada na v26 e
  adiada por falta de evidência de volume (1 ocorrência) contra risco real de regressão no fluxo de
  escalada do `configuracao`. Instrumentado pela barreira. **Gatilho de reavaliação:** o evento
  `Payload inválido em sendTextMessage` aparecer em produção.
- **Item novo a registrar** — o defeito a montante, que foi o que realmente acionou o caminho em
  28/07:

  > O classificador central interpreta resposta curta contra o turno anterior errado, porque o
  > lembrete proativo do `scheduler.js` não é escrito em `agent_logs` e portanto não existe no
  > `historicoConversa`. Em 28/07 21:01 o usuário respondeu `"S"` a um lembrete das 20:58; o
  > histórico visível ao classificador era a conversa de configuração de 6 minutos antes (pausar
  > lembretes do Ômega 3), e a mensagem foi roteada para `configuracao`. Consequência: a dose não
  > foi confirmada e o usuário recebeu dois follow-ups cobrando o que já havia respondido.
  >
  > Evidência do contraste — em 30/07 15:48 (`agent_log b3a73e23`) o mesmo `"S"`, também em `idle`,
  > foi roteado para `principal` e confirmou a dose corretamente; a diferença é que o histórico
  > recente não continha conversa de outro domínio. O defeito é **condicional ao histórico
  > enviesado**, o que explica 1 ocorrência em todo o período.
  >
  > `agent_log_id` de evidência: `e9cbd89b-5fc8-4642-a80a-8d2562198c5e` (falhou),
  > `b3a73e23-aca6-4ed4-b1e3-73436ddea48e` (funcionou).
  >
  > Nota: `detectarConfirmacaoDose("S")` devolve `false` e isso **não é o defeito** — o caminho
  > previsto (classificador → principal, cujo system prompt trata afirmação curta como
  > CONFIRM_DOSE) funciona, como prova o caso de 30/07.