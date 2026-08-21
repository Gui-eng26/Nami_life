// ============================================================
// VERBOS DE ADMINISTRAÇÃO — ponto único (princípio 30).
// BRIEFING_BUG100.md — o discriminador é forma_farmaceutica, e só ele.
// Colírio e Rivotril gotas têm a mesma unidade de dose e verbos opostos
// ('usar' vs 'tomar') — só a forma farmacêutica distingue os dois corretamente.
// ============================================================

const VERBO_POR_FORMA = {
    'colírio':   { infinitivo: 'usar',    passado: 'usou',    imperativoPergunta: 'Já usou?' },
    'pomada':    { infinitivo: 'usar',    passado: 'usou',    imperativoPergunta: 'Já usou?' },
    'injetável': { infinitivo: 'aplicar', passado: 'aplicou', imperativoPergunta: 'Já aplicou?' },
    'comprimido':{ infinitivo: 'tomar',   passado: 'tomou',   imperativoPergunta: 'Já tomou?' },
    'cápsula':   { infinitivo: 'tomar',   passado: 'tomou',   imperativoPergunta: 'Já tomou?' },
    'gotas':     { infinitivo: 'tomar',   passado: 'tomou',   imperativoPergunta: 'Já tomou?' },
    'xarope':    { infinitivo: 'tomar',   passado: 'tomou',   imperativoPergunta: 'Já tomou?' }
};

// Formas genéricas ('unidade', 'líquido') e desconhecidas: a convenção do projeto
// já estabelecida no cadastro — "toma ou usa" — cobre os dois casos sem errar.
const VERBO_NEUTRO = { infinitivo: 'tomar ou usar', passado: 'tomou ou usou', imperativoPergunta: 'Já tomou ou usou?' };

export function verboDoMedicamento(formaFarmaceutica) {
    return VERBO_POR_FORMA[formaFarmaceutica] || VERBO_NEUTRO;
}

// Mensagens que cobrem VÁRIOS medicamentos de formas diferentes não podem
// escolher um verbo — usam o neutro sempre.
export const VERBO_MULTIPLO = VERBO_NEUTRO;

// Grupo homogêneo usa o verbo próprio; só mistura de formas cai no neutro.
// "Já tomou todos?" é bem mais natural que "Já tomou ou usou todos?" — e a
// maioria dos agrupamentos na prática é só de comprimidos.
export function verboDoGrupo(formas) {
    const verbos = [...new Set((formas || []).map(f => verboDoMedicamento(f).passado))];
    return verbos.length === 1 ? { passado: verbos[0] } : VERBO_MULTIPLO;
}
