// ============================================================
// HOTFIX v45 — encerramento (27/09/2026, autorizado por Guilherme:
// "registra os itens no backlog"; briefing
// briefings/execucao_v45_hotfix_encerramento.md §6).
//
// O hotfix já está em produção (main f2cedf2) e no staging (b89c1a4),
// com a correção de dados do §3 aplicada (3 linhas) — o item nasce
// e fecha na mesma sessão. Escritas exclusivamente via src/backlog.js.
// ============================================================

import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const HOJE = '2026-09-27';
const SESSAO = 'v45-hotfix';

async function main() {
    await registrarItemBacklog({
        tipo: 'BUG', numero: 108,
        titulo: 'Encerrar tratamento não fecha a dose pendente do dia e os follow-ups continuam',
        descricao: 'Isaque, produção, 26/09: lembrete do Runner às 20:58 (dose pendente), encerramento confirmado às 21:20 '
            + '("Tratamento com Runner encerrado. Os lembretes foram desativados"), e mesmo assim follow-up às 21:30 e '
            + 'último aviso às 22:32. A dose terminou nao_informado e entrou na adesão como falha. Mesmo padrão em duas '
            + 'doses de usuário de teste (Magnen B6 e Euthyrox, 22/09).',
        causaRaiz: 'encerrarTratamento desativava schedules e gravava o status, mas não fechava os dose_logs pendentes — '
            + 'único caminho de fim de tratamento fora da convenção (pausarMedicamento, concluirTratamento e removerSchedule '
            + "marcam as pendentes como 'pausado'). E getPendingFollowUps selecionava doses pendentes sem olhar o status do "
            + 'remédio, então a dose órfã seguia sendo cobrada e esgotada.',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    await atualizarStatusBacklogItem({
        tipo: 'BUG', numero: 108,
        novoStatus: 'resolvido',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        notas: "Hotfix hotfix/encerramento (a391b6c): encerrarTratamento marca pendentes como 'pausado'; "
            + "getPendingFollowUps faz join inner com medications.status = 'ativo' (defesa de 2ª linha, protege também o "
            + 'esgotamento). Main f2cedf2 (deploy), staging b89c1a4. Dados: 3 dose_logs nao_informado → pausado em produção. '
            + 'Caso A48 no arnês. Validação sem LLM (checagem de banco no staging nos dois branches, A0 verde); '
            + 'A48/A24/A25 ainda não rodados com LLM por decisão de custo.'
    });
    console.log('✅ BUG-108 criado e resolvido (encerramento não fechava a dose pendente — Isaque, 26/09)');
}

main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
