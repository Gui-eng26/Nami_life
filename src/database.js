import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import fetch from 'node-fetch';
global.fetch = fetch;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// USUÁRIOS
// ============================================================

export async function getOrCreateUser(phone) {
    // Tenta buscar usuário existente
    const { data: existing } = await supabase
        .from('users')
        .select('*')
        .eq('phone', phone)
        .single();

    if (existing) return existing;

    // Cria novo usuário
    const { data: newUser, error } = await supabase
        .from('users')
        .insert({ phone })
        .select()
        .single();

    if (error) throw new Error(`Erro ao criar usuário: ${error.message}`);
    return newUser;
}

export async function updateUserName(userId, name) {
    const { error } = await supabase
        .from('users')
        .update({ name, onboarded: true })
        .eq('id', userId);

    if (error) throw new Error(`Erro ao atualizar nome: ${error.message}`);
}

export async function updateUser(userId, fields) {
    const { error } = await supabase
        .from('users')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', userId);

    if (error) throw new Error(`Erro ao atualizar usuário: ${error.message}`);
}

// ============================================================
// ESTADO DA CONVERSA
// ============================================================

export async function getConversationState(userId) {
    const { data } = await supabase
        .from('conversation_state')
        .select('*')
        .eq('user_id', userId)
        .single();

    // Se não existe, retorna estado inicial
    return data || { state: 'idle', context: {} };
}

export async function updateConversationState(userId, state, context = {}) {
    const { error } = await supabase
        .from('conversation_state')
        .upsert({
            user_id: userId,
            state,
            context,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });

    if (error) throw new Error(`Erro ao atualizar estado: ${error.message}`);
}

export async function saveConversationState(userId, { state, context }) {
    return updateConversationState(userId, state, context);
}

// ============================================================
// MEDICAMENTOS
// ============================================================

export async function saveMedication({
    userId, nome, dosagem, instrucoes, estoque,
    forma, tipo_tratamento, tratamento_dias
}) {
    // Verifica se já existe medicamento com mesmo nome
    const { data: existing } = await supabase
        .from('medications')
        .select('id, nome, dosagem, estoque_atual')
        .eq('user_id', userId)
        .ilike('nome', nome)
        .eq('ativo', true)
        .maybeSingle();

    // Se existe, retorna o existente com flag de duplicata
    if (existing) {
        return { ...existing, isDuplicate: true };
    }

    // Se não existe, cria novo normalmente
    const { data, error } = await supabase
        .from('medications')
        .insert({
            user_id: userId,
            nome,
            dosagem,
            instrucoes: instrucoes || null,
            estoque_atual: estoque || 0,
            estoque_minimo: 7,
            forma_farmaceutica: forma || 'comprimido',
            tipo_tratamento: tipo_tratamento || 'continuo',
            tratamento_dias: tratamento_dias || null
        })
        .select()
        .single();

    if (error) throw new Error(`Erro ao salvar medicamento: ${error.message}`);
    return data;
}

export async function replaceMedication({ medicationId, dosagem, instrucoes, estoque, horarios }) {
    // Atualiza o medicamento existente
    const { data, error } = await supabase
        .from('medications')
        .update({ dosagem, instrucoes, estoque_atual: estoque || 0 })
        .eq('id', medicationId)
        .select()
        .single();

    if (error) throw new Error(`Erro ao substituir medicamento: ${error.message}`);

    // Apaga horários antigos e recria
    await supabase.from('schedules').delete().eq('medication_id', medicationId);

    if (horarios && horarios.length > 0) {
        for (let horario of horarios) {
            if (typeof horario === 'object') {
                horario = horario.horario || horario.hora || Object.values(horario)[0];
            }
            const horarioStr = String(horario).trim().substring(0, 5);
            await saveSchedule({ medicationId, horario: horarioStr });
        }
    }

    return data;
}

export async function verificarMedicamentoExistente(userId, nome) {
    const { data } = await supabase
        .from('medications')
        .select('id, nome, dosagem, estoque_atual, ativo, tipo_tratamento, tratamento_dias, schedules(id, horario, ativo)')
        .eq('user_id', userId)
        .ilike('nome', nome)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || null;
}

