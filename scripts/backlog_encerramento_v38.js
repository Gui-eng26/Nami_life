// Escritas de backlog do encerramento v38 (briefings/encerramento_v38.md, Seção 2) —
// executado uma vez, via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v38';
const DATA = '2026-08-30';

async function main() {
    // BUG-27 — nome de medicamento pré-cadastro perdido em cad_nome
    const bug27 = await atualizarStatusBacklogItem({
        tipo: 'BUG', numero: 27,
        novoStatus: 'resolvido',
        sessaoFechamento: SESSAO,
        dataFechamento: DATA,
        notas: 'Resolvido indiretamente pelo MH-80 (v34). Confirmado em produção na v38: 13 cadastros '
            + 'consecutivos (26–28/08/2026) aproveitam o nome da primeira mensagem sem repergunta.'
    });
    console.log(`✅ BUG-${bug27.numero} atualizado (${bug27.status})`);

    // BUG-28 — "ta bom" interpretado como pergunta em contexto idle
    const bug28 = await atualizarStatusBacklogItem({
        tipo: 'BUG', numero: 28,
        novoStatus: 'resolvido',
        sessaoFechamento: SESSAO,
        dataFechamento: DATA,
        notas: 'Confirmado resolvido na v38. Evidência mais fraca que a do BUG-27 — apenas 2 casos '
            + 'observados (02/07 e 08/07/2026) —, mas sem nenhum contraexemplo posterior à abertura do item.'
    });
    console.log(`✅ BUG-${bug28.numero} atualizado (${bug28.status})`);

    console.log('✅ Escritas de backlog do encerramento v38 concluídas.');
}

main().catch(e => {
    console.error('❌ Falha nas escritas de backlog:', e.message);
    process.exit(1);
});
