// ============================================================
// TEMPLATES DE LEMBRETE / FOLLOW-UP / CONCLUSÃO — v47 Onda 2 (MH-100 C)
//
// Movidos POR EQUIVALÊNCIA ESTRITA de scheduler.js e agentes/lembrete.js
// (fixtures do A67 provam byte a byte). Em seguida, com aprovação do
// Guilherme (30/09), entraram as 5 melhorias de copy anotadas no relatório
// da Onda 2 — cada uma marcada "Copy 30/09" no ponto exato.
// scheduler/lembrete produzem o FATO e pedem a renderização pelo catálogo
// (templates/catalogo.js) — nunca mais montam string.
// ============================================================

import { verboDoMedicamento, verboDoGrupo } from './verbos.js';
import { linhaQuantidadeDose } from './dose.js';

function capitalize(texto) {
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// ------------------------------------------------------------
// LEMBRETE (individual) — ex-scheduler.buildReminderMessage
// ------------------------------------------------------------
export function buildReminderMessage(firstName, reminder) {
    const dosagem = reminder.med_dosagem
        ? ` — ${reminder.med_dosagem}`
        : '';
    // MH-081: get_pending_reminders faz JOIN direto em schedules — a quantidade
    // vem sempre nos lembretes, por construção. Não há caso de omissão aqui.
    // A quebra de linha já vem de linhaQuantidadeDose — não acrescentar \n aqui.
    const quantidade = linhaQuantidadeDose({
        quantidade: reminder.quantidade_por_dose,
        unidade_dose: reminder.unidade_dose,
        forma_farmaceutica: reminder.forma_farmaceutica
    });
    const verbo = verboDoMedicamento(reminder.forma_farmaceutica);

    return `⏰ Olá, ${firstName}!\n\nHora do seu *${reminder.med_nome}*${dosagem}.${quantidade}\n\n${verbo.imperativoPergunta} Responda *SIM* ou *NÃO* 💊`;
}

// ------------------------------------------------------------
// LEMBRETE AGRUPADO — ex-scheduler.buildGroupedReminderMessage
// ------------------------------------------------------------
export function buildGroupedReminderMessage(firstName, horario, grupo) {
    const verbo = verboDoGrupo(grupo.map(r => r.forma_farmaceutica));
    const lista = grupo.map(r => {
        const dosagem = r.med_dosagem ? ` — ${r.med_dosagem}` : '';
        // MH-081: sub-linha do item, recuo de 2 espaços — nunca um bullet próprio.
        const quantidade = linhaQuantidadeDose({
            quantidade: r.quantidade_por_dose,
            unidade_dose: r.unidade_dose,
            forma_farmaceutica: r.forma_farmaceutica
        }, { indentacao: '  ' });
        return `• *${r.med_nome}*${dosagem}${quantidade}`;
    }).join('\n');

    return (
        `⏰ ${firstName}, hora dos seus remédios das *${horario}*! 💊\n\n` +
        `${lista}\n\n` +
        `✅ Já ${verbo.passado} todos? Responda *SIM*\n` +
        // Copy 30/09 (Onda 2, nota 4): sem artigo no exemplo — "só o Creatina"
        // errava o gênero; "só Creatina" vale para qualquer nome.
        `💬 ${capitalize(verbo.passado)} só alguns? Me diga quais (ex: "só ${grupo[0].med_nome}")`
    );
}

// ------------------------------------------------------------
// FOLLOW-UP (individual) — ex-lembrete.buildFollowUpMessage
// ------------------------------------------------------------
export function buildFollowUpMessage(tentativa, reminder, quantidade = '') {
    const nome = reminder.user_name
        ? reminder.user_name.split(' ')[0]
        : 'você';
    // Copy 30/09 (Onda 2, nota 3): negrito só quando há NOME de remédio —
    // o genérico "seu remédio" não é um dado para destacar.
    const remedio = reminder.med_nome ? `*${reminder.med_nome}*` : null;
    const verbo = verboDoMedicamento(reminder.med_forma);

    if (tentativa === 2) {
        return (
            `⏰ ${nome}, só passando para lembrar!\n\n` +
            `Ainda não vi sua confirmação do ${remedio || 'seu remédio'}.${quantidade}\n` +
            `${verbo.imperativoPergunta} Responda *SIM* ou *NÃO* 💊`
        );
    }

    if (tentativa === 3) {
        return (
            `💊 ${nome}, último aviso de hoje!\n\n` +
            `${remedio ? `Seu ${remedio}` : 'Seu remédio'} ainda está aguardando confirmação.${quantidade}\n` +
            `${capitalize(verbo.passado)}? É só responder *SIM* ou *NÃO* 🌿`
        );
    }

    // Fallback seguro (não deveria ser chamado fora de tentativa 2 ou 3).
    // Copy 30/09 (Onda 2, nota 2): quebra de linha antes da pergunta — antes a
    // quantidade emendava na pergunta ("…1 comprimido Já tomou?").
    return `💊 ${nome}, lembrete do ${remedio || 'seu remédio'}.${quantidade}\n${verbo.imperativoPergunta} Responda *SIM* ou *NÃO*`;
}

// ------------------------------------------------------------
// FOLLOW-UP AGRUPADO — ex-scheduler.buildGroupedFollowUpMessage
// ------------------------------------------------------------
export function buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo, quantidadePorItem = new Map()) {
    const verbo = verboDoGrupo(grupo.map(r => r.med_forma));
    const lista = grupo.map(r => `• *${r.med_nome}*${quantidadePorItem.get(r.id) || ''}`).join('\n');
    const abertura = tentativa === 3
        ? `💊 ${firstName}, último aviso de hoje!`
        : `⏰ ${firstName}, só passando para lembrar!`;

    return (
        `${abertura}\n\n` +
        `Ainda não vi sua confirmação dos remédios das *${horario}*:\n` +
        `${lista}\n\n` +
        `✅ Já ${verbo.passado} todos? Responda *SIM*\n` +
        `💬 ${capitalize(verbo.passado)} só alguns? Me diga quais 🌿`
    );
}

