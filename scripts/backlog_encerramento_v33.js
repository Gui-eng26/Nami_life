// Escritas de backlog do encerramento v33 (briefings/encerramento_v33.md, seção 1.3) —
// executado uma vez, via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v33';
const DATA = '2026-08-19';

async function main() {
    // a) Fechar MH-073 Parte A — converte o item criado sem parte (v30) na Parte A
    const mh073 = await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 73, parte: '',
        novaParte: 'A',
        novoTitulo: 'Medicamentos líquidos — separação entre unidade de estoque e unidade de dose',
        novoStatus: 'em_validacao',
        prioridade: 'alta',
        sessaoFechamento: SESSAO,
        dataFechamento: DATA,
        notas: 'Modelagem entregue e validada parcialmente em produção (Nimesulida, delta -3 via '
            + 'degrau 1). Pendente: observar debito -2 em Omega 3 e primeira dose de medicamento '
            + 'liquido real (so existira apos Parte B).'
    });
    console.log(`✅ MH-73 -> MH-73 Parte ${mh073.parte} (${mh073.status})`);

    // b) Abrir MH-073 Partes B a E
    const partes = [
        {
            parte: 'B',
            titulo: 'Cadastro de medicamento liquido — frasco lacrado (caso exato)',
            descricao: 'Coleta de unidade_dose (conjunto fechado: comprimido/cápsula · gotas · ml), '
                + 'quantidade_por_dose, gotas_por_ml quando aplicável, e estoque de frasco lacrado '
                + '(volume × quantidade = valor exato). Substitui a etapa cad_forma por '
                + 'cad_unidade_dose e acrescenta cad_quantidade_por_dose. forma_farmaceutica deixa de '
                + 'ter pergunta própria e passa a ser derivada. Inclui cadastro.js:406-431, deixado '
                + 'explicitamente fora da Parte A por depender da coleta.'
        },
        {
            parte: 'C',
            titulo: 'Estoque aproximado de frasco ja aberto — escala visual por fracoes',
            descricao: 'Escala visual por frações para frasco já aberto (acabei de abrir / ~3/4 / '
                + '~metade / ~1/4 / quase acabando) → conversão para ml, marcada como estimativa em '
                + 'stock_movements.origem/motivo. Isolada por ser o maior risco de UX.'
        },
        {
            parte: 'D',
            titulo: 'Apresentacao — unidade correta em todos os textos (~34 pontos)',
            descricao: '~34 pontos com unidade/unidades/comprimidos hardcoded — 7 em '
                + 'estoqueTemplates.js, 8 em cadastro.js, 6 em prompts.js, restante em '
                + 'relatorios.js, principal.js, configuracao.js, scheduler.js, adesaoTemplates.js. '
                + 'Inclui exibir quantidade_por_dose no texto do lembrete (a RPC já expõe o campo).'
        },
        {
            parte: 'E',
            titulo: 'Reposicao de frasco lacrado e revisao do limiar de alerta',
            descricao: 'Recompra de frasco lacrado reancorando o estoque em valor exato — é o '
                + 'momento em que a imprecisão acumulada da Parte C é zerada, por desenho e não por '
                + 'acaso. Inclui revisão de estoque_minimo (default 7 não significa nada em ml) e de '
                + 'calcularAlertaEstoque para unidade fracionária.'
        },
    ];

    for (const p of partes) {
        const resultado = await registrarItemBacklog({
            tipo: 'MH', numero: 73, parte: p.parte,
            titulo: p.titulo,
            descricao: p.descricao,
            status: 'aberto',
            prioridade: 'alta',
            relacionado: 'MH-073',
            sessaoCriacao: SESSAO,
            dataCriacao: DATA
        });
        console.log(`✅ MH-73 Parte ${resultado.parte} criada (${resultado.status})`);
    }

    // c) Abrir MH-077 — recorrência de posologia
    const mh077 = await registrarItemBacklog({
        tipo: 'MH', numero: 77,
        titulo: 'Recorrencia de posologia — 1x por semana, dia sim dia nao, dias especificos',
        descricao: 'A Nami não capta dinâmicas de recorrência. schedules.dias_semana existe e é '
            + 'corretamente respeitada por get_pending_reminders, mas nenhum fluxo do código jamais '
            + 'escreve nela — verificado: 42 de 42 registros com o default de 7 dias, e a coluna '
            + 'aparece em um único select (database.js:232). Infraestrutura pronta, coleta '
            + 'inexistente. Adicionalmente, "dia sim dia não" não é representável no modelo atual: '
            + 'dias_semana é array de dias fixos, e um ciclo de N dias desliza pela semana — exige '
            + 'uma segunda forma de recorrência (cadência por intervalo). Ortogonal a líquidos; '
            + 'deliberadamente fora da MH-073.',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-77 criada (${mh077.status})`);

    // d) Abrir ACH-01 — reversão usa quantidade atual, não a histórica
    const ach01 = await registrarItemBacklog({
        tipo: 'ACH', numero: 1,
        titulo: 'Reversao de dose devolve a quantidade atual, nao a efetivamente debitada',
        descricao: 'reverterConfirmacao chama calcularDeltaEstoqueDaDose, que lê a '
            + 'quantidade_por_dose vigente. Se ela mudar entre a confirmação e a reversão, a '
            + 'devolução diverge do débito. O valor exato está em '
            + 'stock_movements.quantidade_delta na linha com o mesmo dose_log_id; ler de lá exige '
            + 'tratar o caso de múltiplos movimentos por dose. Não implementado na Parte A por '
            + 'decisão explícita.',
        status: 'aberto',
        prioridade: 'baixa',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ ACH-${ach01.numero} criado (${ach01.status})`);

    // e) Abrir ACH-02 — portão de estoque só cobre estoque zerado
    const ach02 = await registrarItemBacklog({
        tipo: 'ACH', numero: 2,
        titulo: 'Portao de estoque do scheduler dispara so em <= 0, nao em insuficiente para a dose',
        descricao: 'scheduler.js:65-66 e :322 testam estoque_atual <= 0. Com dose fracionária ou '
            + 'multi-unidade, o lembrete é enviado mesmo quando o estoque não cobre aquela dose '
            + '(ex: 1 ml restante para dose de 5 ml; 1 comprimido para dose de 3). O usuário '
            + 'confirma, o registrarMovimentoEstoque faz clamp em 0 e o consumo real fica '
            + 'subregistrado. Escopo natural da Parte E.',
        status: 'aberto',
        prioridade: 'media',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ ACH-${ach02.numero} criado (${ach02.status})`);

    // f) Abrir ACH-03 — cadastro cria horários duplicados
    const ach03 = await registrarItemBacklog({
        tipo: 'ACH', numero: 3,
        titulo: 'Cadastro cria schedules duplicados no mesmo horario — saveSchedule sem guarda',
        descricao: 'Evidência de produção: medicamento Nimesulida (ativo) tem três schedules ativos '
            + '— 08:00 (id 6db766be…), 08:00 (id 1b682bf1…) e 22:00 — criados em sequência em 18/08 '
            + '19:02:56-57, no mesmo instante do cadastro_inicial. adicionarSchedule protege contra '
            + 'duplicata (HORARIO_DUPLICADO), mas saveSchedule — usado por processarAcao do '
            + 'cadastro.js e por replaceMedication — não tem guarda alguma: itera sobre '
            + 'action.horarios e insere o que vier do LLM. Impacto (anterior à Parte A, não '
            + 'regressão): infla dosesPerDia, distorcendo diasRestantes e o progresso de tratamento. '
            + 'Após a Parte A, também torna o degrau 2 de resolverQuantidadePorDose ambíguo para '
            + 'doses sem schedule_id naquele horário — o degrau 4 cobre com system_event, mas o '
            + 'dado de origem segue errado.',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ ACH-${ach03.numero} criado (${ach03.status})`);

    console.log('✅ Escritas de backlog do encerramento v33 concluídas.');
}

main().catch(e => {
    console.error('❌ Falha nas escritas de backlog:', e.message);
    process.exit(1);
});
