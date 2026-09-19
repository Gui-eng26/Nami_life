import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque,
    saveConversationState, getHistoricoRecente, getContextoProativoRecente,
    getDosesRetroativas, confirmarDoseRetroativa, usuarioRespondeuDesde,
    getEnvioFunilPorProviderId, getDosesDoEnvio } from './database.js';
import { registrarEvento, registrarFeedback } from './observabilidade.js';
import { buildAlertaEstoquePosConfirmacao, buildConviteEstoqueNaoCadastrado } from './templates/estoqueTemplates.js';
import { interpretarTurno } from './porta.js';
import { handleRecepcionista } from './agentes/recepcionista.js';
import { handlePrincipal } from './agentes/principal.js';
import { handleCadastro, repetirPerguntaCadastro } from './agentes/cadastro.js';
import { handleRelatorios, extrairPeriodo } from './agentes/relatorios.js';
import { handleConfiguracao } from './agentes/configuracao.js';
import { handleExclusaoConta, confirmarIntencaoExclusaoConta } from './agentes/exclusaoConta.js';
import { handleDataNascimento } from './agentes/data_nascimento.js';
import { isCancelamento, pareceExclusaoConta, normalizar } from './nlp_helpers.js';

// ============================================================
// IDEMPOTÊNCIA — descarta eventos duplicados da Z-API
// ============================================================

const processedMessages = new Map();
const MESSAGE_TTL_MS = 30_000;

function isDuplicateMessage(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    for (const [id, ts] of processedMessages.entries()) {
        if (now - ts > MESSAGE_TTL_MS) processedMessages.delete(id);
    }
    if (processedMessages.has(messageId)) return true;
    processedMessages.set(messageId, now);
    return false;
}

// ============================================================
// DOSE PENDENTE DE CONFIRMAÇÃO
// ============================================================

// Dose 'nao_informado' já esgotou o ciclo de tentativas — não é mais "pendente" no
// sentido de confirmação em andamento, é candidata a resposta tardia (BUG-035),
// tratada por tentarConfirmarRespostaTardia(). Ver histórico no BUG-035 (08/07/2026).
function filtrarDosesPendentes(doses) {
    return doses.filter(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado' &&
        d.status !== 'nao_informado' &&
        d.status !== 'sem_estoque'
    );
}

async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return filtrarDosesPendentes(doses).length > 0;
}

// ============================================================
// ALERTA/CONVITE DE ESTOQUE PÓS-CONFIRMAÇÃO — ponto único (P30)
// Mesma decisão nos três caminhos determinísticos de confirmação
// (referenceMessageId, resposta tardia, precedência de dose §5.4).
// ============================================================

async function montarAlertaEstoquePosConfirmacao(medicationId) {
    try {
        const estoqueInfo = await getEstoqueInfoParaAlerta(medicationId);
        if (!estoqueInfo) return '';

        const confirmacoesDoDia = await contarConfirmacoesHoje(medicationId);
        if (estoqueInfo.estoqueDesconhecido) {
            // v43 Bloco C Adendo 1: estoque nunca informado é um CONVITE, não um
            // alerta — e só na 1ª confirmação do dia, persistindo enquanto for NULL.
            return confirmacoesDoDia <= 1 ? buildConviteEstoqueNaoCadastrado(estoqueInfo) : '';
        }
        const deveAlertar = calcularAlertaEstoque({
            diasRestantes: estoqueInfo.diasRestantes,
            tipo_tratamento: estoqueInfo.tipo_tratamento,
            tratamento_dias: estoqueInfo.tratamento_dias,
            confirmacoesDoDia
        });
        return deveAlertar ? buildAlertaEstoquePosConfirmacao(estoqueInfo) : '';
    } catch (e) {
        console.error('⚠️ Erro ao verificar alerta de estoque pós-confirmação:', e.message);
        return '';
    }
}

// ============================================================
// FAST-PATH: RESPOSTA TARDIA AO ESGOTAMENTO (BUG-035)
// ============================================================

// Tenta confirmar diretamente (sem LLM) uma dose nao_informado quando o "Sim" do
// usuário é, comprovadamente, a 1ª resposta dele desde o esgotamento e ocorre
// dentro da janela de 24h. Fora dessas condições, retorna null.
async function tentarConfirmarRespostaTardia(user, message) {
    const dosesRetroativas = await getDosesRetroativas(user.id, 2); // já ordena scheduled_at desc
    if (dosesRetroativas.length === 0) return null;

    const maisRecente = dosesRetroativas[0];

    const dentroDe24h = (Date.now() - new Date(maisRecente.scheduled_at).getTime()) <= 24 * 60 * 60 * 1000;
    if (!dentroDe24h) return null;

    const referencia = maisRecente.ultima_tentativa_at || maisRecente.scheduled_at;
    const jaRespondeu = await usuarioRespondeuDesde(user.id, referencia);
    if (jaRespondeu) return null;

    // Monta o grupo (MH-032): doses nao_informado com o mesmo horario_agendado e mesmo
    // dia da mais recente. Sem horario_agendado (registro legado) → confirma só a própria dose.
    const grupo = maisRecente.horario_agendado
        ? dosesRetroativas.filter(d => d.horario_agendado === maisRecente.horario_agendado
            && new Date(d.scheduled_at).toDateString() === new Date(maisRecente.scheduled_at).toDateString())
        : [maisRecente];

    for (const dose of grupo) {
        await confirmarDoseRetroativa(dose.id, 'resposta tardia ao esgotamento (BUG-035)');
    }

    let alertaSufixo = '';
    const medicationIds = [...new Set(grupo.map(d => d.medication_id))];
    for (const medId of medicationIds) {
        alertaSufixo += await montarAlertaEstoquePosConfirmacao(medId);
    }

    const nomes = grupo.map(d => d.medications?.nome || 'seu remédio').join(' e ');
    const firstName = user.name ? user.name.split(' ')[0] : 'você';

    console.log(`✅ [FAST-PATH] Resposta tardia ao esgotamento confirmada (BUG-035) — ${user.phone} — ${nomes}`);

    return `✅ Anotei! Dose do *${nomes}* confirmada, ${firstName}. Continue assim! 💪💊${alertaSufixo}`;
}

