// ============================================================
// VALIDADOR DETERMINÍSTICO DE RECORRÊNCIA (v44 §5.7 → M2 MH-77)
//
// No M1 este validador só BLOQUEAVA (honestidade de limite). No M2
// ele passa a PREENCHER: padrões representáveis viram estrutura por
// horário — "seg-sex 6h, sáb-dom 10h" = dois schedules com
// dias_semana distintos; "dia sim, dia não" = intervalo_dias 2.
//
// Modelo de dados (descoberta de código, M2 §4): schedules.dias_semana
// JÁ EXISTE como text[] ('seg'..'dom'), DEFAULT todos os dias, e a RPC
// get_pending_reminders JÁ filtra por ela — aproveitado, não recriado
// (o briefing supunha int[] dormente; o modelo real é melhor: zero
// impacto no legado, que carrega o default de 7 dias).
//
// O que fica FORA (honestidade, inventário): "a cada N semanas",
// ciclos 21/7 e afins — detectados e bloqueados como antes.
//
// Determinístico, sem custo de LLM. Vocabulário canônico: validador.
// ============================================================

const PADROES = [
    { nome: 'dia_da_semana', re: /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bados?|domingos?)(\s*[-\s]feira)?\b/i },
    { nome: 'abreviacao_de_dias', re: /\b(seg|ter|qua|qui|sex|s[áa]b|dom)\.?\s*(?:[-–]|a|à|ate|até|e)\s*(seg|ter|qua|qui|sex|s[áa]b|dom)\b/i },
    { nome: 'fim_de_semana', re: /\bfi(?:m|ns)\s+de\s+semana\b/i },
    { nome: 'dia_sim_dia_nao', re: /\bdia\s+sim,?\s+dia\s+n[ãa]o\b|\bdias?\s+alternados?\b/i },
    { nome: 'x_por_semana', re: /\b(\d+|uma|duas|tr[êe]s)\s*(x|vez(?:es)?)\s*(por|na|a cada)\s+semana\b|\bsemanalmente\b/i }
];

const RE_A_CADA_N_DIAS = /\ba\s+cada\s+(\d+)\s*dias?\b/i;
const RE_A_CADA_N_SEMANAS = /\ba\s+cada\s+(\d+)\s*semanas?\b/i;

export function detectarRecorrenciaNaoSuportada(texto) {
    const t = String(texto || '');
    const padroes = [];

    for (const { nome, re } of PADROES) {
        if (re.test(t)) padroes.push(nome);
    }

    const aCadaNDias = t.match(RE_A_CADA_N_DIAS);
    if (aCadaNDias && Number(aCadaNDias[1]) >= 2) padroes.push('a_cada_n_dias');
    if (RE_A_CADA_N_SEMANAS.test(t)) padroes.push('a_cada_n_semanas');

    return { detectado: padroes.length > 0, padroes };
}

// Horários citados na mensagem, com índice de posição (para associar cada
// horário ao grupo de dias que o precede).
// Commit 0 do M3 (caso Evandro, produção 20/09): os sufixos reais de horário
// incluem "hs", "hrs", "hr" e "horas" — "às 17hs" não casava com (?::|h) e o
// lote inteiro deixava de disparar. UM lugar só: multi-med, recorrência e a
// interpretação estruturada derivam daqui.
// O lookbehind (?<![\d/]) impede que o "12" de "12/12 hrs" (notação de
// intervalo de receita) seja lido como horário 12:00.
const SUFIXO_HORA = '(?::|h(?:oras?|rs?|s)?)';
const RE_HORARIO = new RegExp(`(?<![\\d/])\\b([01]?\\d|2[0-3])\\s*${SUFIXO_HORA}\\s*([0-5]\\d)?\\b`, 'gi');

