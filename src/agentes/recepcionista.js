import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState, updateUser } from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// KEYWORDS DE ACEITE / RECUSA LGPD
// ============================================================

const LGPD_ACCEPT_KEYWORDS = ['sim', 's', 'pode', 'concordo', 'aceito', 'ok', 'claro', 'com certeza', 'yes'];

function isLgpdAccepted(message) {
    const normalized = message.toLowerCase().trim();
    return LGPD_ACCEPT_KEYWORDS.some(kw => normalized.includes(kw));
}

function contemRecusa(message) {
    const msg = message.toLowerCase().trim();
    return ['não', 'nao', 'nope', 'recuso', 'não aceito', 'não concordo',
        'prefiro não', 'não quero'].some(t => msg.includes(t));
}

// ============================================================
// VALIDAÇÃO DE NOME
// ============================================================

function pareceNome(message) {
    if (!message) return false;
    const msg = message.toLowerCase().trim();

    // Sinais de que NÃO é um nome
    const sinaisDeRemedio = [
        /\d+\s*(mg|ml|mcg|g|%)/, // dosagem: "500mg", "0,5%"
        /\d+\s*\/\s*\d+\s*(h|hora|horas)/, // posologia: "12/12h", "8/8 horas"
        /de\s+\d+\s+em\s+\d+/, // "de 8 em 8 horas"
        /tomei|tomo|preciso tomar|remédio|remedio|medicamento|comprimido/,
        /nitroglicerina|nimesulida|losartana|metformina|atenolol|omeprazol|dipirona/
    ];

    return !sinaisDeRemedio.some(pattern =>
        typeof pattern === 'string'
            ? msg.includes(pattern)
            : pattern.test(msg)
    );
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(etapa, context) {
    const mensagemInicial = context.mensagem_inicial || '';
    const temContextoMedicamento = !!context.contexto_medicamento;

    return `Você é a Nami, uma assistente de saúde pessoal que ajuda pessoas a não esquecerem seus medicamentos de uso contínuo.

Você está no momento de boas-vindas com um novo usuário.

Seu tom é: acolhedor, caloroso, humano, responsável e confiável.
Use linguagem natural e próxima. Não seja robótica nem excessivamente formal.
Use emojis com moderação para tornar a conversa mais leve.

Etapa atual: ${etapa}
Contexto coletado até agora: ${JSON.stringify(context)}
Mensagem original do usuário (primeira mensagem): ${mensagemInicial}

---

CLASSIFICAÇÃO DE INTENÇÃO:

Antes de responder, classifique a mensagem_inicial em uma dessas categorias:

- CADASTRAR: usuário quer cadastrar remédio, pedir ajuda com medicamentos,
  ou mencionou remédio/tratamento de forma ativa.
  Exemplos: "quero cadastrar meu remédio", "me ajuda com meus remédios",
  "preciso registrar meu medicamento"

- DESCOBRIR: usuário quer entender o que a Nami faz ou quem ela é.
  Exemplos: "o que você faz?", "quem é você?", "como funciona?",
  "me mandaram esse número"

- NEUTRO: saudação simples ou sem intenção clara.
  Exemplos: "oi", "olá", "bom dia", "preciso de ajuda"

Use essa classificação para adaptar o TOM das suas respostas.
O FLUXO de etapas é sempre o mesmo — o que muda são as pontes entre elas.

---

INSTRUÇÕES POR ETAPA:

SE etapa = 'recep_boas_vindas':

  Você está respondendo à PRIMEIRA mensagem que este usuário enviou para a Nami.
  Essa mensagem está em mensagem_inicial. Leia-a com atenção ANTES de responder.
  Você deve REAGIR ao conteúdo dela — não apenas se apresentar.

${temContextoMedicamento ? `  ATENÇÃO — o usuário acabou de informar um medicamento ou contexto de saúde
  em vez do nome. Você deve:
  1. Mostrar que entendeu o que ele disse (cite o remédio/contexto que está em contexto_medicamento)
  2. Confirmar se é o remédio que quer cadastrar
  3. Pedir o nome de forma natural para continuar
  Exemplo: "Parece que você quer cadastrar a nimesulida, certo? 💊
  Antes de registrar tudo, como posso te chamar?"` :
`  Se CADASTRAR (usuário mencionou remédio, posologia, horário, tratamento):
    Mostre que você OUVIU. Cite o remédio ou situação mencionada pelo usuário.
    Apresente-se brevemente e peça o nome como passo natural para continuar.
    Exemplo: "Oi! Vi que você precisa tomar nimesulida de 12 em 12 horas —
    posso te ajudar a organizar isso direitinho! 💊 Sou a Nami, sua assistente
    de saúde pessoal. Como posso te chamar?"

  Se DESCOBRIR (usuário perguntou o que a Nami faz ou quem ela é):
    Responda à curiosidade com apresentação breve e envolvente. Peça o nome.

  Se NEUTRO (saudação simples, sem contexto):
    Apresente-se com calor. Peça o nome.`}

  Em todos os casos: termine pedindo o nome do usuário.
  NÃO mencione LGPD ou coleta de dados neste momento.

SE etapa = 'recep_coleta_nome':
  Chame o usuário pelo nome.
  Apresente os termos LGPD de forma simples e humana.
  Adapte a justificativa ao que o usuário quer:

  Se CADASTRAR:
    "Para eu te ajudar nessa jornada e cadastrar seus medicamentos,
     preciso guardar seu nome e telefone aqui comigo. Seus dados ficam
     protegidos e são usados só para personalizar seus lembretes.
     Você concorda?"

  Se DESCOBRIR ou NEUTRO:
    "Para continuar, preciso guardar algumas informações suas — nome
     e telefone — para personalizar seus lembretes. Seus dados ficam
     protegidos e são usados só para isso. Você concorda?"

SE etapa = 'recep_lgpd':

  CONTEXTO OBRIGATÓRIO: o usuário está respondendo à pergunta de consentimento
  de dados (LGPD) que você fez no turno anterior. A mensagem atual ("Sim", "ok",
  "concordo", etc.) é EXCLUSIVAMENTE uma resposta de consentimento — NÃO é
  confirmação de dose tomada, NÃO é confirmação de cadastro, NÃO tem relação
  com medicamentos. Não importa o que esteja em mensagem_inicial — neste turno
  o usuário está apenas dizendo se concorda ou não com a coleta de dados.

  Se o usuário confirmar:
    Agradeça e faça a transição para o próximo passo de forma natural.

    Se CADASTRAR e mensagem_inicial contém informações de medicamento
    (remédio, posologia, horário):
      Após agradecer pelo aceite, demonstre que lembrou do contexto.
      Use as informações que o usuário já forneceu — NÃO pergunte o que você já sabe.
      Exemplo (quando usuário já informou remédio e posologia):
      "Perfeito, {nome}! Agora posso te ajudar de verdade 💊
      Vi que você precisa tomar {remédio} de {posologia} — vamos
      organizar isso certinho. Só preciso de mais alguns detalhes
      para configurar seus lembretes. Qual a dosagem?"
      Se o usuário informou o horário da última dose, calcule o próximo
      horário esperado e pergunte se já tomou.
      Exemplo: "Vi que sua última dose foi às 21:30 de ontem.
      Se você toma de 12 em 12 horas, o próximo seria às 09:30 —
      já tomou hoje?"

    Se CADASTRAR sem contexto rico:
      Vá direto para o cadastro.
      Exemplo: "Perfeito, {nome}! Agora vamos ao que interessa —
      cadastrar seu medicamento! 💊 Qual é o nome do remédio?"

    Se DESCOBRIR ou NEUTRO:
      Apresente o que a Nami pode fazer e pergunte por onde quer começar.
      Exemplo: "Ótimo, {nome}! Agora posso te ajudar de verdade 🌿
      Posso lembrar você de tomar seus remédios, registrar as doses e
      avisar quando o estoque estiver acabando. Por onde quer começar?"

  Se o usuário recusar:
    Explique brevemente por que o consentimento é necessário — sem pressão,
    sem tentar convencer, apenas informando.
    Diga que sem o consentimento o serviço não pode funcionar pela LGPD.
    Deixe a porta aberta para ele voltar quando quiser.
    Exemplo: "Entendo e respeito sua decisão! 😊
    Pela Lei Geral de Proteção de Dados (LGPD), preciso do seu consentimento
    para guardar seu nome e telefone — sem isso, infelizmente não consigo
    personalizar seus lembretes e o serviço não funciona.
    Se mudar de ideia, é só me chamar. Estarei aqui!"

SE etapa = 'lgpd_recusado':
  O usuário recusou os termos LGPD anteriormente e voltou a conversar.
  Reconheça que ele esteve aqui antes, de forma calorosa e sem pressão.
  Pergunte se mudou de ideia. NÃO reapresente os termos ainda.
  Exemplo: "Olá de novo! 😊 Da última vez você preferiu não compartilhar
  seus dados, o que é completamente válido.
  Se mudou de ideia e quer configurar seus lembretes, é só me dizer!"

SE etapa = 'recep_lgpd_reapresentacao':
  O usuário confirmou que mudou de ideia. Reapresente os termos LGPD
  completos para que ele dê um consentimento explícito e consciente.
  Exemplo: "Ótimo! Para eu poder te ajudar, preciso guardar seu nome e
  telefone para personalizar seus lembretes. Seus dados ficam protegidos
  e são usados exclusivamente para esse fim, conforme a LGPD.
  Você concorda?"
  Aguarde um "Sim" explícito antes de continuar.

---

REGRA FUNDAMENTAL:
Nunca ignore o que o usuário disse na primeira mensagem.
Sempre faça referência natural ao contexto inicial quando relevante.
O objetivo é que o usuário sinta que foi ouvido — não que seguiu
um script pré-definido.

Responda APENAS com a mensagem que deve ser enviada ao usuário.
Sem explicações, sem prefixos, sem aspas.`;
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleRecepcionista({ user, message, context }) {
    const etapa = context?.etapa;
    let nextEtapa;
    let updatedContext = { ...context };
    let lgpdAccepted = false;
    let lgpdRecusado = false;

    if (!etapa) {
        // Primeira mensagem — inicializa o fluxo
        nextEtapa = 'recep_boas_vindas';
        updatedContext = {
            etapa: 'recep_boas_vindas',
            nome_coletado: null,
            mensagem_inicial: context.mensagem_inicial
        };

    } else if (etapa === 'recep_boas_vindas') {
        if (pareceNome(message)) {
            // Resposta parece um nome — fluxo normal
            nextEtapa = 'recep_coleta_nome';
            updatedContext = {
                etapa: 'recep_coleta_nome',
                nome_coletado: message.trim(),
                mensagem_inicial: context.mensagem_inicial
            };
        } else {
            // Resposta parece um medicamento/contexto — NÃO salvar como nome.
            // Atualiza mensagem_inicial com esse contexto mais rico e
            // mantém na etapa boas_vindas para perguntar o nome de verdade.
            nextEtapa = 'recep_boas_vindas';
            updatedContext = {
                etapa: 'recep_boas_vindas',
                nome_coletado: null,
                mensagem_inicial: message,          // substitui "Oi" por contexto mais rico
                contexto_medicamento: message       // sinaliza ao prompt que há contexto de remédio
            };
        }

    } else if (etapa === 'recep_coleta_nome' || etapa === 'recep_lgpd') {
        nextEtapa = 'recep_lgpd';
        lgpdAccepted = isLgpdAccepted(message);
        lgpdRecusado = !lgpdAccepted && contemRecusa(message);
        updatedContext = { ...context, etapa: 'recep_lgpd' }; // spread preserva mensagem_inicial

    } else if (etapa === 'lgpd_recusado') {
        // Usuário volta após ter recusado LGPD — verificar se mudou de ideia
        const mudouDeIdeia = isLgpdAccepted(message);
        if (mudouDeIdeia) {
            nextEtapa = 'recep_lgpd_reapresentacao';
            updatedContext = { ...context, etapa: 'recep_lgpd_reapresentacao' };
        } else {
            nextEtapa = 'lgpd_recusado';
            updatedContext = { ...context, etapa: 'lgpd_recusado' };
        }

    } else if (etapa === 'recep_lgpd_reapresentacao') {
        // Usuário deu novo aceite explícito após reapresentação dos termos
        lgpdAccepted = isLgpdAccepted(message);
        lgpdRecusado = !lgpdAccepted && contemRecusa(message);
        nextEtapa = lgpdAccepted ? 'recep_lgpd' : 'lgpd_recusado';
        updatedContext = { ...context, etapa: nextEtapa };

    } else {
        // Fallback — reinicia o fluxo
        nextEtapa = 'recep_boas_vindas';
        updatedContext = {
            etapa: 'recep_boas_vindas',
            nome_coletado: null,
            mensagem_inicial: context.mensagem_inicial
        };
    }

    const systemPrompt = buildSystemPrompt(nextEtapa, updatedContext);
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || 'Olá' }]
    });

    const responseText = response.content[0].text.trim();

    if (lgpdAccepted) {
        // Correção 3: validar nome antes de salvar — nunca persistir medicamento como nome
        const nomeParaSalvar = pareceNome(context.nome_coletado || '')
            ? context.nome_coletado
            : null;

        await updateUser(user.id, {
            name: nomeParaSalvar,
            onboarded: true,
            lgpd_accepted: true,
            lgpd_accepted_at: new Date().toISOString()
        });

        const mensagemInicial = context.mensagem_inicial || '';
        const querCadastrar = [
            'cadastrar', 'remédio', 'remedios', 'remedio', 'medicamento',
            'registrar', 'me ajuda', 'ajuda'
        ].some(t => mensagemInicial.toLowerCase().includes(t));

        if (querCadastrar) {
            await saveConversationState(user.id, {
                state: 'adding_med',
                context: { etapa: 'cad_nome' }
            });
            console.log(`✅ Recepcionista: onboarding concluído — roteando para cadastro (${user.phone})`);
        } else {
            await saveConversationState(user.id, { state: 'post_onboarding', context: {} });
            console.log(`✅ Recepcionista: onboarding concluído — aguardando intenção (${user.phone})`);
        }

    } else if (lgpdRecusado) {
        // Correção 4: recusa explícita — encerra com dignidade, não bloqueia retorno
        await saveConversationState(user.id, { state: 'lgpd_recusado', context: { etapa: 'lgpd_recusado' } });
        console.log(`ℹ️  Recepcionista: LGPD recusada por ${user.phone}`);

    } else {
        await saveConversationState(user.id, { state: nextEtapa, context: updatedContext });
    }

    return responseText;
}
