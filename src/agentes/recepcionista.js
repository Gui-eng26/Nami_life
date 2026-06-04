import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState, updateUser } from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LGPD_ACCEPT_KEYWORDS = ['sim', 's', 'pode', 'concordo', 'aceito', 'ok', 'claro', 'com certeza', 'yes'];

function isLgpdAccepted(message) {
    const normalized = message.toLowerCase().trim();
    return LGPD_ACCEPT_KEYWORDS.some(kw => normalized.includes(kw));
}

function buildSystemPrompt(etapa, context) {
    return `Você é a Nami, uma assistente de saúde pessoal que ajuda pessoas a não esquecerem seus medicamentos de uso contínuo.

Você está no momento de boas-vindas com um novo usuário.

Seu tom é: acolhedor, caloroso, humano, responsável e confiável.
Use linguagem natural e próxima. Não seja robótica nem excessivamente formal.
Use emojis com moderação para tornar a conversa mais leve.

Etapa atual: ${etapa}
Contexto coletado até agora: ${JSON.stringify(context)}

Instruções por etapa:

SE etapa = 'recep_boas_vindas':
  - Cumprimente o usuário com entusiasmo e calor
  - Se apresente como Nami, assistente de saúde pessoal
  - Pergunte o nome do usuário
  - Seja breve — não explique tudo ainda

SE etapa = 'recep_coleta_nome':
  - Chame o usuário pelo nome que ele informou
  - Explique brevemente o que a Nami faz:
    * Lembra dos medicamentos nos horários certos
    * Registra quando foram tomados
    * Avisa quando o estoque está acabando
    * Tudo pelo WhatsApp, sem precisar baixar nenhum app
  - Apresente os termos de uso de forma simples:
    "Para continuar, preciso guardar algumas informações suas (nome e telefone)
     para personalizar seus lembretes. Seus dados são usados só para isso e
     ficam protegidos. Você concorda?"
  - Aguarde confirmação

SE etapa = 'recep_lgpd':
  - Se o usuário confirmar: agradeça, diga que está tudo pronto
  - Diga que agora pode começar a cadastrar os medicamentos
  - Pergunte se quer começar agora
  - Se o usuário recusar: agradeça pela honestidade, diga que entende e
    que ele pode voltar quando quiser

Responda APENAS com a mensagem que deve ser enviada ao usuário.
Sem explicações, sem prefixos, sem aspas.`;
}

export async function handleRecepcionista({ user, message, context }) {
    const etapa = context?.etapa;
    let nextEtapa;
    let updatedContext = { ...context };
    let lgpdAccepted = false;

    if (!etapa) {
        nextEtapa = 'recep_boas_vindas';
        updatedContext = { etapa: 'recep_boas_vindas', nome_coletado: null };
    } else if (etapa === 'recep_boas_vindas') {
        const nome = message.trim();
        nextEtapa = 'recep_coleta_nome';
        updatedContext = { etapa: 'recep_coleta_nome', nome_coletado: nome };
    } else if (etapa === 'recep_coleta_nome' || etapa === 'recep_lgpd') {
        nextEtapa = 'recep_lgpd';
        lgpdAccepted = isLgpdAccepted(message);
        updatedContext = { ...context, etapa: 'recep_lgpd' };
    } else {
        nextEtapa = 'recep_boas_vindas';
        updatedContext = { etapa: 'recep_boas_vindas', nome_coletado: null };
    }

    const systemPrompt = buildSystemPrompt(nextEtapa, updatedContext);
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || 'Olá' }]
    });

    const responseText = response.content[0].text.trim();

    if (lgpdAccepted) {
        await updateUser(user.id, {
            name: context.nome_coletado,
            onboarded: true,
            lgpd_accepted: true,
            lgpd_accepted_at: new Date().toISOString()
        });
        await saveConversationState(user.id, { state: 'idle', context: {} });
        console.log(`✅ Recepcionista: onboarding concluído para ${user.phone}`);
    } else {
        await saveConversationState(user.id, { state: nextEtapa, context: updatedContext });
    }

    return responseText;
}