export async function getUserMedications(userId) {
    const { data, error } = await supabase
        .from('medications')
        .select(`
            *,
            schedules (id, horario, dias_semana, ativo)
        `)
        .eq('user_id', userId)
        .eq('ativo', true);

    if (error) throw new Error(`Erro ao buscar medicamentos: ${error.message}`);
    return data || [];
}

export async function updateMedicationStock(medicationId, novoEstoque) {
    const { error } = await supabase
        .from('medications')
        .update({ estoque_atual: novoEstoque })
        .eq('id', medicationId);

    if (error) throw new Error(`Erro ao atualizar estoque: ${error.message}`);
}

// ============================================================
// HORÁRIOS
// ============================================================

export async function saveSchedule({ medicationId, horario }) {
    const { error } = await supabase
        .from('schedules')
        .insert({
            medication_id: medicationId,
            horario
        });

    if (error) throw new Error(`Erro ao salvar horário: ${error.message}`);
}

// Busca o número de schedules ativos de um medicamento (= doses por dia)
export async function getMedicamentoDosesPerDia(medicationId) {
    const { data } = await supabase
        .from('schedules')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('ativo', true);
    return (data || []).length;
}

// ============================================================
// REGISTRO DE DOSES
// ============================================================

export async function createDoseLog({ medicationId, scheduledAt, reminderSent, reminderSentAt, zapiMessageId = null, status = 'pendente' }) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('dose_logs')
        .insert({
            medication_id: medicationId,
            scheduled_at: scheduledAt,
            reminder_sent: reminderSent,
            reminder_sent_at: reminderSentAt,
            tentativas: 1,
            ultima_tentativa_at: now,
            status: status,
            zapi_message_id: zapiMessageId
        })
        .select()
        .single();

    if (error) throw new Error(`Erro ao criar log de dose: ${error.message}`);
    console.log(`📝 DoseLog criado — tentativas: ${data.tentativas}, status: ${data.status}${zapiMessageId ? `, msgId: ${zapiMessageId}` : ''}`);
    return data;
}

export async function confirmDose(medicationId) {
    // Busca o log mais recente não confirmado
    const { data: log } = await supabase
        .from('dose_logs')
        .select('*')
        .eq('medication_id', medicationId)
        .eq('confirmed', false)
        .order('scheduled_at', { ascending: false })
        .limit(1)
        .single();

    if (!log) return;

    // Confirma a dose
    await supabase
        .from('dose_logs')
        .update({
            confirmed: true,
            taken_at: new Date().toISOString(),
            status: 'confirmado'
        })
        .eq('id', log.id);
    console.log(`✅ Dose confirmada — log id: ${log.id}`);

    // Decrementa o estoque
    const { data: med } = await supabase
        .from('medications')
        .select('estoque_atual')
        .eq('id', medicationId)
        .single();

    if (med && med.estoque_atual > 0) {
        await updateMedicationStock(medicationId, med.estoque_atual - 1);
    }
}

export async function getRecentDoses(userId, days = 3) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Busca IDs dos medicamentos do usuário primeiro (mesmo padrão do BUG-017)
    const { data: meds } = await supabase
        .from('medications')
        .select('id, nome')
        .eq('user_id', userId)
        .eq('ativo', true);

    if (!meds || meds.length === 0) return [];

    const medicationIds = meds.map(m => m.id);
    const medNomeMap = Object.fromEntries(meds.map(m => [m.id, m.nome]));

    const { data, error } = await supabase
        .from('dose_logs')
        .select('*')
        .in('medication_id', medicationIds)
        .gte('scheduled_at', since.toISOString())
        .order('scheduled_at', { ascending: false });

    if (error) return [];

    // Reconstrói o shape esperado pelos consumers (medications.nome e medications.user_id)
    return (data || []).map(d => ({
        ...d,
        medications: { nome: medNomeMap[d.medication_id], user_id: userId }
    }));
}

