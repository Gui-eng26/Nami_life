// ============================================================
// HELPERS DE NLP COMPARTILHADOS ENTRE AGENTES
// Evita duplicar listas de termos divergentes espalhadas pelo código (BUG-036).
// ============================================================

export function isCancelamento(message) {
    return /\b(não|nao|cancela|cancelar|desiste|desistir|para|esquece|esquece isso)\b/.test(message.toLowerCase());
}
