// ============================================================
// CHAMADA DE CLASSIFICADOR LLM COM PARSE DE JSON — ponto único (P30)
//
// v44 M2: os classificadores do cadastro mudaram de endereço
// (agentes/cadastro.js → validadores/) e o padrão repetido de
// parse+degradação foi consolidado aqui. Os PROMPTS não mudaram —
// classificador com histórico de casos de borda muda de endereço,
// não de lógica (briefing M2 §1).
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { degradar } from '../observabilidade.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Chama o modelo com um system prompt de classificação e devolve o JSON
// parseado, ou o fallback via degradar() quando o parse falha (P31).
export async function classificarJSON({ systemPrompt, message, maxTokens = 200, temperature = null, motivo, agent = 'cadastro', detalheExtra = {}, fallback }) {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        ...(temperature !== null ? { temperature } : {}),
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error(`❌ validador: classificador (${motivo}) não retornou JSON válido:`, rawText);
        return {
            parsed: await degradar({
                origem: 'cadastro',
                motivo,
                agent,
                detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length, ...detalheExtra },
                fallback
            }),
            degradado: true
        };
    }

    return { parsed, degradado: false };
}

// Classificador de palavra única (ex.: recusa/duvida/nova_intencao/ruido).
export async function classificarPalavra({ systemPrompt, message, maxTokens = 8, validos, motivo, detalheExtra = {}, fallback }) {
    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: message || '' }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        return validos.find(v => texto.includes(v)) || fallback;
    } catch (e) {
        console.error(`❌ validador: erro no classificador de palavra (${motivo}): ${e.message}`);
        return await degradar({
            origem: 'cadastro',
            motivo,
            agent: 'cadastro',
            detalhe: { erro: e.name, status: e?.status ?? null, ...detalheExtra },
            fallback
        });
    }
}
