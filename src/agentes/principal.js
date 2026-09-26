// ============================================================
// PRINCIPAL — a porta única (v45 P1 §3–§4)
//
// UMA chamada de interpretação por turno: o principal recebe o turno
// inteiro (doses do bloco único com refs curtas, pendência aberta,
// eventos proativos, mensagem citada) e devolve UMA decisão:
//   { tipo, message, doses, delegar, actions, candidatas, ... }
// O LLM relata o fato; o código executa (router + dosesDoTurno).
//
// A montagem do contexto é PURA (sem banco): o roteador passa os dados
// lidos do banco e o adaptador `principal_p1` do corpus passa os dados
// do itens.json — os dois pelo mesmo caminho.
// ============================================================

import 'dotenv/config';
import { NAMI_SYSTEM_PROMPT } from '../prompts.js';
import { classificarComFerramenta } from '../validadores/llm.js';
import { limparDosagemDoNome } from '../porta.js';
import { nomeEscritoNaMensagem } from '../nlp_helpers.js';
import { AINDA_NAO, NUNCA } from '../inventario.js';
import {
    updateUserName,
    registrarMovimentoEstoque,
    getEstoqueStatusSimples,
    calcularProximaDose,
    formatarHistoricoConversa
} from '../database.js';
// v44 §5.7: nenhum template de estoque vive aqui — autor único é
// src/templates/estoqueTemplates.js (P30), montado de leitura pós-escrita.
import { buildAlertaEstoquePosAjuste, buildEstoqueAtualizadoMessage } from '../templates/estoqueTemplates.js';

export const MODELO_PRINCIPAL = process.env.PRINCIPAL_MODEL || 'claude-sonnet-4-6';

const TIPOS = ['responder', 'dose', 'delegar', 'perguntar'];
// P1-copy §3: `ainda_nao` = a dose segue aguardando (nada é gravado).
const FATOS = ['tomou', 'nao_tomou', 'ainda_nao', 'desfazer'];
// P1-copy §8: o item do inventário que a pessoa pediu — a reserva do "ainda
// não faço" nomeia o item em vez de dizer "isso".
const CHAVES_AINDA_NAO = AINDA_NAO.map(i => i.chave);
const CHAVES_INVENTARIO = [...CHAVES_AINDA_NAO, ...NUNCA.map(i => i.chave)];
const ESPECIALISTAS = ['cadastro', 'configuracao', 'relatorios', 'excluir_conta', 'nao_suportado'];
const RELACOES = ['responde', 'novo', 'sem_pendencia'];
const SUBTIPOS = ['balanco_do_dia', 'meus_remedios', 'estoque', 'proximo_remedio', 'progresso_tratamento', 'historico_encerrados', 'nenhum'];
const FEEDBACKS = ['elogio', 'critica', 'sugestao'];

// ------------------------------------------------------------
// Contexto (§3) — montado por código, em blocos, nesta ordem.
// ------------------------------------------------------------

function textoAgora(agora) {
    const data = agora.toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'long', timeZone: 'America/Sao_Paulo'
    });
    const hora = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    return `${data}, ${hora}`;
}

function textoMedicamentos(medicamentos) {
    if (!medicamentos?.length) return 'nenhum ainda';
    return medicamentos.map(m => {
        if (typeof m === 'string') return `- ${m}`;
        const schedulesAtivos = (m.schedules || []).filter(s => s.ativo);
        const horarios = schedulesAtivos.length
            ? schedulesAtivos.map(s => String(s.horario).slice(0, 5)).join(', ')
            : 'nenhum horário cadastrado';
        const proxima = calcularProximaDose(schedulesAtivos);
        const proximaStr = proxima ? `próxima dose: ${proxima.horario} (${proxima.quando})` : 'sem próxima dose calculada';
        // P49: "não informado" nunca vira "estoque: null". §5.7: com dose em
        // aberto, o número pré-débito é neutralizado (autor único do número).
        const estoque = (m.estoque_atual === null || m.estoque_atual === undefined)
            ? 'estoque: não informado'
            : m.temDoseEmAberto
                ? 'estoque: registrado (número comunicado pelo sistema após a confirmação — não cite)'
                : `estoque: ${m.estoque_atual}`;
        const status = m.status && m.status !== 'ativo' ? `, ${m.status}` : '';
        return `- [id:${m.id}] ${m.nome} (${m.dosagem || 'dosagem não informada'}, ${estoque}, horários: ${horarios}, ${proximaStr}, tipo: ${m.tipo_tratamento || 'contínuo'}${status})`;
    }).join('\n');
}

