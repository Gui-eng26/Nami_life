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
    adicionarSchedule,
    formatarHistoricoConversa
} from '../database.js';
import { isCancelamento, encontrarMedicamento, normalizar } from '../nlp_helpers.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// CLASSIFICAÇÃO VIA CLAUDE — única chamada LLM do agente
// ============================================================

async function classificarIntencao(message, medicamentosDisponiveis, historicoConversa = []) {
    const listaMeds = medicamentosDisponiveis.map(m => m.nome).join(', ') || 'nenhum';
    const historicoTexto = formatarHistoricoConversa(historicoConversa);

    const systemPrompt = `Você é um classificador de intenções para um assistente de saúde.
O usuário quer fazer algo com seus lembretes ou tratamentos.

Medicamentos cadastrados: ${listaMeds}

CONVERSA RECENTE:
${historicoTexto}

Responda APENAS com JSON válido, sem markdown, sem explicações:
{
  "acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "remover_horario" | "adicionar_horario" | "redefinir_horarios" | "esclarecer_pausar_encerrar" | "recusa_opcoes_oferecidas" | "nao_suportado",
  "medicamentoMencionado": "nome mencionado ou null",
  "novoHorario": "HH:MM ou null"
}

Definições:
- pausar: parar lembretes temporariamente, com intenção de retomar.
  Ex: "cancela o lembrete", "para de me lembrar", "quero pausar", "suspender os avisos", "para essa semana", "não quero ser lembrado por uns dias"

- reativar: ativar lembretes pausados.
  Ex: "volta os lembretes", "ativa de novo", "reativar", "quero retomar"

- encerrar: terminar o tratamento definitivamente.
  Ex: "não vou mais tomar", "encerrar", "encerrar tratamento", "terminei o tratamento", "já acabei de tomar esse", "não preciso mais desse remédio porque terminei"

- alterar_horario: mudar UM horário específico para outro — com ou sem horário explícito.
  Ex com horário: "muda das 8 para 9", "trocar o das 20h para 22h"
  Ex sem horário: "quero alterar horário", "mudar horário", "trocar horário"

- remover_horario: apagar um horário específico sem substituir — com ou sem horário explícito.
  Ex com horário: "tirar o das 8h", "apagar o das 20"
  Ex sem horário: "quero remover um horário", "excluir um lembrete"

- adicionar_horario: acrescentar horário novo sem mexer nos existentes — com ou sem horário explícito.
  Ex com horário: "quero tomar às 20 também", "adicionar lembrete às 14h"
  Ex sem horário: "quero adicionar um horário", "incluir mais um lembrete"

- redefinir_horarios: substituir TODOS os horários ou mudar a frequência de doses.
  Ex: "agora vou tomar 3x ao dia", "mudar para 6h, 14h e 22h", "mudar todos os horários"

- esclarecer_pausar_encerrar: USAR APENAS quando o usuário quer parar de tomar/ser lembrado, mas NÃO dá nenhuma pista se é TEMPORÁRIO (pausar) ou DEFINITIVO (encerrar).
  Ex: "quero parar com o losartana", "cancela o dipirona", "não quero mais esse remédio" (sem dizer se terminou ou se é pausa)

- recusa_opcoes_oferecidas: USAR quando a ÚLTIMA mensagem da Nami (ver CONVERSA RECENTE) apresentou
  uma lista de opções para escolher — pode ser medicamentos, horários, ou a escolha entre pausar/
  encerrar/contínuo/temporário — e a resposta do usuário rejeita TODAS essas opções sem mencionar
  nenhum assunto novo.
  Ex: "nenhum", "nenhuma", "nenhum dos dois", "nenhuma das opções", "nenhum desses", "nem um nem outro".

- nao_suportado: pedidos que a configuração não faz — alterar tempo/duração de tratamento, alterar dosagem, alterar nome do medicamento.
  Ex: "mudar o tempo de tratamento", "alterar a dosagem", "trocar o nome do remédio", "mudar de 7 dias para 10 dias"

REGRAS DE DECISÃO:
1. Se o verbo é claro (encerrar, pausar, alterar, remover, adicionar, redefinir, reativar) → retorne a ação diretamente. NUNCA use esclarecer nesses casos.
2. "Encerrar" sozinho = encerrar. "Pausar" sozinho = pausar. Não exija a palavra "tratamento".
3. Se o usuário quer parar MAS dá pista temporal:
   - pista de definitivo ("já terminei", "acabou", "não preciso mais porque terminei") → encerrar
   - pista de temporário ("essa semana", "por uns dias", "por enquanto") → pausar
4. Só use esclarecer_pausar_encerrar quando quer parar e NÃO há nenhuma pista temporal.
5. Intenção de horário sem detalhes → classifique pelo tipo de operação, nunca esclarecer.
6. Se o pedido é sobre algo que a configuração não suporta (dosagem, tempo de tratamento, nome do medicamento) → nao_suportado.
7. Se a última pergunta da Nami ofereceu uma lista de opções (medicamentos, horários, ou
   pausar/encerrar/contínuo/temporário) e a resposta rejeita todas sem introduzir assunto novo
   → recusa_opcoes_oferecidas. NUNCA confunda com reafirmar a ação anterior.`;

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
        return { acao: 'esclarecer_pausar_encerrar', medicamentoMencionado: null, novoHorario: null };
    }
}

