import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import {
    saveConversationState,
    getUserMedications,
    pausarMedicamento,
    reativarMedicamento,
    encerrarTratamento,
    alterarHorarioSchedule,
    reativarComAtualizacao,
    removerSchedule,
    adicionarSchedule
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
  "acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "remover_horario" | "adicionar_horario" | "redefinir_horarios" | "ambiguo",
  "medicamentoMencionado": "nome mencionado ou null",
  "novoHorario": "HH:MM ou null"
}

Definições:
- pausar: parar lembretes temporariamente. Ex: "cancela o lembrete", "para de me lembrar"
- reativar: ativar lembretes pausados. Ex: "volta os lembretes", "ativa de novo"
- encerrar: terminar tratamento definitivamente. Ex: "não vou mais tomar", "remove esse remédio"
- alterar_horario: mudar UM horário específico para outro. Ex: "muda das 8 para 9", "trocar o das 20h para 22h"
- remover_horario: apagar um horário específico sem substituir. Ex: "tirar o lembrete das 8h", "apagar o das 20", "não preciso mais do aviso das 8", "remover esse horário"
- adicionar_horario: acrescentar um horário novo sem mexer nos existentes. Ex: "quero tomar às 20 também", "adicionar lembrete às 14h", "incluir um às 20h"
- redefinir_horarios: substituir TODOS os horários existentes por horários novos, ou aumentar/diminuir a frequência de doses. Ex: "mudar todos os horários", "agora vou tomar 3x ao dia", "mudar os dois horários", "alterar todos"
- ambiguo: não dá pra distinguir entre pausar e encerrar com certeza

ATENÇÃO:
- "remover horário" é diferente de "encerrar tratamento" — remover é sobre um horário específico, encerrar é sobre o medicamento inteiro
- "adicionar horário" mantém os horários existentes — "redefinir" substitui todos
- quando há dúvida entre pausar e encerrar, use "ambiguo"`;

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

function extrairHorarioOrigem(message) {
    const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (!matches.length) return null;
    const m = matches[0];
    return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

function extrairHorarioDestino(message) {
    const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (!matches.length) return null;
    const m = matches[matches.length - 1];
    return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

function normalizarHorario(message, schedulesDisponiveis) {
    const msg = message.toLowerCase().trim();

    // 1. Regex numérico (HH:MM ou HHhMM)
    const matchesNumericos = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (matchesNumericos.length > 0) {
        const m = matchesNumericos[0];
        const horarioExtraido = `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
        const scheduleExato = schedulesDisponiveis.find(s => s.horario.startsWith(horarioExtraido));
        if (scheduleExato) return horarioExtraido;
        const horaSo = m[1].padStart(2, '0');
        const schedulePorHora = schedulesDisponiveis.find(s => s.horario.startsWith(horaSo + ':'));
        if (schedulePorHora) return schedulePorHora.horario.substring(0, 5);
    }

    // 2. Número isolado ("8", "20")
    const matchNumeroIsolado = msg.match(/^(\d{1,2})$/);
    if (matchNumeroIsolado) {
        const hora = matchNumeroIsolado[1].padStart(2, '0');
        const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(hora + ':'));
        if (schedule) return schedule.horario.substring(0, 5);
    }

    // 3. Períodos do dia com número
    const periodos = [
        { pattern: /(\d{1,2})\s*(da\s*manhã|de\s*manhã|am)/i, periodo: 'manha' },
        { pattern: /(\d{1,2})\s*(da\s*tarde|da\s*noite|pm|de\s*noite)/i, periodo: 'tarde_noite' },
        { pattern: /(\d{1,2})\s*h/i, periodo: null }
    ];

    for (const { pattern, periodo } of periodos) {
        const match = msg.match(pattern);
        if (match) {
            let hora = parseInt(match[1]);
            if (periodo === 'tarde_noite' && hora < 12) hora += 12;
            const horaStr = String(hora).padStart(2, '0');
            const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(horaStr + ':'));
            if (schedule) return schedule.horario.substring(0, 5);
        }
    }

    // 4. Expressões sem número
    const expressoes = {
        'meio.?dia': '12',
        'meia.?noite': '00',
        'meio da manhã': '06'
    };
    for (const [expr, hora] of Object.entries(expressoes)) {
        if (new RegExp(expr, 'i').test(msg)) {
            const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(hora + ':'));
            if (schedule) return schedule.horario.substring(0, 5);
        }
    }

    return null;
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
    const { acao, medicationNome, schedulesAtivos, novoHorario, horarioAtual, novosHorarios } = ctx;
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
        case 'remover_horario':
            return `Só confirmar, ${firstName}: vou *remover* o lembrete das *${horarioAtual ? horarioAtual.substring(0,5) : '?'}* do *${medicationNome}* permanentemente.\n\nConfirmar?`;
        case 'adicionar_horario':
            return `Só confirmar, ${firstName}: vou *adicionar* um lembrete às *${novoHorario}* para o *${medicationNome}*.\n\nConfirmar?`;
        case 'redefinir_horarios': {
            const listaHorarios = (novosHorarios || []).join(', ');
            return `Só confirmar, ${firstName}: vou *substituir todos os horários* do *${medicationNome}*.\n\nNovos horários: *${listaHorarios}*\n\nConfirmar?`;
        }
        default:
            return 'Confirmar a alteração?';
    }
}

