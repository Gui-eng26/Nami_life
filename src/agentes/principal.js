import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { NAMI_SYSTEM_PROMPT } from '../prompts.js';
import {
    getConversationState,
    updateConversationState,
    confirmDose,
    updateUserName,
    getRecentDoses,
    getUserMedications,
    updateMedicationStock,
    getEstoqueInfoParaAlerta,
    contarConfirmacoesHoje,
    calcularAlertaEstoque,
    registrarNaoTomado
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

export async function handlePrincipal({ user, message, image }) {
    const state = await getConversationState(user.id);
    console.log(`📊 Estado atual de ${user.phone}: ${state.state}`);

    const medications = await getUserMedications(user.id);
    const recentDoses = await getRecentDoses(user.id, 3);

    const userMessage = buildUserMessage({ text: message, image, user, state, medications, recentDoses });

    console.log(`🤖 Chamando Claude para: "${message}"`);
    let claudeResponse = await callClaude({ userMessage, image });
    console.log(`✅ Claude respondeu — newState: ${claudeResponse.newState}, action: ${claudeResponse.action?.type || 'nenhuma'}`);

    if (claudeResponse.action) {
        const override = await processAction(claudeResponse.action, user);
        if (override) {
            if (override.alertaEstoque) {
                claudeResponse = {
                    ...claudeResponse,
                    message: claudeResponse.message + override.alertaEstoque
                };
            } else {
                claudeResponse = { ...claudeResponse, ...override };
            }
        }
    }

    await updateConversationState(
        user.id,
        claudeResponse.newState || 'idle',
        claudeResponse.context || {}
    );

    return claudeResponse.message;
}

function buildUserMessage({ text, image, user, state, medications, recentDoses }) {
    const context = `
=== CONTEXTO DO USUÁRIO ===
Nome: ${user.name || 'ainda não informado'}
Estado da conversa: ${state.state}
Dados parciais em andamento: ${JSON.stringify(state.context)}

Medicamentos cadastrados: ${medications.length === 0
        ? 'nenhum ainda'
        : medications.map(m => {
            const horarios = m.schedules && m.schedules.length > 0
                ? m.schedules.filter(s => s.ativo).map(s => s.horario).join(', ')
                : 'nenhum horário cadastrado';

            let tratamentoInfo = `tipo: ${m.tipo_tratamento || 'contínuo'}`;
            if (m.tratamento_dias) {
                const inicio = new Date(m.created_at);
                const agora = new Date();
                const diasDecorridos = Math.floor((agora - inicio) / (1000 * 60 * 60 * 24));
                const diasRestantes = Math.max(0, m.tratamento_dias - diasDecorridos);
                const dosesPerDia = (m.schedules || []).filter(s => s.ativo).length || 1;
                    const dosesTotais = m.tratamento_dias * dosesPerDia;
                    const dosesRestantesEstimadas = diasRestantes * dosesPerDia;
                    tratamentoInfo += `, duração total: ${m.tratamento_dias} dias, doses totais do tratamento: ${dosesTotais}, dias decorridos desde o início: ${diasDecorridos}, dias restantes: ${diasRestantes}, doses restantes estimadas: ${dosesRestantesEstimadas}`;
            }

            return `[id:${m.id}] ${m.nome} (${m.dosagem}, estoque: ${m.estoque_atual}, horários: ${horarios}, ${tratamentoInfo})`;
        }).join(' | ')
    }

Doses recentes: ${recentDoses.length === 0
        ? 'nenhuma ainda'
        : JSON.stringify(recentDoses.slice(0, 5))
    }
=== FIM DO CONTEXTO ===

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

        case 'CONFIRM_DOSE':
            await confirmDose(action.medicationId);

            // Verificar se deve emitir alerta de estoque pós-confirmação
            try {
                const estoqueInfo = await getEstoqueInfoParaAlerta(action.medicationId);
                if (estoqueInfo) {
                    const confirmacoesDoDia = await contarConfirmacoesHoje(action.medicationId);
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
