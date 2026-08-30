import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque,
    saveConversationState, getHistoricoRecente, getContextoProativoRecente,
    getDosesRetroativas, confirmarDoseRetroativa, usuarioRespondeuDesde } from './database.js';
import { registrarEvento, registrarFeedback } from './observabilidade.js';
import { CAPACIDADES, NAO_SUPORTADO } from './inventario.js';
import { buildAlertaEstoquePosConfirmacao } from './templates/estoqueTemplates.js';
import { handleRecepcionista } from './agentes/recepcionista.js';
import { handlePrincipal } from './agentes/principal.js';
import { handleCadastro, repetirPerguntaCadastro } from './agentes/cadastro.js';
import { handleRelatorios, classificarIntencaoRelatorio, extrairPeriodo } from './agentes/relatorios.js';
import { handleConfiguracao } from './agentes/configuracao.js';
import { handleExclusaoConta, confirmarIntencaoExclusaoConta } from './agentes/exclusaoConta.js';
import { handleDataNascimento } from './agentes/data_nascimento.js';
import { isCancelamento, pareceExclusaoConta } from './nlp_helpers.js';

// ============================================================
// IDEMPOTÊNCIA — descarta eventos duplicados da Z-API
// ============================================================

const processedMessages = new Map();
const MESSAGE_TTL_MS = 30_000;

function isDuplicateMessage(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    for (const [id, ts] of processedMessages.entries()) {
        if (now - ts > MESSAGE_TTL_MS) processedMessages.delete(id);
    }
    if (processedMessages.has(messageId)) return true;
    processedMessages.set(messageId, now);
    return false;
}

// ============================================================
// DOSE PENDENTE DE CONFIRMAÇÃO
// ============================================================

// Dose 'nao_informado' já esgotou o ciclo de tentativas — não é mais "pendente" no
// sentido de confirmação em andamento, é candidata a resposta tardia (BUG-035),
// tratada por tentarConfirmarRespostaTardia(). Excluí-la aqui garante que o roteador
// não intercepte a mensagem no bloco 4 (confirmação direta) e deixe o bloco 4b
// (fast-path de resposta tardia) ser alcançado. Alinha esta função à mesma definição
// de "dose pendente" já usada em buildUserMessage() (principal.js), que já excluía
// nao_informado corretamente — a divergência entre as duas era a causa raiz do BUG-035
// nunca disparar (confirmado com dados reais de produção, sessão de 08/07/2026).
async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return doses.some(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado' &&
        d.status !== 'nao_informado'
    );
}

// ============================================================
// FAST-PATH: RESPOSTA TARDIA AO ESGOTAMENTO (BUG-035)
// Distinto do fast-path por referenceMessageId (BUG-029, ainda quebrado) —
// este não usa referenceMessageId em nenhum momento.
// ============================================================