// ============================================================
// FOLLOW-UP DE DOSES (usado pelo agente_lembrete)
// ============================================================

export async function getPendingFollowUps() {
    // Retorna dose_logs pendentes com dados de medicamento, schedule e usuário
    const { data, error } = await supabase
        .from('dose_logs')
        .select(`
            *,
            medications (
                id, nome, dosagem, user_id,
                users (id, phone, name)
            )
        `)
        .eq('status', 'pendente')
        .eq('reminder_sent', true)
        .eq('confirmed', false)
        .not('ultima_tentativa_at', 'is', null);

    if (error) {
        console.error('Erro ao buscar follow-ups:', error.message);
        return [];
    }

    // Normaliza para facilitar o uso no agente
    return (data || []).map(log => ({
        ...log,
        med_nome: log.medications?.nome,
        med_dosagem: log.medications?.dosagem,
        user_id: log.medications?.user_id,
        phone: log.medications?.users?.phone,
        user_name: log.medications?.users?.name
    }));
}

export async function updateDoseLogTentativa(doseLogId, tentativas) {
    const { error } = await supabase
        .from('dose_logs')
        .update({
            tentativas,
            ultima_tentativa_at: new Date().toISOString()
        })
        .eq('id', doseLogId);

    if (error) throw new Error(`Erro ao atualizar tentativa: ${error.message}`);
}

export async function updateDoseLogZapiMessageId(doseLogId, zapiMessageId) {
    const { error } = await supabase
        .from('dose_logs')
        .update({ zapi_message_id: zapiMessageId })
        .eq('id', doseLogId);

    if (error) console.error(`⚠️ Erro ao atualizar zapi_message_id no dose_log: ${error.message}`);
}

export async function getDoseLogByZapiMessageId(zapiMessageId) {
    if (!zapiMessageId) return null;

    const { data, error } = await supabase
        .from('dose_logs')
        .select(`
            *,
            medications (id, nome, user_id)
        `)
        .eq('zapi_message_id', zapiMessageId)
        .eq('confirmed', false)
        .single();

    if (error || !data) return null;

    return {
        ...data,
        med_nome: data.medications?.nome
    };
}

export async function confirmDoseByLogId(doseLogId) {
    const { data: log, error: fetchError } = await supabase
        .from('dose_logs')
        .select('*, medications(id, nome, estoque_atual)')
        .eq('id', doseLogId)
        .single();

    if (fetchError || !log) throw new Error(`Dose log não encontrado: ${doseLogId}`);

    const { error: updateError } = await supabase
        .from('dose_logs')
        .update({
            confirmed: true,
            taken_at: new Date().toISOString(),
            status: 'confirmado'
        })
        .eq('id', doseLogId);

    if (updateError) throw new Error(`Erro ao confirmar dose: ${updateError.message}`);
    console.log(`✅ Dose confirmada por log id: ${doseLogId}`);

    const estoque = log.medications?.estoque_atual;
    if (estoque !== null && estoque > 0) {
        await updateMedicationStock(log.medication_id, estoque - 1);
    }
}

export async function markAsNaoInformado(doseLogId) {
    const { error } = await supabase
        .from('dose_logs')
        .update({ status: 'nao_informado' })
        .eq('id', doseLogId);

    if (error) throw new Error(`Erro ao marcar nao_informado: ${error.message}`);
}

export async function registrarNaoTomado(medicationId) {
    const { data: log, error: fetchError } = await supabase
        .from('dose_logs')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('status', 'pendente')
        .eq('confirmed', false)
        .order('scheduled_at', { ascending: false })
        .limit(1)
        .single();

    if (fetchError || !log) {
        console.log(`⚠️ Nenhum log pendente encontrado para registrarNaoTomado — medication: ${medicationId}`);
        return null;
    }

    const { error: updateError } = await supabase
        .from('dose_logs')
        .update({ status: 'nao_tomado' })
        .eq('id', log.id);

    if (updateError) throw new Error(`Erro ao registrar não tomado: ${updateError.message}`);
    console.log(`🚫 Dose registrada como nao_tomado — log id: ${log.id}`);
    return log.id;
}

