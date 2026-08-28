// Escritas de backlog do encerramento v36 (briefings/encerramento_v36.md, Tarefa 4.4) —
// executado uma vez, via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { registrarItemBacklog } from '../src/backlog.js';

const SESSAO = 'v36';
const DATA = '2026-08-28';

async function main() {
    // MH-073 Parte C.1 — já implementada e validada nesta sessão
    const mh073c1 = await registrarItemBacklog({
        tipo: 'MH', numero: 73, parte: 'C.1',
        titulo: 'Aproveitar frascos, volume ou valor exato presentes na mesma mensagem do status do frasco',
        descricao: "O ramo de status do frasco (cad_estoque) devolvia imediatamente com apenas "
            + "status_frasco, descartando o resto da mensagem. Evidências em produção: "
            + '"Ta aberto, deve ter uns 60ml", "1 frasco fechado de 100ml", "1 vidro de 100ml fechado" '
            + '— em todos, o usuário informou tudo e a Nami reperguntou. Corrigido para rodar '
            + 'extrairFrascosEVolume (ramo fechado) ou extrairValorExatoEstoque (ramo aberto) na mesma '
            + 'mensagem do status, podendo pular até duas etapas.',
        status: 'em_validacao',
        prioridade: 'alta',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh073c1.numero} Parte ${mh073c1.parte} criada (${mh073c1.status})`);

    // MH-073 Parte C.2
    const mh073c2 = await registrarItemBacklog({
        tipo: 'MH', numero: 73, parte: 'C.2',
        titulo: 'Ramo indeterminado do status de frasco descarta dados presentes na mensagem',
        descricao: 'Achado ao lado da Parte C.1: quando a resposta ao status do frasco não se classifica '
            + 'com clareza em "fechado"/"aberto" (ramo indeterminado), o restante da mensagem — quantidade, '
            + 'volume ou valor exato eventualmente presentes — é descartado do mesmo jeito que o ramo de '
            + 'status descartava antes da C.1. Mesma classe de defeito, ramo diferente. Não corrigido nesta '
            + 'sessão; tratar junto com o ramo determinado se reincidir em produção.',
        status: 'aberto',
        prioridade: 'media',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh073c2.numero} Parte ${mh073c2.parte} criada (${mh073c2.status})`);

    // BUG — cad_confirma_forma chama classificarPosologia e descarta a resposta
    const bug102 = await registrarItemBacklog({
        tipo: 'BUG', numero: 102,
        titulo: "cad_confirma_forma alcançada pela correção de forma chama classificarPosologia e descarta a resposta",
        descricao: "No Briefing #3 da v36, o case 'forma' do classificador de correção pós-resumo foi "
            + "roteado para cad_confirma_forma sem sinalizar o propósito da correção. Essa etapa chama "
            + 'classificarPosologia por padrão, que não reconhece a resposta do usuário sobre a forma '
            + 'farmacêutica — descartando-a e custando um turno extra antes da correção efetiva ser '
            + 'aplicada. Sintoma do mesmo princípio de fundo do BUG-101 (Princípio 53): uma etapa '
            + 'reaproveitada precisa declarar o que faz com a entrada antes de virar destino de um '
            + 'roteamento novo.',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ BUG-${bug102.numero} criada (${bug102.status})`);

    // BUG — correção pós-resumo descarta o conteúdo da própria mensagem em estoque/nome/tipo_tratamento
    const bug103 = await registrarItemBacklog({
        tipo: 'BUG', numero: 103,
        titulo: 'Correção pós-resumo descarta o conteúdo da própria mensagem nos campos estoque, nome e tipo_tratamento',
        descricao: 'Mesma classe do BUG-102: quando o classificador de correção pós-resumo (cad_confirmacao) '
            + 'roteia para estoque, nome ou tipo_tratamento, a etapa de destino faz apenas a pergunta '
            + 'padrão em vez de extrair o valor já presente na própria mensagem de correção — diferente do '
            + 'tratamento que forma e dosagem já receberam nesta sessão (extrairFormaDaMensagem). Custa um '
            + 'turno extra sempre que a correção já vem com o valor novo embutido, ex: "não é 30 comprimidos, '
            + 'são 60".',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ BUG-${bug103.numero} criada (${bug103.status})`);

    // MH — perguntas de cad_horarios renderizadas em código
    const mh85 = await registrarItemBacklog({
        tipo: 'MH', numero: 85,
        titulo: 'Perguntas de cad_horarios renderizadas em código — mesmo padrão do estoque (Princípio 54)',
        descricao: 'Na bateria de 27/08 (v36), a Nami em cad_horarios perguntou "Quantas doses por dia?" '
            + 'quando a instrução do código era "Qual o horário da primeira dose?" — mesma classe de defeito '
            + 'do Princípio 54 (pergunta de etapa determinística nascendo em instrução ao LLM em vez de '
            + 'código). A correção aplicada nesta sessão (renderizarPerguntaEstoque) cobriu só as três etapas '
            + 'de estoque; cad_horarios tem o mesmo risco por estar encadeada com etapas de semântica '
            + 'vizinha (quantidade-por-dose da posologia).',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh85.numero} criada (${mh85.status})`);

    // MH — classificador unificado de estoque líquido
    const mh86 = await registrarItemBacklog({
        tipo: 'MH', numero: 86,
        titulo: 'Classificador unificado de estoque líquido — status, frascos, volume e fração em um turno',
        descricao: 'A Parte C.1 desta sessão ensinou cad_estoque a aproveitar frascos/volume/valor exato '
            + 'quando vêm junto do status do frasco, mas o fluxo continua estruturalmente em três a quatro '
            + 'etapas encadeadas (status → quantidade/fração → volume), cada uma com sua própria extração. '
            + 'Um classificador único, que tenta extrair todos os campos de estoque líquido disponíveis na '
            + 'mensagem em qualquer etapa do fluxo, reduziria tanto o número de turnos quanto a superfície '
            + 'do defeito descrito no Princípio 54 (menos etapas de semântica vizinha para o LLM confundir).',
        status: 'aberto',
        prioridade: 'media',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh86.numero} criada (${mh86.status})`);

    // MH — reformulação após falha não reconhece o que o usuário disse
    const mh87 = await registrarItemBacklog({
        tipo: 'MH', numero: 87,
        titulo: 'Reformulação após falha não reconhece o que o usuário disse — repergunta seca',
        descricao: 'Quando a extração falha e a etapa reformula a pergunta, o texto não reconhece o que o '
            + 'usuário efetivamente disse antes de pedir de novo — repete a pergunta seca, como se a primeira '
            + 'resposta não tivesse chegado. Observado ao lado dos achados de perguntas fora da etapa desta '
            + 'sessão, mas é um problema de tom/UX independente, não de extração incorreta.',
        status: 'aberto',
        prioridade: 'baixa',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh87.numero} criada (${mh87.status})`);

    // MH — registrar em log a mensagem enviada pela Nami
    const mh88 = await registrarItemBacklog({
        tipo: 'MH', numero: 88,
        titulo: 'Registrar em log a mensagem enviada pela Nami, não só o msgId',
        descricao: 'Lacuna exposta pelo diagnóstico das perguntas fora da etapa (v36): os logs do Railway '
            + 'registram o msgId da mensagem enviada pela Nami, mas não o texto. Dois dos cinco pontos '
            + 'reportados na primeira bateria só puderam ser fechados depois de obter o export do WhatsApp. '
            + 'Registrar o texto da mensagem enviada (sem valores de saúde do usuário, mesmo cuidado do '
            + '🔎 [CAD-CLASSIF]) elimina a dependência do export manual em diagnósticos futuros.',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh88.numero} criada (${mh88.status})`);

    // ACH — ordem invertida entre mensagem recebida e etapa do cadastro no log
    const ach7 = await registrarItemBacklog({
        tipo: 'ACH', numero: 7,
        titulo: "Ordem invertida entre 📩 Mensagem recebida e 💊 Cadastro — etapa no mesmo turno (10:04:20 de 28/08)",
        descricao: 'Observado nos logs do Railway às 10:04:20 de 28/08/2026: a linha de log "💊 Cadastro — '
            + 'etapa" aparece antes de "📩 Mensagem recebida" para o mesmo turno de conversa, ordem invertida '
            + 'em relação ao fluxo real (a mensagem é recebida antes de a etapa ser processada). Sem impacto '
            + 'funcional observado — é provavelmente ordenação de flush entre streams de log, não um bug de '
            + 'lógica. Registrado por completude do achado, não priorizado.',
        status: 'aberto',
        prioridade: 'baixa',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ ACH-${ach7.numero} criada (${ach7.status})`);

    console.log('✅ Escritas de backlog do encerramento v36 concluídas.');
}

main().catch(e => {
    console.error('❌ Falha nas escritas de backlog:', e.message);
    process.exit(1);
});
