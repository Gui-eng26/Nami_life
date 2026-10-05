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
// src/templates/ (P30), montado de leitura pós-escrita. v47 Onda 2: o lookup
// fato → texto passa pelo catálogo (renderização canônica única).
import { renderizarCanonico } from '../templates/catalogo.js';

export const MODELO_PRINCIPAL = process.env.PRINCIPAL_MODEL || 'claude-sonnet-4-6';

// P1-ajustes 3 §1.2: tipos, fatos e regras de cada tipo vêm do contrato único.
import { TIPOS, FATOS, violacaoDoContrato, textoDasRegras } from '../contratoPrincipal.js';
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
        // Validação Etapa 1 (30/09, caso Rivotril): a instrução antiga citava
        // um "sistema" que comunicaria o número, e o principal ECOOU isso à
        // pessoa (REGRA ABSOLUTA violada) em vez de buscar o valor. Agora ela
        // manda a ação certa: pedido de estoque → relatorios/estoque (banco).
        const estoque = (m.estoque_atual === null || m.estoque_atual === undefined)
            ? 'estoque: não informado'
            : m.temDoseEmAberto
                ? 'estoque: registrado (não cite um número de memória; se a pessoa PERGUNTAR o estoque, delegue a relatorios com subtipo "estoque")'
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
    // Legado: eventos anteriores à v47 ainda existem na tabela.
    alerta_estoque_nao_informado: 'aviso de dose sem confirmação',
    resumo_semanal: 'resumo semanal de adesão',
    conclusao_tratamento: 'aviso de conclusão de tratamento',
    // v47 §5: mensagem individual escrita/aprovada pela equipe, enviada pela Nami.
    mensagem_direcionada: 'mensagem individual que você enviou à pessoa'
};

function textoEventosProativos(eventos) {
    if (!eventos?.length) return 'Nenhum desde a última mensagem da pessoa.';
    return eventos.map(ev => {
        const rotulo = ROTULOS_EVENTO_PROATIVO[ev.tipo] || 'mensagem automática';
        const tentativa = ev.tipo === 'follow_up' && ev.tentativa ? ` (cobrança ${ev.tentativa})` : '';
        const med = ev.medicamento ? ` — ${ev.medicamento}${ev.horarioAgendado ? ` (dose das ${ev.horarioAgendado})` : ''}` : '';
        const resumo = ev.tipo === 'mensagem_direcionada' && ev.resumo ? ` — sobre: "${ev.resumo}"` : '';
        const quando = ev.enviadoAt
            ? ` — ${new Date(ev.enviadoAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`
            : '';
        return `- ${rotulo}${tentativa}${med}${resumo}${quando}`;
    }).join('\n');
}

