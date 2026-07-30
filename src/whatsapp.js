import axios from 'axios';
import 'dotenv/config';
import { registrarEvento } from './observabilidade.js';

const ZAPI_URL = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;

export async function sendTextMessage(phone, message) {
    // BARREIRA DE FORMA (v26) — instrumenta a classe "estrutura de controle interna alcança o
    // ponto de saída" (BUG-067 em 27/07, BUG-069 em 28/07, arquivos e causas diferentes).
    //
    // NÃO muda o comportamento: um valor não-string já falha hoje, com 400 na Z-API → throw →
    // catch global → mensagem educada ao usuário. A barreira produz o MESMO desfecho, só que
    // registrando a forma exata do que vazou em vez de um AxiosError 400 mudo.
    //
    // FORA do try de propósito: dentro, o catch da Z-API registraria um SEGUNDO evento para o
    // mesmo defeito, com fingerprint diferente, poluindo a fila de triagem.
    //
    // Rejeita APENAS não-string. String vazia NÃO é barrada: seria mudança de comportamento
    // real (hoje segue para a Z-API) e não há nenhuma evidência de que ocorra.
    if (typeof message !== 'string') {
        const forma = message === null ? 'null'
            : message === undefined ? 'undefined'
            : typeof message === 'object' ? `object:${Object.keys(message).join(',').slice(0, 100)}`
            : typeof message;

        console.error(`❌ [BARREIRA] sendTextMessage recebeu payload inválido — forma: ${forma}`);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            agent: 'whatsapp',
            origem: 'outro',
            titulo: 'Payload inválido em sendTextMessage (não-string)',
            payload: { forma, tipo_js: typeof message }
        });
        throw new TypeError(`sendTextMessage: message deve ser string (recebeu ${forma})`);
    }

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

        const zapiMessageId = response.data?.zaapId
            || response.data?.messageId
            || response.data?.id
            || null;

        console.log(`✅ Mensagem enviada para ${cleanPhone}${zapiMessageId ? ` — msgId: ${zapiMessageId}` : ''}`);
        return { ...response.data, zapiMessageId };

    } catch (error) {
        console.error(`❌ Erro Z-API:`, error.response?.status, error.response?.data || error.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'media',
            agent: 'whatsapp',
            origem: 'outro',
            titulo: 'Falha de envio Z-API (sendTextMessage)',
            payload: { status: error.response?.status ?? null, message: error.response?.data || error.message }
        });
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
    const referenceMessageId = body.referenceMessageId || null;

    return { phone, text, audio, image, referenceMessageId };
}