// ============================================================
// FAST-PATH §5.4: DOSE VENCE COLETA (Constituição regra 5)
// Confirmação determinística do grupo pendente mais recente, ANTES de
// qualquer estado de coleta (adding_med, configurando, aguardando_*).
// Registra a dose primeiro; retoma a coleta depois, na mesma mensagem.
// Corrige a classe do caso Manô 19/09 (ramo 9 engolindo o ramo 12).
// ============================================================

function montarRetomadaColeta(state) {
    const s = state?.state;
    if (s === 'adding_med' || s === 'cadastrando_medicamento') {
        const etapa = state?.context?.etapa || '';
        if (etapa.startsWith('cad_estoque')) return 'E quando quiser me falar do estoque, tô aqui 🌿';
        return 'E quando quiser, seguimos com o cadastro de onde paramos 🌿';
    }
    if (s === 'configurando') return 'E quando quiser, seguimos com o ajuste de onde paramos 🌿';
    if (s === 'aguardando_periodo_adesao' || s === 'aguardando_escolha_tratamento') {
        return 'E quando quiser, seguimos com o relatório de onde paramos 🌿';
    }
    return null;
}

async function confirmarDosePendenteDeterministico(user, state) {
    const doses = await getRecentDoses(user.id, 1); // desc por scheduled_at
    const pendentes = filtrarDosesPendentes(doses);
    if (pendentes.length === 0) return null;

    // Grupo do lembrete mais recente (MH-032): mesmo horario_agendado, mesmo dia.
    const maisRecente = pendentes[0];
    const grupo = maisRecente.horario_agendado
        ? pendentes.filter(d => d.horario_agendado === maisRecente.horario_agendado
            && new Date(d.scheduled_at).toDateString() === new Date(maisRecente.scheduled_at).toDateString())
        : [maisRecente];

    for (const dose of grupo) {
        await confirmDoseByLogId(dose.id);
    }

    // Fato (número) só do template pós-escrita — autoria única (§5.7).
    let alertaSufixo = '';
    const medicationIds = [...new Set(grupo.map(d => d.medication_id))];
    for (const medId of medicationIds) {
        alertaSufixo += await montarAlertaEstoquePosConfirmacao(medId);
    }

    const nomes = [...new Set(grupo.map(d => d.medications?.nome || 'seu remédio'))].join(' e ');
    const firstName = user.name ? user.name.split(' ')[0] : 'você';

    let texto = `✅ Dose do *${nomes}* confirmada, ${firstName}! 💊${alertaSufixo}`;

    // Regra 5: registra a dose primeiro, retoma a coleta depois — o estado da
    // coleta NÃO é tocado; a retomada é só o convite na mesma mensagem.
    const retomada = montarRetomadaColeta(state);
    if (retomada) texto += `\n\n${retomada}`;

    console.log(`✅ [FAST-PATH §5.4] Dose vence coleta — ${grupo.length} dose(s) confirmadas — ${user.phone}`);
    return texto;
}

// ============================================================
// DETECÇÃO DE CONFIRMAÇÃO DE DOSE
// ============================================================

// Verifica se uma palavra aparece de forma independente no texto
// (não como parte de outra palavra — ex: "voltar" não deve bater em "voltaren")
function contemPalavraLivre(texto, palavra) {
    if (palavra.includes(' ')) return texto.includes(palavra); // frases: match direto
    return new RegExp(`(^|\\s)${palavra}(\\s|$|[.,!?])`).test(texto);
}

// Aberturas interrogativas — uma pergunta nunca é confirmação de dose, mesmo sem "?".
const ABERTURAS_INTERROGATIVAS = [
    'como', 'qual', 'quais', 'quanto', 'quantos', 'quantas',
    'quando', 'quem', 'onde', 'cade', 'cadê', 'sera', 'será',
    'o que', 'oq', 'porque', 'por que'
];

function detectarConfirmacaoDose(message) {
    if (!message) return false;
    const msg = message.toLowerCase().trim();

    // GUARDA DE INTERROGATIVA (v25) — pergunta não é confirmação.
    if (msg.endsWith('?')) return false;
    if (ABERTURAS_INTERROGATIVAS.some(a => msg.startsWith(a + ' '))) return false;

    // PRIMEIRO: negação explícita invalida qualquer confirmação
    // Prioridade à negação — falso negativo é recuperável via follow-up;
    // falso positivo corrompe dados de adesão
    const negacoes = [
        'não tomei', 'nao tomei',
        'não vou tomar', 'nao vou tomar',
        'não vou mais', 'nao vou mais',
        'ainda não tomei', 'ainda nao tomei',
        'não tomou', 'nao tomou',
        'não consigo tomar', 'nao consigo tomar',
        'não consigo'
    ];
    if (negacoes.some(n => msg.includes(n))) return false;

    // Termos enxutos (v25): medição em todo o histórico mostrou que termos soltos
    // ('tá', 'foi', 'ok'...) só geravam falso positivo.
    const termos = ['sim', 'tomei', 'já tomei', 'ja tomei', 'tomei sim', 'já tomei sim'];

    return termos.some(t => contemPalavraLivre(msg, t));
}

