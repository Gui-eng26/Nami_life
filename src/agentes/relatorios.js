import 'dotenv/config';
import {
    getDosesDoDia,
    getMedicamentosAtivos,
    getEstoque,
    getProximosMedicamentos,
    calcularAdesao,
    calcularProgressoTratamento,
    getAdesaoEstado,
    upsertAdesaoEstado,
    saveConversationState,
    precisaSaudacao
} from '../database.js';
import { registrarEvento } from '../observabilidade.js';
import { sendTextMessage } from '../whatsapp.js';
import { isCancelamento, encontrarMedicamento } from '../nlp_helpers.js';
import {
    escolherFaixa,
    montarMensagemSemanal,
    montarMensagemMensal,
    montarBlocoMotivo,
    montarBlocoTurno,
    montarBlocoTendencia,
    montarBlocoMarco,
    montarBlocoEstoque,
    escolherFaseProgresso,
    montarMensagemProgresso,
    montarFallbackContinuo,
    montarResumoCompacto,
    montarPerguntaPeriodo,
    montarRecusaPeriodo
} from '../templates/adesaoTemplates.js';
import { resolverDataReferencia, validarJanela, rotularData, diasAtras, hojeBRT, extrairExpressaoData } from '../dataReferencia.js';
import {
    montarBlocoFactual, resumirSituacao, molduraPadrao, montarCabecalhoData,
    TEXTO_FORA_DA_JANELA, TEXTO_DATA_FUTURA, TEXTO_DATA_NAO_RECONHECIDA
} from '../templates/balancoTemplates.js';
import Anthropic from '@anthropic-ai/sdk';

// Considera fechamento mensal quando o último fechamento tem 28+ dias (ou nunca fechou).
const DIAS_FECHAMENTO_MENSAL = 28;
const PERIODOS_VALIDOS = [7, 15, 30];
// '100' > '80_99' > '50_79' > 'abaixo_50' — usado para marco (melhor faixa já atingida)
const RANKING_FAIXA = { abaixo_50: 0, '50_79': 1, '80_99': 2, '100': 3 };
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JANELA_CONFIRMACAO_RETROATIVA_DIAS = 2;

// Saudação condicional dos templates "sob demanda" (BRIEFING_APRESENTACAO_V2.md, seção 1) —
// evita repetir "Olá, [Nome]!" quando o usuário manda várias perguntas seguidas em pouco tempo.
async function comSaudacao(userId, nome, corpo) {
    const saudacao = await precisaSaudacao(userId) ? `Olá, ${nome}! ` : '';
    return saudacao + corpo;
}

// ============================================================
// CLASSIFICADOR DE INTENÇÃO DE RELATÓRIO
// Exportado para uso no router.js (Camada 1 — fast-path por palavra-chave)
// ============================================================

export function classificarIntencaoRelatorio(message) {
    if (!message) return null;
    const msg = message.toLowerCase().trim();

    const padroes = {
        balanco_do_dia: [
            'tomei hoje?',
            'já tomei meus remédios',
            'tomei alguma coisa hoje',
            'registrei hoje',
            'esqueci de tomar hoje',
            'tomei tudo hoje',
            'tomei o remédio hoje',
            'ficou alguma dose pendente',
            'faltou algum remédio',
            'pulei algum remédio'
        ],
        meus_remedios: [
            'quais meus remédios',
            'que remédios tenho',
            'o que tenho cadastrado',
            'quais remédios eu tomo',
            'me mostra meus remédios',
            'lista meus remédios',
            'remédios cadastrados',
            'quais são meus remédios',
            'ver meus remédios'
        ],
        estoque: [
            'quanto tenho de cada',
            'tô ficando sem remédio',
            'quando preciso comprar',
            'quanto sobrou',
            'como está meu estoque',
            'preciso comprar remédio',
            'quanto tenho ainda de',
            'tô sem remédio'
        ],
        proximo_remedio: [
            'o que tenho que tomar',
            'que horas é o próximo',
            'tenho remédio pra tomar agora',
            'esqueci de tomar alguma coisa',
            'qual o próximo remédio',
            'o que devo tomar agora',
            'que remédio tomo agora'
        ],
        adesao: [
            'quantas vezes esqueci',
            'tenho esquecido muito',
            'como está minha adesão',
            'tô tomando direitinho',
            'quantas doses perdi',
            'faltei alguma dose',
            'como tá meu histórico',
            'tô me cuidando bem'
        ],
        progresso_tratamento: [
            'como estou no meu tratamento',
            'como está meu tratamento',
            'quanto falta pro tratamento acabar',
            'quantos dias faltam de tratamento',
            'em que dia do tratamento eu estou',
            'já estou terminando o tratamento',
            'quanto tempo ainda vou tomar esse remédio',
            'meu tratamento já acabou?'
        ]
    };

    for (const [tipo, termos] of Object.entries(padroes)) {
        if (termos.some(t => msg.includes(t))) return tipo;
    }

    return null;
}

