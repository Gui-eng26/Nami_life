// ============================================================
// DECISÃO DE ESTADO PÓS-ONBOARDING (MH-072 Parte A, classificador na Parte B)
// Extraído de recepcionista.js (bloco if (lgpdAccepted), v3-v29) para ponto nomeado
// único, chamado agora só por data_nascimento.js ao fechar a coleta de nascimento.
//
// MH-072 Parte B, item 6: a lista de palavras-chave que decidia adding_med vs.
// post_onboarding (mesma família de pareceNome(), princípio 14 — "Quero começar",
// "vamos lá", "pode ser" não estavam na lista e caíam no post_onboarding errado)
// foi substituída por um classificador semântico sobre mensagem_inicial.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState } from './database.js';
import { degradar } from './observabilidade.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fallback 'outro' — destino mais seguro: post_onboarding acolhe qualquer
// intenção, adding_med sem sinal claro empurraria a pessoa pra um cadastro que
// ela não pediu.
async function classificarDestinoPosOnboarding(mensagemInicial) {
    const systemPrompt = `Você é um classificador para o fim do onboarding de uma assistente de saúde via WhatsApp (a Nami).

A mensagem abaixo é a primeira mensagem que a pessoa enviou, antes de todo o processo de onboarding (nome, LGPD, data de nascimento). Classifique se ela indica intenção de cadastrar um medicamento em UMA destas categorias:

- cadastro: a mensagem indica pedido de uso — cadastrar remédio, pedir ajuda com medicamentos, ou mencionar remédio/tratamento/posologia de forma ativa. Ex: "quero cadastrar losartana", "me ajuda com meus remédios", "vamos lá", "quero começar", "pode ser", "preciso registrar minha metformina".
- outro: qualquer outra coisa — curiosidade, saudação, ou mensagem sem intenção clara de cadastro. Ex: "oi", "o que você faz?", "me mandaram esse número".

MENSAGEM: "${mensagemInicial}"

Responda APENAS com uma palavra: cadastro ou outro. Sem pontuação, sem explicação.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: systemPrompt,
            messages: [{ role: 'user', content: mensagemInicial || 'Olá' }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        const validos = ['cadastro', 'outro'];
        const achado = validos.find(v => texto.includes(v));
        console.log(`✅ [POS-ONBOARDING] Classificador de destino: "${mensagemInicial}" -> ${achado || 'outro (fallback)'}`);
        return achado || 'outro';
    } catch (e) {
        console.error(`❌ [POS-ONBOARDING] Erro no classificador de destino: ${e.message} — assumindo outro`);
        return await degradar({
            origem: 'estado_pos_onboarding',
            motivo: 'classificador_destino_falhou',
            agent: 'estado_pos_onboarding',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: 'outro'
        });
    }
}

export async function definirEstadoPosOnboarding(user, mensagemInicial) {
    const destino = await classificarDestinoPosOnboarding(mensagemInicial || '');

    if (destino === 'cadastro') {
        await saveConversationState(user.id, {
            state: 'adding_med',
            context: { etapa: 'cad_nome' }
        });
        console.log(`✅ Pós-onboarding: roteando para cadastro (${user.phone})`);
    } else {
        await saveConversationState(user.id, { state: 'post_onboarding', context: {} });
        console.log(`✅ Pós-onboarding: aguardando intenção (${user.phone})`);
    }
}
