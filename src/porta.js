// ============================================================
// PORTA ÚNICA DE INTERPRETAÇÃO (v44 M1, briefing §5.1)
//
// UMA chamada de interpretação por turno de usuário onboarded:
// { intencao, campos, feedback, mensagem_citada_relevante }.
//
// A saída é PROPOSTA, nunca decisão — o LLM propõe, o código dispõe:
// campos passam pelos validadores existentes dos especialistas e a
// transição de estado é computada pelo roteador.
//
// Tool-use com schema, NUNCA JSON em texto livre (lição do
// parse_json_falhou — Felipe 18/09 13:21). Um retry em falha de
// schema; segunda falha → degradar() e o roteador faz a repergunta
// segura.
//
// A porta consulta o inventário (três listas) como PORTÃO: pedido que
// não mapeia para uma entrada do FAZ dentro do limite nunca vira
// confirmação — vira nao_suportado (honestidade, Constituição regra 6).
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { CAPACIDADES, NAO_SUPORTADO, NUNCA } from './inventario.js';
import { degradar } from './observabilidade.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INTENCOES_VALIDAS = ['cadastro', 'relatorios', 'configuracao', 'principal', 'excluir_conta', 'nao_suportado'];
// P4 (M3): 'adesao' morreu (pedidos caem no período livre do balanço);
// 'historico_encerrados' nasceu (MH-31).
const SUBTIPOS_VALIDOS = ['balanco_do_dia', 'meus_remedios', 'estoque', 'proximo_remedio', 'progresso_tratamento', 'historico_encerrados'];
const FEEDBACKS_VALIDOS = ['elogio', 'critica', 'sugestao'];

function ferramentaInterpretacao(excluirPrincipal) {
    const intencoes = excluirPrincipal
        ? INTENCOES_VALIDAS.filter(i => i !== 'principal')
        : INTENCOES_VALIDAS;
    return {
        name: 'interpretar_turno',
        description: 'Registra a interpretação estruturada do turno atual do usuário.',
        input_schema: {
            type: 'object',
            properties: {
                intencao: { type: 'string', enum: intencoes },
                subtipo_relatorio: {
                    type: 'string',
                    enum: [...SUBTIPOS_VALIDOS, 'nenhum'],
                    description: 'Obrigatório quando intencao=relatorios; "nenhum" nos demais casos.'
                },
                campos: {
                    type: 'object',
                    properties: {
                        medicamentos: {
                            type: 'array', items: { type: 'string' },
                            description: 'Nomes de medicamentos citados NESTA mensagem para cadastrar, exatamente como o usuário escreveu (sem dosagem). Vazio se nenhum.'
                        },
                        horarios: {
                            type: 'array', items: { type: 'string' },
                            description: 'Expressões de horário citadas, como escritas ("8h", "19:30"). Vazio se nenhuma.'
                        },
                        medicamento: {
                            type: 'string',
                            description: 'Para relatórios/configuração: o medicamento alvo, como escrito. String vazia se não houver.'
                        },
                        expressaoData: {
                            type: 'string',
                            description: 'Expressão de tempo usada, SEM converter ("hoje", "ontem", "domingo", "19/07"). String vazia se não houver. NUNCA calcule a data.'
                        }
                    },
                    required: ['medicamentos', 'horarios', 'medicamento', 'expressaoData']
                },
                feedback: {
                    type: 'string',
                    enum: [...FEEDBACKS_VALIDOS, 'nenhum'],
                    description: 'Feedback do usuário SOBRE A NAMI (não sobre o remédio/tratamento). "nenhum" na maioria das mensagens.'
                },
                mensagem_citada_relevante: {
                    type: 'boolean',
                    description: 'true apenas se houver mensagem citada no contexto E ela mudar a interpretação deste turno.'
                }
            },
            required: ['intencao', 'subtipo_relatorio', 'campos', 'feedback']
        }
    };
}

