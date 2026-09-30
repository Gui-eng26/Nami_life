import cron from 'node-cron';
import 'dotenv/config';
import { getPendingReminders, getPendingFollowUps, createDoseLog,
    getUsuariosAtivos, updateDoseLogTentativa, registrarEventoProativo,
    vincularDosesAoEnvio, registrarAssuntosDoEnvio,
    getTratamentosVencidos, concluirTratamento } from './database.js';
import { enviarAoUsuario } from './funil.js';
import { handleFollowUp } from './agentes/lembrete.js';
import { enviarResumoSemanal } from './agentes/relatorios.js';
import { registrarEvento, tituloEstavel, degradar } from './observabilidade.js';
import { executarJuizOffline } from './juizOffline.js';
// v47 Onda 2 (MH-100 C): o scheduler produz o FATO e pede a renderização ao
// catálogo — nenhum texto ao usuário vive aqui (grep-guard A68).
import { renderizarCanonico } from './templates/catalogo.js';
import { linhaQuantidadeDose } from './templates/dose.js';
import { enfileirar } from './filaTurnos.js';

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
            await registrarEvento({
                tipo: 'erro_tecnico',
                severidade: 'alta',
                origem: 'scheduler',
                agent: 'scheduler',
                titulo: tituloEstavel(error, 'Erro no scheduler (enviarResumosSemanais)'),
                payload: { message: error.message, stack: error.stack, funcao: 'enviarResumosSemanais' }
            });
        }
    }, { timezone: 'America/Sao_Paulo' });

    // Juiz offline (MH-054) — varre os episódios do dia anterior — 03:00 BRT
    cron.schedule('0 3 * * *', async () => {
        console.log('⚖️ Rodando juiz offline...');
        await executarJuizOffline();
    }, { timezone: 'America/Sao_Paulo' });

    // MH-30 (v44 M2) — conclusão automática de tratamento agudo — 09:00 BRT
    // (mensagem proativa também é conversa, regra 10: horário civilizado).
    cron.schedule('0 9 * * *', async () => {
        console.log('🏁 Verificando tratamentos vencidos...');
        await concluirTratamentosVencidos();
    }, { timezone: 'America/Sao_Paulo' });
}

// ============================================================
// MH-30 — CONCLUSÃO AUTOMÁTICA DE TRATAMENTO AGUDO (v44 M2)
// tratamento_fim < hoje E ativo → desativa medicamento e schedules,
// pausa doses pendentes e avisa PELO FUNIL com tom de celebração leve.
// A RPC get_pending_reminders também filtra tratamento_fim — dose de
// tratamento vencido nunca nasce, mesmo antes deste job rodar.
// ============================================================

