// ============================================================
// EXTRAÇÃO E VALIDAÇÃO DETERMINÍSTICA DE DATA DE NASCIMENTO (MH-072 Parte A)
// Módulo determinístico, sem chamada de LLM. Responsabilidade única: dizer O QUE
// uma mensagem contém, não se ela "serve" para o campo esperado — quem decide
// isso é o agente (data_nascimento.js), consultando o tipo devolvido aqui.
// Módulo de funções puras — sem I/O — mesmo padrão de dataReferencia.js.
// ============================================================

import { hojeBRT } from './dataReferencia.js';

const MESES = {
    janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
    julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12
};

const MESES_ABREV = {
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12
};

// Números por extenso, 1–31, incluindo compostos ("vinte e um") e o ordinal "primeiro".
const NUMEROS_EXTENSO = (() => {
    const unidades = {
        um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
        seis: 6, sete: 7, oito: 8, nove: 9
    };
    const especiais = {
        dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14,
        quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
        vinte: 20, trinta: 30
    };
    const mapa = { ...unidades, ...especiais, primeiro: 1, primeira: 1 };
    for (const [palavra, valor] of Object.entries(unidades)) {
        if (valor === 0) continue;
        mapa[`vinte e ${palavra}`] = 20 + valor;
    }
    mapa['trinta e um'] = 31;
    mapa['trinta e uma'] = 31;
    return mapa;
})();

function normalizar(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .replace(/\s+/g, ' ');
}

// ============================================================
// LEVENSHTEIN — tolerância a erro de digitação, só usada contra nomes de mês
// ============================================================

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

function extrairMes(norm) {
    const tokens = norm.match(/[a-z]+/g) || [];

    for (const tok of tokens) {
        if (MESES[tok] !== undefined) return MESES[tok];
    }
    for (const tok of tokens) {
        if (MESES_ABREV[tok] !== undefined) return MESES_ABREV[tok];
    }
    // Tolerância a erro de digitação: distância de Levenshtein <= 1, só contra
    // nomes/abreviações de mês, nunca contra números (princípio explícito do briefing).
    for (const tok of tokens) {
        if (tok.length < 3) continue;
        for (const [nome, num] of Object.entries(MESES)) {
            if (levenshtein(tok, nome) <= 1) return num;
        }
        for (const [abrev, num] of Object.entries(MESES_ABREV)) {
            if (levenshtein(tok, abrev) <= 1) return num;
        }
    }
    return null;
}

function anoAtualBRT() {
    return Number(hojeBRT().split('-')[0]);
}

function extrairAno4Digitos(norm) {
    const matches = norm.match(/\b\d{4}\b/g);
    if (!matches) return null;
    const anoAtual = anoAtualBRT();
    for (const ms of matches) {
        const n = Number(ms);
        if (n >= anoAtual - 110 && n <= anoAtual) return n;
    }
    return null;
}

// Número por extenso a partir do INÍCIO de um trecho de texto (usado após um marcador).
function extrairNumeroDeTrecho(trecho) {
    const t = trecho.trim();
    const md = t.match(/^(\d{1,2})\b/);
    if (md) return Number(md[1]);

    const palavras = t.split(/\s+/);
    for (let n = Math.min(3, palavras.length); n >= 1; n--) {
        const frase = palavras.slice(0, n).join(' ');
        if (NUMEROS_EXTENSO[frase] !== undefined) return NUMEROS_EXTENSO[frase];
    }
    return null;
}

// Marcador explícito de dia — "dia 7", "no dia 7", "sou do dia 7", "o dia é 10"
// (a normalização já removeu o acento de "é" -> "e"). Marcador explícito nunca é
// ambíguo: sempre resolve para 'dia', independente do campoEsperado — mesmo
// tratamento que nomes de mês (nunca ambíguos, só podem ser 'mes').
function extrairDiaComMarcador(norm) {
    const m = norm.match(/\b(?:no dia|sou do dia|do dia|dia)\b(?:\s+e)?\s+/);
    if (!m) return null;
    const resto = norm.slice(m.index + m[0].length);
    const n = extrairNumeroDeTrecho(resto);
    if (n === null || n < 1 || n > 31) return null;
    return n;
}

// Número solto, sem marcador — dígito (1-2), ordinal ou por extenso, em qualquer
// posição da mensagem. Usado só depois que marcador de dia, mês e ano-4-dígitos
// já foram descartados.
function extrairNumeroSolto(norm) {
    const md = norm.match(/\b(\d{1,2})\b/);
    if (md) return Number(md[1]);

    const tokens = norm.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
        for (let len = Math.min(3, tokens.length - i); len >= 1; len--) {
            const frase = tokens.slice(i, i + len).join(' ');
            if (NUMEROS_EXTENSO[frase] !== undefined) return NUMEROS_EXTENSO[frase];
        }
    }
    return null;
}

