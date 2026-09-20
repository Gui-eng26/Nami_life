// ============================================================
// ENCERRAMENTO v44 M2 — registros de backlog (autorizados por
// Guilherme em 19/09/2026: "Pode encerrar atualizando context e
// registrando os itens em backlog").
//
// O M2 está VALIDADO EM STAGING (arnês 24/24 no alvo M2 + replay
// manual parcial), SEM promoção a produção — por isso os itens
// entregues vão para 'em_validacao', nunca 'resolvido' (o flip
// acontece no encerramento da promoção, com o merge para main).
//
// Escritas exclusivamente via src/backlog.js (padrão técnico nº 7).
// ============================================================

import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const HOJE = '2026-09-19';
const SESSAO = 'v44-M2';
const BASE = 'Entregue no M2 (commits 3b8f7ac..fca6b39 na staging; arnês 24/24 no alvo M2, '
    + '169 asserções). VALIDADO EM STAGING — promoção a produção pendente (merge + migrações '
    + '20260919100000/20260919110000 + SQL da Manô). ';

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
    // 1. MH-96 — guarda-chuva do M2: runner + schema + multi-medicamento.
    await emValidacao({
        tipo: 'MH', numero: 96,
        notas: BASE + 'cadastro.js (3.709 linhas) substituído por src/schemas/cadastro.js + '
            + 'src/runner.js + src/validadores/* (classificadores mudaram de endereço, não de '
            + 'lógica). Multi-medicamento: LOTE com confirmação única (A2-pleno/A16 verdes, '
            + 'cada med com o horário DA SUA linha), FILA que sobrevive a desvio e a pivô '
            + '(A17), nome composto "X e Y" → dois registros (A19). Replay manual: Aline ×4 e '
            + 'Priscila OK após correções da própria sessão (ver ACH-10).'
    });

    // 2. MH-77 — recorrência.
    await emValidacao({
        tipo: 'MH', numero: 77,
        notas: BASE + 'Descoberta de código: schedules.dias_semana JÁ era text[] (seg..dom) com '
            + 'DEFAULT de todos os dias e a RPC get_pending_reminders JÁ filtrava por ela — '
            + 'modelo aproveitado (não o int[] do briefing). Aditivo: intervalo_dias + '
            + 'data_inicio + filtro de intervalo na RPC. Validador de recorrência agora '
            + 'PREENCHE (seg-sex 6h + sáb-dom 10h = dois schedules com dias distintos, caso A3 '
            + 'verde no mesmo turno); dia sim/dia não e 1x por semana com dia nomeado; ciclos '
            + 'por semanas seguem AINDA_NAO. Consumidores de dose diária revisados (consumo '
            + 'semanal ÷ 7, balanço do dia, próximos, preservação em replace/reativação). '
            + 'Replay manual de Guilherme validou horários por dia. SQL da Manô: '
            + 'scripts/sql_mano_recorrencia_producao.sql (rodar em produção após o merge).'
    });

    // 3. MH-30 — conclusão automática de tratamento agudo.
    await emValidacao({
        tipo: 'MH', numero: 30,
        notas: BASE + 'Job diário do scheduler (09:00 BRT): tratamento_fim vencido → desativa '
            + 'medicamento + schedules, pausa doses pendentes e avisa PELO FUNIL '
            + '(proativo:conclusao_tratamento, template de celebração leve com o caminho de '
            + 'extensão). A RPC também filtra tratamento_fim: dose de tratamento vencido nunca '
            + 'nasce, mesmo antes do job (caso A21 determinístico, com controle positivo).'
    });

    // 4. MH-49 — limiar de alerta do temporário.
    await emValidacao({
        tipo: 'MH', numero: 49,
        notas: BASE + 'Para temporário, o alerta de estoque compara com os dias RESTANTES do '
            + 'tratamento (tratamento_fim), nunca com o limiar fixo de contínuo — estoque que '
            + 'cobre o fim nunca gera "compre mais" (caso A22 determinístico). Achado: o ramo '
            + 'antigo comparava tipo "agudo", valor inexistente no CHECK — era inalcançável.'
    });

    // 5. MH-86 — estoque líquido num turno só.
    await emValidacao({
        tipo: 'MH', numero: 86,
        notas: BASE + 'Ponto de entrada único do estoque líquido: status + nº de frascos + '
            + 'volume + fração ditos numa mensagem são todos aproveitados; resgates '
            + 'determinísticos (status/fração por regex, volume DECLARADO "de 60ml" nunca '
            + 'confundido com sobra); matemática de gotas/ml intocada. Caso A23 (5 combinações, '
            + 'determinístico). Absorve MH-73 C.1/C.2 na prática.'
    });

    // 6. MH-85 — perguntas renderizadas em código.
    await emValidacao({
        tipo: 'MH', numero: 85,
        notas: BASE + 'Generalizado além do pedido: TODAS as perguntas de coleta do cadastro '
            + '(não só cad_horarios) são renderizadas em código no schema '
            + '(src/schemas/cadastro.js); o cadastro não faz mais NENHUMA chamada de LLM de '
            + 'geração — só classificadores. Grep-guard executável no arnês (caso A0): '
            + 'pergunta de coleta fora do schema é falha de suíte.'
    });

    // 7. MH-83 — nada do anterior vaza no pivô de medicamento.
    await emValidacao({
        tipo: 'MH', numero: 83,
        notas: BASE + '"Medicamento diferente = cadastro novo" virou comportamento do runner: '
            + 'reset TOTAL do tratamento corrente (a fila de outros pendentes sobrevive), '
            + 'anterior gravado fecha pela verdade do banco. Asserção A11-M2: Losartana só com '
            + 'o horário da própria mensagem, nunca o 06:00 da Desvenlafaxina.'
    });

    // 8. BUG-102 — cad_confirma_forma morreu por construção.
    await emValidacao({
        tipo: 'BUG', numero: 102,
        notas: BASE + 'Morto por construção: a etapa cad_confirma_forma (e toda a etapa de '
            + 'confirmação artesanal) não existe mais no código — forma é inferida, pergunta só '
            + 'na ambiguidade real. Verificado por asserção, não por correção: grep-guard '
            + 'executável no caso A0 do arnês.'
    });

    // 9. ACH-3 — guarda anti-duplicata no saveSchedule.
    await emValidacao({
        tipo: 'ACH', numero: 3,
        notas: BASE + 'saveSchedule (ponto único de escrita de schedules) recusa horário '
            + 'duplicado do mesmo medicamento. Verificação viva no caso A0: segundo '
            + 'saveSchedule no mesmo horário não duplica.'
    });

    // 10. ACH-4 — validador de formato de dosagem.
    await emValidacao({
        tipo: 'ACH', numero: 4,
        notas: BASE + 'Dosagem ganhou validador de formato (ponto único ehDosagemPura/'
            + 'ehDosagemReconhecivel): dosagem pura ("1000mg") nunca vira nome (caso A14) e '
            + 'formato não reconhecível não é aceito como dosagem. Guardas no caso A0.'
    });

    // 11. MH-73 C.1 — absorvido pelo MH-86.
    await emValidacao({
        tipo: 'MH', numero: 73, parte: 'C.1',
        notas: BASE + 'Cobertura verificada por asserção (caso A23): frascos+volume ditos na '
            + 'mesma mensagem do status resolvem num turno só. Absorvido pelo ponto de entrada '
            + 'único do MH-86.'
    });

    // 12. MH-73 C.2 — dados da mesma mensagem nunca descartados.
    await emValidacao({
        tipo: 'MH', numero: 73, parte: 'C.2',
        notas: BASE + 'Cobertura verificada por asserção (caso A23): fração sem volume fica '
            + 'PENDENTE (nunca descartada) e falta só o volume; volume declarado nunca vira '
            + 'sobra. Absorvido pelo ponto de entrada único do MH-86 (P57).'
    });

    // 13. ACH-10 — achados do replay manual do M2 (caso Priscila), corrigidos na sessão.
    await registrarItemBacklog({
        tipo: 'ACH', numero: 10,
        titulo: 'Achados do replay manual do M2 (caso Priscila) — divisão multi-med, alteração de med ativo e gramas',
        descricao: '(a) "Vitamina D" casava por substring dentro de "Vitamina de A a Z" na '
            + 'divisão multi-med e herdava a posologia dela — corrigido com atribuição de '
            + 'linhas em dois passes (igualdade exata + fronteira de palavra), guardas no A0. '
            + '(b) Mensagem sobre medicamento JÁ ATIVO com horário/quantidade caía no beco '
            + '"já está cadastrado... é só me dizer" sem executar nada — agora despachada à '
            + 'configuração com o contexto do registro. (c) Gramas na fala são POSOLOGIA '
            + '(decisão de produto de Guilherme): nunca escrever em dosagem; convenção '
            + 'pré-MH-93 = cada dose de pó vira 1 unidade, POR VALOR (caso creatina: "1 scoop, '
            + '10grs, 1 sachê" fica correto), com a resposta declarando a conversão. '
            + 'Remanescentes direcionados: medida real em gramas (posologia e estoque) é o '
            + 'MH-93; alterar quantidade por dose pós-cadastro e copy das configurações vão '
            + 'para o briefing do M3.',
        causaRaiz: '(a) continência sem fronteira de palavra na atribuição de linhas; '
            + '(b) portão de duplicata sem caminho de alteração; (c) coerção inicial modelou '
            + 'gramas como dosagem do produto.',
        status: 'em_validacao', prioridade: 'media',
        sessaoCriacao: SESSAO, dataCriacao: HOJE,
        relacionado: 'MH-096'
    });
    console.log('✅ ACH-10 registrado (em_validacao)');

    // 14. MH-93 — decisão de produto registrada + priorização sugerida.
    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 93,
        novoStatus: 'aberto',
        prioridade: 'alta',
        notas: 'Decisão de produto do replay do M2 (19/09, Guilherme): gramas ditos na '
            + 'posologia ("5gr às 10h", "10grs às 11h") são POSOLOGIA por horário, nunca '
            + 'dosagem do produto — e a posologia de pó varia por horário (caso creatina: '
            + '"1 scoop às 10h, 10grs às 11h, 1 sachê às 20h"). Até este MH, vale a convenção '
            + 'declarada: cada dose = 1 unidade, com aviso na resposta. Escopo real daqui: '
            + 'unidade_dose "g" (CHECK + derivações + rótulos), posologia em gramas por '
            + 'horário e estoque/cobertura em gramas ("tenho 300g"). Prioridade elevada para '
            + 'alta — caso real em produção (creatina do Felipe).'
    });
    console.log('✅ MH-93 notas + prioridade alta');

    console.log('\n🏁 Encerramento v44-M2: 12 itens → em_validacao · ACH-10 criado · MH-93 repriorizado');
}

main().catch(e => {
    console.error('❌', e.message);
    process.exit(1);
});
