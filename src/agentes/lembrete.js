import { enviarAoUsuario } from '../funil.js';
import {
    updateDoseLogTentativa,
    updateDoseLogZapiMessageId,
    vincularDosesAoEnvio,
    markAsNaoInformado,
    getCaregivers,
    markCaregiverNotified,
    registrarEventoProativo
} from '../database.js';
// v47 Onda 2 (MH-100 C): este agente produz o FATO e pede a renderização ao
// catálogo — nenhum texto ao usuário vive aqui (grep-guard A68).
import { renderizarCanonico } from '../templates/catalogo.js';
import { linhaQuantidadeDose } from '../templates/dose.js';
import { degradar } from '../observabilidade.js';

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

        const message = renderizarCanonico('cuidador_follow_up_esgotado', { nomePaciente, remedio, horario });

        for (const entry of cuidadores) {
            const phoneCaregiver = entry.caregiver?.phone;
            if (!phoneCaregiver) continue;

            try {
                await enviarAoUsuario({
                    phone: phoneCaregiver,
                    userId: entry.caregiver?.id ?? null,
                    texto: message,
                    origem: 'cuidador:follow_up_esgotado'
                });
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
            // MH-081: a quantidade vem de dose_logs.schedule_id. Quando o vínculo é nulo
            // (recadastro do medicamento via replaceMedication apaga e recria os schedules,
            // e o FK é ON DELETE SET NULL), OMITIMOS o trecho em vez de assumir 1.
            // Assumir 1 afirmaria posologia que o sistema não pode sustentar (Princípio 49).
            let quantidade = linhaQuantidadeDose({
                quantidade: reminder.quantidade_por_dose,
                unidade_dose: reminder.med_unidade_dose,
                forma_farmaceutica: reminder.med_forma
            });
            if (!quantidade) {
                quantidade = await degradar({
                    origem: 'lembrete',
                    motivo: 'quantidade_dose_indisponivel',
                    agent: 'lembrete',
                    userId: reminder.user_id ?? null,
                    detalhe: {
                        dose_log_id: doseLog.id,
                        medication_id: doseLog.medication_id,
                        schedule_id: doseLog.schedule_id ?? null,
                        horario_agendado: doseLog.horario_agendado ?? null
                    },
                    fallback: ''
                });
            }

            const message = renderizarCanonico('follow_up', { tentativa, reminder, quantidade });
            // v44 §5.5: envio pelo funil. T0 CONCLUÍDO (19/09): a citação referencia o
            // messageId, nunca o zaapId — o legado zapi_message_id prefere messageId.
            const { envioId, zaapId, messageId } = await enviarAoUsuario({
                phone: reminder.phone,
                userId: reminder.user_id ?? null,
                texto: message,
                origem: 'proativo:follow_up',
                // v47 §1: assunto registrado no ato do envio.
                assuntos: [{ fato: 'follow_up', doseLogId: doseLog.id, medicationId: doseLog.medication_id }]
            });
            const zapiMessageId = messageId || zaapId || null;

            await updateDoseLogTentativa(doseLog.id, tentativa);

            // BUG-029: atualizar com o ID do follow-up mais recente para confirmação via "responder"
            if (zapiMessageId) {
                await updateDoseLogZapiMessageId(doseLog.id, zapiMessageId);
            }
            await vincularDosesAoEnvio([doseLog.id], envioId);
            await registrarEventoProativo({
                userId: reminder.user_id,
                tipo: 'follow_up',
                medicationId: doseLog.medication_id,
                doseLogId: doseLog.id,
                tentativa,
                horarioAgendado: doseLog.horario_agendado ? String(doseLog.horario_agendado).substring(0, 5) : null
            });

            console.log(`🔔 Follow-up tentativa ${tentativa} enviado para ${reminder.phone} — ${reminder.med_nome}`);
        } else {
            // 3 tentativas esgotadas — marca como não informado e avisa cuidadores.
            // v47 ajuste-referente §7 (BUG-117): "último aviso" é último — NENHUMA
            // 4ª mensagem depois dele. A antiga cobrança encerrada foi removida;
            // o silêncio é tratado pelo MH-104.
            await markAsNaoInformado(doseLog.id);
            console.log(`⚠️ Dose marcada como nao_informado (${doseLog.id}) — ${reminder.phone} — ${reminder.med_nome}`);
            await notificarCuidadores(doseLog, reminder);
        }
    } catch (error) {
        console.error(`❌ Erro no follow-up para ${reminder.phone}:`, error.message);
    }
}
