# BRIEFING — v43 Bloco A: fila por usuário + janela de agregação (MH-040 A + B)

**Sessão:** v43 (17/09/2026)
**Branch:** `staging`
**Arquivos:** `src/filaTurnos.js` (novo), `src/index.js`, `src/scheduler.js`
**Pré-requisito de:** todas as fases seguintes da jornada de chegada (CONTEXT.md §11.11)

Auto-contido. Todo código e texto literal está embutido.

---

## 0. Evidência e causa raiz

**Sintoma (Ciclo 2, 10 dias de beta):** 5 dos 19 usuários (26%) mandaram um pensamento
fragmentado em mensagens seguidas e receberam N respostas independentes, cada uma decidindo
sobre um estado já obsoleto.

**Causa raiz confirmada por leitura de código (v42, CONTEXT.md §6 item 12 e §11.2 item 1):**
`src/index.js` responde 200 ao webhook e dispara `handleIncomingMessage` sem nenhuma
serialização. A única proteção existente é o dedupe de `messageId` idêntico, que protege
contra webhook duplicado da Z-API — **não** contra mensagens diferentes em sequência do
mesmo usuário.

São **dois problemas distintos**, e a ordem importa:

1. **Concorrência de turnos** — dois turnos do mesmo `user_id` rodando ao mesmo tempo, cada um
   lendo `conversation_state` antes de o outro persistir. Corrigido pela **fila** (MH-040 B).
2. **Fragmentação** — o usuário recebe N respostas para um pensamento só. Corrigido pela
   **janela de agregação** (MH-040 A).

A janela pressupõe a fila. Implementar as duas juntas, nesta ordem dentro do mesmo módulo.

---

## 1. Decisões fechadas (não relitigar durante a implementação)

| Decisão | Valor | Origem |
|---|---|---|
| Janela de agregação | 5 segundos, ajustável por variável de ambiente | Guilherme, v42 |
| Latência introduzida | aceita explicitamente | Guilherme, v42 |
| Tipo de janela | **fixa a partir da primeira mensagem**, não deslizante | v43 (ver 2.3) |
| Lembrete agendado com janela aberta | **entra na fila e espera** o turno corrente fechar; nunca fura | Guilherme, v43 |
| Chave da fila | `phone` | v43 |
| Escopo da fila | em memória, no processo | v43 — validado: Railway com **1 réplica** em produção e em staging, serverless desligado nos dois |

**Restrição que precisa virar linha no CONTEXT.md:** a fila em memória só é correta enquanto
o serviço roda com **1 réplica**. Subir para 2+ réplicas, ou ligar serverless, invalida a
solução silenciosamente — sem erro, sem log, só o bug de volta. Registrar em §6.

---

## 2. Novo módulo `src/filaTurnos.js`

Módulo único, sem I/O de banco, responsável por duas coisas: encadear execuções por usuário e
agrupar mensagens que chegam juntas.

### 2.1 Cabeçalho e estado

```js
// ============================================================
// FILA POR USUÁRIO + JANELA DE AGREGAÇÃO (MH-040 A + B)
// Serializa turnos do mesmo usuário e agrupa mensagens fragmentadas.
// Estado em memória do processo: correto apenas com 1 réplica (ver CONTEXT.md §6).
// ============================================================

const JANELA_MS = Number(process.env.JANELA_AGREGACAO_MS || 5000);
const MAX_FRAGMENTOS = 10;

const cadeias = new Map();   // phone -> Promise (cauda da fila)
const janelas = new Map();   // phone -> buffer aberto
```

### 2.2 Fila — `enfileirar`

```js
export function enfileirar(phone, job, rotulo = 'turno') {
    const anterior = cadeias.get(phone) || Promise.resolve();

    const atual = anterior
        .catch(() => {})              // falha de um job NUNCA trava a fila do usuário
        .then(() => {
            console.log(`🔒 [FILA] Executando ${rotulo} — ${phone}`);
            return job();
        });

    cadeias.set(phone, atual);

    atual.catch(() => {}).finally(() => {
        if (cadeias.get(phone) === atual) cadeias.delete(phone);  // libera memória ao drenar
    });

    return atual;
}
```

**Invariantes obrigatórios:**
- Um job que lança exceção não pode impedir a execução do próximo job do mesmo usuário.
- A entrada do Map só é removida quando a cauda drena, nunca no meio da cadeia — daí a
  comparação `cadeias.get(phone) === atual`.
- Usuários diferentes **nunca** são serializados entre si.

### 2.3 Janela — `agregar`

Janela **fixa**: o relógio começa na primeira mensagem e não é reiniciado pelas seguintes.
Latência máxima previsível de `JANELA_MS`. A alternativa deslizante (reiniciar o timer a cada
mensagem) agrupa melhor quem digita devagar, mas não tem teto de latência — se for necessária,
vira decisão depois de medir, não agora.

```js
export function agregar(fragmento, aoFechar) {
    const { phone } = fragmento;
    let janela = janelas.get(phone);

    if (!janela) {
        janela = {
            textos: [], image: null, audio: false,
            messageIds: [], referenceMessageId: null, timer: null
        };
        janelas.set(phone, janela);
        janela.timer = setTimeout(() => fechar(phone, aoFechar), JANELA_MS);
    }

    if (fragmento.text) janela.textos.push(fragmento.text);
    if (fragmento.image && !janela.image) janela.image = fragmento.image;
    if (fragmento.audio) janela.audio = true;
    if (fragmento.referenceMessageId && !janela.referenceMessageId) {
        janela.referenceMessageId = fragmento.referenceMessageId;
    }
    janela.messageIds.push(fragmento.messageId);

    if (janela.messageIds.length >= MAX_FRAGMENTOS) {
        clearTimeout(janela.timer);
        fechar(phone, aoFechar);
    }
}

function fechar(phone, aoFechar) {
    const janela = janelas.get(phone);
    if (!janela) return;
    janelas.delete(phone);

    const entrada = {
        phone,
        text: janela.textos.join('\n') || null,
        image: janela.image,
        audio: janela.audio,
        messageId: janela.messageIds[0],
        referenceMessageId: janela.referenceMessageId,
        fragmentos: janela.messageIds.length
    };

    if (entrada.fragmentos > 1) {
        console.log(`🪟 [JANELA] ${entrada.fragmentos} mensagens agregadas em 1 turno — ${phone}`);
    }

    enfileirar(phone, () => aoFechar(entrada), 'mensagem');
}
```

