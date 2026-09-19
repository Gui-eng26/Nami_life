// ============================================================
// FUNIL ÚNICO DE SAÍDA (v44 M1, briefing §5.5)
//
// TODO texto que a Nami envia a alguém — resposta de agente, lembrete,
// follow-up, alerta, resumo, aviso a cuidador — passa por enviarAoUsuario.
// Um ponto de envio + um ponto de log (tabela funil_envios).
//
// Critério de aceite §6.4: nenhum outro módulo importa sendTextMessage.
// (verificável por grep de sendTextMessage fora deste arquivo e de whatsapp.js)
//
// O arnês (M0) injeta o transporte de captura por configurarTransporteParaTestes —
// é ESTE o ponto de mock da suíte, nunca a Z-API nem os agentes.
// ============================================================

import { sendTextMessage } from './whatsapp.js';
import { registrarEnvioFunil } from './database.js';
import { registrarEvento } from './observabilidade.js';

let transporte = sendTextMessage;

export function configurarTransporteParaTestes(fn) {
    transporte = fn;
}

// Envia e registra. Lança se o ENVIO falhar (mesmo contrato de sendTextMessage —
// os catches existentes dos chamadores continuam valendo). Falha só no REGISTRO
// não engole a mensagem já entregue: registra evento de degradação e segue.
//
// origem: 'agente:<nome>' | 'proativo:<tipo>' | 'cuidador:<tipo>'
export async function enviarAoUsuario({ phone, userId = null, texto, origem, agentLogId = null }) {
    const resultado = await transporte(phone, texto);

    // T0 CONCLUÍDO (19/09/2026, teste real no staging): o referenceMessageId do
    // webhook de citação é o messageId (6275FA7887596B3661E9 == message_id do envio;
    // o zaapId 01A0BA36... não bate). Seguimos gravando AMBOS por auditoria — a
    // resolução (getEnvioFunilPorProviderId) compara contra os dois por robustez.
    const zaapId = resultado?.zaapId ?? null;
    const messageId = resultado?.messageId ?? null;

    let envioId = null;
    try {
        envioId = await registrarEnvioFunil({ userId, phone, texto, origem, zaapId, messageId, agentLogId });
    } catch (e) {
        console.error(`⚠️ [FUNIL] Envio entregue mas registro falhou (${origem}):`, e.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'media',
            userId,
            agent: 'funil',
            origem: 'outro',
            titulo: 'Falha ao registrar envio no funil',
            payload: { origem_envio: origem, message: e.message }
        });
    }

    return { envioId, zaapId, messageId };
}
