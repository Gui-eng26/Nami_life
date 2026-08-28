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
