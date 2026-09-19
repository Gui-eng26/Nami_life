// ============================================================
// ARNÊS — semeadura e limpeza do banco de teste (staging)
// Usuários do arnês vivem no prefixo reservado +5500000000xx
// (número inválido no Brasil — nunca colide com usuário real)
// e sempre com is_teste = true.
// ============================================================

import { PREFIXO_TELEFONE_ARNES } from './contexto.js';

export function fabricaSeeds(db) {
    let proximoSufixo = 1;

    async function limparUsuariosDoArnes() {
        // Staging tem ON DELETE CASCADE nas FKs (corrigido em 18/09) — apagar o
        // usuário derruba medications/schedules/dose_logs/agent_logs/estado.
        const { error } = await db.from('users').delete().like('phone', `${PREFIXO_TELEFONE_ARNES}%`);
        if (error) throw new Error(`Limpeza do arnês falhou: ${error.message}`);
    }

    async function criarUsuario({ nome = null, onboarded = true, nascimento = null, estado = 'idle', contexto = {} } = {}) {
        const phone = `${PREFIXO_TELEFONE_ARNES}${String(proximoSufixo++).padStart(2, '0')}`;
        const { data: user, error } = await db.from('users').insert({
            phone,
            name: nome,
            onboarded,
            lgpd_accepted: onboarded,
            lgpd_accepted_at: onboarded ? new Date().toISOString() : null,
            data_nascimento: nascimento,
            is_teste: true
        }).select().single();
        if (error) throw new Error(`Seed de usuário falhou: ${error.message}`);

        const { error: eState } = await db.from('conversation_state')
            .insert({ user_id: user.id, state: estado, context: contexto });
        if (eState) throw new Error(`Seed de estado falhou: ${eState.message}`);

        return user;
    }

    async function criarMedicamento({ userId, nome, dosagem = null, estoque = null, horarios = [], quantidadePorDose = 1, forma = 'comprimido', unidadeDose = 'unidade' }) {
        const { data: med, error } = await db.from('medications').insert({
            user_id: userId,
            nome,
            dosagem,
            estoque_atual: estoque,
            forma_farmaceutica: forma,
            unidade_dose: unidadeDose,
            unidade_estoque: unidadeDose === 'gota' ? 'ml' : (unidadeDose === 'ml' ? 'ml' : 'unidade'),
            ativo: true,
            tipo_tratamento: 'continuo'
        }).select().single();
        if (error) throw new Error(`Seed de medicamento falhou: ${error.message}`);

        const schedules = [];
        for (const horario of horarios) {
            const { data: s, error: eS } = await db.from('schedules').insert({
                medication_id: med.id,
                horario,
                quantidade_por_dose: quantidadePorDose,
                ativo: true
            }).select().single();
            if (eS) throw new Error(`Seed de schedule falhou: ${eS.message}`);
            schedules.push(s);
        }
        return { med, schedules };
    }

    // Dose pendente de confirmação: lembrete já enviado, sem resposta.
    async function criarDosePendente({ medicationId, scheduleId = null, horario = null, minutosAtras = 30 }) {
        const quando = new Date(Date.now() - minutosAtras * 60_000).toISOString();
        const { data, error } = await db.from('dose_logs').insert({
            medication_id: medicationId,
            schedule_id: scheduleId,
            scheduled_at: quando,
            reminder_sent: true,
            reminder_sent_at: quando,
            confirmed: false,
            status: 'pendente',
            tentativas: 1,
            ultima_tentativa_at: quando,
            horario_agendado: horario
        }).select().single();
        if (error) throw new Error(`Seed de dose pendente falhou: ${error.message}`);
        return data;
    }

    return { limparUsuariosDoArnes, criarUsuario, criarMedicamento, criarDosePendente };
}
