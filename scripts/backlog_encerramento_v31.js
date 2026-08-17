// Escritas de backlog do encerramento v31 (briefings/encerramento_v31.md, seção 1.2) —
// executado uma vez, via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v31';
const DATA = '2026-08-17';

const itens = [
    {
        tipo: 'BUG', numero: 89, parte: '',
        notas: 'Resolvido na sessão v31 — etapa recep_nome_pos_lgpd adicionada (alcançável '
            + 'apenas a partir da reapresentação, reusa classificarNome), bloco de persistência '
            + 'passou a ler updatedContext em vez de context, e restrição condicional no banco '
            + '(users_nome_obrigatorio_quando_onboarded). Ver CONTEXT.md Sessão v31.'
    },
    {
        tipo: 'MH', numero: 72, parte: 'B',
        notas: 'Resolvido na sessão v31 — separação classificador/gerador aplicada em todo o '
            + 'recepcionista (pareceNome, isLgpdAccepted, contemRecusa, querCadastrar eliminadas). '
            + 'MH-074 implementado dentro desta parte. Ver CONTEXT.md Sessão v31.'
    },
    {
        tipo: 'MH', numero: 74, parte: '',
        notas: 'Resolvido na sessão v31 — implementado dentro do MH-072 Parte B (estados '
            + 'recep_apresentacao e apresentacao_declinada), validado ponta a ponta. '
            + 'Ver CONTEXT.md Sessão v31.'
    },
    {
        tipo: 'BUG', numero: 30, parte: '',
        notas: 'Resolvido na sessão v31 — pareceNome() substituída por classificarNome() no '
            + 'MH-072 Parte B. Ver CONTEXT.md Sessão v31.'
    },
];

async function main() {
    for (const item of itens) {
        const resultado = await atualizarStatusBacklogItem({
            tipo: item.tipo,
            numero: item.numero,
            parte: item.parte,
            novoStatus: 'resolvido',
            sessaoFechamento: SESSAO,
            dataFechamento: DATA,
            notas: item.notas,
        });
        console.log(`✅ ${item.tipo}-${item.numero}${item.parte ? ` Parte ${item.parte}` : ''} -> ${resultado.status}`);
    }
}

main().catch(e => {
    console.error('❌ Falha na escrita de backlog:', e.message);
    process.exit(1);
});
