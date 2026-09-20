// ============================================================
// ENCERRAMENTO v44 M3 — registros de backlog.
//
// GOVERNANÇA (briefing M3): nenhuma escrita em backlog_items a
// partir do briefing — este script SÓ RODA com o "sim, registra"
// explícito de Guilherme (contrato da seção "Registros para o
// encerramento").
//
// O M3 está VALIDADO EM STAGING (arnês no alvo M3), SEM promoção a
// produção — itens entregues vão para 'em_validacao'; o flip para
// 'resolvido' acontece no encerramento da promoção (merge → main).
//
// Escritas exclusivamente via src/backlog.js (padrão técnico nº 7).
// ============================================================

import { atualizarStatusBacklogItem } from '../src/backlog.js';

const HOJE = '2026-09-20';
const SESSAO = 'v44-M3';
const BASE = 'Entregue no M3 (staging; arnês 32 casos no alvo M3, expected-fail só A10/M4). '
    + 'VALIDADO EM STAGING — promoção a produção pendente (merge + migração '
    + '20260920000000_v44_m3_status_tratamento). ';

async function emValidacao({ tipo, numero, parte = '', notas }) {
    await atualizarStatusBacklogItem({
        tipo, numero, parte,
        novoStatus: 'em_validacao',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        notas
    });
    console.log(`✅ ${tipo}-${numero}${parte ? ` Parte ${parte}` : ''} → em_validacao`);
}