export function extrairHorariosCitados(texto) {
    const achados = [];
    let m;
    const re = new RegExp(RE_HORARIO.source, 'gi');
    while ((m = re.exec(String(texto || ''))) !== null) {
        const hora = String(m[1]).padStart(2, '0');
        const minuto = m[2] || '00';
        const hhmm = `${hora}:${minuto}`;
        if (!achados.includes(hhmm)) achados.push(hhmm);
    }
    return achados;
}

// ------------------------------------------------------------
// INTERPRETAÇÃO ESTRUTURADA (MH-77) — de texto a dias por horário.
// ------------------------------------------------------------

const DIA_CANONICO = [
    { codigo: 'dom', re: /^(dom|domingos?)$/ },
    { codigo: 'seg', re: /^(seg|segunda)$/ },
    { codigo: 'ter', re: /^(ter|terca)$/ },
    { codigo: 'qua', re: /^(qua|quarta)$/ },
    { codigo: 'qui', re: /^(qui|quinta)$/ },
    { codigo: 'sex', re: /^(sex|sexta)$/ },
    { codigo: 'sab', re: /^(sab|sabados?)$/ }
];
const ORDEM_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
export const TODOS_OS_DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];

function normalizarTexto(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function codigoDoDia(token) {
    const limpo = token.replace(/[-\s]?feiras?$/, '');
    return DIA_CANONICO.find(d => d.re.test(limpo))?.codigo ?? null;
}

function intervaloDeDias(de, ate) {
    const i = ORDEM_SEMANA.indexOf(de);
    const j = ORDEM_SEMANA.indexOf(ate);
    if (i === -1 || j === -1) return [];
    const dias = [];
    for (let k = i; ; k = (k + 1) % 7) {
        dias.push(ORDEM_SEMANA[k]);
        if (k === j) break;
    }
    return dias;
}

// Interpreta o texto e devolve:
//   null                                  → nenhum padrão de recorrência
//   { suportada: false, padroes }         → padrão fora do representável (bloqueio)
//   { suportada: true, diasPorHorario,    → estrutura pronta para o schema
//     diasSemHorario, intervaloDias, padroes }
//
// diasPorHorario: { 'HH:MM': ['seg',...] } — horários com grupo de dias próprio.
// diasSemHorario: dias citados SEM horário na mensagem (aplicam-se aos horários
// já coletados/futuros). intervaloDias: 2 = dia sim/dia não; N = a cada N dias.
export function interpretarRecorrencia(texto) {
    const deteccao = detectarRecorrenciaNaoSuportada(texto);
    if (!deteccao.detectado) return null;

    // Fora do representável: ciclos por semanas.
    if (deteccao.padroes.includes('a_cada_n_semanas')) {
        return { suportada: false, padroes: deteccao.padroes };
    }

    const t = normalizarTexto(texto);

    let intervaloDias = null;
    if (deteccao.padroes.includes('dia_sim_dia_nao')) intervaloDias = 2;
    const mACada = t.match(RE_A_CADA_N_DIAS);
    if (mACada && Number(mACada[1]) >= 2) intervaloDias = Number(mACada[1]);

    // Varredura sequencial: tokens de dia acumulam um GRUPO; o(s) horário(s)
    // seguinte(s) recebem o grupo. Grupo novo começa no próximo token de dia.
    const reToken = new RegExp(
        '(fi(?:m|ns)\\s+de\\s+semana|dias?\\s+uteis|todos?\\s+os\\s+dias|' +
        '(?:segunda|terca|quarta|quinta|sexta|sabados?|domingos?)(?:[-\\s]feiras?)?|' +
        '\\b(?:seg|ter|qua|qui|sex|sab|dom)\\b|' +
        '\\b(?:a|à|ate|e)\\b|[-–]|' +
        `${RE_HORARIO.source})`, 'gi');

    const diasPorHorario = {};
    let grupoAtual = [];
    let ultimoDia = null;
    let emIntervalo = false;
    let grupoUsado = false;
    let m;

    while ((m = reToken.exec(t)) !== null) {
        const token = m[0].trim();

        if (/^fi(?:m|ns)\s+de\s+semana$/.test(token)) {
            if (grupoUsado) { grupoAtual = []; grupoUsado = false; }
            grupoAtual.push('sab', 'dom');
            ultimoDia = null;
            continue;
        }
        if (/^dias?\s+uteis$/.test(token)) {
            if (grupoUsado) { grupoAtual = []; grupoUsado = false; }
            grupoAtual.push('seg', 'ter', 'qua', 'qui', 'sex');
            ultimoDia = null;
            continue;
        }
        if (/^todos?\s+os\s+dias$/.test(token)) {
            if (grupoUsado) { grupoAtual = []; grupoUsado = false; }
            grupoAtual = [...TODOS_OS_DIAS];
            ultimoDia = null;
            continue;
        }

        const dia = codigoDoDia(token);
        if (dia) {
            if (grupoUsado) { grupoAtual = []; grupoUsado = false; }
            if (emIntervalo && ultimoDia) {
                const faixa = intervaloDeDias(ultimoDia, dia);
                grupoAtual = [...new Set([...grupoAtual.filter(d => d !== ultimoDia), ...faixa])];
                emIntervalo = false;
            } else if (!grupoAtual.includes(dia)) {
                grupoAtual.push(dia);
            }
            ultimoDia = dia;
            continue;
        }

        if (/^(a|à|ate|[-–])$/.test(token)) {
            if (ultimoDia) emIntervalo = true;
            continue;
        }
        if (token === 'e') continue;

        // Horário: fecha o grupo corrente sobre ele (mesmo sufixo da RE_HORARIO).
        const hm = token.match(new RegExp(`^([01]?\\d|2[0-3])\\s*${SUFIXO_HORA}\\s*([0-5]\\d)?$`));
        if (hm) {
            const hhmm = `${String(hm[1]).padStart(2, '0')}:${hm[2] || '00'}`;
            if (grupoAtual.length > 0) {
                const ordenados = ORDEM_SEMANA.filter(d => grupoAtual.includes(d));
                diasPorHorario[hhmm] = [...new Set([...(diasPorHorario[hhmm] || []), ...ordenados])];
                grupoUsado = true;
            }
            emIntervalo = false;
        }
    }

    const diasSemHorario = (!grupoUsado && grupoAtual.length > 0)
        ? ORDEM_SEMANA.filter(d => grupoAtual.includes(d))
        : null;

    const temEstrutura = Object.keys(diasPorHorario).length > 0
        || (diasSemHorario && diasSemHorario.length > 0)
        || intervaloDias !== null;

    // Padrão semanal ("1x por semana") sem dia nomeado: não há como montar a
    // grade — segue para o bloqueio honesto, que pede o dia.
    if (!temEstrutura) {
        return { suportada: false, padroes: deteccao.padroes };
    }

    return {
        suportada: true,
        padroes: deteccao.padroes,
        diasPorHorario: Object.keys(diasPorHorario).length > 0 ? diasPorHorario : null,
        diasSemHorario,
        intervaloDias
    };
}

// Rótulo humano de um conjunto de dias (para resumo/renderizações).
const ROTULO_DIA = { dom: 'dom', seg: 'seg', ter: 'ter', qua: 'qua', qui: 'qui', sex: 'sex', sab: 'sáb' };

export function rotuloDias(diasSemana) {
    const dias = diasSemana || [];
    if (dias.length === 0 || dias.length === 7) return null;
    const ordenados = ORDEM_SEMANA.filter(d => dias.includes(d));
    // Faixa contínua na semana "civil" seg→dom fica mais natural: seg a sex.
    const ordemUtil = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
    const idx = ordenados.map(d => ordemUtil.indexOf(d)).sort((a, b) => a - b);
    const contigua = idx.length >= 3 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    if (contigua) return `${ROTULO_DIA[ordemUtil[idx[0]]]} a ${ROTULO_DIA[ordemUtil[idx[idx.length - 1]]]}`;
    return idx.map(i => ROTULO_DIA[ordemUtil[i]]).join(' e ');
}