// ============================================================
// CONFIGURAÇÃO DE MEDICAMENTOS
// ============================================================

export async function pausarMedicamento(medicationId) {
    const { error: errSched } = await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
    if (errSched) throw new Error(`Erro ao pausar schedules: ${errSched.message}`);

    // Cancela dose_logs pendentes — evita follow-ups após pausa
    const { error: errLogs } = await supabase
        .from('dose_logs')
        .update({ status: 'pausado' })
        .eq('medication_id', medicationId)
        .eq('status', 'pendente');
    if (errLogs) throw new Error(`Erro ao cancelar dose_logs pendentes: ${errLogs.message}`);

    console.log(`⏸️ Medicamento pausado — schedules desativados + dose_logs pendentes marcados como pausado — medication: ${medicationId}`);
}

export async function reativarMedicamento(medicationId) {
    const { error } = await supabase
        .from('schedules')
        .update({ ativo: true })
        .eq('medication_id', medicationId);
    if (error) throw new Error(`Erro ao reativar: ${error.message}`);
    console.log(`▶️ Schedules reativados — medication: ${medicationId}`);
}

export async function encerrarTratamento(medicationId) {
    const { error: errMed } = await supabase
        .from('medications')
        .update({ ativo: false })
        .eq('id', medicationId);
    if (errMed) throw new Error(`Erro ao encerrar: ${errMed.message}`);

    const { error: errSched } = await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
    if (errSched) throw new Error(`Erro ao desativar schedules: ${errSched.message}`);

    console.log(`🔴 Tratamento encerrado — medication: ${medicationId}`);
}

export async function removerSchedule(scheduleId, medicationId, horario) {
    const horaStr = String(horario).substring(0, 5);

    const { data: logsPendentes } = await supabase
        .from('dose_logs')
        .select('id, scheduled_at')
        .eq('medication_id', medicationId)
        .eq('status', 'pendente');

    const idsParaCancelar = (logsPendentes || [])
        .filter(log => {
            const horaLog = new Date(log.scheduled_at)
                .toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'America/Sao_Paulo'
                });
            return horaLog === horaStr;
        })
        .map(log => log.id);

    if (idsParaCancelar.length > 0) {
        const { error: errLogs } = await supabase
            .from('dose_logs')
            .update({ status: 'pausado' })
            .in('id', idsParaCancelar);
        if (errLogs) throw new Error(`Erro ao cancelar dose_logs: ${errLogs.message}`);
    }

    const { error } = await supabase
        .from('schedules')
        .delete()
        .eq('id', scheduleId);
    if (error) throw new Error(`Erro ao remover schedule: ${error.message}`);

    console.log(`🗑️ Schedule removido — id: ${scheduleId}, horario: ${horaStr}, dose_logs cancelados: ${idsParaCancelar.length}`);
}

export async function adicionarSchedule(medicationId, horario) {
    const horarioFormatado = horario.length === 5 ? `${horario}:00` : horario;
    const { data: existente } = await supabase
        .from('schedules')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('horario', horarioFormatado)
        .eq('ativo', true)
        .maybeSingle();

    if (existente) {
        throw new Error(`HORARIO_DUPLICADO: já existe lembrete ativo às ${horario}`);
    }

    const { error } = await supabase
        .from('schedules')
        .insert({ medication_id: medicationId, horario: horarioFormatado, ativo: true });
    if (error) throw new Error(`Erro ao adicionar schedule: ${error.message}`);

    console.log(`➕ Schedule adicionado — medication: ${medicationId}, horario: ${horarioFormatado}`);
}

