// ============================================================
// COMPOSITOR MODO-TURNO — v47 Onda 1 (MH-100 parte B)
//
// UMA função com UM prompt (anti-over-engineering, regras da v45): escreve a
// mensagem única de um turno COM FATOS EXECUTADOS, a partir dos fatos tipados
// lidos do banco pós-escrita (P56) e da intenção conversacional do principal.
//
// Guard-rails, nesta ordem:
//   1. âncora `verificarComposicao` (função pura): presença de todo fato e
//      não-invenção de medicamentos/números/horários;
//   2. falha da âncora, erro, timeout ou resposta vazia → FALLBACK: o texto
//      canônico determinístico dos mesmos fatos (a montagem atual do
//      dosesDoTurno + templates), via degradar() — beco sem saída zero;
//   3. escopo: SOMENTE turnos com fatos executados (guard no router); atalho
//      exato e proativas respondem pelo canônico direto, sem compositor.
//
// Modelo: o mesmo do principal (decisão de 30/09) — sem experimento de
// modelo menor nesta onda. 1 tentativa, sem retry (§4).
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { GUIA_COMPOSICAO, GUIA_COMPOSICAO_TURNO } from './templates/composicao.js';
import { contarChamadaLLM, degradar } from './observabilidade.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const MODELO_COMPOSITOR = process.env.COMPOSITOR_MODEL || 'claude-sonnet-4-6';
const TIMEOUT_COMPOSICAO_MS = 10_000;
const MAX_TOKENS_COMPOSICAO = 300; // mensagem de WhatsApp é breve (§4)

// ------------------------------------------------------------
// Natureza do turno — derivada POR CÓDIGO dos fatos, nunca pelo LLM (§1).
//   correcao: houve desfazer, correção de "não tomada" ou contestação de estoque;
//   chegada:  a pessoa apareceu depois e contou (só retroativas, nada a corrigir);
//   normal:   o resto.
// ------------------------------------------------------------
export function derivarNatureza(fatos) {
    if ((fatos || []).some(f => f.tipo === 'dose_revertida' || f.corrigida || f.contestado)) return 'correcao';
    if ((fatos || []).some(f => f.tipo === 'dose_confirmada' && f.retroativa)) return 'chegada';
    return 'normal';
}

// ------------------------------------------------------------
// Serialização legível dos fatos (§5) — o que o modelo vê é exatamente o que
// a âncora permite (números dos fragmentos canônicos entram no conjunto).
// ------------------------------------------------------------

const ROTULO_STATUS_DEVOLVIDO = {
    pendente: 'aguardando resposta (as cobranças continuam)',
    nao_informado: 'sem resposta (cobranças esgotadas)',
    sem_estoque: 'sem estoque registrado'
};

function linhaDoFato(f) {
    switch (f.tipo) {
        case 'dose_confirmada': {
            const sufixos = [];
            if (f.corrigida) sufixos.push('CORREÇÃO: estava registrada como não tomada e a pessoa disse que tomou');
            else if (f.retroativa) sufixos.push('retroativa: a pessoa contou depois que a dose já tinha passado');
            if (f.semEstoque) sufixos.push('registrada mesmo sem estoque anotado (a palavra da pessoa prevalece)');
            if (f.contestado) sufixos.push('o estoque registrado dizia zero e foi CONTESTADO — ficou em aberto');
            return `dose confirmada e gravada: ${f.canonico}${sufixos.length ? ` — ${sufixos.join('; ')}` : ''}`;
        }
        case 'dose_revertida':
            return `confirmação DESFEITA: ${f.canonico} — a dose voltou a "${ROTULO_STATUS_DEVOLVIDO[f.statusDevolvido] || f.statusDevolvido}"`;
        case 'dose_nao_tomada':
            return `dose fechada como NÃO tomada (linha do sistema: "${f.canonico}") — acolha sem pressão e sem "se tomar mais tarde"`;
        case 'dose_ja_registrada':
            return `já estava registrada (nada foi gravado de novo): ${f.canonico}`;
        case 'ainda_nao':
            return `a pessoa AINDA NÃO tomou o *${f.medicamento}* — nada foi gravado, a dose segue aguardando e as cobranças continuam; deixe a porta aberta`;
        case 'estoque_atualizado':
            return `estoque atualizado (o número é do sistema; use-o exatamente): ${f.canonico}`;
        case 'alerta_estoque':
            return `alerta de estoque (informação do sistema; não mude os números): ${String(f.canonico || '').trim()}`;
        case 'convite_estoque':
            return f.motivo === 'estoque_contestado'
                ? `convite de estoque (POR ÚLTIMO): o estoque do *${f.medicamento}* dizia zero e a pessoa confirmou a dose, então ficou em aberto — convide a informar quantos tem, sem pressão`
                : `convite de estoque (POR ÚLTIMO): ainda não temos o estoque do *${f.medicamento}* — convide a informar quantos tem em casa, sem pressão`;
        default:
            return `${f.tipo}: ${f.canonico || f.medicamento || ''}`;
    }
}

