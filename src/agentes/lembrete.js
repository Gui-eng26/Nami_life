import { sendTextMessage } from '../whatsapp.js';
import {
    updateDoseLogTentativa,
    markAsNaoInformado,
    getCaregivers,
    markCaregiverNotified
} from '../database.js';

// ============================================================
// MENSAGENS DE FOLLOW-UP
// ============================================================

function buildFollowUpMessage(tentativa, reminder) {
    const nome = reminder.user_name
        ? reminder.user_name.split(' ')[0]
        : 'você';
    const remedio = reminder.med_nome || 'seu remédio';

    if (tentativa === 2) {
        return (
            `⏰ ${nome}, só passando para lembrar!\n\n` +
            `Ainda não vi sua confirmação do *${remedio}*.\n` +
            `Já tomou? Responda *SIM* ou *NÃO* 💊`
        );
    }

    if (tentativa === 3) {
        return (
            `💊 ${nome}, último aviso de hoje!\n\n` +
            `Seu *${remedio}* ainda está aguardando confirmação.\n` +
            `Tomou? É só responder *SIM* ou *NÃO* 🌿`
        );
    }

    // Fallback seguro (não deveria ser chamado fora de tentativa 2 ou 3)
    return `💊 ${nome}, lembrete do *${remedio}*. Já tomou? Responda *SIM* ou *NÃO*`;
}

// ============================================================
// NOTIFICAÇÃO DE CUIDADORES
// ============================================================

async function notificarCuidadores(doseLog, reminder) {
    try {
        const userId = doseLog.user_id || doseLog.medications?.user_id;
        if (!userId) return;

        const cuidadores = await getCaregivers(userId);
        if (cuidadores.length === 0) return;

        const nomePaciente = reminder.user_name || 'O paciente';
        const remedio = reminder.med_nome || 'o medicamento';
        const horario = reminder.scheduled_at
            ? new Date(reminder.scheduled_at).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'America/Sao_Paulo'
              })
            : 'horário agendado';

        const message =
            `⚠️ Atenção!\n\n` +
            `*${nomePaciente}* não confirmou a dose do *${remedio}* ` +
            `que estava agendada para ${horario}.\n\n` +
            `Esta foi a 3ª tentativa sem resposta.`;

        for (const entry of cuidadores) {
            const phoneCaregiver = entry.caregiver?.phone;
            if (!phoneCaregiver) continue;

            try {
                await sendTextMessage(phoneCaregiver, message);
                console.log(`📣 Cuidador notificado: ${phoneCaregiver} — dose de ${remedio}`);
            } catch (err) {
                console.error(`❌ Erro ao notificar cuidador ${phoneCaregiver}:`, err.message);
            }
        }

        await markCaregiverNotified(doseLog.id);

    } catch (error) {
        console.error('❌ Erro em notificarCuidadores:', error.message);
    }
}

// ============================================================
// HANDLER PRINCIPAL DE FOLLOW-UP
// ============================================================

export async function handleFollowUp({ doseLog, reminder }) {
    const tentativa = (doseLog.tentativas || 1) + 1;
    const nome = reminder.user_name
        ? reminder.user_name.split(' ')[0]
        : 'usuário';

    try {
        if (tentativa <= 3) {
            const message = buildFollowUpMessage(tentativa, reminder);
            await sendTextMessage(reminder.phone, message);
            await updateDoseLogTentativa(doseLog.id, tentativa);
            console.log(`🔔 Follow-up tentativa ${tentativa} enviado para ${reminder.phone} — ${reminder.med_nome}`);
        } else {
            // 3 tentativas esgotadas — marca como não informado e avisa cuidadores
            await markAsNaoInformado(doseLog.id);
            console.log(`⚠️ Dose marcada como nao_informado (${doseLog.id}) — ${reminder.phone} — ${reminder.med_nome}`);
            await notificarCuidadores(doseLog, reminder);
        }
    } catch (error) {
        console.error(`❌ Erro no follow-up para ${reminder.phone}:`, error.message);
    }
}
