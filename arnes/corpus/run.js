// ============================================================
// CORPUS — executor com adaptadores (v45 P0)
//
//   npm run corpus -- --adaptador=producao_observada   → custo zero (dose, delegacao)
//   npm run corpus -- --adaptador=porta_atual          → 1 chamada por item de extração
//   npm run corpus -- --adaptador=principal_p1         → vazio até o P1
//
//   filtros: --categoria=horario · --item=D-02 · --json=saida.json · --concorrencia=4
//
// O corpus é a RÉGUA do principal como porta: cada item é UM turno real,
// com o contexto estruturado em que chegou, o que o sistema fez em
// produção e o que deveria ter feito. Não altera nada, não entra no
// portão de merge (P0 §0.1) e sai sempre com código 0 — ele mede, não
// reprova.
//
// Fronteira com o arnês: `arnes/casos.js` testa COMPORTAMENTO (conversa
// inteira, veredito binário, portão de merge); este corpus testa a
// INTERPRETAÇÃO de um turno (taxa de acerto por categoria e por campo).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '../..');
const PROD_REF = 'nputymewnwmnhrtpizzs';

const CATEGORIAS_EXTRACAO = ['horario', 'recorrencia', 'multi_med', 'estoque'];
const CATEGORIAS_DECISAO = ['dose', 'delegacao'];

// ------------------------------------------------------------
// Comparação — helpers
// ------------------------------------------------------------

const normalizarNome = (n) => String(n ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const conjunto = (lista) => new Set((lista || []).filter(v => v !== null && v !== undefined && v !== ''));
const mesmoConjunto = (a, b) => a.size === b.size && [...a].every(v => b.has(v));
const ordenado = (s) => [...s].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));

function campoConjunto(esperados, obtidos, extra = {}) {
    return {
        exigido: true,
        ok: mesmoConjunto(esperados, obtidos),
        esperado: ordenado(esperados),
        obtido: ordenado(obtidos),
        ...extra
    };
}
const campoValor = (esperado, obtido) => ({ exigido: true, ok: esperado === obtido, esperado, obtido: obtido ?? null });
const naoExigido = { exigido: false };

// ============================================================
// ADAPTADOR 1 — producao_observada
// Não chama nada. Compara `observado_producao` (o que o sistema de hoje
// fez, tirado de agent_logs / dose_logs / funil_envios) com `esperado`.
// É o baseline de dose e delegacao, com custo zero.
// ============================================================

const CAMPOS_OBSERVADA = ['tipo', 'doses', 'candidatas', 'especialista', 'relacao_pendencia', 'subtipo', 'outra'];

const chavesDose = (lista) => conjunto((lista || []).map(d => `${d.ref}:${d.fato}`));

function compararObservada(item) {
    const e = item.esperado;
    const o = item.observado_producao;
    const campos = {
        tipo: campoValor(e.tipo, o.tipo),
        doses: (e.tipo === 'dose' || (o.doses || []).length > 0)
            ? campoConjunto(chavesDose(e.doses), chavesDose(o.doses))
            : naoExigido,
        candidatas: e.tipo === 'perguntar' && e.candidatas
            ? campoConjunto(conjunto(e.candidatas), conjunto(o.candidatas))
            : naoExigido,
        especialista: e.tipo === 'delegar' ? campoValor(e.especialista, o.tipo === 'delegar' ? o.especialista : null) : naoExigido,
        relacao_pendencia: e.tipo === 'delegar' ? campoValor(e.relacao_pendencia, o.tipo === 'delegar' ? o.relacao_pendencia : null) : naoExigido,
        subtipo: e.subtipo ? campoValor(e.subtipo, o.subtipo) : naoExigido,
        // A segunda parte do turno (ex.: dose + recompra). A produção de hoje
        // nunca trata as duas: quando o observado não traz `outra`, é erro.
        outra: e.outra ? campoValor(e.outra.tipo, o.outra?.tipo) : naoExigido
    };
    const camposOk = CAMPOS_OBSERVADA.every(c => !campos[c].exigido || campos[c].ok);
    return {
        campos,
        correto: o.correto === true,
        // O veredito `correto` é MANUAL (registrado na coleta) e pode divergir
        // dos campos: ex. especialista e relação certos, mas o valor dito na
        // mensagem foi descartado (G-08). A divergência é listada, não corrigida.
        diverge: camposOk !== (o.correto === true)
    };
}

