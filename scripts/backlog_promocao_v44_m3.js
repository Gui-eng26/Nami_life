// ============================================================
// PROMOÇÃO v44 M3 → produção (20/09/2026, autorizada por Guilherme:
// "Todos validados. Pode encerrar... Pode seguir pra promoção na main").
//
// Flip dos itens do M3 de 'em_validacao' para 'resolvido' — o marco
// está em produção (migração aplicada + merge staging → main).
// Escritas exclusivamente via src/backlog.js (padrão técnico nº 7).
// ============================================================

import { atualizarStatusBacklogItem } from '../src/backlog.js';

const HOJE = '2026-09-20';
const SESSAO = 'v44-M3-promocao';
const ITENS = [
    ['BUG', 61], ['BUG', 69], ['BUG', 86], ['BUG', 36],
    ['ACH', 5],
    ['MH', 31], ['MH', 39], ['MH', 41], ['MH', 47], ['MH', 48],
    ['MH', 50], ['MH', 51], ['MH', 60], ['MH', 62], ['MH', 63],
    ['MH', 75], ['MH', 79], ['MH', 82]
];

async function main() {
    for (const [tipo, numero] of ITENS) {
        // notas: undefined preserva a nota do encerramento (supabase-js ignora
        // chaves undefined no update) — o registro do "em_validacao" já conta
        // a história; aqui só o flip de status.
        await atualizarStatusBacklogItem({
            tipo, numero, parte: '',
            novoStatus: 'resolvido',
            sessaoFechamento: SESSAO, dataFechamento: HOJE,
            notas: undefined
        });
        console.log(`✅ ${tipo}-${numero} → resolvido`);
    }
    console.log('\nConcluído. (MH-27 e MH-43 seguem abertos por decisão registrada; ACH-1 já era resolvido.)');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
