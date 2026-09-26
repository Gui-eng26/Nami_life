// ============================================================
// HELPERS DE NLP COMPARTILHADOS ENTRE AGENTES
// Evita duplicar listas de termos divergentes espalhadas pelo código (BUG-036).
// ============================================================

export function isCancelamento(message) {
    return /\b(não|nao|cancela|cancelar|desiste|desistir|para (de|com)|parar|esquece|esquece isso|deixa|deixa pra lá|deixa quieto|sair|chega|chega por hoje|não precisa mais|não precisa)\b/i.test(message.toLowerCase());
}

export function normalizar(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

// v44: um nome proposto pela porta "é outro medicamento" quando não bate com o
// nome do cadastro em andamento (igualdade ou continência, normalizada — mesma
// tolerância de encontrarMedicamento). Usado pelo runner (MH-83: medicamento
// diferente = cadastro novo, nada do anterior vaza).
export function medicamentoDiferente(medicamentosPropostos, nomeEmAndamento) {
    if (!nomeEmAndamento || !medicamentosPropostos || medicamentosPropostos.length === 0) return false;
    const atual = normalizar(nomeEmAndamento);
    return !medicamentosPropostos.some(m => {
        const proposto = normalizar(m);
        return proposto === atual || proposto.includes(atual) || atual.includes(proposto);
    });
}

// Commit 0 do M3 (caso Evandro): "Keppra" dito na etapa de estoque do "Kepra"
// é CORREÇÃO de grafia, nunca medicamento novo. Palavra a palavra: mesmo número
// de palavras e cada par ou é igual ou difere por edição pequena (≤2) em palavra
// com corpo (≥4 letras) — "Vitamina C" vs "Vitamina D" NÃO é correção (a
// diferença é uma palavra inteira de 1 letra), "Kepra" vs "Keppra" é.
function distanciaEdicao(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = cur;
    }
    return prev[n];
}

export function nomeCorrigidoParecido(nomeAtual, nomeNovo) {
    if (!nomeAtual || !nomeNovo) return false;
    const palavrasA = normalizar(nomeAtual).trim().split(/\s+/);
    const palavrasB = normalizar(nomeNovo).trim().split(/\s+/);
    if (palavrasA.length !== palavrasB.length) return false;
    if (palavrasA.join(' ') === palavrasB.join(' ')) return false; // igual não é correção
    return palavrasA.every((pa, i) => {
        const pb = palavrasB[i];
        if (pa === pb) return true;
        if (pa.length < 4 || pb.length < 4) return false;
        return distanciaEdicao(pa, pb) <= 2;
    });
}

// P6.4 (M3, MH-82/39): TODOS os medicamentos citados na mensagem (fronteira de
// palavra na forma normalizada) — para seleção múltipla em lote.
export function encontrarTodosMedicamentos(texto, medications) {
    if (!texto) return [];
    const t = normalizar(texto);
    return medications.filter(m => {
        const nome = normalizar(m.nome).trim();
        if (!nome) return false;
        const escapado = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|[^a-z0-9])${escapado}(?:$|[^a-z0-9])`).test(t);
    });
}

// Continência com FRONTEIRA de palavra (mesma regra da divisão multi-med) —
// replay 20/09: "mudar o nome da Vitamina de A a Z" casava com "Vitamina D"
// por substring ("vitamina d" ⊂ "vitamina de...") e renomeava o medicamento
// ERRADO. Local (não importa de multiMed) para não criar ciclo de imports.
function contemNomeComFronteira(textoNorm, nomeNorm) {
    if (!nomeNorm) return false;
    const escapado = nomeNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escapado}(?:$|[^a-z0-9])`).test(textoNorm);
}

export function encontrarMedicamento(texto, medications) {
    if (!texto) return null;
    const t = normalizar(texto).trim();

    // 1. Igualdade exata.
    const exato = medications.find(m => normalizar(m.nome).trim() === t);
    if (exato) return exato;

    // 2. Nome contido no texto COM fronteira — o nome mais LONGO vence
    //    ("Vitamina de A a Z" ganha de "Vitamina D" na mesma frase).
    const comFronteira = medications
        .filter(m => contemNomeComFronteira(t, normalizar(m.nome).trim()))
        .sort((a, b) => normalizar(b.nome).length - normalizar(a.nome).length);
    if (comFronteira.length > 0) return comFronteira[0];

    // 3. Texto curto contido no nome ("mostra a vitamina" → "Vitamina D"),
    //    comportamento legado preservado.
    return medications.find(m => normalizar(m.nome).includes(t)) || null;
}