const producaoObservada = {
    nome: 'producao_observada',
    descricao: 'o que o sistema de hoje FEZ em produção (sem chamada de API)',
    categoriasPadrao: CATEGORIAS_DECISAO,
    campos: CAMPOS_OBSERVADA,
    aplicavel: (item) => item.observado_producao != null,
    async avaliar(item) {
        return compararObservada(item);
    }
};

// ============================================================
// ADAPTADOR 2 — porta_atual
// Chama `interpretarTurno` (src/porta.js, a porta de hoje) uma vez por
// item de extração e compara os campos que ela representa. O que ela não
// representa vira `nao_suportado_pela_porta_atual`, nunca "erro".
// ============================================================

// A porta devolve o horário como TEXTO, como a pessoa escreveu; a
// normalização para HH:MM vive AQUI, nunca em src/.
const PERIODO_PM = /\b(da|de|à|a)\s*(tarde|noite)\b/i;
const PERIODO_AM = /\b(da|de)\s*(manh[ãa]|madrugada)\b/i;
// `12/12 hrs`, `de 6 em 6hrs`, `8h em 8h` são CADÊNCIA, não horário de relógio.
const EH_INTERVALO = /(\d+\s*\/\s*\d+)|(\bde\s*\d+\s*em\s*\d+)|(\d+\s*h\w*\s*em\s*\d+\s*h)/i;

export function normalizarHorario(expressao) {
    const bruto = String(expressao ?? '').trim();
    if (!bruto) return null;
    if (EH_INTERVALO.test(bruto)) return null;
    if (/meio[\s-]*dia/i.test(bruto)) return '12:00';
    if (/meia[\s-]*noite/i.test(bruto)) return '00:00';

    // `(?!\d)` e NÃO `\b`: em "6:30h" não existe fronteira entre o "0" e o
    // "h", e um `\b` derrubava os minutos — o defeito que o H-07 mede.
    let m = bruto.match(/(\d{1,2})\s*[:h]\s*(\d{2})(?!\d)/i);
    let hora = null;
    let minuto = '00';
    if (m) {
        hora = Number(m[1]);
        minuto = m[2];
    } else if ((m = bruto.match(/(\d{1,2})\s*h(?:s|rs|r|oras?|ras?)?\b/i))) {
        hora = Number(m[1]);
    } else if ((m = bruto.match(/^\s*(\d{1,2})(?:\s*(?:da|de)\s+(?:manh[ãa]|tarde|noite|madrugada))?\s*$/i))) {
        // Número seco só quando a expressão INTEIRA é isso: "1000 mcg" é
        // dosagem que vazou para horários, e virar 00:00 esconderia o erro.
        hora = Number(m[1]);
    } else {
        return null;
    }
    if (!Number.isInteger(hora) || hora < 0 || hora > 24) return null;
    if (hora === 24) hora = 0;
    if (Number(minuto) > 59) return null;

    if (hora <= 12 && PERIODO_PM.test(bruto)) hora = hora === 12 ? 12 : hora + 12;
    if (hora === 12 && PERIODO_AM.test(bruto)) hora = 0;

    return `${String(hora).padStart(2, '0')}:${minuto}`;
}

// A porta de hoje responde com uma INTENÇÃO; o gabarito fala em
// especialista. O mapa é direto; `principal` e `nao_suportado` são não
// delegar (a porta de hoje não tem o `tipo`).
const especialistaDaPorta = (intencao) => intencao ?? null;

// Leitura literal: o contrato declarado da porta ("nomes citados NESTA
// mensagem", "horários como escritos"). Resolução: os mesmos campos
// cobrados contra o gabarito semântico. A distância entre os dois é o que
// o P1 precisa fechar.
const CAMPOS_PORTA = ['especialista', 'nomes_citados', 'horarios_citados', 'medicamentos_a_cadastrar', 'horarios_resolvidos'];
const CAMPOS_NAO_SUPORTADOS = [
    'relacao_pendencia', 'quantidade', 'dias_semana', 'dosagem', 'cadencia',
    'forma_unidade', 'correcoes', 'estoque', 'nao_representavel'
];