// ============================================================
// HANDLER PRINCIPAL
// subtipo é sempre fornecido por quem chama (Camada 1 ou Camada 2 do router.js) —
// nunca mais recalculado aqui dentro (Camada 3 eliminada, causa raiz do BUG-037).
// ============================================================

export async function handleRelatorios({ user, message, subtipo, params, state }) {
    const p = params || { medicamento: null, expressaoData: null };

    switch (subtipo) {
        case 'balanco_do_dia':
            return await relatorioBalancoDoDia({ user, message, params: p });
        case 'meus_remedios':
            return await relatorioMeusRemedios(user);
        case 'estoque':
            return await relatorioEstoque({ user, message, params: p });
        case 'proximo_remedio':
            return await relatorioProximoRemedio({ user, message, params: p });
        case 'adesao':
            return await relatorioAdesao({ user, message, state });
        case 'progresso_tratamento':
            return await relatorioProgressoTratamento({ user, message, state });
        default:
            return null; // não reconheceu — router cai no agente_principal
    }
}

// Princípio 17: o texto da mensagem atual resolve primeiro; o palpite do classificador
// é só fallback. Retorna { id, nome } ou null.
async function resolverMedicamento({ userId, message, medicamentoParam }) {
    const medications = await getMedicamentosAtivos(userId);
    if (medications.length === 0) return null;

    const porTexto = encontrarMedicamento(message, medications);
    if (porTexto) return { id: porTexto.id, nome: porTexto.nome };

    if (medicamentoParam) {
        const porParam = encontrarMedicamento(medicamentoParam, medications);
        if (porParam) return { id: porParam.id, nome: porParam.nome };
    }
    return null;
}

// ============================================================
// R-001 (v25): BALANÇO DO DIA — substitui tomei_hoje
// Núcleo factual determinístico + moldura escrita pelo LLM.
// ============================================================

