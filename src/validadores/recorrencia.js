// ============================================================
// VALIDADOR DETERMINÍSTICO DE RECORRÊNCIA (v44 §5.7, evidência A3)
//
// O limite da capacidade de cadastro é "mesmos horários todos os dias"
// (inventário §2). Padrão de dia-da-semana/frequência detectado aqui
// BLOQUEIA a gravação de horários: gravação errada em silêncio é
// proibida (Constituição regra 7) — a resposta é honestidade de limite
// + oferta do subconjunto representável, e só grava com consentimento.
//
// Determinístico, sem custo de LLM. Vocabulário canônico: validador.
// ============================================================

const PADROES = [
    { nome: 'dia_da_semana', re: /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bados?|domingos?)(\s*[-\s]feira)?\b/i },
    { nome: 'abreviacao_de_dias', re: /\b(seg|ter|qua|qui|sex|s[áa]b|dom)\.?\s*(a|à|ate|até|e)\s*(seg|ter|qua|qui|sex|s[áa]b|dom)\b/i },
    { nome: 'fim_de_semana', re: /\bfi(?:m|ns)\s+de\s+semana\b/i },
    { nome: 'dia_sim_dia_nao', re: /\bdia\s+sim,?\s+dia\s+n[ãa]o\b|\bdias?\s+alternados?\b/i },
    { nome: 'x_por_semana', re: /\b(\d+|uma|duas|tr[êe]s)\s*(x|vez(?:es)?)\s*(por|na|a cada)\s+semana\b|\bsemanalmente\b/i }
];

const RE_A_CADA_N_DIAS = /\ba\s+cada\s+(\d+)\s*dias?\b/i;

export function detectarRecorrenciaNaoSuportada(texto) {
    const t = String(texto || '');
    const padroes = [];

    for (const { nome, re } of PADROES) {
        if (re.test(t)) padroes.push(nome);
    }

    const aCadaNDias = t.match(RE_A_CADA_N_DIAS);
    if (aCadaNDias && Number(aCadaNDias[1]) >= 2) padroes.push('a_cada_n_dias');

    return { detectado: padroes.length > 0, padroes };
}

// Horários citados na mensagem, para a oferta do subconjunto representável.
export function extrairHorariosCitados(texto) {
    const re = /\b([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)?\b/gi;
    const achados = [];
    let m;
    while ((m = re.exec(String(texto || ''))) !== null) {
        const hora = String(m[1]).padStart(2, '0');
        const minuto = m[2] || '00';
        const hhmm = `${hora}:${minuto}`;
        if (!achados.includes(hhmm)) achados.push(hhmm);
    }
    return achados;
}