// Data completa: dd/mm/aaaa (com -, . ou / como separador) ou "dd de <mês> de aaaa".
function extrairDataCompleta(norm) {
    const mNumerico = norm.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
    if (mNumerico) {
        const dia = Number(mNumerico[1]);
        const mes = Number(mNumerico[2]);
        const ano = Number(mNumerico[3]);
        if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
            return { dia, mes, ano };
        }
    }

    const mTextual = norm.match(/\b(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})\b/);
    if (mTextual) {
        const dia = Number(mTextual[1]);
        const mes = extrairMes(`de ${mTextual[2]} de`);
        const ano = Number(mTextual[3]);
        if (dia >= 1 && dia <= 31 && mes !== null) {
            return { dia, mes, ano };
        }
    }

    return null;
}

// ============================================================
// EXTRAÇÃO PRINCIPAL
// ============================================================

// campoEsperado ∈ 'dia' | 'mes' | 'ano'
// Retorno: { tipo: 'dia'|'mes'|'ano'|'data_completa'|'ambiguo'|'indeterminado', valor, candidatos }
export function extrairComponenteData(mensagem, campoEsperado) {
    const norm = normalizar(mensagem);
    if (!norm) return { tipo: 'indeterminado', valor: null, candidatos: null };

    // 1. Data completa
    const completa = extrairDataCompleta(norm);
    if (completa) return { tipo: 'data_completa', valor: completa, candidatos: null };

    // 2. Marcador explícito de dia — nunca ambíguo
    const diaMarcado = extrairDiaComMarcador(norm);
    if (diaMarcado !== null) return { tipo: 'dia', valor: diaMarcado, candidatos: null };

    // 3. Nome de mês (com tolerância a erro de digitação) — nunca ambíguo
    const mes = extrairMes(norm);
    if (mes !== null) return { tipo: 'mes', valor: mes, candidatos: null };

    // 4. Ano de 4 dígitos, dentro da janela de validade
    const ano4 = extrairAno4Digitos(norm);
    if (ano4 !== null) return { tipo: 'ano', valor: ano4, candidatos: null };

    // 5. Número solto — pode ser dia, mês, ou ambíguo entre os dois
    const numero = extrairNumeroSolto(norm);
    if (numero === null) return { tipo: 'indeterminado', valor: null, candidatos: null };

    // Ano de 2 dígitos → indeterminado, NUNCA inferência (regra explícita: "60" pode
    // ser 1960; "25" é ambíguo entre 1925 e 2025 — nunca decidir por conta própria).
    if (campoEsperado === 'ano' && numero >= 10 && numero <= 99) {
        return { tipo: 'indeterminado', valor: null, candidatos: null };
    }

    const cabeDia = numero >= 1 && numero <= 31;
    const cabeMes = numero >= 1 && numero <= 12;

    if (campoEsperado === 'dia' && cabeDia) return { tipo: 'dia', valor: numero, candidatos: null };
    if (campoEsperado === 'mes' && cabeMes) return { tipo: 'mes', valor: numero, candidatos: null };

    const outros = [];
    if (cabeDia && campoEsperado !== 'dia') outros.push('dia');
    if (cabeMes && campoEsperado !== 'mes') outros.push('mes');

    if (outros.length === 1) return { tipo: outros[0], valor: numero, candidatos: null };
    // valor preservado mesmo em caso ambíguo: quem chama precisa do número original
    // para aplicar ao campo que o usuário escolher na desambiguação.
    if (outros.length > 1) return { tipo: 'ambiguo', valor: numero, candidatos: outros };
    return { tipo: 'indeterminado', valor: null, candidatos: null };
}

// ============================================================
// VALIDAÇÃO DE MONTAGEM
// ============================================================

function calcularIdade(isoNascimento, isoHoje) {
    const [anoN, mesN, diaN] = isoNascimento.split('-').map(Number);
    const [anoH, mesH, diaH] = isoHoje.split('-').map(Number);
    let idade = anoH - anoN;
    if (mesH < mesN || (mesH === mesN && diaH < diaN)) idade--;
    return idade;
}

// Quando a combinação é inválida, o campoARefazer é sempre 'dia' — é o campo com
// maior chance de erro; o mês é declarado com mais confiança (nome por extenso ou
// abreviação), não importa qual dos três componentes tenha causado a invalidade.
export function montarDataNascimento({ dia, mes, ano }) {
    if (!Number.isInteger(dia) || dia < 1 || dia > 31) return { valida: false, campoARefazer: 'dia' };
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) return { valida: false, campoARefazer: 'dia' };
    if (!Number.isInteger(ano)) return { valida: false, campoARefazer: 'dia' };

    const diasNoMes = new Date(ano, mes, 0).getDate();
    if (dia > diasNoMes) return { valida: false, campoARefazer: 'dia' };

    const hoje = hojeBRT();
    const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    if (iso > hoje) return { valida: false, campoARefazer: 'dia' };

    const idade = calcularIdade(iso, hoje);
    if (idade < 0 || idade > 110) return { valida: false, campoARefazer: 'dia' };

    return { valida: true, iso };
}
