// ============================================================
// SCHEMA DO ONBOARDING (v44 M4 — briefing §1)
//
// Três campos no MESMO runner: nome (have-to-have), consentimento
// LGPD (PORTÃO — §2: nenhum dado pessoal declarado é persistido
// antes do aceite identificado) e data de nascimento (OPCIONAL,
// decisão 21/09 — nunca trava o usuário).
//
// A DECISÃO é determinística (classificadores + código); o TEXTO de
// coleta é renderizado em código sob a Constituição + emendas
// (mesmo padrão do schema do cadastro, MH-85/P54). A única geração
// por LLM é a apresentação da porta "descobrir" e respostas a
// perguntas abertas sobre a Nami — código não responde pergunta
// livre.
//
// O ponto ÚNICO de escrita de dados pessoais é
// montarPersistenciaOnboarding, que RECUSA sem consentimento —
// guarda determinística testada no A0 (sem LLM).
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { classificarComFerramenta } from '../validadores/llm.js';
import { formatarHistoricoConversa } from '../database.js';
import { degradar } from '../observabilidade.js';
import { GUIA_COMPOSICAO } from '../templates/composicao.js';
import { nomeUsuarioAceitavel } from './perfil.js';
import { extrairComponenteData, montarDataNascimento } from '../dataNascimento.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ------------------------------------------------------------
// SCHEMA — ordem canônica mantida: nome → LGPD → nascimento (§1).
// ------------------------------------------------------------

export const SCHEMA_ONBOARDING = {
    nome: 'onboarding',
    estadoConversa: 'onboarding',
    campos: [
        {
            nome: 'nome',
            nivel: 'have_to_have',
            faltando: c => !c?.nome_coletado,
            etapa: () => 'onb_nome'
        },
        {
            nome: 'consentimento_lgpd',
            nivel: 'portao',
            faltando: c => c?.consentimento_lgpd !== true,
            etapa: () => 'onb_lgpd'
        },
        {
            nome: 'data_nascimento',
            nivel: 'opcional',
            faltando: c => !c?.data_nascimento && !c?.nascimento_encerrado,
            etapa: () => 'onb_nascimento'
        }
    ]
};

// ------------------------------------------------------------
// GUARDA LGPD — ponto único de montagem da escrita em `users`.
// Nenhum caminho de código grava dado pessoal declarado com
// consentimento ausente: sem aceite identificado, LANÇA (A0, §2.5).
// ------------------------------------------------------------

export function montarPersistenciaOnboarding(campos) {
    if (campos?.consentimento_lgpd !== true) {
        throw new Error('Guarda LGPD: persistência de dados pessoais sem consentimento identificado');
    }
    return {
        name: campos.nome_coletado || null,
        onboarded: true,
        lgpd_accepted: true,
        lgpd_accepted_at: campos.lgpd_aceito_em || new Date().toISOString(),
        ...(campos.data_nascimento ? { data_nascimento: campos.data_nascimento } : {})
    };
}

// ------------------------------------------------------------
// DETECÇÕES DETERMINÍSTICAS
// ------------------------------------------------------------

function contemPalavraLivre(texto, palavra) {
    if (palavra.includes(' ')) return texto.includes(palavra);
    return new RegExp(`(^|\\s)${palavra}(\\s|$|[.,!?])`).test(texto);
}

// Spec "é para outra pessoa" (A18) — migrada intacta do recepcionista (§4).
const RE_OUTRA_PESSOA = /\b(?:pra|para)\s+(?:uma?\s+)?outra\s+pessoa\b|\b(?:é|e|ser[iá]a?)?\s*(?:pra|para)\s+(?:o\s+|a\s+)?(?:minha?|meu)\s+(?:m[ãa]e|pai|filh[oa]|esposa|marido|mulher|av[óôo]|v[óôo]|irm[ãa][oa]?|tia|tio|sogr[oa])\b|\bn[ãa]o [ée] pra mim\b/i;

export function ehParaOutraPessoa(message) {
    return RE_OUTRA_PESSOA.test(String(message || ''));
}

