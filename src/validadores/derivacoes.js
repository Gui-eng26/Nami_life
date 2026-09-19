// ============================================================
// DERIVAÇÕES DETERMINÍSTICAS DO CADASTRO (v44 M2 — mudança de
// endereço, não de lógica: vieram de agentes/cadastro.js)
//
// Nenhuma função aqui chama LLM. São as tabelas fechadas e as
// contas puras que o schema (perguntas/resumos) e os validadores
// compartilham. Vocabulário canônico: validador.
// ============================================================

export const FORMAS_VALIDAS = new Set(['comprimido', 'capsula', 'colirio', 'gotas', 'pomada', 'injetavel', 'xarope']);
export const UNIDADES_DOSE_VALIDAS = new Set(['unidade', 'gota', 'ml']);
export const HORARIO_REGEX = /^\d{2}:\d{2}$/;

export function horarioValido(h) {
    if (typeof h !== 'string' || !HORARIO_REGEX.test(h)) return false;
    const [hh, mm] = h.split(':').map(Number);
    return hh <= 23 && mm <= 59;
}

// BUG-99: as únicas formas coerentes com cada unidade de dose já resolvida.
// Usado para descartar PALPITES incompatíveis — nunca para descartar o que o
// usuário disse explicitamente.
const FORMAS_COMPATIVEIS = {
    unidade: new Set(['comprimido', 'capsula', 'pomada', 'injetavel']),
    gota: new Set(['colirio', 'gotas']),
    ml: new Set(['xarope', 'colirio', 'gotas'])
};

export function formaCompativelComUnidade(forma, unidadeDose) {
    if (!forma || !unidadeDose) return true;
    const compativeis = FORMAS_COMPATIVEIS[unidadeDose];
    return !compativeis || compativeis.has(forma);
}

// unidade_dose é chave de comportamento (P45) e tem CHECK no schema do banco.
// Esta tabela é a ÚNICA fonte das outras duas colunas.
export function derivarUnidades(unidadeDose) {
    switch (unidadeDose) {
        case 'gota': return { unidade_dose: 'gota', unidade_estoque: 'ml', gotas_por_ml: 20 };
        case 'ml': return { unidade_dose: 'ml', unidade_estoque: 'ml', gotas_por_ml: null };
        default: return { unidade_dose: 'unidade', unidade_estoque: 'unidade', gotas_por_ml: null };
    }
}

// Ordem de confiança: o que o usuário disse literalmente > o que ele confirmou
// > rótulo genérico derivado da unidade. NUNCA retorna null nem 'comprimido' default.
export const ROTULO_CANONICO = {
    comprimido: 'comprimido', capsula: 'cápsula', colirio: 'colírio',
    gotas: 'gotas', pomada: 'pomada', injetavel: 'injetável', xarope: 'xarope'
};
const ROTULO_GENERICO = { unidade: 'unidade', gota: 'gotas', ml: 'líquido' };

export function derivarFormaFarmaceutica(formaExplicita, formaConfirmada, unidadeDose) {
    return ROTULO_CANONICO[formaExplicita]
        ?? ROTULO_CANONICO[formaConfirmada]
        ?? ROTULO_GENERICO[unidadeDose]
        ?? 'unidade';
}

// BUG-93: o rótulo da QUANTIDADE vem da unidade de dose (ml/gota) ou, para
// "unidade", da forma quando ela é contável — nunca da forma em geral.
const ROTULO_DOSE = { ml: 'ml', gota: 'gota' };

export function rotuloDaDose(unidadeDose, forma) {
    if (ROTULO_DOSE[unidadeDose]) return ROTULO_DOSE[unidadeDose];
    return ['comprimido', 'cápsula'].includes(forma) ? forma : 'unidade';
}

export function pluralizarRotulo(rotulo, quantidade) {
    if (Number(quantidade) === 1) return rotulo;
    const plurais = {
        unidade: 'unidades', comprimido: 'comprimidos', capsula: 'cápsulas', cápsula: 'cápsulas',
        gota: 'gotas'
    };
    return plurais[rotulo] || rotulo;
}

// ============================================================
// GRADE DE HORÁRIOS A PARTIR DE FREQUÊNCIA (BUG-041) — dado de
// saúde calculado em código, nunca pelo LLM (Princípio 28).
// ============================================================

export function calcularHorariosPorIntervalo(horarioInicio, intervaloHoras) {
    if (!horarioInicio || !intervaloHoras || intervaloHoras <= 0) return [];

    const dosesPerDia = Math.round(24 / intervaloHoras);
    if (dosesPerDia < 1) return [];

    const [h, m] = horarioInicio.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return [];

    const horarios = [];
    let minutoAtual = h * 60 + m;

    for (let i = 0; i < dosesPerDia; i++) {
        const minutoNormalizado = ((minutoAtual % 1440) + 1440) % 1440;
        const hh = String(Math.floor(minutoNormalizado / 60)).padStart(2, '0');
        const mm = String(minutoNormalizado % 60).padStart(2, '0');
        horarios.push(`${hh}:${mm}`);
        minutoAtual += intervaloHoras * 60;
    }

    return horarios;
}

// Recebe a lista de horários e ou (a) uma quantidade única aplicada a todos, ou
// (b) o mapa de quantidades por horário. Devolve sempre [{horario, quantidade}]
// ordenado por horário, sem duplicatas de horário.
export function montarParesPosologia(horarios, quantidadePorHorario) {
    const unicos = [...new Set((horarios || []).filter(h => HORARIO_REGEX.test(h)))];
    unicos.sort();

    if (Array.isArray(quantidadePorHorario)) {
        const mapa = new Map(quantidadePorHorario.map(p => [p.horario, p.quantidade]));
        return unicos.map(h => ({ horario: h, quantidade: Number(mapa.get(h)) || 1 }));
    }

    const quantidade = Number(quantidadePorHorario) || 1;
    return unicos.map(h => ({ horario: h, quantidade }));
}

// v36 Briefing #1: quando a mensagem traz UM horário e um intervalo, o horário é
// o INÍCIO da grade — expandir em código, nunca no LLM.
export function expandirParesPorIntervalo(classificacao) {
    const { pares, intervaloHoras } = classificacao;
    if (!intervaloHoras || !Array.isArray(pares) || pares.length !== 1) return null;

    const inicio = classificacao.horarioInicio || pares[0].horario;
    const horarios = calcularHorariosPorIntervalo(inicio, intervaloHoras);
    if (horarios.length <= 1) return null;

    return {
        pares: montarParesPosologia(horarios, pares[0].quantidade),
        horarios,
        intervalo_horas: intervaloHoras,
        horario_inicio: inicio
    };
}