// ============================================================
// DETECÇÃO DE AFIRMAÇÃO SIMPLES (pós-onboarding)
// ============================================================

function isAffirmativeSimple(message) {
    if (!message) return false;
    const termos = ['sim', 'ok', 'pode', 'claro', 'quero', 'vamos', 'bora', 'vou', 's'];
    const msg = message.toLowerCase().trim();
    return termos.some(t => msg === t || msg.startsWith(t + ' '));
}

// ============================================================
// HEURÍSTICA DE LOG (v44 §5.1): pareceLinhaDePosologia NÃO decide mais
// roteamento — a porta interpreta. Sobrevive só como sinal de observação.
// ============================================================

function pareceLinhaDePosologia(message) {
    const linhas = String(message).split('\n');
    const padraoHorario = /\b([01]?\d|2[0-3])\s*(:|h|hs|hrs|horas)\s*([0-5]\d)?\b/i;
    return linhas.some(linha => {
        const temHorario = padraoHorario.test(linha);
        const temPalavra = /[a-zà-ú]{4,}/i.test(linha);
        return temHorario && temPalavra;
    });
}

// ============================================================
// REPERGUNTA SEGURA — destino do degradar() da porta (P31: o fallback
// existe como retorno de quem registrou a degradação).
// ============================================================

function reperguntaSegura(user) {
    const firstName = user.name ? user.name.split(' ')[0] : null;
    return `${firstName ? `${firstName}, d` : 'D'}esculpa, não consegui te entender direito. 🌿\n\nPode me dizer de outro jeito o que você precisa?`;
}

// ============================================================
// DESPACHO DE RELATÓRIO (v25) — ponto ÚNICO de chamada de handleRelatorios.
// ============================================================
async function despacharRelatorio({ user, message, image, historicoConversa,
                                    subtipo, params, state }) {
    const response = await handleRelatorios({ user, message, subtipo, params, state });

    if (response) {
        return { agentName: 'relatorios', response };
    }

    console.log(`🤖 Relatorios não reconheceu (subtipo: ${subtipo}), caindo no principal — ${user.phone}`);
    const r = await chamarPrincipal({ user, message, image, historicoConversa, permitirDevolucao: false });
    return { agentName: r.agentName, response: r.response };
}

// ============================================================
// PONTO ÚNICO DE ENTRADA NO CADASTRO (v44 §5.2)
// Substitui os 10 pontos que montavam { etapa: 'cad_nome' } na mão.
// SEMPRE mescla: rascunho existente + campos extraídos pela porta +
// mensagem original. Proibido contexto literal de cadastro fora daqui.
// ============================================================

// Um nome proposto pela porta "é outro medicamento" quando não bate com o nome
// do cadastro em andamento (mesma tolerância de encontrarMedicamento: igualdade
// ou continência, normalizada).
function citaOutroMedicamento(medicamentosPropostos, nomeEmAndamento) {
    if (!nomeEmAndamento || !medicamentosPropostos || medicamentosPropostos.length === 0) return false;
    const atual = normalizar(nomeEmAndamento);
    return !medicamentosPropostos.some(m => {
        const proposto = normalizar(m);
        return proposto === atual || proposto.includes(atual) || atual.includes(proposto);
    });
}

// Fechamento do cadastro anterior pela verdade do banco (P56): ele JÁ existe e
// gera lembretes; só o opcional (estoque) fica para depois — NULL, nunca 0 (P49).
function montarFechamentoCadastroAnterior(nomeAnterior) {
    return `Só fechando o anterior: o *${nomeAnterior}* já está cadastrado, e o estoque dele fica pra depois — quando quiser, é só me mandar a quantidade. 🌿`;
}

