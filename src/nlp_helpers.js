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