export function serializarTurnoParaComposicao({ user, fatos, natureza, intencao, assuntoCitacao, historicoCurto }) {
    const nome = user?.name ? user.name.split(' ')[0] : null;
    const linhas = [
        '=== TURNO ===',
        `Pessoa: ${nome || 'nome não informado'}`,
        `Natureza do turno: ${natureza}`,
        assuntoCitacao ? `A pessoa respondeu CITANDO uma mensagem da Nami (${String(assuntoCitacao.origem || '').replace(/^proativo:/, '')}).` : null,
        '',
        'FATOS EXECUTADOS (tudo já gravado — a mensagem relata exatamente isto):',
        ...(fatos || []).map(f => `- ${linhaDoFato(f)}`),
        '',
        intencao
            ? `INTENÇÃO CONVERSACIONAL da etapa anterior (reformule e entrelace; em conflito, o fato vence): "${String(intencao).slice(0, 500)}"`
            : 'INTENÇÃO CONVERSACIONAL: nenhuma — a mensagem é só a narrativa dos fatos.',
        (historicoCurto || []).length ? '' : null,
        (historicoCurto || []).length ? 'RESPOSTAS RECENTES DA NAMI (não repita a abertura nem a formulação):' : null,
        ...(historicoCurto || []).map(t => `- "${String(t).replace(/\s+/g, ' ').slice(0, 160)}"`),
        '',
        'Escreva agora a mensagem única do turno.'
    ];
    return linhas.filter(l => l !== null).join('\n');
}

const SYSTEM_COMPOSITOR = `Você é a Nami, uma assistente de saúde gentil e cuidadosa que ajuda pessoas a não esquecerem seus medicamentos. Você conversa pelo WhatsApp com um público principalmente de idosos e pessoas com doenças crônicas: linguagem simples, clara e carinhosa; frases curtas; nada de jargão.

SUA TAREFA NESTA CHAMADA: escrever a MENSAGEM ÚNICA do turno a partir dos FATOS EXECUTADOS que o sistema te entrega. Tudo o que está nos fatos JÁ aconteceu e JÁ está gravado — você não decide, não executa, não pergunta se pode: você narra e acolhe. Responda SOMENTE com o texto da mensagem, sem aspas, sem preâmbulo e sem comentário.
${GUIA_COMPOSICAO}
${GUIA_COMPOSICAO_TURNO}`;

// UMA tentativa, sem retry (§4): qualquer falha é do chamador (fallback).
export async function comporMensagemDoTurno({ user, fatos, natureza, intencao, assuntoCitacao, historicoCurto, model = MODELO_COMPOSITOR }) {
    const inicio = Date.now();
    contarChamadaLLM();
    const chamada = anthropic.messages.create({
        model,
        max_tokens: MAX_TOKENS_COMPOSICAO,
        system: [{ type: 'text', text: SYSTEM_COMPOSITOR, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: serializarTurnoParaComposicao({ user, fatos, natureza, intencao, assuntoCitacao, historicoCurto }) }]
    });
    chamada.catch(() => {}); // rejeição pós-timeout nunca vira unhandled rejection
    let timer;
    const response = await Promise.race([
        chamada,
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout_composicao')), TIMEOUT_COMPOSICAO_MS); })
    ]).finally(() => clearTimeout(timer));
    const texto = (response.content || []).find(b => b.type === 'text')?.text?.trim() || null;
    console.log(`🧵 [COMPOSITOR] composição em ${Date.now() - inicio}ms (${natureza}, ${fatos.length} fato(s))`);
    return texto;
}

