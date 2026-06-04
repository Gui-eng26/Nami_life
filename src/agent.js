import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { NAMI_SYSTEM_PROMPT } from './prompts.js';
import {
    getOrCreateUser,
    getConversationState,
    updateConversationState,
    saveMedication,
    replaceMedication,
    saveSchedule,
    confirmDose,
    updateUserName,
    getRecentDoses,
    getUserMedications
} from './database.js';
import { sendTextMessage } from './whatsapp.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function handleIncomingMessage({ phone, text, audio, image }) {
    try {
        const user = await getOrCreateUser(phone);

        if (audio && !text) {
            console.log(`🎵 Áudio recebido de ${phone} — ignorando sem alterar estado`);
            await sendTextMessage(phone,
                'Oi! 😊 Ainda não consigo ouvir áudios, mas estou melhorando!\n\nPode me escrever o que você disse? Estou aqui pra te ajudar! 💊🌿'
            );
            return;
        }

        const state = await getConversationState(user.id);
        console.log(`📊 Estado atual de ${phone}: ${state.state}`);

        const medications = await getUserMedications(user.id);
        const recentDoses = await getRecentDoses(user.id, 3);

        const userMessage = buildUserMessage({
            text, image, user, state, medications, recentDoses
        });

        console.log(`🤖 Chamando Claude para: "${text}"`);
        let claudeResponse = await callClaude({ userMessage, image });
        console.log(`✅ Claude respondeu — newState: ${claudeResponse.newState}, action: ${claudeResponse.action?.type || 'nenhuma'}`);

        // processAction agora retorna override opcional da resposta
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

        await sendTextMessage(phone, claudeResponse.message);

    } catch (error) {
        console.error('❌ Erro no agente:', error.message);
        console.error('Stack:', error.stack);
        try {
            await sendTextMessage(phone, 'Desculpe, tive um probleminha aqui. Pode repetir o que você disse? 🌿');
        } catch (sendError) {
            console.error('❌ Erro ao enviar mensagem de erro:', sendError.message);
        }
    }
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
            return { newState: 'adding_med' };

        case 'SAVE_MEDICATION': {
            const med = await saveMedication({
                userId: user.id,
                nome: action.nome,
                dosagem: action.dosagem,
                instrucoes: action.instrucoes || null,
                estoque: action.estoque || 0
            });

            // Medicamento duplicado — retorna override para perguntar ao usuário
            if (med.isDuplicate) {
                return {
                    message:
                        `Guilherme, já tenho o *${med.nome}* cadastrado! 💊\n\n` +
                        `Cadastro atual: ${med.dosagem}, estoque: ${med.estoque_atual} unidades.\n\n` +
                        `O que prefere?\n` +
                        `1️⃣ *Substituir* — atualizar com as novas informações\n` +
                        `2️⃣ *Manter* — deixar como está`,
                    newState: 'confirming_duplicate',
                    context: {
                        medicationId: med.id,
                        nome: action.nome,
                        dosagem: action.dosagem,
                        horarios: action.horarios,
                        estoque: action.estoque
                    }
                };
            }

            // Novo medicamento — salva horários
            if (action.horarios && action.horarios.length > 0) {
                for (let horario of action.horarios) {
                    if (typeof horario === 'object') {
                        horario = horario.horario || horario.hora || Object.values(horario)[0];
                    }
                    const horarioStr = String(horario).trim().substring(0, 5);
                    await saveSchedule({ medicationId: med.id, horario: horarioStr });
                }
            }
            return null;
        }

        case 'REPLACE_MEDICATION': {
            await replaceMedication({
                medicationId: action.medicationId,
                dosagem: action.dosagem,
                instrucoes: action.instrucoes || null,
                estoque: action.estoque || 0,
                horarios: action.horarios
            });
            return null;
        }

        case 'ADD_SCHEDULE': {
            // Adiciona horários a medicamento já existente
            if (action.medicationId && action.horarios) {
                for (let horario of action.horarios) {
                    if (typeof horario === 'object') {
                        horario = horario.horario || horario.hora || Object.values(horario)[0];
                    }
                    const horarioStr = String(horario).trim().substring(0, 5);
                    await saveSchedule({ medicationId: action.medicationId, horario: horarioStr });
                }
            }
            return null;
        }

        case 'CONFIRM_DOSE':
            await confirmDose(action.medicationId);
            return null;

        default:
            console.warn(`⚠️ Ação desconhecida: ${action.type}`);
            return null;
    }
}