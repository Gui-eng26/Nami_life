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
    updateMedicationStock
} from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
            claudeResponse = { ...claudeResponse, ...override };
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
            return `[id:${m.id}] ${m.nome} (${m.dosagem}, estoque: ${m.estoque_atual}, horários: ${horarios})`;
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
            return null;

        case 'UPDATE_STOCK':
            await updateMedicationStock(action.medicationId, action.quantidade);
            return null;

        default:
            console.warn(`⚠️ Ação desconhecida no agente principal: ${action.type}`);
            return null;
    }
}