// Aceite pós-convite (retomada de quem tinha declinado) — lista fechada.
export function ehAfirmativoOnboarding(message) {
    const msg = String(message || '').toLowerCase().trim();
    return ['sim', 's', 'quero', 'bora', 'vamos', 'pode ser', 'pode', 'claro', 'ok', 'como faço', 'como faco']
        .some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ','));
}

// ------------------------------------------------------------
// DETECÇÃO DE CONSENTIMENTO (§2.3): lista determinística de termos
// primeiro; classificador tool-use só para formas livres. O aceite
// por termo vale também no MEIO de um dump ("nome + telefone + data
// + sim"), desde que sem negação por perto; na dúvida, o chamador
// REPEDE o consentimento — nunca assume.
// ------------------------------------------------------------

const TERMOS_ACEITE_LGPD = ['sim', 'concordo', 'aceito', 'autorizo', 'de acordo', 'pode guardar', 'com certeza', 'claro'];
const TERMOS_ACEITE_EXATOS = ['ok', 'pode', 'tudo bem', 'beleza', 'pode ser', 'uhum', 'aham', 's'];
const TERMOS_RECUSA_LGPD = [
    'não quero', 'nao quero', 'prefiro não', 'prefiro nao', 'não concordo', 'nao concordo',
    'não aceito', 'nao aceito', 'não autorizo', 'nao autorizo', 'agora não', 'agora nao',
    'deixa pra lá', 'deixa pra la'
];

export function detectarConsentimentoDeterministico(message) {
    const msg = String(message || '').toLowerCase().trim();
    if (!msg) return null;
    if (['não', 'nao', 'não.', 'nao.', 'não!', 'nao!'].includes(msg)) return 'recusa';
    if (TERMOS_RECUSA_LGPD.some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ',') || msg.startsWith(t + '.'))) {
        return 'recusa';
    }
    // BUG-88 vive como guarda: nenhuma checagem por substring solta — termo
    // exato ou com fronteira de palavra, e negação presente anula o aceite.
    if (/\b(n[ãa]o|nunca|nem)\b/.test(msg)) return null;
    if (TERMOS_ACEITE_EXATOS.some(t => msg === t || msg === t + '!' || msg === t + '.')) return 'aceite';
    if (TERMOS_ACEITE_LGPD.some(t => contemPalavraLivre(msg, t))) return 'aceite';
    return null;
}

// ------------------------------------------------------------
// ABSORÇÃO DETERMINÍSTICA DO RASCUNHO (§2.1/§2.2): data de nascimento
// e telefone ditos em QUALQUER ponto do onboarding são reconhecidos —
// a data vai ao rascunho (nunca ao banco antes do aceite) e NUNCA é
// reperguntada; o telefone é reconhecido (já é o número da conversa).
// ------------------------------------------------------------

const RE_SUGERE_CADASTRO = new RegExp([
    '\\b(?:rem[ée]dios?|medicamentos?|cadastr\\w*|tom(?:o|ar|ando)|comprimidos?|c[áa]psulas?|gotas?|xarope|col[íi]rio|pomada|inje[çc]\\w*|vitaminas?|dosagem|posologia)\\b',
    '\\d\\s*(?:mg|mcg|ml)\\b',
    '\\b\\d{1,2}\\s*(?:h|hs|hrs|horas)\\b',
    '\\b\\d{1,2}:\\d{2}\\b'
].join('|'), 'i');

export function sugereCadastroDeMedicamento(message) {
    return RE_SUGERE_CADASTRO.test(String(message || ''));
}

// Preenche campos.data_nascimento (rascunho) quando a mensagem traz uma data
// completa válida. Data dentro de mensagem de medicamento não é nascimento.
export function absorverDataNascimento(campos, message) {
    if (campos.data_nascimento || !/\d/.test(String(message || ''))) return null;
    if (sugereCadastroDeMedicamento(message)) return null;
    const componente = extrairComponenteData(message, 'dia');
    if (componente.tipo !== 'data_completa') return null;
    const montagem = montarDataNascimento(componente.valor);
    if (!montagem.valida) return { invalida: true };
    campos.data_nascimento = montagem.iso;
    const { dia, mes, ano } = componente.valor;
    console.log(`🎂 [ONBOARDING] Data de nascimento absorvida no rascunho — nunca será reperguntada`);
    return { dataBR: `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}` };
}