async function entrarNoCadastro({ user, message, image, state, camposExtraidos = null,
                                  historicoConversa, contextoProativo = null }) {
    const estadoAtual = state?.state || 'idle';

    // v44 (replay manual 19/09, Guilherme): medicamento NOVO citado no meio de um
    // cadastro em andamento é um cadastro NOVO, não resposta da coleta — repetir a
    // pergunta pendente ignorava a mensagem inteira (regra 3). O anterior, já
    // gravado, fecha pela verdade do banco; rascunho não gravado é abandonado pelo
    // próprio pivô do usuário.
    const nomeEmAndamento = (estadoAtual === 'adding_med') ? (state?.context?.nome || null) : null;
    const trouxeOutroMedicamento = citaOutroMedicamento(camposExtraidos?.medicamentos, nomeEmAndamento);
    let prefixoFechamentoAnterior = '';
    if (trouxeOutroMedicamento) {
        console.log(`💊 [ENTRADA-CADASTRO] Novo medicamento sobre cadastro em andamento (${nomeEmAndamento} → ${camposExtraidos.medicamentos.join(', ')}) — ${user.phone}`);
        if (state?.context?.medication_id) {
            prefixoFechamentoAnterior = montarFechamentoCadastroAnterior(nomeEmAndamento);
        }
    }

    // Fluxo em andamento: o contexto coletado vale. Fora dele (ou num pivô para
    // outro medicamento), começa do início mesclando qualquer rascunho preservado.
    const contextoBase = (!trouxeOutroMedicamento && (estadoAtual === 'adding_med') && state?.context?.etapa)
        ? state.context
        : trouxeOutroMedicamento
            ? { etapa: 'cad_nome' }
            : { etapa: 'cad_nome', ...(state?.context?.rascunho_cadastro || {}) };

    // P57: um aceite curto ("sim") depois de uma mensagem rica preservada entrega
    // ao cadastro a mensagem COM os dados, nunca o "sim".
    const mensagemRica = state?.context?.mensagem_rica || null;
    let mensagemParaCadastro = (isAffirmativeSimple(message) && mensagemRica) ? mensagemRica : message;

    // Vários medicamentos numa mensagem é AINDA NÃO FAZ até o M2 (inventário §2):
    // honestidade + expectativa (regra 6), nada ignorado (regra 3) — reconhece
    // todos, avisa que cadastra um por vez e começa pelo primeiro, aproveitando
    // os horários compartilhados da mensagem. A proposta da porta só REDUZ a
    // mensagem; os campos continuam passando pelos validadores do cadastro.
    let prefixoMultiMed = '';
    const medicamentosPropostos = camposExtraidos?.medicamentos || [];
    if (medicamentosPropostos.length > 1) {
        const lista = medicamentosPropostos.join(', ');
        const horarios = camposExtraidos?.horarios || [];
        prefixoMultiMed =
            `Vi tudo o que você me mandou: ${lista}.\n\n` +
            `Por enquanto eu cadastro um de cada vez, rapidinho — vamos começar pelo primeiro.`;
        mensagemParaCadastro = `${medicamentosPropostos[0]}${horarios.length > 0 ? `, ${horarios.join(' e ')}` : ''}`;
        console.log(`💊 [ENTRADA-CADASTRO] ${medicamentosPropostos.length} medicamentos na mensagem — começando por "${medicamentosPropostos[0]}" — ${user.phone}`);
    }

    if (pareceLinhaDePosologia(message)) {
        console.log(`📎 [HEURÍSTICA] mensagem com cara de posologia — ${user.phone}`);
    }

    const rCad = await despacharCadastro({
        user, message: mensagemParaCadastro, image, state, historicoConversa,
        contextoProativo, context: contextoBase
    });
    const prefixos = [prefixoFechamentoAnterior, prefixoMultiMed].filter(Boolean).join('\n\n');
    if (prefixos && typeof rCad.response === 'string') {
        rCad.response = `${prefixos}\n\n${rCad.response}`;
    }
    return rCad;
}

// ============================================================
// DESPACHO DE CADASTRO (MH-073 Parte B.1) — ponto ÚNICO de chamada de handleCadastro.
// REGRA DE REENTRADA: quando a porta, reinterpretando a escalada, devolve
// 'cadastro' de novo, ela está CONCORDANDO que o usuário não saiu do fluxo —
// contexto mantido, pergunta pendente repetida. Nenhum dado coletado é descartado.
// ============================================================
async function despacharCadastro({ user, message, image, state, context, historicoConversa,
                                   contextoProativo = null }) {
    const resultado = await handleCadastro({ user, message, state, context, historicoConversa });

    if (!resultado?.escalarParaRoteador) {
        return { agentName: 'cadastro', response: resultado };
    }

    const proposta = await interpretarTurno({
        message,
        currentState: state?.state || 'adding_med',
        historicoConversa,
        contextoProativo
    });

    if (!proposta) {
        return { agentName: 'porta_degradada', response: reperguntaSegura(user) };
    }

    if (proposta.intencao === 'cadastro') {
        // v44 (replay manual 19/09): 'cadastro' na reinterpretação tem DOIS sentidos.
        // Com um medicamento DIFERENTE do em andamento nos campos, é cadastro NOVO —
        // repetir a pergunta pendente ignorava a mensagem (regra 3). Sem medicamento
        // novo, a porta está concordando que o usuário não saiu do fluxo: repete a
        // pergunta pendente sem descartar nada (comportamento original).
        if (citaOutroMedicamento(proposta.campos?.medicamentos, context?.nome)) {
            console.log(`💊 [ESCALADA-CADASTRO] Novo medicamento sobre cadastro em andamento (${context?.nome} → ${proposta.campos.medicamentos.join(', ')}) — ${user.phone}`);
            const respostaNovo = await handleCadastro({
                user, message, state: { state: 'idle', context: {} }, historicoConversa,
                context: { etapa: 'cad_nome' }
            });
            if (respostaNovo?.escalarParaRoteador) {
                return { agentName: 'porta_degradada', response: reperguntaSegura(user), feedback: proposta.feedback };
            }
            const prefixo = context?.medication_id ? montarFechamentoCadastroAnterior(context.nome) : '';
            const response = (prefixo && typeof respostaNovo === 'string')
                ? `${prefixo}\n\n${respostaNovo}`
                : respostaNovo;
            return { agentName: 'cadastro', response, feedback: proposta.feedback };
        }

        console.log(`💊 [ESCALADA-CADASTRO] Porta confirmou cadastro — mantendo fluxo — ${user.phone}`);
        const retomada = await repetirPerguntaCadastro({ context, userName: user.name, historicoConversa });
        return { agentName: 'cadastro', response: retomada, feedback: proposta.feedback };
    }

    const escalada = await despacharEscalada({
        user, message, image, historicoConversa, contextoProativo,
        contextoPreservado: context || null,
        propostaPreResolvida: proposta
    });
    return {
        agentName: escalada.agentName,
        response: escalada.response,
        feedback: escalada.feedback,
        intencaoNaoSuportadaDetectada: escalada.intencaoNaoSuportadaDetectada
    };
}

