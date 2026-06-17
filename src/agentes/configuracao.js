import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import {
    saveConversationState,
    getUserMedications,
    pausarMedicamento,
    reativarMedicamento,
    encerrarTratamento,
    alterarHorarioSchedule
} from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// CLASSIFICAÇÃO VIA CLAUDE — única chamada LLM do agente
// ============================================================

async function classificarIntencao(message, medicamentosDisponiveis) {
    const listaMeds = medicamentosDisponiveis.map(m => m.nome).join(', ') || 'nenhum';

    const systemPrompt = `Você é um classificador de intenções para um assistente de saúde.
O usuário quer fazer algo com seus lembretes ou tratamentos.

Medicamentos cadastrados: ${listaMeds}

Responda APENAS com JSON válido, sem markdown, sem explicações:
{
  "acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "ambiguo",
  "medicamentoMencionado": "nome mencionado ou null",
  "novoHorario": "HH:MM ou null"
}

Definições:
- pausar: parar lembretes temporariamente (pode retomar depois). Ex: "cancela o lembrete", "para de me lembrar", "não preciso mais do aviso"
- reativar: ativar lembretes que estavam pausados. Ex: "volta os lembretes", "ativa de novo"
- encerrar: terminar tratamento definitivamente ou remover medicamento. Ex: "não vou mais tomar", "remove esse remédio", "acabei o tratamento"
- alterar_horario: mudar o horário de um lembrete. Ex: "muda pra 9h", "trocar horário para 22:00"
- ambiguo: não dá pra distinguir entre pausar e encerrar com certeza

Regra: quando há dúvida entre pausar (temporário) e encerrar (definitivo), use "ambiguo".`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 150,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }]
        });
        const text = response.content[0]?.text || '{}';
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        console.log(`⚙️ Intenção classificada: ${JSON.stringify(parsed)}`);
        return parsed;
    } catch (e) {
        console.error('⚠️ Erro ao classificar intenção:', e.message);
        return { acao: 'ambiguo', medicamentoMencionado: null, novoHorario: null };
    }
}

// ============================================================
// HELPERS DETERMINÍSTICOS
// ============================================================

function encontrarMedicamento(texto, medications) {
    if (!texto) return null;
    const t = texto.toLowerCase();
    return medications.find(m => m.nome.toLowerCase() === t)
        || medications.find(m =>
            t.includes(m.nome.toLowerCase()) ||
            m.nome.toLowerCase().includes(t)
        )
        || null;
}

function extrairHorario(message) {
    const match = message.match(/(\d{1,2})[:h](\d{2})?/);
    if (!match) return null;
    const h = match[1].padStart(2, '0');
    const m = (match[2] || '00').padStart(2, '0');
    return `${h}:${m}`;
}

function isConfirmacao(message) {
    const msg = message.toLowerCase().trim();
    const termos = ['sim', 's', 'ok', 'pode', 'claro', 'confirmar', 'confirmo', 'vai', 'vamos', 'isso'];
    return termos.some(t => msg === t || msg.startsWith(t + ' '));
}

function isCancelamento(message) {
    return /\b(não|nao|cancela|cancelar|desiste|desistir|para|esquece|esquece isso)\b/.test(message.toLowerCase());
}

function formatarHorarios(schedules) {
    return (schedules || [])
        .filter(s => s.ativo)
        .map(s => s.horario.substring(0, 5))
        .join(' e ');
}

// ============================================================
// MENSAGENS DE CONFIRMAÇÃO
// ============================================================

function buildConfirmacaoMessage(firstName, ctx) {
    const { acao, medicationNome, schedulesAtivos, novoHorario, horarioAtual } = ctx;
    const horarios = formatarHorarios(schedulesAtivos);

    switch (acao) {
        case 'pausar':
            return `Só confirmar, ${firstName}: vou *pausar* todos os lembretes do *${medicationNome}*${horarios ? ` (${horarios})` : ''}.\n\nVocê pode reativar quando quiser. Confirmar?`;
        case 'reativar':
            return `Só confirmar: vou *reativar* os lembretes do *${medicationNome}*.\n\nEles voltarão a ser enviados nos horários cadastrados. Confirmar?`;
        case 'encerrar':
            return `Só confirmar: vou *encerrar o tratamento* com *${medicationNome}* e desativar todos os lembretes permanentemente.\n\nConfirmar?`;
        case 'alterar_horario':
            return `Só confirmar: vou mudar o lembrete${horarioAtual ? ` das *${horarioAtual.substring(0,5)}*` : ''} do *${medicationNome}* para *${novoHorario}*.\n\nConfirmar?`;
        default:
            return 'Confirmar a alteração?';
    }
}

