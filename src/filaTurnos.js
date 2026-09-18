// ============================================================
// FILA POR USUÁRIO + JANELA DE AGREGAÇÃO (MH-040 A + B)
// Serializa turnos do mesmo usuário e agrupa mensagens fragmentadas.
// Estado em memória do processo: correto apenas com 1 réplica (ver CONTEXT.md §6).
// ============================================================

const JANELA_MS = Number(process.env.JANELA_AGREGACAO_MS || 5000);
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