// Tenta confirmar diretamente (sem LLM) uma dose nao_informado quando o "Sim" do
// usuário é, comprovadamente, a 1ª resposta dele desde o esgotamento e ocorre
// dentro da janela de 24h. Fora dessas condições, retorna null e o roteamento
// segue o caminho normal (bloco retroativo com apresentação, já existente).
async function tentarConfirmarRespostaTardia(user, message) {
    const dosesRetroativas = await getDosesRetroativas(user.id, 2); // já ordena scheduled_at desc
    if (dosesRetroativas.length === 0) return null;

    const maisRecente = dosesRetroativas[0];

    const dentroDe24h = (Date.now() - new Date(maisRecente.scheduled_at).getTime()) <= 24 * 60 * 60 * 1000;
    if (!dentroDe24h) return null;

    const referencia = maisRecente.ultima_tentativa_at || maisRecente.scheduled_at;
    const jaRespondeu = await usuarioRespondeuDesde(user.id, referencia);
    if (jaRespondeu) return null;

    // Monta o grupo (MH-032): doses nao_informado com o mesmo horario_agendado e mesmo
    // dia da mais recente. Sem horario_agendado (registro legado) → confirma só a própria dose.
    const grupo = maisRecente.horario_agendado
        ? dosesRetroativas.filter(d => d.horario_agendado === maisRecente.horario_agendado
            && new Date(d.scheduled_at).toDateString() === new Date(maisRecente.scheduled_at).toDateString())
        : [maisRecente];

    for (const dose of grupo) {
        await confirmarDoseRetroativa(dose.id, 'resposta tardia ao esgotamento (BUG-035)');
    }

    // Alerta de estoque — mesma lógica do fast-path por referenceMessageId, aplicada por
    // medicamento do grupo (podem ser medicamentos diferentes agrupados pelo mesmo horário).
    let alertaSufixo = '';
    const medicationIds = [...new Set(grupo.map(d => d.medication_id))];
    for (const medId of medicationIds) {
        try {
            const estoqueInfo = await getEstoqueInfoParaAlerta(medId);
            if (estoqueInfo) {
                const confirmacoesDoDia = await contarConfirmacoesHoje(medId);
                const deveAlertar = calcularAlertaEstoque({
                    diasRestantes: estoqueInfo.diasRestantes,
                    tipo_tratamento: estoqueInfo.tipo_tratamento,
                    tratamento_dias: estoqueInfo.tratamento_dias,
                    confirmacoesDoDia
                });
                if (deveAlertar) alertaSufixo += buildAlertaEstoquePosConfirmacao(estoqueInfo);
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar alerta estoque (fast-path resposta tardia):', e.message);
        }
    }

    const nomes = grupo.map(d => d.medications?.nome || 'seu remédio').join(' e ');
    const firstName = user.name ? user.name.split(' ')[0] : 'você';

    console.log(`✅ [FAST-PATH] Resposta tardia ao esgotamento confirmada (BUG-035) — ${user.phone} — ${nomes}`);

    return `✅ Anotei! Dose do *${nomes}* confirmada, ${firstName}. Continue assim! 💪💊${alertaSufixo}`;
}

// ============================================================
// DETECÇÃO DE CONFIRMAÇÃO DE DOSE
// ============================================================

// Verifica se uma palavra aparece de forma independente no texto
// (não como parte de outra palavra — ex: "voltar" não deve bater em "voltaren")
function contemPalavraLivre(texto, palavra) {
    if (palavra.includes(' ')) return texto.includes(palavra); // frases: match direto
    return new RegExp(`(^|\\s)${palavra}(\\s|$|[.,!?])`).test(texto);
}

// Aberturas interrogativas — uma pergunta nunca é confirmação de dose, mesmo sem "?".
// Ex: "como tá meu estoque" (sem interrogação) não pode virar confirmação.
const ABERTURAS_INTERROGATIVAS = [
    'como', 'qual', 'quais', 'quanto', 'quantos', 'quantas',
    'quando', 'quem', 'onde', 'cade', 'cadê', 'sera', 'será',
    'o que', 'oq', 'porque', 'por que'
];

function detectarConfirmacaoDose(message) {
    if (!message) return false;
    const msg = message.toLowerCase().trim();

    // GUARDA DE INTERROGATIVA (v25) — pergunta não é confirmação.
    // Duas formas: pontuação final e abertura interrogativa (usuário nem sempre usa "?").
    if (msg.endsWith('?')) return false;
    if (ABERTURAS_INTERROGATIVAS.some(a => msg.startsWith(a + ' '))) return false;

    // PRIMEIRO: negação explícita invalida qualquer confirmação
    // Prioridade à negação — falso negativo é recuperável via follow-up;
    // falso positivo corrompe dados de adesão
    const negacoes = [
        'não tomei', 'nao tomei',
        'não vou tomar', 'nao vou tomar',
        'não vou mais', 'nao vou mais',
        'ainda não tomei', 'ainda nao tomei',
        'não tomou', 'nao tomou',
        'não consigo tomar', 'nao consigo tomar',
        'não consigo'
    ];
    if (negacoes.some(n => msg.includes(n))) return false;

    // Termos enxutos (v25): 'tá', 'foi', 'pode', 'ok', 'claro' e 'feito' foram REMOVIDOS.
    // Medição em todo o histórico de agent_logs: zero confirmações reais dependiam deles;
    // só geravam falso positivo ('tá' casava dentro de "está"). Se o usuário responder com
    // uma dessas palavras, a mensagem cai no classificador central e chega ao principal,
    // cujo NAMI_SYSTEM_PROMPT já trata todas elas como CONFIRM_DOSE (regra de máxima
    // prioridade) — a dose continua sendo confirmada, com uma chamada de LLM a mais.
    const termos = ['sim', 'tomei', 'já tomei', 'ja tomei', 'tomei sim', 'já tomei sim'];

    // contemPalavraLivre (word boundary) em vez de includes — impede que um termo case
    // dentro de outra palavra. Mesma função já usada por detectarIntencaoConfiguracao.
    return termos.some(t => contemPalavraLivre(msg, t));
}

// ============================================================
// DETECÇÃO DE AFIRMAÇÃO SIMPLES (pós-onboarding)
// Separada de detectarConfirmacaoDose para não misturar contextos
// ============================================================

function isAffirmativeSimple(message) {
    if (!message) return false;
    const termos = ['sim', 'ok', 'pode', 'claro', 'quero', 'vamos', 'bora', 'vou', 's'];
    const msg = message.toLowerCase().trim();
    return termos.some(t => msg === t || msg.startsWith(t + ' '));
}

// ============================================================
// DETECÇÃO DE INTENÇÃO DE CONFIGURAÇÃO
// ============================================================

function detectarIntencaoConfiguracao(message) {
    if (!message) return false;
    const msg = message.toLowerCase();

    // Casos diretos — detectados sem precisar de combinação
    const casosDiretos = [
        'pausar', 'reativar', 'encerrar tratamento',
        'alterar horário', 'alterar horario',
        'mudar horário', 'mudar horario',
        'trocar horário', 'trocar horario',
        'não vou mais tomar', 'nao vou mais tomar'
    ];
    if (casosDiretos.some(t => msg.includes(t))) return true;

    // Combinatório: palavra de ação + palavra de objeto
    const palavrasAcao = [
        'parar', 'cancela', 'cancelar', 'desativar', 'suspender',
        'tirar', 'remover', 'apagar', 'excluir', 'deletar',
        'encerrar', 'finalizar', 'acabar',
        'mudar', 'alterar', 'trocar', 'modificar',
        'ativar', 'retomar', 'voltar',
        'não preciso', 'nao preciso',
        'não precisa', 'nao precisa',
        'não quero mais', 'nao quero mais',
        'não me lembra', 'nao me lembra',
        'não me lembre', 'nao me lembre'
    ];
    const palavrasObjeto = [
        'lembrete', 'aviso', 'alarme', 'alerta', 'notificação', 'notificacao',
        'remédio', 'remedio', 'medicamento', 'tratamento',
        'horário', 'horario', 'hora'
    ];

    const temAcao = palavrasAcao.some(p => contemPalavraLivre(msg, p));
    const temObjeto = palavrasObjeto.some(p => contemPalavraLivre(msg, p));
    return temAcao && temObjeto;
}

// ============================================================
// DETECÇÃO DE INTENÇÃO DE CADASTRO
// ============================================================

function detectarIntencaoCadastro(message) {
    if (!message) return false;
    const termos = [
        'cadastrar', 'adicionar remédio', 'novo remédio', 'registrar remédio',
        'quero cadastrar', 'tenho um remédio', 'adicionar medicamento',
        'novo medicamento', 'registrar medicamento', 'quero adicionar',
        // Variações com "mais um" e "outro"
        'adicionar mais', 'mais um remédio', 'mais um medicamento',
        'outro remédio', 'outro medicamento', 'incluir remédio',
        'incluir medicamento', 'colocar remédio', 'colocar medicamento',
        'inserir remédio', 'inserir medicamento'
    ];
    const msg = message.toLowerCase();
    return termos.some(t => msg.includes(t));
}

// ============================================================
// CLASSIFICADOR LLM — contexto conversacional para o else final
// ============================================================

// Extrai JSON de resposta de LLM tolerando cercas markdown e texto ao redor.
// Mesma proteção que juizOffline.js já usa — replicada aqui após o C-3 (v25):
// o classificador falhava em 29% das chamadas porque o modelo devolvia ```json ... ```
// e o fallback silencioso mandava tudo para o principal.
function extrairJSON(texto) {
    if (!texto) return null;
    let limpo = String(texto).trim();

    // Remove cercas markdown (```json ... ``` ou ``` ... ```)
    limpo = limpo.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();

    // Se ainda houver texto ao redor, isola o primeiro objeto JSON
    if (!limpo.startsWith('{')) {
        const inicio = limpo.indexOf('{');
        const fim = limpo.lastIndexOf('}');
        if (inicio === -1 || fim === -1 || fim <= inicio) return null;
        limpo = limpo.slice(inicio, fim + 1);
    }

    try {
        return JSON.parse(limpo);
    } catch {
        return null;
    }
}

// MH-70/Parte C (v28) — rótulo de tempo determinístico, comum ao bloco reativo
// e ao proativo, pra que o classificador enxergue a distância real entre os
// turnos em vez de inferir pela posição no texto (nenhum dos dois blocos tinha
// rótulo de tempo nenhum antes desta sessão).
function formatarTempoRelativo(timestamp) {
    const minutos = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
    if (minutos < 1) return 'agora mesmo';
    if (minutos < 60) return `há ${minutos} min`;
    const horas = Math.round(minutos / 60);
    if (horas < 24) return `há ${horas}h`;
    const dias = Math.round(horas / 24);
    return `há ${dias} dia${dias > 1 ? 's' : ''}`;
}

const ROTULOS_EVENTO_PROATIVO = {
    lembrete: 'lembrete de dose',
    follow_up: 'follow-up de dose',
    alerta_estoque_zerado: 'aviso de estoque zerado',
    alerta_estoque_nao_informado: 'aviso de estoque (dose não confirmada)',
    resumo_semanal: 'resumo semanal de adesão'
};

// MH-065 (v27) / reescrito MH-70/Parte C (v28) — renderiza CADA evento proativo
// como sua própria linha da cronologia, em vez de só o mais recente. O rótulo
// entre colchetes é DESCRITIVO (evita que o LLM leia as linhas como turno de
// usuário), nunca diretivo. Não é seção destacada, não leva instrução de
// precedência — a cronologia e o rótulo de tempo carregam a informação sozinhas.
function renderizarEventosProativos(eventos) {
    if (!eventos || eventos.length === 0) return '';

    const linhas = eventos.map(ev => {
        const rotulo = ROTULOS_EVENTO_PROATIVO[ev.tipo] || 'mensagem automática';
        const tentativaTexto = ev.tipo === 'follow_up' && ev.tentativa ? ` (cobrança ${ev.tentativa})` : '';
        const medTexto = ev.medicamento
            ? ` — ${ev.medicamento}${ev.horarioAgendado ? ` (dose das ${ev.horarioAgendado})` : ''}`
            : '';
        return `Nami: ${rotulo}${tentativaTexto}${medTexto} — enviado ${formatarTempoRelativo(ev.enviadoAt)}`;
    }).join('\n');

    return `[mensagens automáticas da Nami — sem resposta do usuário até aqui]\n${linhas}`;
}

async function classificarIntencaoComContexto({ message, currentState, historicoConversa, contextoProativo = null }) {
    const fallback = { agente: 'principal', subtipoRelatorio: null, params: { medicamento: null, expressaoData: null }, feedback: null };

    try {
        // Monta o histórico como texto legível para o LLM. MH-70/Parte C: cada turno
        // ganha um rótulo de tempo determinístico — antes desta sessão, nenhum dos
        // dois blocos (reativo ou proativo) tinha noção de distância temporal alguma.
        const historicoReativo = historicoConversa.length > 0
            ? historicoConversa.map(h => {
                const contextoResumo = h.contexto_conversa?.medicationNome
                    ? ` [em andamento: configuração sobre ${h.contexto_conversa.medicationNome}, etapa ${h.contexto_conversa.etapa}]`
                    : '';
                const tempo = h.created_at ? ` (${formatarTempoRelativo(h.created_at)})` : '';
                return `Usuário: ${h.user_message}\nNami: ${h.agent_response}${contextoResumo}${tempo}`;
              }).join('\n\n')
            : 'Sem histórico recente.';

        // MH-065/MH-70/Parte C: até 6 eventos proativos entram na MESMA linha do tempo,
        // no fim (por construção da regra de sequência, são mais recentes que os 3
        // turnos reativos). NÃO é seção destacada e NÃO leva instrução de precedência —
        // a cronologia e o rótulo de tempo carregam a informação sozinhos. Campos
        // rotulados, sem genitivo solto: "lembrete de X" é ambíguo quando o nome do
        // medicamento soa como nome próprio (ex. "Elani").
        // Quando não há evento proativo, historicoTexto fica idêntico ao de antes.
        const eventosProativosTexto = renderizarEventosProativos(contextoProativo);
        const historicoTexto = eventosProativosTexto
            ? `${historicoReativo}\n\n${eventosProativosTexto}`
            : historicoReativo;

        // Seções do prompt montadas a partir do inventário único (src/inventario.js,
        // Princípio 55) em vez de string literal — evita a divergência de três listas
        // separadas que motivou o MH-009.
        const agentesTexto = CAPACIDADES.map(c => `- ${c.agente}: ${c.descricao}`).join('\n');
        const naoSuportadoTexto = NAO_SUPORTADO.map(item => `- ${item}`).join('\n');
        const subtipoRelatoriosTexto = CAPACIDADES
            .find(c => c.agente === 'relatorios').subtipos
            .map(s => `- ${s.chave}: ${s.descricao}`).join('\n');

        const prompt = `Você é o classificador de intenções da Nami, um assistente de saúde via WhatsApp.

Identifique para qual agente a mensagem deve ir, considerando o contexto da conversa.

AGENTES E SUAS CAPACIDADES:
${agentesTexto}

FUNCIONALIDADES QUE A NAMI AINDA NÃO TEM (classifique como "nao_suportado"):
${naoSuportadoTexto}

FEEDBACK SOBRE A NAMI (dimensão independente do agente — coexiste com qualquer roteamento):
Avalie se a mensagem contém feedback do usuário SOBRE A NAMI (o assistente/a experiência), NÃO
sobre o tratamento ou o remédio em si. Preencha "feedback" com um destes valores, ou null:
- elogio: satisfação, gratidão afetuosa ou carinho com a Nami/o serviço
  (ex: "adorei", "você me ajuda muito", "que assistente boa"). Um "ok"/"obrigado" isolado é
  reação, NÃO elogio — só marque quando houver satisfação clara com a Nami.
- critica: insatisfação, reclamação ou frustração com a Nami/a experiência
  (ex: "isso é confuso", "cansei de confirmar toda hora", "você não me entende").
- sugestao: proposta EXPLÍCITA de melhoria ou de algo novo para a Nami
  (ex: "seria bom lembrete por voz", "vocês deviam mandar menos mensagens").
- null: nenhum feedback explícito (a maioria das mensagens).
NÃO marque feedback para comentário sobre o remédio/sintoma, nem para o simples uso de uma
funcionalidade que não temos (isso já é "nao_suportado").

ESTADO ATUAL: ${currentState}

HISTÓRICO RECENTE:
${historicoTexto}

MENSAGEM ATUAL: "${message}"

Se o agente escolhido for "relatorios", identifique também o subtipo do relatório em
"subtipoRelatorio", escolhendo exatamente um destes valores:
${subtipoRelatoriosTexto}

Preencha também "params" com o que a mensagem disser (ou null quando não disser):
- "medicamento": o nome do medicamento citado, exatamente como o usuário escreveu.
- "expressaoData": a expressão de tempo usada, SEM converter para data. Valores possíveis:
  "hoje", "ontem", "anteontem", um dia da semana ("domingo", "segunda"...), ou um número/data
  como aparece na mensagem ("19", "19/07"). NUNCA calcule a data — apenas copie a expressão.

Para os demais agentes, "subtipoRelatorio" e "params" devem ser null.

Responda APENAS com um JSON válido — sem bloco de código markdown, sem \`\`\` e sem nenhum texto
antes ou depois. Comece a resposta diretamente com "{". Formato exato:
{"agente": "cadastro|relatorios|configuracao|principal|excluir_conta|nao_suportado", "subtipoRelatorio": "balanco_do_dia|meus_remedios|estoque|proximo_remedio|adesao|progresso_tratamento|null", "params": {"medicamento": "texto ou null", "expressaoData": "texto ou null"}, "feedback": "elogio|critica|sugestao|null"}`;

        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 250,
            messages: [{ role: 'user', content: prompt }]
        });

        const textoResposta = resposta.content[0]?.text?.trim() || '';
        const agentesValidos = ['cadastro', 'relatorios', 'configuracao', 'principal', 'excluir_conta', 'nao_suportado'];
        const subtiposValidos = ['balanco_do_dia', 'meus_remedios', 'estoque',
                                 'proximo_remedio', 'adesao', 'progresso_tratamento'];

        let parsed = extrairJSON(textoResposta);

        if (!parsed) {
            console.warn(`⚠️ [CLASSIFICADOR] Resposta não-JSON do LLM: "${textoResposta}" — usando principal`);
            // Falha de parse degradava o roteamento silenciosamente (C-3, v25).
            // Registrar em system_events dá visibilidade sem depender de leitura de log.
            await registrarEvento({
                tipo: 'erro_tecnico',
                severidade: 'media',
                origem: 'router',
                agent: 'classificador',
                titulo: 'Falha de parse na resposta do classificador central',
                payload: {
                    funcao: 'classificarIntencaoComContexto',
                    resposta_bruta: String(textoResposta).slice(0, 500),
                    mensagem_usuario: String(message).slice(0, 200)
                }
            });
            return fallback;
        }

        const agente = String(parsed?.agente || '').trim().toLowerCase();
        const subtipoRelatorio = String(parsed?.subtipoRelatorio || '').trim().toLowerCase();
        const feedbacksValidos = ['elogio', 'critica', 'sugestao'];
        const feedbackRaw = String(parsed?.feedback || '').trim().toLowerCase();
        const feedback = feedbacksValidos.includes(feedbackRaw) ? feedbackRaw : null;

        const paramsRaw = parsed?.params || {};
        const params = {
            medicamento: typeof paramsRaw.medicamento === 'string' && paramsRaw.medicamento.trim()
                ? paramsRaw.medicamento.trim() : null,
            expressaoData: typeof paramsRaw.expressaoData === 'string' && paramsRaw.expressaoData.trim()
                ? paramsRaw.expressaoData.trim() : null
        };

        if (!agentesValidos.includes(agente)) {
            console.warn(`⚠️ [CLASSIFICADOR] Agente inesperado do LLM: "${agente}" — usando principal`);
            return fallback;
        }

        if (agente === 'relatorios' && !subtiposValidos.includes(subtipoRelatorio)) {
            console.warn(`⚠️ [CLASSIFICADOR] Subtipo de relatório ausente/inválido: "${subtipoRelatorio}" — não reconhecido`);
            return { agente: 'relatorios', subtipoRelatorio: null, params, feedback };
        }

        console.log(`🧠 [CLASSIFICADOR] Intenção classificada como: ${agente}${subtipoRelatorio && agente === 'relatorios' ? ` (${subtipoRelatorio})` : ''} — params: ${JSON.stringify(params)} — mensagem: "${message}"`);
        return { agente, subtipoRelatorio: agente === 'relatorios' ? subtipoRelatorio : null, params, feedback };

    } catch (error) {
        // Erro na chamada LLM — fallback seguro, não interrompe o usuário
        console.error(`❌ [CLASSIFICADOR] Erro ao classificar intenção: ${error.message} — usando principal`);
        return fallback;
    }
}

