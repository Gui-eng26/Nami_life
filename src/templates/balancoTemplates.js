// ============================================================
// BLOCO FACTUAL DO BALANÇO DO DIA (v25)
// Este bloco é renderizado 100% em código e inserido LITERALMENTE na mensagem final.
// O LLM escreve apenas a moldura (abertura/fechamento) ao redor dele e está proibido
// de citar horário, nome ou status fora daqui. Preserva o princípio 13 (apresentação
// de dado de saúde é determinística) enquanto permite calor na comunicação.
// Módulo de funções puras — sem I/O.
// ============================================================

const ICONE = {
    confirmado: '✅',
    nao_informado: '⏳',
    nao_tomado: '❌',
    sem_estoque: '📦',
    pendente: '🔜'
};

const DESCRICAO = {
    confirmado: 'confirmado',
    nao_informado: 'sem confirmação',
    nao_tomado: 'não tomado',
    sem_estoque: 'sem estoque',
    pendente: 'ainda não chegou o horário'
};

export function montarBlocoFactual(doses) {
    return doses.map(d => {
        const icone = ICONE[d.status] || '•';
        const desc = DESCRICAO[d.status] || d.status;
        const sufixo = d.confirmadaRetroativamente ? ' (confirmado depois)' : '';
        return `${icone} *${d.nome}* — ${d.horario} — ${desc}${sufixo}`;
    }).join('\n');
}

// Resumo estrutural entregue ao LLM para ele escolher o tom (não vai para o usuário).
export function resumirSituacao(doses) {
    const total = doses.length;
    const confirmadas = doses.filter(d => d.status === 'confirmado').length;
    const pendentesFuturas = doses.filter(d => d.status === 'pendente').length;
    const faltantes = doses.filter(d =>
        d.status === 'nao_informado' || d.status === 'nao_tomado' || d.status === 'sem_estoque'
    ).length;

    let cenario;
    if (total === 0) cenario = 'sem_doses';
    else if (faltantes === 0 && pendentesFuturas === 0) cenario = 'tudo_confirmado';
    else if (confirmadas === 0 && pendentesFuturas === total) cenario = 'nada_chegou_ainda';
    else if (confirmadas === 0) cenario = 'nada_confirmado';
    else cenario = 'parcial';

    return { total, confirmadas, faltantes, pendentesFuturas, cenario };
}

// Moldura padrão — usada quando a chamada ao LLM falha (fallback defensivo).
export function molduraPadrao({ nome, rotuloData, resumo }) {
    const abertura = resumo.total === 0
        ? `${nome}, não encontrei doses agendadas para ${rotuloData}.`
        : `${nome}, aqui está como ficou ${rotuloData}:`;

    let fechamento = '';
    if (resumo.cenario === 'tudo_confirmado') {
        fechamento = 'Tudo certinho! Continue assim! 💪';
    } else if (resumo.faltantes > 0) {
        fechamento = 'Se você tomou alguma dessas e só não me avisou, é só me dizer qual. 💊';
    }
    return { abertura, fechamento };
}

export const TEXTO_FORA_DA_JANELA =
    `Consigo olhar seus registros dos últimos 30 dias. 🌿\nPara um período mais antigo que isso, ainda não tenho como buscar.`;

export const TEXTO_DATA_FUTURA =
    `Essa data ainda não chegou! 😊\nPosso te mostrar como está hoje ou como foi em algum dia anterior — é só me dizer.`;

export const TEXTO_DATA_NAO_RECONHECIDA =
    `Não consegui identificar de qual dia você está falando. 🌿\nPode me dizer assim: "hoje", "ontem", ou a data (ex: 19/07)?`;
