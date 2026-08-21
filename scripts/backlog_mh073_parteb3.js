// Escritas de backlog da seção 9 do briefings/BRIEFING_MH073_PARTEB3.md — executado uma
// vez, via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
// Autorizadas por Guilherme nesta sessão (v34). Nota: `prioridade` na tabela só aceita
// alta/media/baixa — BUG-97 (crítico no briefing) foi registrado como `alta`, a mais
// severa disponível, com a severidade real explicada na descrição.
import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v34';
const DATA = '2026-08-21';

async function main() {
    await registrarItemBacklog({
        tipo: 'BUG', numero: 94,
        titulo: 'Mensagem do cadastro afirma posologia/estoque ausentes do estado — geração livre em caminhos sem renderização em código',
        descricao: 'Cinco ocorrências na validação de produção de 20/08 (15:53-16:27): a Nami afirmou '
            + 'horários, quantidade e dias de estoque restante que não batiam com o estado gravado — em '
            + 'alguns casos lidos da CONVERSA RECENTE em vez do banco. Corrigido em cad_tipo_tratamento, '
            + 'cad_estoque (pergunta e indeterminado) e cad_salvo: só citam dado de saúde a partir de um '
            + 'trecho renderizado em código; sem trecho, não citam nada. Regra global reforçada em '
            + 'buildSystemPrompt proibindo citar CONVERSA RECENTE para esses dados.',
        status: 'em_validacao',
        prioridade: 'alta',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'BUG', numero: 95,
        titulo: 'decidirCadConfirmaForma descarta correção de horários e de frequência',
        descricao: 'Tratava só posologia_completa e formaExplicita — horarios_apenas e '
            + 'frequencia_intervalo caíam no fallback genérico ("avança sem confirmação clara") e a '
            + 'correção do usuário era descartada em silêncio. Reprodução: 15:53:05, correção "vai '
            + 'começar às 16hrs" na etapa cad_confirma_forma foi ignorada. Corrigido: dois ramos novos, '
            + 'reaproveitando remapearParesParaNovosHorarios e recalcularGradePorIntervalo; nunca bloqueia.',
        status: 'em_validacao',
        prioridade: 'alta',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'BUG', numero: 96,
        titulo: 'corrigirPosologiaEmConfirmacao não trata correção por intervalo',
        descricao: 'Tratava posologia_completa, horarios_apenas e quantidade_apenas — frequencia_intervalo '
            + 'caía em indeterminado com contextUpdates vazio. Reprodução: 15:56:28, "Vou tomar de 8 em '
            + '8hrs começando as 16hrs" não mudou o estado. Corrigido: ramo frequencia_intervalo recalcula '
            + 'a grade via calcularHorariosPorIntervalo quando há horário de início; sem início, avança '
            + 'para cad_horarios (reaproveitando o "aguardando primeira dose" já existente).',
        status: 'em_validacao',
        prioridade: 'alta',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'BUG', numero: 97,
        titulo: 'REGRESSÃO (Parte B): estoque sólido perde o número quando informado em frase natural',
        descricao: 'cadastro.js: `parseInt(message) || 0` — "Tenho 30 cps" e "Caixa com 60" viravam 0. '
            + 'Reprodução: lipitor ("Caixa com 60") e diovan ("Tenho 30 cps") gravados com estoque_atual=0. '
            + 'Regressão introduzida pela própria especificação da Parte B (seção 6.5), que substituiu a '
            + 'extração por LLM (pré-Parte B) por parse ingênuo sem extrator equivalente. Corrigido: '
            + 'classificador dedicado classificarEstoqueSolido (mesmo padrão dos demais classificadores da '
            + 'etapa), com zero como categoria "quantidade" válida e falha de extração devolvendo '
            + '"indeterminado" (nunca 0). Ramo líquido (extrairFrascosEVolume) mantido; só passou a '
            + 'repreguntar em vez de assumir 0 quando o volume não é reconhecido. CRÍTICO — prioridade da '
            + 'tabela limitada a alta/media/baixa, mas esta é a mais severa do lote.',
        status: 'em_validacao',
        prioridade: 'alta',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'BUG', numero: 98,
        titulo: 'Correção do primeiro horário não recalcula a grade quando há intervalo declarado',
        descricao: 'Posologia "de 8 em 8h começando às 6h" -> 06:00/14:00/22:00. Correção "o primeiro '
            + 'horário é às 16hrs" trocou só o valor e reordenou (14:00/16:00/22:00) em vez de recalcular '
            + 'a grade a partir do novo início (16:00/00:00/08:00) — perdeu a semântica de que os horários '
            + 'eram derivados de um intervalo, não escolhidos um a um. Corrigido: novas funções '
            + 'identificarNovoInicio + recalcularGradePorIntervalo + resolverCorrecaoHorariosApenas, '
            + 'compartilhadas por corrigirPosologiaEmConfirmacao e decidirCadConfirmaForma sempre que '
            + 'context.intervalo_horas está preenchido — só recalcula quando dá pra identificar com '
            + 'segurança que o início mudou (nunca assume que é só o horário mais cedo em relógio, o que '
            + 'apagaria uma correção feita numa dose que não é a primeira do dia).',
        status: 'em_validacao',
        prioridade: 'media',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'BUG', numero: 99,
        titulo: 'forma_farmaceutica aceita palpite incompatível com unidade_dose',
        descricao: 'Claritin gravado com unidade_dose=ml e forma_farmaceutica=comprimido — o palpite de '
            + 'sugerirFormaFarmaceutica foi aceito sem checagem de coerência com a unidade já resolvida. '
            + 'Corrigido: tabela FORMAS_COMPATIVEIS (via helper formaCompativelComUnidade) aplicada SOMENTE '
            + 'sobre o palpite silencioso (nunca sobre forma_explicita/forma_confirmada vindas de fala '
            + 'literal do usuário) — palpite incompatível vira null e cai no rótulo genérico. Fala explícita '
            + 'incompatível é apenas sinalizada para investigação (evento '
            + 'cadastro:forma_explicita_incompativel), nunca descartada — checagem comparada contra a '
            + 'unidade já persistida no contexto quando a mensagem de correção não repete a unidade.',
        status: 'em_validacao',
        prioridade: 'media',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'MH', numero: 80,
        titulo: 'Aproveitar dados completos informados na primeira mensagem do cadastro',
        descricao: 'Reprodução: 16:16:00, "Quero cadastrar o xarope expec, vou tomar 5ml as 17hrs, tenho '
            + '1 vidro de 100ml" — só o nome foi aproveitado, todo o resto foi reperguntado. Implementado: '
            + 'classificador extrairCadastroCompleto, disparado só em cad_nome quando a mensagem tem dígito '
            + 'ou mais de 6 palavras (evita chamada extra em mensagens simples). montarSaltoCadastroCompleto '
            + 'grava todos os campos extraídos e avança para a primeira etapa faltante na ordem canônica, '
            + 'sem pular etapas no meio nem contornar a verificação de duplicata. Falha de extração degrada '
            + 'para o fluxo normal (pergunta o nome de novo). Zero de estoque tratado com o mesmo cuidado do '
            + 'BUG-97 (campo ausente nunca vira 0 por conversão implícita — Number(null) seria 0 sem o '
            + 'guard explícito de tipo).',
        status: 'em_validacao',
        prioridade: 'media',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    const parteB3 = await registrarItemBacklog({
        tipo: 'MH', numero: 73, parte: 'B.3',
        titulo: 'Conteúdo determinístico e exaustividade das decisões',
        descricao: 'Segunda bateria de validação em produção (20/08, 15:46-16:28 BRT) — corrige BUG-94 a '
            + 'BUG-99 e implementa MH-80. Ver briefings/BRIEFING_MH073_PARTEB3.md.',
        status: 'aberto',
        prioridade: 'alta',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-73 Parte ${parteB3.parte} criada (${parteB3.status})`);

    const parteB3Fechada = await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 73, parte: 'B.3',
        novoStatus: 'em_validacao',
        sessaoFechamento: SESSAO,
        dataFechamento: DATA,
        notas: 'Implementação concluída nesta sessão: renderização em código estendida a '
            + 'cad_tipo_tratamento/cad_estoque/cad_salvo (BUG-94); decidirCadConfirmaForma e '
            + 'corrigirPosologiaEmConfirmacao tratam horarios_apenas e frequencia_intervalo, com detecção '
            + 'robusta de novo início via identificarNovoInicio (BUG-95/96/98); classificarEstoqueSolido '
            + 'substitui parseInt(message) (BUG-97, crítico); FORMAS_COMPATIVEIS filtra palpite '
            + 'incompatível sem descartar fala explícita, checando contra a unidade já persistida (BUG-99); '
            + 'extrairCadastroCompleto + montarSaltoCadastroCompleto implementam MH-80, com estoque=0 nunca '
            + 'confundido com campo ausente. Revisão de código (angles A-C + reuse/simplification/'
            + 'efficiency/altitude, 5 agentes em paralelo) encontrou e corrigiu 3 bugs adicionais '
            + 'introduzidos pela própria implementação desta sessão antes do commit: MH-80 colapsando '
            + 'estoque ausente em 0 via Number(null)===0, heurística de novo-início ingênua (mais cedo em '
            + 'relógio) em decidirCadConfirmaForma que podia apagar uma correção legítima, e checagem '
            + 'BUG-99 ignorando a unidade já persistida quando a mensagem de correção não a repete. '
            + 'Pendente: validação em produção (cenários da seção 8 do briefing).'
    });
    console.log(`✅ MH-73 Parte ${parteB3Fechada.parte} -> ${parteB3Fechada.status}`);

    console.log('✅ Escritas de backlog da seção 9 (Parte B.3) concluídas.');
}

main().catch(e => {
    console.error('❌ Falha nas escritas de backlog:', e.message);
    process.exit(1);
});