// ============================================================
// EXECUÇÃO DA AÇÃO
// ============================================================

async function executarAcao(user, firstName, ctx) {
    const { acao, medicationId, medicationNome, scheduleId, novoHorario, schedulesAtivos } = ctx;
    const horarios = formatarHorarios(schedulesAtivos);

    await saveConversationState(user.id, { state: 'idle', context: {} });

    switch (acao) {
        case 'pausar':
            await pausarMedicamento(medicationId);
            return `✅ Pronto, ${firstName}! Lembretes do *${medicationNome}*${horarios ? ` (${horarios})` : ''} pausados.\n\nQuando quiser retomar, é só me dizer *"reativar ${medicationNome}"* 🌿`;

        case 'reativar':
            await reativarMedicamento(medicationId);
            return `✅ Pronto! Lembretes do *${medicationNome}* reativados. Vou voltar a te lembrar nos horários cadastrados 💊`;

        case 'encerrar':
            await encerrarTratamento(medicationId);
            return `✅ Tratamento com *${medicationNome}* encerrado. Os lembretes foram desativados 🌿\n\nSe precisar cadastrar novamente no futuro, é só me chamar!`;

        case 'alterar_horario':
            await alterarHorarioSchedule(scheduleId, novoHorario);
            return `✅ Pronto! Seu lembrete do *${medicationNome}* foi atualizado para *${novoHorario}* ⏰`;

        default:
            return `Não consegui executar a ação. Pode tentar novamente?`;
    }
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleConfiguracao({ user, message, state, context }) {
    const etapa = context?.etapa || 'identif_intencao';
    const firstName = user.name?.split(' ')[0] || 'você';
    const medications = await getUserMedications(user.id);
    const medicationsAtivos = medications.filter(m => m.ativo !== false);

    console.log(`⚙️ Configuração — etapa: ${etapa} — ${user.phone}`);

    // ── ETAPA 1: Classificar intenção via Claude ─────────────────────────────
    if (etapa === 'identif_intencao') {
        const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos);

        if (medicationsAtivos.length === 0) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
        }

        // Intenção ambígua → perguntar se quer pausar ou encerrar
        if (acao === 'ambiguo') {
            const med = medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null;
            const nomeExibir = med?.nome || medicamentoMencionado || 'esse medicamento';
            await saveConversationState(user.id, {
                state: 'configurando',
                context: {
                    etapa: 'identif_acao',
                    medicationId: med?.id || null,
                    medicationNome: nomeExibir,
                    schedulesAtivos: med ? (med.schedules || []).filter(s => s.ativo) : []
                }
            });
            return `Entendido, ${firstName}! Sobre o *${nomeExibir}*, você quer:\n\n• *Pausar* os lembretes (temporário — pode retomar depois)\n• *Encerrar* o tratamento definitivamente\n\nO que prefere?`;
        }

        // Intenção clara → identificar medicamento
        const med = medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null;
        return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, novoHorario, message });
    }

    // ── ETAPA 2: Usuário esclarece pausar vs encerrar ────────────────────────
    if (etapa === 'identif_acao') {
        const msg = message.toLowerCase();
        let acao = null;
        if (/pausar|pausa|temporár|temporar|depois|retomar/.test(msg)) acao = 'pausar';
        else if (/encerrar|definitiv|remover|apagar|excluir|não vou mais|nao vou mais/.test(msg)) acao = 'encerrar';
        else if (isConfirmacao(msg) && msg.includes('paus')) acao = 'pausar';
        else if (isConfirmacao(msg) && msg.includes('encerr')) acao = 'encerrar';

        if (!acao) {
            return `Não entendi, ${firstName}. Você quer *pausar* (temporário) ou *encerrar* definitivamente?`;
        }

        // Se já tem medicamento no contexto, ir para confirmação
        if (context.medicationId) {
            const schedulesAtivos = context.schedulesAtivos || [];
            const newCtx = { etapa: 'confirm_acao', acao, medicationId: context.medicationId, medicationNome: context.medicationNome, schedulesAtivos };
            await saveConversationState(user.id, { state: 'configurando', context: newCtx });
            return buildConfirmacaoMessage(firstName, newCtx);
        }

        // Sem medicamento identificado → perguntar qual
        const lista = medicationsAtivos.map(m => `• ${m.nome}`).join('\n');
        await saveConversationState(user.id, { state: 'configurando', context: { etapa: 'identif_medicamento', acao } });
        return `Qual medicamento você quer ${acao === 'pausar' ? 'pausar' : 'encerrar'}?\n\n${lista}`;
    }

    // ── ETAPA 3: Usuário especifica qual medicamento ──────────────────────────
    if (etapa === 'identif_medicamento') {
        const med = encontrarMedicamento(message, medicationsAtivos);

        if (!med) {
            const lista = medicationsAtivos.map(m => `• ${m.nome}`).join('\n');
            return `Não encontrei esse medicamento, ${firstName}. Seus medicamentos:\n\n${lista}\n\nQual deles?`;
        }

        const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);
        const { acao, novoHorario } = context;
        return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, novoHorario, message, schedulesAtivos });
    }

    // ── ETAPA 4: Usuário especifica qual horário alterar ─────────────────────
    if (etapa === 'identif_schedule') {
        const horarioMencionado = extrairHorario(message);
        const schedulesAtivos = context.schedulesAtivos || [];
        const schedule = schedulesAtivos.find(s =>
            horarioMencionado && s.horario.startsWith(horarioMencionado)
        );

        if (!schedule) {
            const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
            return `Não encontrei esse horário. Horários disponíveis:\n\n${lista}\n\nQual você quer alterar?`;
        }

        if (!context.novoHorario) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { ...context, etapa: 'obter_horario', scheduleId: schedule.id, horarioAtual: schedule.horario }
            });
            return `Para qual horário você quer mudar o lembrete das *${schedule.horario.substring(0,5)}*? (ex: *14:30*)`;
        }

        const newCtx = { ...context, etapa: 'confirm_acao', scheduleId: schedule.id, horarioAtual: schedule.horario };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 5: Obter o novo horário ────────────────────────────────────────
    if (etapa === 'obter_horario') {
        const novoHorario = extrairHorario(message);
        if (!novoHorario) {
            return `Não entendi o horário, ${firstName}. Informe no formato *HH:MM* (ex: *14:30*)`;
        }
        const newCtx = { ...context, etapa: 'confirm_acao', novoHorario };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 6: Confirmar e executar ────────────────────────────────────────
    if (etapa === 'confirm_acao') {
        if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        if (!isConfirmacao(message)) {
            return buildConfirmacaoMessage(firstName, context)
                + '\n\n_(Responda *SIM* para confirmar ou *NÃO* para cancelar)_';
        }
        return await executarAcao(user, firstName, context);
    }

    // Fallback
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `Algo deu errado no fluxo de configuração, ${firstName}. Pode tentar novamente?`;
}