function montarPrompt({ message, currentState, historicoTexto, mensagemCitada }) {
    const agentesTexto = CAPACIDADES.map(c => `- ${c.agente}: ${c.descricao}${c.limites ? ` — LIMITE: ${c.limites}` : ''}`).join('\n');
    const naoSuportadoTexto = NAO_SUPORTADO.map(item => `- ${item}`).join('\n');
    const subtipoRelatoriosTexto = CAPACIDADES
        .find(c => c.agente === 'relatorios').subtipos
        .map(s => `- ${s.chave}: ${s.descricao}`).join('\n');

    return `Você é a PORTA de interpretação da Nami, assistente de saúde via WhatsApp.

Interprete o turno do usuário e registre a proposta pela ferramenta interpretar_turno.
Sua saída é PROPOSTA, nunca decisão: o código valida os campos e decide a transição.

INTENÇÕES E SUAS CAPACIDADES (lista FAZ):
${agentesTexto}

O QUE A NAMI AINDA NÃO FAZ (proponha "nao_suportado" — a Nami NUNCA confirma o que não está no FAZ):
${naoSuportadoTexto}

O QUE A NAMI NUNCA FARÁ (fronteira de segurança — proponha "principal", que responde
redirecionando a médico/farmacêutico, sem prometer que "está chegando"):
${NUNCA.map(item => `- ${item.rotulo}`).join('\n')}

SUBTIPOS DE RELATÓRIO (obrigatório escolher um quando intencao=relatorios):
${subtipoRelatoriosTexto}

REGRAS:
- Estado atual da conversa pesa: no meio de um fluxo (adding_med, configurando), uma
  resposta curta ("9", "sim", "de manhã") é normalmente continuação — proponha a intenção
  do fluxo corrente, não uma nova.
- Mensagem que lista medicamento(s) com ou sem horários é intenção de cadastro, mesmo sem
  verbo ("Bariatron 12:00", "Fluoxetina 08:00 e 20:00").
- Mensagem que TRAZ medicamento(s) para cadastrar é SEMPRE "cadastro" — mesmo com VÁRIOS
  medicamentos de uma vez, ou com padrão de dias da semana/recorrência (o cadastro já
  representa dias da semana, dia sim/dia não e 1x por semana; para o que ainda não faz,
  é ele quem responde com honestidade SEM descartar o que a pessoa já disse).
  "nao_suportado" é só para pedidos sem caminho nenhum (exportar histórico, conectar
  cuidador, registrar sintomas, áudio/foto).
- FEEDBACK é dimensão independente: avalie sempre. "ok"/"obrigado" isolado é reação, não elogio.
- excluir_conta é APAGAR A CONTA INTEIRA, nunca remover um remédio/horário (isso é configuracao).

ESTADO ATUAL: ${currentState}

HISTÓRICO RECENTE:
${historicoTexto}
${mensagemCitada ? `
MENSAGEM CITADA (o usuário respondeu citando esta mensagem anterior):
[${mensagemCitada.origem} — ${mensagemCitada.quando}] "${mensagemCitada.texto}"
` : ''}
MENSAGEM ATUAL: "${message}"`;
}

function normalizarProposta(input, excluirPrincipal) {
    const intencao = String(input?.intencao || '').trim().toLowerCase();
    const validas = excluirPrincipal ? INTENCOES_VALIDAS.filter(i => i !== 'principal') : INTENCOES_VALIDAS;
    if (!validas.includes(intencao)) return null;

    const subtipoRaw = String(input?.subtipo_relatorio || '').trim().toLowerCase();
    const subtipoRelatorio = SUBTIPOS_VALIDOS.includes(subtipoRaw) ? subtipoRaw : null;
    if (intencao === 'relatorios' && !subtipoRelatorio) {
        // subtipo ausente não invalida a proposta — o despacho de relatórios já
        // trata subtipo null caindo no principal (comportamento existente).
    }

    const feedbackRaw = String(input?.feedback || '').trim().toLowerCase();
    const feedback = FEEDBACKS_VALIDOS.includes(feedbackRaw) ? feedbackRaw : null;

    const camposRaw = input?.campos || {};
    const limparTexto = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    const campos = {
        medicamentos: Array.isArray(camposRaw.medicamentos)
            ? camposRaw.medicamentos.map(m => String(m).trim()).filter(Boolean) : [],
        horarios: Array.isArray(camposRaw.horarios)
            ? camposRaw.horarios.map(h => String(h).trim()).filter(Boolean) : [],
        medicamento: limparTexto(camposRaw.medicamento),
        expressaoData: limparTexto(camposRaw.expressaoData)
    };

    return {
        intencao,
        subtipoRelatorio: intencao === 'relatorios' ? subtipoRelatorio : null,
        campos,
        feedback,
        mensagemCitadaRelevante: input?.mensagem_citada_relevante === true
    };
}

