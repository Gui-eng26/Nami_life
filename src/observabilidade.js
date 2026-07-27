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