// Recusa/pulo do dado OPCIONAL (data de nascimento) — lista determinística:
// a porta de saída oferecida na própria pergunta se aceita sem custo de LLM.
const TERMOS_RECUSA_DADO = [
    'prefiro não', 'prefiro nao', 'não quero', 'nao quero', 'não vou informar', 'nao vou informar',
    'não vou passar', 'nao vou passar', 'pular', 'pula', 'passo', 'depois eu', 'deixa pra depois',
    'sem a data', 'segue sem', 'melhor não', 'melhor nao'
];

export function ehRecusaDeDado(message) {
    const msg = String(message || '').toLowerCase().trim();
    if (['não', 'nao', 'não.', 'nao.', 'não, obrigado', 'nao, obrigado', 'não, obrigada', 'nao, obrigada'].includes(msg)) return true;
    return TERMOS_RECUSA_DADO.some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ',') || msg.startsWith(t + '.'));
}

// Telefone no dump: reconhecido (é o mesmo número da conversa), nunca pedido.
export function reconheceTelefone(message) {
    const semDatas = String(message || '').replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:\d{2}|\d{4})\b/g, ' ');
    return /(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}/.test(semDatas);
}

// ------------------------------------------------------------
// CLASSIFICADORES (tool-use pelo ponto único do P6.2) — decidem
// CATEGORIA; o texto do comportamento correspondente é template.
// ------------------------------------------------------------

// Intenção da PRIMEIRA mensagem (duas portas da v43 preservadas — §5):
// cadastrar/neutro pedem o nome direto; descobrir passa pela apresentação.
export async function classificarIntencaoInicial({ message }) {
    const systemPrompt = `Você é um classificador de intenção inicial para uma assistente de saúde via WhatsApp (a Nami), que ajuda pessoas a não esquecerem seus medicamentos de uso contínuo.

Esta é a PRIMEIRA mensagem que a pessoa envia. Classifique-a em UMA destas categorias:

- cadastrar: pedido ativo de uso. Ex: "quero cadastrar meu remédio", "me ajuda com a losartana", "preciso tomar nimesulida de 12 em 12h".
- descobrir: curiosidade sobre o que a Nami é ou faz, SEM pedido de uso. Ex: "pra que você serve?", "o que você faz?", "você serve pra cadastrar remédio?", "você consegue me ajudar com lembretes?", "me mandaram esse número", "quero conhecer a Nami".
- neutro: saudação ou mensagem sem intenção discernível. Ex: "oi", "bom dia", "tudo bem?".

Fronteira importante: "você serve pra X?" é descobrir (pergunta sobre capacidade, especulação). "quero X" é cadastrar (pedido de uso).

MENSAGEM: "${message}"`;

    const { parsed } = await classificarComFerramenta({
        systemPrompt, message, maxTokens: 50,
        schema: {
            type: 'object',
            properties: { categoria: { type: 'string', enum: ['cadastrar', 'descobrir', 'neutro'] } },
            required: ['categoria']
        },
        motivo: 'classificador_intencao_inicial_falhou',
        agent: 'onboarding', origem: 'onboarding',
        fallback: { categoria: 'neutro' }
    });
    const categoria = parsed?.categoria || 'neutro';
    console.log(`👋 [ONBOARDING] Intenção inicial: "${String(message).slice(0, 60)}" -> ${categoria}`);
    return categoria;
}

