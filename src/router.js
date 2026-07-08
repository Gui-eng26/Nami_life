import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque,
    saveConversationState, getHistoricoRecente, registrarIntencaoNaoSuportada,
    getDosesRetroativas, confirmarDoseRetroativa, usuarioRespondeuDesde } from './database.js';
import { handleRecepcionista } from './agentes/recepcionista.js';
import { handlePrincipal } from './agentes/principal.js';
import { handleCadastro } from './agentes/cadastro.js';
import { handleRelatorios, classificarIntencaoRelatorio, extrairPeriodo } from './agentes/relatorios.js';
import { handleConfiguracao } from './agentes/configuracao.js';
import { isCancelamento } from './nlp_helpers.js';

// ============================================================
// MENSAGEM DE ALERTA DE ESTOQUE PÓS-CONFIRMAÇÃO
// ============================================================

function buildAlertaEstoqueMessage(info) {
    const { medNome, novoEstoque, diasRestantes } = info;

    if (diasRestantes === 0) {
        return (
            `\n\n⚠️ *Atenção:* você acabou de tomar o último comprimido do *${medNome}* disponível. ` +
            `Não esqueça de providenciar a recompra!\n` +
            `Quando comprar, me avise: *"Comprei 30 comprimidos de ${medNome}"* 💊`
        );
    }

    const prazo = diasRestantes === 1
        ? 'mais *1 dia*'
        : `mais *${diasRestantes} dias*`;

    return (
        `\n\n⚠️ *Lembrete de estoque:* você tem *${novoEstoque}* ${novoEstoque === 1 ? 'unidade' : 'unidades'} ` +
        `do *${medNome}* — suficiente para ${prazo}. ` +
        `Bom momento para planejar a recompra! 💊`
    );
}

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
// tratada por tentarConfirmarRespostaTardia(). Excluí-la aqui garante que o roteador
// não intercepte a mensagem no bloco 4 (confirmação direta) e deixe o bloco 4b
// (fast-path de resposta tardia) ser alcançado. Alinha esta função à mesma definição
// de "dose pendente" já usada em buildUserMessage() (principal.js), que já excluía
// nao_informado corretamente — a divergência entre as duas era a causa raiz do BUG-035
// nunca disparar (confirmado com dados reais de produção, sessão de 08/07/2026).
async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return doses.some(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado' &&
        d.status !== 'nao_informado'
    );
}

// ============================================================
// FAST-PATH: RESPOSTA TARDIA AO ESGOTAMENTO (BUG-035)
// Distinto do fast-path por referenceMessageId (BUG-029, ainda quebrado) —
// este não usa referenceMessageId em nenhum momento.
// ============================================================

// Tenta confirmar diretamente (sem LLM) uma dose nao_informado quando o "Sim" do
// usuário é, comprovadamente, a 1ª resposta dele desde o esgotamento e ocorre
// dentro da janela de 24h. Fora dessas condições, retorna null e o roteamento
// segue o caminho normal (bloco retroativo com apresentação, já existente).
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

    // Alerta de estoque — mesma lógica do fast-path por referenceMessageId, aplicada por
    // medicamento do grupo (podem ser medicamentos diferentes agrupados pelo mesmo horário).
    let alertaSufixo = '';
    const medicationIds = [...new Set(grupo.map(d => d.medication_id))];
    for (const medId of medicationIds) {
        try {
            const estoqueInfo = await getEstoqueInfoParaAlerta(medId);
            if (estoqueInfo) {
                const confirmacoesDoDia = await contarConfirmacoesHoje(medId);
                const deveAlertar = calcularAlertaEstoque({
                    diasRestantes: estoqueInfo.diasRestantes,
                    tipo_tratamento: estoqueInfo.tipo_tratamento,
                    tratamento_dias: estoqueInfo.tratamento_dias,
                    confirmacoesDoDia
                });
                if (deveAlertar) alertaSufixo += buildAlertaEstoqueMessage(estoqueInfo);
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar alerta estoque (fast-path resposta tardia):', e.message);
        }
    }

    const nomes = grupo.map(d => d.medications?.nome || 'seu remédio').join(' e ');
    const firstName = user.name ? user.name.split(' ')[0] : 'você';

    console.log(`✅ [FAST-PATH] Resposta tardia ao esgotamento confirmada (BUG-035) — ${user.phone} — ${nomes}`);

    return `✅ Anotei! Dose do *${nomes}* confirmada, ${firstName}. Continue assim! 💪💊${alertaSufixo}`;
}

