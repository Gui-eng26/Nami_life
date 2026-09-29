// ============================================================
// CONTRATO DA DECISÃO DO PRINCIPAL — v45 P1-ajustes 3 §1.2
//
// Definição ÚNICA dos tipos de decisão e das regras de cada um (o que é
// obrigatório, o que pode ficar vazio). Lida por DOIS consumidores:
//   - o prompt do principal (textoDosTipos / textoDasRegras, em prompts.js);
//   - o validador (violacaoDoContrato, em agentes/principal.js).
// Nenhuma regra de tipo é escrita à mão em só um dos dois: o P1-ajustes 2
// mudou o prompt ("deixe message vazia" no estoque) sem mudar o validador,
// e o turno só de estoque degradou em "não entendi" (staging, 29/09).
// ============================================================

// P1-copy §3: `ainda_nao` = a dose segue aguardando (nada é gravado).
export const FATOS = ['tomou', 'nao_tomou', 'ainda_nao', 'desfazer'];

// Ações do domínio do principal. `textoDoCodigo`: o código escreve o fato
// dessa ação (a `message` do principal não é usada no turno).
export const ACOES = {
    UPDATE_STOCK: { textoDoCodigo: true },
    SET_USER_NAME: { textoDoCodigo: false }
};

const temMessage = (d) => typeof d.message === 'string' && !!d.message.trim();
const temTextoDoCodigo = (d) => (d.actions || []).some(a => ACOES[a?.type]?.textoDoCodigo);

// Cada tipo: descrição (vai ao prompt) e regras (vão ao prompt E ao validador).
export const TIPOS_DECISAO = [
    {
        tipo: 'responder',
        descricao: 'você mesma responde (conversa, dúvida, consulta que o contexto já responde).',
        regras: [
            { texto: '"message" obrigatória', ok: temMessage }
        ]
    },
    {
        tipo: 'dose',
        descricao: 'a pessoa relatou o que aconteceu com uma ou mais doses do bloco DOSES.',
        regras: [
            { texto: '"doses" com pelo menos um fato; "message" pode ficar vazia (confirmação pura)', ok: d => d.doses.length > 0 }
        ]
    },
    {
        tipo: 'acao',
        descricao: 'a pessoa pediu algo do SEU DOMÍNIO que o código executa e escreve (UPDATE_STOCK, SET_USER_NAME) — ex.: "Comprei mais 20 do Decadron", "tenho 20 em estoque".',
        regras: [
            { texto: '"actions" com pelo menos uma ação', ok: d => d.actions.length > 0 },
            { texto: 'com UPDATE_STOCK, "message" vazia (o texto é do sistema; se vier, é ignorado); com SET_USER_NAME sozinho, "message" obrigatória', ok: d => temTextoDoCodigo(d) || temMessage(d) }
        ]
    },
    {
        tipo: 'delegar',
        descricao: 'o pedido é de um especialista (cadastro, configuração, relatórios, exclusão de conta) ou é algo que a Nami ainda não faz (nao_suportado).',
        regras: [
            { texto: '"delegar.especialista" preenchido; "message" vazia (se vier, é ignorada)', ok: (d, ctx) => ctx.especialistas.includes(d.delegar?.especialista) }
        ]
    },
    {
        tipo: 'perguntar',
        descricao: 'não dá para saber a qual dose (ou a qual das pendências) a pessoa se refere.',
        regras: [
            { texto: '"message" obrigatória (a pergunta)', ok: temMessage }
        ]
    }
];

export const TIPOS = TIPOS_DECISAO.map(t => t.tipo);

// Regras que valem para qualquer tipo.
export const REGRAS_GERAIS = [
    {
        texto: 'especialista "nao_suportado": "pedido" ou "chave_ainda_nao" preenchido; "message" vazia (o texto do "ainda não" é do sistema; se vier, é ignorado)',
        ok: (d, ctx) => d.delegar?.especialista !== 'nao_suportado'
            || ctx.chavesAindaNao.includes(d.delegar?.chave_ainda_nao)
            || (typeof d.delegar?.pedido === 'string' && !!d.delegar.pedido.trim())
    },
    {
        texto: 'dose com "nao_tomou" ou "ainda_nao": "message" obrigatória (o acolhimento é seu)',
        ok: d => !d.doses.some(x => x.fato === 'nao_tomou' || x.fato === 'ainda_nao') || temMessage(d)
    }
];

// Devolve null se a decisão cumpre o contrato; senão, o texto da regra violada.
export function violacaoDoContrato(input, { especialistas = [], chavesAindaNao = [] } = {}) {
    if (!input || typeof input.message !== 'string') return 'decisão sem "message" (string)';
    const def = TIPOS_DECISAO.find(t => t.tipo === input.tipo);
    if (!def) return `tipo desconhecido: ${input.tipo}`;
    if (!Array.isArray(input.doses)) return '"doses" não é lista';
    if (input.doses.some(x => !x?.ref || !FATOS.includes(x.fato))) return 'dose sem ref ou com fato desconhecido';
    const d = { ...input, actions: Array.isArray(input.actions) ? input.actions : [] };
    const ctx = { especialistas, chavesAindaNao };
    for (const regra of [...def.regras, ...REGRAS_GERAIS]) {
        if (!regra.ok(d, ctx)) return `${input.tipo}: ${regra.texto}`;
    }
    return null;
}

// Texto do prompt — gerado da mesma definição.
export function textoDosTipos() {
    return TIPOS_DECISAO.map(t => `- "${t.tipo}": ${t.descricao}`).join('\n');
}

export function textoDasRegras() {
    return [
        ...TIPOS_DECISAO.map(t => `- "${t.tipo}": ${t.regras.map(r => r.texto).join('; ')}.`),
        ...REGRAS_GERAIS.map(r => `- ${r.texto}.`)
    ].join('\n');
}