// Coleta de nome (BUG-30): categoria semântica + valor normalizado. As guardas
// do A26 (nomeUsuarioAceitavel — plausibilidade + vetos de palavras-de-pedido)
// valem SEMPRE sobre o valor devolvido (§1).
export async function classificarNomeOnboarding({ message, historicoConversa = [] }) {
    const systemPrompt = `Você é um classificador para a etapa de coleta de nome no onboarding de uma assistente de saúde via WhatsApp (a Nami).

A Nami acabou de perguntar "como posso te chamar?". Classifique a resposta em UMA destas categorias:

- nome: a pessoa disse como quer ser chamada. Ex: "Guilherme", "pode me chamar de Gui", "meu nome é Ana Paula", "Ana".
- saudacao: a pessoa só cumprimentou, sem dizer o nome. Ex: "oi", "olá", "bom dia", "tudo bem?".
- contexto_saude: a pessoa mencionou um remédio, dosagem, posologia ou situação de saúde em vez do nome. Ex: "tomo losartana 50mg", "preciso de nimesulida de 12 em 12h".
- pergunta: a pessoa fez uma pergunta em vez de responder. Ex: "por que você precisa disso?", "pra que serve isso?", "quanto custa?".
- recusa: a pessoa não quer dizer o nome, ou declinou de continuar. Ex: "não quero dizer", "prefiro não falar", "não vou usar", "obrigado, mas não".
- indeterminado: a resposta não se encaixa em nenhuma categoria acima — confusa ou fora de contexto.

Quando a categoria for "nome", registre também o nome NORMALIZADO que a pessoa quer usar — nunca a frase inteira. Ex: "pode me chamar de gui" -> "Gui". "meu nome é guilherme silveira" -> "Guilherme Silveira".

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"`;

    const { parsed } = await classificarComFerramenta({
        systemPrompt, message, maxTokens: 100,
        schema: {
            type: 'object',
            properties: {
                categoria: { type: 'string', enum: ['nome', 'saudacao', 'contexto_saude', 'pergunta', 'recusa', 'indeterminado'] },
                nome: { type: ['string', 'null'], description: 'O nome normalizado, apenas quando categoria=nome.' }
            },
            required: ['categoria']
        },
        motivo: 'classificador_nome_falhou',
        agent: 'onboarding', origem: 'onboarding',
        fallback: { categoria: 'indeterminado', nome: null }
    });

    const categoria = parsed?.categoria || 'indeterminado';
    if (categoria === 'nome') {
        const valor = String(parsed?.nome || '').trim();
        if (valor && nomeUsuarioAceitavel(valor)) {
            console.log(`👋 [ONBOARDING] Classificador de nome: "${String(message).slice(0, 60)}" -> nome: "${valor}"`);
            return { tipo: 'nome', valor };
        }
        console.log(`👋 [ONBOARDING] Nome vetado pelas guardas do A26 ("${valor}") — indeterminado`);
        return { tipo: 'indeterminado', valor: null };
    }
    console.log(`👋 [ONBOARDING] Classificador de nome: "${String(message).slice(0, 60)}" -> ${categoria}`);
    return { tipo: categoria, valor: null };
}

// Consentimento LGPD — classificador para formas livres (§2.3). NUNCA aceite
// em falha (BUG-88): fallback é indeterminado, e indeterminado REPEDE.
export async function classificarConsentimentoLgpd({ message, historicoConversa = [] }) {
    const systemPrompt = `Você é um classificador de consentimento LGPD para uma assistente de saúde via WhatsApp (a Nami).

A Nami acabou de pedir consentimento para guardar nome, telefone e data de nascimento do usuário. Classifique a resposta dele em UMA destas categorias:

- aceite: o usuário concorda de forma inequívoca com a guarda dos dados. Ex: "sim", "pode", "concordo", "aceito", "tudo bem", "claro", "ok", "sim, pode guardar".
- recusa: o usuário não concorda, ou adia. Ex: "não", "prefiro não passar os dados", "agora não", "deixa pra lá", "não quero compartilhar", "tô com receio disso".
- duvida: o usuário pergunta sobre o uso dos dados, sem aceitar nem recusar. Ex: "pra que vocês precisam disso?", "vocês vendem meus dados?", "quem vai ver isso?", "posso apagar depois?".
- indeterminado: a resposta não se encaixa em nenhuma categoria acima — confusa ou fora de contexto.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"`;

    const { parsed } = await classificarComFerramenta({
        systemPrompt, message, maxTokens: 50,
        schema: {
            type: 'object',
            properties: { categoria: { type: 'string', enum: ['aceite', 'recusa', 'duvida', 'indeterminado'] } },
            required: ['categoria']
        },
        motivo: 'classificador_lgpd_falhou',
        agent: 'onboarding', origem: 'onboarding',
        fallback: { categoria: 'indeterminado' }
    });
    const categoria = parsed?.categoria || 'indeterminado';
    console.log(`🔒 [ONBOARDING] Classificador LGPD: "${String(message).slice(0, 60)}" -> ${categoria}`);
    return categoria;
}

