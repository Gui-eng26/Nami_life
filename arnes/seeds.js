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
        // A limpeza usa a MESMA função atômica da exclusão LGPD (delete_user_account):
        // stock_movements e adesao_estado têm FK deliberadamente sem CASCADE e são
        // apagados explicitamente lá — DELETE direto em users quebrava nessas duas
        // (achado da 1ª execução do arnês, 19/09). Reusar o caminho de produção
        // também exercita a função a cada execução da suíte.
        const { data: usuarios, error: eSel } = await db.from('users')
            .select('id, phone')
            .like('phone', `${PREFIXO_TELEFONE_ARNES}%`);
        if (eSel) throw new Error(`Limpeza do arnês falhou (seleção): ${eSel.message}`);

        for (const u of usuarios || []) {
            const { error } = await db.rpc('delete_user_account', { p_user_id: u.id });
            if (error) throw new Error(`Limpeza do arnês falhou (delete_user_account de ${u.phone}): ${error.message}`);
        }
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

    // v45 P1: dose em qualquer status do ciclo (esgotada, sem_estoque, confirmada),
    // com o lembrete já enviado. `quando` sobrepõe minutosAtras quando o caso
    // precisa de um dia específico (ontem, anteontem).
    async function criarDose({ medicationId, scheduleId = null, horario = null, minutosAtras = 30, quando = null,
                               status = 'pendente', tentativas = 1, minutosDesdeUltimaTentativa = null,
                               funilEnvioId = null }) {
        const agendada = quando ?? new Date(Date.now() - minutosAtras * 60_000).toISOString();
        const ultima = minutosDesdeUltimaTentativa !== null
            ? new Date(Date.now() - minutosDesdeUltimaTentativa * 60_000).toISOString()
            : agendada;
        const confirmada = status === 'confirmado';
        const { data, error } = await db.from('dose_logs').insert({
            medication_id: medicationId,
            schedule_id: scheduleId,
            scheduled_at: agendada,
            reminder_sent: true,
            reminder_sent_at: agendada,
            confirmed: confirmada,
            taken_at: confirmada ? agendada : null,
            status,
            tentativas,
            ultima_tentativa_at: ultima,
            horario_agendado: horario,
            funil_envio_id: funilEnvioId
        }).select().single();
        if (error) throw new Error(`Seed de dose (${status}) falhou: ${error.message}`);
        return data;
    }

    // Envio do funil (para citação): o messageId é o que o webhook devolve
    // em referenceMessageId (T0 de 19/09).
    async function criarEnvioFunil({ user, texto, origem = 'proativo:lembrete', minutosAtras = 10 }) {
        const messageId = `arnes-envio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { data, error } = await db.from('funil_envios').insert({
            user_id: user.id,
            phone: user.phone,
            texto,
            origem,
            message_id: messageId,
            created_at: new Date(Date.now() - minutosAtras * 60_000).toISOString()
        }).select().single();
        if (error) throw new Error(`Seed de envio do funil falhou: ${error.message}`);
        return { envio: data, messageId };
    }

    return { limparUsuariosDoArnes, criarUsuario, criarMedicamento, criarDosePendente, criarDose, criarEnvioFunil };
}
