// ============================================================
// QUANTIDADE DA DOSE — ponto único de formatação (MH-081, Princípio 30).
//
// Regra de categoria: unidade_dose (conjunto fechado, CHECK no schema) decide o TIPO
// do rótulo. forma_farmaceutica escolhe apenas o SUBSTANTIVO quando a dose é contável,
// e só isso — ela é descritiva e tem deriva conhecida em produção (Princípio 45).
// Divergência de forma produz texto estranho, nunca quantidade errada.
//
// Módulo puro: sem I/O. A decisão de registrar degradação quando a quantidade não pode
// ser resolvida pertence ao call site (ver seção 6 do BRIEFING_MH081.md).
// ============================================================

// Normaliza para comparação: minúsculas, sem acento, sem espaço nas pontas.
// Produção tem 'capsula' e 'cápsula' na mesma base — sem isso, uma das duas cairia
// no fallback genérico.
function normalizarForma(forma) {
    if (typeof forma !== 'string') return '';
    return forma
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

// Substantivo para dose CONTÁVEL (unidade_dose === 'unidade').
// Conjunto fechado e deliberadamente curto: só formas cujo substantivo é inequívoco.
// Qualquer outra forma (pomada, injetavel, efervescente, null...) cai em 'unidade(s)' —
// texto genérico, nunca errado. Refinar formas adicionais é escopo do MH-073 Parte D.
const SUBSTANTIVO_CONTAVEL = {
    'comprimido': { singular: 'comprimido', plural: 'comprimidos' },
    'capsula':    { singular: 'cápsula',    plural: 'cápsulas' }
};

const SUBSTANTIVO_CONTAVEL_PADRAO = { singular: 'unidade', plural: 'unidades' };

// Rótulo canônico por chave normalizada (acento/caixa já removidos por normalizarForma).
// Funde os sinônimos confirmados em produção (MH-009 §4.9): cápsula/capsula é variação de
// acento; colírio/gotas e xarope/líquido são palavras diferentes para o mesmo uso. Só para
// AGRUPAR exibição — nunca para decidir comportamento (unidade_dose/unidade_estoque
// continuam a fonte de verdade, Princípio 45).
const FORMA_FARMACEUTICA_CANONICA = {
    'comprimido': 'comprimido',
    'capsula':    'cápsula',
    'colirio':    'colírio',
    'gotas':      'colírio',
    'xarope':     'xarope',
    'liquido':    'xarope'
};

/**
 * Devolve a forma farmacêutica normalizada para exibição agrupada (ex: dashboard).
 * Formas sem sinônimo mapeado voltam pela chave normalizada (sem acento) — agrupa
 * variações de acento/caixa mesmo sem entrada explícita, nunca inventa uma forma nova.
 *
 * @returns {string} ex: "cápsula" · "colírio" · "xarope" · "não informado"
 */
export function normalizarFormaFarmaceutica(forma) {
    if (typeof forma !== 'string' || !forma.trim()) return 'não informado';
    const chave = normalizarForma(forma);
    return FORMA_FARMACEUTICA_CANONICA[chave] || chave;
}

// Formata o número em pt-BR: inteiro sem casas decimais, fracionário com vírgula
// e sem zeros à direita. 2 -> "2" · 2.0 -> "2" · 0.5 -> "0,5" · 2.50 -> "2,5"
function formatarNumero(n) {
    if (Number.isInteger(n)) return String(n);
    return String(n).replace(/0+$/, '').replace('.', ',');
}

/**
 * Devolve o rótulo da quantidade da dose, ou null quando não é possível formatar.
 *
 * null significa "não sei", e o chamador OMITE o trecho — nunca substitui por 1.
 * Colapsar "não sei" com uma quantidade legítima é o Princípio 49.
 *
 * @returns {string|null} ex: "2 comprimidos" · "1 cápsula" · "5 ml" · "4 gotas" · "0,5 comprimido"
 */
export function formatarQuantidadeDose({ quantidade, unidade_dose, forma_farmaceutica }) {
    // Number(null) === 0 e Number(undefined) === NaN — os dois precisam cair fora,
    // e quantidade 0 não é dose válida (CHECK schedules_quantidade_por_dose_check > 0).
    if (quantidade === null || quantidade === undefined) return null;
    const n = Number(quantidade);
    if (!Number.isFinite(n) || n <= 0) return null;

    const numero = formatarNumero(n);

    // 'ml' é símbolo de unidade: nunca pluraliza. "1 ml", "5 ml", "2,5 ml".
    if (unidade_dose === 'ml') return `${numero} ml`;

    if (unidade_dose === 'gota') {
        return `${numero} ${n > 1 ? 'gotas' : 'gota'}`;
    }

    // unidade_dose === 'unidade' (ou ausente/desconhecido — mesmo tratamento seguro)
    const chave = normalizarForma(forma_farmaceutica);
    const termo = SUBSTANTIVO_CONTAVEL[chave] || SUBSTANTIVO_CONTAVEL_PADRAO;
    return `${numero} ${n > 1 ? termo.plural : termo.singular}`;
}

/**
 * Devolve a LINHA pronta para concatenar na mensagem — quebra de linha + rótulo —
 * ou string vazia quando não há quantidade a exibir.
 *
 * Existe para que os 4 call sites não repitam o mesmo ternário: se o rótulo, o
 * separador ou o recuo mudarem, mudam em um lugar só (Princípio 30).
 *
 * @param {string} [opcoes.indentacao] recuo aplicado antes do rótulo. Usado só nas
 *        mensagens agrupadas, onde a quantidade é sub-linha de um item de lista.
 *
 * @returns {string} ex: "\nQuantidade: 2 cápsulas" · "\n  Quantidade: 5 ml" · ""
 */
export function linhaQuantidadeDose(args, { indentacao = '' } = {}) {
    const rotulo = formatarQuantidadeDose(args);
    return rotulo ? `\n${indentacao}Quantidade: ${rotulo}` : '';
}

/**
 * v43 Bloco C Adendo 1 — rótulo PLURAL da unidade de ESTOQUE (não de dose): "comprimidos",
 * "cápsulas", "ml" — para perguntas como "quantos X você tem em casa?" e para o convite de
 * estoque não informado. Reaproveita formatarQuantidadeDose (mesma tabela de substantivos),
 * nunca reimplementa o mapeamento — só força uma quantidade plural (2) e descarta o número.
 *
 * unidade_estoque decide a CATEGORIA (ml é sempre "ml"; qualquer outra coisa é contável e
 * usa o substantivo derivado de forma_farmaceutica) — nunca unidade_dose: estoque líquido
 * em gotas ainda é contado em ml (gotas_por_ml já faz essa conversão na dose).
 *
 * @returns {string} ex: "comprimidos" · "cápsulas" · "ml" · "unidades"
 */
export function rotuloEstoquePlural({ unidade_estoque, forma_farmaceutica }) {
    const unidadeDoseEquivalente = unidade_estoque === 'ml' ? 'ml' : 'unidade';
    const rotulo = formatarQuantidadeDose({ quantidade: 2, unidade_dose: unidadeDoseEquivalente, forma_farmaceutica });
    return rotulo ? rotulo.replace(/^2 /, '') : 'unidades';
}

// P1-ajustes §3: o pronome interrogativo concorda com o rótulo plural ("quantos
// comprimidos", "quantas unidades"). Mapa único, ao lado do rótulo; rótulo fora
// do mapa cai em "quantos".
const PRONOME_QUANTOS = {
    comprimidos: 'quantos', frascos: 'quantos', 'sachês': 'quantos', ml: 'quantos',
    unidades: 'quantas', 'cápsulas': 'quantas', gotas: 'quantas'
};

export function quantosDoRotulo(rotuloPlural) {
    return `${PRONOME_QUANTOS[rotuloPlural] || 'quantos'} ${rotuloPlural}`;
}

// ============================================================
// v47 ONDA 2 (MH-100 C) — RÓTULOS DE TEMPO E FRAGMENTOS CANÔNICOS DE DOSE
// Movidos POR EQUIVALÊNCIA ESTRITA de dosesDoTurno.js (que os importa de
// volta): os fragmentos viram entradas do catálogo (templates/catalogo.js).
// Rótulos de tempo sempre calculados em código, nunca pelo LLM (BUG-059).
// ============================================================

const FUSO = 'America/Sao_Paulo';

export function dataISOBRT(data) {
    return new Date(data).toLocaleDateString('en-CA', { timeZone: FUSO });
}

export function horaBRT(data) {
    return new Date(data).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: FUSO });
}

