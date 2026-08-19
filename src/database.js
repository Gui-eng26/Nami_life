import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import fetch from 'node-fetch';
import { registrarEvento, degradar } from './observabilidade.js';
import { janelaDiaBRT, hojeBRT } from './dataReferencia.js';
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

// MH-020: exclusão de conta a pedido explícito do usuário (LGPD).
// Chama a função SQL atômica delete_user_account (ordem de deleção + transação
// tudo-ou-nada). Único ponto de exclusão de conta no código (princípio 16).
export async function excluirContaUsuario(userId) {
    const { error } = await supabase.rpc('delete_user_account', { p_user_id: userId });
    if (error) throw new Error(`Erro ao excluir conta: ${error.message}`);
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

// tratamento_fim é sempre recalculada a partir de agora — na criação (~= created_at)
// e na reativação (reinicia o relógio do tratamento). Fonte da verdade para
// calcularProgressoTratamento; null para tratamento contínuo ou sem tratamento_dias.
function calcularTratamentoFim(tipo_tratamento, tratamento_dias) {
    if (!tratamento_dias || tipo_tratamento === 'continuo' || !tipo_tratamento) return null;
    const fim = new Date();
    fim.setDate(fim.getDate() + tratamento_dias);
    return fim.toISOString().split('T')[0];
}

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

    // Se não existe, cria novo normalmente (estoque nasce em 0; o valor informado
    // é aplicado logo em seguida via registrarMovimentoEstoque, para gerar o
    // movimento cadastro_inicial com estoque_anterior = 0)
    const { data, error } = await supabase
        .from('medications')
        .insert({
            user_id: userId,
            nome,
            dosagem,
            instrucoes: instrucoes || null,
            estoque_atual: 0,
            estoque_minimo: 7,
            forma_farmaceutica: forma || 'comprimido',
            tipo_tratamento: tipo_tratamento || 'continuo',
            tratamento_dias: tratamento_dias || null,
            tratamento_fim: calcularTratamentoFim(tipo_tratamento, tratamento_dias)
        })
        .select()
        .single();

    if (error) throw new Error(`Erro ao salvar medicamento: ${error.message}`);

    const { estoqueNovo } = await registrarMovimentoEstoque({
        medicationId: data.id,
        tipo: 'cadastro_inicial',
        origem: 'manual',
        valorAbsoluto: estoque || 0
    });

    return { ...data, estoque_atual: estoqueNovo };
}