// ============================================================
// DESPACHO DE ESCALADA — usado quando um agente devolve
// { escalarParaRoteador: true } em vez de uma resposta de texto
// ============================================================

async function despacharEscalada({ user, message, image, contextoPreservado, historicoConversa,
                                   contextoProativo = null, propostaPreResolvida = null }) {
    // BUG-101: quem já interpretou a mensagem passa a proposta INTEIRA aqui e evita a
    // segunda chamada de LLM.
    const proposta = propostaPreResolvida ?? await interpretarTurno({
        message, currentState: 'configurando', historicoConversa, contextoProativo
    });

    if (!proposta) {
        return { agentName: 'porta_degradada', response: reperguntaSegura(user), feedback: null, intencaoNaoSuportadaDetectada: false };
    }

    const { intencao, subtipoRelatorio, campos, feedback } = proposta;
    const params = { medicamento: campos.medicamento, expressaoData: campos.expressaoData };

    let agentName = intencao;
    let response;
    let intencaoNaoSuportadaDetectada = false;

    if (intencao === 'configuracao') {
        console.log(`⚙️ [ESCALADA] Destino: configuração — reentra em identif_intencao${contextoPreservado?.medicationNome ? ` preservando ${contextoPreservado.medicationNome}` : ' sem medicamento preservado'} — ${user.phone}`);
        response = await handleConfiguracao({
            user, message, historicoConversa,
            state: { state: 'configurando', context: { etapa: 'identif_intencao' } },
            context: {
                etapa: 'identif_intencao',
                medicationId: contextoPreservado?.medicationId || null,
                medicationNome: contextoPreservado?.medicationNome || null,
                schedulesAtivos: contextoPreservado?.schedulesAtivos || []
            }
        });
    } else {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        const idleState = { state: 'idle', context: {} };

        if (intencao === 'cadastro') {
            console.log(`💊 [ESCALADA] Roteando para cadastro — ${user.phone}`);
            // Chama handleCadastro DIRETO, não despacharCadastro — despacharEscalada
            // já É o destino de uma escalada; despachar de dentro do despacho criaria
            // recursão. A entrada única monta o contexto mínimo aqui.
            response = await handleCadastro({
                user, message, state: idleState, historicoConversa,
                context: { etapa: 'cad_nome' }
            });
        } else if (intencao === 'relatorios') {
            console.log(`📊 [ESCALADA] Roteando para relatorios (${subtipoRelatorio}) — ${user.phone}`);
            const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                 subtipo: subtipoRelatorio, params, state: idleState });
            agentName = r.agentName;
            response = r.response;
        } else if (intencao === 'excluir_conta') {
            agentName = 'exclusao_conta';
            console.log(`🗑️ [ESCALADA] Pedido de exclusão de conta — ${user.phone}`);
            const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
            response = r.response;
        } else if (intencao === 'nao_suportado') {
            agentName = 'principal';
            console.log(`🚧 [ESCALADA] Intenção não suportada — ${user.phone}`);
            intencaoNaoSuportadaDetectada = true;
            const r = await chamarPrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true, permitirDevolucao: false });
            response = r.response;
        } else {
            console.log(`🤖 [ESCALADA] Roteando para principal — ${user.phone}`);
            const r = await chamarPrincipal({ user, message, image, historicoConversa, permitirDevolucao: false });
            agentName = r.agentName;
            response = r.response;
        }
    }

    return { agentName, response, feedback, intencaoNaoSuportadaDetectada };
}

// ============================================================
// CONTRATO UNIVERSAL DE DEVOLUÇÃO DO PRINCIPAL (v44 §5.3)
// O principal era o único agente conversacional sem saída — a promessa falsa
// da Thaielly (MH-090) é consequência. Quando ele devolve o turno
// ({ escalarParaRoteador: true }), a porta reinterpreta SEM a opção
// 'principal' (evita pingue-pongue); se ainda assim não houver destino,
// repergunta segura.
// ============================================================

async function chamarPrincipal({ user, message, image, historicoConversa,
                                 intencaoNaoSuportada = false, contextoProativo = null,
                                 state = null, permitirDevolucao = true }) {
    const r = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada });

    if (!r || typeof r === 'string' || !r.escalarParaRoteador) {
        return { agentName: 'principal', response: r, intencaoNaoSuportadaDetectada: intencaoNaoSuportada, feedback: null };
    }

    if (!permitirDevolucao) {
        console.warn(`⚠️ [PRINCIPAL] Devolução sem rodada disponível — repergunta segura — ${user.phone}`);
        return { agentName: 'principal', response: reperguntaSegura(user), intencaoNaoSuportadaDetectada: false, feedback: null };
    }

    console.log(`🔁 [PRINCIPAL] Devolveu o turno à porta (§5.3) — reinterpretando sem 'principal' — ${user.phone}`);
    const proposta = await interpretarTurno({
        message,
        currentState: state?.state || 'idle',
        historicoConversa,
        contextoProativo,
        excluirPrincipal: true
    });

    if (!proposta) {
        return { agentName: 'porta_degradada', response: reperguntaSegura(user), intencaoNaoSuportadaDetectada: false, feedback: null };
    }

    const r2 = await despacharPorProposta({
        proposta, user, message, image,
        state, currentState: state?.state || 'idle',
        historicoConversa, contextoProativo,
        permitirDevolucao: false
    });
    return { ...r2, feedback: r2.feedback ?? proposta.feedback ?? null };
}