function exigenciasNaoSuportadas(e) {
    const meds = e.medicamentos || [];
    const algum = (f) => meds.some(m => m[f] !== null && m[f] !== undefined);
    return {
        relacao_pendencia: !!e.relacao_pendencia,
        quantidade: algum('quantidade'),
        dias_semana: meds.some(m => Array.isArray(m.dias_semana) && m.dias_semana.length > 0),
        dosagem: algum('dosagem'),
        cadencia: algum('cadencia') || algum('intervalo_horas') || algum('frequencia_semanal'),
        forma_unidade: algum('forma') || algum('convencao_po_gramas') || algum('periodos'),
        correcoes: (e.correcoes || []).length > 0,
        estoque: (e.estoque || []).length > 0,
        nao_representavel: e.nao_representavel === true
    };
}

function compararPorta(item, proposta) {
    const e = item.esperado;
    const meds = e.medicamentos || [];
    const citados = item.citados || { nomes: [], horarios: [] };
    const brutos = proposta?.campos?.horarios || [];
    const nomesObtidos = conjunto([
        ...(proposta?.campos?.medicamentos || []).map(normalizarNome),
        ...(proposta?.campos?.medicamento ? [normalizarNome(proposta.campos.medicamento)] : [])
    ]);
    const horariosObtidos = conjunto(brutos.map(normalizarHorario));
    // Resolução usa só `medicamentos` (o campo "para cadastrar" da porta); o
    // alvo de relatório/configuração vive no campo singular e não é cadastro.
    const aCadastrarObtidos = conjunto((proposta?.campos?.medicamentos || []).map(normalizarNome));
    const exig = exigenciasNaoSuportadas(e);

    const campos = {
        especialista: campoValor(e.especialista, especialistaDaPorta(proposta?.intencao)),
        nomes_citados: campoConjunto(conjunto(citados.nomes.map(normalizarNome)), nomesObtidos),
        horarios_citados: campoConjunto(conjunto(citados.horarios), horariosObtidos, { bruto: brutos }),
        medicamentos_a_cadastrar: campoConjunto(conjunto(meds.map(m => m.nome).filter(Boolean).map(normalizarNome)), aCadastrarObtidos),
        horarios_resolvidos: campoConjunto(
            conjunto([...meds.flatMap(m => m.horarios || []), ...(e.horarios_livres || [])]),
            horariosObtidos, { bruto: brutos })
    };
    for (const c of CAMPOS_NAO_SUPORTADOS) {
        campos[c] = exig[c]
            ? { exigido: true, ok: null, status: 'nao_suportado_pela_porta_atual' }
            : naoExigido;
    }
    return { campos, correto: CAMPOS_PORTA.every(c => campos[c].ok), diverge: false };
}

let interpretarTurno = null;

async function carregarPorta() {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(RAIZ, '.env') });
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('ANTHROPIC_API_KEY ausente — o adaptador porta_atual chama a porta de verdade.');
        process.exit(2);
    }
    // Banco NEUTRALIZADO antes de importar src/: a porta não lê banco, mas
    // `degradar()` (falha dupla de schema) escreve em system_events — e o
    // .env do projeto aponta para PRODUÇÃO. Credenciais inertes tornam essa
    // escrita impossível por construção.
    process.env.SUPABASE_URL = 'https://corpus-inerte.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'corpus-inerte';
    process.env.ZAPI_INSTANCE_ID = 'corpus-inerte';
    process.env.ZAPI_TOKEN = 'corpus-inerte';
    process.env.ZAPI_CLIENT_TOKEN = 'corpus-inerte';
    if (process.env.SUPABASE_URL.includes(PROD_REF)) {
        console.error('Corpus apontando para PRODUÇÃO — execução recusada.');
        process.exit(2);
    }
    ({ interpretarTurno } = await import('../../src/porta.js'));
}

const portaAtual = {
    nome: 'porta_atual',
    descricao: 'interpretarTurno de src/porta.js (claude-sonnet-4-6), uma chamada por item',
    categoriasPadrao: CATEGORIAS_EXTRACAO,
    campos: [...CAMPOS_PORTA, ...CAMPOS_NAO_SUPORTADOS],
    aplicavel: (item) => CATEGORIAS_EXTRACAO.includes(item.categoria),
    preparar: carregarPorta,
    async avaliar(item) {
        let proposta = null;
        let erro = null;
        try {
            // Mesma entrada do baseline E0: estado corrente, sem histórico.
            // A pendência estruturada do item é o que o principal receberá no
            // P1; a porta de hoje não tem onde recebê-la.
            proposta = await interpretarTurno({
                message: item.mensagem,
                currentState: item.contexto.estado,
                historicoConversa: []
            });
        } catch (e) {
            erro = e.message;
        }
        return { ...compararPorta(item, proposta), proposta, erro };
    }
};