// ------------------------------------------------------------
// ALERTA DE ESTOQUE ZERADO (na hora da dose) — ex-scheduler.buildEstoqueZeradoMessage
// ------------------------------------------------------------
export function buildEstoqueZeradoMessage(firstName, reminder) {
    return (
        // v45 P1-copy §1: desde o P1 um "SIM" a este lembrete REGISTRA a dose
        // (e o estoque vira desconhecido) — "não foi possível registrar" ficou falso.
        `⏰ ${firstName}, está na hora do seu *${reminder.med_nome}*!\n\n` +
        `Pelas minhas contas o estoque acabou — mas se você ainda tem e já tomou, é só responder SIM que eu registro. 💊\n\n` +
        `Se comprou mais, me conta quantos: *"Comprei 30 comprimidos de ${reminder.med_nome}"*`
    );
}

// ------------------------------------------------------------
// CONCLUSÃO DE TRATAMENTO — ex-scheduler.buildConclusaoTratamentoMessage
// Template determinístico (regra 2: fato pós-escrita; tom de celebração leve).
// ------------------------------------------------------------
export function buildConclusaoTratamentoMessage(firstName, med) {
    // Copy 30/09 (Onda 2, nota 1): concordância — "1 dia completinho",
    // "7 dias completinhos" (antes: "1 dia completinhos").
    const duracao = med.tratamento_dias
        ? ` — ${med.tratamento_dias} ${Number(med.tratamento_dias) === 1 ? 'dia completinho' : 'dias completinhos'}`
        : '';
    return (
        `🎉 ${firstName}, o tratamento com *${med.nome}* chegou ao fim${duracao}!\n\n` +
        `Já desliguei os lembretes dele pra você.\n\n` +
        `Se o médico estender o tratamento, é só me pedir pra cadastrar de novo. 🌿`
    );
}

// ------------------------------------------------------------
// AVISO AO CUIDADOR (follow-up esgotado) — ex-literal de lembrete.notificarCuidadores
// ------------------------------------------------------------
export function buildCuidadorFollowUpEsgotado({ nomePaciente, remedio, horario }) {
    // Copy 30/09 (Onda 2, nota 5): sem número de tentativa cravado no texto —
    // o fato é que as cobranças do dia se esgotaram sem resposta.
    return (
        `⚠️ Atenção!\n\n` +
        `*${nomePaciente}* não confirmou a dose do *${remedio}* ` +
        `que estava agendada para ${horario}.\n\n` +
        `As tentativas de hoje se esgotaram sem resposta.`
    );
}
