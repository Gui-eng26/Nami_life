import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque,
    saveConversationState } from './database.js';
import { handleRecepcionista } from './agentes/recepcionista.js';
import { handlePrincipal } from './agentes/principal.js';
import { handleCadastro } from './agentes/cadastro.js';
import { handleRelatorios, classificarIntencaoRelatorio } from './agentes/relatorios.js';
import { handleConfiguracao } from './agentes/configuracao.js';

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

async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return doses.some(d => d.reminder_sent === true && d.confirmed === false);
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
                agentResponse: `Dose confirmada: ${nomeRemedio}`
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

    let response;
    let agentName;

    // 1. Usuário ainda não fez onboarding → recepcionista
    if (!user.onboarded) {
        agentName = 'recepcionista';
        console.log(`👋 Roteando para recepcionista — ${user.phone}`);
        response = await handleRecepcionista({
            user,
            message,
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
                context: { etapa: 'cad_nome' }
            });
        } else {
            agentName = 'principal';
            console.log(`🤖 Roteando para principal (pós-onboarding) — ${user.phone}`);
            response = await handlePrincipal({ user, message, image });

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

    // 3. Usuário no meio de um fluxo de configuração
    } else if (currentState === 'configurando') {
        agentName = 'configuracao';
        console.log(`⚙️ Roteando para configuração (estado configurando) — ${user.phone}`);
        response = await handleConfiguracao({
            user, message, state,
            context: state?.context || {}
        });

    // 3b. Usuário em idle com intenção de configuração detectada
    } else if (currentState === 'idle' && detectarIntencaoConfiguracao(message)) {
        agentName = 'configuracao';
        console.log(`⚙️ Roteando para configuração (intenção detectada) — ${user.phone}`);
        response = await handleConfiguracao({
            user, message, state,
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
            context: { etapa: 'cad_nome' }
        });

    // 4. PRIORIDADE: confirmação de dose — só intercepta se mensagem É confirmação E há dose real pendente
    } else if (currentState === 'idle'
        && detectarConfirmacaoDose(message)
        && await temDosePendente(user.id)) {
        agentName = 'principal';
        console.log(`💊 Confirmação de dose detectada, roteando para principal — ${user.phone}`);
        response = await handlePrincipal({ user, message, image });

    // 5. Usuário idle com intenção de relatório → agente_relatorios
    } else if (currentState === 'idle' && classificarIntencaoRelatorio(message)) {
        agentName = 'relatorios';
        console.log(`📊 Roteando para relatorios — ${user.phone}`);
        const resultado = await handleRelatorios({ user, message });

        if (resultado) {
            response = resultado;
        } else {
            // Classificador não reconheceu na execução — cai no principal
            agentName = 'principal';
            console.log(`🤖 Relatorios não reconheceu, caindo no principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image });
        }

    // 6. Demais casos → agente_principal
    } else {
        agentName = 'principal';
        console.log(`🤖 Roteando para principal — ${user.phone}`);
        response = await handlePrincipal({ user, message, image });
    }

    await logAgentInteraction({
        userId: user.id,
        agent: agentName,
        userMessage: message,
        agentResponse: response
    });

    return response;
}
