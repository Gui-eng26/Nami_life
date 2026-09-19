// ============================================================
// VALIDADORES DE CAMPO SIMPLES (v44 M2 — endereço novo dos
// classificadores de nome/dosagem e tipo de tratamento; a LÓGICA
// não mudou)
// ============================================================

import { formatarHistoricoConversa } from '../database.js';
import { classificarJSON } from './llm.js';

// ACH-4 / regra 7 (caso Caltrat 19/09): dosagem pura NUNCA vira nome de
// medicamento, e dosagem só é aceita quando tem formato reconhecível
// (número + unidade). Ponto único do formato.
const RE_DOSAGEM_PURA = /^[\d.,\s]+\s*(mg|mcg|g|ml|%|ui|u)(\/ml)?s?\.?$/i;

export function ehDosagemPura(valor) {
    return RE_DOSAGEM_PURA.test(String(valor).trim());
}

// ACH-4: dosagem tem que ser número+unidade reconhecível ("1000mg", "0,5%",
// "100mg/ml") — texto sem número ou sem unidade não é dosagem.
export function ehDosagemReconhecivel(valor) {
    return /\d/.test(String(valor)) && /(mg|mcg|g|ml|%|ui|u)(\/ml)?s?\.?\s*$/i.test(String(valor).trim());
}

function buildCampoSimplesSystemPrompt({ campo, historicoConversa, message }) {
    const descricao = campo === 'nome'
        ? 'o NOME do medicamento'
        : 'a DOSAGEM do medicamento (a concentração, como vem no rótulo — ex: 50mg, 0,5%, 100mg/ml)';

    return `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami), que está
cadastrando um medicamento e perguntou ${descricao}.

CATEGORIAS (escolha exatamente UMA):
- valor: a mensagem contém ${descricao}. Extraia o valor tal como a pessoa escreveu (mantendo
  unidade quando houver, ex: "50mg").
- indeterminado: a mensagem não responde à pergunta, é confusa, ou é sobre outra coisa.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "categoria": "...", "valor": null }`;
}

export async function extrairCampoSimples({ campo, message, historicoConversa = [] }) {
    const { parsed, degradado } = await classificarJSON({
        systemPrompt: buildCampoSimplesSystemPrompt({ campo, historicoConversa, message }),
        message, maxTokens: 200,
        motivo: 'classificador_campo_simples_falhou',
        detalheExtra: { campo },
        fallback: null
    });
    if (degradado || !parsed) return { categoria: 'indeterminado', valor: null };

    const categoria = parsed.categoria === 'valor' && typeof parsed.valor === 'string' && parsed.valor.trim()
        ? 'valor'
        : 'indeterminado';

    console.log(`🔎 [CAD-CLASSIF] extrairCampoSimples -> ${categoria} (campo: ${campo})`);
    return { categoria, valor: categoria === 'valor' ? parsed.valor.trim() : null };
}

function buildTipoTratamentoSystemPrompt({ nomeMedicamento, aguardandoDias, historicoConversa, message }) {
    return `Você é um classificador de tipo de tratamento para uma assistente de saúde via WhatsApp (a
Nami). A Nami perguntou se o uso do medicamento "${nomeMedicamento || ''}" é contínuo ou
temporário${aguardandoDias ? ', e o usuário já respondeu que é temporário — agora ela está esperando por quantos dias' : ''}.

CATEGORIAS (escolha exatamente UMA):
- continuo: o usuário indicou uso contínuo, sem prazo de parada. Ex: "é contínuo", "uso pra
  sempre", "não tem previsão de parar".
- dias: o usuário informou um número de dias (implica tratamento temporário), mesmo sem dizer a
  palavra "temporário". Ex: "10 dias", "é por 7 dias", "uma semana" (=7), "duas semanas" (=14).
- temporario: o usuário indicou que é temporário mas NÃO informou quantos dias.
- indeterminado: a resposta não permite decidir nenhuma das categorias acima.

Números por extenso e expressões de tempo contam: "uma semana" = 7 dias, "duas semanas" = 14 dias,
"um mês" = 30 dias.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "categoria": "...", "dias": null }`;
}

export async function classificarTipoTratamento({ message, nomeMedicamento, aguardandoDias, historicoConversa = [] }) {
    const { parsed, degradado } = await classificarJSON({
        systemPrompt: buildTipoTratamentoSystemPrompt({ nomeMedicamento, aguardandoDias, historicoConversa, message }),
        message, maxTokens: 200,
        motivo: 'classificador_tipo_tratamento_falhou',
        fallback: null
    });
    if (degradado || !parsed) return { categoria: 'indeterminado', dias: null };

    const categoriasValidas = new Set(['continuo', 'dias', 'temporario', 'indeterminado']);
    let categoria = categoriasValidas.has(parsed.categoria) ? parsed.categoria : 'indeterminado';

    let dias = Number(parsed.dias);
    dias = Number.isFinite(dias) && dias > 0 ? dias : null;
    if (categoria === 'dias' && dias === null) categoria = 'indeterminado';

    console.log(`🔎 [CAD-CLASSIF] classificarTipoTratamento -> ${categoria} (dias: ${dias})`);
    return { categoria, dias };
}
