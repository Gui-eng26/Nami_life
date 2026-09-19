// ============================================================
// ARNÊS — catálogo de asserções determinísticas (briefing v44 §3)
// Cada asserção devolve { ok, detalhe } — nunca lança.
// Asserções sobre TEXTO recebem a resposta final ao usuário;
// asserções sobre ESTADO leem o banco DEPOIS do turno.
// ============================================================

function resultado(ok, detalhe) {
    return { ok, detalhe };
}

// --- Texto -------------------------------------------------

// Constituição regra 8: no máximo uma pergunta, sozinha na última linha.
export function umaPerguntaNaUltimaLinha(texto) {
    const interrogacoes = (String(texto).match(/\?/g) || []).length;
    if (interrogacoes === 0) return resultado(true, 'sem pergunta');
    if (interrogacoes > 1) return resultado(false, `${interrogacoes} interrogações na mensagem`);
    const linhas = String(texto).split('\n').map(l => l.trim()).filter(Boolean);
    const ultima = linhas[linhas.length - 1] || '';
    return ultima.includes('?')
        ? resultado(true, 'pergunta única na última linha')
        : resultado(false, `a pergunta não está na última linha (última: "${ultima.slice(0, 60)}")`);
}

// Constituição regra 9 / padrão técnico 19: negrito do WhatsApp é UM asterisco.
export function semNegritoMarkdown(texto) {
    return String(texto).includes('**')
        ? resultado(false, 'contém "**" (negrito markdown vaza literal no WhatsApp)')
        : resultado(true, 'sem "**"');
}

export function contem(texto, regex, rotulo) {
    return regex.test(String(texto))
        ? resultado(true, `contém ${rotulo}`)
        : resultado(false, `não contém ${rotulo} (esperado ${regex})`);
}

export function naoContem(texto, regex, rotulo) {
    return regex.test(String(texto))
        ? resultado(false, `contém ${rotulo} (proibido ${regex}) — trecho: "${String(texto).match(regex)?.[0]}"`)
        : resultado(true, `não contém ${rotulo}`);
}

// Constituição regra 2 / A5: os blocos de estoque vêm de template determinístico.
// Marcadores dos templates de estoqueTemplates.js e do convite de estoque.
const MARCADORES_BLOCO_ESTOQUE = /(\*Lembrete de estoque:\*|🚨 \*Atenção:\*|⚠️ \*Atenção:\*|📦 Ainda não tenho o estoque|📦 Estoque atualizado)/g;

export function blocosDeEstoque(texto) {
    return (String(texto).match(MARCADORES_BLOCO_ESTOQUE) || []).length;
}

export function noMaximoUmBlocoDeEstoque(texto) {
    const n = blocosDeEstoque(texto);
    return n <= 1
        ? resultado(true, `${n} bloco(s) de estoque`)
        : resultado(false, `${n} blocos de estoque na mesma mensagem (máximo 1)`);
}

// O número citado no bloco de estoque tem que ser a leitura pós-escrita do banco.
export function numeroDeEstoqueConfere(texto, estoqueNoBanco) {
    const m = String(texto).match(/tem (?:mais )?\*(\d+)\*\s*unidade/);
    if (!m) return resultado(true, 'nenhum número de estoque citado');
    const citado = Number(m[1]);
    return citado === Number(estoqueNoBanco)
        ? resultado(true, `número citado (${citado}) == banco (${estoqueNoBanco})`)
        : resultado(false, `número citado (${citado}) != banco pós-escrita (${estoqueNoBanco})`);
}

// --- Banco -------------------------------------------------

export async function estadoDaConversa(db, userId, esperado) {
    const { data } = await db.from('conversation_state').select('state, context').eq('user_id', userId).single();
    const atual = data?.state || null;
    const ok = Array.isArray(esperado) ? esperado.includes(atual) : atual === esperado;
    return resultado(ok, `estado: ${atual} (esperado: ${esperado})`);
}

export async function medicamentos(db, userId, filtro = {}) {
    let q = db.from('medications').select('*, schedules(*)').eq('user_id', userId);
    if (filtro.nomeIlike) q = q.ilike('nome', filtro.nomeIlike);
    if (filtro.ativo !== undefined) q = q.eq('ativo', filtro.ativo);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
}

export async function doseLogs(db, medicationId) {
    const { data, error } = await db.from('dose_logs').select('*').eq('medication_id', medicationId);
    if (error) throw new Error(error.message);
    return data || [];
}

export async function turnosLogados(db, userId) {
    const { data, error } = await db.from('agent_logs').select('*').eq('user_id', userId).order('created_at');
    if (error) throw new Error(error.message);
    return data || [];
}