// ============================================================
// HELPERS DETERMINÍSTICOS
// ============================================================

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

// Converte linguagem natural em HH:MM sem depender de lista de schedules.
// Usado em obter_horario (adicionar novo horário) onde o horário não existe ainda.
function interpretarHorarioLivre(message) {
    const msg = message.toLowerCase().trim();

    // 1. Formato numérico explícito (HH:MM ou HHhMM) — pega o último (destino)
    const matchesNumericos = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (matchesNumericos.length > 0) {
        const m = matchesNumericos[matchesNumericos.length - 1];
        let hora = parseInt(m[1]);
        const min = m[2] || '00';
        if (/(da\s*tarde|da\s*noite|de\s*noite|pm)/i.test(msg) && hora < 12) hora += 12;
        if (hora >= 0 && hora <= 23) {
            return `${String(hora).padStart(2, '0')}:${min.padStart(2, '0')}`;
        }
    }

    // 2. Número isolado com período (ex: "3 da tarde", "8 da noite", "9 da manhã")
    const matchPeriodo = msg.match(/(\d{1,2})\s*(da\s*manh[aã]|de\s*manh[aã]|da\s*tarde|da\s*noite|de\s*noite|am|pm)/i);
    if (matchPeriodo) {
        let hora = parseInt(matchPeriodo[1]);
        const periodo = matchPeriodo[2].toLowerCase();
        const ehTardeNoite = /tarde|noite|pm/.test(periodo);
        if (ehTardeNoite && hora < 12) hora += 12;
        if (/manh[aã]|am/.test(periodo) && hora === 12) hora = 0;
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    // 3. Número com "h" isolado (ex: "14h", "8h")
    const matchHora = msg.match(/(\d{1,2})\s*h(?:oras?)?$/i);
    if (matchHora) {
        const hora = parseInt(matchHora[1]);
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    // 4. Número puro isolado (ex: "15", "8") — assume 24h
    const matchIsolado = msg.match(/^(\d{1,2})$/);
    if (matchIsolado) {
        const hora = parseInt(matchIsolado[1]);
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    // 5. Expressões nomeadas
    if (/meio.?dia/i.test(msg)) return '12:00';
    if (/meia.?noite/i.test(msg)) return '00:00';

    return null;
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

function sobrouConteudoAlemDoNome(message, medNome) {
    const semPontuacao = (s) => s.replace(/[^\w\s]/g, '').trim();
    const restante = semPontuacao(normalizar(message))
        .replace(semPontuacao(normalizar(medNome)), '')
        .replace(/\s+/g, ' ')
        .trim();
    return restante.length > 0;
}

// "Parar a dipirona" cita um remédio — isso é intenção de encerrar tratamento,
// não desistência da operação. Só aceita como cancelamento puro quando a
// mensagem não menciona nenhum medicamento conhecido.
function isCancelamentoGenuino(message, medicationsAtivos) {
    return isCancelamento(message) && !encontrarMedicamento(message, medicationsAtivos);
}

function isConfirmacao(message) {
    const msg = message.toLowerCase().trim();
    const termos = ['sim', 's', 'ok', 'pode', 'claro', 'confirmar', 'confirmo', 'vai', 'vamos', 'isso'];
    return termos.some(t => msg === t || msg.startsWith(t + ' '));
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

// ── HELPER: classifica a intenção da mensagem atual (via classificarIntencao)
// e decide o próximo passo — usado pela entrada fresca em identif_intencao E
// por qualquer outra etapa que precise reconfirmar se a intenção mudou.
async function processarIntencaoOuEscalar({ user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa, context }) {
    if (context.medicationId && isCancelamentoGenuino(message, medicationsAtivos)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos, historicoConversa);

    if (medicationsAtivos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
    }

    // Rede de segurança do classificador interno — não decide mais sozinho se é
    // "não suportado de verdade" ou "suportado por outro agente". Escala pro
    // classificador central em vez de responder direto.
    if (acao === 'nao_suportado') {
        return { escalarParaRoteador: true };
    }

    if (acao === 'recusa_opcoes_oferecidas') {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }

    // Intenção de parar sem pista temporal → perguntar se quer pausar ou encerrar
    if (acao === 'esclarecer_pausar_encerrar') {
        const medNaMensagemAtual = encontrarMedicamento(message, medicationsAtivos);
        const med = medNaMensagemAtual
            || (context.medicationId ? medicationsAtivos.find(m => m.id === context.medicationId) : null)
            || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);
        const nomeExibir = med?.nome || medicamentoMencionado || context.medicationNome || 'esse medicamento';
        await saveConversationState(user.id, {
            state: 'configurando',
            context: {
                etapa: 'identif_intencao',
                medicationId: med?.id || null,
                medicationNome: nomeExibir,
                schedulesAtivos: med ? (med.schedules || []).filter(s => s.ativo) : []
            }
        });
        return `Entendido, ${firstName}! Sobre o *${nomeExibir}*, você quer:\n\n• *Pausar* os lembretes (temporário — pode retomar depois)\n• *Encerrar* o tratamento definitivamente\n\nO que prefere?`;
    }

    // Medicamento já identificado no contexto (vem de esclarecer_pausar_encerrar anterior ou de outro fluxo)
    const medNaMensagemAtual = encontrarMedicamento(message, medicationsAtivos);
    const medDoContexto = context.medicationId
        ? medicationsAtivos.find(m => m.id === context.medicationId)
        : null;
    const med = medNaMensagemAtual || medDoContexto
        || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);
    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message });
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleConfiguracao({ user, message, state, context, historicoConversa = [] }) {
    const etapa = context?.etapa || 'identif_intencao';
    const firstName = user.name?.split(' ')[0] || 'você';
    const medications = await getUserMedications(user.id);
    const medicationsAtivos = medications.filter(m => m.ativo !== false);
    const temScheduleAtivo = m => (m.schedules || []).some(s => s.ativo);
    const medicamentosComSchedule = medications.filter(m => m.ativo && temScheduleAtivo(m));
    const medicamentosPausados = medications.filter(m => m.ativo && !temScheduleAtivo(m));

    console.log(`⚙️ Configuração — etapa: ${etapa} — ${user.phone}`);

    // ── ETAPA 1: Classificar intenção via Claude ─────────────────────────────
    if (etapa === 'identif_intencao') {
        return await processarIntencaoOuEscalar({ user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa, context });
    }

    // ── ETAPA 3: Usuário especifica qual medicamento ──────────────────────────
    if (etapa === 'identif_medicamento') {
        const med = encontrarMedicamento(message, medicationsAtivos);
        const listaParaMostrar = context.acao === 'reativar' ? medicamentosPausados : medicamentosComSchedule;

        if (!med) {
            if (isCancelamento(message)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }

        const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);

        // A mensagem trouxe mais do que só o nome do remédio? Pode ser mudança de
        // intenção ("quero parar o Neosaldina" em vez de só "Neosaldina") — reaproveita
        // o mesmo classificador/escalada de identif_intencao em vez de seguir cego
        // com a ação que já estava fixada no contexto.
        if (sobrouConteudoAlemDoNome(message, med.nome)) {
            return await processarIntencaoOuEscalar({
                user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa,
                context: { etapa: 'identif_intencao', medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
            });
        }

        const { acao, novoHorario } = context;
        return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, schedulesAtivos });
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
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
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
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
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
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }

        const horariosUnicos = [...new Set(matches)];
        const ctx = { ...context, etapa: 'confirm_acao', novosHorarios: horariosUnicos };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // ── ETAPA 5: Obter o novo horário ────────────────────────────────────────
    if (etapa === 'obter_horario') {
        const novoHorario = interpretarHorarioLivre(message);
        if (!novoHorario) {
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }
        const newCtx = { ...context, etapa: 'confirm_acao', novoHorario };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 6: Confirmar e executar ────────────────────────────────────────
    if (etapa === 'confirm_acao') {
        const negacaoPresente = /\b(não|nao)\b/i.test(message.toLowerCase());
        const horarioCorrecao = interpretarHorarioLivre(message);

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
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
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
                if (isCancelamentoGenuino(message, medicationsAtivos)) {
                    await saveConversationState(user.id, { state: 'idle', context: {} });
                    return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
                }
                return { escalarParaRoteador: true };
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
                if (isCancelamentoGenuino(message, medicationsAtivos)) {
                    await saveConversationState(user.id, { state: 'idle', context: {} });
                    return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
                }
                return { escalarParaRoteador: true };
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
async function continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, schedulesAtivos }) {
    const acaoTexto = {
        'alterar_horario':    'alterar o horário de',
        'remover_horario':    'remover um horário de',
        'adicionar_horario':  'adicionar um horário para',
        'redefinir_horarios': 'redefinir os horários de',
        'pausar':             'pausar',
        'reativar':           'reativar',
        'encerrar':           'encerrar o tratamento de'
    };

    // Sem medicamento identificado
    if (!med) {
        const listaParaMostrar = acao === 'reativar' ? medicamentosPausados : medicamentosComSchedule;
        if (listaParaMostrar.length === 1) {
            med = listaParaMostrar[0];
        } else {
            const lista = listaParaMostrar.map(m => `• ${m.nome}`).join('\n');
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_medicamento', acao, novoHorario }
            });
            return `Qual medicamento você quer ${acaoTexto[acao] || 'configurar'}?\n\n${lista}`;
        }
    }

    schedulesAtivos = schedulesAtivos || (med.schedules || []).filter(s => s.ativo);

    // remover_horario
    if (acao === 'remover_horario') {
        if (schedulesAtivos.length <= 1) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_intencao', medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
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
