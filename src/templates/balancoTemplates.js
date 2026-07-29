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
    pendente: '❓',
    agendado: '🔜'
};

// 'pendente' = lembrete JÁ enviado, aguardando resposta do usuário (não é dose futura).
// 'agendado' = status sintético para dose do dia que ainda não tem linha em dose_logs.
function descrever(d) {
    switch (d.status) {
        case 'confirmado': return 'confirmado';
        case 'nao_informado': return 'sem confirmação';
        case 'nao_tomado': return 'não tomado';
        case 'sem_estoque': return 'sem estoque';
        case 'pendente': return 'aguardando sua confirmação';
        case 'agendado': return d.horarioJaPassou ? 'sem registro ainda' : 'ainda não chegou o horário';
        default: return d.status;
    }
}

export function montarBlocoFactual(doses) {
    return doses.map(d => {
        const icone = ICONE[d.status] || '•';
        const sufixo = d.confirmadaRetroativamente ? ' (confirmado depois)' : '';
        return `${icone} *${d.nome}* — ${d.horario} — ${descrever(d)}${sufixo}`;
    }).join('\n');
}

// Resumo estrutural entregue ao LLM para ele escolher o tom (não vai para o usuário).
export function resumirSituacao(doses) {
    const total = doses.length;
    const confirmadas = doses.filter(d => d.status === 'confirmado').length;
    const aguardandoConfirmacao = doses.filter(d => d.status === 'pendente').length;
    const aindaNaoChegaram = doses.filter(d => d.status === 'agendado' && !d.horarioJaPassou).length;
    const faltantes = doses.filter(d =>
        d.status === 'nao_informado' || d.status === 'nao_tomado' || d.status === 'sem_estoque'
    ).length;
    const semRegistro = doses.filter(d => d.status === 'agendado' && d.horarioJaPassou).length;

    let cenario;
    if (total === 0) cenario = 'sem_doses';
    else if (confirmadas === total) cenario = 'tudo_confirmado';
    else if (confirmadas === 0 && aindaNaoChegaram === total) cenario = 'nada_chegou_ainda';
    else if (confirmadas === 0) cenario = 'nada_confirmado';
    else cenario = 'parcial';

    return { total, confirmadas, faltantes, aguardandoConfirmacao,
             aindaNaoChegaram, semRegistro, cenario };
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
