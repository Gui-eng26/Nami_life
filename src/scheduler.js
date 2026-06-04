import cron from 'node-cron';
import 'dotenv/config';
import { getPendingReminders, createDoseLog } from './database.js';
import { sendTextMessage } from './whatsapp.js';

// ============================================================
// INICIA O SCHEDULER
// Chame essa função no index.js para ativar os lembretes
// ============================================================

export function startScheduler() {
    console.log('⏰ Scheduler da Nami iniciado...');

    // Roda a cada minuto
    // para: roda a cada 2 minutos e só loga se tiver lembretes
    cron.schedule('*/2 * * * *', async () => {
        await checkAndSendReminders();
    });
}

// ============================================================
// VERIFICA E DISPARA LEMBRETES
// ============================================================

async function checkAndSendReminders() {
    try {
        const reminders = await getPendingReminders();

        if (reminders.length === 0) return;

        console.log(`💊 ${reminders.length} lembrete(s) para disparar...`);

        for (const reminder of reminders) {
            await sendReminder(reminder);

            // Pequena pausa entre envios para não sobrecarregar a API
            await sleep(1000);
        }

    } catch (error) {
        console.error('❌ Erro no scheduler:', error.message);
    }
}

// ============================================================
// ENVIA UM LEMBRETE INDIVIDUAL
// ============================================================

async function sendReminder(reminder) {
    try {
        const firstName = reminder.user_name
            ? reminder.user_name.split(' ')[0]
            : 'você';

        // Monta a mensagem de lembrete
        const message = buildReminderMessage(firstName, reminder);

        // Envia a mensagem
        await sendTextMessage(reminder.phone, message);

        // Registra no banco que o lembrete foi enviado
        await createDoseLog({
            medicationId: reminder.medication_id,
            scheduledAt: new Date().toISOString(),
            reminderSent: true,
            reminderSentAt: new Date().toISOString()
        });

        console.log(`✅ Lembrete enviado para ${reminder.phone} — ${reminder.med_nome}`);

        // Verifica se o estoque está baixo e envia alerta separado
        if (reminder.estoque_atual <= reminder.estoque_minimo) {
            await sleep(2000);
            await sendLowStockAlert(reminder);
        }

    } catch (error) {
        console.error(`❌ Erro ao enviar lembrete para ${reminder.phone}:`, error.message);
    }
}

// ============================================================
// MONTA A MENSAGEM DE LEMBRETE
// ============================================================

function buildReminderMessage(firstName, reminder) {
    const dosagem = reminder.med_dosagem
        ? ` — ${reminder.med_dosagem}`
        : '';

    return `⏰ Olá, ${firstName}!\n\nHora do seu *${reminder.med_nome}*${dosagem}.\n\nJá tomou? Responda *SIM* ou *NÃO* 💊`;
}

// ============================================================
// ENVIA ALERTA DE ESTOQUE BAIXO
// ============================================================

async function sendLowStockAlert(reminder) {
    try {
        const firstName = reminder.user_name
            ? reminder.user_name.split(' ')[0]
            : 'você';

        const diasRestantes = reminder.estoque_atual;

        const message = `⚠️ Atenção, ${firstName}!\n\nSeu *${reminder.med_nome}* vai acabar em aproximadamente *${diasRestantes} dias*.\n\nNão esqueça de fazer a recompra para não interromper seu tratamento! 💊`;

        await sendTextMessage(reminder.phone, message);
        console.log(`📦 Alerta de estoque enviado para ${reminder.phone}`);

    } catch (error) {
        console.error('❌ Erro ao enviar alerta de estoque:', error.message);
    }
}

// ============================================================
// UTILITÁRIO
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}