function textoPendencia(pendencia) {
    if (!pendencia) return 'Nenhuma — a conversa está livre (estado idle).';
    const linhas = [
        `Fluxo: ${pendencia.fluxo}${pendencia.etapa ? ` · etapa ${pendencia.etapa}` : ''}`,
        pendencia.pergunta ? `Pergunta que ficou aberta: "${String(pendencia.pergunta).replace(/\s+/g, ' ').slice(0, 400)}"` : null,
        pendencia.obrigatoria === true ? 'Resposta: obrigatória para o fluxo terminar.'
            : pendencia.obrigatoria === false ? 'Resposta: OPCIONAL (convite) — nunca prende a pessoa.' : null,
        pendencia.quando ? `Perguntada: ${pendencia.quando}` : null,
        pendencia.maisRecente ? `Mais recente entre a pergunta aberta e o último lembrete de dose: ${pendencia.maisRecente}` : null,
        pendencia.mensagemPreservada ? `Mensagem preservada da pessoa (pós-cadastro inicial): "${String(pendencia.mensagemPreservada).slice(0, 600)}"` : null
    ];
    return linhas.filter(Boolean).join('\n');
}

const ROTULOS_EVENTO_PROATIVO = {
    lembrete: 'lembrete de dose',
    follow_up: 'cobrança de dose',
    alerta_estoque_zerado: 'aviso de estoque zerado (lembrete da dose)',
    alerta_estoque_nao_informado: 'aviso de dose sem confirmação',
    resumo_semanal: 'resumo semanal de adesão',
    conclusao_tratamento: 'aviso de conclusão de tratamento'
};

function textoEventosProativos(eventos) {
    if (!eventos?.length) return 'Nenhum desde a última mensagem da pessoa.';
    return eventos.map(ev => {
        const rotulo = ROTULOS_EVENTO_PROATIVO[ev.tipo] || 'mensagem automática';
        const tentativa = ev.tipo === 'follow_up' && ev.tentativa ? ` (cobrança ${ev.tentativa})` : '';
        const med = ev.medicamento ? ` — ${ev.medicamento}${ev.horarioAgendado ? ` (dose das ${ev.horarioAgendado})` : ''}` : '';
        const quando = ev.enviadoAt
            ? ` — ${new Date(ev.enviadoAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`
            : '';
        return `- ${rotulo}${tentativa}${med}${quando}`;
    }).join('\n');
}

export function montarContextoPrincipal({
    user = null, agora = new Date(), estado = 'idle', blocoDoses, pendencia = null,
    eventosProativos = [], medicamentos = [], historicoConversa = [],
    especialistaDevolveu = null, mensagem, temImagem = false
}) {
    return `
=== CONTEXTO ===
Nome da pessoa: ${user?.name || 'ainda não informado'}
Agora é ${textoAgora(agora)} (horário de Brasília). Nunca calcule datas por conta própria.
Estado da conversa: ${estado}

=== DOSES ===
${blocoDoses}

=== PENDÊNCIA ABERTA ===
${textoPendencia(pendencia)}

=== EVENTOS PROATIVOS DESDE O ÚLTIMO TURNO DA PESSOA ===
${textoEventosProativos(eventosProativos)}

=== MEDICAMENTOS CADASTRADOS ===
${textoMedicamentos(medicamentos)}

=== CONVERSA RECENTE (para resolver referências como "ele", "esse", "ok") ===
${formatarHistoricoConversa(historicoConversa)}
${especialistaDevolveu ? `
=== ATENÇÃO: O ESPECIALISTA "${especialistaDevolveu}" DEVOLVEU ESTE TURNO ===
Ele concluiu que a mensagem não é dele. As doses e ações deste turno JÁ foram executadas — não as
repita. Decida só o destino: outro especialista, ou responder/perguntar você mesma.
` : ''}
=== FIM DO CONTEXTO ===

Mensagem da pessoa: ${mensagem || (temImagem ? '[a pessoa enviou uma imagem]' : '')}
`.trim();
}

// ------------------------------------------------------------
// Decisão (§4) — tool-use com schema.
// ------------------------------------------------------------

