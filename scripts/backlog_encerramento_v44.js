// ============================================================
// ENCERRAMENTO v44 — registros de backlog (autorizados por Guilherme
// em 19/09/2026: "pode seguir com os registros de backlog").
// Escritas exclusivamente via src/backlog.js (padrão técnico nº 7).
// ============================================================

import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const HOJE = '2026-09-19';
const SESSAO = 'v44';

async function main() {
    // 1. MH-95 — item novo que SUPERA o BUG-029 (briefing v44 §7).
    await registrarItemBacklog({
        tipo: 'MH', numero: 95,
        titulo: 'Citação como contexto de primeira classe (funil + messageId)',
        descricao: 'Entregue no M1 (v44): todo envio passa pelo funil (funil_envios) gravando '
            + 'zaapId E messageId; T0 empírico (19/09) provou que o referenceMessageId da citação '
            + 'é o messageId. Resolução: citação → lookup no funil → mensagem_citada injetada na '
            + 'porta; citação de lembrete/follow-up AGRUPADO + confirmação confirma exatamente o '
            + 'grupo de doses (dose_logs.funil_envio_id). Evidência: Wellington + Manô 18/09.',
        causaRaiz: 'BUG-029: zapi_message_id gravava o zaapId, e a citação referencia o messageId '
            + '— o fast-path nunca casava. Confirmado pelo T0 com os dois ids lado a lado.',
        status: 'resolvido', prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE,
        relacionado: 'BUG-029'
    });
    console.log('✅ MH-95 registrado (resolvido)');

    // 2. BUG-029 — superado pelo MH-95.
    await atualizarStatusBacklogItem({
        tipo: 'BUG', numero: 29,
        novoStatus: 'superseded',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        relacionado: 'MH-095',
        notas: 'Superado pelo MH-95 (v44 M1 §5.6). T0 de 19/09: referenceMessageId == messageId '
            + '(zaapId nunca bate). Funil grava ambos; legado zapi_message_id passou a preferir messageId.'
    });
    console.log('✅ BUG-029 → superseded (MH-95)');

    // 3. BUG-103 — resolvido ANTECIPADO no M1 (o briefing previa M2/caso A9).
    await atualizarStatusBacklogItem({
        tipo: 'BUG', numero: 103,
        novoStatus: 'resolvido',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        notas: 'Resolvido estruturalmente no M1 (antes do previsto): a etapa de confirmação saiu '
            + 'do fluxo principal do cadastro (resumo agora vem logo após a gravação) e a correção '
            + 'pós-fechamento entra pela porta única (UPDATE_STOCK / configuração). Caso A9 do '
            + 'arnês verde: "Na verdade 9 no estoque" corrige o estoque no mesmo turno.'
    });
    console.log('✅ BUG-103 → resolvido');

    // 4. MH-77 — remapeado para o M2, com o requisito do schema do runner.
    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 77,
        novoStatus: 'aberto',
        notas: 'Remapeado para o M2 (v44): recorrência exige representação no schema '
            + '(schedules.dias_semana já existe; runner precisa gerar e o scheduler respeitar). '
            + 'No M1, o validador determinístico de recorrência garante resposta honesta de limite '
            + '+ gravação só do subconjunto consentido (caso A3 do arnês). Inclui a variação de '
            + 'quantidade POR DIA; quantidade por horário já é suportada (caso A12).'
    });
    console.log('✅ MH-77 remapeado (M2, notas atualizadas)');

    // 5. MH-96 — ex-"Fase 5", com número novo (MH-094 foi retitulado na v43).
    await registrarItemBacklog({
        tipo: 'MH', numero: 96,
        titulo: 'Runner de coleta + múltiplos medicamentos numa mensagem (M2)',
        descricao: 'M2 da arquitetura v44: runner único de coleta com campos como schema, '
            + 'absorvendo o cadastro e destravando N medicamentos registrados a partir da mesma '
            + 'mensagem. Critério de aceite já existe no arnês: caso A2-pleno (os 4 medicamentos '
            + 'da Thaielly registrados), hoje expected-fail deliberado. No M1, multi-med recebe '
            + 'reconhecimento de todos + honestidade de um-por-vez começando pelo primeiro.',
        causaRaiz: null,
        status: 'aberto', prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE,
        relacionado: 'MH-094'
    });
    console.log('✅ MH-96 registrado (aberto, M2)');

    // 6. ACH-9 — achado do replay em produção (decisão adiada por Guilherme).
    await registrarItemBacklog({
        tipo: 'ACH', numero: 9,
        titulo: 'Porta classifica "medicamento já cadastrado + dosagem" como consulta, não cadastro',
        descricao: 'Replay 19/09 (produção): "Predsin 20mg" com o Predsin já cadastrado foi '
            + 'classificado pela porta como relatorios/meus_remedios (listou TODOS os remédios) em '
            + 'vez de cadastro → checagem de duplicado ("o Predsin já está cadastrado e ativo..."). '
            + 'Sem dano — zero duplicata — mas a resposta ideal fala do medicamento citado. '
            + 'Possível causa: histórico recente mostrando o medicamento cadastrado enviesa a porta.',
        causaRaiz: null,
        status: 'aberto', prioridade: 'baixa',
        sessaoCriacao: SESSAO, dataCriacao: HOJE,
        relacionado: 'MH-095'
    });
    console.log('✅ ACH-9 registrado (aberto)');

    console.log('\nEncerramento v44 — 6 escritas concluídas.');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