// ============================================================
// DESPACHO DE RELATÓRIO (v25) — ponto ÚNICO de chamada de handleRelatorios.
// Encapsula os três passos que os 8 call sites anteriores repetiam:
// chamar o handler → devolver a resposta → cair no principal quando não reconhecido.
// NÃO gerencia estado conversacional de propósito: decidir se um fluxo terminou é
// responsabilidade do branch que chama, não do despacho (evita acoplamento).
// ============================================================
async function despacharRelatorio({ user, message, image, historicoConversa,
                                    subtipo, params, state }) {
    const response = await handleRelatorios({ user, message, subtipo, params, state });

    if (response) {
        return { agentName: 'relatorios', response };
    }

    console.log(`🤖 Relatorios não reconheceu (subtipo: ${subtipo}), caindo no principal — ${user.phone}`);
    return {
        agentName: 'principal',
        response: await handlePrincipal({ user, message, image, historicoConversa })
    };
}

// ============================================================
// DESPACHO DE CADASTRO (MH-073 Parte B.1) — ponto ÚNICO de chamada de handleCadastro.
// Encapsula a interceptação de { escalarParaRoteador: true }, que antes não existia para
// este agente. Instrumentar call site a call site é a causa raiz do BUG-069 (1 de 6
// pontos esquecido) — Princípio 30.
//
// REGRA DE REENTRADA (seção 3.3 do briefing): quando o classificador central devolve
// 'cadastro' de novo, ele está CONCORDANDO que o usuário não saiu do fluxo — o estado e o
// contexto são mantidos como estão e a pergunta pendente é repetida (via
// repetirPerguntaCadastro, sem reclassificar a mensagem — ver justificativa em
// cadastro.js). Nenhum dado coletado é descartado. Só destinos diferentes de cadastro
// passam pelo despacharEscalada.
// ============================================================
async function despacharCadastro({ user, message, image, state, context, historicoConversa,
                                   contextoProativo = null }) {
    const resultado = await handleCadastro({ user, message, state, context, historicoConversa });

    if (!resultado?.escalarParaRoteador) {
        return { agentName: 'cadastro', response: resultado };
    }

    // BUG-101: guarda o objeto INTEIRO — subtipoRelatorio/params/feedback são consumidos
    // por despacharEscalada e se perderiam se só o agente fosse propagado.
    const classificacao = await classificarIntencaoComContexto({
        message,
        currentState: state?.state || 'adding_med',
        historicoConversa,
        contextoProativo
    });
    const agenteSelecionado = classificacao.agente;

    if (agenteSelecionado === 'cadastro') {
        // Ainda é cadastro — repete a pergunta pendente sem reiniciar nada.
        console.log(`💊 [ESCALADA-CADASTRO] Classificador confirmou cadastro — mantendo fluxo — ${user.phone}`);
        const retomada = await repetirPerguntaCadastro({ context, userName: user.name, historicoConversa });
        return { agentName: 'cadastro', response: retomada };
    }

    const escalada = await despacharEscalada({
        user, message, image, historicoConversa, contextoProativo,
        contextoPreservado: null,
        classificacaoPreResolvida: classificacao
    });
    return {
        agentName: escalada.agentName,
        response: escalada.response,
        feedback: escalada.feedback,
        intencaoNaoSuportadaDetectada: escalada.intencaoNaoSuportadaDetectada
    };
}