**Regras de agregação:**
- Textos concatenados com `\n`, **na ordem de chegada**.
- A primeira imagem da janela é a que segue; as demais são descartadas.
- `messageId` do turno = o da **primeira** mensagem da janela (é o que já existe hoje nos logs).
- `audio` vira `true` se qualquer fragmento for áudio. Se houver texto junto, o texto prevalece
  e o áudio é ignorado — comportamento melhor do que o de hoje, em que o áudio abortava o turno.
  Só quando a janela inteira é áudio sem texto é que a resposta de áudio não suportado dispara
  (a regra já existe em `agent.js`, não mexer nela).

---

## 3. Alterações em `src/index.js`

Substituir a chamada direta por agregação. O dedupe de `messageId` **continua antes** da
janela — protege contra o webhook duplicado da Z-API, que é problema diferente.

Trecho atual:

```js
        console.log(`📦 Z-API payload:`, JSON.stringify(req.body, null, 2));
        console.log(`📩 Mensagem recebida de ${phone}: ${text || '[mídia]'}`);
        await handleIncomingMessage({ phone, text, audio, image, messageId, referenceMessageId });
```

Passa a ser:

```js
        console.log(`📦 Z-API payload:`, JSON.stringify(req.body, null, 2));
        console.log(`📩 Mensagem recebida de ${phone}: ${text || '[mídia]'}`);

        agregar(
            { phone, text, audio, image, messageId, referenceMessageId },
            (entrada) => handleIncomingMessage(entrada)
        );
```

`agregar` não é `await` — o webhook já respondeu 200 e o processamento é assíncrono por
construção. Importar no topo:

```js
import { agregar } from './filaTurnos.js';
```

`src/agent.js` **não muda**.

---

## 4. Alterações em `src/scheduler.js`

Decisão 4a: lembrete disparado com a janela aberta entra na fila e espera. Envolver os três
pontos de despacho por usuário, não os `sendTextMessage` individuais.

Importar:

```js
import { enfileirar } from './filaTurnos.js';
```

Nos laços de `checkAndSendReminders` e `checkAndSendFollowUps`, cada chamada a
`sendGroupedReminder(grupo)`, `handleGroupedFollowUp(grupo)` e `sendReminder(reminder)` passa a
ser enfileirada na chave do telefone daquele usuário:

```js
// antes
await sendGroupedReminder(grupo);

// depois
enfileirar(grupo[0].phone, () => sendGroupedReminder(grupo), 'lembrete');
```

```js
// antes
await sendReminder(reminder);

// depois
enfileirar(reminder.phone, () => sendReminder(reminder), 'lembrete');
```

```js
// antes
await handleGroupedFollowUp(grupo);

// depois
enfileirar(grupo[0].phone, () => handleGroupedFollowUp(grupo), 'follow-up');
```

**Atenção:** o laço do scheduler não deve mais dar `await` nesses envios, senão o scheduler
inteiro passa a esperar a fila de cada usuário em série. Enfileirar e seguir. A marcação de
"lembrete enviado" no banco continua dentro das funções, então nada muda na persistência.

**Atraso máximo de um lembrete:** janela (até 5s) + duração do turno corrente. Aceito.

---

## 5. O que este briefing NÃO faz

- Não mexe em `router.js`, `cadastro.js`, `recepcionista.js` nem em nenhum agente.
- Não muda nenhum texto enviado ao usuário.
- Não cria tabela, coluna nem migração.
- Não persiste fila em banco — reinício do processo descarta janelas abertas e a fila
  pendente. Perda máxima: as mensagens em voo durante um deploy. Aceito.

---

## 6. Validação em staging (executar nesta ordem)

| # | Teste | Resultado esperado |
|---|---|---|
| 1 | Mandar 3 mensagens em menos de 5s | **1** resposta só; log `🪟 [JANELA] 3 mensagens agregadas` |
| 2 | Mandar 2 mensagens com 8s de intervalo | 2 respostas, sem agregação |
| 3 | Iniciar cadastro e mandar "Losartana" + "8h e 20h" em sequência rápida | os dois chegam no mesmo turno, no mesmo `message` |
| 4 | Abrir a janela e, dentro dela, disparar lembrete manual em `/reminders/check` | o lembrete chega **depois** da resposta ao usuário |
| 5 | Provocar erro num turno e mandar nova mensagem em seguida | a segunda mensagem é processada normalmente (fila não travou) |
| 6 | Dois telefones diferentes mandando ao mesmo tempo | respostas em paralelo, sem espera cruzada |
| 7 | Mandar 12 mensagens muito rápido | fecha em 10, sem estourar memória nem duplicar resposta |

Só promover para `main` com os 7 passando.

---

## 7. Itens de backlog cobertos

- **MH-040 Parte B** — concorrência de turnos → resolvido pela fila.
- **MH-040 Parte A** — mensagens fragmentadas com respostas independentes → resolvido pela janela.

Atualizar os dois para `em_validacao` após o deploy em staging, e para `concluido` só após a
validação com print de produção.