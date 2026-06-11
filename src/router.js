import { getConversationState, logAgentInteraction, getRecentDoses } from './database.js';
import { handleRecepcionista } from './agentes/recepcionista.js';
import { handlePrincipal } from './agentes/principal.js';
import { handleCadastro } from './agentes/cadastro.js';
import { handleRelatorios, classificarIntencaoRelatorio } from './agentes/relatorios.js';

// ============================================================
// DOSE PENDENTE DE CONFIRMAÇÃO
// ============================================================

async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return doses.some(d => d.reminder_sent === true && d.confirmed === false);
}

// ============================================================
// DETECÇÃO DE INTENÇÃO DE CADASTRO
// ============================================================

function detectarIntencaoCadastro(message) {
    if (!message) return false;
    const termos = [
        'cadastrar', 'adicionar remédio', 'novo remédio', 'registrar remédio',
        'quero cadastrar', 'tenho um remédio', 'adicionar medicamento',
        'novo medicamento', 'registrar medicamento', 'quero adicionar'
    ];
    const msg = message.toLowerCase();
    return termos.some(t => msg.includes(t));
}

// ============================================================
// ROTEADOR PRINCIPAL
// ============================================================

export async function routeMessage({ user, message, image }) {
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

    // 2. Usuário já está em fluxo de cadastro → agente_cadastro
    } else if (currentState === 'adding_med') {
        agentName = 'cadastro';
        console.log(`💊 Roteando para cadastro (estado adding_med) — ${user.phone}`);
        response = await handleCadastro({
            user,
            message,
            state,
            context: state?.context || {}
        });

    // 3. Usuário idle com intenção explícita de cadastro → agente_cadastro
    } else if (currentState === 'idle' && detectarIntencaoCadastro(message)) {
        agentName = 'cadastro';
        console.log(`💊 Roteando para cadastro (intenção detectada) — ${user.phone}`);
        response = await handleCadastro({
            user,
            message,
            state,
            context: { etapa: 'cad_nome' }
        });

    // 4. PRIORIDADE: dose pendente de confirmação → principal (antes dos relatórios)
    } else if (currentState === 'idle' && await temDosePendente(user.id)) {
        agentName = 'principal';
        console.log(`💊 Dose pendente detectada, roteando para principal — ${user.phone}`);
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