export async function reativarComAtualizacao({ medicationId, estoque, tipo_tratamento, tratamento_dias, horarios, apenasHorarios = false }) {
    if (!apenasHorarios) {
        const { error: errMed } = await supabase
            .from('medications')
            .update({
                estoque_atual: estoque,
                tipo_tratamento,
                tratamento_dias: tratamento_dias || null,
                ativo: true
            })
            .eq('id', medicationId);
        if (errMed) throw new Error(`Erro ao atualizar medicamento: ${errMed.message}`);
    }

    const { error: errDel } = await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
    if (errDel) throw new Error(`Erro ao desativar schedules: ${errDel.message}`);

    for (const horario of horarios) {
        const horarioStr = String(horario).trim().substring(0, 5);
        const { error: errSched } = await supabase
            .from('schedules')
            .insert({ medication_id: medicationId, horario: `${horarioStr}:00`, ativo: true });
        if (errSched) throw new Error(`Erro ao criar schedule: ${errSched.message}`);
    }

    console.log(`▶️ Schedules redefinidos — medication: ${medicationId}, horarios: ${horarios.join(', ')}`);
}

export async function alterarHorarioSchedule(scheduleId, novoHorario) {
    const horarioFormatado = novoHorario.length === 5
        ? `${novoHorario}:00`
        : novoHorario;
    const { error } = await supabase
        .from('schedules')
        .update({ horario: horarioFormatado })
        .eq('id', scheduleId);
    if (error) throw new Error(`Erro ao alterar horário: ${error.message}`);
    console.log(`🕐 Horário alterado — schedule: ${scheduleId} → ${horarioFormatado}`);
}

export async function getCaregivers(userId) {
    const { data, error } = await supabase
        .from('care_network')
        .select(`
            *,
            caregiver:caregiver_id (id, phone, name)
        `)
        .eq('user_id', userId)
        .eq('status', 'active');

    if (error) {
        console.error('Erro ao buscar cuidadores:', error.message);
        return [];
    }
    return data || [];
}

export async function markCaregiverNotified(doseLogId) {
    const { error } = await supabase
        .from('dose_logs')
        .update({
            caregiver_notified: true,
            caregiver_notified_at: new Date().toISOString()
        })
        .eq('id', doseLogId);

    if (error) throw new Error(`Erro ao marcar cuidador notificado: ${error.message}`);
}

// ============================================================
// LEMBRETES PENDENTES (usado pelo scheduler)
// ============================================================

export async function getPendingReminders() {
    const { data, error } = await supabase
        .rpc('get_pending_reminders');

    if (error) {
        console.error('Erro ao buscar lembretes:', error.message);
        return [];
    }
    return data || [];
}

// ============================================================
// RELATÓRIOS — CONSULTAS DE HISTÓRICO E ADESÃO
// ============================================================

// Doses de hoje — separadas em tomadas e pendentes
export async function getDosesHoje(userId) {
    // Início do dia de hoje no fuso de Brasília convertido para UTC
    const agora = new Date();
    const inicioDia = new Date(
        agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
            .split('/')
            .reverse()
            .join('-') + 'T03:00:00.000Z' // BRT = UTC-3, então meia-noite BRT = 03:00 UTC
    );

    // Busca IDs dos medicamentos do usuário primeiro para filtrar corretamente
    const medications = await getUserMedications(userId);
    const medicationIds = medications.map(m => m.id);

    const { data: tomadas } = await supabase
        .from('dose_logs')
        .select('*, medications(id, nome)')
        .eq('confirmed', true)
        .in('medication_id', medicationIds)
        .gte('taken_at', inicioDia.toISOString());

    const tomadasFiltradas = (tomadas || []).map(d => ({
        medication_id: d.medication_id,
        med_nome: d.medications?.nome,
        taken_at: d.taken_at
    }));

    // Schedules ativos sem dose confirmada hoje
    const tomadosIds = tomadasFiltradas.map(d => d.medication_id);

    const pendentes = [];
    for (const med of medications) {
        if (!tomadosIds.includes(med.id)) {
            const schedules = (med.schedules || []).filter(s => s.ativo);
            if (schedules.length > 0) {
                pendentes.push({
                    medication_id: med.id,
                    med_nome: med.nome,
                    horario: schedules[0].horario
                });
            }
        }
    }

    return { tomadas: tomadasFiltradas, pendentes };
}

