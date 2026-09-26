// ============================================================
// ENCERRAMENTO v45 (26/09/2026, autorizado por Guilherme no briefing
// briefings/encerramento.v45.md §5).
//
// Sessão de documentação: definições de métrica de base (CONTEXT §13)
// e cor creme no guidance. Nenhum código de produção mudou, então os
// dois itens nascem 'aberto'. Escritas exclusivamente via
// src/backlog.js (padrão técnico nº 7).
//
// Guilherme decidiu explicitamente NÃO abrir item para aplicar a cor
// nova a materiais anteriores — eles ficam como estão.
// ============================================================

import { registrarItemBacklog } from '../src/backlog.js';

const HOJE = '2026-09-26';
const SESSAO = 'v45';

async function main() {
    await registrarItemBacklog({
        tipo: 'MH', numero: 98,
        titulo: 'Dashboard e consultas adotarem as definições de métrica da v45',
        descricao: 'Aplicar as definições da seção 13 do CONTEXT.md ao dashboard e a qualquer consulta de base. '
            + 'Engajamento passa a sair de agent_logs (mensagem do usuário em 7 dias), não de status de dose. '
            + 'Adesão apurada só sobre engajados. Abandono como métrica própria. Ciclo 1 incluído nas contagens. '
            + 'Expor também as doses perdidas por falta de estoque como indicador separado — é argumento '
            + 'comercial com rede de farmácia.',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ MH-98 criado → aberto (dashboard e consultas adotam as definições de métrica da v45)');

    await registrarItemBacklog({
        tipo: 'ACH', numero: 12,
        titulo: 'Engajamento e adesão não podem sair da mesma fonte de dados',
        descricao: 'Achado de 26/09. Medir engajamento por status de dose subestima a base: quem responde à Nami '
            + 'sobre estoque, horário ou qualquer outro assunto está engajado, e isso não aparece em dose_logs. '
            + "Além disso, dose_logs.status = 'sem_estoque' é gravado pelo scheduler quando estoque_atual = 0, "
            + 'sem qualquer ação do usuário — usá-lo como sinal de interação classifica como engajado quem não '
            + 'mandou mensagem nenhuma. Engajamento = agent_logs; adesão = dose_logs. Registrado como achado '
            + 'porque afeta toda análise futura de base, não um bug isolado.',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ ACH-12 criado → aberto (engajamento em agent_logs, adesão em dose_logs)');
}

main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