// ============================================================
// ADAPTADOR 3 — principal_p1
// Criado vazio no P0. No P1 ele recebe `item.contexto` exatamente como
// está (pendência, doses com refs, último lembrete, mensagem citada) e
// devolve { tipo, doses | especialista + relacao_pendencia + campos }.
// ============================================================

const principalP1 = {
    nome: 'principal_p1',
    descricao: 'o principal como porta única (P1) — ainda não ligado',
    categoriasPadrao: [...CATEGORIAS_DECISAO, ...CATEGORIAS_EXTRACAO],
    campos: [],
    vazio: true,
    aplicavel: () => true,
    async avaliar() {
        throw new Error('principal_p1 ainda não foi ligado — isso acontece no P1');
    }
};

const ADAPTADORES = { producao_observada: producaoObservada, porta_atual: portaAtual, principal_p1: principalP1 };

// ============================================================
// Execução
// ============================================================

function parseArgs(argv) {
    const a = { adaptador: 'producao_observada', categoria: null, item: null, json: null, concorrencia: 4 };
    for (let i = 0; i < argv.length; i++) {
        let [chave, valor] = argv[i].split('=');
        if (valor === undefined && argv[i + 1] && !argv[i + 1].startsWith('--')) valor = argv[++i];
        chave = chave.replace(/^--/, '');
        if (chave in a) a[chave] = chave === 'concorrencia' ? (Number(valor) || 4) : valor;
    }
    return a;
}

const args = parseArgs(process.argv.slice(2));
const adaptador = ADAPTADORES[args.adaptador];
if (!adaptador) {
    console.error(`Adaptador desconhecido: ${args.adaptador}. Use: ${Object.keys(ADAPTADORES).join(', ')}`);
    process.exit(2);
}

const ITENS = JSON.parse(fs.readFileSync(path.join(AQUI, 'itens.json'), 'utf8'));

let aRodar = ITENS;
if (args.item) aRodar = aRodar.filter(i => i.id === args.item);
else if (args.categoria) aRodar = aRodar.filter(i => i.categoria === args.categoria);
else aRodar = aRodar.filter(i => adaptador.categoriasPadrao.includes(i.categoria));

const foraDoAlcance = aRodar.filter(i => !adaptador.aplicavel(i));
aRodar = aRodar.filter(i => adaptador.aplicavel(i));

console.log(`\n📏 CORPUS — adaptador ${adaptador.nome}: ${adaptador.descricao}`);

if (adaptador.vazio) {
    console.log('   ⏸  adaptador vazio: será ligado no P1. Nada foi executado.\n');
    process.exit(0);
}
if (foraDoAlcance.length) {
    console.log(`   ${foraDoAlcance.length} item(ns) fora do alcance deste adaptador: ${foraDoAlcance.map(i => i.id).join(', ')}`);
}
if (aRodar.length === 0) {
    console.error('Nenhum item selecionado. Categorias: ' + [...new Set(ITENS.map(i => i.categoria))].join(', '));
    process.exit(2);
}
console.log(`   ${aRodar.length} item(ns)\n`);

if (adaptador.preparar) await adaptador.preparar();

const resultados = new Array(aRodar.length);
let proximo = 0;
const inicio = Date.now();
async function trabalhador() {
    while (true) {
        const i = proximo++;
        if (i >= aRodar.length) return;
        resultados[i] = { item: aRodar[i], ...(await adaptador.avaliar(aRodar[i])) };
        if (adaptador.preparar) process.stdout.write('.');
    }
}
await Promise.all(Array.from({ length: Math.max(1, args.concorrencia) }, trabalhador));
if (adaptador.preparar) console.log(`\n   ${aRodar.length} chamadas em ${((Date.now() - inicio) / 1000).toFixed(1)}s\n`);

// ---- Relatório por categoria e por campo ----

const pct = (ok, total) => total ? `${Math.round((ok / total) * 100)}%` : '—';
const categorias = [...new Set(resultados.map(r => r.item.categoria))];