// ============================================================
// EXECUÇÃO DA AÇÃO
// ============================================================

async function executarAcao(user, firstName, ctx) {
    const { acao, medicationId, medicationNome, scheduleId, novoHorario, horarioAtual, schedulesAtivos, novosHorarios } = ctx;
    const horarios = formatarHorarios(schedulesAtivos);

    switch (acao) {
        case 'pausar':
            await saveConversationState(user.id, { state: 'idle', context: {} });
            await pausarMedicamento(medicationId);
            return `✅ Pronto, ${firstName}! Lembretes do *${medicationNome}*${horarios ? ` (${horarios})` : ''} pausados.\n\nQuando quiser retomar, é só me dizer *"reativar ${medicationNome}"* 🌿`;

        case 'reativar':
            await saveConversationState(user.id, { state: 'idle', context: {} });
            await reativarMedicamento(medicationId);
            return `✅ Pronto! Lembretes do *${medicationNome}* reativados. Vou voltar a te lembrar nos horários cadastrados 💊`;

        case 'encerrar':
            await saveConversationState(user.id, { state: 'idle', context: {} });
            await encerrarTratamento(medicationId);
            return `✅ Tratamento com *${medicationNome}* encerrado. Os lembretes foram desativados 🌿\n\nSe precisar cadastrar novamente no futuro, é só me chamar!`;

        case 'alterar_horario': {
            await alterarHorarioSchedule(scheduleId, novoHorario);

            const remainingSchedules = (schedulesAtivos || []).filter(s => s.id !== scheduleId);

            if (remainingSchedules.length > 0) {
                const lista = remainingSchedules.map(s => `• ${s.horario.substring(0, 5)}`).join('\n');
                const plural = remainingSchedules.length > 1 ? 's' : '';

                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: {
                        etapa: 'pos_alteracao',
                        acao: 'alterar_horario',
                        medicationId,
                        medicationNome,
                        schedulesAtivos: remainingSchedules
                    }
                });

                return `✅ Pronto! Lembrete das *${horarioAtual ? horarioAtual.substring(0, 5) : '?'}* do *${medicationNome}* atualizado para *${novoHorario}* ⏰\n\nVocê ainda tem lembrete${plural} cadastrado${plural} para esse medicamento:\n${lista}\n\nQuer alterar algum?`;
            }

            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `✅ Pronto! Seu lembrete do *${medicationNome}* foi atualizado para *${novoHorario}* ⏰`;
        }

        case 'remover_horario': {
            await removerSchedule(scheduleId, medicationId, horarioAtual);
            const remainingSchedules = (schedulesAtivos || []).filter(s => s.id !== scheduleId);
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `✅ Pronto, ${firstName}! Lembrete das *${horarioAtual ? horarioAtual.substring(0,5) : '?'}* do *${medicationNome}* removido.\n\n${remainingSchedules.length > 0
                ? `Você ainda tem lembrete${remainingSchedules.length > 1 ? 's' : ''} às ${remainingSchedules.map(s => s.horario.substring(0,5)).join(' e ')} para esse medicamento.`
                : ''}`;
        }

        case 'adicionar_horario': {
            try {
                await adicionarSchedule(medicationId, novoHorario);
                await saveConversationState(user.id, { state: 'idle', context: {} });
                const todosHorarios = [...(schedulesAtivos || []).map(s => s.horario.substring(0,5)), novoHorario]
                    .sort()
                    .join(', ');
                return `✅ Pronto, ${firstName}! Adicionei um lembrete às *${novoHorario}* para o *${medicationNome}* 💊\n\nAgora você tem lembretes às: ${todosHorarios}`;
            } catch (e) {
                if (e.message.startsWith('HORARIO_DUPLICADO')) {
                    await saveConversationState(user.id, { state: 'idle', context: {} });
                    return `O *${medicationNome}* já tem um lembrete às *${novoHorario}*. Nada foi alterado 🌿`;
                }
                throw e;
            }
        }

        case 'redefinir_horarios': {
            await reativarComAtualizacao({
                medicationId,
                estoque: null,
                tipo_tratamento: null,
                tratamento_dias: null,
                horarios: novosHorarios,
                apenasHorarios: true
            });
            const horariosLabel = (novosHorarios || []).sort().join(', ');
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `✅ Pronto, ${firstName}! Horários do *${medicationNome}* atualizados 💊\n\nNovos lembretes: ${horariosLabel}`;
        }

        default:
            await saveConversationState(user.id, { state: 'idle', context: {} });
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
        const schedulesAtivos = context.schedulesAtivos || [];
        const msg = message.toLowerCase();
        const querTodos = /\b(todos|os dois|ambos|os três|tudo|todas)\b/.test(msg);

        if (querTodos) {
            const schedulesOrdenados = [...schedulesAtivos].sort((a, b) => a.horario.localeCompare(b.horario));
            const primeiro = schedulesOrdenados[0];
            await saveConversationState(user.id, {
                state: 'configurando',
                context: {
                    ...context,
                    etapa: 'obter_horario',
                    scheduleId: primeiro.id,
                    horarioAtual: primeiro.horario,
                    schedulesAtivos: schedulesOrdenados
                }
            });
            return `Certo! Vou alterar todos os horários do *${context.medicationNome}* um a um.\n\nComeçando pelo primeiro: lembrete das *${primeiro.horario.substring(0,5)}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
        }

        const horarioMencionado = normalizarHorario(message, schedulesAtivos);
        const schedule = horarioMencionado
            ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
            : null;

        if (!schedule) {
            const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
            return `Não reconheci esse horário. Os lembretes cadastrados são:\n\n${lista}\n\nMe responda com um desses exatamente — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
        }

        if (!context.novoHorario) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { ...context, etapa: 'obter_horario', scheduleId: schedule.id, horarioAtual: schedule.horario }
            });
            return `Certo! Vou alterar o lembrete das *${schedule.horario.substring(0,5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
        }

        const newCtx = { ...context, etapa: 'confirm_acao', scheduleId: schedule.id, horarioAtual: schedule.horario };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 4b: Usuário escolhe qual horário remover ───────────────────────
    if (etapa === 'identif_schedule_remocao') {
        const schedulesAtivos = context.schedulesAtivos || [];
        const horarioMencionado = normalizarHorario(message, schedulesAtivos);
        const schedule = horarioMencionado
            ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
            : null;

        if (!schedule) {
            const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
            return `Não reconheci esse horário. Os lembretes cadastrados são:\n\n${lista}\n\nMe responda com um desses — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
        }

        const ctx = { ...context, etapa: 'confirm_acao', scheduleId: schedule.id, horarioAtual: schedule.horario };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // ── ETAPA 4c: Coleta novos horários para redefinição ─────────────────────
    if (etapa === 'obter_novos_horarios') {
        const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)].map(m => {
            const h = m[1].padStart(2, '0');
            const min = (m[2] || '00').padStart(2, '0');
            return `${h}:${min}`;
        });

        if (matches.length === 0) {
            return `Não reconheci os horários, ${firstName}. Me diga os novos horários das doses — por exemplo: *06:00, 14:00 e 22:00*`;
        }

        const horariosUnicos = [...new Set(matches)];
        const ctx = { ...context, etapa: 'confirm_acao', novosHorarios: horariosUnicos };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // ── ETAPA 5: Obter o novo horário ────────────────────────────────────────
    if (etapa === 'obter_horario') {
        const novoHorario = extrairHorarioDestino(message);
        if (!novoHorario) {
            return `Não reconheci esse horário, ${firstName}. Me diga só o novo horário no formato *HH:MM* — por exemplo: *08:00*`;
        }
        const newCtx = { ...context, etapa: 'confirm_acao', novoHorario };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 6: Confirmar e executar ────────────────────────────────────────
    if (etapa === 'confirm_acao') {
        const negacaoPresente = /\b(não|nao)\b/i.test(message.toLowerCase());
        const horarioCorrecao = extrairHorarioDestino(message);

        if (negacaoPresente && horarioCorrecao) {
            const newCtx = { ...context, etapa: 'confirm_acao', novoHorario: horarioCorrecao };
            await saveConversationState(user.id, { state: 'configurando', context: newCtx });
            return buildConfirmacaoMessage(firstName, newCtx);
        }

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

    // ── ETAPA reativ_confirmar: usuário confirma se quer reativar ────────────
    if (etapa === 'reativ_confirmar') {
        if (isCancelamento(message) || /\b(não|nao|n)\b/i.test(message.toLowerCase())) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
        }

        await saveConversationState(user.id, {
            state: 'configurando',
            context: { ...context, etapa: 'reativ_tipo_tratamento' }
        });
        return `Ótimo! Vamos atualizar as informações antes de reativar.\n\nO *${context.medicationNome}* é de uso contínuo (sem previsão de parada) ou tem prazo determinado, como um antibiótico ou anti-inflamatório?`;
    }

    // ── ETAPA reativ_tipo_tratamento: coleta tipo e prazo ───────────────────
    if (etapa === 'reativ_tipo_tratamento') {
        const msg = message.toLowerCase();
        let tipo_tratamento = null;
        let tratamento_dias = null;

        if (/contínuo|continuo|sempre|sem prazo|permanente|crônico|cronico/.test(msg)) {
            tipo_tratamento = 'continuo';
        } else if (/temporar|prazo|dias|semana|antibiótico|antibiotico|anti-inflamatório|antiinflamatorio/.test(msg)) {
            tipo_tratamento = 'temporario';
            const diasMatch = msg.match(/(\d+)\s*dias?/);
            tratamento_dias = diasMatch ? parseInt(diasMatch[1]) : null;
        }

        if (!tipo_tratamento) {
            return `Não entendi, ${firstName}. É uso *contínuo* (sem previsão de parada) ou *temporário* (tem um prazo determinado)?`;
        }

        if (tipo_tratamento === 'temporario' && !tratamento_dias) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { ...context, etapa: 'reativ_tipo_tratamento', tipo_tratamento }
            });
            return `Quantos dias dura esse tratamento?`;
        }

        await saveConversationState(user.id, {
            state: 'configurando',
            context: { ...context, etapa: 'reativ_estoque', tipo_tratamento, tratamento_dias }
        });
        return `Certo! Seu estoque anterior era de *${context.estoqueAtual} unidades*. Continua assim ou quer atualizar?`;
    }

    // ── ETAPA reativ_estoque: confirma ou atualiza estoque ──────────────────
    if (etapa === 'reativ_estoque') {
        const msg = message.toLowerCase().trim();
        const confirmouEstoque = ['sim', 's', 'ok', 'continua', 'mesmo', 'igual', 'está certo', 'tá bom', 'pode'].some(t =>
            msg === t || msg.startsWith(t + ' ')
        );

        let novoEstoque = context.estoqueAtual;

        if (!confirmouEstoque) {
            const numMatch = message.match(/\d+/);
            if (numMatch) {
                novoEstoque = parseInt(numMatch[0]);
            } else {
                return `Não entendi, ${firstName}. Qual a quantidade atual em estoque? (ex: *20*)`;
            }
        }

        const schedulesAnteriores = context.schedulesExistentes || [];
        const horariosAnteriores = schedulesAnteriores
            .map(s => `• ${s.horario.substring(0, 5)}`)
            .join('\n');

        await saveConversationState(user.id, {
            state: 'configurando',
            context: { ...context, etapa: 'reativ_horarios', novoEstoque }
        });
        return `Ótimo! Os horários anteriores eram:\n${horariosAnteriores || '(nenhum cadastrado)'}\n\nContinua igual ou quer definir novos horários?`;
    }

    // ── ETAPA reativ_horarios: confirma ou coleta novos horários ────────────
    if (etapa === 'reativ_horarios') {
        const msg = message.toLowerCase().trim();
        const confirmouHorarios = ['sim', 's', 'ok', 'continua', 'mesmo', 'igual', 'está certo', 'tá bom', 'pode'].some(t =>
            msg === t || msg.startsWith(t + ' ')
        );

        let horariosFinais;

        if (confirmouHorarios) {
            const schedulesAnteriores = context.schedulesExistentes || [];
            horariosFinais = schedulesAnteriores.map(s => s.horario.substring(0, 5));
        } else {
            const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)].map(m => {
                const h = m[1].padStart(2, '0');
                const min = (m[2] || '00').padStart(2, '0');
                return `${h}:${min}`;
            });

            if (matches.length === 0) {
                return `Não entendi os horários, ${firstName}. Me diga os horários das doses — por exemplo: *08:00 e 20:00*`;
            }

            horariosFinais = matches;
        }

        await reativarComAtualizacao({
            medicationId: context.medicationId,
            estoque: context.novoEstoque,
            tipo_tratamento: context.tipo_tratamento,
            tratamento_dias: context.tratamento_dias || null,
            horarios: horariosFinais
        });

        const tipoLabel = context.tipo_tratamento === 'temporario'
            ? `${context.tratamento_dias} dias`
            : 'uso contínuo';
        const horariosLabel = horariosFinais.join(', ');

        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `✅ Pronto, ${firstName}! *${context.medicationNome}* reativado com sucesso 💊\n\nHorários: ${horariosLabel}\nEstoque: ${context.novoEstoque} unidades\nTratamento: ${tipoLabel}\n\nVou voltar a te lembrar nos horários certos!`;
    }

    // ── ETAPA pos_alteracao: usuário quer alterar outro horário? ─────────────
    if (etapa === 'pos_alteracao') {
        if (isCancelamento(message) || /\b(não|nao|n|chega|pronto|ok|tudo bem)\b/i.test(message.toLowerCase())) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
        }

        const schedulesRestantes = context.schedulesAtivos || [];

        if (schedulesRestantes.length === 1) {
            const schedule = schedulesRestantes[0];
            await saveConversationState(user.id, {
                state: 'configurando',
                context: {
                    ...context,
                    etapa: 'obter_horario',
                    scheduleId: schedule.id,
                    horarioAtual: schedule.horario
                }
            });
            return `Certo! Vou alterar o lembrete das *${schedule.horario.substring(0, 5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
        }

        const lista = schedulesRestantes.map(s => `• ${s.horario.substring(0, 5)}`).join('\n');
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { ...context, etapa: 'identif_schedule' }
        });
        return `Qual desses você quer alterar?\n\n${lista}\n\nMe responda com o horário — por exemplo: *${schedulesRestantes[0]?.horario?.substring(0, 5)}*`;
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

    // remover_horario
    if (acao === 'remover_horario') {
        if (schedulesAtivos.length <= 1) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_acao', medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
            });
            return `O *${med.nome}* tem apenas um horário de lembrete cadastrado (${schedulesAtivos[0]?.horario?.substring(0,5) || '?'}). Não é possível remover o único horário.\n\nSe quiser parar os lembretes, posso *pausar* temporariamente ou *encerrar* o tratamento. O que prefere?`;
        }

        const horarioMencionado = normalizarHorario(message, schedulesAtivos);
        const scheduleAlvo = horarioMencionado
            ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
            : null;

        if (!scheduleAlvo) {
            const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_schedule_remocao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
            });
            return `O *${med.nome}* tem lembretes nos seguintes horários:\n\n${lista}\n\nQual você quer remover? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
        }

        const ctx = {
            etapa: 'confirm_acao',
            acao: 'remover_horario',
            medicationId: med.id,
            medicationNome: med.nome,
            schedulesAtivos,
            scheduleId: scheduleAlvo.id,
            horarioAtual: scheduleAlvo.horario
        };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // adicionar_horario
    if (acao === 'adicionar_horario') {
        if (novoHorario) {
            const ctx = {
                etapa: 'confirm_acao',
                acao: 'adicionar_horario',
                medicationId: med.id,
                medicationNome: med.nome,
                schedulesAtivos,
                novoHorario
            };
            await saveConversationState(user.id, { state: 'configurando', context: ctx });
            return buildConfirmacaoMessage(firstName, ctx);
        }

        await saveConversationState(user.id, {
            state: 'configurando',
            context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
        });
        const horariosAtuais = schedulesAtivos.map(s => s.horario.substring(0,5)).join(' e ');
        return `Você tem lembretes do *${med.nome}* às ${horariosAtuais}.\n\nQual horário quer adicionar? Me diga só o horário — por exemplo: *14:00*`;
    }

    // redefinir_horarios
    if (acao === 'redefinir_horarios') {
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { etapa: 'obter_novos_horarios', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
        });
        const horariosAtuais = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
        return `Vou substituir todos os horários do *${med.nome}*.\n\nHorários atuais:\n${horariosAtuais}\n\nMe diga os novos horários — por exemplo: *06:00, 14:00 e 22:00*`;
    }

    // alterar_horario: verificar se precisamos do schedule específico e/ou novo horário
    if (acao === 'alterar_horario') {
        // Múltiplos schedules sem horário específico mencionado
        if (schedulesAtivos.length > 1) {
            const horarioMencionado = normalizarHorario(message, schedulesAtivos);
            const scheduleEspecifico = horarioMencionado
                ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
                : null;

            if (!scheduleEspecifico) {
                const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
                const qtd = schedulesAtivos.length;
                const descricaoQtd = qtd === 1 ? 'um horário' :
                                     qtd === 2 ? 'dois horários' :
                                     `${qtd} horários`;
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: { etapa: 'identif_schedule', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario }
                });
                return `O *${med.nome}* tem lembretes em ${descricaoQtd}:\n\n${lista}\n\nQual desses você quer alterar? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
            }

            if (!novoHorario) {
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario }
                });
                return `Certo! Vou alterar o lembrete das *${scheduleEspecifico.horario.substring(0,5)}* do *${med.nome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
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
            return `Certo! Vou alterar o lembrete das *${schedulesAtivos[0]?.horario?.substring(0,5)}* do *${med.nome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
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
