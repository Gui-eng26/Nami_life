# BRIEFING — v43 Bloco A, Adendo 1: janela deslizante e ordem das mensagens

**Sessão:** v43 (18/09/2026)
**Branch:** `staging`
**Arquivo:** `src/filaTurnos.js`
**Depende de:** `BRIEFING_V43_BLOCO_A_FILA_JANELA.md`, já implementado e no `staging`

Auto-contido.

---

## 0. Evidência

Teste real em staging, 18/09 02:17 UTC. O usuário digitou **uma frase em cinco bolhas**, nesta
ordem (confirmada por print da tela do WhatsApp):

```
1. Não, mas não quero cadastrar
2. O meu remédio
3. Agora
4. Só quero
5. Conversar
```

O que o sistema fez:

| Turno | `user_message` gravado | Horário | Consequência |
|---|---|---|---|
| A | `Não, mas não quero cadastrar` | 02:17:24 | **encerrou o cadastro** |
| B | `Agora` / `O meu remédio` / `Só quero` / `Conversar` | 02:17:33 | resposta genérica |

**Dois defeitos distintos, ambos confirmados:**

1. **A janela fixa fecha enquanto a pessoa ainda está digitando.** A bolha 1 abriu a janela; os
   5 segundos venceram antes de a bolha 2 chegar. Uma frase virou duas decisões, e a primeira
   cancelou um fluxo que o usuário não queria cancelar.
2. **A ordem de concatenação está errada.** "Agora" foi digitada em terceiro e apareceu em
   primeiro. A Z-API não garante ordem de entrega dos webhooks, e o briefing original mandou
   concatenar por ordem de chegada.

Outras duas quebras a 6 segundos no mesmo teste (02:15:43/49 e 02:16:45/51) produziram respostas
quase idênticas seguidas — mesma causa raiz, o intervalo humano entre bolhas é maior que 5s.

---

## 1. Correção 1 — janela deslizante com teto

**Decisão:** cada mensagem nova **reinicia** o relógio da janela. A janela nunca ultrapassa um
teto absoluto contado desde a primeira mensagem.

```js
const JANELA_MS = Number(process.env.JANELA_AGREGACAO_MS || 5000);       // reinicia a cada msg
const JANELA_TETO_MS = Number(process.env.JANELA_TETO_MS || 15000);      // desde a 1ª msg
const MAX_FRAGMENTOS = 10;
```

Em `agregar`, ao criar a janela, guardar o instante de abertura; a cada nova mensagem,
reagendar respeitando o teto:

```js
    if (!janela) {
        janela = {
            textos: [], image: null, audio: false,
            messageIds: [], referenceMessageId: null, timer: null,
            abertaEm: Date.now(),
            itens: []                      // ver Correção 2
        };
        janelas.set(phone, janela);
    } else {
        clearTimeout(janela.timer);        // deslizante: a mensagem nova reinicia o relógio
    }

    // ... acumula o fragmento ...

    const restanteAteOTeto = JANELA_TETO_MS - (Date.now() - janela.abertaEm);
    const espera = Math.max(0, Math.min(JANELA_MS, restanteAteOTeto));
    janela.timer = setTimeout(() => fechar(phone, aoFechar), espera);
```

**Comportamento resultante:** cinco bolhas com 2 a 4 segundos entre cada uma viram **um turno
só**. Quem faz uma pergunta e volta 30 segundos depois com outra continua tendo duas respostas.
A latência máxima é 15 segundos, e só para quem ficou 15 segundos digitando sem parar.

Os dois valores ficam em variável de ambiente para serem ajustados por medição, não por
intuição. Definir os dois no Railway, em produção e em staging.

---

## 2. Correção 2 — ordenar por timestamp da mensagem, não por chegada

O payload da Z-API traz o instante em que a mensagem foi enviada. Nos logs de
`📦 Z-API payload` do staging esse campo aparece como `momment` (epoch em milissegundos, grafia
da própria Z-API). **Conferir o nome exato no payload logado antes de implementar** — se o campo
não existir ou vier nulo, o fallback é a ordem de chegada, nunca um erro.

`src/index.js` passa o timestamp adiante:

```js
const enviadaEm = Number(req.body.momment) || Date.now();

agregar(
    { phone, text, audio, image, messageId, referenceMessageId, enviadaEm },
    (entrada) => handleIncomingMessage(entrada)
);
```

`agregar` acumula itens em vez de só textos:

```js
    if (fragmento.text) {
        janela.itens.push({ texto: fragmento.text, enviadaEm: fragmento.enviadaEm || Date.now() });
    }
```

E `fechar` ordena antes de concatenar:

```js
    const ordenados = [...janela.itens].sort((a, b) => a.enviadaEm - b.enviadaEm);
    const texto = ordenados.map(i => i.texto).join('\n') || null;
```

O `messageId` do turno continua sendo o da primeira mensagem **a chegar** — é o que já existe
nos logs hoje e não vale mudar agora.

---

## 3. O que este adendo NÃO faz

- Não usa sinal de "digitando" da Z-API para fechar a janela. Seria melhor que timer, e é
  investigação para depois da CIW, não para hoje.
- Não muda a fila, o scheduler nem nenhum agente.
- Não muda nenhum texto enviado ao usuário.

---

## 4. Validação em staging

| # | Teste | Esperado |
|---|---|---|
| 1 | Cinco bolhas de uma frase só, 2 a 4s entre cada | **1** resposta, considerando a frase inteira |
| 2 | Mesmas cinco bolhas, conferir `user_message` em `agent_logs` | ordem igual à digitada |
| 3 | Duas mensagens com 6s de intervalo | **1** resposta (era o caso que quebrava) |
| 4 | Duas mensagens com 30s de intervalo | 2 respostas |
| 5 | Digitar sem parar por mais de 15s | fecha no teto, não espera indefinidamente |
| 6 | Iniciar cadastro e mandar "não quero cadastrar / o meu remédio / agora" em bolhas | a decisão considera a frase inteira, não a primeira bolha |

O teste 6 é o que reproduz a falha original. É o que precisa passar.

---

## 5. Backlog

**MH-040 Parte A** permanece aberta até esta validação passar — a implementação anterior estava
correta na fila e incompleta na janela. Não abrir número novo.