console.log('━━━ POR CATEGORIA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const cat of categorias) {
    const grupo = resultados.filter(r => r.item.categoria === cat);
    const certos = grupo.filter(r => r.correto).length;
    console.log(`\n${cat} — ${grupo.length} itens — correto ${certos}/${grupo.length} (${pct(certos, grupo.length)})`);
    const medidos = [];
    const ausentes = [];
    for (const campo of adaptador.campos) {
        const exigidos = grupo.filter(r => r.campos[campo]?.exigido);
        if (!exigidos.length) continue;
        if (exigidos[0].campos[campo].status === 'nao_suportado_pela_porta_atual') {
            ausentes.push(`${campo} ${exigidos.length}`);
        } else {
            const ok = exigidos.filter(r => r.campos[campo].ok).length;
            medidos.push(`${campo} ${ok}/${exigidos.length}`);
        }
    }
    console.log(`   campos : ${medidos.join(' · ')}`);
    if (ausentes.length) console.log(`   nao_suportado_pela_porta_atual: ${ausentes.join(', ')}`);
}

console.log('\n━━━ POR CAMPO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const campo of adaptador.campos) {
    const exigidos = resultados.filter(r => r.campos[campo]?.exigido);
    if (!exigidos.length) continue;
    if (exigidos[0].campos[campo].status === 'nao_suportado_pela_porta_atual') {
        console.log(`${campo.padEnd(24)} ${String(exigidos.length).padStart(3)} item(ns) exigem — nao_suportado_pela_porta_atual`);
    } else {
        const ok = exigidos.filter(r => r.campos[campo].ok).length;
        console.log(`${campo.padEnd(24)} ${String(ok).padStart(3)}/${String(exigidos.length).padEnd(3)} ${pct(ok, exigidos.length)}`);
    }
}
const totalCertos = resultados.filter(r => r.correto).length;
console.log(`${'CORRETO (item inteiro)'.padEnd(24)} ${String(totalCertos).padStart(3)}/${String(resultados.length).padEnd(3)} ${pct(totalCertos, resultados.length)}`);

// ---- Itens errados, para leitura rápida ----
const errados = resultados.filter(r => !r.correto);
console.log(`\n━━━ ITENS ERRADOS (${errados.length}/${resultados.length}) ━━━`);
for (const r of errados) {
    const quais = adaptador.campos.filter(c => r.campos[c]?.exigido && r.campos[c].ok === false);
    console.log(`\n${r.item.id} [${r.item.categoria}]${r.item.revisar ? ' 🔎revisar' : ''} — ${quais.join(', ') || '(campos ok; veredito manual)'}`);
    console.log(`  mensagem: ${JSON.stringify(r.item.mensagem)}`);
    if (r.item.observado_producao && adaptador.nome === 'producao_observada') console.log(`  produção: ${r.item.observado_producao.resumo}`);
    if (r.erro) console.log(`  ERRO: ${r.erro}`);
    for (const k of quais) {
        console.log(`  ${k}: esperado ${JSON.stringify(r.campos[k].esperado)} · obtido ${JSON.stringify(r.campos[k].obtido)}`);
        if (r.campos[k].bruto) console.log(`    (texto devolvido pela porta: ${JSON.stringify(r.campos[k].bruto)})`);
    }
}

const divergentes = resultados.filter(r => r.diverge).map(r => r.item.id);
if (divergentes.length) {
    console.log(`\nℹ️  Veredito manual ≠ campos (o valor dito na mensagem se perdeu, ou o erro está fora dos campos): ${divergentes.join(', ')}`);
}
const marcados = resultados.filter(r => r.item.revisar).map(r => r.item.id);
console.log(`\n🔎 Marcados para revisão de Guilherme (§6): ${marcados.length} — ${marcados.join(', ')}`);

if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(resultados.map(r => ({
        id: r.item.id, categoria: r.item.categoria, revisar: r.item.revisar, mensagem: r.item.mensagem,
        esperado: r.item.esperado, correto: r.correto, campos: r.campos, proposta: r.proposta, erro: r.erro
    })), null, 2));
    console.log(`\nDetalhe item a item: ${args.json}`);
}

console.log('');
// O corpus MEDE, não reprova: exit 0 sempre (fora erro de uso).
process.exit(0);