// Devolve a proposta normalizada, ou null quando as DUAS tentativas falham —
// o roteador trata null com a repergunta segura (P31: o fallback vive no
// retorno de quem registra a degradação).
export async function interpretarTurno({ message, currentState, historicoConversa = [], contextoProativo = null, mensagemCitada = null, excluirPrincipal = false }) {
    const historicoTexto = renderizarHistorico(historicoConversa, contextoProativo);
    const prompt = montarPrompt({ message, currentState, historicoTexto, mensagemCitada });
    const ferramenta = ferramentaInterpretacao(excluirPrincipal);

    for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
            const resposta = await anthropic.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 600,
                tools: [ferramenta],
                tool_choice: { type: 'tool', name: 'interpretar_turno' },
                messages: [{ role: 'user', content: prompt }]
            });

            const toolUse = resposta.content.find(b => b.type === 'tool_use' && b.name === 'interpretar_turno');
            const proposta = toolUse ? normalizarProposta(toolUse.input, excluirPrincipal) : null;
            if (proposta) {
                console.log(`🚪 [PORTA] intenção: ${proposta.intencao}${proposta.subtipoRelatorio ? ` (${proposta.subtipoRelatorio})` : ''} — campos: ${JSON.stringify(proposta.campos)} — "${String(message).slice(0, 80)}"`);
                return proposta;
            }
            console.warn(`⚠️ [PORTA] Proposta inválida na tentativa ${tentativa} — ${JSON.stringify(toolUse?.input ?? null).slice(0, 300)}`);
        } catch (e) {
            console.error(`❌ [PORTA] Erro na tentativa ${tentativa}: ${e.message}`);
        }
    }

    return await degradar({
        origem: 'porta',
        motivo: 'interpretacao_falhou_duas_vezes',
        agent: 'porta',
        detalhe: { mensagem: String(message).slice(0, 200), estado: currentState },
        fallback: null
    });
}

// ------------------------------------------------------------
// Renderização do histórico — mesma linha do tempo do classificador
// anterior (MH-70 Parte C): rótulo de tempo determinístico por turno,
// eventos proativos ao fim, descritivos, sem instrução de precedência.
// ------------------------------------------------------------

function formatarTempoRelativo(timestamp) {
    const minutos = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
    if (minutos < 1) return 'agora mesmo';
    if (minutos < 60) return `há ${minutos} min`;
    const horas = Math.round(minutos / 60);
    if (horas < 24) return `há ${horas}h`;
    const dias = Math.round(horas / 24);
    return `há ${dias} dia${dias > 1 ? 's' : ''}`;
}

const ROTULOS_EVENTO_PROATIVO = {
    lembrete: 'lembrete de dose',
    follow_up: 'follow-up de dose',
    alerta_estoque_zerado: 'aviso de estoque zerado',
    alerta_estoque_nao_informado: 'aviso de estoque (dose não confirmada)',
    resumo_semanal: 'resumo semanal de adesão',
    conclusao_tratamento: 'aviso de conclusão de tratamento'
};

function renderizarHistorico(historicoConversa, contextoProativo) {
    const historicoReativo = historicoConversa.length > 0
        ? historicoConversa.map(h => {
            const contextoResumo = h.contexto_conversa?.medicationNome
                ? ` [em andamento: configuração sobre ${h.contexto_conversa.medicationNome}, etapa ${h.contexto_conversa.etapa}]`
                : '';
            const tempo = h.created_at ? ` (${formatarTempoRelativo(h.created_at)})` : '';
            return `Usuário: ${h.user_message}\nNami: ${h.agent_response}${contextoResumo}${tempo}`;
          }).join('\n\n')
        : 'Sem histórico recente.';

    if (!contextoProativo || contextoProativo.length === 0) return historicoReativo;

    const linhas = contextoProativo.map(ev => {
        const rotulo = ROTULOS_EVENTO_PROATIVO[ev.tipo] || 'mensagem automática';
        const tentativaTexto = ev.tipo === 'follow_up' && ev.tentativa ? ` (cobrança ${ev.tentativa})` : '';
        const medTexto = ev.medicamento
            ? ` — ${ev.medicamento}${ev.horarioAgendado ? ` (dose das ${ev.horarioAgendado})` : ''}`
            : '';
        return `Nami: ${rotulo}${tentativaTexto}${medTexto} — enviado ${formatarTempoRelativo(ev.enviadoAt)}`;
    }).join('\n');

    return `${historicoReativo}\n\n[mensagens automáticas da Nami — sem resposta do usuário até aqui]\n${linhas}`;
}
