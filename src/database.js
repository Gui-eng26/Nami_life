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
            status: 'pendente'
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
            taken_at: new Date().toISOString(),
            status: 'confirmado'
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

export async function markAsNaoInformado(doseLogId) {
    const { error } = await supabase
        .from('dose_logs')
        .update({ status: 'nao_informado' })
        .eq('id', doseLogId);

    if (error) throw new Error(`Erro ao marcar nao_informado: ${error.message}`);
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

    const { data: tomadas } = await supabase
        .from('dose_logs')
        .select('*, medications(id, nome, user_id)')
        .eq('confirmed', true)
        .gte('taken_at', inicioDia.toISOString())
        .eq('medications.user_id', userId);

    const tomadasFiltradas = (tomadas || [])
        .filter(d => d.medications?.user_id === userId)
        .map(d => ({
            medication_id: d.medication_id,
            med_nome: d.medications.nome,
            taken_at: d.taken_at
        }));

    // Schedules ativos sem dose confirmada hoje
    const medications = await getUserMedications(userId);
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

        const esperado = schedulesAtivos * dias;
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

        const esperado = schedulesAtivos * dias;
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
// LOGS DE AGENTES
// ============================================================

export async function logAgentInteraction({ userId, agent, userMessage, agentResponse }) {
    const { error } = await supabase
        .from('agent_logs')
        .insert({
            user_id: userId,
            agent,
            user_message: userMessage,
            agent_response: agentResponse
        });

    if (error) console.error(`Erro ao salvar log de agente: ${error.message}`);
}