// ── HELPER: continua após intenção clara + medicamento opcional ──────────────
async function continuarComAcao({ user, firstName, acao, med, medicationsAtivos, novoHorario, message, schedulesAtivos }) {
    // Sem medicamento identificado
    if (!med) {
        if (medicationsAtivos.length === 1) {
            med = medicationsAtivos[0];
        } else {
            const lista = medicationsAtivos.map(m => `• ${m.nome}`).join('\n');
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_medicamento', acao, novoHorario }
            });
            return `Qual medicamento você quer ${acao === 'alterar_horario' ? 'alterar o horário' : acao}?\n\n${lista}`;
        }
    }

    schedulesAtivos = schedulesAtivos || (med.schedules || []).filter(s => s.ativo);

    // alterar_horario: verificar se precisamos do schedule específico e/ou novo horário
    if (acao === 'alterar_horario') {
        // Múltiplos schedules sem horário específico mencionado
        if (schedulesAtivos.length > 1) {
            const horarioMencionado = extrairHorario(message);
            const scheduleEspecifico = horarioMencionado
                ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
                : null;

            if (!scheduleEspecifico) {
                const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: { etapa: 'identif_schedule', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario }
                });
                return `O *${med.nome}* tem lembretes em:\n\n${lista}\n\nQual horário você quer alterar?`;
            }

            if (!novoHorario) {
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario }
                });
                return `Para qual horário você quer mudar o lembrete das *${scheduleEspecifico.horario.substring(0,5)}*? (ex: *14:30*)`;
            }

            const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario, novoHorario };
            await saveConversationState(user.id, { state: 'configurando', context: ctx });
            return buildConfirmacaoMessage(firstName, ctx);
        }

        // Schedule único
        if (!novoHorario) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: schedulesAtivos[0]?.id, horarioAtual: schedulesAtivos[0]?.horario }
            });
            return `Para qual horário você quer mudar o lembrete das *${schedulesAtivos[0]?.horario?.substring(0,5)}* do *${med.nome}*? (ex: *14:30*)`;
        }

        const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: schedulesAtivos[0]?.id, horarioAtual: schedulesAtivos[0]?.horario, novoHorario };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // Outros casos (pausar, reativar, encerrar) → confirmação direta
    const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario };
    await saveConversationState(user.id, { state: 'configurando', context: ctx });
    return buildConfirmacaoMessage(firstName, ctx);
}