async function relatorioBalancoDoDia({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';

    // Princípio 17: texto da mensagem primeiro; params do classificador como fallback.
    // Necessário porque a Camada 1 não produz params (C-1, v25).
    const expressao = extrairExpressaoData(message) || params.expressaoData;
    const { dataISO, erro } = resolverDataReferencia(expressao);
    if (erro === 'futuro') return comSaudacao(user.id, firstName, TEXTO_DATA_FUTURA);
    if (erro) return comSaudacao(user.id, firstName, TEXTO_DATA_NAO_RECONHECIDA);

    const janela = validarJanela(dataISO);
    if (!janela.ok) {
        return comSaudacao(user.id, firstName,
            janela.motivo === 'futuro' ? TEXTO_DATA_FUTURA : TEXTO_FORA_DA_JANELA);
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const doses = await getDosesDoDia(user.id, dataISO, med?.id || null);
    const resumo = resumirSituacao(doses);
    const rotuloData = rotularData(dataISO);
    const blocoFactual = montarBlocoFactual(doses);

    // Janela de confirmação retroativa: só até 2 dias (mesma janela de getDosesRetroativas).
    // Além dela, é leitura pura — estoque só se ajusta por pedido direto do usuário.
    const podeConfirmarRetroativo = diasAtras(dataISO) <= JANELA_CONFIRMACAO_RETROATIVA_DIAS;

    const moldura = await gerarMoldura({
        nome: firstName, rotuloData, resumo, med, podeConfirmarRetroativo
    });

    const cabecalhoData = montarCabecalhoData(dataISO, rotuloData);

    const partes = [moldura.abertura];
    if (cabecalhoData) partes.push(cabecalhoData);
    if (blocoFactual) partes.push(blocoFactual);
    if (moldura.fechamento) partes.push(moldura.fechamento);

    return comSaudacao(user.id, firstName, partes.join('\n\n'));
}

const PROMPT_MOLDURA = `Você é a Nami, assistente de saúde via WhatsApp. Linguagem simples, clara e
carinhosa, com emojis usados com moderação.

Você vai escrever a ABERTURA e o FECHAMENTO de uma mensagem. Entre as duas, o usuário verá uma
lista de doses que JÁ ESTÁ PRONTA e que você NÃO escreve.

REGRAS ABSOLUTAS:
1. NUNCA cite nome de medicamento, horário, quantidade, data ou status na abertura ou no
   fechamento. Esses dados já aparecem na lista. Fale de forma geral ("suas doses", "alguns
   remédios", "o dia").
2. NUNCA invente informação. Você recebe apenas um resumo numérico — use só ele.
3. NUNCA mencione mecanismo interno (sistema, aplicativo, banco de dados, registro técnico).
   Para o usuário existe só você.
4. Abertura: no máximo 2 frases. Fechamento: no máximo 2 frases, ou vazio.
5. Não repita a saudação com o nome mais de uma vez.

Sobre o CENÁRIO recebido:
- tudo_confirmado: celebre com leveza.
- nada_chegou_ainda: informe que o dia ainda está começando, sem cobrança.
- nada_confirmado: acolha, sem culpa, e convide a atualizar.
- parcial: reconheça o que foi feito e aponte com gentileza o que ficou em aberto.
- sem_doses: informe que não há registro para esse dia, sem alarme.

Sobre os números recebidos:
- "aguardandoConfirmacao": doses cujo horário já passou e que ainda esperam a resposta do usuário.
- "aindaNaoChegaram": doses do dia cujo horário ainda não chegou — não são atraso, não cobre.
- "semRegistro": doses cujo horário passou sem registro. Não afirme que o usuário não tomou;
  trate como pendência de confirmação.

Se "podeConfirmarRetroativo" for true E houver doses faltantes, o FECHAMENTO deve convidar o
usuário a avisar caso tenha tomado e esquecido de confirmar — dizendo que você registra e ajusta
o estoque para ele.
Se for false E houver doses faltantes, o fechamento NÃO deve oferecer registro: explique com
delicadeza que para dias mais antigos você só consegue mostrar o histórico, e que ajustes de
estoque precisam ser pedidos diretamente.

Responda APENAS com JSON válido, sem markdown e sem texto antes ou depois:
{"abertura": "...", "fechamento": "..."}`;

async function gerarMoldura({ nome, rotuloData, resumo, med, podeConfirmarRetroativo }) {
    const entrada = JSON.stringify({
        nome,
        dia: rotuloData,
        medicamentoEspecifico: med ? true : false,
        cenario: resumo.cenario,
        totalDoses: resumo.total,
        confirmadas: resumo.confirmadas,
        faltantes: resumo.faltantes,
        aguardandoConfirmacao: resumo.aguardandoConfirmacao,
        aindaNaoChegaram: resumo.aindaNaoChegaram,
        semRegistro: resumo.semRegistro,
        podeConfirmarRetroativo
    });

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 300,
            system: PROMPT_MOLDURA,
            messages: [{ role: 'user', content: entrada }]
        });

        const raw = resposta.content[0]?.text?.trim() || '';
        // Critério de FORMA, não de tamanho (lição do BUG-067): texto que começa com "{"
        // nunca é exposto cru ao usuário.
        const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
        const abertura = typeof parsed.abertura === 'string' ? parsed.abertura.trim() : '';
        const fechamento = typeof parsed.fechamento === 'string' ? parsed.fechamento.trim() : '';

        if (!abertura || abertura.startsWith('{')) throw new Error('abertura inválida');
        return { abertura, fechamento: fechamento.startsWith('{') ? '' : fechamento };

    } catch (e) {
        console.warn(`[relatorios] Moldura via LLM falhou, usando padrão: ${e.message}`);
        return molduraPadrao({ nome, rotuloData, resumo });
    }
}