// Resposta que não é data na pergunta (opcional) de nascimento.
export async function classificarRespostaData({ message, historicoConversa = [] }) {
    const systemPrompt = `Você é um classificador para a pergunta de data de nascimento no onboarding de uma assistente de saúde via WhatsApp (a Nami). A pergunta é OPCIONAL e a Nami já ofereceu a saída ("se preferir não informar, é só me dizer").

A mensagem do usuário não foi reconhecida como uma data. Classifique-a em UMA destas categorias:

- recusa: o usuário não quer informar a data, pede para pular, ou aceita a saída oferecida. Ex: "não quero dizer", "prefiro não falar", "pula essa", "depois eu falo", "segue sem".
- duvida: o usuário pergunta o motivo da pergunta, sem recusar diretamente. Ex: "pra que você precisa disso?", "por que isso importa?".
- nova_intencao: o usuário muda de assunto — quer fazer outra coisa em vez de responder. Ex: "na verdade quero cadastrar meu remédio agora", "esquece, me ajuda com outra coisa".
- saudacao: o usuário está apenas cumprimentando ou retomando a conversa. Ex: "oi", "bom dia", "voltei".
- ruido: a mensagem não se encaixa em nenhuma das anteriores — confusa, incompreensível ou fora de contexto.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"`;

    const { parsed } = await classificarComFerramenta({
        systemPrompt, message, maxTokens: 50,
        schema: {
            type: 'object',
            properties: { categoria: { type: 'string', enum: ['recusa', 'duvida', 'nova_intencao', 'saudacao', 'ruido'] } },
            required: ['categoria']
        },
        motivo: 'classificador_resposta_data_falhou',
        agent: 'onboarding', origem: 'onboarding',
        fallback: { categoria: 'ruido' }
    });
    const categoria = parsed?.categoria || 'ruido';
    console.log(`🎂 [ONBOARDING] Classificador da resposta de data: "${String(message).slice(0, 60)}" -> ${categoria}`);
    return categoria;
}

// ------------------------------------------------------------
// GERAÇÃO ABERTA (única LLM de texto do onboarding): apresentação da
// porta "descobrir" e resposta a perguntas livres sobre a Nami — a
// decisão de fluxo já foi tomada em código antes desta chamada.
// ------------------------------------------------------------

const FALLBACK_APRESENTACAO = `Oi! 😊 Sou a Nami — eu te lembro dos seus remédios na hora certa, aqui mesmo no WhatsApp, sem precisar instalar nada.\n\nQuer começar? Me diz como posso te chamar.`;