// ------------------------------------------------------------
// A ÂNCORA (§2) — função pura, pós-composição. Na dúvida, reprovar é o lado
// seguro: o fallback canônico está sempre atrás dela.
// ------------------------------------------------------------

// Fatos cuja PRESENÇA no texto é exigida (têm conteúdo canônico próprio).
// ja_registrada/ainda_nao/alerta/convite podem ser parafraseados — a
// não-invenção continua valendo para todos.
const PRESENCA_OBRIGATORIA = new Set(['dose_confirmada', 'dose_nao_tomada', 'dose_revertida', 'estoque_atualizado']);

function normalizar(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const RE_HORA = /\d{1,2}:\d{2}/g;
const RE_DATA = /\d{2}\/\d{2}/g;
const RE_NUMERO = /\d+(?:[.,]\d+)?/g;

function colherPermitidos(fatos, intencao = '') {
    const horas = new Set();
    const datas = new Set();
    const numeros = new Set();
    const colher = (s) => {
        const str = String(s ?? '');
        for (const h of str.match(RE_HORA) || []) horas.add(h);
        for (const d of str.match(RE_DATA) || []) datas.add(d);
        const resto = str.replace(RE_HORA, ' ').replace(RE_DATA, ' ');
        for (const n of resto.match(RE_NUMERO) || []) numeros.add(n.replace(',', '.'));
    };
    for (const f of fatos || []) {
        colher(f.canonico);
        colher(f.medicamento); // "Ômega 3", "Puran T4": o número do NOME é permitido
        colher(f.quando?.entreParenteses);
        if (f.estoqueNovo !== null && f.estoqueNovo !== undefined) numeros.add(String(f.estoqueNovo).replace(',', '.'));
        if (f.quantidade !== null && f.quantidade !== undefined) numeros.add(String(f.quantidade).replace(',', '.'));
    }
    // v47 correção 09/10 (turno misto): a INTENÇÃO é entrada da composição —
    // números/horas/datas escritos nela (ex.: a próxima dose, calculada por
    // código no contexto do principal) são permitidos, não invenção.
    colher(intencao);
    return { horas, datas, numeros };
}

export function verificarComposicao(fatos, texto, { medicamentosDoUsuario = [], intencao = '' } = {}) {
    const t = String(texto || '');
    if (!t.trim()) return { ok: false, motivo: 'texto_vazio' };
    const tNorm = normalizar(t);

    // 1. PRESENÇA — todo fato aparece: medicamento, horário(s) e dia do fato.
    for (const f of fatos || []) {
        if (!PRESENCA_OBRIGATORIA.has(f.tipo)) continue;
        if (f.medicamento && !tNorm.includes(normalizar(f.medicamento))) {
            return { ok: false, motivo: `fato_ausente:medicamento:${f.medicamento}` };
        }
        const quando = String(f.quando?.entreParenteses || '');
        for (const h of quando.match(RE_HORA) || []) {
            if (!t.includes(h)) return { ok: false, motivo: `fato_ausente:horario:${h}` };
        }
        const rotulo = f.quando?.rotulo;
        if (rotulo && rotulo !== 'hoje') {
            const data = quando.match(RE_DATA)?.[0] || null;
            if (!tNorm.includes(normalizar(rotulo)) && !(data && t.includes(data))) {
                return { ok: false, motivo: `fato_ausente:dia:${rotulo}` };
            }
        }
        if (f.tipo === 'estoque_atualizado' && f.estoqueNovo !== null && f.estoqueNovo !== undefined) {
            const n = String(f.estoqueNovo);
            if (!t.includes(n) && !t.includes(n.replace('.', ','))) {
                return { ok: false, motivo: `fato_ausente:estoque:${n}` };
            }
        }
        if (f.quantidade !== null && f.quantidade !== undefined && !t.includes(String(f.quantidade))) {
            return { ok: false, motivo: `fato_ausente:quantidade:${f.quantidade}` };
        }
    }

    // 2. NÃO-INVENÇÃO — medicamentos: nenhum remédio do usuário fora dos fatos
    // NEM da intenção (v47 correção 09/10, caso "qual meu próximo remédio?": a
    // resposta cita legitimamente OUTRO remédio — escrito na intenção, que é
    // entrada da composição; fora das duas fontes continua reprovando).
    // Limite documentado (teste A65): a checagem é por substring do nome
    // normalizado — nomes muito curtos podem colidir com palavras comuns; o
    // lado escolhido é reprovar (fallback), nunca deixar passar.
    const medsDosFatos = new Set((fatos || []).map(f => normalizar(f.medicamento)).filter(Boolean));
    const intencaoNorm = normalizar(intencao);
    for (const nome of medicamentosDoUsuario || []) {
        const n = normalizar(nome);
        if (n && !medsDosFatos.has(n) && !(intencaoNorm && intencaoNorm.includes(n)) && tNorm.includes(n)) {
            return { ok: false, motivo: `medicamento_fora_dos_fatos:${nome}` };
        }
    }

    // 3. NÃO-INVENÇÃO — números, horários e datas do texto pertencem ao
    // conjunto dos fatos (incluindo os fragmentos canônicos, que são a verdade
    // escrita por código) ou da intenção. Só dígitos contam — palavras
    // numéricas ("duas") ficam fora da heurística de propósito (limite
    // documentado no A65).
    const permitidos = colherPermitidos(fatos, intencao);
    for (const h of t.match(RE_HORA) || []) {
        if (!permitidos.horas.has(h)) return { ok: false, motivo: `horario_inventado:${h}` };
    }
    let resto = t.replace(RE_HORA, ' ');
    for (const d of resto.match(RE_DATA) || []) {
        if (!permitidos.datas.has(d)) return { ok: false, motivo: `data_inventada:${d}` };
    }
    resto = resto.replace(RE_DATA, ' ');
    for (const n of resto.match(RE_NUMERO) || []) {
        if (!permitidos.numeros.has(n.replace(',', '.'))) return { ok: false, motivo: `numero_inventado:${n}` };
    }

    return { ok: true };
}

// ------------------------------------------------------------
// Composição com âncora e fallback (§2–§3): a função que o fluxo do turno
// chama. NUNCA lança e NUNCA devolve vazio — na pior hipótese devolve o
// canônico recebido (P31: o fallback é o retorno de quem registrou a queda).
// ------------------------------------------------------------
export async function comporComAncora({ user, fatos, intencao = '', assuntoCitacao = null,
                                        historicoCurto = [], medicamentosDoUsuario = [], canonico }) {
    const natureza = derivarNatureza(fatos);
    const inicio = Date.now();
    let composto = null;
    let motivo = null;

    try {
        composto = await comporMensagemDoTurno({ user, fatos, natureza, intencao, assuntoCitacao, historicoCurto });
        if (!composto) motivo = 'resposta_vazia';
    } catch (e) {
        motivo = e?.message === 'timeout_composicao' ? 'timeout' : `erro:${e?.name || 'Error'}`;
    }

    if (composto) {
        const veredito = verificarComposicao(fatos, composto, { medicamentosDoUsuario, intencao });
        if (veredito.ok) return { texto: composto, caminho: 'composto', natureza };
        motivo = `ancora:${veredito.motivo}`;
    }

    // compositor_fallback (§2.4): o sinal de qualidade da composição em produção.
    // v47 correção 09/10 (turno misto): o fallback PRESERVA a intenção — o
    // canônico dos fatos seguido da message do principal, em partes (o formato
    // pré-Onda 1). Pior que dois blocos é engolir a pergunta da pessoa.
    const texto = await degradar({
        origem: 'compositor',
        motivo: motivo?.startsWith('ancora:') ? 'ancora_reprovou' : 'chamada_falhou',
        agent: 'compositor',
        userId: user?.id ?? null,
        detalhe: {
            motivo,
            natureza,
            duracao_ms: Date.now() - inicio,
            fatos: (fatos || []).map(f => ({ tipo: f.tipo, medication_id: f.medicationId ?? null }))
        },
        fallback: intencao && String(intencao).trim()
            ? `${canonico}\n\n${String(intencao).trim()}`
            : canonico
    });
    return { texto, caminho: motivo?.startsWith('ancora:') ? 'fallback_ancora' : 'fallback_chamada', natureza };
}