// ============================================================
// DETECÇÃO DE CONFIRMAÇÃO DE DOSE
// ============================================================

function detectarConfirmacaoDose(message) {
    if (!message) return false;
    const msg = message.toLowerCase().trim();

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
        'não consigo', 'nao consigo'
    ];
    if (negacoes.some(n => msg.includes(n))) return false;

    const termos = ['sim', 'tomei', 'já tomei', 'pode', 'ok', 'claro',
        'feito', 'tá', 'foi', 'tomei sim', 'já tomei sim'];
    return termos.some(t => msg.includes(t));
}

// ============================================================
// DETECÇÃO DE AFIRMAÇÃO SIMPLES (pós-onboarding)
// Separada de detectarConfirmacaoDose para não misturar contextos
// ============================================================

function isAffirmativeSimple(message) {
    if (!message) return false;
    const termos = ['sim', 'ok', 'pode', 'claro', 'quero', 'vamos', 'bora', 'vou', 's'];
    const msg = message.toLowerCase().trim();
    return termos.some(t => msg === t || msg.startsWith(t + ' '));
}

// ============================================================
// DETECÇÃO DE INTENÇÃO DE CONFIGURAÇÃO
// ============================================================

// Verifica se uma palavra aparece de forma independente no texto
// (não como parte de outra palavra — ex: "voltar" não deve bater em "voltaren")
function contemPalavraLivre(texto, palavra) {
    if (palavra.includes(' ')) return texto.includes(palavra); // frases: match direto
    return new RegExp(`(^|\\s)${palavra}(\\s|$|[.,!?])`).test(texto);
}

function detectarIntencaoConfiguracao(message) {
    if (!message) return false;
    const msg = message.toLowerCase();

    // Casos diretos — detectados sem precisar de combinação
    const casosDiretos = [
        'pausar', 'reativar', 'encerrar tratamento',
        'alterar horário', 'alterar horario',
        'mudar horário', 'mudar horario',
        'trocar horário', 'trocar horario',
        'não vou mais tomar', 'nao vou mais tomar'
    ];
    if (casosDiretos.some(t => msg.includes(t))) return true;

    // Combinatório: palavra de ação + palavra de objeto
    const palavrasAcao = [
        'parar', 'cancela', 'cancelar', 'desativar', 'suspender',
        'tirar', 'remover', 'apagar', 'excluir', 'deletar',
        'encerrar', 'finalizar', 'acabar',
        'mudar', 'alterar', 'trocar', 'modificar',
        'ativar', 'retomar', 'voltar',
        'não preciso', 'nao preciso',
        'não precisa', 'nao precisa',
        'não quero mais', 'nao quero mais',
        'não me lembra', 'nao me lembra',
        'não me lembre', 'nao me lembre'
    ];
    const palavrasObjeto = [
        'lembrete', 'aviso', 'alarme', 'alerta', 'notificação', 'notificacao',
        'remédio', 'remedio', 'medicamento', 'tratamento',
        'horário', 'horario', 'hora'
    ];

    const temAcao = palavrasAcao.some(p => contemPalavraLivre(msg, p));
    const temObjeto = palavrasObjeto.some(p => contemPalavraLivre(msg, p));
    return temAcao && temObjeto;
}

// ============================================================
// DETECÇÃO DE INTENÇÃO DE CADASTRO
// ============================================================

function detectarIntencaoCadastro(message) {
    if (!message) return false;
    const termos = [
        'cadastrar', 'adicionar remédio', 'novo remédio', 'registrar remédio',
        'quero cadastrar', 'tenho um remédio', 'adicionar medicamento',
        'novo medicamento', 'registrar medicamento', 'quero adicionar',
        // Variações com "mais um" e "outro"
        'adicionar mais', 'mais um remédio', 'mais um medicamento',
        'outro remédio', 'outro medicamento', 'incluir remédio',
        'incluir medicamento', 'colocar remédio', 'colocar medicamento',
        'inserir remédio', 'inserir medicamento'
    ];
    const msg = message.toLowerCase();
    return termos.some(t => msg.includes(t));
}

