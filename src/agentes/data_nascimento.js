// ============================================================
// COLETA DE DATA DE NASCIMENTO NO ONBOARDING (MH-072 Parte A)
// Máquina de turno determinística: quem decide etapa, avanço, correção e
// validade é sempre o JS (extrairComponenteData/montarDataNascimento, em
// ../dataNascimento.js). A LLM entra em dois papéis, isolados um do outro:
// 1) redigir o texto de cada turno, com o tom da Nami (nunca decide fluxo);
// 2) classificar uma resposta 'indeterminado' em recusa|duvida|nova_intencao|
//    ruido (única outra chamada de LLM do arquivo).
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState, updateUser, formatarHistoricoConversa } from '../database.js';
import { extrairComponenteData, montarDataNascimento } from '../dataNascimento.js';
import { definirEstadoPosOnboarding } from '../estadoPosOnboarding.js';
import { degradar } from '../observabilidade.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TENTATIVAS_INDETERMINADO = 3;
const CAMPO_ESPERADO_POR_ETAPA = { nasc_dia: 'dia', nasc_mes: 'mes', nasc_ano: 'ano' };

function firstNameOf(user) {
    return user.name ? user.name.split(' ')[0] : 'você';
}

// Confirmação curta ("sim", "isso", "correto"...) — mesmo padrão já usado em
// isLgpdAccepted (recepcionista.js) e isAffirmativeSimple (router.js): lista
// fechada para reconhecer SIM/NÃO, não uma lista crescente de "foge do padrão"
// (isso seria o antipadrão do princípio 14 — não é o caso aqui).
function respostaAfirmativaSimples(message) {
    const termos = ['sim', 'isso', 'isso mesmo', 'correto', 'exato', 'confirmo', 'certo', 'certinho', 'pode', 'ok'];
    const msg = (message || '').toLowerCase().trim();
    return termos.some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ','));
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatarDataBR(dia, mes, ano) {
    return `${pad2(dia)}/${pad2(mes)}/${ano}`;
}

function proximaEtapaFaltante(context) {
    if (context.dia === null || context.dia === undefined) return 'nasc_dia';
    if (context.mes === null || context.mes === undefined) return 'nasc_mes';
    if (context.ano === null || context.ano === undefined) return 'nasc_ano';
    return 'nasc_confirmacao';
}

