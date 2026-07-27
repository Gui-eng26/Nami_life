import 'dotenv/config';
import { getOrCreateUser, logAgentInteraction } from './database.js';
import { sendTextMessage } from './whatsapp.js';
import { routeMessage } from './router.js';
import { registrarEvento } from './observabilidade.js';

export async function handleIncomingMessage({ phone, text, audio, image, messageId, referenceMessageId }) {
    let user;
    try {
        user = await getOrCreateUser(phone);

        if (audio && !text) {
            console.log(`🎵 Áudio recebido de ${phone} — ignorando sem alterar estado`);
            await sendTextMessage(phone,
                'Oi! 😊 Ainda não consigo ouvir áudios, mas estou melhorando!\n\nPode me escrever o que você disse? Estou aqui pra te ajudar! 💊🌿'
            );
            return;
        }

        const response = await routeMessage({ user, message: text, image, messageId, referenceMessageId });
        if (!response) return; // mensagem duplicada — router retornou null
        await sendTextMessage(phone, response);

    } catch (error) {
        console.error('❌ Erro no agente:', error.message);
        console.error('Stack:', error.stack);

        try {
            let agentLogId = null;
            if (typeof user !== 'undefined' && user?.id) {
                agentLogId = await logAgentInteraction({
                    userId: user.id,
                    agent: 'erro',
                    userMessage: text,
                    agentResponse: null,
                    estadoConversa: 'erro'
                });
            }
            await registrarEvento({
                tipo: 'erro_tecnico',
                severidade: 'alta',
                userId: (typeof user !== 'undefined' && user?.id) ? user.id : null,
                agent: 'agent',
                origem: 'catch_global',
                agentLogId,
                titulo: `Exceção não tratada: ${error.message?.split('\n')[0] ?? 'desconhecida'}`.slice(0, 200),
                payload: { message: error.message, stack: error.stack, estado: 'erro' }
            });
        } catch (obsError) {
            console.error('[observabilidade] Falha ao capturar erro técnico:', obsError.message);
        }

        try {
            await sendTextMessage(phone, 'Desculpe, tive um probleminha aqui. Pode repetir o que você disse? 🌿');
        } catch (sendError) {
            console.error('❌ Erro ao enviar mensagem de erro:', sendError.message);
        }
    }
}
