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

// ============================================================
// DEGRADAÇÃO CONTROLADA (MH-064, v26)
//
// Une "devolver fallback" e "registrar que degradou" numa expressão só. A regra NÃO é que esta
// função seja dona do texto — é que o valor de fallback só existe como RETORNO dela. Assim fica
// estruturalmente impossível ter um sem o outro, porque quem quer o fallback passa por quem
// registra. Mesma forma do princípio 30 (ponto único de despacho), aplicada à degradação.
//
// A chave é `origem:motivo` — origem é o local no código (fixo por call site, não é julgamento)
// e motivo é sintoma observável (princípio 26), nunca causa inferida. Severidade e título vêm
// da tabela, NUNCA do call site: dois pontos equivalentes escolhendo severidades diferentes
// desordenam a fila de triagem. O título é templatizado porque alimenta o fingerprint
// (princípio 25) — o detalhe volátil vive no `detalhe`, fora do hash.
// ============================================================

const DEGRADACOES = {
    'principal:parse_json_falhou': {
        severidade: 'alta',
        titulo: 'Resposta do principal não pôde ser interpretada — ação descartada'
    },
    'cadastro:parse_json_falhou': {
        severidade: 'media',
        titulo: 'Resposta do cadastro não pôde ser interpretada — etapa mantida'
    },
    'configuracao:classificacao_falhou': {
        severidade: 'alta',
        titulo: 'Classificação de intenção da configuração caiu no default'
    },
    'exclusao_conta:deteccao_llm_falhou': {
        severidade: 'alta',
        titulo: 'Detecção de pedido de exclusão falhou — assumido NÃO'
    },
    'exclusao_conta:exclusao_falhou': {
        severidade: 'critica',
        titulo: 'Falha ao executar exclusão de conta (LGPD)'
    },
    'contexto_proativo:query_falhou': {
        severidade: 'media',
        titulo: 'Contexto proativo não pôde ser lido — classificador seguiu sem ele'
    },
    'data_nascimento:etapa_ruido_nao_reconhecida': {
        severidade: 'media',
        titulo: 'Etapa não reconhecida ao montar mensagem de ruído na coleta de nascimento'
    },
    'recepcionista:classificador_lgpd_falhou': {
        severidade: 'alta',
        titulo: 'Classificador de consentimento LGPD falhou — assumido indeterminado, nunca aceite'
    },
    'recepcionista:classificador_intencao_inicial_falhou': {
        severidade: 'media',
        titulo: 'Classificador de intenção inicial falhou — assumido neutro'
    },
    'recepcionista:classificador_resposta_convite_falhou': {
        severidade: 'media',
        titulo: 'Classificador de resposta ao convite (MH-074) falhou — assumido ruido'
    },
    'recepcionista:classificador_nome_falhou': {
        severidade: 'media',
        titulo: 'Classificador de nome (BUG-30) falhou — assumido indeterminado'
    },
    'estado_pos_onboarding:classificador_destino_falhou': {
        severidade: 'media',
        titulo: 'Classificador de destino pós-onboarding falhou — assumido outro (post_onboarding)'
    },
    'cadastro:classificador_posologia_falhou': {
        severidade: 'media',
        titulo: 'Classificador de posologia falhou — etapa repete a pergunta'
    },
    'cadastro:classificador_campo_simples_falhou': {
        severidade: 'media',
        titulo: 'Classificador de campo simples (nome/dosagem) falhou — etapa repete a pergunta'
    },
    'cadastro:classificador_tipo_tratamento_falhou': {
        severidade: 'media',
        titulo: 'Classificador de tipo de tratamento falhou — etapa repete a pergunta'
    },
    'cadastro:classificador_confirmacao_falhou': {
        severidade: 'alta',
        titulo: 'Classificador de confirmação de cadastro falhou — usuário pode ter confirmado sem avançar'
    },
    'cadastro:classificador_forma_sugerida_falhou': {
        severidade: 'baixa',
        titulo: 'Sugestão de forma farmacêutica falhou — segue sem palpite'
    },
    'cadastro:salvamento_com_estado_incompleto': {
        severidade: 'critica',
        titulo: 'Cadastro salvo com posologia vazia ou estoque não resolvido'
    },
    'cadastro:classificador_estoque_falhou': {
        severidade: 'alta',
        titulo: 'Classificador de estoque sólido falhou — etapa repete a pergunta'
    },
    'cadastro:extracao_cadastro_completo_falhou': {
        severidade: 'baixa',
        titulo: 'Extração de cadastro completo (MH-80) falhou — fluxo segue etapa a etapa'
    },
    'cadastro:palpite_forma_incompativel': {
        severidade: 'baixa',
        titulo: 'Palpite de forma farmacêutica descartado por incompatibilidade com a unidade de dose'
    },
    'cadastro:forma_explicita_incompativel': {
        severidade: 'media',
        titulo: 'Usuário informou forma farmacêutica incompatível com a unidade de dose já resolvida'
    },
    'cadastro:confirmacao_sem_resumo': {
        severidade: 'critica',
        titulo: 'cad_confirmacao alcançada sem resumo montado — posologia ou estoque incompletos'
    }
};

const DEGRADACAO_NAO_CATALOGADA = {
    severidade: 'media',
    titulo: 'Degradação controlada não catalogada'
};

/**
 * Registra uma degradação controlada e devolve o fallback recebido.
 *
 * @param {string}   origem   - local no código: 'principal', 'cadastro', 'configuracao', 'exclusao_conta'
 * @param {string}   motivo   - sintoma observável: 'parse_json_falhou', 'classificacao_falhou',
 *                              'deteccao_llm_falhou', 'exclusao_falhou'
 * @param {string}   agent    - agente para o campo `agent` de system_events
 * @param {string?}  userId
 * @param {object?}  detalhe  - APENAS estrutura. Nunca texto de usuário nem saída de LLM.
 * @param {*}        fallback - o valor devolvido ao chamador, tal e qual
 * @returns {Promise<*>} o próprio `fallback`
 */
export async function degradar({ origem, motivo, agent, userId = null, detalhe = null, fallback }) {
    const chave = `${origem}:${motivo}`;
    const cat = DEGRADACOES[chave] || DEGRADACAO_NAO_CATALOGADA;

    console.error(`⚠️ [DEGRADACAO] ${chave}${detalhe ? ` — ${JSON.stringify(detalhe)}` : ''}`);

    await registrarEvento({
        tipo: 'erro_tecnico',
        severidade: cat.severidade,
        userId,
        agent,
        origem: 'outro',
        titulo: cat.titulo,
        payload: { origem, motivo, catalogado: !!DEGRADACOES[chave], ...(detalhe || {}) }
    });

    return fallback;
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
