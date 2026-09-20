// ============================================================
// PROMOÇÃO v44 M2 → PRODUÇÃO — flip do backlog (autorizado por
// Guilherme em 19/09/2026: "pode promover para produção").
//
// Os 12 itens do encerramento + ACH-10 saem de 'em_validacao' para
// 'resolvido': merge staging→main feito, migrações aplicadas em
// produção via MCP e verificadas. Escritas via src/backlog.js.
// ============================================================

import { atualizarStatusBacklogItem } from '../src/backlog.js';

const HOJE = '2026-09-19';
const SESSAO = 'v44-M2';
const NOTA = ' | PROMOVIDO A PRODUÇÃO em 19/09/2026 (merge staging→main; migrações '
    + 'v44_m2_mh77_recorrencia e v44_m2_mh30_tratamento_fim aplicadas e verificadas).';

const ITENS = [
    { tipo: 'MH', numero: 96 },
    { tipo: 'MH', numero: 77 },
    { tipo: 'MH', numero: 30 },
    { tipo: 'MH', numero: 49 },
    { tipo: 'MH', numero: 86 },
    { tipo: 'MH', numero: 85 },
    { tipo: 'MH', numero: 83 },
    { tipo: 'BUG', numero: 102 },
    { tipo: 'ACH', numero: 3 },
    { tipo: 'ACH', numero: 4 },
    { tipo: 'MH', numero: 73, parte: 'C.1' },
    { tipo: 'MH', numero: 73, parte: 'C.2' },
    { tipo: 'ACH', numero: 10 }
];

async function main() {
    // Lê as notas atuais para PRESERVÁ-LAS (o flip só acrescenta o sufixo).
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    for (const item of ITENS) {
        const parte = item.parte ?? '';
        const { data } = await db.from('backlog_items')
            .select('notas')
            .eq('tipo', item.tipo).eq('numero', item.numero).eq('parte', parte)
            .neq('status', 'historico_substituido')
            .single();

        await atualizarStatusBacklogItem({
            tipo: item.tipo, numero: item.numero, parte,
            novoStatus: 'resolvido',
            sessaoFechamento: SESSAO, dataFechamento: HOJE,
            notas: `${data?.notas ?? ''}${NOTA}`
        });
        console.log(`✅ ${item.tipo}-${item.numero}${parte ? ` Parte ${parte}` : ''} → resolvido`);
    }
    console.log(`\n🏁 Promoção v44-M2: ${ITENS.length} itens → resolvido`);
}

main().catch(e => {
    console.error('❌', e.message);
    process.exit(1);
});
