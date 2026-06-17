import cron from 'node-cron';
import 'dotenv/config';
import { getPendingReminders, getPendingFollowUps, createDoseLog,
    getUsuariosAtivos } from './database.js';
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
        if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
            const firstName = reminder.user_name?.split(' ')[0] || 'você';
            const message = buildEstoqueZeradoMessage(firstName, reminder);
            await sendTextMessage(reminder.phone, message);

            // Cria dose_log com status 'sem_estoque' para ativar deduplicação do scheduler
            // Sem isso, o stored procedure retorna o mesmo medicamento no próximo ciclo
            await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                status: 'sem_estoque'
            });

            console.log(`📦 Aviso de estoque zerado enviado para ${reminder.phone} — ${reminder.med_nome}`);
            return;
        }

        const firstName = reminder.user_name
            ? reminder.user_name.split(' ')[0]
            : 'você';

        const message = buildReminderMessage(firstName, reminder);

        // BUG-029: capturar o ID da mensagem enviada pela Z-API
        const zapiResult = await sendTextMessage(reminder.phone, message);
        const zapiMessageId = zapiResult?.zapiMessageId || null;

        await createDoseLog({
            medicationId: reminder.medication_id,
            scheduledAt: new Date().toISOString(),
            reminderSent: true,
            reminderSentAt: new Date().toISOString(),
            zapiMessageId
        });

        console.log(`✅ Lembrete enviado para ${reminder.phone} — ${reminder.med_nome}`);

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
// MENSAGEM DE ESTOQUE ZERADO
// ============================================================

function buildEstoqueZeradoMessage(firstName, reminder) {
    return (
        `⏰ ${firstName}, está na hora do seu *${reminder.med_nome}*!\n\n` +
        `⚠️ Seu estoque está zerado — não foi possível registrar a dose.\n\n` +
        `Quando fizer a recompra, me avise a nova quantidade:\n` +
        `*"Comprei 30 comprimidos de ${reminder.med_nome}"* 💊`
    );
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
