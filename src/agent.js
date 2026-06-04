import 'dotenv/config';
import { getOrCreateUser } from './database.js';
import { sendTextMessage } from './whatsapp.js';
import { routeMessage } from './router.js';

export async function handleIncomingMessage({ phone, text, audio, image }) {
    try {
        const user = await getOrCreateUser(phone);

        if (audio && !text) {
            console.log(`🎵 Áudio recebido de ${phone} — ignorando sem alterar estado`);
            await sendTextMessage(phone,
                'Oi! 😊 Ainda não consigo ouvir áudios, mas estou melhorando!\n\nPode me escrever o que você disse? Estou aqui pra te ajudar! 💊🌿'
            );
            return;
        }

        const response = await routeMessage({ user, message: text, image });
        await sendTextMessage(phone, response);

    } catch (error) {
        console.error('❌ Erro no agente:', error.message);
        console.error('Stack:', error.stack);
        try {
            await sendTextMessage(phone, 'Desculpe, tive um probleminha aqui. Pode repetir o que você disse? 🌿');
        } catch (sendError) {
            console.error('❌ Erro ao enviar mensagem de erro:', sendError.message);
        }
    }
}
