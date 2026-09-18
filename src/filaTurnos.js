// ============================================================
// FILA POR USUÁRIO + JANELA DE AGREGAÇÃO (MH-040 A + B, Adendo 1)
// Serializa turnos do mesmo usuário e agrupa mensagens fragmentadas.
// Estado em memória do processo: correto apenas com 1 réplica (ver CONTEXT.md §6).
// Janela DESLIZANTE (Adendo 1): cada mensagem nova reinicia o relógio, até um
// teto absoluto contado desde a primeira mensagem — sem isso, uma frase digitada
// em várias bolhas fecha a janela no meio, e a primeira bolha vira uma decisão
// sozinha (ver evidência do briefing).
// ============================================================

const JANELA_MS = Number(process.env.JANELA_AGREGACAO_MS || 5000);       // reinicia a cada msg
const JANELA_TETO_MS = Number(process.env.JANELA_TETO_MS || 15000);      // desde a 1ª msg
const MAX_FRAGMENTOS = 10;

const cadeias = new Map();   // phone -> Promise (cauda da fila)
const janelas = new Map();   // phone -> buffer aberto

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

export function agregar(fragmento, aoFechar) {
    const { phone } = fragmento;
    let janela = janelas.get(phone);

    if (!janela) {
        janela = {
            image: null, audio: false,
            messageIds: [], referenceMessageId: null, timer: null,
            abertaEm: Date.now(),
            itens: []                      // { texto, enviadaEm } — ordenados no fechamento
        };
        janelas.set(phone, janela);
    } else {
        clearTimeout(janela.timer);        // deslizante: a mensagem nova reinicia o relógio
    }

    if (fragmento.text) {
        janela.itens.push({ texto: fragmento.text, enviadaEm: fragmento.enviadaEm || Date.now() });
    }
    if (fragmento.image && !janela.image) janela.image = fragmento.image;
    if (fragmento.audio) janela.audio = true;
    if (fragmento.referenceMessageId && !janela.referenceMessageId) {
        janela.referenceMessageId = fragmento.referenceMessageId;
    }
    janela.messageIds.push(fragmento.messageId);

    if (janela.messageIds.length >= MAX_FRAGMENTOS) {
        fechar(phone, aoFechar);
        return;
    }

    const restanteAteOTeto = JANELA_TETO_MS - (Date.now() - janela.abertaEm);
    const espera = Math.max(0, Math.min(JANELA_MS, restanteAteOTeto));
    janela.timer = setTimeout(() => fechar(phone, aoFechar), espera);
}

function fechar(phone, aoFechar) {
    const janela = janelas.get(phone);
    if (!janela) return;
    clearTimeout(janela.timer);
    janelas.delete(phone);

    const ordenados = [...janela.itens].sort((a, b) => a.enviadaEm - b.enviadaEm);
    const texto = ordenados.map(i => i.texto).join('\n') || null;

    const entrada = {
        phone,
        text: texto,
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
