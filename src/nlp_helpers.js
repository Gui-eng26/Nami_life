// ============================================================
// HELPERS DE NLP COMPARTILHADOS ENTRE AGENTES
// Evita duplicar listas de termos divergentes espalhadas pelo código (BUG-036).
// ============================================================

export function isCancelamento(message) {
    return /\b(não|nao|cancela|cancelar|desiste|desistir|para (de|com)|parar|esquece|esquece isso|deixa|deixa pra lá|deixa quieto|sair|chega|chega por hoje|não precisa mais|não precisa)\b/i.test(message.toLowerCase());
}

export function normalizar(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

export function encontrarMedicamento(texto, medications) {
    if (!texto) return null;
    const t = normalizar(texto);
    return medications.find(m => normalizar(m.nome) === t)
        || medications.find(m =>
            t.includes(normalizar(m.nome)) ||
            normalizar(m.nome).includes(t)
        )
        || null;
}

// ============================================================
// MH-020 — PRÉ-FILTRO DE EXCLUSÃO DE CONTA (estágio 1, determinístico)
// Barato: roda em toda mensagem de usuário onboarded. Só sinaliza CANDIDATO —
// a decisão semântica final é do estágio 2 (LLM), em exclusaoConta.js.
// Objetos aqui são DISJUNTOS dos de detectarIntencaoConfiguracao (lembrete/remédio/
// horário), então "excluir meu lembrete" NÃO cai aqui.
// ============================================================

function contemPalavraLivreExcl(texto, palavra) {
    if (palavra.includes(' ')) return texto.includes(palavra);
    return new RegExp(`(^|\\s)${palavra}(\\s|$|[.,!?])`).test(texto);
}

export function pareceExclusaoConta(message) {
    if (!message) return false;
    const msg = normalizar(message);

    // Verbos que, junto de um objeto de CONTA, sugerem exclusão de conta.
    const acoes = [
        'excluir', 'exclua', 'exclua', 'deletar', 'delete', 'apagar', 'apague',
        'remover', 'remova', 'cancelar', 'cancela', 'encerrar', 'encerra',
        'retirar', 'retira', 'tirar'
    ];
    // Objetos que significam "a conta/o cadastro do usuário na Nami".
    const objetos = [
        'conta', 'cadastro', 'meus dados', 'meu dados', 'meus dado',
        'minhas informacoes', 'minha informacao', 'meus registros', 'meu registro',
        'perfil', 'meu usuario', 'da nami', 'na nami', 'da plataforma', 'do app'
    ];
    // Frases que já significam exclusão de conta por si só (verbo + objeto embutidos).
    const frasesDiretas = [
        'me descadastrar', 'descadastrar', 'me descadastra', 'quero sair da nami',
        'sair da nami', 'apagar tudo', 'excluir tudo', 'deletar tudo'
    ];

    if (frasesDiretas.some(f => msg.includes(f))) return true;

    const temAcao = acoes.some(a => contemPalavraLivreExcl(msg, a));
    const temObjeto = objetos.some(o => contemPalavraLivreExcl(msg, o));
    return temAcao && temObjeto;
}