// ============================================================
// R-002: QUAIS MEUS REMÉDIOS?
// ============================================================

async function relatorioMeusRemedios(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const medications = await getMedicamentosAtivos(user.id);

    if (medications.length === 0) {
        return `Você ainda não tem remédios cadastrados, ${firstName}. Quer cadastrar agora? 💊`;
    }

    // A-2 (v25): ordem alfabética. Feita AQUI e não em getUserMedications de propósito —
    // aquela função tem sete consumidores e reordenar na origem mudaria o comportamento
    // de quem não pediu. localeCompare com 'pt-BR' para acentuação correta (Ômega).
    const ordenados = [...medications].sort((a, b) =>
        String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR')
    );

    let msg = `💊 Seus remédios cadastrados, ${firstName}:\n\n`;

    ordenados.forEach((med, i) => {
        const horariosAtivos = (med.schedules || []).filter(s => s.ativo);
        // A-2 (v25): horários também ordenados — antes saíam na ordem do banco ("21:00 e 09:00").
        const horarios = horariosAtivos.length > 0
            ? horariosAtivos
                .map(s => s.horario.substring(0, 5))
                .sort((x, y) => x.localeCompare(y))
                .join(' e ')
            : 'sem horário cadastrado';
        const forma = med.forma_farmaceutica || 'comprimido';
        // A-4 (v25): dosagem nula era exibida literalmente como "null".
        const dosagem = med.dosagem || 'dosagem não informada';
        msg += `${i + 1}. *${med.nome}* — ${dosagem} (${forma})\n`;
        msg += `   ⏰ ${horarios}\n\n`;
    });

    return msg.trim();
}

// ============================================================
// R-003: ESTOQUE
// ============================================================