export async function gerarApresentacao({ message, historicoConversa = [], mensagemInicial = '', motivo = 'primeira', rodadasDuvida = 0 }) {
    const blocoMotivo = motivo === 'nova_duvida' ? `
O usuário fez uma NOVA pergunta sobre a Nami, em vez de aceitar ou recusar o convite anterior. Responda a essa dúvida em uma ou duas frases objetivas e depois REOFEREÇA o convite, pedindo o nome junto — mais leve e mais curto do que da vez anterior (esta é a rodada ${rodadasDuvida || 1} de reoferta: quanto mais rodadas, mais leve e menos insistente deve soar).`
        : motivo === 'pergunta_no_nome' ? `
O usuário fez uma pergunta em vez de responder o nome. Responda a essa pergunta de forma breve e verdadeira e depois repita o pedido do nome, em uma única mensagem curta.`
        : `
Esta é a primeira resposta da Nami a alguém que chegou querendo entender o que ela faz. A pergunta está em "Mensagem original do usuário" abaixo.

Esta mensagem tem NO MÁXIMO 4 linhas curtas. É a porta de entrada de quem chega por QR code, cartaz ou indicação — cada linha a mais custa usuário.

Estrutura obrigatória, nesta ordem:
1. Responda ESPECIFICAMENTE o que a pessoa perguntou, citando-a. Se ela apenas disse que quer conhecer a Nami, apresente-se em uma frase.
2. Diga o que você faz em UMA frase: lembra dos remédios na hora certa, aqui no WhatsApp, sem instalar nada. NÃO liste capacidades em tópicos.
3. Convide a começar JÁ PEDINDO O NOME, em uma frase, sem pressão. Responder com o nome é o aceite.
   Exemplo: "Quer começar agora? Me diz como posso te chamar que a gente organiza seus remédios juntos 😊"`;

    const systemPrompt = `Você é a Nami, uma assistente de saúde pessoal que ajuda pessoas a não esquecerem seus medicamentos de uso contínuo. Você está no momento de boas-vindas com um novo usuário.

Seu tom é: acolhedor, caloroso, humano, responsável e confiável. Use linguagem natural e próxima, não robótica.
${GUIA_COMPOSICAO}
Mensagem original do usuário (primeira mensagem): ${mensagemInicial}

A decisão de FLUXO já foi tomada pelo código — você só redige o texto do comportamento abaixo.
${blocoMotivo}

REGRAS OBRIGATÓRIAS:
- NÃO mencione LGPD, dados ou consentimento neste momento.
- NÃO inicie cadastro de medicamento.
- NÃO mencione que está em desenvolvimento, em construção, aprendendo, em teste ou em evolução. NUNCA use a expressão "teste beta".
- Se a pessoa falar em usar para OUTRA PESSOA / um familiar: diga com honestidade que você ainda não acompanha o tratamento de outra pessoa — é algo que está chegando; NUNCA afirme essa capacidade; ofereça na mesma mensagem o caminho que já existe (a própria pessoa que toma pode usar a Nami no telefone dela — é só ela mandar um oi para este mesmo número); e retome pedindo o nome.
- Se perguntarem quem criou a Nami: foi o Guilherme Silveira, contato (11) 94106-5858 — pode contar sem rodeios, no mesmo tom caloroso.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

Responda APENAS com a mensagem que deve ser enviada ao usuário. Sem explicações, sem prefixos, sem aspas.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 512,
            system: systemPrompt,
            messages: [{ role: 'user', content: message || 'Olá' }]
        });
        return resposta.content[0].text.trim();
    } catch (e) {
        console.error(`❌ [ONBOARDING] Erro na geração da apresentação: ${e.message}`);
        return await degradar({
            origem: 'onboarding',
            motivo: 'apresentacao_falhou',
            agent: 'onboarding',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: FALLBACK_APRESENTACAO
        });
    }
}

// ------------------------------------------------------------
// TEXTOS DE COLETA — renderizados em código (§1), sob a Constituição
// (uma pergunta no fim; itens em linha própria com emoji; negrito de
// UM asterisco) e a copy da LGPD validada em produção (§5 — as
// asserções de forma do A7 seguram).
// ------------------------------------------------------------

function primeiroNome(nome) {
    return nome ? String(nome).split(' ')[0] : null;
}

export function renderizarBoasVindas({ intencao = 'neutro', medReconhecido = null }) {
    if (medReconhecido) {
        return `Oi! 😊 Vi que você já chegou me contando do *${medReconhecido}* — anotei aqui e já te ajudo a organizar ele.\n\nAntes, como posso te chamar?`;
    }
    if (intencao === 'cadastrar') {
        return `Oi! 😊 Vou te ajudar a organizar seus remédios, sim — anotei o seu pedido aqui.\n\nAntes de começarmos, como posso te chamar?`;
    }
    return `Oi! 😊 Sou a Nami — eu te lembro dos seus remédios na hora certa, aqui mesmo no WhatsApp, sem precisar instalar nada.\n\nComo posso te chamar?`;
}

export function renderizarPedidoNome({ motivo = null, medNoRascunho = null }) {
    if (motivo === 'contexto_saude') {
        const ack = medNoRascunho
            ? `Anotei o *${medNoRascunho}* aqui — já cuido dele com você em seguida. 💊`
            : `Anotei o que você me contou — já cuido disso com você em seguida. 💊`;
        return `${ack}\n\nAntes, como posso te chamar?`;
    }
    if (motivo === 'saudacao') return `Oi! 😊 E como posso te chamar?`;
    if (motivo === 'recusa') {
        return `Entendo! É só pra eu conseguir conversar com você do jeito certo — pode ser um primeiro nome, ou até um apelido. 😊\n\nComo posso te chamar?`;
    }
    if (motivo === 'pos_lgpd') return `Que bom que você topou! 😊\n\nComo posso te chamar?`;
    if (motivo === 'pos_convite') return `Que bom! 😊 Vamos começar então — como posso te chamar?`;
    return `Não entendi direito — como posso te chamar? Pode ser só o primeiro nome mesmo 😊`;
}

// Pedido de consentimento — especificação de conteúdo da copy em produção
// (v44 §5.8), agora template: abertura com o porquê; os TRÊS dados como itens
// de lista, cada um em linha própria aberta por emoji; frase de proteção;
// pergunta de consentimento sozinha na última linha.
export function renderizarPedidoConsentimento({ nomeColetado = null, dataJaInformada = false, medNoRascunho = null, reapresentacao = false }) {
    const first = primeiroNome(nomeColetado);
    const abertura = reapresentacao
        ? `Que bom que você reconsiderou! 😊 Pra continuar, preciso da sua autorização pra guardar estas informações:`
        : medNoRascunho
            ? `Prazer${first ? `, ${first}` : ''}! 😊 Pra eu cadastrar o *${medNoRascunho}* e personalizar seus lembretes, preciso guardar algumas informações suas:`
            : `Prazer${first ? `, ${first}` : ''}! 😊 Pra personalizar seus lembretes, preciso guardar algumas informações suas:`;

    const linhaNome = nomeColetado
        ? `✅ *nome* — já tenho aqui`
        : `🙋 *nome* — te pergunto em seguida`;
    const linhaData = dataJaInformada
        ? `📅 *data de nascimento* — você já me passou, deixo guardada`
        : `📅 *data de nascimento* — te peço em seguida, e é opcional`;

    return `${abertura}\n\n${linhaNome}\n☎️ *telefone* — o mesmo número desta conversa\n${linhaData}\n\nSeus dados ficam protegidos e são usados só pra isso — nunca vendidos nem compartilhados.\n\nVocê concorda?`;
}

// Dump sem aceite (§2.2): a resposta MOSTRA que entendeu os dados (listagem
// curta, cada item em linha própria com emoji) e repede SÓ o consentimento,
// gentil, com a pergunta sozinha na última linha. Nada ignorado, nada perdido.
export function renderizarReconhecimentoDump({ nomeColetado = null, dataBR = null, telefone = false, medNome = null }) {
    const first = primeiroNome(nomeColetado);
    const itens = [];
    if (dataBR) itens.push(`📅 *data de nascimento* — ${dataBR}, deixo anotada`);
    if (telefone) itens.push(`☎️ *telefone* — esse mesmo número`);
    if (medNome) itens.push(`💊 *${medNome}* — deixo pronto pra cadastrar em seguida`);
    return `Entendi tudo o que você me mandou${first ? `, ${first}` : ''}! 😊 Fica assim:\n\n${itens.join('\n')}\n\nSó me falta o seu consentimento pra eu poder guardar esses dados.\n\nVocê concorda?`;
}

export function renderizarDuvidaLgpd() {
    return `Boa pergunta! Seus dados são usados só pra personalizar os lembretes — nunca são vendidos nem compartilhados com ninguém, e você pode pedir pra apagar tudo quando quiser.\n\nPosso guardar seu nome, telefone e data de nascimento?`;
}

export function renderizarReperguntaLgpd() {
    return `Não consegui te entender direito 😊 Um "sim" ou "não" já resolve.\n\nPosso guardar seu nome, telefone e data de nascimento pra personalizar seus lembretes?`;
}

export function renderizarLgpdRecusada() {
    return `Tudo bem, respeito totalmente a sua decisão 🌿\n\nPela LGPD, sem o seu consentimento eu não posso guardar seus dados — e sem eles os lembretes não funcionam. Se mudar de ideia, é só mandar um oi que eu vou estar por aqui.`;
}

export function renderizarLgpdRetorno() {
    return `Que bom te ver por aqui de novo! 😊 Da última vez você preferiu não guardar seus dados — e tá tudo bem.\n\nMudou de ideia?`;
}

// Pedido gentil da data (OPCIONAL — §1): a porta de saída vem na própria
// mensagem; recusa/pulo completa o onboarding normalmente.
export function renderizarPedidoNascimento({ nomeColetado = null, repeticao = false }) {
    const first = primeiroNome(nomeColetado);
    const abertura = repeticao
        ? `A gente tinha parado na sua data de nascimento — e continua opcional, viu: se preferir não informar, é só me dizer que a gente segue.`
        : `Obrigada por confiar em mim${first ? `, ${first}` : ''}! 😊\n\nSó mais uma coisinha, e é opcional: se preferir não informar, é só me dizer que a gente segue direto.`;
    return `${abertura}\n\nQual a sua data de nascimento?\nPor exemplo: 06/11/1989`;
}

export function renderizarDataInvalidaOnboarding() {
    return `Acho que essa data não existe no calendário! 😅 E lembrando: se preferir não informar, é só me dizer.\n\nQual a sua data de nascimento?\nPor exemplo: 06/11/1989`;
}

export function renderizarDuvidaNascimento() {
    return `É só pra eu conhecer melhor quem usa a Nami — nada além disso. E é opcional: se preferir não informar, é só me dizer que a gente segue. 🌿\n\nQual a sua data de nascimento?`;
}

// Fechamento do onboarding — convite ao primeiro cadastro (sem rascunho).
export function renderizarConviteAoPrimeiroCadastro({ nomeColetado = null, semData = false }) {
    const first = primeiroNome(nomeColetado);
    const abertura = semData
        ? `Sem problema nenhum${first ? `, ${first}` : ''} — seguimos sem essa informação! 🌿`
        : `Prontinho${first ? `, ${first}` : ''}, tudo guardado! 📝`;
    return `${abertura}\n\nAgora me conta: qual remédio você quer cadastrar? Pode mandar tudo de uma vez — o nome, quanto você toma por vez e os horários.\nPor exemplo: Losartana 50mg, 1 comprimido, 8h e 20h`;
}

// Fechamento curto — usado quando o cadastro semeado continua no MESMO turno.
export function renderizarFechamentoCurto({ nomeColetado = null, semData = false }) {
    const first = primeiroNome(nomeColetado);
    return semData
        ? `Sem problema nenhum${first ? `, ${first}` : ''} — seguimos sem essa informação! 🌿 Agora vamos ao que você me pediu.`
        : `Prontinho${first ? `, ${first}` : ''}, tudo guardado! 📝 Agora vamos ao que você me pediu.`;
}

// "É para outra pessoa" (A18): honestidade + expectativa + caminho real de
// hoje + retomada — e o fechamento curto quando a pessoa agradece/encerra
// (regra 6 do guia: nunca reexplicar o turno anterior).
export function renderizarOutraPessoa() {
    return `Que bom que você quer cuidar de alguém! 🌿 Hoje eu ainda não acompanho o tratamento de outra pessoa por você — é algo que está chegando.\n\nO que já dá pra fazer: a própria pessoa que toma o remédio pode usar a Nami no telefone dela — é só ela mandar um oi pra este mesmo número.\n\nE se você quiser usar pra você também, me diz: como posso te chamar?`;
}

export function renderizarFechamentoOutraPessoa() {
    return `Entendo perfeitamente! 😊 Fico feliz que você tenha vindo atrás de quem cuida. Qualquer coisa, é só mandar um oi por aqui.`;
}

export function renderizarDespedida({ motivo = 'declinado' }) {
    if (motivo === 'limite_tentativas') {
        return `Acho que a gente não se entendeu dessa vez — tudo bem! 🌿 Quando quiser tentar de novo, é só mandar um oi que eu vou estar por aqui.`;
    }
    return `Tudo bem! 🌿 Fico por aqui — quando quiser começar, é só mandar um oi.`;
}

export function renderizarPortaAberta() {
    return `Oi! Que bom te ver por aqui de novo 😊 Sem pressa nenhuma — quando quiser começar, é só me dizer como posso te chamar.`;
}