const FERRAMENTA = {
    type: 'object',
    properties: {
        tipo: { type: 'string', enum: TIPOS, description: 'A parte principal do turno.' },
        message: { type: 'string', description: 'Texto para a pessoa. Obrigatório em responder/perguntar, em nao_suportado sem chave e em toda resposta negativa (nao_tomou/ainda_nao); VAZIO em confirmação pura e em delegação.' },
        doses: {
            type: 'array',
            description: 'Fatos relatados sobre doses do bloco DOSES. Vazio se nenhum.',
            items: {
                type: 'object',
                properties: {
                    ref: { type: 'string', description: 'Referência do bloco, ex.: "D2".' },
                    fato: { type: 'string', enum: FATOS }
                },
                required: ['ref', 'fato']
            }
        },
        candidatas: { type: 'array', items: { type: 'string' }, description: 'Em "perguntar" sobre dose: as refs candidatas.' },
        delegar: {
            type: 'object',
            description: 'Preencha quando o turno tem parte para um especialista.',
            properties: {
                especialista: { type: 'string', enum: ESPECIALISTAS },
                relacao_pendencia: { type: 'string', enum: RELACOES },
                chave_ainda_nao: { type: 'string', enum: CHAVES_INVENTARIO, description: 'Só com especialista "nao_suportado": o item do inventário que a pessoa pediu.' },
                campos: {
                    type: 'object',
                    properties: {
                        medicamentos: { type: 'array', items: { type: 'string' } },
                        horarios: { type: 'array', items: { type: 'string' } },
                        medicamento: { type: 'string' },
                        expressaoData: { type: 'string' },
                        subtipo: { type: 'string', enum: SUBTIPOS }
                    }
                }
            },
            required: ['especialista', 'relacao_pendencia']
        },
        actions: { type: 'array', items: { type: 'object' }, description: 'Ações do seu domínio: UPDATE_STOCK, SET_USER_NAME.' },
        newState: { type: 'string', enum: ['idle', 'confirming'] },
        feedback: { type: 'string', enum: [...FEEDBACKS, 'nenhum'] },
        mensagem_citada_relevante: { type: 'boolean' }
    },
    required: ['tipo', 'message', 'doses', 'feedback']
};

function decisaoValida(input) {
    if (!input || !TIPOS.includes(input.tipo) || typeof input.message !== 'string') return false;
    if (!Array.isArray(input.doses)) return false;
    if (input.doses.some(d => !d?.ref || !FATOS.includes(d.fato))) return false;
    if ((input.tipo === 'responder' || input.tipo === 'perguntar') && !input.message.trim()) return false;
    if (input.tipo === 'delegar' && !ESPECIALISTAS.includes(input.delegar?.especialista)) return false;
    // Sem texto do principal, a reserva do "ainda não faço" precisa da chave.
    if (input.delegar?.especialista === 'nao_suportado' && !input.message.trim()
        && !CHAVES_AINDA_NAO.includes(input.delegar?.chave_ainda_nao)) return false;
    // P1-copy §2.2: resposta negativa sempre tem o acolhimento do principal.
    if (input.doses.some(d => d.fato === 'nao_tomou' || d.fato === 'ainda_nao') && !input.message.trim()) return false;
    if (input.tipo === 'dose' && input.doses.length === 0) return false;
    return true;
}

export const DECISAO_DEGRADADA = { tipo: 'degradado', message: '', doses: [], actions: [], delegar: null, feedback: 'nenhum' };

// Normaliza a proposta: o que o código vai de fato olhar, sem campo solto.
export function normalizarDecisao(input, mensagem = null) {
    const d = input?.delegar && ESPECIALISTAS.includes(input.delegar.especialista) ? input.delegar : null;
    const campos = d?.campos || {};
    const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
        tipo: input.tipo,
        message: (input.message || '').trim(),
        doses: (input.doses || []).map(x => ({ ref: String(x.ref).trim(), fato: x.fato })),
        candidatas: Array.isArray(input.candidatas) ? input.candidatas.map(String) : [],
        delegar: d ? {
            especialista: d.especialista,
            relacao_pendencia: RELACOES.includes(d.relacao_pendencia) ? d.relacao_pendencia : 'sem_pendencia',
            chaveAindaNao: CHAVES_AINDA_NAO.includes(d.chave_ainda_nao) ? d.chave_ainda_nao : null,
            campos: {
                // O campo DECLARA "sem dosagem": o contrato é feito cumprir aqui, no
                // mesmo ponto único da porta (replay 21/09, "Predsin 2mg 2mg").
                medicamentos: Array.isArray(campos.medicamentos)
                    ? campos.medicamentos.map(m => limparDosagemDoNome(String(m).trim()))
                        .filter(m => m && (mensagem === null || nomeEscritoNaMensagem(m, mensagem)))
                    : [],
                horarios: Array.isArray(campos.horarios) ? campos.horarios.map(h => String(h).trim()).filter(Boolean) : [],
                medicamento: texto(campos.medicamento),
                expressaoData: texto(campos.expressaoData),
                subtipo: SUBTIPOS.includes(campos.subtipo) && campos.subtipo !== 'nenhum' ? campos.subtipo : null
            }
        } : null,
        actions: Array.isArray(input.actions) ? input.actions : [],
        newState: input.newState === 'confirming' ? 'confirming' : 'idle',
        feedback: FEEDBACKS.includes(input.feedback) ? input.feedback : null,
        mensagemCitadaRelevante: input.mensagem_citada_relevante === true
    };
}