// ============================================================
// DESPACHO PÓS-PORTA (v44 §5.1) — a porta propõe, o código dispõe.
// ============================================================

async function despacharPorProposta({ proposta, user, message, image, state, currentState,
                                      historicoConversa, contextoProativo, permitirDevolucao = true }) {
    let { intencao, subtipoRelatorio, campos } = proposta;
    const params = { medicamento: campos.medicamento, expressaoData: campos.expressaoData };

    // O CÓDIGO DISPÕE: no meio de um fluxo de coleta, 'principal' proposto pela
    // porta é continuação do fluxo — os especialistas têm as próprias camadas de
    // escalada quando a mensagem realmente saiu do assunto.
    if (intencao === 'principal' && (currentState === 'adding_med' || currentState === 'cadastrando_medicamento')) {
        intencao = 'cadastro';
    }
    if (intencao === 'principal' && currentState === 'configurando') {
        intencao = 'configuracao';
    }

    let agentName = intencao;
    let response;
    let intencaoNaoSuportadaDetectada = false;
    let feedback = proposta.feedback ?? null;

    // Saída dos estados de pergunta do relatório quando o assunto mudou —
    // são estados leves, sem dado coletado a preservar.
    const emEstadoDePerguntaRelatorio = currentState === 'aguardando_periodo_adesao'
        || currentState === 'aguardando_escolha_tratamento';
    const continuaNoRelatorio = intencao === 'relatorios' && (
        (currentState === 'aguardando_periodo_adesao' && subtipoRelatorio === 'adesao') ||
        (currentState === 'aguardando_escolha_tratamento' && subtipoRelatorio === 'progresso_tratamento')
    );
    if (emEstadoDePerguntaRelatorio && !continuaNoRelatorio) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        state = { state: 'idle', context: {} };
    }

    if (intencao === 'cadastro') {
        const rCad = await entrarNoCadastro({
            user, message, image, state, camposExtraidos: campos,
            historicoConversa, contextoProativo
        });
        agentName = rCad.agentName;
        response = rCad.response;
        feedback = rCad.feedback ?? feedback;
        if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;

    } else if (intencao === 'relatorios') {
        const r = await despacharRelatorio({
            user, message, image, historicoConversa,
            subtipo: subtipoRelatorio, params, state
        });
        agentName = r.agentName;
        response = r.response;

    } else if (intencao === 'configuracao') {
        const contextoConfig = (currentState === 'configurando')
            ? (state?.context || { etapa: 'identif_intencao' })
            : { etapa: 'identif_intencao' };
        const resultadoConfig = await handleConfiguracao({
            user, message, state, historicoConversa, context: contextoConfig
        });
        if (resultadoConfig?.escalarParaRoteador) {
            const escalada = await despacharEscalada({
                user, message, image, historicoConversa, contextoProativo,
                contextoPreservado: currentState === 'configurando' ? state?.context : null
            });
            agentName = escalada.agentName;
            response = escalada.response;
            feedback = escalada.feedback ?? feedback;
            if (escalada.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        } else {
            response = resultadoConfig;
        }

    } else if (intencao === 'excluir_conta') {
        agentName = 'exclusao_conta';
        const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
        response = r.response;

    } else if (intencao === 'nao_suportado') {
        intencaoNaoSuportadaDetectada = true;
        const r = await chamarPrincipal({
            user, message, image, historicoConversa,
            intencaoNaoSuportada: true, contextoProativo, state, permitirDevolucao: false
        });
        agentName = r.agentName;
        response = r.response;

    } else {
        const r = await chamarPrincipal({
            user, message, image, historicoConversa,
            contextoProativo, state, permitirDevolucao
        });
        agentName = r.agentName;
        response = r.response;
        if (r.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        feedback = r.feedback ?? feedback;
    }

    return { agentName, response, intencaoNaoSuportadaDetectada, feedback };
}

// ============================================================
// ROTEADOR PRINCIPAL — v44 §5.1: para usuário onboarded, os antigos
// ramos 4–15 viram: fast-paths determinísticos (§5.4) → porta → despacho.
// ============================================================

export async function routeMessage({ user, message, image, messageId, referenceMessageId }) {
    if (isDuplicateMessage(messageId)) {
        console.log(`⚠️  Mensagem duplicada ignorada: ${messageId}`);
        return null;
    }

    // ---- CITAÇÃO (§5.6, supera BUG-029): resolve o referenceMessageId no funil ----
    // A comparação é contra zaap_id E message_id até o T0 (§4) decidir qual vale.
    // Regra: o citado vence o estado atual NA INTERPRETAÇÃO (entra no contexto da
    // porta) — nunca escreve estado direto.
    let envioCitado = null;
    let mensagemCitada = null;
    if (referenceMessageId) {
        envioCitado = await getEnvioFunilPorProviderId(referenceMessageId);
        if (envioCitado) {
            mensagemCitada = {
                texto: envioCitado.texto,
                quando: new Date(envioCitado.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                origem: envioCitado.origem
            };
            console.log(`💬 [CITAÇÃO] referenceMessageId resolvido no funil (${envioCitado.origem}) — ${user.phone}`);
        } else {
            console.log(`💬 [CITAÇÃO] referenceMessageId ${referenceMessageId} sem correspondência no funil — ${user.phone}`);
        }
    }

    // FAST-PATH determinístico preservado e consertado (§5.6): citação de
    // lembrete/follow-up + confirmação → confirma EXATAMENTE aquele grupo de doses
    // (generaliza o antigo caso individual — o agrupado era irreconhecível, MH-032).
    if (referenceMessageId && detectarConfirmacaoDose(message)) {
        const dosesDoEnvio = envioCitado ? filtrarDosesPendentes(await getDosesDoEnvio(envioCitado.id)) : [];

        if (dosesDoEnvio.length > 0) {
            for (const dose of dosesDoEnvio) {
                await confirmDoseByLogId(dose.id);
            }
            let alertaSufixo = '';
            for (const medId of [...new Set(dosesDoEnvio.map(d => d.medication_id))]) {
                alertaSufixo += await montarAlertaEstoquePosConfirmacao(medId);
            }
            const nomes = [...new Set(dosesDoEnvio.map(d => d.medications?.nome || 'seu remédio'))].join(' e ');
            const firstName = user.name ? user.name.split(' ')[0] : 'você';

            console.log(`✅ [FAST-PATH] Grupo de ${dosesDoEnvio.length} dose(s) confirmado via citação do envio — ${user.phone} — ${nomes}`);

            const agentLogIdCitacao = await logAgentInteraction({
                userId: user.id,
                agent: 'fast_path_reference',
                userMessage: message,
                agentResponse: `Dose(s) confirmada(s) via citação: ${nomes}`,
                estadoConversa: null,
                contextoConversa: null,
                referenceMessageId
            });

            return {
                texto: `✅ Anotei! Dose do *${nomes}* confirmada, ${firstName}. Continue assim! 💪💊${alertaSufixo}`,
                agente: 'fast_path_reference',
                agentLogId: agentLogIdCitacao
            };
        }

        // Legado (pré-funil): dose individual vinculada por zapi_message_id.
        const doseLog = await getDoseLogByZapiMessageId(referenceMessageId);
        if (doseLog && doseLog.confirmed === false) {
            await confirmDoseByLogId(doseLog.id);
            const nomeRemedio = doseLog.med_nome || 'seu remédio';
            const firstName = user.name ? user.name.split(' ')[0] : 'você';

            console.log(`✅ [FAST-PATH] Dose confirmada via referenceMessageId — ${user.phone} — ${nomeRemedio}`);

            const agentLogIdFastPath = await logAgentInteraction({
                userId: user.id,
                agent: 'fast_path_reference',
                userMessage: message,
                agentResponse: `Dose confirmada: ${nomeRemedio}`,
                estadoConversa: null,
                contextoConversa: null,
                referenceMessageId
            });

            const alertaSufixo = await montarAlertaEstoquePosConfirmacao(doseLog.medication_id);

            return {
                texto: `✅ Anotei! Dose do *${nomeRemedio}* confirmada, ${firstName}. Continue assim! 💪💊${alertaSufixo}`,
                agente: 'fast_path_reference',
                agentLogId: agentLogIdFastPath
            };
        }
    }

    const state = await getConversationState(user.id);
    const currentState = state?.state || 'idle';

    // Histórico conversacional — buscado UMA vez, propagado a todos os agentes LLM
    const historicoConversa = await getHistoricoRecente(user.id, 3);

    // Contexto proativo (MH-065) — buscado UMA vez, propagado à porta.
    const ultimoTurnoAt = historicoConversa.at(-1)?.created_at ?? null;
    const contextoProativo = await getContextoProativoRecente(user.id, ultimoTurnoAt);

    let response;
    let agentName;
    let feedbackDetectado = null;
    let intencaoNaoSuportadaDetectada = false;

    // 1. Usuário ainda não fez onboarding → recepcionista
    if (!user.onboarded) {
        agentName = 'recepcionista';
        console.log(`👋 Roteando para recepcionista — ${user.phone}`);
        response = await handleRecepcionista({
            user,
            message,
            historicoConversa,
            context: {
                ...state?.context,
                mensagem_inicial: state?.context?.mensagem_inicial || message
            }
        });

    // 2. MH-020 — Confirmação pendente de exclusão de conta (trata o estado antes de tudo)
    } else if (currentState === 'aguardando_confirmacao_exclusao') {
        agentName = 'exclusao_conta';
        console.log(`🗑️ Roteando para exclusão de conta (confirmação pendente) — ${user.phone}`);
        const r = await handleExclusaoConta({ user, message, etapa: 'confirmar', historicoConversa });

        if (r.contaExcluida) {
            // Usuário não existe mais — RETORNA ANTES do logAgentInteraction final
            // (inserir agent_logs com user_id apagado daria FK error).
            return { texto: r.response, agente: 'exclusao_conta', agentLogId: null };
        }
        response = r.response;

    // 3. MH-020 — Portão de detecção de pedido de exclusão de conta (único ponto de detecção).
    } else if (user.onboarded
        && pareceExclusaoConta(message)
        && await confirmarIntencaoExclusaoConta({ message, historicoConversa, currentState })) {
        agentName = 'exclusao_conta';
        console.log(`🗑️ Pedido de exclusão de conta detectado — ${user.phone}`);
        const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
        response = r.response;

    // 3.5. MH-072 Parte A — coleta de data de nascimento no onboarding (fica até o M4).
    } else if (currentState === 'coletando_nascimento') {
        agentName = 'data_nascimento';
        console.log(`🎂 Roteando para coleta de data de nascimento — ${user.phone}`);
        const resultadoNascimento = await handleDataNascimento({ user, message, state, historicoConversa });
        if (resultadoNascimento?.escalarParaRoteador) {
            const escalada = await despacharEscalada({
                user, message, image, historicoConversa, contextoProativo,
                contextoPreservado: null
            });
            agentName = escalada.agentName;
            response = escalada.response;
            feedbackDetectado = escalada.feedback ?? feedbackDetectado;
            if (escalada.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        } else {
            response = resultadoNascimento;
        }

    // 4+ — v44 §5.1: fast-paths determinísticos → porta → despacho.
    } else {

        // ---- FAST-PATHS DETERMINÍSTICOS (§5.4) ----

        // Dose vence qualquer fluxo pendente (regra 5) — inclusive coleta.
        if (detectarConfirmacaoDose(message)) {
            if (await temDosePendente(user.id)) {
                const confirmacao = await confirmarDosePendenteDeterministico(user, state);
                if (confirmacao) {
                    agentName = 'fast_path_dose';
                    response = confirmacao;
                }
            } else {
                // Resposta tardia ao esgotamento (BUG-035)
                const tardia = await tentarConfirmarRespostaTardia(user, message);
                if (tardia) {
                    agentName = 'fast_path_resposta_tardia';
                    response = tardia;
                }
            }
        }

        // Aceite pós-onboarding com mensagem rica preservada (P57): o "sim" carrega
        // os dados da mensagem anterior direto ao cadastro, sem porta.
        if (response === undefined && currentState === 'post_onboarding'
            && isAffirmativeSimple(message) && state?.context?.mensagem_rica) {
            console.log(`💊 Aceite pós-onboarding com mensagem rica preservada — ${user.phone}`);
            const rCad = await entrarNoCadastro({
                user, message, image, state,
                // campos que a porta extraiu da mensagem rica no turno anterior —
                // sem eles, uma mensagem com N medicamentos perderia o caminho
                // multi-med (achado da 1ª execução do arnês, A2).
                camposExtraidos: state?.context?.campos_rica ?? null,
                historicoConversa, contextoProativo
            });
            agentName = rCad.agentName;
            response = rCad.response;
            feedbackDetectado = rCad.feedback ?? feedbackDetectado;
            if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        }

        // Respostas determinísticas dos estados de pergunta do relatório (BUG-057/056).
        if (response === undefined && currentState === 'aguardando_periodo_adesao') {
            if (isCancelamento(message)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                agentName = 'relatorios';
                const firstName = user.name ? user.name.split(' ')[0] : 'você';
                console.log(`📊 Desistência do período de adesão — ${user.phone}`);
                response = `Sem problemas, ${firstName}! Se quiser ver sua adesão depois, é só me chamar 🌿`;
            } else if (extrairPeriodo(message)) {
                console.log(`📊 Roteando para relatorios (aguardando período de adesão) — ${user.phone}`);
                const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                     subtipo: 'adesao', params: { medicamento: null, expressaoData: null }, state });
                agentName = r.agentName;
                response = r.response;
            }
        }
        if (response === undefined && currentState === 'aguardando_escolha_tratamento' && isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'relatorios';
            const firstName = user.name ? user.name.split(' ')[0] : 'você';
            console.log(`📊 Desistência da escolha de tratamento — ${user.phone}`);
            response = `Sem problemas, ${firstName}! Se quiser ver de novo, é só me chamar 🌿`;
        }

        // ---- PORTA ÚNICA (§5.1): 1 chamada de interpretação por turno ----
        let propostaPorta = null;
        if (response === undefined) {
            propostaPorta = await interpretarTurno({
                message, currentState, historicoConversa, contextoProativo, mensagemCitada
            });

            if (!propostaPorta) {
                agentName = 'porta_degradada';
                response = reperguntaSegura(user);
            } else {
                const r = await despacharPorProposta({
                    proposta: propostaPorta, user, message, image, state, currentState,
                    historicoConversa, contextoProativo
                });
                agentName = r.agentName;
                response = r.response;
                feedbackDetectado = r.feedback ?? feedbackDetectado;
                if (r.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
            }
        }

        // Pós-onboarding: guarda SEMPRE a mensagem anterior (§5.1, rede de segurança
        // P57 — a condição de regex que perdeu os 4 medicamentos da Thaielly morreu),
        // junto com os campos que a porta extraiu dela (o "sim" seguinte recupera tudo).
        if (currentState === 'post_onboarding' && agentName === 'principal') {
            const exchanges = state?.context?.exchanges || 0;
            if (exchanges < 1) {
                await saveConversationState(user.id, {
                    state: 'post_onboarding',
                    context: {
                        exchanges: exchanges + 1,
                        mensagem_rica: message,
                        campos_rica: propostaPorta?.campos ?? null
                    }
                });
                console.log(`🔄 post_onboarding preservado com mensagem_rica (exchanges: ${exchanges + 1}) — ${user.phone}`);
            }
        }
    }

    const agentLogId = await logAgentInteraction({
        userId: user.id,
        agent: agentName,
        userMessage: message,
        agentResponse: response,
        estadoConversa: currentState || null,
        contextoConversa: state?.context || null,
        referenceMessageId: referenceMessageId || null
    });

    if (intencaoNaoSuportadaDetectada) {
        await registrarEvento({
            tipo: 'intencao_nao_suportada',
            severidade: 'baixa',
            userId: user.id,
            agent: agentName,
            origem: 'porta',
            agentLogId,
            titulo: 'Intenção não suportada (porta única)'
        });
    }

    if (feedbackDetectado) {
        await registrarFeedback({
            userId: user.id,
            categoria: feedbackDetectado,
            origem: 'espontaneo',
            texto: message,
            agentLogId
        });
    }

    // v44 §5.5: o roteador devolve texto + vínculo — quem ENVIA é só o funil.
    return { texto: response, agente: agentName, agentLogId };
}