// ============================================================
// CLASSIFICADOR LLM — contexto conversacional para o else final
// ============================================================

async function classificarIntencaoComContexto({ message, currentState, historicoConversa }) {
    const fallback = { agente: 'principal', subtipoRelatorio: null };

    try {
        // Monta o histórico como texto legível para o LLM
        const historicoTexto = historicoConversa.length > 0
            ? historicoConversa.map(h =>
                `Usuário: ${h.user_message}\nNami: ${h.agent_response}`
              ).join('\n\n')
            : 'Sem histórico recente.';

        const prompt = `Você é o classificador de intenções da Nami, um assistente de saúde via WhatsApp.

Identifique para qual agente a mensagem deve ir, considerando o contexto da conversa.

AGENTES E SUAS CAPACIDADES:
- cadastro: cadastrar novo medicamento, iniciar novo tratamento
- relatorios: consultar doses tomadas, adesão, estoque, próximos remédios, horários cadastrados, progresso do tratamento (dias restantes, % concluído)
- configuracao: pausar, reativar, encerrar tratamento; alterar/remover/adicionar/redefinir horário de lembrete
- principal: conversa geral, dúvidas, saudações, reações ("ok", "obrigado"), fechamentos, confirmação de doses, confirmação retroativa de doses (últimos 2 dias), reversão de confirmação por engano, correção/atualização de estoque (recompra, recontagem, perda)

FUNCIONALIDADES QUE A NAMI AINDA NÃO TEM (classifique como "nao_suportado"):
- alterar tempo/duração de tratamento
- alterar dosagem de um medicamento
- alterar nome de um medicamento
- registrar sintomas, pressão, glicemia ou outros dados de saúde
- falar com médico, agendar consulta
- exportar histórico em arquivo

ESTADO ATUAL: ${currentState}

HISTÓRICO RECENTE:
${historicoTexto}

MENSAGEM ATUAL: "${message}"

Se o agente escolhido for "relatorios", identifique também o subtipo do relatório em
"subtipoRelatorio", escolhendo exatamente um destes valores:
- tomei_hoje: perguntar se já tomou os remédios hoje
- meus_remedios: listar medicamentos cadastrados
- estoque: consultar quantidade em estoque
- proximo_remedio: qual remédio tomar agora/a seguir
- adesao: taxa de adesão ao tratamento (histórico de doses tomadas x esperadas)
- progresso_tratamento: quantos dias/doses faltam para o tratamento acabar

Para os demais agentes, "subtipoRelatorio" deve ser null.

Responda APENAS com um JSON válido, sem nenhum texto antes ou depois, no formato exato:
{"agente": "cadastro|relatorios|configuracao|principal|nao_suportado", "subtipoRelatorio": "tomei_hoje|meus_remedios|estoque|proximo_remedio|adesao|progresso_tratamento|null"}`;

        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 60,
            messages: [{ role: 'user', content: prompt }]
        });

        const textoResposta = resposta.content[0]?.text?.trim() || '';
        const agentesValidos = ['cadastro', 'relatorios', 'configuracao', 'principal', 'nao_suportado'];
        const subtiposValidos = ['tomei_hoje', 'meus_remedios', 'estoque', 'proximo_remedio', 'adesao', 'progresso_tratamento'];

        let parsed;
        try {
            parsed = JSON.parse(textoResposta);
        } catch {
            console.warn(`⚠️ [CLASSIFICADOR] Resposta não-JSON do LLM: "${textoResposta}" — usando principal`);
            return fallback;
        }

        const agente = String(parsed?.agente || '').trim().toLowerCase();
        const subtipoRelatorio = String(parsed?.subtipoRelatorio || '').trim().toLowerCase();

        if (!agentesValidos.includes(agente)) {
            console.warn(`⚠️ [CLASSIFICADOR] Agente inesperado do LLM: "${agente}" — usando principal`);
            return fallback;
        }

        if (agente === 'relatorios' && !subtiposValidos.includes(subtipoRelatorio)) {
            console.warn(`⚠️ [CLASSIFICADOR] Subtipo de relatório ausente/inválido: "${subtipoRelatorio}" — não reconhecido`);
            return { agente: 'relatorios', subtipoRelatorio: null };
        }

        console.log(`🧠 [CLASSIFICADOR] Intenção classificada como: ${agente}${subtipoRelatorio && agente === 'relatorios' ? ` (${subtipoRelatorio})` : ''} — mensagem: "${message}"`);
        return { agente, subtipoRelatorio: agente === 'relatorios' ? subtipoRelatorio : null };

    } catch (error) {
        // Erro na chamada LLM — fallback seguro, não interrompe o usuário
        console.error(`❌ [CLASSIFICADOR] Erro ao classificar intenção: ${error.message} — usando principal`);
        return fallback;
    }
}

