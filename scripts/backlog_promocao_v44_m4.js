// ============================================================
// PROMOÇÃO v44 M4 → produção — NÃO EXECUTAR sem autorização
// explícita de Guilherme para o merge staging → main.
//
// Flip dos itens do M4 de 'em_validacao' para 'resolvido': o marco só
// está em produção depois do merge. Sem migração de banco neste marco.
// Escritas exclusivamente via src/backlog.js (padrão técnico nº 7).
// ============================================================

import { atualizarStatusBacklogItem } from '../src/backlog.js';

const HOJE = '2026-09-21';
const SESSAO = 'v44-M4-promocao';
const ITENS = [
    ['MH', 87, ''],
    ['ACH', 11, ''],
    ['MH', 73, 'B.1']
];

async function main() {
    for (const [tipo, numero, parte] of ITENS) {
        // notas: undefined preserva a nota do encerramento — aqui só o flip.
        await atualizarStatusBacklogItem({
            tipo, numero, parte,
            novoStatus: 'resolvido',
            sessaoFechamento: SESSAO, dataFechamento: HOJE,
            notas: undefined
        });
        console.log(`✅ ${tipo}-${numero}${parte ? ` Parte ${parte}` : ''} → resolvido`);
    }
    console.log('\nConcluído. (MH-46 e MH-89 A já foram a resolvido no encerramento; MH-97 nasce aberto.)');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
