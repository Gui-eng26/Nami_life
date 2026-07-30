import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import 'dotenv/config';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ÚNICO ponto de escrita em system_events e feedbacks.
// REGRA CRÍTICA: estas funções NUNCA lançam exceção.

// tipo: 'erro_tecnico' | 'desvio_comportamental' | 'intencao_nao_suportada'
// severidade: 'baixa' | 'media' | 'alta' | 'critica'
// origem: 'catch_global' | 'classificador_central' | 'juiz_offline' | 'scheduler' | 'outro'
// titulo: resumo ESTÁVEL/templatizado (o fingerprint agrupa por ele) — NUNCA a mensagem crua.
// payload: NÃO conter texto cru do usuário (invariante de LGPD). Amarre ao texto via agentLogId.

// Deriva um título ESTÁVEL a partir de um erro, para alimentar o fingerprint.
// Estável entre ocorrências do MESMO defeito; ainda distingue defeitos diferentes.
// O detalhe volátil (mensagem, request_id, stack) vive no payload, nunca aqui.
export function tituloEstavel(error, prefixo) {
    const nome = error?.name || 'Error';
    const status = error?.status ?? error?.response?.status ?? null;
    return `${prefixo}: ${nome}${status ? ` ${status}` : ''}`.slice(0, 200);
}

export async function registrarEvento({
    tipo, severidade, userId = null, agent = null, origem,
    agentLogId = null, titulo = null, payload = null
}) {
    try {
        const fingerprint = crypto.createHash('sha1')
            .update(`${tipo}|${titulo || ''}|${agent || ''}`)
            .digest('hex');

        const { error } = await supabase.from('system_events').insert({
            tipo, severidade, user_id: userId, agent, origem,
            agent_log_id: agentLogId, titulo, payload, fingerprint
        });
        if (error) console.error(`[observabilidade] Falha ao registrar evento: ${error.message}`);
    } catch (e) {
        console.error(`[observabilidade] Exceção ao registrar evento: ${e.message}`);
    }
}

// categoria: 'elogio' | 'critica' | 'sugestao'
// origem: 'espontaneo' | 'proativo_adesao' | 'proativo_outro'
export async function registrarFeedback({
    userId = null, categoria, origem = 'espontaneo', texto, agentLogId = null
}) {
    try {
        const { error } = await supabase.from('feedbacks').insert({
            user_id: userId, categoria, origem, texto, agent_log_id: agentLogId
        });
        if (error) console.error(`[observabilidade] Falha ao registrar feedback: ${error.message}`);
    } catch (e) {
        console.error(`[observabilidade] Exceção ao registrar feedback: ${e.message}`);
    }
}

// status: 'sucesso' | 'falha_parcial' | 'falha_total'
// Ponto ÚNICO de escrita em juiz_offline_execucoes (MH-58) — nunca insert direto em outro lugar.
export async function registrarExecucaoJuizOffline({
    dataAvaliada, turnosTotais = null, episodiosTotais = null,
    episodiosPuladosIdempotencia = 0, episodiosAvaliados = 0,
    episodiosFalhaJulgamento = 0, turnosAvaliados = 0, eventosRegistrados = 0,
    status, erroResumo = null
}) {
    try {
        const { error } = await supabase.from('juiz_offline_execucoes').insert({
            data_avaliada: dataAvaliada,
            turnos_totais: turnosTotais,
            episodios_totais: episodiosTotais,
            episodios_pulados_idempotencia: episodiosPuladosIdempotencia,
            episodios_avaliados: episodiosAvaliados,
            episodios_falha_julgamento: episodiosFalhaJulgamento,
            turnos_avaliados: turnosAvaliados,
            eventos_registrados: eventosRegistrados,
            status,
            erro_resumo: erroResumo
        });
        if (error) console.error(`[observabilidade] Falha ao registrar execução do juiz offline: ${error.message}`);
    } catch (e) {
        console.error(`[observabilidade] Exceção ao registrar execução do juiz offline: ${e.message}`);
    }
}
