import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId } from './database.js';
import { handleRecepcionista } from './agentes/recepcionista.js';
import { handlePrincipal } from './agentes/principal.js';
import { handleCadastro } from './agentes/cadastro.js';
import { handleRelatorios, classificarIntencaoRelatorio } from './agentes/relatorios.js';

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
    const termos = ['sim', 'tomei', 'já tomei', 'pode', 'ok', 'claro',
        'feito', 'tá', 'foi', 'tomei sim', 'já tomei sim'];
    const msg = message.toLowerCase().trim();
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
            console.log(`✅ [FAST-PATH] Dose confirmada via referenceMessageId — ${user.phone} — ${nomeRemedio}`);

            await logAgentInteraction({
                userId: user.id,
                agent: 'fast_path_reference',
                userMessage: message,
                agentResponse: `Dose confirmada: ${nomeRemedio}`
            });

            const firstName = user.name ? user.name.split(' ')[0] : 'você';
            return `✅ Anotei! Dose do *${nomeRemedio}* confirmada, ${firstName}. Continue assim! 💪💊`;
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
        }

    // 3. Usuário já está em fluxo de cadastro → agente_cadastro
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
