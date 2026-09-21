// ============================================================
// ENCERRAMENTO v44 M4 (21/09/2026, autorizado por Guilherme:
// "arnes 100%. Pode seguir para o encerramento e fazer os registros
// no backlog").
//
// Padrão dos marcos anteriores: o que foi entregue NESTE marco entra
// como 'em_validacao' (o código está na staging) e vira 'resolvido' na
// promoção; o que já está em produção e foi SUPERADO por construção
// vai direto a 'resolvido'. Escritas exclusivamente via src/backlog.js
// (padrão técnico nº 7).
//
// MH-92 não aparece aqui: já estava 'resolvido' desde a v42 e o M4
// preserva o comportamento (data completa em um turno; agora absorvida
// no rascunho pré-consentimento e nunca reperguntada — caso A10/A33).
// ============================================================

import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const HOJE = '2026-09-21';
const SESSAO = 'v44-M4';

async function main() {
    // ---- 1. Entregue no M4 (staging) → em_validacao ----

    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 87, parte: '',
        novoStatus: 'em_validacao',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        notas: 'Fechado pelos DOIS lados. Cadastro/configuração: desde o M2 a reformulação pós-falha '
            + 'reconhece o que a pessoa disse (aberturas do schema, regra 3 da Constituição). Onboarding: '
            + 'no M4 o fluxo virou schema no runner e o reconhecimento passou a ser por construção — '
            + 'contexto de saúde vira "Anotei o X aqui" antes de repedir o nome, e o dump na etapa de LGPD '
            + 'responde com a listagem curta do que foi entendido antes de repedir só o consentimento '
            + '(casos A33/A35). Sobe a produção na promoção do M4.'
    });
    console.log('✅ MH-87 → em_validacao (reformulação pós-falha reconhece o que a pessoa disse — os dois lados)');

    await registrarItemBacklog({
        tipo: 'ACH', numero: 11,
        titulo: 'Replay manual do M4 — 3 defeitos corrigidos na sessão (um deles atravessa M2/M3)',
        descricao: 'Replay completo do onboarding no runner (Guilherme, 21/09, staging, número limpo): '
            + '(1) mensagem_rica do pós-onboarding era preservada mesmo sendo um "oi", e o fast-path de aceite '
            + 'sequestrava o turno seguinte ("Quero corrigir minha data de nascimento" virava cadastro) — passou a '
            + 'ser preservada só quando carrega conteúdo de cadastro; (2) a recepção e o pedido de consentimento '
            + 'citavam só o 1º medicamento (o rascunho guardava um nome, porque o extrator completo devolve um só), '
            + 'dando a impressão de que os outros tinham se perdido embora todos fossem cadastrados — a lista passou '
            + 'a vir da porta e a proposta dela é reusada no fechamento (mesma classe do BUG-101), sem chamada extra; '
            + '(3) "Predsin 2mg 2mg" na proposta de lote.',
        causaRaiz: 'No achado (3): o campo `medicamentos` da porta DECLARA "sem dosagem", mas o modelo devolvia a '
            + 'concentração junto do nome; a divisão multi-med extraía a dosagem da linha outra vez. Além do texto '
            + 'duplicado, o nome era GRAVADO com a concentração embutida num schema em que dosagem é coluna própria. '
            + 'Como a saída da porta é proposta e nunca decisão, o contrato passou a ser feito cumprir na normalização '
            + '(limparDosagemDoNome), com rotularNomeComDosagem como defesa em profundidade nos 5 pontos que compõem o '
            + 'rótulo. ATENÇÃO: este defeito existe desde o M2 e atinge qualquer cadastro multi-medicamento em '
            + 'PRODUÇÃO — a correção não é só do M4.',
        status: 'em_validacao',
        prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE,
        relacionado: 'MH-96'
    });
    console.log('✅ ACH-11 criado → em_validacao (3 defeitos do replay; a limpeza da dosagem corrige produção)');

    // ---- 2. Superados por construção, já em produção → resolvido ----

    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 46, parte: '',
        novoStatus: 'resolvido',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        notas: 'SUPERADO por construção, sem trabalho próprio. Os dois estados-alvo do item deixaram de ser um '
            + 'problema: aguardando_periodo_adesao MORREU no M3 (a adesão reativa 7/15/30 foi removida — pedidos '
            + 'caem no período livre) e aguardando_escolha_tratamento deixou de ser um beco na v44 M1, quando os '
            + 'fast-paths determinísticos (§5.4) passaram a rodar ANTES da porta para QUALQUER estado — '
            + 'tentarConfirmarRespostaTardia (BUG-035) não está mais restrita ao bloco idle do roteador. '
            + 'Verificado no código na sessão do M4.'
    });
    console.log('✅ MH-46 → resolvido (superado: estado morto no M3 + fast-path antes da porta desde o M1)');

    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 89, parte: 'A',
        novoStatus: 'resolvido',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        notas: 'Staging isolado operacional e em uso PLENO: é o banco do arnês de regressão (36 casos, guarda dura '
            + 'que recusa o ref de produção) e o ambiente de todos os replays manuais dos marcos M1–M4, incluindo '
            + 'os testes de ponta a ponta com número real. A pendência de privilégios do service_role citada na '
            + 'causa raiz está resolvida — sem ela o arnês não escreveria no banco. MH-89 B (auditoria por variável '
            + 'de ambiente) segue aberto; MH-89 C (fluxo de promoção) já estava resolvido.'
    });
    console.log('✅ MH-89 Parte A → resolvido (staging é o banco do arnês e de todos os replays)');

    // ---- 3. Evidência nova em item que aguarda a promoção ----

    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 73, parte: 'B.1',
        novoStatus: 'em_validacao',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        notas: 'Pendências das notas anteriores RESOLVIDAS. Os ramos recusa/duvida do classificarIndeterminadoCadastro '
            + 'são exercitados a cada execução do arnês (A6 fecha pela verdade do banco na recusa; A14/A17 cobrem '
            + 'ruido; o prefácio de dúvida é template do schema). A reentrada cadastro→cadastro virou comportamento '
            + 'declarado e testado: a porta, ao reclassificar como cadastro, CONCORDA que o usuário não saiu do fluxo '
            + '(repetirPergunta, sem descartar nada) ou traz medicamento diferente (MH-83, caso A11). O M4 fechou o '
            + 'último agente sem saída — o onboarding também devolve o turno ao roteador pelo contrato universal. '
            + 'Flip para resolvido na promoção do M4.'
    });
    console.log('✅ MH-73 Parte B.1 → em_validacao com a evidência que faltava (flip na promoção)');

    // ---- 4. Item novo nascido da decisão de escopo do M4 ----

    await registrarItemBacklog({
        tipo: 'MH', numero: 97,
        titulo: 'Gate de menores de idade no onboarding (LGPD de menores, art. 14)',
        descricao: 'A Nami coleta nome, telefone e data de nascimento no onboarding, com consentimento do próprio '
            + 'titular. A LGPD (art. 14) trata dados de crianças e adolescentes de forma específica — o tratamento de '
            + 'dados de criança exige consentimento de um dos pais ou responsável legal. Hoje não existe nenhum gate: '
            + 'a idade é conhecida quando a data de nascimento é informada, mas o campo é OPCIONAL (decisão 21/09), '
            + 'então nem sempre há idade. Escopo a definir: se existe gate, em que ponto ele age, o que acontece com '
            + 'quem recusa a data, e como o consentimento do responsável seria colhido por WhatsApp.',
        causaRaiz: 'Decisão de escopo do briefing do M4 (21/09): deliberadamente FORA do marco, por exigir apoio '
            + 'jurídico antes de qualquer desenho de produto. Registrado aqui para não se perder — nenhuma linha de '
            + 'código foi escrita a respeito.',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ MH-97 criado → aberto (gate de menores; decisão adiada, exige apoio jurídico)');

    console.log('\nConcluído. Flip para resolvido na promoção: MH-87, ACH-11, MH-73 B.1.');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
