import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { NAMI_SYSTEM_PROMPT } from '../prompts.js';
import {
    getConversationState,
    updateConversationState,
    confirmDose,
    confirmDoseByLogId,
    updateUserName,
    getRecentDoses,
    getUserMedications,
    updateMedicationStock,
    getEstoqueInfoParaAlerta,
    contarConfirmacoesHoje,
    calcularAlertaEstoque,
    registrarNaoTomado,
    calcularProximaDose,
    formatarHistoricoConversa
} from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildAlertaEstoqueMessage(info) {
    const { medNome, novoEstoque, diasRestantes } = info;

    if (diasRestantes === 0) {
        return (
            `\n\n⚠️ *Atenção:* você acabou de tomar o último comprimido do *${medNome}* disponível. ` +
            `Não esqueça de providenciar a recompra!\n` +
            `Quando comprar, me avise: *"Comprei 30 comprimidos de ${medNome}"* 💊`
        );
    }

    const prazo = diasRestantes === 1
        ? 'mais *1 dia*'
        : `mais *${diasRestantes} dias*`;

    return (
        `\n\n⚠️ *Lembrete de estoque:* você tem *${novoEstoque}* ${novoEstoque === 1 ? 'unidade' : 'unidades'} ` +
        `do *${medNome}* — suficiente para ${prazo}. ` +
        `Bom momento para planejar a recompra! 💊`
    );
}

export async function handlePrincipal({ user, message, image, historicoConversa = [], intencaoNaoSuportada = false }) {
    const state = await getConversationState(user.id);
    console.log(`📊 Estado atual de ${user.phone}: ${state.state}`);

    const medications = await getUserMedications(user.id);
    const recentDoses = await getRecentDoses(user.id, 3);

    const userMessage = buildUserMessage({ text: message, image, user, state, medications, recentDoses, historicoConversa, intencaoNaoSuportada });

    console.log(`🤖 Chamando Claude para: "${message}"`);
    let claudeResponse = await callClaude({ userMessage, image });
    const acoesTipos = (claudeResponse.actions || []).map(a => a.type).join(', ') || claudeResponse.action?.type || 'nenhuma';
    console.log(`✅ Claude respondeu — newState: ${claudeResponse.newState}, actions: ${acoesTipos}`);

    // Compatibilidade: aceita tanto o formato novo (actions: array)
    // quanto o formato antigo (action: objeto único)
    let listaAcoes = [];
    if (Array.isArray(claudeResponse.actions)) {
        listaAcoes = claudeResponse.actions;
    } else if (claudeResponse.action) {
        listaAcoes = [claudeResponse.action];
    }

    // Processa todas as ações em sequência.
    // Alertas de estoque de cada confirmação são acumulados e anexados à mensagem.
    let alertasEstoque = '';
    for (const acao of listaAcoes) {
        const override = await processAction(acao, user);
        if (override) {
            if (override.alertaEstoque) {
                alertasEstoque += override.alertaEstoque;
            } else {
                claudeResponse = { ...claudeResponse, ...override };
            }
        }
    }
    if (alertasEstoque) {
        claudeResponse = {
            ...claudeResponse,
            message: claudeResponse.message + alertasEstoque
        };
    }

    await updateConversationState(
        user.id,
        claudeResponse.newState || 'idle',
        claudeResponse.context || {}
    );

    return claudeResponse.message;
}

