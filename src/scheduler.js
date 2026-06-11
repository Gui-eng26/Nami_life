import cron from 'node-cron';
import 'dotenv/config';
import { getPendingReminders, getPendingFollowUps, createDoseLog, getUsuariosAtivos } from './database.js';
import { sendTextMessage } from './whatsapp.js';
import { handleFollowUp } from './agentes/lembrete.js';
import { enviarResumoSemanal } from './agentes/relatorios.js';

// ============================================================
// INICIA O SCHEDULER
// Chame essa função no index.js para ativar os lembretes
// ============================================================

export function startScheduler() {
    console.log('⏰ Scheduler da Nami iniciado...');

    // Lembretes e follow-ups — a cada 2 minutos
    cron.schedule('*/2 * * * *', async () => {
        await checkAndSendReminders();
    });

    // Resumo semanal — toda segunda-feira às 08:00 (horário de Brasília)
    cron.schedule('0 8 * * 1', async () => {
        console.log('📊 Enviando resumos semanais...');
        try {
            const usuarios = await getUsuariosAtivos();
            console.log(`📊 ${usuarios.length} usuário(s) para resumo semanal`);
            for (const user of usuarios) {
                await enviarResumoSemanal(user);
                await sleep(2000);
            }
        } catch (error) {
            console.error('❌ Erro ao enviar resumos semanais:', error.message);
        }
    }, { timezone: 'America/Sao_Paulo' });
}

// ============================================================
// VERIFICA E DISPARA LEMBRETES + FOLLOW-UPS
// ============================================================

async function checkAndSendReminders() {
    try {
        // 1. Lembretes novos (lógica existente)
        const reminders = await getPendingReminders();

        if (reminders.length > 0) {
            console.log(`💊 ${reminders.length} lembrete(s) para disparar...`);

            for (const reminder of reminders) {
                await sendReminder(reminder);
                await sleep(1000);
            }
        }

        // 2. Follow-ups de doses sem resposta
        await checkAndSendFollowUps();

    } catch (error) {
        console.error('❌ Erro no scheduler:', error.message);
    }
}

// ============================================================
// VERIFICA E DISPARA FOLLOW-UPS
// ============================================================

async function checkAndSendFollowUps() {
    try {
        const pendentes = await getPendingFollowUps();
        if (pendentes.length === 0) return;

        console.log(`🔔 ${pendentes.length} follow-up(s) para verificar...`);

        for (const item of pendentes) {
            const minutosSinceUltima = getMinutosSince(item.ultima_tentativa_at);
            const tentativas = item.tentativas || 1;

            const deveReenviar =
                (tentativas === 1 && minutosSinceUltima >= 30) ||
                (tentativas === 2 && minutosSinceUltima >= 60) ||
                (tentativas === 3 && minutosSinceUltima >= 30);

            if (deveReenviar) {
                await handleFollowUp({ doseLog: item, reminder: item });
                await sleep(1000);
            }
        }
    } catch (error) {
        console.error('❌ Erro nos follow-ups:', error.message);
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

        const message = buildReminderMessage(firstName, reminder);

        await sendTextMessage(reminder.phone, message);

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
// UTILITÁRIOS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getMinutosSince(timestamp) {
    if (!timestamp) return 0;
    return (Date.now() - new Date(timestamp).getTime()) / 60000;
}