export async function replaceMedication({ medicationId, dosagem, instrucoes, estoque, horarios }) {
    // Atualiza o medicamento existente (estoque é tratado à parte, via registrarMovimentoEstoque)
    const { data, error } = await supabase
        .from('medications')
        .update({ dosagem, instrucoes })
        .eq('id', medicationId)
        .select()
        .single();

    if (error) throw new Error(`Erro ao substituir medicamento: ${error.message}`);

    const { estoqueNovo } = await registrarMovimentoEstoque({
        medicationId,
        tipo: 'cadastro_substituicao',
        origem: 'manual',
        valorAbsoluto: estoque || 0
    });
    data.estoque_atual = estoqueNovo;

    // MH-073: preserva quantidade_por_dose antes de recriar os horários — sem isso,
    // uma substituição de cadastro zeraria a posologia silenciosamente.
    const { data: schedulesAntigos } = await supabase
        .from('schedules')
        .select('horario, quantidade_por_dose')
        .eq('medication_id', medicationId);

    const quantidadePorHorario = new Map(
        (schedulesAntigos || []).map(s => [
            String(s.horario).substring(0, 5),
            Number(s.quantidade_por_dose)
        ])
    );
    const quantidadesDistintas = [...new Set(quantidadePorHorario.values())];
    const quantidadePadrao = quantidadesDistintas.length === 1 ? quantidadesDistintas[0] : 1;

    // Apaga horários antigos e recria
    await supabase.from('schedules').delete().eq('medication_id', medicationId);

    if (horarios && horarios.length > 0) {
        for (let horario of horarios) {
            if (typeof horario === 'object') {
                horario = horario.horario || horario.hora || Object.values(horario)[0];
            }
            const horarioStr = String(horario).trim().substring(0, 5);
            await saveSchedule({
                medicationId,
                horario: horarioStr,
                quantidadePorDose: quantidadePorHorario.get(horarioStr) ?? quantidadePadrao
            });
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
            schedules (id, horario, dias_semana, ativo, quantidade_por_dose)
        `)
        .eq('user_id', userId)
        .eq('ativo', true);

    if (error) throw new Error(`Erro ao buscar medicamentos: ${error.message}`);
    return data || [];
}

// Único ponto de escrita em estoque — toda mudança em medications.estoque_atual
// passa por aqui e gera uma linha em stock_movements (MH-042).
//
// Risco de inconsistência: a atualização em `medications` e o insert em `stock_movements`
// não são atômicos (a Supabase JS SDK não expõe transação client-side). Se o insert em
// stock_movements falhar após o update em medications, o estoque muda mas o movimento
// não fica registrado. Aceito por ora — mover para uma stored procedure (rpc, no padrão
// de get_pending_reminders) é a evolução natural caso isso vire problema real.
export async function registrarMovimentoEstoque({
    medicationId, tipo, origem, motivo = null, doseLogId = null,
    delta = null,        // use quando o movimento é um incremento/decremento conhecido
    valorAbsoluto = null // use quando o movimento é "setar para X" (recontagem, cadastro)
}) {
    const { data: med, error: fetchError } = await supabase
        .from('medications')
        .select('estoque_atual')
        .eq('id', medicationId)
        .single();

    if (fetchError || !med) throw new Error(`Medicamento não encontrado: ${medicationId}`);

    const estoqueAnterior = med.estoque_atual ?? 0;
    let estoqueNovo;
    let deltaAplicado;

    if (valorAbsoluto !== null) {
        estoqueNovo = Math.max(0, valorAbsoluto);
        deltaAplicado = estoqueNovo - estoqueAnterior;
    } else {
        estoqueNovo = Math.max(0, estoqueAnterior + delta);
        deltaAplicado = estoqueNovo - estoqueAnterior; // já reflete o clamp em 0
    }

    const { error: updateError } = await supabase
        .from('medications')
        .update({ estoque_atual: estoqueNovo })
        .eq('id', medicationId);

    if (updateError) throw new Error(`Erro ao atualizar estoque: ${updateError.message}`);

    const { error: logError } = await supabase
        .from('stock_movements')
        .insert({
            medication_id: medicationId,
            tipo,
            origem,
            quantidade_delta: deltaAplicado,
            estoque_anterior: estoqueAnterior,
            estoque_novo: estoqueNovo,
            motivo,
            dose_log_id: doseLogId
        });

    if (logError) throw new Error(`Erro ao registrar movimento de estoque: ${logError.message}`);

    console.log(`📦 Movimento de estoque — tipo: ${tipo}, medication: ${medicationId}, ${estoqueAnterior} → ${estoqueNovo}`);

    return { estoqueAnterior, estoqueNovo, deltaAplicado };
}

// ============================================================
// HORÁRIOS
// ============================================================

export async function saveSchedule({ medicationId, horario, quantidadePorDose = 1 }) {
    const { error } = await supabase
        .from('schedules')
        .insert({
            medication_id: medicationId,
            horario,
            quantidade_por_dose: quantidadePorDose
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

export async function createDoseLog({
    medicationId, scheduledAt, reminderSent, reminderSentAt,
    zapiMessageId = null, status = 'pendente',
    horarioAgendado = null, scheduleId = null
}) {
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
            zapi_message_id: zapiMessageId,
            horario_agendado: horarioAgendado,
            schedule_id: scheduleId
        })
        .select()
        .single();

    if (error) throw new Error(`Erro ao criar log de dose: ${error.message}`);
    console.log(`📝 DoseLog criado — tentativas: ${data.tentativas}, status: ${data.status}${horarioAgendado ? `, horario: ${horarioAgendado}` : ''}`);
    return data;
}

// ============================================================
// MH-073 Parte A — QUANTIDADE POR DOSE E CONVERSÃO PARA ESTOQUE
// ============================================================

// Resolve quantas unidades_dose uma dose representa, na ordem de confiabilidade
// da evidência disponível. NUNCA infere: cada degrau é uma fonte determinística,
// e o degrau final registra system_event em vez de chutar silenciosamente.
//
// 1. dose_logs.schedule_id  → fonte da verdade (doses criadas a partir da Parte A)
// 2. dose_logs.horario_agendado casando com EXATAMENTE 1 schedule ativo
// 3. todos os schedules ativos do medicamento têm a mesma quantidade → usa ela
// 4. ambíguo → retorna 1 e registra degradação visível
export async function resolverQuantidadePorDose(doseLog) {
    const medicationId = doseLog.medication_id;

    // Degrau 1 — vínculo direto
    if (doseLog.schedule_id) {
        const { data: sched } = await supabase
            .from('schedules')
            .select('quantidade_por_dose')
            .eq('id', doseLog.schedule_id)
            .maybeSingle();
        if (sched) return Number(sched.quantidade_por_dose);
    }

    const { data: schedules } = await supabase
        .from('schedules')
        .select('id, horario, quantidade_por_dose')
        .eq('medication_id', medicationId)
        .eq('ativo', true);

    const lista = schedules || [];
    if (lista.length === 0) return 1;

    // Degrau 2 — casamento por horário agendado, apenas se não ambíguo
    if (doseLog.horario_agendado) {
        const alvo = String(doseLog.horario_agendado).substring(0, 5);
        const casados = lista.filter(s => String(s.horario).substring(0, 5) === alvo);
        if (casados.length === 1) return Number(casados[0].quantidade_por_dose);
    }

    // Degrau 3 — quantidade uniforme entre todos os horários
    const distintas = [...new Set(lista.map(s => Number(s.quantidade_por_dose)))];
    if (distintas.length === 1) return distintas[0];

    // Degrau 4 — ambíguo: não chuta em silêncio
    await registrarEvento({
        tipo: 'degradacao_silenciosa',
        severidade: 'media',
        origem: 'database',
        agent: 'database',
        titulo: 'Quantidade por dose ambígua — fallback para 1',
        payload: {
            funcao: 'resolverQuantidadePorDose',
            dose_log_id: doseLog.id,
            medication_id: medicationId,
            schedule_id: doseLog.schedule_id ?? null,
            horario_agendado: doseLog.horario_agendado ?? null,
            quantidades_distintas: distintas
        }
    });
    return 1;
}

// Converte a quantidade de uma dose para a unidade em que o estoque é contado.
// Âncora definida na v33: gotas_por_ml é a ponte entre dose em gotas e estoque em ml.
// Em Parte A todos os medicamentos são unidade→unidade, então esta função é
// identidade na prática; existe para que as Partes B–E não precisem tocar o núcleo.
export function converterDoseParaEstoque({ quantidade, unidade_dose, unidade_estoque, gotas_por_ml }) {
    if (unidade_dose === 'gota' && unidade_estoque === 'ml') {
        const fator = Number(gotas_por_ml) || 20;
        return quantidade / fator;
    }
    return quantidade;
}

// Quantidade a debitar do estoque por uma dose confirmada, já na unidade de estoque.
export async function calcularDeltaEstoqueDaDose(doseLog) {
    const quantidade = await resolverQuantidadePorDose(doseLog);

    const { data: med } = await supabase
        .from('medications')
        .select('unidade_dose, unidade_estoque, gotas_por_ml')
        .eq('id', doseLog.medication_id)
        .single();

    if (!med) return quantidade;

    return converterDoseParaEstoque({
        quantidade,
        unidade_dose: med.unidade_dose,
        unidade_estoque: med.unidade_estoque,
        gotas_por_ml: med.gotas_por_ml
    });
}

// Consumo diário total do medicamento, na unidade de estoque — soma de todos os
// horários ativos. Substitui a contagem de schedules como proxy de consumo.
export async function calcularConsumoDiario(medicationId) {
    const { data: med } = await supabase
        .from('medications')
        .select('unidade_dose, unidade_estoque, gotas_por_ml')
        .eq('id', medicationId)
        .single();

    const { data: schedules } = await supabase
        .from('schedules')
        .select('quantidade_por_dose')
        .eq('medication_id', medicationId)
        .eq('ativo', true);

    const lista = schedules || [];
    if (!med || lista.length === 0) return { consumoDiario: 0, dosesPerDia: 0 };

    const somaDoses = lista.reduce((acc, s) => acc + Number(s.quantidade_por_dose), 0);

    return {
        consumoDiario: converterDoseParaEstoque({
            quantidade: somaDoses,
            unidade_dose: med.unidade_dose,
            unidade_estoque: med.unidade_estoque,
            gotas_por_ml: med.gotas_por_ml
        }),
        dosesPerDia: lista.length
    };
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

    // Decrementa o estoque (MH-073: quantidade vem da posologia, não é mais fixa em 1)
    const deltaDose = await calcularDeltaEstoqueDaDose(log);
    await registrarMovimentoEstoque({
        medicationId,
        tipo: 'dose_confirmada',
        origem: 'automatico',
        delta: -deltaDose,
        doseLogId: log.id
    });
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

    if (error) {
        console.error(`⚠️ Erro ao atualizar zapi_message_id no dose_log: ${error.message}`);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'media',
            agent: 'database',
            origem: 'outro',
            titulo: 'Falha ao atualizar zapi_message_id no dose_log',
            payload: { message: error.message, doseLogId }
        });
    }
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

    const deltaDose = await calcularDeltaEstoqueDaDose(log);
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_confirmada',
        origem: 'automatico',
        delta: -deltaDose,
        doseLogId
    });

    return log.medication_id;
}

export async function markAsNaoInformado(doseLogId) {
    const { error } = await supabase
        .from('dose_logs')
        .update({ status: 'nao_informado' })
        .eq('id', doseLogId);

    if (error) throw new Error(`Erro ao marcar nao_informado: ${error.message}`);
}

export async function registrarNaoTomado(medicationId, doseLogId = null) {
    // Caso retroativo: dose específica por ID
    if (doseLogId) {
        const { data: log, error: fetchError } = await supabase
            .from('dose_logs')
            .select('id, status')
            .eq('id', doseLogId)
            .single();

        if (fetchError || !log) {
            console.log(`⚠️ Dose log não encontrado para registrarNaoTomado — id: ${doseLogId}`);
            return null;
        }

        const eraRetroativo = log.status !== 'pendente';
        const agora = new Date().toISOString();

        const { error } = await supabase
            .from('dose_logs')
            .update({
                status: 'nao_tomado',
                ...(eraRetroativo && {
                    revertido: true,
                    revertido_at: agora,
                    revertido_de: log.status,
                    revertido_motivo: 'usuário confirmou que não tomou'
                })
            })
            .eq('id', doseLogId);

        if (error) throw new Error(`Erro ao registrar nao_tomado retroativo: ${error.message}`);
        console.log(`🚫 Dose registrada como nao_tomado — log id: ${doseLogId}${eraRetroativo ? ' (retroativo)' : ''}`);
        return doseLogId;
    }

    // Caso normal: busca dose pendente mais recente por medicationId
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

export async function getDosesRetroativas(userId, dias = 2) {
    const since = new Date();
    since.setDate(since.getDate() - dias);

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
        .eq('status', 'nao_informado')
        .gte('scheduled_at', since.toISOString())
        .order('scheduled_at', { ascending: false });

    if (error) {
        console.error('Erro ao buscar doses retroativas:', error.message);
        return [];
    }

    return (data || []).map(d => ({
        ...d,
        medications: { nome: medNomeMap[d.medication_id], user_id: userId }
    }));
}

export async function getDosesConfirmadasHoje(userId) {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

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
        .eq('status', 'confirmado')
        .gte('taken_at', hoje.toISOString())
        .order('taken_at', { ascending: false });

    if (error) {
        console.error('Erro ao buscar doses confirmadas hoje:', error.message);
        return [];
    }

    return (data || []).map(d => ({
        ...d,
        medications: { nome: medNomeMap[d.medication_id], user_id: userId }
    }));
}

export async function confirmarDoseRetroativa(doseLogId, motivo) {
    const { data: log, error: fetchError } = await supabase
        .from('dose_logs')
        .select('*, medications(id, nome, estoque_atual)')
        .eq('id', doseLogId)
        .single();

    if (fetchError || !log) throw new Error(`Dose log não encontrado: ${doseLogId}`);
    if (log.status !== 'nao_informado') throw new Error(`Dose não está em nao_informado: ${log.status}`);

    const agora = new Date().toISOString();

    const { error: updateError } = await supabase
        .from('dose_logs')
        .update({
            status: 'confirmado',
            confirmed: true,
            taken_at: agora,
            revertido: true,
            revertido_at: agora,
            revertido_de: 'nao_informado',
            revertido_motivo: motivo || 'confirmação retroativa pelo usuário'
        })
        .eq('id', doseLogId);

    if (updateError) throw new Error(`Erro ao confirmar dose retroativa: ${updateError.message}`);
    console.log(`⏪ Dose confirmada retroativamente — log id: ${doseLogId}`);

    const deltaDose = await calcularDeltaEstoqueDaDose(log);
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_retroativa',
        origem: 'automatico',
        delta: -deltaDose,
        doseLogId
    });

    return log.medication_id;
}

export async function reverterConfirmacao(doseLogId, motivo) {
    const { data: log, error: fetchError } = await supabase
        .from('dose_logs')
        .select('*, medications(id, nome, estoque_atual)')
        .eq('id', doseLogId)
        .single();

    if (fetchError || !log) throw new Error(`Dose log não encontrado: ${doseLogId}`);
    if (log.status !== 'confirmado') throw new Error(`Dose não está confirmada: ${log.status}`);

    const novoStatus = (log.tentativas < 3) ? 'pendente' : 'nao_tomado';
    const agora = new Date().toISOString();

    const { error: updateError } = await supabase
        .from('dose_logs')
        .update({
            status: novoStatus,
            confirmed: false,
            taken_at: null,
            revertido: true,
            revertido_at: agora,
            revertido_de: 'confirmado',
            revertido_motivo: motivo || 'reversão solicitada pelo usuário'
        })
        .eq('id', doseLogId);

    if (updateError) throw new Error(`Erro ao reverter confirmação: ${updateError.message}`);
    console.log(`↩️ Confirmação revertida — log id: ${doseLogId}, novo status: ${novoStatus}`);

    const deltaDose = await calcularDeltaEstoqueDaDose(log);
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_revertida',
        origem: 'automatico',
        delta: deltaDose,
        doseLogId
    });

    return { medicationId: log.medication_id, novoStatus };
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

    // MH-073: herda a quantidade_por_dose dos demais horários do medicamento quando
    // ela for uniforme; caso contrário, não há como inferir e usa 1.
    const { data: schedulesAtuais } = await supabase
        .from('schedules')
        .select('quantidade_por_dose')
        .eq('medication_id', medicationId)
        .eq('ativo', true);

    const quantidadesDistintas = [...new Set((schedulesAtuais || []).map(s => Number(s.quantidade_por_dose)))];
    const quantidadePorDose = quantidadesDistintas.length === 1 ? quantidadesDistintas[0] : 1;

    const { error } = await supabase
        .from('schedules')
        .insert({ medication_id: medicationId, horario: horarioFormatado, ativo: true, quantidade_por_dose: quantidadePorDose });
    if (error) throw new Error(`Erro ao adicionar schedule: ${error.message}`);

    console.log(`➕ Schedule adicionado — medication: ${medicationId}, horario: ${horarioFormatado}`);
}

export async function reativarComAtualizacao({ medicationId, estoque, tipo_tratamento, tratamento_dias, horarios, apenasHorarios = false }) {
    // MH-073: preserva quantidade_por_dose antes de desativar os horários antigos —
    // mesma blindagem de replaceMedication (seção 5.6 do briefing).
    const { data: schedulesAntigos } = await supabase
        .from('schedules')
        .select('horario, quantidade_por_dose')
        .eq('medication_id', medicationId);

    const quantidadePorHorario = new Map(
        (schedulesAntigos || []).map(s => [
            String(s.horario).substring(0, 5),
            Number(s.quantidade_por_dose)
        ])
    );
    const quantidadesDistintas = [...new Set(quantidadePorHorario.values())];
    const quantidadePadrao = quantidadesDistintas.length === 1 ? quantidadesDistintas[0] : 1;

    if (!apenasHorarios) {
        const { error: errMed } = await supabase
            .from('medications')
            .update({
                tipo_tratamento,
                tratamento_dias: tratamento_dias || null,
                tratamento_fim: calcularTratamentoFim(tipo_tratamento, tratamento_dias),
                ativo: true
            })
            .eq('id', medicationId);
        if (errMed) throw new Error(`Erro ao atualizar medicamento: ${errMed.message}`);

        await registrarMovimentoEstoque({
            medicationId,
            tipo: 'reativacao_com_estoque',
            origem: 'manual',
            valorAbsoluto: estoque || 0
        });
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
            .insert({
                medication_id: medicationId,
                horario: `${horarioStr}:00`,
                ativo: true,
                quantidade_por_dose: quantidadePorHorario.get(horarioStr) ?? quantidadePadrao
            });
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

// ============================================================
// BALANÇO DO DIA (v25) — doses de um dia, filtradas por scheduled_at (dia DEVIDO).
// Substitui getDosesHoje no fluxo de relatório. NUNCA filtra por taken_at: uma dose
// de ontem confirmada hoje pertence a ONTEM (mesma regra já aplicada em calcularAdesao
// desde a v15). Sem janela fixa de dias e sem corte de registros.
// ============================================================
export async function getDosesDoDia(userId, dataISO, medicationId = null) {
    const { inicio, fim } = janelaDiaBRT(dataISO);

    const { data: meds } = await supabase
        .from('medications')
        .select('id, nome')
        .eq('user_id', userId)
        .eq('ativo', true);

    if (!meds || meds.length === 0) return [];

    const medNomeMap = Object.fromEntries(meds.map(m => [m.id, m.nome]));
    const medicationIds = medicationId ? [medicationId] : meds.map(m => m.id);

    const { data, error } = await supabase
        .from('dose_logs')
        .select('id, medication_id, scheduled_at, horario_agendado, status, confirmed, taken_at, reminder_sent')
        .in('medication_id', medicationIds)
        .gte('scheduled_at', inicio)
        .lte('scheduled_at', fim)
        .order('scheduled_at', { ascending: true });

    if (error) {
        console.error('Erro ao buscar doses do dia:', error.message);
        return [];
    }

    const doses = (data || []).map(d => ({
        id: d.id,
        medicationId: d.medication_id,
        nome: medNomeMap[d.medication_id] || 'medicamento',
        horario: d.horario_agendado
            ? String(d.horario_agendado).substring(0, 5)
            : new Date(d.scheduled_at).toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            }),
        scheduledAt: d.scheduled_at,
        status: d.status,
        confirmado: d.confirmed === true,
        takenAt: d.taken_at,
        confirmadaRetroativamente: d.confirmed === true && d.taken_at
            ? new Date(d.taken_at).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) !== dataISO
            : false,
        horarioJaPassou: true
    }));

    // A linha em dose_logs só nasce quando o scheduler envia o lembrete (~2 min antes do
    // horário). Doses futuras do dia de hoje, portanto, ainda não existem no banco (C-2, v25).
    // Complementamos com os horários cadastrados que ainda não têm linha.
    // Apenas para HOJE: em dias passados não há como saber quais horários estavam vigentes.
    if (dataISO !== hojeBRT()) return doses;

    const { data: schedules } = await supabase
        .from('schedules')
        .select('medication_id, horario')
        .in('medication_id', medicationIds)
        .eq('ativo', true);

    const agoraHHMM = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
    });

    const jaTemLinha = new Set(doses.map(d => `${d.medicationId}|${d.horario}`));

    for (const s of (schedules || [])) {
        const horario = String(s.horario).substring(0, 5);
        const chave = `${s.medication_id}|${horario}`;
        if (jaTemLinha.has(chave)) continue;

        doses.push({
            id: null,
            medicationId: s.medication_id,
            nome: medNomeMap[s.medication_id] || 'medicamento',
            horario,
            scheduledAt: null,
            status: 'agendado',           // status sintético — não existe em dose_logs
            confirmado: false,
            takenAt: null,
            confirmadaRetroativamente: false,
            horarioJaPassou: horario <= agoraHHMM
        });
    }

    return doses.sort((a, b) => a.horario.localeCompare(b.horario));
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
        .eq('ativo', true)
        // A-1 (v25): ordem por unidades crescente — o que está acabando aparece primeiro.
        // Substitui a ordem alfabética do briefing anterior. Aproximação consciente:
        // a ordem correta é por DIAS DE COBERTURA (estoque ÷ doses por dia), tratada no MH-60.
        // Desempate por nome para manter a ordem estável entre chamadas (motivo do N-4).
        .order('estoque_atual', { ascending: true })
        .order('nome', { ascending: true });
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

    // N-2 (v25): usa getDosesDoDia em vez de getDosesHoje. Três defeitos corrigidos de uma vez:
    // (a) getDosesHoje filtrava por taken_at, então confirmação retroativa de ontem marcava
    //     doses de hoje como tomadas (mesma raiz do BUG-70);
    // (b) a confirmação era resolvida por medicamento, não por dose/horário;
    // (c) o relatório contradizia o balanco_do_dia sobre o mesmo dado.
    // A chave de casamento é medicationId + horario.
    const dosesHoje = await getDosesDoDia(userId, hojeBRT());
    const confirmadasPorDose = new Set(
        dosesHoje.filter(d => d.status === 'confirmado')
                 .map(d => `${d.medicationId}|${d.horario}`)
    );

    const passados = [];
    const agoraList = [];
    const proximos = [];

    for (const med of medications) {
        for (const schedule of (med.schedules || []).filter(s => s.ativo)) {
            const horario = schedule.horario.substring(0, 5);
            const confirmado = confirmadasPorDose.has(`${med.id}|${horario}`);
            const diff = _minutesDiff(horaAtual, horario);

            if (diff < -120) {
                passados.push({ nome: med.nome, horario, confirmado });
            } else if (diff >= -120 && diff <= 30) {
                agoraList.push({ nome: med.nome, horario, confirmado });
            } else {
                proximos.push({ nome: med.nome, horario, confirmado });
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

// Limiar de diagnóstico por turno — sinaliza um turno quando concentra >= 60% das
// ocorrências de um status (nao_tomado/nao_informado), com no mínimo 3 casos.
// Ajustável após dados reais de uso (ver briefing seção 6).
const TURNO_LIMIAR_PERCENTUAL = 0.6;
const TURNO_LIMIAR_MINIMO_CASOS = 3;

// Deriva turno (manhã/tarde/noite) a partir de horario_agendado (MH-032).
// Logs pré-MH-032 têm horario_agendado nulo — não entram no diagnóstico de turno.
function derivarTurno(horarioAgendado) {
    if (!horarioAgendado) return null;
    const hora = parseInt(String(horarioAgendado).substring(0, 2), 10);
    if (hora >= 5 && hora <= 11) return 'manha';
    if (hora >= 12 && hora <= 17) return 'tarde';
    return 'noite'; // 18h-04h
}

// Adesão unificada — substitui getAdesaoPeriodo e getAdesaoPorMedicamento.
// Filtra por scheduled_at (nunca taken_at): atribui confirmações retroativas ao
// dia devido e exclui automaticamente doses revertidas (confirmed:false no reverso).
// diagnosticoPorTurno só é calculado quando dias >= 28 (fechamento mensal).
export async function calcularAdesao(userId, dias) {
    const agora = new Date();
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);

    const medications = await getUserMedications(userId);
    const medicationIds = medications.map(m => m.id);
    const medNomeMap = Object.fromEntries(medications.map(m => [m.id, m.nome]));

    const vazio = {
        esperado: 0, confirmado: 0, percentual: 0,
        porStatus: { confirmado: 0, nao_informado: 0, nao_tomado: 0, sem_estoque: 0 },
        porMedicamento: {},
        diagnosticoPorTurno: null
    };
    if (medicationIds.length === 0) return vazio;

    const { data: logs, error } = await supabase
        .from('dose_logs')
        .select('id, medication_id, status, horario_agendado')
        .in('medication_id', medicationIds)
        .gte('scheduled_at', desde.toISOString())
        .lte('scheduled_at', agora.toISOString());

    if (error) throw new Error(`Erro ao calcular adesão: ${error.message}`);

    const todosLogs = logs || [];
    const esperado = todosLogs.length;
    if (esperado === 0) return vazio;

    const porStatus = { confirmado: 0, nao_informado: 0, nao_tomado: 0, sem_estoque: 0 };
    const porMedicamento = {};

    for (const log of todosLogs) {
        // Dose recém-criada, ainda aguardando follow-up — conta como "sem resposta" por ora.
        const statusEfetivo = log.status === 'pendente' ? 'nao_informado' : log.status;
        if (porStatus[statusEfetivo] !== undefined) porStatus[statusEfetivo]++;

        if (!porMedicamento[log.medication_id]) {
            porMedicamento[log.medication_id] = {
                nome: medNomeMap[log.medication_id] || 'desconhecido',
                esperado: 0,
                confirmado: 0,
                percentual: 0,
                porStatus: { confirmado: 0, nao_informado: 0, nao_tomado: 0, sem_estoque: 0 }
            };
        }
        const bucket = porMedicamento[log.medication_id];
        bucket.esperado++;
        if (statusEfetivo === 'confirmado') bucket.confirmado++;
        if (bucket.porStatus[statusEfetivo] !== undefined) bucket.porStatus[statusEfetivo]++;
    }

    for (const bucket of Object.values(porMedicamento)) {
        bucket.percentual = bucket.esperado > 0 ? Math.round((bucket.confirmado / bucket.esperado) * 100) : 0;
    }

    const confirmado = porStatus.confirmado;
    const percentual = Math.round((confirmado / esperado) * 100);

    let diagnosticoPorTurno = null;
    if (dias >= 28) {
        diagnosticoPorTurno = {};
        for (const statusAlvo of ['nao_tomado', 'nao_informado']) {
            const porTurno = { manha: 0, tarde: 0, noite: 0 };
            let totalStatus = 0;

            for (const log of todosLogs) {
                const statusEfetivo = log.status === 'pendente' ? 'nao_informado' : log.status;
                if (statusEfetivo !== statusAlvo) continue;
                const turno = derivarTurno(log.horario_agendado);
                if (!turno) continue;
                porTurno[turno]++;
                totalStatus++;
            }

            diagnosticoPorTurno[statusAlvo] = null;
            if (totalStatus > 0) {
                for (const [turno, count] of Object.entries(porTurno)) {
                    if (count >= TURNO_LIMIAR_MINIMO_CASOS && (count / totalStatus) >= TURNO_LIMIAR_PERCENTUAL) {
                        diagnosticoPorTurno[statusAlvo] = turno;
                        break;
                    }
                }
            }
        }
    }

    return { esperado, confirmado, percentual, porStatus, porMedicamento, diagnosticoPorTurno };
}

// tratamento_fim é uma string YYYY-MM-DD, sempre interpretada como meia-noite UTC pelo
// Date() — zerar em horário local aqui causaria off-by-one no fuso America/Sao_Paulo
// (UTC-3): tratamento_fim = hoje seria lido como "ontem 21h" local e excluído
// indevidamente. Por isso a comparação usa meia-noite UTC, não local.
function startOfDayUTC(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// Progresso do tratamento — só medicamentos ativos, não-contínuos, com tratamento_dias,
// cujo tratamento_fim ainda não passou. Comparação por data (não por diasRestantes/
// dosesRestantes, que zeram no último dia mesmo com dose pendente — BRIEFING_ADESAO_AO_
// TRATAMENTO_COMPLEMENTO.md) — assim o tratamento some da lista só a partir do dia
// seguinte ao fim, nunca no próprio dia final.
// tratamento_fim é sempre a fonte da verdade (populada em saveMedication/reativarComAtualizacao).
export async function calcularProgressoTratamento(userId) {
    const medications = await getUserMedications(userId);
    const hoje = new Date();

    const elegiveis = medications.filter(m =>
        m.tipo_tratamento && m.tipo_tratamento !== 'continuo' && m.tratamento_dias && m.tratamento_fim
        && new Date(m.tratamento_fim) >= startOfDayUTC(hoje)
    );

    return elegiveis.map(med => {
        const tratamentoFim = new Date(med.tratamento_fim);
        const diasRestantes = Math.max(0, Math.ceil((tratamentoFim - hoje) / (1000 * 60 * 60 * 24)));
        const diasDecorridos = Math.max(0, med.tratamento_dias - diasRestantes);
        const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);
        const dosesPorDia = schedulesAtivos.length || 1;
        const dosesRestantes = diasRestantes * dosesPorDia;
        // MH-073: consumo diário na unidade de estoque (soma das quantidades por dose)
        const consumoDiario = schedulesAtivos.reduce(
            (acc, s) => acc + Number(s.quantidade_por_dose ?? 1), 0
        ) || 1;
        const percentualDecorrido = Math.round((diasDecorridos / med.tratamento_dias) * 100);

        return {
            medicationId: med.id,
            nome: med.nome,
            tratamentoDias: med.tratamento_dias,
            diasDecorridos,
            diasRestantes,
            dosesRestantes,
            percentualDecorrido,
            estoqueAtual: med.estoque_atual,
            dosesPorDia,
            consumoDiario
        };
    });
}

// ============================================================
// ADESAO_ESTADO — jornada de faixa/semana e cadência semanal/mensal
// ============================================================

export async function getAdesaoEstado(userId) {
    const { data } = await supabase
        .from('adesao_estado')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    return data || {
        user_id: userId,
        ultimo_fechamento_mensal_at: null,
        faixa_atual: null,
        percentual_ultimo_envio: null,
        semana_atual_na_faixa: 1,
        melhor_faixa_atingida: null
    };
}

export async function upsertAdesaoEstado(userId, patch) {
    const { error } = await supabase
        .from('adesao_estado')
        .upsert({
            user_id: userId,
            ...patch,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });

    if (error) throw new Error(`Erro ao atualizar adesao_estado: ${error.message}`);
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

    // MH-073: dias de cobertura dependem do CONSUMO diário (soma das quantidades),
    // não do número de horários. Com 2 comprimidos por dose e 2 horários, o consumo
    // é 4/dia — contar schedules daria 2 e dobraria a projeção de cobertura.
    const { consumoDiario, dosesPerDia } = await calcularConsumoDiario(medicationId);
    if (dosesPerDia === 0 || consumoDiario <= 0) return null;

    const diasRestantes = Math.floor(Number(med.estoque_atual) / consumoDiario);

    return {
        medNome: med.nome,
        novoEstoque: med.estoque_atual,
        dosesPerDia,
        consumoDiario,
        diasRestantes,
        tipo_tratamento: med.tipo_tratamento || 'continuo',
        tratamento_dias: med.tratamento_dias || null
    };
}

// Status de estoque simples (mesmo limiar crítico/baixo/ok usado em relatorioEstoque)
// — usado para o alerta pós-ajuste manual de estoque (MH-042), que não depende de
// doses/dia como o alerta pós-confirmação de dose.
export async function getEstoqueStatusSimples(medicationId) {
    const { data: med } = await supabase
        .from('medications')
        .select('nome, estoque_atual, estoque_minimo')
        .eq('id', medicationId)
        .single();

    if (!med) return null;

    const status = med.estoque_atual <= 0
        ? 'critico'
        : med.estoque_atual <= med.estoque_minimo
            ? 'baixo'
            : 'ok';

    return { medNome: med.nome, estoqueAtual: med.estoque_atual, status };
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

// Classifica o nível de urgência do estoque com base em unidades reais E dias de
// cobertura — nunca infere "zerado" a partir de diasRestantes sozinho (BUG-065).
export function classificarNivelEstoquePorDias({ novoEstoque, diasRestantes }) {
    if (novoEstoque <= 0) return 'zerado';       // literalmente sem unidades
    if (diasRestantes === 0) return 'urgente';   // sobra estoque, mas não fecha 1 dia
    return 'ok';                                  // diasRestantes >= 1
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
    const { data, error } = await supabase
        .from('agent_logs')
        .insert({
            user_id: userId,
            agent,
            user_message: userMessage,
            agent_response: agentResponse,
            estado_conversa: estadoConversa,
            contexto_conversa: contextoConversa
        })
        .select('id')
        .single();

    if (error) {
        console.error(`Erro ao salvar log de agente: ${error.message}`);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'media',
            userId,
            agent,
            origem: 'outro',
            titulo: 'Falha ao salvar log de agente',
            payload: { message: error.message }
        });
        return null;
    }
    return data?.id ?? null;
}

// Verifica se o usuário já respondeu qualquer coisa desde um timestamp de referência.
// Usada pelo fast-path de resposta tardia ao esgotamento (BUG-035) para confirmar que a
// mensagem atual é a 1ª interação do usuário desde o esgotamento da dose.
export async function usuarioRespondeuDesde(userId, timestampReferencia) {
    const { data, error } = await supabase
        .from('agent_logs')
        .select('id')
        .eq('user_id', userId)
        .not('user_message', 'is', null)
        .gt('created_at', timestampReferencia)
        .limit(1);

    if (error) {
        console.error('Erro ao verificar resposta prévia do usuário:', error.message);
        return true; // fail-safe: assume que já respondeu → não dispara o fast-path automático
    }
    return (data || []).length > 0;
}

// ============================================================
// HISTÓRICO RECENTE — para classificador LLM do roteador
// ============================================================

export async function getHistoricoRecente(userId, limite = 3) {
    const { data, error } = await supabase
        .from('agent_logs')
        .select('user_message, agent_response, agent, estado_conversa, contexto_conversa, created_at')
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

// ============================================================
// EVENTOS PROATIVOS (MH-70, v28)
// Ponto único de escrita — nunca inserir em eventos_proativos por SQL direto
// fora desta função (mesmo princípio de src/backlog.js para backlog_items).
// Defensiva: uma falha aqui nunca pode impedir o envio real da mensagem ao
// usuário, por isso nunca lança exceção — mesmo padrão de registrarEvento/
// registrarFeedback (observabilidade.js).
// ============================================================
export async function registrarEventoProativo({ userId, tipo, medicationId = null, doseLogId = null, tentativa = null, horarioAgendado = null }) {
    try {
        const { error } = await supabase.from('eventos_proativos').insert({
            user_id: userId,
            tipo,
            medication_id: medicationId,
            dose_log_id: doseLogId,
            tentativa,
            horario_agendado: horarioAgendado
        });
        if (error) console.error(`[eventos_proativos] Falha ao registrar evento proativo: ${error.message}`);
    } catch (e) {
        console.error(`[eventos_proativos] Exceção ao registrar evento proativo: ${e.message}`);
    }
}

// ============================================================
// CONTEXTO PROATIVO — MH-065 (v27), reescrito no MH-71/Parte C (v28)
// Mensagens que a Nami enviou por iniciativa própria (lembrete, follow-up,
// alerta de estoque, resumo semanal) não existem em agent_logs: scheduler.js,
// lembrete.js e relatorios.js não chamam logAgentInteraction. Esta função lê
// de eventos_proativos (MH-70) — registro de ENTREGA, append-only, escrito no
// instante do envio (princípio 24) — em vez de reconstruir a partir do estado
// MUTÁVEL de dose_logs, como a versão MH-065 original fazia.
//
// Por que a versão anterior foi substituída (decisão de arquitetura da v28):
// (1) dose_logs só guarda o ÚLTIMO follow-up — cada UPDATE sobrescreve o
//     anterior, então os follow-ups intermediários se perdiam antes de
//     qualquer leitura acontecer.
// (2) o filtro por status da dose (idêntico a temDosePendente) misturava duas
//     perguntas diferentes: "esta dose ainda está pendente?" (operacional) com
//     "isso apareceu na tela do usuário?" (conversacional) — uma dose já
//     confirmada ou já nao_informado continua tendo acontecido, e o
//     classificador precisa saber disso mesmo assim.
//
// Consumida SOMENTE pelo classificador central (router.js). O principal já tem
// esse contexto via getRecentDoses + bloco DOSES AGUARDANDO CONFIRMAÇÃO.
// ============================================================

const MAX_EVENTOS_PROATIVOS = 6;

export async function getContextoProativoRecente(userId, ultimoTurnoAt) {
    try {
        const { inicio: inicioDiaBRT } = janelaDiaBRT(hojeBRT());
        // SEQUÊNCIA — só entram eventos mais recentes que o último turno reativo.
        // ultimoTurnoAt null = usuário sem histórico nenhum: usa início do dia
        // como rede de segurança (mesmo papel que tinha na versão anterior).
        const corteMinimo = ultimoTurnoAt || inicioDiaBRT;

        const { data, error } = await supabase
            .from('eventos_proativos')
            .select('tipo, tentativa, horario_agendado, enviado_at, medications(nome)')
            .eq('user_id', userId)
            .gt('enviado_at', corteMinimo)
            .order('enviado_at', { ascending: true })
            .limit(MAX_EVENTOS_PROATIVOS);

        if (error) {
            return await degradar({
                origem: 'contexto_proativo',
                motivo: 'query_falhou',
                agent: 'classificador',
                userId,
                detalhe: { etapa: 'eventos_proativos' },
                fallback: []
            });
        }

        return (data || []).map(e => ({
            tipo: e.tipo,
            medicamento: e.medications?.nome || null,
            tentativa: e.tentativa,
            horarioAgendado: e.horario_agendado ? String(e.horario_agendado).substring(0, 5) : null,
            enviadoAt: e.enviado_at
        }));

    } catch (e) {
        return await degradar({
            origem: 'contexto_proativo',
            motivo: 'query_falhou',
            agent: 'classificador',
            userId,
            detalhe: { excecao: true },
            fallback: []
        });
    }
}

// ============================================================
// SAUDAÇÃO CONDICIONAL — para templates "sob demanda" de adesão/progresso
// (BRIEFING_APRESENTACAO_V2.md, seção 1)
// ============================================================

const MINUTOS_PARA_NOVA_SAUDACAO = 10;

export async function getUltimaInteracao(userId) {
    const { data, error } = await supabase
        .from('agent_logs')
        .select('created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);

    if (error) {
        console.error('Erro ao buscar última interação:', error.message);
        return null;
    }
    return data?.[0]?.created_at || null;
}

export async function precisaSaudacao(userId) {
    const ultimaInteracao = await getUltimaInteracao(userId);
    if (!ultimaInteracao) return true;
    const minutosDesdeUltima = (Date.now() - new Date(ultimaInteracao).getTime()) / 60000;
    return minutosDesdeUltima > MINUTOS_PARA_NOVA_SAUDACAO;
}

export async function registrarIntencaoNaoSuportada(userId, mensagem) {
    const { error } = await supabase
        .from('intencoes_nao_suportadas')
        .insert({ user_id: userId, mensagem, created_at: new Date().toISOString() });
    if (error) console.error(`⚠️ Erro ao registrar intenção não suportada: ${error.message}`);
    else console.log(`📋 Intenção não suportada registrada: "${mensagem}"`);
}