// ============================================================
// CHAMADA DE CLASSIFICADOR LLM VIA TOOL-USE — ponto único (P30)
//
// v44 M3 P6.2: TODA saída estruturada de LLM chega por tool-use com
// schema — nunca mais JSON em texto livre (mesmo padrão da porta:
// schema + 1 retry + degradar). Zera a família parse_json_falhou;
// asserção A0 estendida: nenhum JSON.parse de saída de LLM no
// sistema. Os PROMPTS dos classificadores não mudaram (briefing
// M2 §1: classificador com histórico de borda muda de transporte,
// não de lógica).
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { degradar } from '../observabilidade.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCHEMA_LIVRE = { type: 'object' };

// Chama o modelo com tool_choice forçado e devolve o input da ferramenta.
// Duas tentativas; na segunda falha, degradar() com o fallback do chamador
// (P31: o fallback vive no retorno de quem registra a degradação).
export async function classificarComFerramenta({
    systemPrompt, message, messages = null, maxTokens = 200, temperature = null,
    model = 'claude-sonnet-4-6',
    nomeFerramenta = 'registrar_classificacao',
    descricaoFerramenta = 'Registra a classificação estruturada da mensagem.',
    schema = SCHEMA_LIVRE, validar = null,
    motivo, agent = 'cadastro', origem = 'cadastro', detalheExtra = {}, fallback
}) {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
            const response = await anthropic.messages.create({
                model,
                max_tokens: maxTokens,
                ...(temperature !== null ? { temperature } : {}),
                system: systemPrompt,
                tools: [{ name: nomeFerramenta, description: descricaoFerramenta, input_schema: schema }],
                tool_choice: { type: 'tool', name: nomeFerramenta },
                messages: messages || [{ role: 'user', content: message || '' }]
            });
            const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === nomeFerramenta);
            const input = toolUse?.input ?? null;
            if (input && (!validar || validar(input))) {
                return { parsed: input, degradado: false };
            }
            console.warn(`⚠️ [TOOL-USE] ${motivo}: entrada inválida na tentativa ${tentativa} — ${JSON.stringify(input).slice(0, 200)}`);
        } catch (e) {
            console.error(`❌ [TOOL-USE] ${motivo}: erro na tentativa ${tentativa}: ${e.message}`);
        }
    }

    return {
        parsed: await degradar({ origem, motivo, agent, detalhe: detalheExtra, fallback }),
        degradado: true
    };
}

// Assinatura preservada dos classificadores do cadastro: mesmo contrato
// ({ parsed, degradado }), transporte novo (tool-use em vez de JSON-texto).
// `schema`/`validar` opcionais: classificador com shape conhecido DECLARA o
// schema — o modelo oscila menos do que com objeto livre.
export async function classificarJSON({ systemPrompt, message, maxTokens = 200, temperature = null, motivo, agent = 'cadastro', detalheExtra = {}, fallback, schema = undefined, validar = undefined }) {
    return classificarComFerramenta({
        systemPrompt, message, maxTokens, temperature,
        ...(schema ? { schema } : {}),
        ...(validar ? { validar } : {}),
        motivo, agent, origem: 'cadastro', detalheExtra, fallback
    });
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