export function ddmm(dataISO) {
    const [, m, d] = dataISO.split('-');
    return `${d}/${m}`;
}

// 'hoje' | 'ontem' | 'anteontem' | null (fora da janela).
export function calcularRotuloDia(scheduledAt, agora = new Date()) {
    const alvo = dataISOBRT(scheduledAt);
    for (const [rotulo, dias] of [['hoje', 0], ['ontem', 1], ['anteontem', 2]]) {
        if (alvo === dataISOBRT(new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000))) return rotulo;
    }
    return null;
}

export function horaDaDose(dose) {
    return dose.horario_agendado ? String(dose.horario_agendado).slice(0, 5) : horaBRT(dose.scheduled_at);
}

// P1-copy §2 — regra da data: dose de hoje leva só a hora; de outro dia leva
// rótulo, data e hora. "de hoje (06:28)", "de ontem (25/09, 06:28)".
export function quandoDaDose(dose, agora = new Date()) {
    const rotulo = calcularRotuloDia(dose.scheduled_at, agora);
    const data = ddmm(dataISOBRT(dose.scheduled_at));
    const hora = horaDaDose(dose);
    if (rotulo === 'hoje') return { rotulo, entreParenteses: hora };
    return { rotulo: rotulo || data, entreParenteses: `${data}, ${hora}` };
}