// v47 ajuste-referente §1 (C1 do BUG-117): a mensagem direcionada enviada
// depois do último turno da pessoa entra na CONVERSA RECENTE como FALA da
// Nami, com texto INTEGRAL — e a ordem é afirmada por código (extensão do
// mecanismo `maisRecente` de montarPendencia): o modelo não estima tempo.
function textoFalaDirecionada(falaDirecionada) {
    if (!falaDirecionada?.texto) return '';
    const hora = new Date(falaDirecionada.enviadoAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    return `
Nami (mensagem individual, ${hora}): "${String(falaDirecionada.texto).replace(/\s+/g, ' ')}"
A ordem é um fato: a fala mais recente da Nami é esta mensagem individual (${hora}) — a pessoa está respondendo a uma conversa em que esta foi a última coisa dita.`;
}

export function montarContextoPrincipal({
    user = null, agora = new Date(), estado = 'idle', blocoDoses, pendencia = null,
    eventosProativos = [], medicamentos = [], historicoConversa = [],
    especialistaDevolveu = null, especialistaNaoExecuta = null, mensagem, temImagem = false,
    falaDirecionada = null
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
${formatarHistoricoConversa(historicoConversa)}${textoFalaDirecionada(falaDirecionada)}
${especialistaDevolveu ? `
=== ATENÇÃO: O ESPECIALISTA "${especialistaDevolveu}" DEVOLVEU ESTE TURNO ===
Ele concluiu que a mensagem não é dele. As doses e ações deste turno JÁ foram executadas — não as
repita. Decida só o destino: outro especialista, ou responder/perguntar você mesma.
` : ''}${especialistaNaoExecuta ? `
=== ATENÇÃO: O ESPECIALISTA "${especialistaNaoExecuta}" ENTENDEU O PEDIDO E NÃO EXECUTA ===
O pedido é claro e é algo que a Nami AINDA NÃO FAZ. As doses e ações deste turno JÁ foram
executadas — não as repita. Não delegue a ninguém e não diga que não entendeu: delegue
"nao_suportado" com "pedido" (e "chave_ainda_nao", se for um caso conhecido). O texto do "ainda
não" é do sistema: deixe "message" vazia.
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
        tipo: { type: 'string', enum: TIPOS, description: `A parte principal do turno. Regras de cada tipo:\n${textoDasRegras()}` },
        message: { type: 'string', description: 'Texto para a pessoa — obrigatório ou vazio conforme as regras do tipo (ver "tipo").' },
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
                pedido: { type: 'string', description: 'Paráfrase curta do que a pessoa pediu, com as palavras dela. Obrigatório com "nao_suportado"; recomendado em toda delegação.' },
                misto_com_nunca: { type: 'boolean', description: 'Só com "nao_suportado": o pedido mistura uma parte da lista NUNCA (ex.: decisão sobre dose) com o "ainda não".' },
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

// P1-ajustes 3 §1.2: o validador lê o MESMO contrato que o prompt descreve.
export function decisaoValida(input) {
    const violacao = violacaoDoContrato(input, { especialistas: ESPECIALISTAS, chavesAindaNao: CHAVES_AINDA_NAO });
    if (violacao) console.warn(`⚠️ [PRINCIPAL] decisão fora do contrato — ${violacao}`);
    return !violacao;
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
            pedido: texto(d.pedido) ? texto(d.pedido).slice(0, 200) : null,
            mistoComNunca: d.misto_com_nunca === true,
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
        descricaoFerramenta: `Registra a decisão do turno: ${TIPOS.join(', ')}.`,
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
                return {
                    linha: renderizarCanonico('estoque_atualizado', {
                        medNome: statusInfo.medNome,
                        estoqueAnterior,
                        estoqueNovo,
                        deltaAplicado,
                        quantidadeSolicitada: action.modo === 'set' ? null : action.quantidade,
                        unidadeEstoque: statusInfo.unidadeEstoque,
                        medForma: statusInfo.medForma
                    }),
                    alerta: renderizarCanonico('alerta_estoque', { contexto: 'pos_ajuste', statusInfo }),
                    // v47 Onda 1 (compositor): dados prontos do fato de estoque.
                    dados: { medNome: statusInfo.medNome, medicationId: action.medicationId, estoqueNovo, nivel: statusInfo.status }
                };
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

// v45 P1-ajustes 2 §2 — o texto do turno de estoque é todo do código: uma
// linha 📦 por remédio, a abertura uma vez só (ausente quando a confirmação de
// dose do mesmo turno já abriu a mensagem), alertas depois das linhas.
// v47 Onda 1: devolve { texto, fatos } — os fatos de estoque entram na mesma
// composição do turno quando há fatos de dose; o texto segue sendo a
// renderização canônica (fallback e turnos só de ação).
export async function executarAcoesDoPrincipal(actions, user, { abertura = null } = {}) {
    const linhas = [];
    let alertas = '';
    const fatos = [];
    for (const acao of actions || []) {
        try {
            const r = await executarAcao(acao, user);
            if (r?.linha) {
                linhas.push(r.linha);
                alertas += r.alerta || '';
                if (r.dados) {
                    fatos.push({
                        tipo: 'estoque_atualizado', sujeito: 'usuario',
                        medicamento: r.dados.medNome, medicationId: r.dados.medicationId,
                        estoqueNovo: r.dados.estoqueNovo, canonico: r.linha
                    });
                    if (r.alerta) {
                        fatos.push({
                            tipo: 'alerta_estoque', sujeito: 'usuario', nivel: r.dados.nivel,
                            medicamento: r.dados.medNome, medicationId: r.dados.medicationId,
                            canonico: r.alerta.trim()
                        });
                    }
                }
            }
        } catch (e) {
            console.error(`⚠️ Erro ao executar ${acao?.type}:`, e.message);
        }
    }
    if (!linhas.length) return { texto: '', fatos };
    return { texto: (abertura ? `${abertura} ` : '') + linhas.join('\n') + alertas, fatos };
}
