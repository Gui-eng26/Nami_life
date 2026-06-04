import axios from 'axios';
import 'dotenv/config';

const ZAPI_URL = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;

export async function sendTextMessage(phone, message) {
    try {
        const cleanPhone = phone.replace(/\D/g, '');

        console.log(`📤 Enviando para ${cleanPhone}`);

        const response = await axios.post(`${ZAPI_URL}/send-text`, {
            phone: cleanPhone,
            message
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Client-Token': process.env.ZAPI_CLIENT_TOKEN
            }
        });

        console.log(`✅ Mensagem enviada para ${cleanPhone}`);
        return response.data;

    } catch (error) {
        console.error(`❌ Erro Z-API:`, error.response?.status, error.response?.data || error.message);
        throw error;
    }
}

export async function downloadAudio(audioUrl) {
    try {
        const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (error) {
        console.error('❌ Erro ao baixar áudio:', error.message);
        throw error;
    }
}

export function parseZApiPayload(body) {
    if (body.fromMe) return null;
    if (body.isGroup) return null;

    const phone = body.phone
        ? `+${body.phone.replace(/\D/g, '')}`
        : null;

    if (!phone) return null;

    const text = body.text?.message || null;
    const audio = body.audio?.audioUrl || null;
    const image = body.image?.imageUrl || null;

    return { phone, text, audio, image };
}