// "*Roacutan* de ontem (25/09, 06:28)"
export function descreverDose(dose, { negrito = true } = {}) {
    const nome = dose.medications?.nome || 'seu remédio';
    const { rotulo, entreParenteses } = quandoDaDose(dose);
    return `${negrito ? `*${nome}*` : nome} de ${rotulo} (${entreParenteses})`;
}

// Monta o texto de confirmação (puro — testável sem banco). `confirmadas` e
// `jaRegistradas` são doses lidas do banco.
export function textoDeConfirmacao({ abertura, confirmadas, jaRegistradas = [] }) {
    if (confirmadas.length === 0) return '';
    if (jaRegistradas.length > 0) {
        // §4 — confirmação parcial.
        const agora = confirmadas.map(d => `• ${descreverDose(d, { negrito: false })}`).join('\n');
        const antes = jaRegistradas.map(d => {
            const nome = d.medications?.nome || 'seu remédio';
            return `${nome} (${quandoDaDose(d).entreParenteses})`;
        }).join(', ');
        return `${abertura} ✅ Confirmei agora:\n${agora}\n\nJá estavam registradas: ${antes}.`;
    }
    if (confirmadas.length === 1) {
        return `${abertura} ✅ ${descreverDose(confirmadas[0])} confirmada 💊`;
    }
    return `${abertura} ✅ Doses confirmadas:\n${confirmadas.map(d => `• ${descreverDose(d)}`).join('\n')}`;
}

// §2.2 — linha fixa de fato para a dose FECHADA como não tomada (vem depois
// do acolhimento que o principal escreve).
export function linhaNaoTomada(dose) {
    return `O ${descreverDose(dose)} ficou registrado como não tomado.`;
}

// v47 Onda 2: a linha do desfazer (ex-literal de dosesDoTurno.montarTextoPosEscrita).
export function linhaDosesRevertidas({ doses }) {
    return `Desfiz a confirmação: ${doses.map(d => descreverDose(d)).join(', ')}. 🌿`;
}
