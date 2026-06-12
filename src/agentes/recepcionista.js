import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState, updateUser } from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LGPD_ACCEPT_KEYWORDS = ['sim', 's', 'pode', 'concordo', 'aceito', 'ok', 'claro', 'com certeza', 'yes'];

function isLgpdAccepted(message) {
    const normalized = message.toLowerCase().trim();
    return LGPD_ACCEPT_KEYWORDS.some(kw => normalized.includes(kw));
}

function buildSystemPrompt(etapa, context) {
    const mensagemInicial = context.mensagem_inicial || '';
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

  Se CADASTRAR (usuário mencionou remédio, posologia, horário, tratamento):
    Mostre que você OUVIU. Cite o remédio ou situação mencionada pelo usuário.
    Apresente-se brevemente e peça o nome como passo natural para continuar.
    Exemplo: "Oi! Vi que você precisa tomar nimesulida de 12 em 12 horas —
    posso te ajudar a organizar isso direitinho! 💊 Sou a Nami, sua assistente
    de saúde pessoal. Como posso te chamar?"

  Se DESCOBRIR (usuário perguntou o que a Nami faz ou quem ela é):
    Responda à curiosidade com apresentação breve e envolvente. Peça o nome.

  Se NEUTRO (saudação simples, sem contexto):
    Apresente-se com calor. Peça o nome.

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

    Se CADASTRAR:
      Vá direto para o cadastro.
      Exemplo: "Perfeito, {nome}! Agora vamos ao que interessa —
      cadastrar seu medicamento! 💊 Qual é o nome do remédio?"

    Se DESCOBRIR ou NEUTRO:
      Apresente o que a Nami pode fazer e pergunte por onde quer começar.
      Exemplo: "Ótimo, {nome}! Agora posso te ajudar de verdade 🌿
      Posso lembrar você de tomar seus remédios, registrar as doses e
      avisar quando o estoque estiver acabando. Por onde quer começar?"

  Se o usuário recusar:
    Agradeça pela honestidade, diga que entende e que ele pode voltar
    quando quiser.

---

REGRA FUNDAMENTAL:
Nunca ignore o que o usuário disse na primeira mensagem.
Sempre faça referência natural ao contexto inicial quando relevante.
O objetivo é que o usuário sinta que foi ouvido — não que seguiu
um script pré-definido.

Responda APENAS com a mensagem que deve ser enviada ao usuário.
Sem explicações, sem prefixos, sem aspas.`;
}

export async function handleRecepcionista({ user, message, context }) {
    const etapa = context?.etapa;
    let nextEtapa;
    let updatedContext = { ...context };
    let lgpdAccepted = false;

    if (!etapa) {
        nextEtapa = 'recep_boas_vindas';
        updatedContext = {
            etapa: 'recep_boas_vindas',
            nome_coletado: null,
            mensagem_inicial: context.mensagem_inicial
        };
    } else if (etapa === 'recep_boas_vindas') {
        const nome = message.trim();
        nextEtapa = 'recep_coleta_nome';
        updatedContext = {
            etapa: 'recep_coleta_nome',
            nome_coletado: nome,
            mensagem_inicial: context.mensagem_inicial
        };
    } else if (etapa === 'recep_coleta_nome' || etapa === 'recep_lgpd') {
        nextEtapa = 'recep_lgpd';
        lgpdAccepted = isLgpdAccepted(message);
        updatedContext = { ...context, etapa: 'recep_lgpd' }; // spread preserva mensagem_inicial
    } else {
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
        await updateUser(user.id, {
            name: context.nome_coletado,
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
            await saveConversationState(user.id, { state: 'idle', context: {} });
            console.log(`✅ Recepcionista: onboarding concluído para ${user.phone}`);
        }
    } else {
        await saveConversationState(user.id, { state: nextEtapa, context: updatedContext });
    }

    return responseText;
}
