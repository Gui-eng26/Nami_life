// ============================================================
// ARNÊS DE REGRESSÃO — runner (M0, v44)
//
//   npm run arnes                 → todos os casos, alvo M1
//   npm run arnes -- --caso A3    → um caso específico
//   npm run arnes -- --lista      → lista os casos sem executar
//
// Saída: pass/fail por caso e por asserção, legível em terminal e CI.
// Checagem de marco ACIMA do alvo que falha é "conhecido" (expected-fail),
// nunca regressão. Exit code 1 apenas quando uma checagem do alvo falha.
// ============================================================

const ORDEM_MARCOS = { M1: 1, M2: 2, M4: 4 };

function parseArgs(argv) {
    const args = { alvo: 'M1', caso: null, lista: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--caso') args.caso = argv[++i];
        else if (argv[i] === '--alvo') args.alvo = argv[++i];
        else if (argv[i] === '--lista') args.lista = true;
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));

const { CASOS } = await import('./casos.js');

if (args.lista) {
    for (const c of CASOS) console.log(`${c.id}  [${c.marco}]  ${c.titulo}`);
    process.exit(0);
}

const { prepararContexto } = await import('./contexto.js');
const { fabricaSeeds } = await import('./seeds.js');

const ctx = await prepararContexto();
const seeds = fabricaSeeds(ctx.db);

console.log(`\n🧪 ARNÊS — alvo: ${args.alvo} — banco: ${process.env.SUPABASE_URL}`);
console.log(`   funil mockado: ${ctx.funilMockado ? 'sim' : 'não (baseline pré-§5.5 — envios diretos não são capturados)'}\n`);

await seeds.limparUsuariosDoArnes();

const casosParaRodar = args.caso ? CASOS.filter(c => c.id === args.caso) : CASOS;
if (casosParaRodar.length === 0) {
    console.error(`Caso "${args.caso}" não existe. Use --lista.`);
    process.exit(2);
}

let falhasDoAlvo = 0;
let conhecidos = 0;
let verdes = 0;
const resumo = [];

for (const caso of casosParaRodar) {
    console.log(`\n━━ ${caso.id} [${caso.marco}] ${caso.titulo}`);
    let checks;
    const inicio = Date.now();
    try {
        checks = await caso.executar({ ctx, seeds });
    } catch (e) {
        checks = [{ nome: 'execução do caso sem exceção', ok: false, detalhe: `${e.message}` }];
    }
    const duracao = ((Date.now() - inicio) / 1000).toFixed(1);

    let casoVerde = true;
    let casoConhecido = false;
    for (const check of checks) {
        const marcoCheck = check.marco || caso.marco;
        const acimaDoAlvo = (ORDEM_MARCOS[marcoCheck] || 99) > (ORDEM_MARCOS[args.alvo] || 1);
        if (check.ok) {
            verdes++;
            console.log(`   ✅ ${check.nome}`);
        } else if (acimaDoAlvo) {
            conhecidos++;
            casoConhecido = true;
            console.log(`   🟡 ${check.nome} — CONHECIDO (${marcoCheck} > alvo ${args.alvo}) — ${check.detalhe}`);
        } else {
            falhasDoAlvo++;
            casoVerde = false;
            console.log(`   ❌ ${check.nome} — ${check.detalhe}`);
        }
    }
    resumo.push({
        id: caso.id, marco: caso.marco,
        status: !casoVerde ? 'FALHOU' : casoConhecido ? 'VERDE (com conhecidos)' : 'VERDE',
        duracao
    });
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const r of resumo) {
    const icone = r.status === 'FALHOU' ? '❌' : r.status.startsWith('VERDE (') ? '🟡' : '✅';
    console.log(`${icone} ${r.id} [${r.marco}] — ${r.status} (${r.duracao}s)`);
}
console.log(`\nAsserções: ${verdes} verdes · ${falhasDoAlvo} falhas no alvo ${args.alvo} · ${conhecidos} conhecidas (marco futuro)`);

await seeds.limparUsuariosDoArnes();

process.exit(falhasDoAlvo > 0 ? 1 : 0);
