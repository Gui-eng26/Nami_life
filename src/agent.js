import 'dotenv/config';
import { getOrCreateUser, getConversationState, logAgentInteraction } from './database.js';
import { enviarAoUsuario } from './funil.js';
import { routeMessage } from './router.js';
import { registrarEvento, tituloEstavel } from './observabilidade.js';

// v44 §5.5: recusa de áudio deixa de ser atalho invisível fora do pipeline.
// A recusa vem da lista AINDA_NÃO FAZ do inventário (honestidade + expectativa,
// Constituição regra 6), é registrada em agent_logs e sai pelo funil.
async function recusarAudio(user, phone) {
    const state = await getConversationState(user.id);
    const texto =
        'Ainda não consigo ouvir áudios — é uma das coisas que estou aprendendo a fazer. 😊\n\n' +
        'Pode me escrever o que você disse?';

    const agentLogId = await logAgentInteraction({
        userId: user.id,
        agent: 'recusa_capacidade',
        userMessage: '[áudio recebido]',
        agentResponse: texto,
        estadoConversa: state?.state || null,
        contextoConversa: state?.context || null
    });

    await enviarAoUsuario({
        phone,
        userId: user.id,
        texto,
        origem: 'agente:recusa_capacidade',
        agentLogId
    });
}

export async function handleIncomingMessage({ phone, text, audio, image, messageId, referenceMessageId }) {
    let user;
    try {
        user = await getOrCreateUser(phone);

        if (audio && !text) {
            console.log(`🎵 Áudio recebido de ${phone} — recusa honesta pelo pipeline (v44 §5.5)`);
            await recusarAudio(user, phone);
            return;
        }

        const resultado = await routeMessage({ user, message: text, image, messageId, referenceMessageId });
        if (!resultado) return; // mensagem duplicada — router retornou null
        await enviarAoUsuario({
            phone,
            userId: user.id,
            texto: resultado.texto,
            origem: `agente:${resultado.agente}`,
            agentLogId: resultado.agentLogId ?? null
        });

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
                titulo: tituloEstavel(error, 'Exceção não tratada (agent)'),
                payload: { message: error.message, stack: error.stack, estado: 'erro' }
            });
        } catch (obsError) {
            console.error('[observabilidade] Falha ao capturar erro técnico:', obsError.message);
        }

        try {
            await enviarAoUsuario({
                phone,
                userId: (typeof user !== 'undefined' && user?.id) ? user.id : null,
                texto: 'Desculpe, tive um probleminha aqui. Pode repetir o que você disse? 🌿',
                origem: 'agente:erro'
            });
        } catch (sendError) {
            console.error('❌ Erro ao enviar mensagem de erro:', sendError.message);
        }
    }
}