// ============================================================
// ROTEADOR PRINCIPAL
// ============================================================

export async function routeMessage({ user, message, image, messageId, referenceMessageId }) {
    if (isDuplicateMessage(messageId)) {
        console.log(`⚠️  Mensagem duplicada ignorada: ${messageId}`);
        return null;
    }

    // FAST-PATH: confirmação por referência de mensagem (função "responder" do WhatsApp)
    if (referenceMessageId && detectarConfirmacaoDose(message)) {
        const doseLog = await getDoseLogByZapiMessageId(referenceMessageId);
        if (doseLog && doseLog.confirmed === false) {
            await confirmDoseByLogId(doseLog.id);
            const nomeRemedio = doseLog.med_nome || 'seu remédio';
            const firstName = user.name ? user.name.split(' ')[0] : 'você';

            console.log(`✅ [FAST-PATH] Dose confirmada via referenceMessageId — ${user.phone} — ${nomeRemedio}`);

            await logAgentInteraction({
                userId: user.id,
                agent: 'fast_path_reference',
                userMessage: message,
                agentResponse: `Dose confirmada: ${nomeRemedio}`,
                estadoConversa: null,
                contextoConversa: null
            });

            // Verificar alerta de estoque pós-confirmação
            let alertaSufixo = '';
            try {
                const estoqueInfo = await getEstoqueInfoParaAlerta(doseLog.medication_id);
                if (estoqueInfo) {
                    const confirmacoesDoDia = await contarConfirmacoesHoje(doseLog.medication_id);
                    const deveAlertar = calcularAlertaEstoque({
                        diasRestantes: estoqueInfo.diasRestantes,
                        tipo_tratamento: estoqueInfo.tipo_tratamento,
                        tratamento_dias: estoqueInfo.tratamento_dias,
                        confirmacoesDoDia
                    });
                    if (deveAlertar) alertaSufixo = buildAlertaEstoqueMessage(estoqueInfo);
                }
            } catch (e) {
                console.error('⚠️ Erro ao verificar alerta estoque (fast-path):', e.message);
            }

            return `✅ Anotei! Dose do *${nomeRemedio}* confirmada, ${firstName}. Continue assim! 💪💊${alertaSufixo}`;
        }
    }

    const state = await getConversationState(user.id);
    const currentState = state?.state || 'idle';

    // Histórico conversacional — buscado UMA vez, propagado a todos os agentes LLM
    const historicoConversa = await getHistoricoRecente(user.id, 3);

    let response;
    let agentName;

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

    // 2. Usuário concluiu onboarding agora — respondendo "por onde quer começar?"
    } else if (currentState === 'post_onboarding') {
        if (detectarIntencaoCadastro(message) || isAffirmativeSimple(message)) {
            agentName = 'cadastro';
            console.log(`💊 Roteando para cadastro (pós-onboarding) — ${user.phone}`);
            response = await handleCadastro({
                user,
                message,
                state,
                historicoConversa,
                context: { etapa: 'cad_nome' }
            });
        } else {
            agentName = 'principal';
            console.log(`🤖 Roteando para principal (pós-onboarding) — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });

            // Preserva post_onboarding por mais 1 troca para capturar o "sim" seguinte.
            // Após 1 troca (exchanges >= 1), deixa o principal gerenciar o estado normalmente.
            const exchanges = state?.context?.exchanges || 0;
            if (exchanges < 1) {
                await saveConversationState(user.id, {
                    state: 'post_onboarding',
                    context: { exchanges: exchanges + 1 }
                });
                console.log(`🔄 post_onboarding preservado (exchanges: ${exchanges + 1}) — ${user.phone}`);
            }
        }

    // 2b. Usuário no meio do fluxo de seleção de período do relatório de adesão
    // BUG-057: esse estado travava TODA mensagem seguinte (inclusive confirmação de
    // dose real) como se fosse resposta de período. Ordem de checagem abaixo dá
    // precedência a dose > cancelamento > período válido > classificador central.
    } else if (currentState === 'aguardando_periodo_adesao') {

        if (detectarConfirmacaoDose(message) && await temDosePendente(user.id)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'principal';
            console.log(`💊 Confirmação de dose detectada (aguardando_periodo_adesao), roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });

        } else if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'relatorios';
            const firstName = user.name ? user.name.split(' ')[0] : 'você';
            console.log(`📊 Desistência do período de adesão — ${user.phone}`);
            response = `Sem problemas, ${firstName}! Se quiser ver sua adesão depois, é só me chamar 🌿`;

        } else if (extrairPeriodo(message)) {
            agentName = 'relatorios';
            console.log(`📊 Roteando para relatorios (aguardando período de adesão) — ${user.phone}`);
            response = await handleRelatorios({ user, message, subtipo: 'adesao', state });

        } else {
            const { agente: agenteSelecionado, subtipoRelatorio } = await classificarIntencaoComContexto({
                message, currentState, historicoConversa
            });

            if (agenteSelecionado === 'relatorios' && subtipoRelatorio === 'adesao') {
                agentName = 'relatorios';
                console.log(`📊 [CLASSIFICADOR] Ainda sobre adesão, sem período reconhecível — ${user.phone}`);
                response = await handleRelatorios({ user, message, subtipo: 'adesao', state });
            } else {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                agentName = agenteSelecionado;
                const idleState = { state: 'idle', context: {} };

                if (agenteSelecionado === 'cadastro') {
                    console.log(`💊 [CLASSIFICADOR] Roteando para cadastro (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    response = await handleCadastro({
                        user, message, state: idleState, historicoConversa,
                        context: { etapa: 'cad_nome' }
                    });
                } else if (agenteSelecionado === 'relatorios') {
                    console.log(`📊 [CLASSIFICADOR] Roteando para relatorios (${subtipoRelatorio}, saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    response = await handleRelatorios({ user, message, subtipo: subtipoRelatorio, state: idleState });
                    if (!response) {
                        agentName = 'principal';
                        response = await handlePrincipal({ user, message, image, historicoConversa });
                    }
                } else if (agenteSelecionado === 'configuracao') {
                    console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    response = await handleConfiguracao({
                        user, message, state: idleState, historicoConversa,
                        context: { etapa: 'identif_intencao' }
                    });
                } else if (agenteSelecionado === 'nao_suportado') {
                    agentName = 'principal';
                    console.log(`🚧 [CLASSIFICADOR] Intenção não suportada (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    await registrarIntencaoNaoSuportada(user.id, message);
                    response = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true });
                } else {
                    agentName = 'principal';
                    console.log(`🤖 [CLASSIFICADOR] Roteando para principal (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    response = await handlePrincipal({ user, message, image, historicoConversa });
                }
            }
        }

    // 2c. Usuário no meio da escolha de qual tratamento ver o progresso (2+ ativos, BUG-056)
    // Mesma precedência do BUG-057: dose > cancelamento > classificador central.
    // BUG-056 (complemento): decidir por nome de medicamento antes de confirmar o assunto
    // gerava falso-positivo (ex: "qual estoque do Neosaldina?" virava progresso). O
    // classificador central é sempre consultado primeiro — nome só é usado depois de
    // confirmar que o assunto ainda é progresso_tratamento.
    } else if (currentState === 'aguardando_escolha_tratamento') {

        if (detectarConfirmacaoDose(message) && await temDosePendente(user.id)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'principal';
            console.log(`💊 Confirmação de dose detectada (aguardando_escolha_tratamento), roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });

        } else if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'relatorios';
            const firstName = user.name ? user.name.split(' ')[0] : 'você';
            console.log(`📊 Desistência da escolha de tratamento — ${user.phone}`);
            response = `Sem problemas, ${firstName}! Se quiser ver de novo, é só me chamar 🌿`;

        } else {
            const { agente: agenteSelecionado, subtipoRelatorio } = await classificarIntencaoComContexto({
                message, currentState, historicoConversa
            });

            if (agenteSelecionado === 'relatorios' && subtipoRelatorio === 'progresso_tratamento') {
                agentName = 'relatorios';
                console.log(`📊 [CLASSIFICADOR] Ainda sobre progresso, sem nome reconhecível — ${user.phone}`);
                response = await handleRelatorios({ user, message, subtipo: 'progresso_tratamento', state });
            } else {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                agentName = agenteSelecionado;
                const idleState = { state: 'idle', context: {} };

                if (agenteSelecionado === 'cadastro') {
                    console.log(`💊 [CLASSIFICADOR] Roteando para cadastro (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    response = await handleCadastro({
                        user, message, state: idleState, historicoConversa,
                        context: { etapa: 'cad_nome' }
                    });
                } else if (agenteSelecionado === 'relatorios') {
                    console.log(`📊 [CLASSIFICADOR] Roteando para relatorios (${subtipoRelatorio}, saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    response = await handleRelatorios({ user, message, subtipo: subtipoRelatorio, state: idleState });
                    if (!response) {
                        agentName = 'principal';
                        response = await handlePrincipal({ user, message, image, historicoConversa });
                    }
                } else if (agenteSelecionado === 'configuracao') {
                    console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    response = await handleConfiguracao({
                        user, message, state: idleState, historicoConversa,
                        context: { etapa: 'identif_intencao' }
                    });
                } else if (agenteSelecionado === 'nao_suportado') {
                    agentName = 'principal';
                    console.log(`🚧 [CLASSIFICADOR] Intenção não suportada (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    await registrarIntencaoNaoSuportada(user.id, message);
                    response = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true });
                } else {
                    agentName = 'principal';
                    console.log(`🤖 [CLASSIFICADOR] Roteando para principal (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    response = await handlePrincipal({ user, message, image, historicoConversa });
                }
            }
        }

    // 3. Usuário no meio de um fluxo de configuração
    } else if (currentState === 'configurando') {
        agentName = 'configuracao';
        console.log(`⚙️ Roteando para configuração (estado configurando) — ${user.phone}`);
        response = await handleConfiguracao({
            user, message, state, historicoConversa,
            context: state?.context || {}
        });

    // 3b. Usuário em idle com intenção de configuração detectada
    } else if (currentState === 'idle' && detectarIntencaoConfiguracao(message)) {
        agentName = 'configuracao';
        console.log(`⚙️ Roteando para configuração (intenção detectada) — ${user.phone}`);
        response = await handleConfiguracao({
            user, message, state, historicoConversa,
            context: { etapa: 'identif_intencao' }
        });

    // 4. Usuário já está em fluxo de cadastro → agente_cadastro
    } else if (currentState === 'adding_med') {
        agentName = 'cadastro';
        console.log(`💊 Roteando para cadastro (estado adding_med) — ${user.phone}`);
        response = await handleCadastro({
            user,
            message,
            state,
            historicoConversa,
            context: state?.context || {}
        });

    // Handler para estado fantasma criado pelo agente_principal
    // Redireciona para o fluxo estruturado do agente_cadastro
    } else if (currentState === 'cadastrando_medicamento') {
        agentName = 'cadastro';
        console.log(`💊 Roteando para cadastro (estado cadastrando_medicamento corrigido) — ${user.phone}`);
        response = await handleCadastro({
            user,
            message,
            state,
            historicoConversa,
            context: { etapa: 'cad_nome' }  // reinicia do zero de forma estruturada
        });

    // 4. Usuário idle com intenção explícita de cadastro → agente_cadastro
    } else if (currentState === 'idle' && detectarIntencaoCadastro(message)) {
        agentName = 'cadastro';
        console.log(`💊 Roteando para cadastro (intenção detectada) — ${user.phone}`);
        response = await handleCadastro({
            user,
            message,
            state,
            historicoConversa,
            context: { etapa: 'cad_nome' }
        });

    // 4. PRIORIDADE: confirmação de dose — só intercepta se mensagem É confirmação E há dose real pendente
    } else if (currentState === 'idle'
        && detectarConfirmacaoDose(message)
        && await temDosePendente(user.id)) {
        agentName = 'principal';
        console.log(`💊 Confirmação de dose detectada, roteando para principal — ${user.phone}`);
        response = await handlePrincipal({ user, message, image, historicoConversa });

    // 4b. Resposta tardia ao esgotamento (BUG-035) — fast-path determinístico,
    // distinto do fast-path por referenceMessageId (BUG-029, ainda quebrado)
    } else if (currentState === 'idle'
        && detectarConfirmacaoDose(message)
        && !(await temDosePendente(user.id))) {

        const resultado = await tentarConfirmarRespostaTardia(user, message);
        if (resultado) {
            agentName = 'fast_path_resposta_tardia';
            response = resultado;
        } else {
            // Nenhuma condição bateu — segue fluxo normal (cai no principal/retroativo/classificador)
            agentName = 'principal';
            response = await handlePrincipal({ user, message, image, historicoConversa });
        }

    // 5. Usuário idle com intenção de relatório → agente_relatorios
    } else if (currentState === 'idle' && classificarIntencaoRelatorio(message)) {
        const subtipo = classificarIntencaoRelatorio(message);
        agentName = 'relatorios';
        console.log(`📊 Roteando para relatorios (${subtipo}) — ${user.phone}`);
        const resultado = await handleRelatorios({ user, message, subtipo, state });

        if (resultado) {
            response = resultado;
        } else {
            // Classificador não reconheceu na execução — cai no principal
            agentName = 'principal';
            console.log(`🤖 Relatorios não reconheceu, caindo no principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });
        }

    // 6. Demais casos → classificador LLM com contexto conversacional
    } else {
        const { agente: agenteSelecionado, subtipoRelatorio } = await classificarIntencaoComContexto({
            message,
            currentState,
            historicoConversa
        });

        agentName = agenteSelecionado;

        if (agenteSelecionado === 'cadastro') {
            console.log(`💊 [CLASSIFICADOR] Roteando para cadastro — ${user.phone}`);
            response = await handleCadastro({
                user, message, state, historicoConversa,
                context: { etapa: 'cad_nome' }
            });
        } else if (agenteSelecionado === 'relatorios') {
            console.log(`📊 [CLASSIFICADOR] Roteando para relatorios (${subtipoRelatorio}) — ${user.phone}`);
            response = await handleRelatorios({ user, message, subtipo: subtipoRelatorio, state });
            if (!response) {
                agentName = 'principal';
                response = await handlePrincipal({ user, message, image, historicoConversa });
            }
        } else if (agenteSelecionado === 'configuracao') {
            console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao — ${user.phone}`);
            response = await handleConfiguracao({
                user, message, state, historicoConversa,
                context: { etapa: 'identif_intencao' }
            });
        } else if (agenteSelecionado === 'nao_suportado') {
            agentName = 'principal';
            console.log(`🚧 [CLASSIFICADOR] Intenção não suportada — ${user.phone}`);
            await registrarIntencaoNaoSuportada(user.id, message);
            response = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true });
        } else {
            // 'principal' — resposta geral ou intenção não identificada
            agentName = 'principal';
            console.log(`🤖 [CLASSIFICADOR] Roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });
        }
    }

    await logAgentInteraction({
        userId: user.id,
        agent: agentName,
        userMessage: message,
        agentResponse: response,
        estadoConversa: currentState || null,
        contextoConversa: state?.context || null
    });

    return response;
}