// UMA chamada de interpretação. Duas tentativas; na falha dupla, degradar()
// e o roteador faz a pergunta segura.
export async function interpretarComPrincipal({ contexto, mensagem = null, image = null, model = MODELO_PRINCIPAL }) {
    const content = image
        ? [{ type: 'image', source: { type: 'url', url: image } }, { type: 'text', text: contexto }]
        : [{ type: 'text', text: contexto }];

    const { parsed, degradado } = await classificarComFerramenta({
        systemPrompt: NAMI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        maxTokens: 1200,
        model,
        nomeFerramenta: 'responder_usuario',
        descricaoFerramenta: 'Registra a decisão do turno: responder, relatar doses, delegar ou perguntar.',
        schema: FERRAMENTA,
        validar: decisaoValida,
        motivo: 'principal_decisao_invalida',
        agent: 'principal',
        origem: 'principal',
        fallback: DECISAO_DEGRADADA
    });
    if (degradado || parsed?.tipo === 'degradado') return null;
    return normalizarDecisao(parsed, mensagem);
}

// ------------------------------------------------------------
// Ações do domínio do principal (sem mudança de comportamento).
// ------------------------------------------------------------

async function executarAcao(action, user) {
    switch (action?.type) {
        case 'SET_USER_NAME':
            if (action.name) await updateUserName(user.id, action.name);
            return '';

        case 'UPDATE_STOCK': {
            if (!action.medicationId) {
                console.warn('⚠️ UPDATE_STOCK sem medicationId — ignorando');
                return '';
            }
            let params;
            switch (action.modo) {
                case 'soma':
                    params = { tipo: action.motivo === 'recompra' ? 'recompra' : 'correcao_soma', delta: action.quantidade };
                    break;
                case 'subtracao':
                    params = { tipo: 'correcao_subtracao', delta: -action.quantidade };
                    break;
                case 'set':
                    params = { tipo: 'correcao_set', valorAbsoluto: action.quantidade };
                    break;
                default:
                    console.warn(`⚠️ UPDATE_STOCK com modo desconhecido: ${action.modo}`);
                    return '';
            }

            const { estoqueAnterior, estoqueNovo, deltaAplicado } = await registrarMovimentoEstoque({
                medicationId: action.medicationId,
                origem: 'manual',
                motivo: action.motivo || null,
                ...params
            });

            try {
                const statusInfo = await getEstoqueStatusSimples(action.medicationId);
                if (!statusInfo) return '';
                // Informativo determinístico (nunca o número que o LLM escreveu).
                return buildEstoqueAtualizadoMessage({
                    medNome: statusInfo.medNome,
                    estoqueAnterior,
                    estoqueNovo,
                    deltaAplicado,
                    quantidadeSolicitada: action.modo === 'set' ? null : action.quantidade
                }) + buildAlertaEstoquePosAjuste(statusInfo);
            } catch (e) {
                console.error('⚠️ Erro ao montar mensagem de estoque atualizado:', e.message);
                return '';
            }
        }

        default:
            console.warn(`⚠️ Ação fora do domínio do principal: ${action?.type}`);
            return '';
    }
}

export async function executarAcoesDoPrincipal(actions, user) {
    let texto = '';
    for (const acao of actions || []) {
        try {
            texto += await executarAcao(acao, user);
        } catch (e) {
            console.error(`⚠️ Erro ao executar ${acao?.type}:`, e.message);
        }
    }
    return texto.replace(/^\n+/, '');
}
