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

// ============================================================
// MEDICAMENTOS
// ============================================================

export async function saveMedication({ userId, nome, dosagem, instrucoes, estoque }) {
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
            instrucoes,
            estoque_atual: estoque || 0,
            estoque_minimo: 7
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

// ============================================================
// REGISTRO DE DOSES
// ============================================================

export async function createDoseLog({ medicationId, scheduledAt, reminderSent, reminderSentAt }) {
    const { data, error } = await supabase
        .from('dose_logs')
        .insert({
            medication_id: medicationId,
            scheduled_at: scheduledAt,
            reminder_sent: reminderSent,
            reminder_sent_at: reminderSentAt
        })
        .select()
        .single();

    if (error) throw new Error(`Erro ao criar log de dose: ${error.message}`);
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
            taken_at: new Date().toISOString()
        })
        .eq('id', log.id);

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

    const { data, error } = await supabase
        .from('dose_logs')
        .select(`
      *,
      medications (nome, user_id)
    `)
        .gte('scheduled_at', since.toISOString())
        .eq('medications.user_id', userId)
        .order('scheduled_at', { ascending: false });

    if (error) return [];
    return data || [];
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