async function relatorioEstoque({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const estoque = await getEstoque(user.id);

    if (estoque.length === 0) {
        return `Você ainda não tem remédios cadastrados, ${firstName}. 💊`;
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const lista = med ? estoque.filter(e => e.id === med.id) : estoque;
    if (lista.length === 0) return null; // não encontrou — cai no principal

    const cabecalho = med
        ? `📦 Estoque do *${med.nome}*, ${firstName}:\n\n`
        : `📦 Estoque dos seus remédios, ${firstName}:\n\n`;

    let msg = cabecalho;
    for (const m of lista) {
        if (m.estoque_atual <= 0) {
            msg += `🚨 *${m.nome}* — sem estoque! Compre com urgência\n`;
        } else if (m.estoque_atual <= m.estoque_minimo) {
            msg += `⚠️ *${m.nome}* — ${m.estoque_atual} unidades (hora de comprar mais!)\n`;
        } else {
            msg += `✅ *${m.nome}* — ${m.estoque_atual} unidades\n`;
        }
    }
    return msg.trim();
}

// ============================================================
// R-004: O QUE TENHO QUE TOMAR AGORA?
// ============================================================

async function relatorioProximoRemedio({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const { passados, agora, proximos } = await getProximosMedicamentos(user.id);

    if (passados.length === 0 && agora.length === 0 && proximos.length === 0) {
        return `Não encontrei remédios agendados para hoje, ${firstName}. 💊`;
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const linhaPassado = m => `${m.confirmado ? '✅' : '⚠️'} *${m.nome}* (${m.horario}) — ${m.confirmado ? 'já registrado' : 'não registrado'}`;
    // N-2 (v25): a linha "agora" ignorava m.confirmado e anunciava dose já confirmada como
    // pendente, contradizendo o balanco_do_dia.
    const linhaAgora = m => m.confirmado
        ? `✅ *${m.nome}* (${m.horario}) — já registrado`
        : `💊 *${m.nome}* (${m.horario}) — está na hora de tomar!`;
    const linhaProximo = m => m.confirmado
        ? `✅ *${m.nome}* (${m.horario}) — já registrado`
        : `🔜 *${m.nome}* — próximo às ${m.horario}`;

    // Sem medicamento nomeado: mostra o que ainda importa.
    // N-3 (v25): "quais minhas próximas doses?" devolvia o dia inteiro, incluindo doses já
    // registradas. Passado já confirmado é ruído aqui; passado NÃO confirmado permanece,
    // porque é pendência real.
    if (!med) {
        const passadosPendentes = passados.filter(m => !m.confirmado);
        const agoraRelevantes = agora.filter(m => !m.confirmado);
        const proximosRelevantes = proximos.filter(m => !m.confirmado);

        if (passadosPendentes.length === 0 && agoraRelevantes.length === 0 && proximosRelevantes.length === 0) {
            return `Tudo em ordem por hoje, ${firstName}! Você já registrou todas as doses do dia. ✅`;
        }

        let msg = `⏰ Seus próximos remédios, ${firstName}:\n\n`;
        for (const m of agoraRelevantes) msg += linhaAgora(m) + '\n';
        for (const m of proximosRelevantes) msg += linhaProximo(m) + '\n';

        if (passadosPendentes.length > 0) {
            msg += `\nAinda sem confirmação de hoje:\n\n`;
            for (const m of passadosPendentes) msg += linhaPassado(m) + '\n';
        }
        return msg.trim();
    }

    // Com medicamento nomeado: destaque primeiro, resto como lembrete complementar.
    const ehDoMed = m => m.nome === med.nome;
    const destaqueAgora = agora.filter(ehDoMed);
    const destaqueProximos = proximos.filter(ehDoMed);
    const destaquePassados = passados.filter(ehDoMed);

    let msg = '';
    if (destaqueAgora.length > 0) {
        msg += `⏰ *${med.nome}*, ${firstName}:\n\n`;
        for (const m of destaqueAgora) msg += linhaAgora(m) + '\n';
        for (const m of destaqueProximos) msg += linhaProximo(m) + '\n';
    } else if (destaqueProximos.length > 0) {
        msg += `⏰ Seu próximo *${med.nome}*, ${firstName}:\n\n`;
        msg += linhaProximo(destaqueProximos[0]) + '\n';
        for (const m of destaqueProximos.slice(1)) msg += linhaProximo(m) + '\n';
    } else if (destaquePassados.length > 0) {
        msg += `⏰ *${med.nome}*, ${firstName}:\n\n`;
        for (const m of destaquePassados) msg += linhaPassado(m) + '\n';
        msg += `\nNão há mais doses do ${med.nome} programadas para hoje.\n`;
    } else {
        msg += `Não encontrei doses do *${med.nome}* programadas para hoje, ${firstName}.\n`;
    }

    const outros = [
        ...agora.filter(m => !ehDoMed(m)).map(linhaAgora),
        ...proximos.filter(m => !ehDoMed(m)).map(linhaProximo)
    ];

    if (outros.length > 0) {
        msg += `\nAh, e só pra lembrar — hoje você também tem:\n\n${outros.join('\n')}`;
    }

    return msg.trim();
}

// ============================================================
// R-005: ADESÃO SOB DEMANDA — seleção de período em duas etapas
// ============================================================

export function extrairPeriodo(message) {
    for (const periodo of PERIODOS_VALIDOS) {
        if (new RegExp(`\\b${periodo}\\b`).test(message)) return periodo;
    }
    return null;
}

// Mensagem menciona algum número (fora dos 3 períodos válidos) — pedido de período fora de escopo
function mencionaPeriodoInvalido(message) {
    return /\b\d{1,3}\b/.test(message);
}

async function relatorioAdesao({ user, message, state }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const aguardandoPeriodo = state?.state === 'aguardando_periodo_adesao';

    if (aguardandoPeriodo && isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Sem problemas, ${firstName}! Se quiser ver sua adesão depois, é só me chamar 🌿`;
    }

    const periodo = extrairPeriodo(message);

    if (!periodo) {
        await saveConversationState(user.id, { state: 'aguardando_periodo_adesao', context: {} });

        if (mencionaPeriodoInvalido(message)) {
            await registrarEvento({
                tipo: 'intencao_nao_suportada',
                severidade: 'baixa',
                userId: user.id,
                agent: 'relatorios',
                origem: 'classificador_central',
                agentLogId: null,
                titulo: 'Intenção não suportada (período de adesão inválido)'
            });
            return comSaudacao(user.id, firstName, montarRecusaPeriodo());
        }
        return comSaudacao(user.id, firstName, montarPerguntaPeriodo());
    }

    await saveConversationState(user.id, { state: 'idle', context: {} });

    const dados = await calcularAdesao(user.id, periodo);
    if (dados.esperado === 0) {
        return `Ainda não tenho dados suficientes para calcular sua adesão, ${firstName}. Continue confirmando suas doses e em breve terei um histórico para te mostrar! 💊`;
    }

    return comSaudacao(user.id, firstName, await montarRespostaAdesaoDireta(user, dados, periodo));
}

// "Sob demanda: versão direta" (4.7) — números atuais + tendência desde o último
// envio automático, sem avançar nem repetir o texto da jornada semanal/mensal.
// Não atualiza adesao_estado — só os envios automáticos fazem isso.
async function montarRespostaAdesaoDireta(user, dados, periodo) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const adesaoEstado = await getAdesaoEstado(user.id);

    let msg = `📊 Sua adesão nos últimos ${periodo} dias, ${firstName}:\n\n`;
    msg += `${dados.percentual}% (${dados.confirmado}/${dados.esperado} doses)\n\n`;
    msg += `✅ Confirmadas: ${dados.porStatus.confirmado}\n`;
    msg += `⏳ Sem resposta: ${dados.porStatus.nao_informado}\n`;
    msg += `❌ Não tomadas: ${dados.porStatus.nao_tomado}\n`;
    msg += `📦 Sem estoque: ${dados.porStatus.sem_estoque}`;

    if (adesaoEstado.percentual_ultimo_envio !== null && adesaoEstado.percentual_ultimo_envio !== undefined) {
        const diff = dados.percentual - adesaoEstado.percentual_ultimo_envio;
        const tipoTendencia = diff > 5 ? 'subiu' : diff < -5 ? 'caiu' : 'estavel';
        msg += `\n\n${montarBlocoTendencia(tipoTendencia, {
            taxaAnterior: adesaoEstado.percentual_ultimo_envio,
            taxaAtual: dados.percentual
        })}`;
    }

    return msg;
}

// ============================================================
// R-006: PROGRESSO DO TRATAMENTO
// ============================================================

function montarBlocoIndividual(p) {
    const fase = escolherFaseProgresso(p.percentualDecorrido);
    const diasCobertosPeloEstoque = Math.floor(p.estoqueAtual / p.dosesPorDia);
    const suficiente = diasCobertosPeloEstoque >= p.diasRestantes;
    const blocoEstoque = montarBlocoEstoque({
        suficiente,
        estoque: p.estoqueAtual,
        diasRestantes: p.diasRestantes,
        diasCobertos: diasCobertosPeloEstoque
    });

    return montarMensagemProgresso({
        medicamento: p.nome,
        diasDecorridos: p.diasDecorridos,
        tratamentoDias: p.tratamentoDias,
        diasRestantes: p.diasRestantes,
        dosesRestantes: p.dosesRestantes,
        blocoEstoque,
        fase
    });
}

async function relatorioProgressoTratamento({ user, message }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const progressos = await calcularProgressoTratamento(user.id);

    if (progressos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return comSaudacao(user.id, firstName, montarFallbackContinuo());
    }

    if (progressos.length === 1) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return comSaudacao(user.id, firstName, montarBlocoIndividual(progressos[0]));
    }

    // 2+ tratamentos — tenta casar nome mencionado
    const medicationsElegiveis = progressos.map(p => ({ id: p.medicationId, nome: p.nome }));
    const mencionado = encontrarMedicamento(message, medicationsElegiveis);

    if (mencionado) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        const p = progressos.find(x => x.medicationId === mencionado.id);
        return comSaudacao(user.id, firstName, montarBlocoIndividual(p));
    }

    // Pedido genérico ("todos", "tudo", "meu tratamento" sem nome) — resumo compacto
    await saveConversationState(user.id, {
        state: 'aguardando_escolha_tratamento',
        context: { medicationIds: progressos.map(p => p.medicationId) }
    });
    return comSaudacao(user.id, firstName, montarResumoCompacto(progressos));
}

// ============================================================
// RESUMO AUTOMÁTICO — SEMANAL OU FECHAMENTO MENSAL (chamado pelo scheduler)
// ============================================================

export async function enviarResumoSemanal(user) {
    try {
        const firstName = user.name?.split(' ')[0] || 'você';
        const adesaoEstado = await getAdesaoEstado(user.id);

        const isMensal = !adesaoEstado.ultimo_fechamento_mensal_at ||
            (Date.now() - new Date(adesaoEstado.ultimo_fechamento_mensal_at).getTime()) >= DIAS_FECHAMENTO_MENSAL * 24 * 60 * 60 * 1000;
        const dias = isMensal ? 30 : 7;

        const dados = await calcularAdesao(user.id, dias);
        if (dados.esperado === 0) {
            console.log(`⏭️  Resumo ${isMensal ? 'mensal' : 'semanal'} ignorado (sem doses no período): ${user.phone}`);
            return;
        }

        const faixaNova = escolherFaixa(dados.percentual);
        const mudouDeFaixa = adesaoEstado.faixa_atual !== null && adesaoEstado.faixa_atual !== faixaNova;
        const semanaNova = (adesaoEstado.faixa_atual === null || mudouDeFaixa)
            ? 1
            : (adesaoEstado.semana_atual_na_faixa || 1) + 1;

        let texto = isMensal
            ? montarMensagemMensal({ nome: firstName, taxa: dados.percentual, faixa: faixaNova })
            : montarMensagemSemanal({ nome: firstName, taxa: dados.percentual, faixa: faixaNova, semana: semanaNova });

        // Bloco motivo dominante — só o de maior contagem entre os 3; empate/zerado, omite
        const motivos = ['nao_tomado', 'nao_informado', 'sem_estoque'];
        const motivoDominante = motivos.reduce((maior, atual) =>
            dados.porStatus[atual] > (dados.porStatus[maior] || 0) ? atual : maior, null);

        if (motivoDominante) {
            texto += `\n\n${montarBlocoMotivo(motivoDominante)}`;

            // Turno — só no fechamento mensal, só para nao_tomado/nao_informado
            if (isMensal && motivoDominante !== 'sem_estoque' && dados.diagnosticoPorTurno) {
                const turno = dados.diagnosticoPorTurno[motivoDominante];
                if (turno) texto += `\n\n${montarBlocoTurno(turno)}`;
            }
        }

        // Bloco tendência — compara com o envio automático anterior
        if (adesaoEstado.percentual_ultimo_envio !== null && adesaoEstado.percentual_ultimo_envio !== undefined) {
            const diff = dados.percentual - adesaoEstado.percentual_ultimo_envio;
            const tipoTendencia = diff > 5 ? 'subiu' : diff < -5 ? 'caiu' : 'estavel';
            texto += `\n\n${montarBlocoTendencia(tipoTendencia, {
                taxaAnterior: adesaoEstado.percentual_ultimo_envio,
                taxaAtual: dados.percentual
            })}`;
        }

        // Bloco marco — primeira vez alcançando 100%
        const melhorAnterior = adesaoEstado.melhor_faixa_atingida;
        if (faixaNova === '100' && melhorAnterior !== '100') {
            texto += `\n\n${montarBlocoMarco()}`;
        }

        await sendTextMessage(user.phone, texto);

        const melhorFaixaNova = (!melhorAnterior || RANKING_FAIXA[faixaNova] > RANKING_FAIXA[melhorAnterior])
            ? faixaNova
            : melhorAnterior;

        await upsertAdesaoEstado(user.id, {
            faixa_atual: faixaNova,
            percentual_ultimo_envio: dados.percentual,
            semana_atual_na_faixa: semanaNova,
            melhor_faixa_atingida: melhorFaixaNova,
            ultimo_fechamento_mensal_at: isMensal ? new Date().toISOString() : adesaoEstado.ultimo_fechamento_mensal_at
        });

        console.log(`📊 Resumo ${isMensal ? 'mensal' : 'semanal'} enviado para ${user.phone} (faixa: ${faixaNova}, ${dados.percentual}%)`);

    } catch (error) {
        console.error(`❌ Erro ao enviar resumo semanal para ${user.phone}:`, error.message);
    }
}