// Medicamentos ativos — alias semântico para getUserMedications
export async function getMedicamentosAtivos(userId) {
    return getUserMedications(userId);
}

// Estoque de todos os medicamentos ativos
export async function getEstoque(userId) {
    const { data } = await supabase
        .from('medications')
        .select('id, nome, estoque_atual, estoque_minimo, forma_farmaceutica')
        .eq('user_id', userId)
        .eq('ativo', true);
    return data || [];
}

// Próximos medicamentos com base no horário atual (fuso Brasília)
export async function getProximosMedicamentos(userId) {
    const horaAtual = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo'
    }); // "HH:MM"

    const medications = await getUserMedications(userId);
    const dosesHoje = await getDosesHoje(userId);
    const tomadosIds = dosesHoje.tomadas.map(d => d.medication_id);

    const passados = [];
    const agoraList = [];
    const proximos = [];

    for (const med of medications) {
        for (const schedule of (med.schedules || []).filter(s => s.ativo)) {
            const horario = schedule.horario.substring(0, 5);
            const confirmado = tomadosIds.includes(med.id);
            const diff = _minutesDiff(horaAtual, horario);

            if (diff < -120) {
                passados.push({ nome: med.nome, horario, confirmado });
            } else if (diff >= -120 && diff <= 30) {
                agoraList.push({ nome: med.nome, horario, confirmado });
            } else {
                proximos.push({ nome: med.nome, horario });
            }
        }
    }

    // Ordena cada lista por horário
    const byHorario = (a, b) => a.horario.localeCompare(b.horario);
    return {
        passados: passados.sort(byHorario),
        agora: agoraList.sort(byHorario),
        proximos: proximos.sort(byHorario)
    };
}

// Diferença em minutos entre horaAtual (HH:MM) e horarioAlvo (HH:MM)
// Positivo = alvo está no futuro; negativo = alvo está no passado
function _minutesDiff(horaAtual, horarioAlvo) {
    const [hA, mA] = horaAtual.split(':').map(Number);
    const [hT, mT] = horarioAlvo.split(':').map(Number);
    return (hT * 60 + mT) - (hA * 60 + mA);
}

// Adesão em um período (em dias) para um usuário
export async function getAdesaoPeriodo(userId, dias = 7) {
    const agora = new Date();
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);

    const medications = await getUserMedications(userId);

    let totalEsperado = 0;
    let totalConfirmado = 0;
    let piorMedicamento = null;
    let piorPercentual = 101; // começa acima de 100 para capturar o menor

    for (const med of medications) {
        const schedulesAtivos = (med.schedules || []).filter(s => s.ativo).length;
        if (schedulesAtivos === 0) continue;

        const medCriadoEm = new Date(med.created_at);
        const inicioEfetivo = medCriadoEm > desde ? medCriadoEm : desde;
        const diasEfetivos = Math.max(1, Math.ceil((agora - inicioEfetivo) / (1000 * 60 * 60 * 24)));
        const esperado = schedulesAtivos * diasEfetivos;
        totalEsperado += esperado;

        const { data: confirmadas } = await supabase
            .from('dose_logs')
            .select('id')
            .eq('medication_id', med.id)
            .eq('confirmed', true)
            .gte('taken_at', desde.toISOString());

        const confirmado = (confirmadas || []).length;
        totalConfirmado += confirmado;

        const pct = Math.round((confirmado / esperado) * 100);
        if (pct < piorPercentual) {
            piorPercentual = pct;
            piorMedicamento = med.nome;
        }
    }

    const percentual = totalEsperado > 0
        ? Math.round((totalConfirmado / totalEsperado) * 100)
        : 0;

    return { totalEsperado, totalConfirmado, percentual, piorMedicamento };
}