export async function concluirTratamentosVencidos() {
    try {
        const vencidos = await getTratamentosVencidos();
        if (vencidos.length === 0) return;

        console.log(`🏁 ${vencidos.length} tratamento(s) vencido(s) para concluir...`);

        for (const med of vencidos) {
            try {
                await concluirTratamento(med.id);

                const usuario = med.users;
                if (!usuario?.phone) continue;

                const firstName = usuario.name ? usuario.name.split(' ')[0] : 'você';
                const message = renderizarCanonico('conclusao_tratamento', { firstName, med });
                await enviarAoUsuario({
                    phone: usuario.phone,
                    userId: usuario.id ?? null,
                    texto: message,
                    origem: 'proativo:conclusao_tratamento',
                    // v47 §1: assunto registrado no ato do envio.
                    assuntos: [{ fato: 'conclusao_tratamento', medicationId: med.id }]
                });
                await registrarEventoProativo({
                    userId: usuario.id,
                    tipo: 'conclusao_tratamento',
                    medicationId: med.id
                });

                console.log(`🏁 Conclusão de tratamento enviada para ${usuario.phone} — ${med.nome}`);
                await sleep(1000);
            } catch (e) {
                console.error(`❌ Erro ao concluir tratamento ${med.id} (${med.nome}):`, e.message);
                await registrarEvento({
                    tipo: 'erro_tecnico',
                    severidade: 'alta',
                    origem: 'scheduler',
                    agent: 'scheduler',
                    titulo: tituloEstavel(e, 'Erro no scheduler (concluirTratamento)'),
                    payload: { message: e.message, stack: e.stack, funcao: 'concluirTratamentosVencidos', medication_id: med.id }
                });
            }
        }
    } catch (error) {
        console.error('❌ Erro ao verificar tratamentos vencidos:', error.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            origem: 'scheduler',
            agent: 'scheduler',
            titulo: tituloEstavel(error, 'Erro no scheduler (concluirTratamentosVencidos)'),
            payload: { message: error.message, stack: error.stack, funcao: 'concluirTratamentosVencidos' }
        });
    }
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
                enfileirar(reminder.phone, () => sendReminder(reminder), 'lembrete');
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
                    enfileirar(grupo[0].phone, () => sendReminder(grupo[0]), 'lembrete');
                } else {
                    enfileirar(grupo[0].phone, () => sendGroupedReminder(grupo), 'lembrete');
                }
                await sleep(1000);
            }
        }

        // Follow-ups de doses sem resposta
        await checkAndSendFollowUps();

    } catch (error) {
        console.error('❌ Erro no scheduler:', error.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            origem: 'scheduler',
            agent: 'scheduler',
            titulo: tituloEstavel(error, 'Erro no scheduler (checkAndSendReminders)'),
            payload: { message: error.message, stack: error.stack, funcao: 'checkAndSendReminders' }
        });
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
                enfileirar(grupo[0].phone, () => handleGroupedFollowUp(grupo), 'follow-up');
            }
            await sleep(1000);
        }
    } catch (error) {
        console.error('❌ Erro nos follow-ups:', error.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            origem: 'scheduler',
            agent: 'scheduler',
            titulo: tituloEstavel(error, 'Erro no scheduler (checkAndSendFollowUps)'),
            payload: { message: error.message, stack: error.stack, funcao: 'checkAndSendFollowUps' }
        });
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

        const message = renderizarCanonico('lembrete', { firstName, horario, grupo });

        // v44 §5.5 (corrige o gap MH-032): o envio agrupado passa pelo funil e as
        // N doses apontam para o registro do envio (funil_envio_id) — a citação da
        // mensagem agrupada volta a ser resolvível. zapi_message_id segue NULL nas
        // agrupadas: o vínculo do grupo é o funil, não o id solto.
        const { envioId } = await enviarAoUsuario({
            phone: primeiro.phone,
            userId: primeiro.user_id ?? null,
            texto: message,
            origem: 'proativo:lembrete'
        });

        const assuntos = [];
        for (const reminder of grupo) {
            const horarioAgendado = String(reminder.horario).substring(0, 5);
            const doseLog = await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                // zapiMessageId omitido de propósito (default null)
                horarioAgendado,
                scheduleId: reminder.schedule_id,
                funilEnvioId: envioId
            });
            await registrarEventoProativo({
                userId: reminder.user_id,
                tipo: 'lembrete',
                medicationId: reminder.medication_id,
                doseLogId: doseLog.id,
                horarioAgendado
            });
            assuntos.push({ fato: 'lembrete', doseLogId: doseLog.id, medicationId: reminder.medication_id });
        }
        // v47 §1: uma linha de assunto por dose do grupo. As doses nascem DEPOIS
        // do envio, por isso o registro é aqui e não no ato (mesma verdade).
        await registrarAssuntosDoEnvio(envioId, assuntos);

        const nomes = grupo.map(r => r.med_nome).join(', ');
        console.log(`✅ Lembrete agrupado (${grupo.length} doses: ${nomes}) enviado para ${primeiro.phone} — horário ${horario}`);
    } catch (error) {
        console.error(`❌ Erro ao enviar lembrete agrupado:`, error.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            origem: 'scheduler',
            agent: 'scheduler',
            titulo: tituloEstavel(error, 'Erro no scheduler (sendGroupedReminder)'),
            payload: { message: error.message, stack: error.stack, funcao: 'sendGroupedReminder' }
        });
    }
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

        // MH-081: omissão é POR ITEM — se 2 de 3 resolverem, os 2 exibem e o terceiro
        // fica só com o nome. Nunca assumir 1 para o item que não resolveu.
        const quantidadePorItem = new Map();
        for (const item of grupo) {
            let trecho = linhaQuantidadeDose({
                quantidade: item.quantidade_por_dose,
                unidade_dose: item.med_unidade_dose,
                forma_farmaceutica: item.med_forma
            }, { indentacao: '  ' });
            if (!trecho) {
                trecho = await degradar({
                    origem: 'lembrete',
                    motivo: 'quantidade_dose_indisponivel',
                    agent: 'scheduler',
                    userId: item.user_id ?? null,
                    detalhe: {
                        dose_log_id: item.id,
                        medication_id: item.medication_id,
                        schedule_id: item.schedule_id ?? null,
                        horario_agendado: item.horario_agendado ?? null,
                        agrupado: true
                    },
                    fallback: ''
                });
            }
            quantidadePorItem.set(item.id, trecho);
        }

        const message = renderizarCanonico('follow_up', { tentativa, firstName, horario, grupo, quantidadePorItem });
        // v44 §5.5 (MH-032): envio agrupado pelo funil; as doses do grupo apontam
        // para o registro do envio logo abaixo.
        const { envioId } = await enviarAoUsuario({
            phone: primeiro.phone,
            userId: primeiro.user_id ?? null,
            texto: message,
            origem: 'proativo:follow_up',
            // v47 §1: assunto registrado no ato do envio, uma linha por dose.
            assuntos: grupo.map(i => ({ fato: 'follow_up', doseLogId: i.id, medicationId: i.medication_id }))
        });
        await vincularDosesAoEnvio(grupo.map(i => i.id), envioId);

        // Atualiza estado individualmente por dose (tentativas), mas NÃO grava zapi_message_id
        // (doses agrupadas não usam o fast-path — ver briefing MH-032 complemento).
        for (const item of grupo) {
            const tentativaItem = (item.tentativas || 1) + 1;
            await updateDoseLogTentativa(item.id, tentativaItem);
            await registrarEventoProativo({
                userId: item.user_id,
                tipo: 'follow_up',
                medicationId: item.medication_id,
                doseLogId: item.id,
                tentativa: tentativaItem,
                horarioAgendado: item.horario_agendado ? String(item.horario_agendado).substring(0, 5) : null
            });
        }

        const nomes = grupo.map(i => i.med_nome).join(', ');
        console.log(`🔔 Follow-up agrupado tentativa ${tentativa} (${grupo.length} doses: ${nomes}) enviado para ${primeiro.phone}`);
    } catch (error) {
        console.error(`❌ Erro no follow-up agrupado:`, error.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            origem: 'scheduler',
            agent: 'scheduler',
            titulo: tituloEstavel(error, 'Erro no scheduler (handleGroupedFollowUp)'),
            payload: { message: error.message, stack: error.stack, funcao: 'handleGroupedFollowUp' }
        });
    }
}

