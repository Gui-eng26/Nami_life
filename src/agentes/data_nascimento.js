// ============================================================
// COLETA DE DATA DE NASCIMENTO NO ONBOARDING (MH-072 Parte A, correções MH-072 A.1)
// Máquina de turno determinística: quem decide etapa, avanço, correção e
// validade é sempre o JS (extrairComponenteData/montarDataNascimento, em
// ../dataNascimento.js). A LLM entra em dois papéis, isolados um do outro:
// 1) redigir o texto de cada turno, com o tom da Nami (nunca decide fluxo) —
//    sempre recebendo um bloco de ESTADO explícito (campos confirmados, campo
//    pendente, o que acabou de ser aceito/rejeitado), pra nunca improvisar em
//    cima do histórico bruto (MH-072 A.1 item 1);
// 2) classificar uma resposta 'indeterminado' em recusa|duvida|nova_intencao|
//    ruido — e, quando a etapa é nasc_confirmacao, também confirmacao|negacao
//    (MH-072 A.1 item 4) — única outra chamada de LLM do arquivo.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState, updateUser, formatarHistoricoConversa } from '../database.js';
import { extrairComponenteData, montarDataNascimento } from '../dataNascimento.js';
import { definirEstadoPosOnboarding } from '../estadoPosOnboarding.js';
import { degradar } from '../observabilidade.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// O número só é significativo porque saudação (item 3, A.2) e declarações explícitas
// (recusa/dúvida/nova_intencao, item 7, A.1) são EXCLUÍDAS do contador — ele conta
// exclusivamente tentativa real de resposta ininteligível à pergunta pendente.
const MAX_TENTATIVAS_INDETERMINADO = 3;
const CAMPO_ESPERADO_POR_ETAPA = { nasc_dia: 'dia', nasc_mes: 'mes', nasc_ano: 'ano' };
const CAMPO_LABEL_POR_ETAPA = { nasc_dia: 'dia', nasc_mes: 'mês', nasc_ano: 'ano', nasc_confirmacao: 'confirmação' };

function firstNameOf(user) {
    return user.name ? user.name.split(' ')[0] : 'você';
}

// Confirmação curta ("sim", "isso", "correto"...) — mesmo padrão já usado em
// isAffirmativeSimple (router.js): lista fechada para reconhecer SIM/NÃO, não
// uma lista crescente de "foge do padrão" (isso seria o antipadrão do
// princípio 14 — não é o caso aqui). Nota BUG-88: o equivalente em
// recepcionista.js (isLgpdAccepted) NÃO era uma lista fechada de SIM/NÃO — era
// checada com includes() sobre mensagem livre, o que é o antipadrão de fato;
// foi substituído por classificarConsentimentoLgpd (classificação semântica).
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

// Puramente informativo (MH-072 A.1 item 1): identifica um ano de 2 dígitos que
// extrairComponenteData já descartou por regra (nunca infere século — "89" pode ser
// 1889, 1989 ou 2089). Serve só pra avisar a LLM do que foi rejeitado e por quê; a
// decisão de fluxo já foi tomada pelo extrator, isso não reabre decisão nenhuma.
function detectarAnoDoisDigitosRejeitado(message) {
    const norm = (message || '').toLowerCase();
    if (/\b\d{3,4}\b/.test(norm)) return null;
    const m = norm.match(/\b(\d{2})\b/);
    return m ? m[1] : null;
}

// Estado determinístico do preenchimento — mesma leitura que o JS usa pra decidir
// fluxo, exposta pra LLM só redigir em cima dela (nunca inferir do histórico).
function estadoContexto(context, etapa) {
    const camposPreenchidos = {};
    if (context.dia !== null && context.dia !== undefined) camposPreenchidos.dia = context.dia;
    if (context.mes !== null && context.mes !== undefined) camposPreenchidos.mes = context.mes;
    if (context.ano !== null && context.ano !== undefined) camposPreenchidos.ano = context.ano;
    return { camposPreenchidos, campoPendente: CAMPO_LABEL_POR_ETAPA[etapa] || null };
}

