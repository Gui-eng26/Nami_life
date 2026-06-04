import { getConversationState, logAgentInteraction } from './database.js';
import { handleRecepcionista } from './agentes/recepcionista.js';
import { handlePrincipal } from './agentes/principal.js';

export async function routeMessage({ user, message, image }) {
    const state = await getConversationState(user.id);
    const currentState = state?.state || 'idle';

    let response;
    let agentName;

    if (!user.onboarded) {
        agentName = 'recepcionista';
        console.log(`👋 Roteando para recepcionista — ${user.phone}`);
        response = await handleRecepcionista({ user, message, context: state?.context || {} });
    } else if (currentState === 'cadastro') {
        // futuro: agente_cadastro
        agentName = 'principal';
        response = await handlePrincipal({ user, message, image });
    } else {
        agentName = 'principal';
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
