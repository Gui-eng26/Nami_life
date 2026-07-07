import cron from 'node-cron';
import 'dotenv/config';
import { getPendingReminders, getPendingFollowUps, createDoseLog,
    getUsuariosAtivos, updateDoseLogTentativa } from './database.js';
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

    // Resumo semanal (ou fechamento mensal, a cada 4 semanas) — todo domingo às 16:00 (horário de Brasília)
    cron.schedule('0 16 * * 0', async () => {
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
        const reminders = await getPendingReminders();

        if (reminders.length > 0) {
            console.log(`💊 ${reminders.length} lembrete(s) para disparar...`);

            const semEstoque = reminders.filter(r => r.estoque_atual !== null && r.estoque_atual <= 0);
            const comEstoque = reminders.filter(r => !(r.estoque_atual !== null && r.estoque_atual <= 0));

            // Doses sem estoque: sempre individuais (mensagem de estoque zerado)
            for (const reminder of semEstoque) {
                await sendReminder(reminder);
                await sleep(1000);
            }

            // Doses com estoque: agrupar por (user_id + horario de cadastro)
            const grupos = agruparPorUsuarioEHorario(
                comEstoque,
                r => r.user_id,
                r => r.horario ? String(r.horario).substring(0, 5) : null
            );
            for (const grupo of grupos) {
                if (grupo.length === 1) {
                    await sendReminder(grupo[0]);
                } else {
                    await sendGroupedReminder(grupo);
                }
                await sleep(1000);
            }
        }

        // Follow-ups de doses sem resposta
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

        // Filtra os que devem reenviar neste ciclo
        const paraReenviar = pendentes.filter(item => {
            const minutosSinceUltima = getMinutosSince(item.ultima_tentativa_at);
            const tentativas = item.tentativas || 1;
            return (
                (tentativas === 1 && minutosSinceUltima >= 30) ||
                (tentativas === 2 && minutosSinceUltima >= 60) ||
                (tentativas === 3 && minutosSinceUltima >= 30)
            );
        });

        if (paraReenviar.length === 0) return;

        // Separa os que vão esgotar (tentativa+1 > 3) dos que ainda enviam mensagem
        const queEsgotam = paraReenviar.filter(item => (item.tentativas || 1) + 1 > 3);
        const queEnviam = paraReenviar.filter(item => (item.tentativas || 1) + 1 <= 3);

        // Esgotamentos sempre individuais (nao_informado, cuidadores, estoque)
        for (const item of queEsgotam) {
            await handleFollowUp({ doseLog: item, reminder: item });
            await sleep(1000);
        }

        // Follow-ups com mensagem: agrupar por (user_id + horario_agendado)
        const grupos = agruparPorUsuarioEHorario(
            queEnviam,
            i => i.user_id,
            i => i.horario_agendado ? String(i.horario_agendado).substring(0, 5) : null
        );

        for (const grupo of grupos) {
            if (grupo.length === 1) {
                await handleFollowUp({ doseLog: grupo[0], reminder: grupo[0] });
            } else {
                await handleGroupedFollowUp(grupo);
            }
            await sleep(1000);
        }
    } catch (error) {
        console.error('❌ Erro nos follow-ups:', error.message);
    }
}

// ============================================================
// HELPER DE AGRUPAMENTO
// ============================================================

// Agrupa itens por (user_id + horário). Itens sem horário (null) ficam em grupos individuais.
function agruparPorUsuarioEHorario(itens, keyUser, keyHorario) {
    const mapa = new Map();
    const individuais = [];

    for (const item of itens) {
        const horario = keyHorario(item);
        if (!horario) {
            individuais.push([item]);
            continue;
        }
        const chave = `${keyUser(item)}||${horario}`;
        if (!mapa.has(chave)) mapa.set(chave, []);
        mapa.get(chave).push(item);
    }

    return [...mapa.values(), ...individuais];
}

// ============================================================
// LEMBRETE AGRUPADO (2+ doses, mesmo usuário e horário)
// ============================================================