// Adesão detalhada por medicamento — usada no resumo semanal
// Retorna breakdown individual + totais gerais
export async function getAdesaoPorMedicamento(userId, dias = 7) {
    const agora = new Date();
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);

    const medications = await getUserMedications(userId);
    const estoque = await (async () => {
        const { data } = await supabase
            .from('medications')
            .select('id, estoque_atual, estoque_minimo')
            .eq('user_id', userId)
            .eq('ativo', true);
        return data || [];
    })();
    const estoqueMap = Object.fromEntries(estoque.map(m => [m.id, m]));

    let totalEsperado = 0;
    let totalConfirmado = 0;
    const porMedicamento = [];

    for (const med of medications) {
        const schedulesAtivos = (med.schedules || []).filter(s => s.ativo).length;
        if (schedulesAtivos === 0) continue;

        const medCriadoEm = new Date(med.created_at);
        const inicioEfetivo = medCriadoEm > desde ? medCriadoEm : desde;
        const diasEfetivos = Math.max(1, Math.ceil((agora - inicioEfetivo) / (1000 * 60 * 60 * 24)));
        const esperado = schedulesAtivos * diasEfetivos;
        totalEsperado += esperado;

        const { data: confirmadas } = await supabase
            .from('dose_logs')
            .select('id')
            .eq('medication_id', med.id)
            .eq('confirmed', true)
            .gte('taken_at', desde.toISOString());

        const confirmado = (confirmadas || []).length;
        const naoRegistrado = esperado - confirmado;
        totalConfirmado += confirmado;

        const percentual = Math.round((confirmado / esperado) * 100);
        const estoqueInfo = estoqueMap[med.id];

        porMedicamento.push({
            nome: med.nome,
            doses_esperadas: esperado,
            doses_tomadas: confirmado,
            doses_nao_registradas: naoRegistrado,
            percentual,
            estoque_atual: estoqueInfo?.estoque_atual ?? null,
            estoque_minimo: estoqueInfo?.estoque_minimo ?? 7,
            estoque_status: estoqueInfo
                ? (estoqueInfo.estoque_atual <= 0
                    ? 'critico'
                    : estoqueInfo.estoque_atual <= estoqueInfo.estoque_minimo
                        ? 'baixo'
                        : 'ok')
                : 'desconhecido'
        });
    }

    const percentualGeral = totalEsperado > 0
        ? Math.round((totalConfirmado / totalEsperado) * 100)
        : 0;

    return {
        porMedicamento,
        totalEsperado,
        totalConfirmado,
        totalNaoRegistrado: totalEsperado - totalConfirmado,
        percentualGeral
    };
}

// Buscar todos os usuários onboarded (para resumo semanal)
export async function getUsuariosAtivos() {
    const { data } = await supabase
        .from('users')
        .select('*')
        .eq('onboarded', true);
    return data || [];
}

// ============================================================
// ALERTA DE ESTOQUE — SUPORTE PÓS-CONFIRMAÇÃO
// ============================================================

// Retorna info de estoque do medicamento para decisão de alerta
export async function getEstoqueInfoParaAlerta(medicationId) {
    const { data: med } = await supabase
        .from('medications')
        .select('nome, estoque_atual, tipo_tratamento, tratamento_dias')
        .eq('id', medicationId)
        .single();

    if (!med) return null;

    const { data: schedules } = await supabase
        .from('schedules')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('ativo', true);

    const dosesPerDia = (schedules || []).length;
    if (dosesPerDia === 0) return null;

    const diasRestantes = Math.floor(med.estoque_atual / dosesPerDia);

    return {
        medNome: med.nome,
        novoEstoque: med.estoque_atual,
        dosesPerDia,
        diasRestantes,
        tipo_tratamento: med.tipo_tratamento || 'continuo',
        tratamento_dias: med.tratamento_dias || null
    };
}

// Conta confirmações de hoje para o medicamento (determina se é 1ª do dia)
export async function contarConfirmacoesHoje(medicationId) {
    const agora = new Date();
    const dataBRT = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const [dia, mes, ano] = dataBRT.split('/');
    const inicioDiaBRT = new Date(`${ano}-${mes}-${dia}T00:00:00-03:00`);

    const { data } = await supabase
        .from('dose_logs')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('confirmed', true)
        .gte('taken_at', inicioDiaBRT.toISOString());

    return (data || []).length;
}

