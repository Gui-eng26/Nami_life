// Escritas de backlog do encerramento v42 (briefings/encerramento_v42.md, Seção 2) —
// executado uma vez, via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v42';
const DATA = '2026-09-09';

async function main() {
    // 2.1 BUG-104
    const bug104 = await registrarItemBacklog({
        tipo: 'BUG', numero: 104,
        titulo: '`principal` promete cadastro e `cadastro` confirma persistência que nunca ocorre',
        descricao: 'No bloco post_onboarding do router.js, despacharCadastro é chamado com '
            + "context: { etapa: 'cad_nome' } literal e a message do turno corrente. Uma mensagem com "
            + 'quatro medicamentos e horários seguida de "Sim" faz o cadastro receber apenas o "Sim", no '
            + 'primeiro degrau, com contexto vazio. O agente principal, que recebeu a mensagem rica, não '
            + 'tem verbo de cadastro em seu vocabulário de ação (CONFIRM_DOSE, UPDATE_STOCK, '
            + 'REGISTER_NAO_TOMADO, REVERSE_CONFIRMATION) e nenhuma regra o proíbe de prometer a ação — '
            + 'gerou "Vou cadastrar os quatro agora". O cadastro, no turno seguinte, gerou "Tudo '
            + 'cadastrado!" ecoando o histórico. Confirmado: zero linhas em medications para a usuária. '
            + 'Fecha na Fase 2 do plano (CONTEXT.md §11.11).',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ BUG-${bug104.numero} criado (${bug104.status})`);

    // 2.2 MH-090
    const mh090 = await registrarItemBacklog({
        tipo: 'MH', numero: 90,
        titulo: 'Estender o contrato { message } a `principal` e `recepcionista` — afirmação de estado por leitura pós-escrita (P56)',
        descricao: 'O MH-073 Parte C aplicou a disciplina ao cadastro; principal e recepcionista seguem '
            + 'gerando livremente afirmações sobre estado do sistema ("Tudo cadastrado", "Anotei as quatro '
            + 'vitaminas", "totalmente gratuita, sem mensalidade" — as três observadas em produção). Toda '
            + 'mensagem que afirma persistência passa a ser montada a partir de leitura pós-escrita. Inclui '
            + 'dar ao principal tratamento explícito para "usuário trouxe medicamento novo" em vez de prosa '
            + 'livre (P51 aplicado ao vocabulário de ação).',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh090.numero} criado (${mh090.status})`);

    // 2.3 MH-091
    const mh091 = await registrarItemBacklog({
        tipo: 'MH', numero: 91,
        titulo: 'Texto de acolhida enxuto',
        descricao: '9 de 19 usuários do Ciclo 2 mandaram uma ou duas mensagens e sumiram sem dar o nome — '
            + 'viram apenas o texto de acolhida, que soma apresentação, proposta de valor, pergunta e aviso '
            + 'de transparência (MH-076) antes de qualquer interação. Maior perda isolada do funil. Fase 0 '
            + 'do plano: independente das demais, é copy, não toca arquitetura. Guilherme revisa o texto '
            + 'antes da geração.',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh091.numero} criado (${mh091.status})`);

    // 2.4 MH-092
    const mh092 = await registrarItemBacklog({
        tipo: 'MH', numero: 92,
        titulo: 'Data de nascimento em um turno quando a mensagem já traz a data',
        descricao: 'O MH-072 separou a coleta em dia → mês → ano → confirmação, decisão deliberada para '
            + 'contornar o P44. O custo é 4 turnos como piso para todos os usuários; uma usuária gastou 10. '
            + 'Outra entregou a data completa junto do consentimento e ainda assim percorreu a escada '
            + 'inteira. Com o runner de extração da Fase 7, a escada permanece como fallback, nunca como '
            + 'padrão. Substitui os 4 classificadores de campo único de recepcionista.js por um esquema.',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh092.numero} criado (${mh092.status})`);

    // 2.5 MH-093
    const mh093 = await registrarItemBacklog({
        tipo: 'MH', numero: 93,
        titulo: 'Formas por medida ou massa (pó, sachê, granulado) e dedução de estoque correspondente',
        descricao: 'FORMAS_VALIDAS em cadastro.js tem 7 formas e não inclui "pó"; UNIDADES_DOSE_VALIDAS '
            + '(unidade, gota, ml) não representa colher, scoop ou grama. Usuária real tentou cadastrar '
            + 'cúrcuma em pó e o valor foi descartado por validação. Exige decisão própria sobre dedução de '
            + 'estoque, análoga à do MH-073 para líquidos. Fora do escopo da frente de fluidez — registrado '
            + 'para não travar a sessão.',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh093.numero} criado (${mh093.status})`);

    // 2.6 MH-094
    const mh094 = await registrarItemBacklog({
        tipo: 'MH', numero: 94,
        titulo: 'Cadastro de múltiplos medicamentos declarados em uma única mensagem',
        descricao: 'extrairCadastroCompleto devolve nome como string única — extrairia um de quatro '
            + 'medicamentos e ignoraria três. As duas usuárias auditadas bateram nesse limite, com o mesmo '
            + 'comportamento: listar todos os medicamentos de uma vez. Não é caso de borda — é o '
            + 'comportamento natural de quem toma mais de um medicamento, que é o público-alvo. Sem este '
            + 'item, os dois casos ficam parcialmente resolvidos. Exige decisão de desenho própria: '
            + 'cadastro em sequência, confirmação da lista antes, e tratamento de falha parcial. Fase 5 do '
            + 'plano.',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh094.numero} criado (${mh094.status})`);

    // 2.7 MH-040 Parte B
    const mh040b = await registrarItemBacklog({
        tipo: 'MH', numero: 40, parte: 'B',
        titulo: 'Concorrência de turnos — `conversation_state` lido antes da persistência do turno anterior',
        descricao: 'Parte B do MH-040, aberto há 73 dias. Causa raiz agora confirmada: src/index.js '
            + 'responde 200 e dispara handleIncomingMessage sem fila; o único mecanismo é o dedupe de '
            + 'messageId idêntico. Mensagens próximas do mesmo usuário viram execuções concorrentes de '
            + 'routeMessage que leem conversation_state antes de qualquer uma gravar. Evidência: três '
            + "turnos consecutivos de uma usuária, em 6 segundos, todos com estado_conversa = 'idle', "
            + 'produzindo três textos de acolhida completos. Atingiu 5 dos 19 usuários (26%). Solução '
            + 'decidida: fila por usuário (não-negociável) + janela de agregação de 5 segundos (ajustável '
            + 'após medição). Fase 1 do plano.',
        status: 'aberto',
        prioridade: 'alta',
        relacionado: 'MH-040',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh040b.numero} Parte ${mh040b.parte} criado (${mh040b.status})`);

    // 2.8 ACH-008
    const ach008 = await registrarItemBacklog({
        tipo: 'ACH', numero: 8,
        titulo: 'Juiz Offline não marcou afirmação de persistência falsa',
        descricao: 'Três conversas com falha grave — incluindo a Nami afirmando que quatro medicamentos '
            + 'estavam cadastrados sem nenhuma linha em medications — geraram zero registros em '
            + 'system_events. Fato confirmado por consulta direta filtrando pelos três user_id. Se é lacuna '
            + 'de taxonomia ou falha de disparo exige leitura do código do Juiz. Ligado a BUG-104 e MH-090. '
            + 'Nota relacionada: há 10 eventos desvio_comportamental de severidade crítica desde 30/08 com '
            + "status_triagem = 'novo' e backlog_ref nulo, nove com título \"Informação de saúde incorreta "
            + 'ao usuário", nenhum triado.',
        status: 'aberto',
        prioridade: 'media',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ ACH-${ach008.numero} criado (${ach008.status})`);

    // 2.9 MH-89 Parte C — UPDATE
    const mh89c = await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 89, parte: 'C',
        novoStatus: 'resolvido',
        sessaoFechamento: SESSAO,
        dataFechamento: DATA,
        notas: 'Fluxo formalizado no CONTEXT.md §7, subseção "Promoção staging → produção e disciplina do '
            + 'CONTEXT.md". Cinco passos por entrega e três regras de branch, sendo a decisiva que a staging '
            + 'recebe o CONTEXT.md por merge, nunca por cópia de arquivo — cópia é edição, cria alteração '
            + 'independente do mesmo arquivo nos dois lados e transforma merge trivial em reconciliação. '
            + 'Verificado na v42 que main e staging têm o CONTEXT.md byte a byte idêntico '
            + '(md5 7e1ef26a2990, 24.318 bytes).'
    });
    console.log(`✅ MH-${mh89c.numero} Parte ${mh89c.parte} atualizado (${mh89c.status}) — "${mh89c.titulo}"`);

    console.log('✅ Escritas de backlog do encerramento v42 concluídas.');
}

main().catch(e => {
    console.error('❌ Falha nas escritas de backlog:', e.message);
    process.exit(1);
});