// ============================================================
// CLASSIFICADOR DE `indeterminado` — só roda quando o extrator determinístico não
// reconheceu nenhum componente de data. Na etapa nasc_confirmacao, o vocabulário
// ganha confirmacao/negacao (MH-072 A.1 item 4) — sem isso, um typo em cima de "sim"
// (ex: "Issi") caía em ruido e reabria o fluxo do zero.
// ============================================================
async function classificarIndeterminado({ message, historicoConversa, etapa }) {
    const historicoTexto = formatarHistoricoConversa(historicoConversa);
    const naConfirmacao = etapa === 'nasc_confirmacao';

    const categoriaConfirmacao = naConfirmacao ? `
- confirmacao: o usuário está confirmando que a data lida de volta está certa, mesmo com erro de digitação ou de forma indireta. Ex: "Issi", "isso ai", "eh isso mesmo", "ta certo", "aham".
- negacao: o usuário está dizendo que a data lida de volta está ERRADA, sem dizer qual campo. Ex: "não, tá errado", "não é essa data", "errado".` : '';

    const systemPrompt = `Você é um classificador para a etapa de coleta de data de nascimento de um assistente de saúde via WhatsApp (a Nami).

A mensagem do usuário não foi reconhecida ${naConfirmacao ? 'como confirmação/negação explícita da data que acabou de ser lida de volta pra ele' : 'como um componente de data (dia, mês ou ano)'}. Classifique-a em UMA destas categorias:
${categoriaConfirmacao}
- recusa: o usuário não quer informar a data de nascimento, está incomodado com a pergunta, ou pede para pular/parar. Ex: "não quero dizer", "prefiro não falar", "chato isso", "não quero mais".
- duvida: o usuário pergunta o motivo da pergunta, questiona a necessidade, sem recusar diretamente. Ex: "pra que você precisa disso?", "por que isso importa?", "vocês vão usar pra quê?".
- nova_intencao: o usuário muda de assunto — quer fazer outra coisa (cadastrar remédio, tirar outra dúvida, etc.) em vez de responder. Ex: "na verdade quero cadastrar meu remédio agora", "esquece, me ajuda com outra coisa".
- saudacao: o usuário está apenas cumprimentando ou retomando a conversa, sem responder à pergunta e sem recusar. Ex: "oi", "olá", "bom dia", "tudo bem?", "voltei", "alô".
- ruido: a mensagem não se encaixa em nenhuma das anteriores — resposta confusa, incompreensível, fora de contexto, ou que simplesmente não é uma data válida.

CONVERSA RECENTE:
${historicoTexto}

MENSAGEM ATUAL: "${message}"

Responda APENAS com uma palavra: ${naConfirmacao ? 'confirmacao, negacao, ' : ''}recusa, duvida, nova_intencao, saudacao ou ruido. Sem pontuação, sem explicação.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        const validos = naConfirmacao
            ? ['confirmacao', 'negacao', 'recusa', 'duvida', 'nova_intencao', 'saudacao', 'ruido']
            : ['recusa', 'duvida', 'nova_intencao', 'saudacao', 'ruido'];
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
function buildSystemPrompt({ etapa, context, user, motivo, correcaoAplicada, dataFormatada, valorAceito, valorRejeitado, campo, campoZerado }) {
    const nome = firstNameOf(user);
    const mensagemInicial = context.mensagem_inicial || '';
    const { camposPreenchidos, campoPendente } = estadoContexto(context, etapa);

    // Bloco de estado (MH-072 A.1 itens 1+2) — injetado em TODA etapa via `base`, pra
    // fechar a divergência entre o que o sistema sabe e o que a LLM diz (princípio 24).
    const estadoTexto = `

ESTADO ATUAL (única fonte de verdade — nunca contradiga isto, nunca invente valor fora daqui):
- Campos já confirmados: ${Object.keys(camposPreenchidos).length ? JSON.stringify(camposPreenchidos) : 'nenhum ainda'}
- Campo pendente agora: ${campoPendente || 'nenhum'}${valorAceito ? `
- Acabou de aceitar nesse turno: ${valorAceito.campo} = ${valorAceito.valor}. Reconheça isso antes de pedir o próximo campo — NUNCA trate como tentativa errada.` : ''}${valorRejeitado ? `
- Valor rejeitado nesse turno: "${valorRejeitado.valor}" (motivo: ${valorRejeitado.motivo}). NUNCA proponha, sugira ou confirme esse valor — peça de novo.` : ''}${campoZerado ? `
- O campo "${campoZerado}" foi APAGADO a pedido da pessoa e NÃO EXISTE MAIS no sistema. Não confirme, não repita e não sugira nenhum valor para ele — nem que a pessoa o tenha mencionado antes nesta própria mensagem. Peça o valor novo. Os demais campos seguem válidos e não devem ser perguntados de novo.` : ''}

Regras obrigatórias, válidas em TODA etapa deste fluxo:
1. Nunca proponha, sugira ou confirme um valor que não esteja em "Campos já confirmados" acima. Se a resposta do usuário for inválida, peça de novo — não adivinhe o que ele quis dizer.
2. Nunca trate como erro do usuário um valor que acabou de ser aceito (ver "Acabou de aceitar" acima, quando presente).
3. O exemplo de formato na pergunta deve corresponder exatamente ao campo pendente — nunca misture com exemplo de data completa (DD/MM/AAAA) quando só um campo isolado foi pedido.
4. Nunca insista, negocie ou minimize desconforto do usuário. Proibido: "só mais uma", "é rapidinho", "prometo que é a última", "é só uma informação", "não vai demorar", ou qualquer promessa de brevidade. Se a pessoa demonstrar desconforto, acolha e ofereça a saída — nunca tente convencer.`;

    const base = `Você é a Nami, uma assistente de saúde pessoal que ajuda pessoas a não esquecerem seus medicamentos de uso contínuo.

Você está coletando a data de nascimento de ${nome} durante o onboarding, logo depois do aceite da LGPD. A finalidade é só conhecer a idade média do público da Nami (estatística agregada) — não há personalização por idade.

Seu tom é: acolhedor, caloroso, humano, responsável e confiável. Use linguagem natural e próxima, não robótica. Use emojis com moderação.

Responda APENAS com a mensagem que deve ser enviada ao usuário. Sem explicações, sem prefixos, sem aspas.${estadoTexto}`;

    const correcaoTexto = correcaoAplicada
        ? `\n\nO usuário acabou de CORRIGIR o campo "${correcaoAplicada.campo}" para ${correcaoAplicada.valor}. Comece reconhecendo a correção brevemente (ex: "Corrigi para ...!"), sem se desculpar de forma exagerada.`
        : '';

    // Saudação (item 3, A.2) — usuário só cumprimentou ou retomou a conversa, sem
    // responder nem recusar. Reconhece brevemente e repete a pergunta pendente, sem
    // consumir tentativa (ver invariante do contador no handler).
    const saudacaoTexto = motivo === 'saudacao'
        ? `\n\n${nome} só te cumprimentou ou retomou a conversa (ex: "oi", "voltei") — não respondeu à pergunta ainda e não recusou nada. Reconheça a saudação de forma breve e calorosa, e então repita a pergunta pendente normalmente.`
        : '';

    if (etapa === 'nasc_dia') {
        if (motivo === 'combinacao_invalida') {
            return `${base}${correcaoTexto}

A combinação de dia/mês/ano que ${nome} informou não existe no calendário (ex: 31 de fevereiro). Explique gentilmente que a data não bate e peça o *DIA* de novo (negrito do WhatsApp — um asterisco de cada lado da palavra), com exemplo obrigatório de formato.
Exemplo de tom: "Acho que essa data não existe no calendário! 😅 Vamos conferir de novo — em que *dia* do mês você nasceu? Por exemplo: 7"`;
        }
        return `${base}${correcaoTexto}${saudacaoTexto}

Pergunte em que *DIA* do mês ${nome} nasceu, com negrito do WhatsApp (um asterisco de cada lado) na palavra "dia". O exemplo de formato é OBRIGATÓRIO na pergunta.
Exemplo: "Em que *dia* do mês você nasceu? Pode mandar só o número — por exemplo: 7"`;
    }

    if (etapa === 'nasc_mes') {
        return `${base}${correcaoTexto}${saudacaoTexto}

Pergunte de qual *MÊS* ${nome} nasceu, com negrito do WhatsApp (um asterisco de cada lado) na palavra "mês". O exemplo de formato é OBRIGATÓRIO na pergunta.
Exemplo: "E de qual *mês*? Pode escrever o nome — por exemplo: março"`;
    }

    if (etapa === 'nasc_ano') {
        return `${base}${correcaoTexto}${saudacaoTexto}

Pergunte em que *ANO* ${nome} nasceu, com negrito do WhatsApp (um asterisco de cada lado) na palavra "ano". O exemplo de formato é OBRIGATÓRIO na pergunta.
Exemplo: "E em que *ano*? Os quatro números — por exemplo: 1958"`;
    }

    if (etapa === 'nasc_confirmacao') {
        return `${base}${correcaoTexto}${saudacaoTexto}

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

    if (etapa === 'nasc_negacao') {
        if (motivo === 'repetir') {
            return `${base}

${nome} ainda não deixou claro qual parte da data está errada. Pergunte de novo, de forma simples, qual campo: dia, mês ou ano.
Exemplo: "Não entendi bem — é o dia, o mês ou o ano que está errado?"`;
        }
        return `${base}

${nome} disse que a data lida de volta está errada, mas não especificou qual parte. Pergunte de forma simples e curta qual campo está errado: dia, mês ou ano.
Exemplo: "Poxa, desculpa! O que ficou errado — o dia, o mês ou o ano?"`;
    }

    if (etapa === 'nasc_ruido') {
        if (motivo === 'confirmacao_nao_entendida') {
            return `${base}

A última resposta de ${nome} não deu pra entender como confirmação da data. A data montada é EXATAMENTE: ${dataFormatada}. Releia essa data pra ${nome} de forma natural e peça confirmação de novo, sem reabrir nenhum campo.
Exemplo: "Não entendi direito — só confirmando: você nasceu em ${dataFormatada}?"`;
        }
        return `${base}

A última resposta de ${nome} não deu pra entender como resposta à pergunta sobre a data de nascimento (campo pendente: ${campo}). Repita a pergunta dessa etapa com o exemplo de formato, de forma gentil, sem soar repetitiva ou impaciente.`;
    }

    if (etapa === 'nasc_limite_tentativas') {
        return `${base}

Não foi possível entender a data de nascimento de ${nome} depois de algumas tentativas. Informe de forma leve que vamos seguir sem essa informação por agora — sem cobrar, sem culpar ${nome} — e retome com naturalidade o que ${nome} pediu originalmente antes do onboarding.

MENSAGEM ORIGINAL DE ${nome}: "${mensagemInicial}"

Se a mensagem original indicar pedido de cadastro de remédio, siga para isso, citando o remédio mencionado. Caso contrário, pergunte por onde ${nome} quer começar.
Exemplo (quando a msg original foi "quero cadastrar losartana"):
"Sem problemas, ${nome}! Vamos seguir sem essa informação por agora 🌿 Voltando ao que você me pediu — cadastrar a losartana. Qual a dosagem?"`;
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
// FECHAMENTO DO FLUXO — reproduz a decisão de roteamento que antes vivia em
// recepcionista.js, agora com chamador único (definirEstadoPosOnboarding).
// motivo distingue o TOM do fechamento: 'recusa' (usuário declarou que não quer)
// vs. 'limite_tentativas' (MH-072 A.1 item 6 — 3 tentativas de ruído, a Nami pula
// por conta própria, sem perguntar, sem tratar como recusa do usuário).
// ============================================================

async function fecharSemDado({ user, context, message, motivo = 'recusa' }) {
    const etapa = motivo === 'limite_tentativas' ? 'nasc_limite_tentativas' : 'nasc_recusa';
    const resposta = await gerarTexto({ etapa, context, user, message });
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
        return await gerarTexto({ etapa: proxima, context: novoContext, user, message, motivo: 'avanco', valorAceito: { campo, valor } });
    }

    // Campo "futuro" (ainda não previsto pela etapa atual): preenche, permanece
    // na etapa atual e repete a pergunta (seção 6.2 do briefing original da Parte A).
    novoContext.etapa = etapaAtual;
    await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
    return await gerarTexto({ etapa: etapaAtual, context: novoContext, user, message, motivo: 'campo_futuro', valorAceito: { campo, valor } });
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleDataNascimento({ user, message, state, historicoConversa = [] }) {
    const context = state?.context || {};
    const etapa = context.etapa || 'nasc_dia';

    // Saída de emergência já oferecida (dúvida com oferta ativa) — aceite explícito.
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

    // Resolução da pergunta "o que está errado?" depois de uma negação em
    // nasc_confirmacao (MH-072 A.1 item 4, refinado no item 1 da A.2) — reabre SÓ o
    // campo indicado, nunca os três. Se a mensagem já traz campo + valor juntos (ex:
    // "o correto e dia 10"), aplica direto em vez de descartar o valor e repreguntar
    // — sem isso a Nami zera o campo, repergunta, e ainda inventa uma confirmação em
    // cima do valor que acabou de jogar fora (mesma família do item 1 da A.1).
    if (etapa === 'nasc_negacao') {
        const msgNorm = (message || '').toLowerCase();
        const campoErrado = /\bdia\b/.test(msgNorm) ? 'dia'
            : /\bm[eê]s\b/.test(msgNorm) ? 'mes'
            : /\bano\b/.test(msgNorm) ? 'ano'
            : null;

        if (campoErrado) {
            const extracaoValor = extrairComponenteData(message, campoErrado);

            if (extracaoValor.tipo === campoErrado) {
                // Caso A: campo + valor na mesma mensagem — corrige direto, sem zerar.
                console.log(`🎂 [DATA-NASCIMENTO] Negação com valor — corrigindo ${campoErrado}=${extracaoValor.valor} direto — ${user.phone}`);
                const etapaCampo = { dia: 'nasc_dia', mes: 'nasc_mes', ano: 'nasc_ano' }[campoErrado];
                return await aplicarPreenchimento({
                    user, message, context, etapaAtual: etapaCampo,
                    campo: campoErrado, valor: extracaoValor.valor, foiCorrecao: true
                });
            }

            // Caso B: só o nome do campo, sem valor novo — zera e repergunta,
            // avisando o gerador que esse campo específico foi apagado (item 2, A.2).
            console.log(`🎂 [DATA-NASCIMENTO] Negação sem valor — reabrindo ${campoErrado} — ${user.phone}`);
            const proximaEtapa = { dia: 'nasc_dia', mes: 'nasc_mes', ano: 'nasc_ano' }[campoErrado];
            const novoContext = { ...context, [campoErrado]: null, etapa: proximaEtapa, tentativas_indeterminado: 0 };
            await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
            return await gerarTexto({ etapa: proximaEtapa, context: novoContext, user, message, campoZerado: campoErrado });
        }

        // Caso C: não esclareceu qual campo está errado — repete a pergunta.
        console.log(`🎂 [DATA-NASCIMENTO] Resposta não esclareceu qual campo está errado — repetindo — ${user.phone}`);
        return await gerarTexto({ etapa: 'nasc_negacao', context, user, message, motivo: 'repetir' });
    }

    const campoEsperado = CAMPO_ESPERADO_POR_ETAPA[etapa] || 'dia';
    const extracao = extrairComponenteData(message, campoEsperado);

    if (extracao.tipo === 'indeterminado') {
        const classificacao = await classificarIndeterminado({ message, historicoConversa, etapa });

        if (classificacao === 'confirmacao') {
            console.log(`🎂 [DATA-NASCIMENTO] Confirmação reconhecida via classificador — ${user.phone}`);
            return await gravarEFechar({ user, context, message });
        }

        if (classificacao === 'negacao') {
            console.log(`🎂 [DATA-NASCIMENTO] Negação na confirmação — perguntando qual campo está errado — ${user.phone}`);
            const novoContext = { ...context, etapa: 'nasc_negacao', tentativas_indeterminado: 0 };
            await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
            return await gerarTexto({ etapa: 'nasc_negacao', context: novoContext, user, message });
        }

        if (classificacao === 'recusa') {
            console.log(`🎂 [DATA-NASCIMENTO] Recusa — ${user.phone}`);
            return await fecharSemDado({ user, context, message });
        }

        if (classificacao === 'nova_intencao') {
            console.log(`🎂 [DATA-NASCIMENTO] Nova intenção — escalando ao roteador — ${user.phone}`);
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return { escalarParaRoteador: true };
        }

        if (classificacao === 'saudacao') {
            // Item 3, A.2: cumprimento/retomada de conversa não é tentativa fracassada
            // de responder — não toca tentativas_indeterminado, só repete a pergunta
            // pendente reconhecendo a saudação.
            console.log(`🎂 [DATA-NASCIMENTO] Saudação — não consome tentativa — ${user.phone}`);
            if (etapa === 'nasc_confirmacao') {
                return await gerarTexto({
                    etapa: 'nasc_confirmacao', context, user, message, motivo: 'saudacao',
                    dataFormatada: formatarDataBR(context.dia, context.mes, context.ano)
                });
            }
            return await gerarTexto({ etapa, context, user, message, motivo: 'saudacao' });
        }

        if (classificacao === 'duvida') {
            // Dúvida sempre oferece a saída explícita nessa mesma mensagem (item 5) —
            // reafirmação de recusa no turno seguinte fecha por fecharSemDado, pelo
            // mesmo mecanismo de oferta_pular_ativa usado pela saída de emergência.
            const novoContext = { ...context, oferta_pular_ativa: true };
            await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });
            return await gerarTexto({ etapa: 'nasc_duvida', context: novoContext, user, message, motivo: 'duvida' });
        }

        // ruido — o ÚNICO ramo que consome tentativa. Confirmação, negação, recusa,
        // dúvida, nova_intencao e saudação retornam antes e nunca tocam o contador:
        // uma pessoa que diz claramente que não quer informar não está errando, está
        // decidindo — e um "oi" é retomada de conversa, não tentativa fracassada
        // (invariante, MH-072 A.1 item 7 + A.2 item 3 — não "unificar" este ramo com
        // os anteriores numa refatoração futura).
        const tentativas = (context.tentativas_indeterminado || 0) + 1;

        // Item 6: ao atingir o limite, PULA automaticamente — não oferece mais (decisão
        // de produto: perguntar "quer pular?" depois de 3 tentativas só empurra fricção).
        if (tentativas >= MAX_TENTATIVAS_INDETERMINADO) {
            console.log(`🎂 [DATA-NASCIMENTO] ${tentativas}ª tentativa de ruído — pulando automaticamente — ${user.phone}`);
            return await fecharSemDado({
                user, context: { ...context, tentativas_indeterminado: tentativas }, message,
                motivo: 'limite_tentativas'
            });
        }

        const novoContext = { ...context, tentativas_indeterminado: tentativas, oferta_pular_ativa: false };
        await saveConversationState(user.id, { state: 'coletando_nascimento', context: novoContext });

        // Item 3: nasc_confirmacao tem ramo próprio — relê a data montada em vez de
        // repetir a pergunta de um campo dia/mês/ano (essa etapa não é nenhum deles).
        if (etapa === 'nasc_confirmacao') {
            return await gerarTexto({
                etapa: 'nasc_ruido', context: novoContext, user, message,
                motivo: 'confirmacao_nao_entendida',
                dataFormatada: formatarDataBR(context.dia, context.mes, context.ano)
            });
        }

        let campoRuido = CAMPO_LABEL_POR_ETAPA[etapa];
        if (!campoRuido) {
            // Defensivo (alinhado ao MH-064): etapa fora do mapa é bug, não degradação
            // silenciosa — loga em system_events e segue com um fallback razoável,
            // nunca trava o usuário (MH-072 A.1 item 3).
            campoRuido = await degradar({
                origem: 'data_nascimento',
                motivo: 'etapa_ruido_nao_reconhecida',
                agent: 'data_nascimento',
                userId: user.id,
                detalhe: { etapa },
                fallback: 'dia'
            });
        }

        const anoRejeitado = campoEsperado === 'ano' ? detectarAnoDoisDigitosRejeitado(message) : null;
        const valorRejeitado = anoRejeitado ? { valor: anoRejeitado, motivo: 'ano precisa de 4 dígitos' } : null;

        return await gerarTexto({
            etapa: 'nasc_ruido', context: novoContext, user, message,
            motivo: 'repetir', campo: campoRuido, valorRejeitado
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