async function sendGroupedReminder(grupo) {
    try {
        const primeiro = grupo[0];
        const firstName = primeiro.user_name?.split(' ')[0] || 'você';
        const horario = String(primeiro.horario).substring(0, 5);

        const message = buildGroupedReminderMessage(firstName, horario, grupo);

        await sendTextMessage(primeiro.phone, message);   // envia, mas não usamos o zaapId

        // Doses agrupadas NÃO gravam zapi_message_id (fica NULL) — ver briefing MH-032 complemento.
        // A confirmação delas ocorre pelo fluxo [ref:] do principal.js, não pelo fast-path.
        for (const reminder of grupo) {
            await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                // zapiMessageId omitido de propósito (default null)
                horarioAgendado: String(reminder.horario).substring(0, 5)
            });
        }

        const nomes = grupo.map(r => r.med_nome).join(', ');
        console.log(`✅ Lembrete agrupado (${grupo.length} doses: ${nomes}) enviado para ${primeiro.phone} — horário ${horario}`);
    } catch (error) {
        console.error(`❌ Erro ao enviar lembrete agrupado:`, error.message);
    }
}

function buildGroupedReminderMessage(firstName, horario, grupo) {
    const lista = grupo.map(r => {
        const dosagem = r.med_dosagem ? ` — ${r.med_dosagem}` : '';
        return `• *${r.med_nome}*${dosagem}`;
    }).join('\n');

    return (
        `⏰ ${firstName}, hora dos seus remédios das *${horario}*! 💊\n\n` +
        `${lista}\n\n` +
        `✅ Tomou todos? Responda *SIM*\n` +
        `💬 Tomou só alguns? Me diga quais (ex: "só o ${grupo[0].med_nome}")`
    );
}

// ============================================================
// FOLLOW-UP AGRUPADO (2+ doses pendentes, mesmo horario_agendado)
// ============================================================

async function handleGroupedFollowUp(grupo) {
    try {
        const primeiro = grupo[0];
        const tentativa = (primeiro.tentativas || 1) + 1;
        const firstName = primeiro.user_name?.split(' ')[0] || 'você';
        const horario = String(primeiro.horario_agendado).substring(0, 5);

        const message = buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo);
        await sendTextMessage(primeiro.phone, message);   // envia, mas não usamos o zaapId

        // Atualiza estado individualmente por dose (tentativas), mas NÃO grava zapi_message_id
        // (doses agrupadas não usam o fast-path — ver briefing MH-032 complemento).
        for (const item of grupo) {
            const tentativaItem = (item.tentativas || 1) + 1;
            await updateDoseLogTentativa(item.id, tentativaItem);
        }

        const nomes = grupo.map(i => i.med_nome).join(', ');
        console.log(`🔔 Follow-up agrupado tentativa ${tentativa} (${grupo.length} doses: ${nomes}) enviado para ${primeiro.phone}`);
    } catch (error) {
        console.error(`❌ Erro no follow-up agrupado:`, error.message);
    }
}

function buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo) {
    const lista = grupo.map(r => `• *${r.med_nome}*`).join('\n');
    const abertura = tentativa === 3
        ? `💊 ${firstName}, último aviso de hoje!`
        : `⏰ ${firstName}, só passando para lembrar!`;

    return (
        `${abertura}\n\n` +
        `Ainda não vi sua confirmação dos remédios das *${horario}*:\n` +
        `${lista}\n\n` +
        `✅ Tomou todos? Responda *SIM*\n` +
        `💬 Tomou só alguns? Me diga quais 🌿`
    );
}

// ============================================================
// ENVIA UM LEMBRETE INDIVIDUAL
// ============================================================

async function sendReminder(reminder) {
    try {
        const horarioAgendado = reminder.horario ? String(reminder.horario).substring(0, 5) : null;

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
                status: 'sem_estoque',
                horarioAgendado
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
            zapiMessageId,
            horarioAgendado
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