// Decide se deve enviar alerta de estoque após confirmação
// Retorna false se não deve alertar, ou true se deve
export function calcularAlertaEstoque({ diasRestantes, tipo_tratamento, tratamento_dias, confirmacoesDoDia }) {
    // Agudo com tratamento curto (<=5 dias): ignora faixa 2-5, só alerta no último dia
    const limiteAlerta = (tipo_tratamento === 'agudo' && tratamento_dias && tratamento_dias <= 5)
        ? 1
        : 5;

    if (diasRestantes > limiteAlerta) return false;

    // diasRestantes = 0: alerta sempre (último comprimido tomado)
    if (diasRestantes === 0) return true;

    // diasRestantes 1-5 (ou 1 para agudo curto): só na 1ª confirmação do dia
    return confirmacoesDoDia <= 1;
}

// ============================================================
// PRÓXIMA DOSE — cálculo determinístico
// ============================================================

// Retorna o próximo horário de dose a partir de agora (timezone São Paulo).
// Se todos os horários já passaram hoje, retorna o primeiro de amanhã.
export function calcularProximaDose(schedulesAtivos, agora = new Date()) {
    if (!schedulesAtivos || schedulesAtivos.length === 0) return null;

    const horaAtualStr = agora.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo', hour12: false
    });
    const [hAtual, mAtual] = horaAtualStr.split(':').map(Number);
    const minutosAgora = hAtual * 60 + mAtual;

    const horariosMinutos = schedulesAtivos
        .map(s => {
            const [h, m] = s.horario.substring(0, 5).split(':').map(Number);
            return { horario: s.horario.substring(0, 5), minutos: h * 60 + m };
        })
        .sort((a, b) => a.minutos - b.minutos);

    const proximoHoje = horariosMinutos.find(h => h.minutos > minutosAgora);
    if (proximoHoje) return { horario: proximoHoje.horario, quando: 'hoje' };

    return { horario: horariosMinutos[0].horario, quando: 'amanhã' };
}

// ============================================================
// LOGS DE AGENTES
// ============================================================

export async function logAgentInteraction({ userId, agent, userMessage, agentResponse, estadoConversa = null, contextoConversa = null }) {
    const { error } = await supabase
        .from('agent_logs')
        .insert({
            user_id: userId,
            agent,
            user_message: userMessage,
            agent_response: agentResponse,
            estado_conversa: estadoConversa,
            contexto_conversa: contextoConversa
        });

    if (error) console.error(`Erro ao salvar log de agente: ${error.message}`);
}

// ============================================================
// HISTÓRICO RECENTE — para classificador LLM do roteador
// ============================================================

export async function getHistoricoRecente(userId, limite = 3) {
    const { data, error } = await supabase
        .from('agent_logs')
        .select('user_message, agent_response, agent, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limite);

    if (error) {
        console.error('Erro ao buscar histórico recente:', error.message);
        return [];
    }

    // Retorna em ordem cronológica (mais antigo primeiro) para o prompt fazer sentido
    return (data || []).reverse();
}

// Formata o histórico conversacional para inclusão em prompts LLM
export function formatarHistoricoConversa(historicoConversa) {
    if (!historicoConversa || historicoConversa.length === 0) {
        return 'Sem conversa anterior recente.';
    }
    return historicoConversa
        .map(h => `Usuário: ${h.user_message}\nNami: ${h.agent_response}`)
        .join('\n\n');
}

export async function registrarIntencaoNaoSuportada(userId, mensagem) {
    const { error } = await supabase
        .from('intencoes_nao_suportadas')
        .insert({ user_id: userId, mensagem, created_at: new Date().toISOString() });
    if (error) console.error(`⚠️ Erro ao registrar intenção não suportada: ${error.message}`);
    else console.log(`📋 Intenção não suportada registrada: "${mensagem}"`);
}