// ============================================================
// CLASSIFICADOR DE `indeterminado` (seção 6.4 do briefing) — só roda quando o
// extrator determinístico não reconheceu nenhum componente de data.
// ============================================================
async function classificarIndeterminado({ message, historicoConversa }) {
    const historicoTexto = formatarHistoricoConversa(historicoConversa);

    const systemPrompt = `Você é um classificador para a etapa de coleta de data de nascimento de um assistente de saúde via WhatsApp (a Nami).

A mensagem do usuário não foi reconhecida como um componente de data (dia, mês ou ano). Classifique-a em UMA destas categorias:

- recusa: o usuário não quer informar a data de nascimento, está incomodado com a pergunta, ou pede para pular/parar. Ex: "não quero dizer", "prefiro não falar", "chato isso", "não quero mais".
- duvida: o usuário pergunta o motivo da pergunta, questiona a necessidade, sem recusar diretamente. Ex: "pra que você precisa disso?", "por que isso importa?", "vocês vão usar pra quê?".
- nova_intencao: o usuário muda de assunto — quer fazer outra coisa (cadastrar remédio, tirar outra dúvida, etc.) em vez de responder. Ex: "na verdade quero cadastrar meu remédio agora", "esquece, me ajuda com outra coisa".
- ruido: a mensagem não se encaixa em nenhuma das anteriores — resposta confusa, incompreensível, fora de contexto, ou que simplesmente não é uma data válida.

CONVERSA RECENTE:
${historicoTexto}

MENSAGEM ATUAL: "${message}"

Responda APENAS com uma palavra: recusa, duvida, nova_intencao ou ruido. Sem pontuação, sem explicação.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        const validos = ['recusa', 'duvida', 'nova_intencao', 'ruido'];
        const achado = validos.find(v => texto.includes(v));
        console.log(`🎂 [DATA-NASCIMENTO] Classificador indeterminado: "${message}" -> ${achado || 'ruido (fallback)'}`);
        return achado || 'ruido';
    } catch (e) {
        console.error(`❌ [DATA-NASCIMENTO] Erro no classificador de indeterminado: ${e.message} — assumindo ruido`);
        return await degradar({
            origem: 'data_nascimento',
            motivo: 'classificador_indeterminado_falhou',
            agent: 'data_nascimento',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: 'ruido'
        });
    }
}

// ============================================================
// SYSTEM PROMPT — redige o texto do turno. Nunca decide etapa/validade.
// ============================================================
function buildSystemPrompt({ etapa, context, user, motivo, correcaoAplicada, dataFormatada }) {
    const nome = firstNameOf(user);
    const mensagemInicial = context.mensagem_inicial || '';

    const base = `Você é a Nami, uma assistente de saúde pessoal que ajuda pessoas a não esquecerem seus medicamentos de uso contínuo.

Você está coletando a data de nascimento de ${nome} durante o onboarding, logo depois do aceite da LGPD. A finalidade é só conhecer a idade média do público da Nami (estatística agregada) — não há personalização por idade.

Seu tom é: acolhedor, caloroso, humano, responsável e confiável. Use linguagem natural e próxima, não robótica. Use emojis com moderação.

Responda APENAS com a mensagem que deve ser enviada ao usuário. Sem explicações, sem prefixos, sem aspas.`;

    const correcaoTexto = correcaoAplicada
        ? `\n\nO usuário acabou de CORRIGIR o campo "${correcaoAplicada.campo}" para ${correcaoAplicada.valor}. Comece reconhecendo a correção brevemente (ex: "Corrigi para ...!"), sem se desculpar de forma exagerada.`
        : '';

    if (etapa === 'nasc_dia') {
        if (motivo === 'combinacao_invalida') {
            return `${base}${correcaoTexto}

A combinação de dia/mês/ano que ${nome} informou não existe no calendário (ex: 31 de fevereiro). Explique gentilmente que a data não bate e peça o DIA de novo, com exemplo obrigatório de formato.
Exemplo de tom: "Acho que essa data não existe no calendário! 😅 Vamos conferir de novo — em que dia do mês você nasceu? Por exemplo: 7"`;
        }
        return `${base}${correcaoTexto}

Pergunte em que DIA do mês ${nome} nasceu. O exemplo de formato é OBRIGATÓRIO na pergunta.
Exemplo: "Em que dia do mês você nasceu? Pode mandar só o número — por exemplo: 7"`;
    }

    if (etapa === 'nasc_mes') {
        return `${base}${correcaoTexto}

Pergunte de qual MÊS ${nome} nasceu. O exemplo de formato é OBRIGATÓRIO na pergunta.
Exemplo: "E de qual mês? Pode escrever o nome — por exemplo: março"`;
    }

    if (etapa === 'nasc_ano') {
        return `${base}${correcaoTexto}

Pergunte em que ANO ${nome} nasceu. O exemplo de formato é OBRIGATÓRIO na pergunta.
Exemplo: "E em que ano? Os quatro números — por exemplo: 1958"`;
    }

    if (etapa === 'nasc_confirmacao') {
        return `${base}${correcaoTexto}

A data de nascimento montada é EXATAMENTE: ${dataFormatada}. Cite esse texto literalmente (não recalcule, não reformate os números). Leia essa data de volta para ${nome} de forma natural e pergunte se está certo.
${motivo === 'correcao' ? '' : `Exemplo: "Deixa eu confirmar: você nasceu em ${dataFormatada}, certo?"`}`;
    }

    if (etapa === 'nasc_ambiguo') {
        return `${base}

${nome} respondeu um número que pode ser tanto o DIA quanto o MÊS do nascimento (os dois cabem). Pergunte de forma simples e curta qual dos dois ele quis dizer. Não repita os outros campos.
Exemplo: "Isso é o dia ou o mês do seu nascimento?"`;
    }

    if (etapa === 'nasc_recusa') {
        return `${base}

${nome} não quer informar a data de nascimento. Acolha a decisão SEM insistir e SEM tentar convencer — é a única resposta aceitável aqui. Depois, retome com naturalidade o que ${nome} pediu originalmente, para seguir a conversa dali.

MENSAGEM ORIGINAL DE ${nome} (o que ele pediu antes de começar o onboarding): "${mensagemInicial}"

Se a mensagem original indicar pedido de cadastro de remédio, siga para isso, citando o remédio mencionado. Caso contrário, pergunte por onde ${nome} quer começar.
Exemplo (quando a msg original foi "quero cadastrar losartana"):
"Sem problemas, ${nome}! Não vou insistir nisso 😊 Agora vamos ao que você me pediu — cadastrar a losartana. Qual a dosagem?"`;
    }

    if (etapa === 'nasc_duvida') {
        return `${base}

${nome} perguntou por que a Nami precisa da data de nascimento. Explique em UMA frase: é só pra entender a idade média de quem usa a Nami, de forma agregada. Depois, ofereça EXPLICITAMENTE a opção de não informar, sem pressão.
Exemplo: "É só pra gente entender a idade média de quem usa a Nami, de forma bem geral 🌿 Mas se preferir não informar, sem problema nenhum — é só me dizer. Em que dia você nasceu?"`;
    }

    if (etapa === 'nasc_ruido') {
        const campo = { nasc_dia: 'dia', nasc_mes: 'mês', nasc_ano: 'ano' }[context.etapa] || 'dia';
        const ofertaSaida = motivo === 'oferecer_saida'
            ? ' Ofereça espontaneamente pular essa etapa, já que já tentamos algumas vezes sem sucesso — deixe claro que não tem problema nenhum pular.'
            : '';
        return `${base}

A última resposta de ${nome} não deu pra entender como resposta à pergunta sobre a data de nascimento (campo pendente: ${campo}). Repita a pergunta dessa etapa com o exemplo de formato, de forma gentil, sem soar repetitiva ou impaciente.${ofertaSaida}`;
    }

    if (etapa === 'nasc_fechamento') {
        return `${base}

${nome} acabou de confirmar a data de nascimento, que já foi salva. Agradeça de forma breve (ex: "Anotei aqui 📝") e retome com naturalidade o que ${nome} pediu originalmente antes do onboarding, para seguir a conversa dali.

MENSAGEM ORIGINAL DE ${nome}: "${mensagemInicial}"

Se a mensagem original indicar pedido de cadastro de remédio, siga para isso, citando o remédio mencionado. Caso contrário, pergunte por onde ${nome} quer começar.
Exemplo (quando a msg original foi "quero cadastrar losartana"):
"Maravilha, ${nome}! Anotei aqui 📝 Agora vamos ao que você me pediu — cadastrar a losartana. Qual a dosagem?"`;
    }

    return base;
}

async function gerarTexto(promptArgs) {
    const systemPrompt = buildSystemPrompt(promptArgs);
    const resposta = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: promptArgs.message || 'Olá' }]
    });
    return resposta.content[0].text.trim();
}

// ============================================================
// FECHAMENTO DO FLUXO (seção 7) — reproduz a decisão de roteamento que antes
// vivia em recepcionista.js, agora com chamador único (definirEstadoPosOnboarding).
// ============================================================

async function fecharSemDado({ user, context, message }) {
    const resposta = await gerarTexto({ etapa: 'nasc_recusa', context, user, message });
    await definirEstadoPosOnboarding(user, context.mensagem_inicial || '');
    return resposta;
}

async function gravarEFechar({ user, context, message }) {
    await updateUser(user.id, { data_nascimento: context.iso });
    console.log(`🎂 [DATA-NASCIMENTO] Data de nascimento gravada — ${user.phone} — ${context.iso}`);
    const resposta = await gerarTexto({ etapa: 'nasc_fechamento', context, user, message });
    await definirEstadoPosOnboarding(user, context.mensagem_inicial || '');
    return resposta;
}

// ============================================================
// PREENCHIMENTO — ponto único que decide avançar / repetir / confirmar / corrigir
// depois que um campo (dia/mes/ano) foi determinado, seja por extração direta,
// data_completa, ou resolução de ambiguidade.
// ============================================================

async function validarConcluirOuContinuar({ user, message, novoContext, correcaoAplicada }) {
    const todosPreenchidos = novoContext.dia !== null && novoContext.dia !== undefined
        && novoContext.mes !== null && novoContext.mes !== undefined
        && novoContext.ano !== null && novoContext.ano !== undefined;

    if (!todosPreenchidos) return null;

    const montagem = montarDataNascimento({ dia: novoContext.dia, mes: novoContext.mes, ano: novoContext.ano });

    if (!montagem.valida) {
        novoContext.dia = null;
        novoContext.etapa = 'nasc_dia';
        await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
        return await gerarTexto({ etapa: 'nasc_dia', context: novoContext, user, message, motivo: 'combinacao_invalida' });
    }

    novoContext.etapa = 'nasc_confirmacao';
    novoContext.iso = montagem.iso;
    await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
    return await gerarTexto({
        etapa: 'nasc_confirmacao', context: novoContext, user, message,
        motivo: correcaoAplicada ? 'correcao' : 'leitura',
        correcaoAplicada,
        dataFormatada: formatarDataBR(novoContext.dia, novoContext.mes, novoContext.ano)
    });
}

async function aplicarPreenchimento({ user, message, context, etapaAtual, campo, valor, foiCorrecao }) {
    const novoContext = {
        ...context,
        [campo]: valor,
        tentativas_indeterminado: 0,
        oferta_pular_ativa: false
    };
    delete novoContext.desambiguando;

    const correcaoAplicada = foiCorrecao ? { campo, valor } : null;

    const respostaConclusao = await validarConcluirOuContinuar({ user, message, novoContext, correcaoAplicada });
    if (respostaConclusao !== null) return respostaConclusao;

    if (correcaoAplicada) {
        novoContext.etapa = etapaAtual;
        await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
        return await gerarTexto({ etapa: etapaAtual, context: novoContext, user, message, motivo: 'correcao', correcaoAplicada });
    }

    if (campo === CAMPO_ESPERADO_POR_ETAPA[etapaAtual]) {
        const proxima = proximaEtapaFaltante(novoContext);
        novoContext.etapa = proxima;
        await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
        return await gerarTexto({ etapa: proxima, context: novoContext, user, message, motivo: 'avanco' });
    }

    // Campo "futuro" (ainda não previsto pela etapa atual): preenche, permanece
    // na etapa atual e repete a pergunta (seção 6.2 do briefing).
    novoContext.etapa = etapaAtual;
    await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
    return await gerarTexto({ etapa: etapaAtual, context: novoContext, user, message, motivo: 'campo_futuro' });
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleDataNascimento({ user, message, state, historicoConversa = [] }) {
    const context = state?.context || {};
    const etapa = context.etapa || 'nasc_dia';

    // Saída de emergência já oferecida (3+ tentativas indeterminadas) — aceite explícito.
    if (context.oferta_pular_ativa && respostaAfirmativaSimples(message)) {
        console.log(`🎂 [DATA-NASCIMENTO] Saída de emergência aceita — ${user.phone}`);
        return await fecharSemDado({ user, context, message });
    }

    // Confirmação simples ("sim", "correto"...) na etapa de leitura de conferência —
    // só depois de checar correção implícita não se aplica aqui, pois uma correção
    // sempre reconhece um componente de data, o que a extração cobre a seguir.
    if (etapa === 'nasc_confirmacao' && respostaAfirmativaSimples(message)) {
        return await gravarEFechar({ user, context, message });
    }

    // Resolução de uma desambiguação pendente (turno anterior perguntou "dia ou mês?").
    if (context.desambiguando) {
        const { numero, candidatos, etapaOrigem } = context.desambiguando;
        const msgNorm = (message || '').toLowerCase();
        const escolhaDia = candidatos.includes('dia') && /\bdia\b/.test(msgNorm);
        const escolhaMes = candidatos.includes('mes') && /\bm[eê]s\b/.test(msgNorm);

        if (escolhaDia || escolhaMes) {
            const campo = escolhaDia ? 'dia' : 'mes';
            const foiCorrecao = context[campo] !== null && context[campo] !== undefined;
            return await aplicarPreenchimento({
                user, message, context, etapaAtual: etapaOrigem, campo, valor: numero, foiCorrecao
            });
        }
        // Resposta não esclareceu a escolha (ex: usuário respondeu "dia 5" em vez de só
        // "dia") — segue para extração normal da mensagem, sem ficar preso no impasse.
    }

    const campoEsperado = CAMPO_ESPERADO_POR_ETAPA[etapa] || 'dia';
    const extracao = extrairComponenteData(message, campoEsperado);

    if (extracao.tipo === 'indeterminado') {
        const classificacao = await classificarIndeterminado({ message, historicoConversa });

        if (classificacao === 'recusa') {
            console.log(`🎂 [DATA-NASCIMENTO] Recusa — ${user.phone}`);
            return await fecharSemDado({ user, context, message });
        }

        if (classificacao === 'nova_intencao') {
            console.log(`🎂 [DATA-NASCIMENTO] Nova intenção — escalando ao roteador — ${user.phone}`);
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return { escalarParaRoteador: true };
        }

        if (classificacao === 'duvida') {
            const novoContext = { ...context };
            await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
            return await gerarTexto({ etapa: 'nasc_duvida', context: novoContext, user, message, motivo: 'duvida' });
        }

        // ruido
        const tentativas = (context.tentativas_indeterminado || 0) + 1;
        const ofereceSaida = tentativas >= MAX_TENTATIVAS_INDETERMINADO;
        const novoContext = { ...context, tentativas_indeterminado: tentativas, oferta_pular_ativa: ofereceSaida };
        await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
        return await gerarTexto({
            etapa: 'nasc_ruido', context: novoContext, user, message,
            motivo: ofereceSaida ? 'oferecer_saida' : 'repetir'
        });
    }

    if (extracao.tipo === 'ambiguo') {
        const novoContext = {
            ...context,
            desambiguando: { numero: extracao.valor, candidatos: extracao.candidatos, etapaOrigem: etapa }
        };
        await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
        return await gerarTexto({ etapa: 'nasc_ambiguo', context: novoContext, user, message, motivo: 'ambiguo' });
    }

    if (extracao.tipo === 'data_completa') {
        const { dia, mes, ano } = extracao.valor;
        const foiCorrecaoDia = context.dia !== null && context.dia !== undefined;
        const novoContext = {
            ...context, dia, mes, ano,
            tentativas_indeterminado: 0, oferta_pular_ativa: false
        };
        delete novoContext.desambiguando;

        const correcaoAplicada = foiCorrecaoDia ? { campo: 'dia', valor: dia } : null;
        return await validarConcluirOuContinuar({ user, message, novoContext, correcaoAplicada });
    }

    // dia | mes | ano
    const campo = extracao.tipo;
    const foiCorrecao = context[campo] !== null && context[campo] !== undefined;
    return await aplicarPreenchimento({ user, message, context, etapaAtual: etapa, campo, valor: extracao.valor, foiCorrecao });
}