async function main() {
    // ---- Verificados em 20/09 (fora do código do M3) ----
    // ACH-1 vai DIRETO a resolvido: o código verificado já está em produção
    // desde antes do M3 — não depende da promoção deste marco.
    await atualizarStatusBacklogItem({
        tipo: 'ACH', numero: 1, parte: '',
        novoStatus: 'resolvido',
        sessaoFechamento: SESSAO, dataFechamento: HOJE,
        notas: 'Verificado em 20/09 (sessão M3): reverterConfirmacao devolve o delta '
            + 'efetivamente debitado via calcularDeltaEstoqueDaDose, com guarda P49 para NULL '
            + '(database.js). Já estava resolvido no código em produção — registro de verificação.'
    });
    console.log('✅ ACH-1 → resolvido');

    // ---- P1: estado explícito ----
    await emValidacao({
        tipo: 'BUG', numero: 61,
        notas: BASE + 'Porta 2 da reativação (P3): cadastrar medicamento pausado/encerrado → '
            + 'aviso + foto congelada + oferta reativar/recadastrar. "Isso" avança o recadastro '
            + 'pós-encerramento (caso A25); o encerrado fica preservado no histórico (MH-31).'
    });
    await emValidacao({
        tipo: 'MH', numero: 31,
        notas: BASE + 'medications.status (ativo|pausado|encerrado) + status_alterado_em com '
            + 'backfill; escrita por ponto único. Histórico consultável: subtipo '
            + 'historico_encerrados ("quais tratamentos eu já encerrei?"); encerrados '
            + 'preservados no recadastro (registro novo, nunca sobrescrita).'
    });

    // ---- P2: edição via runner ----
    await emValidacao({
        tipo: 'MH', numero: 75,
        notas: BASE + 'schemas/perfil.js (nome + data de nascimento, reaproveitando o validador '
            + 'de data do onboarding) no modo correção do runner; ação corrigir_dados_pessoais '
            + 'no configuracao; inventário atualizado no mesmo commit (P21). Caso A26 verde. '
            + 'Caminho de remediação do BUG-030 disponível.'
    });
    await emValidacao({
        tipo: 'MH', numero: 79,
        notas: BASE + 'Edição de dosagem/forma que indica apresentação DISTINTA (sólido↔líquido) '
            + 'oferece novo tratamento com nome qualificado ("X (gotas)") — nunca sobrescrita '
            + 'nem bloqueio. Confirmação inicia cadastro novo com o nome preenchido.'
    });
    await emValidacao({
        tipo: 'MH', numero: 41,
        notas: BASE + 'Alteração/remoção de horário CANCELA a dose pendente do horário antigo no '
            + 'mesmo ato (alterarHorarioSchedule + reativarComAtualizacao — horários que saem da '
            + 'grade pausam as pendentes). Asserção A26 verde.'
    });
    // MH-43 é PARCIAL: a fatia de prorrogação foi entregue, mas o item segue
    // ABERTO (pós-encerramento e alertas vencidos permanecem) — só a nota muda.
    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 43, parte: '',
        novoStatus: 'aberto',
        sessaoFechamento: null, dataFechamento: null,
        notas: 'PARCIAL no M3 (20/09, em staging): prorrogação/encurtamento via edição de '
            + 'duração (corrigir_duracao recalcula tratamento_fim — caso A26). Pós-encerramento '
            + 'e alertas vencidos PERMANECEM — item segue aberto como feature.'
    });
    console.log('✅ MH-43 → segue aberto (nota de entrega parcial)');

    // ---- P4: relatórios ----
    await emValidacao({
        tipo: 'MH', numero: 60,
        notas: BASE + 'relatorioEstoque ordena por DIAS DE COBERTURA crescente (estoque ÷ consumo '
            + 'diário real, com recorrência do M2) — mais urgente primeiro. O subtipo "reposicao" '
            + 'citado no item não existe mais; a cobertura já existia nos alertas.'
    });
    await emValidacao({
        tipo: 'MH', numero: 62,
        notas: 'Decisão de escopo documentada (CONTEXT §12.8) com base nos logs de produção '
            + '(45 dias): uso do subtipo proximo_remedio é quase nulo (3 mensagens, todas na '
            + 'prática balanço). Escopo MANTIDO: "remédios de hoje" com passado confirmado '
            + 'oculto (v25). MH-63 alinhou o enquadramento da janela "agora".'
    });
    await emValidacao({
        tipo: 'MH', numero: 63,
        notas: BASE + 'Janela "agora" de getProximosMedicamentos: só horário que JÁ chegou '
            + '(diff ≤ 0, até 2h atrás) — nunca mais "está na hora de tomar" 30 minutos antes; '
            + 'futuro é "próximo às HH:MM", alinhado ao enquadramento do balanço.'
    });
    await emValidacao({
        tipo: 'MH', numero: 50,
        notas: BASE + 'BLOCO_ESTOQUE.insuficiente declara o estoque REAL ([Estoque]); cobertura '
            + 'zero tem fraseado próprio (BLOCO_ESTOQUE.zerado) — nunca "dá pra mais 0 dias".'
    });

    // ---- P6: confiabilidade transversal ----
    await emValidacao({
        tipo: 'BUG', numero: 86,
        notas: BASE + 'Dupla pendência (pergunta de fluxo SIM/NÃO aberta + dose pendente): vence '
            + 'a PERGUNTA FEITA POR ÚLTIMO; mesma janela (90s) → desambiguação de uma linha. '
            + 'Pergunta ABERTA de coleta não disputa (dose vence, regra 5 preservada — A4). '
            + 'Caso A30 em duas partes verde (cenário 01/08 + o inverso).'
    });
    await emValidacao({
        tipo: 'BUG', numero: 69,
        notas: BASE + 'Escalada dupla nunca mais vaza o objeto {escalarParaRoteador} para o '
            + 'funil: interceptado em despacharEscalada (configuracao, runner e '
            + 'configurarExistente) com repergunta segura.'
    });
    await emValidacao({
        tipo: 'ACH', numero: 5,
        notas: BASE + 'despacharEscalada recebe o currentState REAL do chamador '
            + '(coletando_nascimento, adding_med, ...) — "configurando" cravado morreu.'
    });
    await emValidacao({
        tipo: 'MH', numero: 48,
        notas: BASE + 'Sinal explícito de escalada gravado em agent_logs.contexto_conversa '
            + '({escalada: {para: <agente>}}) — consultável sem cruzar console do Railway.'
    });
    await emValidacao({
        tipo: 'MH', numero: 82,
        notas: BASE + '"Encerrar todos" / seleção múltipla nomeada → UMA confirmação agregada '
            + '(etapa confirm_acao_lote), execução em lote com status explícito. Caso A20 verde. '
            + 'Vale também para pausar (mesmo mecanismo).'
    });
    await emValidacao({
        tipo: 'MH', numero: 39,
        notas: BASE + 'Avaliação concluída: fluxo de encerramento em lote implementado junto do '
            + 'MH-82 (uma confirmação agregada; A20 verde).'
    });
    await emValidacao({
        tipo: 'BUG', numero: 36,
        notas: BASE + '"Manter"/"manter assim"/"como estava" reconhecido como confirmação de '
            + 'manutenção no fluxo novo de reativação (tratarManterOuMudar) — o termo continuava '
            + 'fora de isConfirmacao (verificação 20/09). Caso A24/A25.'
    });
    await emValidacao({
        tipo: 'MH', numero: 47,
        notas: BASE + 'Fluxos reescritos do M3 (reativação, correção, lote, estoque agregado) '
            + 'nasceram como templates sob a constituição; passe de tom nas mensagens mais '
            + 'frias do configuracao (fallbacks). Tool-use em todos os classificadores (P6.2).'
    });
    await emValidacao({
        tipo: 'MH', numero: 51,
        notas: BASE + 'Pergunta de esclarecimento no meio de pausar/encerrar cai na camada 2 do '
            + 'contrato universal (escalada reinterpreta com estado real — ACH-5) em vez de '
            + 'repetir a mesma pergunta; a porta responde a dúvida e retoma.'
    });

    console.log('\nConcluído. MH-27 permanece ABERTO como feature (honestidade entregue no M3).');
    console.log('Caso Evandro: sem item novo — coberto por A32 (registrar no §12 do CONTEXT).');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