// ============================================================
// ENVIA UM LEMBRETE INDIVIDUAL
// ============================================================

async function sendReminder(reminder) {
    try {
        const horarioAgendado = reminder.horario ? String(reminder.horario).substring(0, 5) : null;

        if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
            const firstName = reminder.user_name?.split(' ')[0] || 'você';
            const message = renderizarCanonico('alerta_estoque_zerado', { firstName, reminder });
            const { envioId } = await enviarAoUsuario({
                phone: reminder.phone,
                userId: reminder.user_id ?? null,
                texto: message,
                origem: 'proativo:alerta_estoque_zerado'
            });

            // Cria dose_log com status 'sem_estoque' para ativar deduplicação do scheduler
            // Sem isso, o stored procedure retorna o mesmo medicamento no próximo ciclo
            const doseLog = await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                status: 'sem_estoque',
                horarioAgendado,
                scheduleId: reminder.schedule_id,
                funilEnvioId: envioId
            });
            await registrarEventoProativo({
                userId: reminder.user_id,
                tipo: 'alerta_estoque_zerado',
                medicationId: reminder.medication_id,
                doseLogId: doseLog.id,
                horarioAgendado
            });
            // v47 §1: assunto do envio (a dose nasce depois do envio).
            await registrarAssuntosDoEnvio(envioId, [{ fato: 'alerta_estoque_zerado', doseLogId: doseLog.id, medicationId: reminder.medication_id }]);

            console.log(`📦 Aviso de estoque zerado enviado para ${reminder.phone} — ${reminder.med_nome}`);
            return;
        }

        const firstName = reminder.user_name
            ? reminder.user_name.split(' ')[0]
            : 'você';

        const message = renderizarCanonico('lembrete', { firstName, reminder });

        // BUG-029: capturar o ID da mensagem enviada — agora via funil (v44 §5.5).
        // T0 CONCLUÍDO (19/09, Guilherme no staging): o referenceMessageId da citação
        // é o messageId do envio, NUNCA o zaapId — por isso o legado prefere messageId
        // (gravar o zaapId primeiro era a causa raiz do BUG-029 nunca casar).
        const { envioId, zaapId, messageId } = await enviarAoUsuario({
            phone: reminder.phone,
            userId: reminder.user_id ?? null,
            texto: message,
            origem: 'proativo:lembrete'
        });
        const zapiMessageId = messageId || zaapId || null;

        const doseLog = await createDoseLog({
            medicationId: reminder.medication_id,
            scheduledAt: new Date().toISOString(),
            reminderSent: true,
            reminderSentAt: new Date().toISOString(),
            zapiMessageId,
            horarioAgendado,
            scheduleId: reminder.schedule_id,
            funilEnvioId: envioId
        });
        await registrarEventoProativo({
            userId: reminder.user_id,
            tipo: 'lembrete',
            medicationId: reminder.medication_id,
            doseLogId: doseLog.id,
            horarioAgendado
        });
        // v47 §1: assunto do envio (a dose nasce depois do envio).
        await registrarAssuntosDoEnvio(envioId, [{ fato: 'lembrete', doseLogId: doseLog.id, medicationId: reminder.medication_id }]);

        console.log(`✅ Lembrete enviado para ${reminder.phone} — ${reminder.med_nome}`);

    } catch (error) {
        console.error(`❌ Erro ao enviar lembrete para ${reminder.phone}:`, error.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            origem: 'scheduler',
            agent: 'scheduler',
            titulo: tituloEstavel(error, 'Erro no scheduler (sendReminder)'),
            payload: { message: error.message, stack: error.stack, funcao: 'sendReminder' }
        });
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