// ============================================================
// DESPACHO DE ESCALADA — usado quando um agente devolve
// { escalarParaRoteador: true } em vez de uma resposta de texto
// ============================================================

async function despacharEscalada({ user, message, image, contextoPreservado, historicoConversa,
                                   contextoProativo = null, classificacaoPreResolvida = null }) {
    // MH-065: recebe o contextoProativo JÁ BUSCADO pelo roteador — nenhuma query nova
    // (princípio 6: buscar uma vez, propagar).
    //
    // BUG-101: quem já classificou a mensagem passa o resultado INTEIRO aqui e evita a
    // segunda chamada de LLM. Propagar o objeto completo, nunca só o agente — subtipoRelatorio,
    // params e feedback são consumidos abaixo (ver seção 3 do briefing). Quando o parâmetro
    // é null, o comportamento é byte a byte idêntico ao anterior (mitigação MH-065).
    const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } =
        classificacaoPreResolvida ?? await classificarIntencaoComContexto({
            message, currentState: 'configurando', historicoConversa, contextoProativo
        });

    let agentName = agenteSelecionado;
    let response;
    let intencaoNaoSuportadaDetectada = false;

    if (agenteSelecionado === 'configuracao') {
        console.log(`⚙️ [ESCALADA] Destino: configuração — reentra em identif_intencao${contextoPreservado?.medicationNome ? ` preservando ${contextoPreservado.medicationNome}` : ' sem medicamento preservado'} — ${user.phone}`);
        response = await handleConfiguracao({
            user, message, historicoConversa,
            state: { state: 'configurando', context: { etapa: 'identif_intencao' } },
            context: {
                etapa: 'identif_intencao',
                medicationId: contextoPreservado?.medicationId || null,
                medicationNome: contextoPreservado?.medicationNome || null,
                schedulesAtivos: contextoPreservado?.schedulesAtivos || []
            }
        });
    } else {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        const idleState = { state: 'idle', context: {} };

        if (agenteSelecionado === 'cadastro') {
            console.log(`💊 [ESCALADA] Roteando para cadastro — ${user.phone}`);
            // MH-073 Parte B.1: chama handleCadastro DIRETO, não despacharCadastro —
            // despacharEscalada já É o destino de uma escalada; despachar de dentro do
            // despacho criaria recursão (despacharCadastro chama despacharEscalada).
            response = await handleCadastro({
                user, message, state: idleState, historicoConversa,
                context: { etapa: 'cad_nome' }
            });
        } else if (agenteSelecionado === 'relatorios') {
            console.log(`📊 [ESCALADA] Roteando para relatorios (${subtipoRelatorio}) — ${user.phone}`);
            const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                 subtipo: subtipoRelatorio, params, state: idleState });
            agentName = r.agentName;
            response = r.response;
        } else if (agenteSelecionado === 'excluir_conta') {
            agentName = 'exclusao_conta';
            console.log(`🗑️ [ESCALADA] Pedido de exclusão de conta — ${user.phone}`);
            const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
            response = r.response;
        } else if (agenteSelecionado === 'nao_suportado') {
            agentName = 'principal';
            console.log(`🚧 [ESCALADA] Intenção não suportada — ${user.phone}`);
            intencaoNaoSuportadaDetectada = true;
            response = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true });
        } else {
            agentName = 'principal';
            console.log(`🤖 [ESCALADA] Roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });
        }
    }

    return { agentName, response, feedback, intencaoNaoSuportadaDetectada };
}

// ============================================================
// ROTEADOR PRINCIPAL
// ============================================================

export async function routeMessage({ user, message, image, messageId, referenceMessageId }) {
    if (isDuplicateMessage(messageId)) {
        console.log(`⚠️  Mensagem duplicada ignorada: ${messageId}`);
        return null;
    }

    // FAST-PATH: confirmação por referência de mensagem (função "responder" do WhatsApp)
    if (referenceMessageId && detectarConfirmacaoDose(message)) {
        const doseLog = await getDoseLogByZapiMessageId(referenceMessageId);
        if (doseLog && doseLog.confirmed === false) {
            await confirmDoseByLogId(doseLog.id);
            const nomeRemedio = doseLog.med_nome || 'seu remédio';
            const firstName = user.name ? user.name.split(' ')[0] : 'você';

            console.log(`✅ [FAST-PATH] Dose confirmada via referenceMessageId — ${user.phone} — ${nomeRemedio}`);

            await logAgentInteraction({
                userId: user.id,
                agent: 'fast_path_reference',
                userMessage: message,
                agentResponse: `Dose confirmada: ${nomeRemedio}`,
                estadoConversa: null,
                contextoConversa: null
            });

            // Verificar alerta de estoque pós-confirmação
            let alertaSufixo = '';
            try {
                const estoqueInfo = await getEstoqueInfoParaAlerta(doseLog.medication_id);
                if (estoqueInfo) {
                    const confirmacoesDoDia = await contarConfirmacoesHoje(doseLog.medication_id);
                    const deveAlertar = calcularAlertaEstoque({
                        diasRestantes: estoqueInfo.diasRestantes,
                        tipo_tratamento: estoqueInfo.tipo_tratamento,
                        tratamento_dias: estoqueInfo.tratamento_dias,
                        confirmacoesDoDia
                    });
                    if (deveAlertar) alertaSufixo = buildAlertaEstoquePosConfirmacao(estoqueInfo);
                }
            } catch (e) {
                console.error('⚠️ Erro ao verificar alerta estoque (fast-path):', e.message);
            }

            return `✅ Anotei! Dose do *${nomeRemedio}* confirmada, ${firstName}. Continue assim! 💪💊${alertaSufixo}`;
        }
    }

    const state = await getConversationState(user.id);
    const currentState = state?.state || 'idle';

    // Histórico conversacional — buscado UMA vez, propagado a todos os agentes LLM
    const historicoConversa = await getHistoricoRecente(user.id, 3);

    // Contexto proativo (MH-065) — buscado UMA vez aqui, propagado SÓ ao classificador
    // central e ao despacharEscalada. Os agentes não recebem: o principal já tem o bloco
    // DOSES AGUARDANDO CONFIRMAÇÃO, que é mais forte (traz o doseLogId).
    // historicoConversa vem em ordem cronológica (mais antigo primeiro) — o último item é
    // o turno mais recente. O turno ATUAL ainda não foi logado (logAgentInteraction roda no
    // fim de routeMessage, L1000), então não há off-by-one.
    const ultimoTurnoAt = historicoConversa.at(-1)?.created_at ?? null;
    const contextoProativo = await getContextoProativoRecente(user.id, ultimoTurnoAt);

    let response;
    let agentName;
    let feedbackDetectado = null;
    let intencaoNaoSuportadaDetectada = false;

    // 1. Usuário ainda não fez onboarding → recepcionista
    if (!user.onboarded) {
        agentName = 'recepcionista';
        console.log(`👋 Roteando para recepcionista — ${user.phone}`);
        response = await handleRecepcionista({
            user,
            message,
            historicoConversa,
            context: {
                ...state?.context,
                mensagem_inicial: state?.context?.mensagem_inicial || message
            }
        });

    // 2. MH-020 — Confirmação pendente de exclusão de conta (trata o estado antes de tudo)
    } else if (currentState === 'aguardando_confirmacao_exclusao') {
        agentName = 'exclusao_conta';
        console.log(`🗑️ Roteando para exclusão de conta (confirmação pendente) — ${user.phone}`);
        const r = await handleExclusaoConta({ user, message, etapa: 'confirmar', historicoConversa });

        if (r.contaExcluida) {
            // Usuário não existe mais — RETORNA ANTES do logAgentInteraction final
            // (inserir agent_logs com user_id apagado daria FK error).
            return r.response;
        }
        response = r.response;

    // 3. MH-020 — Portão de detecção de pedido de exclusão de conta (único ponto de detecção).
    // Roda para qualquer usuário onboarded, em qualquer estado -> precedência sobre todos os fluxos.
    // Estágio 1 (barato, determinístico) curto-circuita o estágio 2 (LLM) quando não é candidato.
    } else if (user.onboarded
        && pareceExclusaoConta(message)
        && await confirmarIntencaoExclusaoConta({ message, historicoConversa, currentState })) {
        agentName = 'exclusao_conta';
        console.log(`🗑️ Pedido de exclusão de conta detectado — ${user.phone}`);
        const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
        response = r.response;

    // 3.5. MH-072 Parte A — coleta de data de nascimento no onboarding. Entre o portão
    // de exclusão de conta (bloco 3, que tem precedência sobre tudo) e post_onboarding
    // (bloco 4): o usuário aqui já está onboarded (recepcionista.js grava onboarded=true
    // no momento do aceite da LGPD, antes desta coleta começar), então um pedido de
    // exclusão de conta durante a coleta é atendido normalmente pelo bloco 3, antes deste.
    } else if (currentState === 'coletando_nascimento') {
        agentName = 'data_nascimento';
        console.log(`🎂 Roteando para coleta de data de nascimento — ${user.phone}`);
        const resultadoNascimento = await handleDataNascimento({ user, message, state, historicoConversa });
        if (resultadoNascimento?.escalarParaRoteador) {
            const escalada = await despacharEscalada({
                user, message, image, historicoConversa, contextoProativo,
                contextoPreservado: null
            });
            agentName = escalada.agentName;
            response = escalada.response;
            feedbackDetectado = escalada.feedback ?? feedbackDetectado;
            if (escalada.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        } else {
            response = resultadoNascimento;
        }

    // 4. Usuário concluiu onboarding agora — respondendo "por onde quer começar?"
    } else if (currentState === 'post_onboarding') {
        if (detectarIntencaoCadastro(message) || isAffirmativeSimple(message)) {
            console.log(`💊 Roteando para cadastro (pós-onboarding) — ${user.phone}`);
            const rCad = await despacharCadastro({ user, message, image, state, historicoConversa,
                                                   contextoProativo, context: { etapa: 'cad_nome' } });
            agentName = rCad.agentName;
            response = rCad.response;
            feedbackDetectado = rCad.feedback ?? feedbackDetectado;
            if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        } else {
            agentName = 'principal';
            console.log(`🤖 Roteando para principal (pós-onboarding) — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });

            // Preserva post_onboarding por mais 1 troca para capturar o "sim" seguinte.
            // Após 1 troca (exchanges >= 1), deixa o principal gerenciar o estado normalmente.
            const exchanges = state?.context?.exchanges || 0;
            if (exchanges < 1) {
                await saveConversationState(user.id, {
                    state: 'post_onboarding',
                    context: { exchanges: exchanges + 1 }
                });
                console.log(`🔄 post_onboarding preservado (exchanges: ${exchanges + 1}) — ${user.phone}`);
            }
        }

    // 5. Usuário no meio do fluxo de seleção de período do relatório de adesão
    // BUG-057: esse estado travava TODA mensagem seguinte (inclusive confirmação de
    // dose real) como se fosse resposta de período. Ordem de checagem abaixo dá
    // precedência a dose > cancelamento > período válido > classificador central.
    } else if (currentState === 'aguardando_periodo_adesao') {

        if (detectarConfirmacaoDose(message) && await temDosePendente(user.id)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'principal';
            console.log(`💊 Confirmação de dose detectada (aguardando_periodo_adesao), roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });

        } else if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'relatorios';
            const firstName = user.name ? user.name.split(' ')[0] : 'você';
            console.log(`📊 Desistência do período de adesão — ${user.phone}`);
            response = `Sem problemas, ${firstName}! Se quiser ver sua adesão depois, é só me chamar 🌿`;

        } else if (extrairPeriodo(message)) {
            agentName = 'relatorios';
            console.log(`📊 Roteando para relatorios (aguardando período de adesão) — ${user.phone}`);
            const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                 subtipo: 'adesao', params: { medicamento: null, expressaoData: null }, state });
            agentName = r.agentName;
            response = r.response;

        } else {
            const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
                message, currentState, historicoConversa, contextoProativo
            });
            feedbackDetectado = feedback ?? feedbackDetectado;

            if (agenteSelecionado === 'relatorios' && subtipoRelatorio === 'adesao') {
                agentName = 'relatorios';
                console.log(`📊 [CLASSIFICADOR] Ainda sobre adesão, sem período reconhecível — ${user.phone}`);
                const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                     subtipo: 'adesao', params, state });
                agentName = r.agentName;
                response = r.response;
            } else {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                agentName = agenteSelecionado;
                const idleState = { state: 'idle', context: {} };

                if (agenteSelecionado === 'cadastro') {
                    console.log(`💊 [CLASSIFICADOR] Roteando para cadastro (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    const rCad = await despacharCadastro({ user, message, image, state: idleState, historicoConversa,
                                                           contextoProativo, context: { etapa: 'cad_nome' } });
                    agentName = rCad.agentName;
                    response = rCad.response;
                    feedbackDetectado = rCad.feedback ?? feedbackDetectado;
                    if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
                } else if (agenteSelecionado === 'relatorios') {
                    console.log(`📊 [CLASSIFICADOR] Roteando para relatorios (${subtipoRelatorio}, saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                         subtipo: subtipoRelatorio, params, state: idleState });
                    agentName = r.agentName;
                    response = r.response;
                } else if (agenteSelecionado === 'configuracao') {
                    console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    const resultadoConfig = await handleConfiguracao({
                        user, message, state: idleState, historicoConversa,
                        context: { etapa: 'identif_intencao' }
                    });
                    if (resultadoConfig?.escalarParaRoteador) {
                        const escalada = await despacharEscalada({
                            user, message, image, historicoConversa, contextoProativo,
                            contextoPreservado: null
                        });
                        agentName = escalada.agentName;
                        response = escalada.response;
                        feedbackDetectado = escalada.feedback ?? feedbackDetectado;
                        if (escalada.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
                    } else {
                        response = resultadoConfig;
                    }
                } else if (agenteSelecionado === 'excluir_conta') {
                    agentName = 'exclusao_conta';
                    console.log(`🗑️ [CLASSIFICADOR] Pedido de exclusão de conta (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
                    response = r.response;
                } else if (agenteSelecionado === 'nao_suportado') {
                    agentName = 'principal';
                    console.log(`🚧 [CLASSIFICADOR] Intenção não suportada (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    intencaoNaoSuportadaDetectada = true;
                    response = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true });
                } else {
                    agentName = 'principal';
                    console.log(`🤖 [CLASSIFICADOR] Roteando para principal (saiu de aguardando_periodo_adesao) — ${user.phone}`);
                    response = await handlePrincipal({ user, message, image, historicoConversa });
                }
            }
        }

    // 6. Usuário no meio da escolha de qual tratamento ver o progresso (2+ ativos, BUG-056)
    // Mesma precedência do BUG-057: dose > cancelamento > classificador central.
    // BUG-056 (complemento): decidir por nome de medicamento antes de confirmar o assunto
    // gerava falso-positivo (ex: "qual estoque do Neosaldina?" virava progresso). O
    // classificador central é sempre consultado primeiro — nome só é usado depois de
    // confirmar que o assunto ainda é progresso_tratamento.
    } else if (currentState === 'aguardando_escolha_tratamento') {

        if (detectarConfirmacaoDose(message) && await temDosePendente(user.id)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'principal';
            console.log(`💊 Confirmação de dose detectada (aguardando_escolha_tratamento), roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });

        } else if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            agentName = 'relatorios';
            const firstName = user.name ? user.name.split(' ')[0] : 'você';
            console.log(`📊 Desistência da escolha de tratamento — ${user.phone}`);
            response = `Sem problemas, ${firstName}! Se quiser ver de novo, é só me chamar 🌿`;

        } else {
            const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
                message, currentState, historicoConversa, contextoProativo
            });
            feedbackDetectado = feedback ?? feedbackDetectado;

            if (agenteSelecionado === 'relatorios' && subtipoRelatorio === 'progresso_tratamento') {
                agentName = 'relatorios';
                console.log(`📊 [CLASSIFICADOR] Ainda sobre progresso, sem nome reconhecível — ${user.phone}`);
                const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                     subtipo: 'progresso_tratamento', params, state });
                agentName = r.agentName;
                response = r.response;
            } else {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                agentName = agenteSelecionado;
                const idleState = { state: 'idle', context: {} };

                if (agenteSelecionado === 'cadastro') {
                    console.log(`💊 [CLASSIFICADOR] Roteando para cadastro (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    const rCad = await despacharCadastro({ user, message, image, state: idleState, historicoConversa,
                                                           contextoProativo, context: { etapa: 'cad_nome' } });
                    agentName = rCad.agentName;
                    response = rCad.response;
                    feedbackDetectado = rCad.feedback ?? feedbackDetectado;
                    if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
                } else if (agenteSelecionado === 'relatorios') {
                    console.log(`📊 [CLASSIFICADOR] Roteando para relatorios (${subtipoRelatorio}, saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                         subtipo: subtipoRelatorio, params, state: idleState });
                    agentName = r.agentName;
                    response = r.response;
                } else if (agenteSelecionado === 'configuracao') {
                    console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    const resultadoConfig = await handleConfiguracao({
                        user, message, state: idleState, historicoConversa,
                        context: { etapa: 'identif_intencao' }
                    });
                    if (resultadoConfig?.escalarParaRoteador) {
                        const escalada = await despacharEscalada({
                            user, message, image, historicoConversa, contextoProativo,
                            contextoPreservado: null
                        });
                        agentName = escalada.agentName;
                        response = escalada.response;
                        feedbackDetectado = escalada.feedback ?? feedbackDetectado;
                        if (escalada.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
                    } else {
                        response = resultadoConfig;
                    }
                } else if (agenteSelecionado === 'excluir_conta') {
                    agentName = 'exclusao_conta';
                    console.log(`🗑️ [CLASSIFICADOR] Pedido de exclusão de conta (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
                    response = r.response;
                } else if (agenteSelecionado === 'nao_suportado') {
                    agentName = 'principal';
                    console.log(`🚧 [CLASSIFICADOR] Intenção não suportada (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    intencaoNaoSuportadaDetectada = true;
                    response = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true });
                } else {
                    agentName = 'principal';
                    console.log(`🤖 [CLASSIFICADOR] Roteando para principal (saiu de aguardando_escolha_tratamento) — ${user.phone}`);
                    response = await handlePrincipal({ user, message, image, historicoConversa });
                }
            }
        }

    // 7. Usuário no meio de um fluxo de configuração
    } else if (currentState === 'configurando') {
        agentName = 'configuracao';
        console.log(`⚙️ Roteando para configuração (estado configurando) — ${user.phone}`);
        const resultadoConfig = await handleConfiguracao({
            user, message, state, historicoConversa,
            context: state?.context || {}
        });
        if (resultadoConfig?.escalarParaRoteador) {
            const escalada = await despacharEscalada({
                user, message, image, historicoConversa, contextoProativo,
                contextoPreservado: state?.context
            });
            agentName = escalada.agentName;
            response = escalada.response;
            feedbackDetectado = escalada.feedback ?? feedbackDetectado;
            if (escalada.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        } else {
            response = resultadoConfig;
        }

    // 8. Usuário em idle com intenção de configuração detectada
    } else if (currentState === 'idle' && detectarIntencaoConfiguracao(message)) {
        agentName = 'configuracao';
        console.log(`⚙️ Roteando para configuração (intenção detectada) — ${user.phone}`);
        const resultadoConfig = await handleConfiguracao({
            user, message, state, historicoConversa,
            context: { etapa: 'identif_intencao' }
        });
        if (resultadoConfig?.escalarParaRoteador) {
            const escalada = await despacharEscalada({
                user, message, image, historicoConversa, contextoProativo,
                contextoPreservado: null
            });
            agentName = escalada.agentName;
            response = escalada.response;
            feedbackDetectado = escalada.feedback ?? feedbackDetectado;
            if (escalada.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        } else {
            response = resultadoConfig;
        }

    // 9. Usuário já está em fluxo de cadastro → agente_cadastro
    } else if (currentState === 'adding_med') {
        console.log(`💊 Roteando para cadastro (estado adding_med) — ${user.phone}`);
        const rCad = await despacharCadastro({ user, message, image, state, historicoConversa,
                                               contextoProativo, context: state?.context || {} });
        agentName = rCad.agentName;
        response = rCad.response;
        feedbackDetectado = rCad.feedback ?? feedbackDetectado;
        if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;

    // 10. Handler para estado fantasma criado pelo agente_principal
    // Redireciona para o fluxo estruturado do agente_cadastro
    } else if (currentState === 'cadastrando_medicamento') {
        console.log(`💊 Roteando para cadastro (estado cadastrando_medicamento corrigido) — ${user.phone}`);
        const rCad = await despacharCadastro({ user, message, image, state, historicoConversa,
                                               contextoProativo, context: { etapa: 'cad_nome' } }); // reinicia do zero de forma estruturada
        agentName = rCad.agentName;
        response = rCad.response;
        feedbackDetectado = rCad.feedback ?? feedbackDetectado;
        if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;

    // 11. Usuário idle com intenção explícita de cadastro → agente_cadastro
    } else if (currentState === 'idle' && detectarIntencaoCadastro(message)) {
        console.log(`💊 Roteando para cadastro (intenção detectada) — ${user.phone}`);
        const rCad = await despacharCadastro({ user, message, image, state, historicoConversa,
                                               contextoProativo, context: { etapa: 'cad_nome' } });
        agentName = rCad.agentName;
        response = rCad.response;
        feedbackDetectado = rCad.feedback ?? feedbackDetectado;
        if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;

    // 12. PRIORIDADE: confirmação de dose — só intercepta se mensagem É confirmação E há dose real pendente
    } else if (currentState === 'idle'
        && detectarConfirmacaoDose(message)
        && await temDosePendente(user.id)) {
        agentName = 'principal';
        console.log(`💊 Confirmação de dose detectada, roteando para principal — ${user.phone}`);
        response = await handlePrincipal({ user, message, image, historicoConversa });

    // 13. Resposta tardia ao esgotamento (BUG-035) — fast-path determinístico,
    // distinto do fast-path por referenceMessageId (BUG-029, ainda quebrado)
    } else if (currentState === 'idle'
        && detectarConfirmacaoDose(message)
        && !(await temDosePendente(user.id))) {

        const resultado = await tentarConfirmarRespostaTardia(user, message);
        if (resultado) {
            agentName = 'fast_path_resposta_tardia';
            response = resultado;
        } else {
            // Nenhuma condição bateu — segue fluxo normal (cai no principal/retroativo/classificador)
            agentName = 'principal';
            response = await handlePrincipal({ user, message, image, historicoConversa });
        }

    // 14. Usuário idle com intenção de relatório → agente_relatorios
    } else if (currentState === 'idle' && classificarIntencaoRelatorio(message)) {
        const subtipo = classificarIntencaoRelatorio(message);
        agentName = 'relatorios';
        console.log(`📊 Roteando para relatorios (${subtipo}) — ${user.phone}`);
        const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                             subtipo, params: { medicamento: null, expressaoData: null }, state });
        agentName = r.agentName;
        response = r.response;

    // 15. Demais casos → classificador LLM com contexto conversacional
    } else {
        const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
            message,
            currentState,
            historicoConversa,
            contextoProativo
        });
        feedbackDetectado = feedback ?? feedbackDetectado;

        agentName = agenteSelecionado;

        if (agenteSelecionado === 'cadastro') {
            console.log(`💊 [CLASSIFICADOR] Roteando para cadastro — ${user.phone}`);
            const rCad = await despacharCadastro({ user, message, image, state, historicoConversa,
                                                   contextoProativo, context: { etapa: 'cad_nome' } });
            agentName = rCad.agentName;
            response = rCad.response;
            feedbackDetectado = rCad.feedback ?? feedbackDetectado;
            if (rCad.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
        } else if (agenteSelecionado === 'relatorios') {
            console.log(`📊 [CLASSIFICADOR] Roteando para relatorios (${subtipoRelatorio}) — ${user.phone}`);
            const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                                 subtipo: subtipoRelatorio, params, state });
            agentName = r.agentName;
            response = r.response;
        } else if (agenteSelecionado === 'configuracao') {
            console.log(`⚙️ [CLASSIFICADOR] Roteando para configuracao — ${user.phone}`);
            const resultadoConfig = await handleConfiguracao({
                user, message, state, historicoConversa,
                context: { etapa: 'identif_intencao' }
            });
            if (resultadoConfig?.escalarParaRoteador) {
                const escalada = await despacharEscalada({
                    user, message, image, historicoConversa, contextoProativo,
                    contextoPreservado: null
                });
                agentName = escalada.agentName;
                response = escalada.response;
                feedbackDetectado = escalada.feedback ?? feedbackDetectado;
                if (escalada.intencaoNaoSuportadaDetectada) intencaoNaoSuportadaDetectada = true;
            } else {
                response = resultadoConfig;
            }
        } else if (agenteSelecionado === 'excluir_conta') {
            agentName = 'exclusao_conta';
            console.log(`🗑️ [CLASSIFICADOR] Pedido de exclusão de conta — ${user.phone}`);
            const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
            response = r.response;
        } else if (agenteSelecionado === 'nao_suportado') {
            agentName = 'principal';
            console.log(`🚧 [CLASSIFICADOR] Intenção não suportada — ${user.phone}`);
            intencaoNaoSuportadaDetectada = true;
            response = await handlePrincipal({ user, message, image, historicoConversa, intencaoNaoSuportada: true });
        } else {
            // 'principal' — resposta geral ou intenção não identificada
            agentName = 'principal';
            console.log(`🤖 [CLASSIFICADOR] Roteando para principal — ${user.phone}`);
            response = await handlePrincipal({ user, message, image, historicoConversa });
        }
    }

    const agentLogId = await logAgentInteraction({
        userId: user.id,
        agent: agentName,
        userMessage: message,
        agentResponse: response,
        estadoConversa: currentState || null,
        contextoConversa: state?.context || null
    });

    if (intencaoNaoSuportadaDetectada) {
        await registrarEvento({
            tipo: 'intencao_nao_suportada',
            severidade: 'baixa',
            userId: user.id,
            agent: agentName,
            origem: 'classificador_central',
            agentLogId,
            titulo: 'Intenção não suportada (classificador central)'
        });
    }

    if (feedbackDetectado) {
        await registrarFeedback({
            userId: user.id,
            categoria: feedbackDetectado,
            origem: 'espontaneo',
            texto: message,
            agentLogId
        });
    }

    return response;
}