function buildUserMessage({ text, image, user, state, medications, recentDoses, historicoConversa = [], intencaoNaoSuportada = false }) {
    const dosesPendentes = recentDoses.filter(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'nao_informado' &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado' &&
        d.status !== 'sem_estoque'
    );

    const blocoPendentes = dosesPendentes.length === 0
        ? 'Nenhuma dose aguardando confirmação no momento.'
        : dosesPendentes.map(d => {
            const nome = d.medications?.nome || 'medicamento';
            const hora = new Date(d.scheduled_at).toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            return `⚠️ ${nome} — dose das ${hora} [ref: ${d.id}]`;
        }).join('\n');

    const context = `
=== CONTEXTO DO USUÁRIO ===
Nome: ${user.name || 'ainda não informado'}
Estado da conversa: ${state.state}
Dados parciais em andamento: ${JSON.stringify(state.context)}

Medicamentos cadastrados: ${medications.length === 0
        ? 'nenhum ainda'
        : medications.map(m => {
            const schedulesAtivos = m.schedules ? m.schedules.filter(s => s.ativo) : [];
            const horarios = schedulesAtivos.length > 0
                ? schedulesAtivos.map(s => s.horario).join(', ')
                : 'nenhum horário cadastrado';

            const proximaDose = calcularProximaDose(schedulesAtivos);
            const proximaDoseStr = proximaDose
                ? `próxima dose: ${proximaDose.horario} (${proximaDose.quando})`
                : 'sem próxima dose calculada';

            let tratamentoInfo = `tipo: ${m.tipo_tratamento || 'contínuo'}`;
            if (m.tratamento_dias) {
                const inicio = new Date(m.created_at);
                const agora = new Date();
                const diasDecorridos = Math.floor((agora - inicio) / (1000 * 60 * 60 * 24));
                const diasRestantes = Math.max(0, m.tratamento_dias - diasDecorridos);
                const dosesPerDia = schedulesAtivos.length || 1;
                const dosesTotais = m.tratamento_dias * dosesPerDia;
                const dosesRestantesEstimadas = diasRestantes * dosesPerDia;
                tratamentoInfo += `, duração total: ${m.tratamento_dias} dias, doses totais do tratamento: ${dosesTotais}, dias decorridos desde o início: ${diasDecorridos}, dias restantes: ${diasRestantes}, doses restantes estimadas: ${dosesRestantesEstimadas}`;
            }

            return `[id:${m.id}] ${m.nome} (${m.dosagem}, estoque: ${m.estoque_atual}, horários: ${horarios}, ${proximaDoseStr}, ${tratamentoInfo})`;
        }).join(' | ')
    }

=== DOSES AGUARDANDO CONFIRMAÇÃO ===
${blocoPendentes}

Como usar este bloco:
- Se o usuário responder confirmando que tomou (qualquer forma: "sim", "tomei", "já tomei", "isso", "tomei sim", etc.), emita CONFIRM_DOSE para a(s) dose(s) correspondente(s), usando o valor [ref: ...] no campo doseLogId.
- Se houver várias doses pendentes e o usuário confirmar coletivamente ("tomei todos", "tomei os dois"), emita um CONFIRM_DOSE para cada [ref] da lista.
- Se o usuário mencionar um medicamento ou horário específico, confirme apenas a dose correspondente.
- Se o usuário falar de OUTRA coisa (estoque, horário, dúvida, "comprei mais X"), ajude normalmente com o assunto dele. NÃO force confirmação. As doses continuam pendentes e serão cobradas depois.

Doses recentes (contexto histórico): ${recentDoses.length === 0
        ? 'nenhuma ainda'
        : JSON.stringify(recentDoses.slice(0, 5))
    }

=== CONVERSA RECENTE (apenas para entender referências como "ele", "esse", "ok") ===
${formatarHistoricoConversa(historicoConversa)}

IMPORTANTE: O bloco "DOSES AGUARDANDO CONFIRMAÇÃO" acima tem PRECEDÊNCIA. Se há dose pendente e o usuário responde algo afirmativo ("sim", "tomei", etc.), isso é confirmação de dose — NUNCA trate como fechamento social, mesmo que a conversa recente sugira fim de papo. Use a CONVERSA RECENTE apenas para: (1) resolver pronomes ("dele", "esse") referindo-se ao último medicamento/assunto mencionado; (2) reconhecer fechamentos curtos ("ok", "obrigado", "entendi") como encerramento acolhedor SOMENTE quando NÃO há dose pendente.

=== FIM DO CONTEXTO ===
${intencaoNaoSuportada ? `
=== ATENÇÃO: INTENÇÃO NÃO SUPORTADA ===
O usuário pediu algo que a Nami AINDA NÃO faz. Responda com honestidade e gentileza:
- Explique que essa funcionalidade ainda está em desenvolvimento
- NÃO invente que consegue fazer
- NÃO derive para pausar/encerrar/cadastrar
- Pergunte se pode ajudar com outra coisa (cadastrar, consultar, alterar horários, pausar/reativar)
` : ''}
Mensagem do usuário: ${text || '[usuário enviou uma imagem]'}
    `.trim();
    return context;
}

async function callClaude({ userMessage, image }) {
    const content = image
        ? [
            { type: 'image', source: { type: 'url', url: image } },
            { type: 'text', text: userMessage }
        ]
        : [{ type: 'text', text: userMessage }];

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: NAMI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }]
    });

    const rawText = response.content[0].text;

    try {
        return JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch {
                console.error('❌ Falha ao extrair JSON:', rawText);
            }
        }
        console.error('❌ Claude não retornou JSON válido:', rawText);
        return {
            message: rawText.length > 10 && rawText.length < 500
                ? rawText
                : 'Desculpe, não entendi bem. Pode repetir? 🌿',
            newState: 'idle',
            context: {},
            action: null
        };
    }
}

async function processAction(action, user) {
    switch (action.type) {

        case 'SET_USER_NAME':
            await updateUserName(user.id, action.name);
            return null;

        case 'CONFIRM_DOSE': {
            let medId;
            if (action.doseLogId) {
                medId = await confirmDoseByLogId(action.doseLogId);
            } else if (action.medicationId) {
                await confirmDose(action.medicationId);
                medId = action.medicationId;
            } else {
                console.warn('⚠️ CONFIRM_DOSE sem doseLogId nem medicationId');
                return null;
            }

            // Verificar se deve emitir alerta de estoque pós-confirmação
            try {
                const estoqueInfo = await getEstoqueInfoParaAlerta(medId);
                if (estoqueInfo) {
                    const confirmacoesDoDia = await contarConfirmacoesHoje(medId);
                    const deveAlertar = calcularAlertaEstoque({
                        diasRestantes: estoqueInfo.diasRestantes,
                        tipo_tratamento: estoqueInfo.tipo_tratamento,
                        tratamento_dias: estoqueInfo.tratamento_dias,
                        confirmacoesDoDia
                    });
                    if (deveAlertar) {
                        return { alertaEstoque: buildAlertaEstoqueMessage(estoqueInfo) };
                    }
                }
            } catch (e) {
                console.error('⚠️ Erro ao verificar alerta de estoque pós-confirmação:', e.message);
            }
            return null;
        }

        case 'REGISTER_NAO_TOMADO':
            if (action.medicationId) {
                await registrarNaoTomado(action.medicationId);
                console.log(`🚫 Dose registrada como não tomada via REGISTER_NAO_TOMADO — ${action.medicationId}`);
            }
            return null;

        case 'UPDATE_STOCK':
            await updateMedicationStock(action.medicationId, action.quantidade);
            return null;

        default:
            console.warn(`⚠️ Ação desconhecida no agente principal: ${action.type}`);
            return null;
    }
}
