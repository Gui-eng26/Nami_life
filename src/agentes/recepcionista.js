import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState, updateUser, formatarHistoricoConversa } from '../database.js';
import { degradar } from '../observabilidade.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// BUG-88 (MH-072 Parte B.0): teto de tentativas indeterminadas antes de encerrar
// em lgpd_recusado como saída de emergência — mesmo padrão de
// MAX_TENTATIVAS_INDETERMINADO em data_nascimento.js. duvida NÃO conta (ver
// classificarConsentimentoLgpd) — só indeterminado consome tentativa.
const MAX_TENTATIVAS_LGPD = 3;

// MH-072 Parte B: mesmo padrão de teto — nova_duvida NÃO conta (servir a
// curiosidade é o propósito da etapa recep_apresentacao); só ruido consome.
const MAX_TENTATIVAS_APRESENTACAO = 3;

// MH-072 Parte B (BUG-30): teto de tentativas de coleta de nome antes de
// encerrar em apresentacao_declinada — saudacao/recusa/indeterminado consomem;
// contexto_saude e pergunta não (são respostas legítimas, não falhas).
const MAX_TENTATIVAS_NOME = 3;

// ============================================================
// CLASSIFICADOR DE CONSENTIMENTO LGPD
// ============================================================
// BUG-88: substitui isLgpdAccepted()/contemRecusa() (keyword 's' via includes()
// casava com "pa*s*sar" em "prefiro nao passar os dados" — recusa gravada como
// aceite). Um único julgamento semântico sobre a mensagem, categoria fechada —
// o gerador de texto (buildSystemPrompt) só executa a decisão já tomada aqui,
// nunca decide sozinho. Mesmo padrão de classificarIndeterminado em
// data_nascimento.js (max_tokens: 8, degradar() no catch, nunca aceite em falha).
export async function classificarConsentimentoLgpd({ message, historicoConversa }) {
    const historicoTexto = formatarHistoricoConversa(historicoConversa);

    const systemPrompt = `Você é um classificador de consentimento LGPD para uma assistente de saúde via WhatsApp (a Nami).

A Nami acabou de pedir consentimento para guardar nome, telefone e data de nascimento do usuário. Classifique a resposta dele em UMA destas categorias:

- aceite: o usuário concorda de forma inequívoca com a guarda dos dados. Ex: "sim", "pode", "concordo", "aceito", "tudo bem", "claro", "ok", "sim, pode guardar".
- recusa: o usuário não concorda, ou adia. Ex: "não", "prefiro não passar os dados", "agora não", "deixa pra lá", "não quero compartilhar", "tô com receio disso".
- duvida: o usuário pergunta sobre o uso dos dados, sem aceitar nem recusar. Ex: "pra que vocês precisam disso?", "vocês vendem meus dados?", "quem vai ver isso?", "posso apagar depois?".
- indeterminado: a resposta não se encaixa em nenhuma categoria acima — confusa ou fora de contexto.

CONVERSA RECENTE:
${historicoTexto}

MENSAGEM ATUAL: "${message}"

Responda APENAS com uma palavra: aceite, recusa, duvida ou indeterminado. Sem pontuação, sem explicação.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: systemPrompt,
            messages: [{ role: 'user', content: message || 'Olá' }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        const validos = ['aceite', 'recusa', 'duvida', 'indeterminado'];
        const achado = validos.find(v => texto.includes(v));
        console.log(`🔒 [RECEPCIONISTA] Classificador LGPD: "${message}" -> ${achado || 'indeterminado (fallback)'}`);
        return achado || 'indeterminado';
    } catch (e) {
        console.error(`❌ [RECEPCIONISTA] Erro no classificador de consentimento LGPD: ${e.message} — assumindo indeterminado`);
        return await degradar({
            origem: 'recepcionista',
            motivo: 'classificador_lgpd_falhou',
            agent: 'recepcionista',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: 'indeterminado'
        });
    }
}

// ============================================================
// CLASSIFICADOR DE INTENÇÃO INICIAL (MH-072 Parte B, item 1)
// ============================================================
// Roda só no turno 1 (!context.etapa). Antes vivia embutido no mesmo prompt que
// gera a resposta (buildSystemPrompt) — a classificação existia mas não tinha
// poder de decisão sobre o fluxo, só ajustava o tom (princípio 14). Aqui ela
// decide, antes de qualquer texto ser gerado, entre recep_boas_vindas (pede
// nome direto) e recep_apresentacao (MH-074 — caminho do curioso).
export async function classificarIntencaoInicial({ message }) {
    const systemPrompt = `Você é um classificador de intenção inicial para uma assistente de saúde via WhatsApp (a Nami), que ajuda pessoas a não esquecerem seus medicamentos de uso contínuo.

Esta é a PRIMEIRA mensagem que a pessoa envia. Classifique-a em UMA destas categorias:

- cadastrar: pedido ativo de uso. Ex: "quero cadastrar meu remédio", "me ajuda com a losartana", "preciso tomar nimesulida de 12 em 12h".
- descobrir: curiosidade sobre o que a Nami é ou faz, SEM pedido de uso. Ex: "pra que você serve?", "o que você faz?", "você serve pra cadastrar remédio?", "você consegue me ajudar com lembretes?", "me mandaram esse número".
- neutro: saudação ou mensagem sem intenção discernível. Ex: "oi", "bom dia", "tudo bem?".

Fronteira importante: "você serve pra X?" é descobrir (pergunta sobre capacidade, especulação). "quero X" é cadastrar (pedido de uso).

MENSAGEM: "${message}"

Responda APENAS com uma palavra: cadastrar, descobrir ou neutro. Sem pontuação, sem explicação.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: systemPrompt,
            messages: [{ role: 'user', content: message || 'Olá' }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        const validos = ['cadastrar', 'descobrir', 'neutro'];
        const achado = validos.find(v => texto.includes(v));
        console.log(`👋 [RECEPCIONISTA] Classificador de intenção inicial: "${message}" -> ${achado || 'neutro (fallback)'}`);
        return achado || 'neutro';
    } catch (e) {
        console.error(`❌ [RECEPCIONISTA] Erro no classificador de intenção inicial: ${e.message} — assumindo neutro`);
        return await degradar({
            origem: 'recepcionista',
            motivo: 'classificador_intencao_inicial_falhou',
            agent: 'recepcionista',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: 'neutro'
        });
    }
}

// ============================================================
// CLASSIFICADOR DE RESPOSTA AO CONVITE (MH-074, item 3)
// ============================================================
// Roda nas etapas recep_apresentacao e apresentacao_declinada — a resposta é
// sempre relativa ao convite (ou à despedida) do turno anterior, por isso o
// histórico recente entra no prompt.
export async function classificarRespostaConvite({ message, historicoConversa }) {
    const historicoTexto = formatarHistoricoConversa(historicoConversa);

    const systemPrompt = `Você é um classificador de resposta a um convite, para uma assistente de saúde via WhatsApp (a Nami).

A Nami acabou de se apresentar (ou de reencontrar alguém que já conhecia) e convidar a pessoa a começar a usar — cadastrar um remédio. Classifique a resposta dela em UMA destas categorias:

- afirmativo: aceita começar. Ex: "sim", "quero", "bora", "vamos lá", "pode ser", "como faço?", "quero cadastrar meu remédio".
- negativo: recusa ou adia. Ex: "não", "agora não", "só estava olhando", "depois eu vejo".
- nova_duvida: outra pergunta sobre a Nami, sem aceitar nem recusar. Ex: "e é de graça?", "funciona pra meu pai?", "precisa instalar app?".
- ruido: incompreensível ou fora de contexto.

CONVERSA RECENTE:
${historicoTexto}

MENSAGEM ATUAL: "${message}"

Responda APENAS com uma palavra: afirmativo, negativo, nova_duvida ou ruido. Sem pontuação, sem explicação.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: systemPrompt,
            messages: [{ role: 'user', content: message || 'Olá' }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        const validos = ['afirmativo', 'negativo', 'nova_duvida', 'ruido'];
        const achado = validos.find(v => texto.includes(v));
        console.log(`👋 [RECEPCIONISTA] Classificador de resposta ao convite: "${message}" -> ${achado || 'ruido (fallback)'}`);
        return achado || 'ruido';
    } catch (e) {
        console.error(`❌ [RECEPCIONISTA] Erro no classificador de resposta ao convite: ${e.message} — assumindo ruido`);
        return await degradar({
            origem: 'recepcionista',
            motivo: 'classificador_resposta_convite_falhou',
            agent: 'recepcionista',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: 'ruido'
        });
    }
}

// ============================================================
// EXTRATOR DE NOME (BUG-30, MH-072 Parte B item 5)
// ============================================================
// Substitui pareceNome() — lista de exclusão que só sabia reconhecer sinais de
// remédio, então qualquer outra coisa (inclusive "Sim, quero continuar") virava
// nome. Devolve tipo semântico + valor (princípio 14: nunca booleano de
// validade). Chamada uma única vez — a segunda checagem que existia na
// gravação (reusando a mesma função que produziu o erro) some: o valor aqui já
// sai normalizado e validado.
export async function classificarNome({ message, historicoConversa }) {
    const historicoTexto = formatarHistoricoConversa(historicoConversa);

    const systemPrompt = `Você é um classificador para a etapa de coleta de nome no onboarding de uma assistente de saúde via WhatsApp (a Nami).

A Nami acabou de perguntar "como posso te chamar?". Classifique a resposta em UMA destas categorias:

- nome: a pessoa disse como quer ser chamada. Ex: "Guilherme", "pode me chamar de Gui", "meu nome é Ana Paula", "Ana".
- saudacao: a pessoa só cumprimentou, sem dizer o nome. Ex: "oi", "olá", "bom dia", "tudo bem?".
- contexto_saude: a pessoa mencionou um remédio, dosagem, posologia ou situação de saúde em vez do nome. Ex: "tomo losartana 50mg", "preciso de nimesulida de 12 em 12h", "é pra minha mãe".
- pergunta: a pessoa fez uma pergunta em vez de responder. Ex: "por que você precisa disso?", "pra que serve isso?", "quanto custa?".
- recusa: a pessoa não quer dizer o nome. Ex: "não quero dizer", "prefiro não falar", "não vou passar meu nome".
- indeterminado: a resposta não se encaixa em nenhuma categoria acima — confusa ou fora de contexto.

Quando a categoria for "nome", devolva também o nome NORMALIZADO que a pessoa quer usar — nunca a frase inteira. Ex: "pode me chamar de gui" -> "Gui". "meu nome é guilherme silveira" -> "Guilherme Silveira".

CONVERSA RECENTE:
${historicoTexto}

MENSAGEM ATUAL: "${message}"

Responda EXATAMENTE neste formato, sem explicação:
- Se a categoria NÃO for "nome": só a categoria, uma palavra, uma linha.
- Se a categoria FOR "nome": duas linhas — "nome" na primeira, o nome normalizado na segunda.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 30,
            system: systemPrompt,
            messages: [{ role: 'user', content: message || 'Olá' }]
        });
        const texto = (resposta.content[0]?.text || '').trim();
        const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean);
        const categoriaBruta = (linhas[0] || '').toLowerCase();
        const validos = ['nome', 'saudacao', 'contexto_saude', 'pergunta', 'recusa', 'indeterminado'];
        const achado = validos.find(v => categoriaBruta.includes(v));

        if (achado === 'nome') {
            const valor = (linhas[1] || message || '').trim();
            console.log(`👋 [RECEPCIONISTA] Classificador de nome: "${message}" -> nome: "${valor}"`);
            return { tipo: 'nome', valor };
        }

        console.log(`👋 [RECEPCIONISTA] Classificador de nome: "${message}" -> ${achado || 'indeterminado (fallback)'}`);
        return { tipo: achado || 'indeterminado', valor: null };
    } catch (e) {
        console.error(`❌ [RECEPCIONISTA] Erro no classificador de nome: ${e.message} — assumindo indeterminado`);
        const fallback = await degradar({
            origem: 'recepcionista',
            motivo: 'classificador_nome_falhou',
            agent: 'recepcionista',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: 'indeterminado'
        });
        return { tipo: fallback, valor: null };
    }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(etapa, context, extras = {}) {
    const mensagemInicial = context.mensagem_inicial || '';
    const temContextoMedicamento = !!context.contexto_medicamento;
    const intencaoInicial = context.intencao_inicial || 'neutro';

    // --- Bloco recep_apresentacao (MH-074) ---
    const apresentacaoTexto = extras.motivoApresentacao === 'ruido' ? `
  A última mensagem do usuário não deu pra entender como resposta ao convite que você acabou de fazer. Repita o convite de forma gentil e mais curta, sem soar repetitiva ou impaciente.
  NÃO peça o nome, NÃO mencione LGPD, NÃO inicie cadastro.` : extras.motivoApresentacao === 'nova_duvida' ? `
  O usuário fez uma NOVA pergunta sobre a Nami, em vez de aceitar ou recusar o convite anterior. Responda a essa dúvida em uma ou duas frases objetivas e depois REOFEREÇA o convite para começar a usar — mais leve e mais curto do que da vez anterior (esta é a rodada ${extras.rodadasDuvida || 1} de reoferta: quanto mais rodadas, mais leve e menos insistente deve soar).
  NÃO peça o nome, NÃO mencione LGPD, NÃO inicie cadastro.` : `
  Esta é a primeira resposta da Nami a alguém que só quer entender o que ela faz — a pessoa ainda NÃO pediu para usar.
  A pergunta feita está em "Mensagem original do usuário" acima. Responda ESPECIFICAMENTE a ela, citando-a — se a pergunta foi "você serve pra cadastrar remédio?", comece por algo como "sim, eu ajudo você a cadastrar os horários dos seus remédios".
  Complemente com as demais capacidades da Nami: lembretes nos horários certos, confirmação de dose, controle de estoque, acompanhamento de adesão ao tratamento, e visibilidade para quem cuida de um familiar.
  Feche com um convite explícito e caloroso para começar a usar — é uma oferta, não um funil. Sem pressão.

  RESTRIÇÕES ABSOLUTAS NESTA ETAPA:
  - NÃO peça o nome do usuário
  - NÃO mencione LGPD, dados ou consentimento
  - NÃO inicie o cadastro de medicamento`;

    // --- Bloco apresentacao_declinada (MH-074) ---
    const declinioTexto = extras.motivoDeclinio === 'retorno' ? `
  O usuário já esteve aqui antes e não quis continuar (ou não deu uma resposta clara). Agora ele voltou a escrever, mas ainda não aceitou nem recusou de forma clara nesta mensagem. Acolha com calor, SEM cobrar, SEM recapitular a recusa anterior como se fosse uma cobrança pendente. Não insista — só mostre que a porta continua aberta.` : extras.motivoDeclinio === 'limite_tentativas' ? `
  Depois de algumas tentativas, não foi possível entender as respostas do usuário. Encerre com uma despedida gentil e leve, sem cobrança, deixando claro que ele pode voltar quando quiser.` : `
  O usuário decidiu, por ora, não continuar. Despeça-se de forma gentil e leve, SEM insistir e SEM tentar convencer. Deixe a porta aberta para ele voltar quando quiser.`;

    // --- Bloco recep_boas_vindas ---
    let boasVindasTexto;
    if (extras.motivoNome) {
        const motivoNomeTexto = extras.motivoNome === 'saudacao' ? `
  A última resposta do usuário foi só um cumprimento (ex: "oi", "bom dia") — NÃO é o nome dele. Cumprimente de volta com calor e repita o pedido do nome.
  Exemplo: "Oi! 😊 E como posso te chamar?"` : extras.motivoNome === 'pergunta' ? `
  A última resposta do usuário foi uma pergunta, não o nome dele. Responda a essa pergunta de forma breve e depois repita o pedido do nome.` : extras.motivoNome === 'recusa' ? `
  O usuário disse que não quer dizer o nome. Explique com empatia, em uma frase, por que o nome ajuda a Nami a personalizar a conversa — sem insistir ou pressionar — e repita o pedido de forma leve.` : `
  A última resposta do usuário não deu pra entender como um nome. Repita o pedido do nome com um exemplo, de forma gentil.
  Exemplo: "Não entendi direito — como posso te chamar? Pode ser só o primeiro nome mesmo 😊"`;
        boasVindasTexto = `${motivoNomeTexto}

  NÃO mencione LGPD ou coleta de dados neste momento.`;
    } else if (temContextoMedicamento) {
        boasVindasTexto = `  ATENÇÃO — o usuário acabou de informar um medicamento ou contexto de saúde
  em vez do nome. Você deve:
  1. Mostrar que entendeu o que ele disse (cite o remédio/contexto que está em contexto_medicamento)
  2. Confirmar se é o remédio que quer cadastrar
  3. Pedir o nome de forma natural para continuar
  Exemplo: "Parece que você quer cadastrar a nimesulida, certo? 💊
  Antes de registrar tudo, como posso te chamar?"

  NÃO mencione LGPD ou coleta de dados neste momento.`;
    } else if (extras.modoBoasVindas === 'pos_convite') {
        boasVindasTexto = `  A pessoa já viu a apresentação da Nami e acabou de aceitar o convite para começar a usar${extras.retornoDeclinado ? ' (ela tinha adiado antes e voltou agora)' : ''}. NÃO se reapresente do zero e NÃO repita as capacidades já explicadas — reconheça a aceitação com calor, breve, e pergunte o nome direto.
  Exemplo: "Que bom! 😊 Vamos começar então — como posso te chamar?"

  NÃO mencione LGPD ou coleta de dados neste momento.`;
    } else {
        boasVindasTexto = `  Você está respondendo à PRIMEIRA mensagem que este usuário enviou para a Nami.
  Essa mensagem está em mensagem_inicial. Leia-a com atenção ANTES de responder.
  Você deve REAGIR ao conteúdo dela — não apenas se apresentar.

  Se a intenção inicial for CADASTRAR (usuário mencionou remédio, posologia, horário, tratamento):
    Mostre que você OUVIU. Cite o remédio ou situação mencionada pelo usuário.
    Apresente-se brevemente e peça o nome como passo natural para continuar.
    Exemplo: "Oi! Vi que você precisa tomar nimesulida de 12 em 12 horas —
    posso te ajudar a organizar isso direitinho! 💊 Sou a Nami, sua assistente
    de saúde pessoal. Como posso te chamar?"

  Se a intenção inicial for NEUTRO (saudação simples, sem contexto):
    Apresente-se com calor. Peça o nome.

  Em todos os casos: termine pedindo o nome do usuário.
  NÃO mencione LGPD ou coleta de dados neste momento.`;
    }

    // --- Bloco recep_nome_pos_lgpd (BUG-89) ---
    // Sem teto de tentativas (seção 3.3 do briefing) — não há ramo de
    // "limite_tentativas" aqui como em recep_boas_vindas.
    let nomePosLgpdTexto;
    if (extras.motivoNomePosLgpd === 'saudacao') {
        nomePosLgpdTexto = `
  A última resposta do usuário foi só um cumprimento (ex: "oi", "bom dia") — NÃO é o nome dele. Cumprimente de volta com calor e repita o pedido do nome.`;
    } else if (extras.motivoNomePosLgpd === 'pergunta') {
        nomePosLgpdTexto = `
  A última resposta do usuário foi uma pergunta, não o nome dele. Responda a essa pergunta de forma breve e depois repita o pedido do nome.`;
    } else if (extras.motivoNomePosLgpd === 'recusa') {
        nomePosLgpdTexto = `
  O usuário disse que não quer dizer o nome. Explique com empatia, em uma frase, por que o nome é necessário para continuar — sem insistir ou pressionar — e repita o pedido de forma leve.`;
    } else if (extras.motivoNomePosLgpd === 'contexto_saude') {
        nomePosLgpdTexto = `
  ATENÇÃO — o usuário acabou de informar um medicamento ou contexto de saúde em vez do nome. Mostre que entendeu o que ele disse (cite o remédio/contexto que está em contexto_medicamento), confirme se é o que quer cadastrar, e peça o nome de forma natural para continuar.`;
    } else if (extras.motivoNomePosLgpd === 'indeterminado') {
        nomePosLgpdTexto = `
  A última resposta do usuário não deu pra entender como um nome. Repita o pedido do nome com um exemplo, de forma gentil.
  Exemplo: "Não entendi direito — como posso te chamar? Pode ser só o primeiro nome mesmo 😊"`;
    } else {
        nomePosLgpdTexto = `
  O usuário ACABOU de dar consentimento (LGPD) após reconsiderar. Agradeça o consentimento com calor, em uma frase curta, e peça o nome dele para continuar — em uma única mensagem.
  Exemplo: "Que bom que você topou! 😊 Antes de seguirmos, como posso te chamar?"`;
    }

    return `Você é a Nami, uma assistente de saúde pessoal que ajuda pessoas a não esquecerem seus medicamentos de uso contínuo.

Você está no momento de boas-vindas com um novo usuário.

Seu tom é: acolhedor, caloroso, humano, responsável e confiável.
Use linguagem natural e próxima. Não seja robótica nem excessivamente formal.
Use emojis com moderação para tornar a conversa mais leve.

Etapa atual: ${etapa}
Contexto coletado até agora: ${JSON.stringify(context)}
Mensagem original do usuário (primeira mensagem): ${mensagemInicial}

---

INTENÇÃO INICIAL JÁ CLASSIFICADA: ${intencaoInicial}
(cadastrar = pedido ativo de uso | descobrir = curiosidade sobre a Nami, sem pedido de uso | neutro = saudação sem intenção clara)
A decisão de FLUXO (qual etapa vem a seguir) já foi tomada pelo código antes desta chamada — você só redige o texto do comportamento já decidido, nunca julga de novo intenção nem consentimento.

---

INSTRUÇÕES POR ETAPA:

SE etapa = 'recep_apresentacao':
${apresentacaoTexto}

SE etapa = 'apresentacao_declinada':
${declinioTexto}
  NÃO peça o nome, NÃO mencione LGPD, NÃO inicie cadastro.

SE etapa = 'recep_boas_vindas':

${boasVindasTexto}

SE etapa = 'recep_coleta_nome':
  Chame o usuário pelo nome.
  Apresente os termos LGPD de forma simples e humana.
  Adapte a justificativa ao que o usuário quer:

  Se a intenção inicial for CADASTRAR:
    "Para eu te ajudar nessa jornada e cadastrar seus medicamentos,
     preciso guardar seu nome, telefone e data de nascimento aqui
     comigo. Seus dados ficam protegidos e são usados só para
     personalizar seus lembretes. Você concorda?"

  Se a intenção inicial for DESCOBRIR ou NEUTRO:
    "Para continuar, preciso guardar algumas informações suas — nome,
     telefone e data de nascimento — para personalizar seus lembretes.
     Seus dados ficam protegidos e são usados só para isso. Você
     concorda?"

SE etapa = 'recep_lgpd':

  CONTEXTO OBRIGATÓRIO: o usuário está respondendo à pergunta de consentimento
  de dados (LGPD) que você fez no turno anterior. A mensagem atual ("Sim", "ok",
  "concordo", etc.) é EXCLUSIVAMENTE uma resposta de consentimento — NÃO é
  confirmação de dose tomada, NÃO é confirmação de cadastro, NÃO tem relação
  com medicamentos. Não importa o que esteja em mensagem_inicial — neste turno
  o usuário está apenas dizendo se concorda ou não com a coleta de dados.

  A classificação da resposta já foi decidida por um classificador (não é sua
  decisão): classificacao_lgpd = '${context.classificacao_lgpd || ''}'. Você
  APENAS redige o texto do comportamento correspondente abaixo — nunca julgue
  de novo se o usuário aceitou ou recusou.

${context.classificacao_lgpd === 'aceite' ? `  O usuário ACEITOU o consentimento.
    Agradeça o aceite e faça a transição para a COLETA DE DATA DE NASCIMENTO —
    NÃO vá direto para o cadastro nem para a apresentação de funcionalidades:
    essa etapa vem sempre antes (logo após o aceite da LGPD, antes do cadastro
    de medicamento). Essa ponte é necessária porque este turno já produz uma
    resposta — sem ela, seriam duas mensagens seguidas da Nami. Termine SEMPRE
    perguntando em que DIA do mês {nome} nasceu, com exemplo obrigatório de
    formato (ex: "por exemplo: 7").

    Se a intenção inicial for CADASTRAR e mensagem_inicial contém informações de medicamento
    (remédio, posologia, horário):
      Mostre que lembrou do contexto — cite o remédio/situação mencionada —
      mas NÃO avance para o cadastro ainda. Peça só mais um detalhe rápido
      antes: o dia de nascimento.
      Exemplo: "Perfeito, {nome}! Já anotei que você quer cuidar da
      {remédio} — vamos organizar isso já já 💊 Antes, só um detalhe
      rapidinho: em que dia do mês você nasceu? Por exemplo: 7"

    Se a intenção inicial for CADASTRAR sem contexto rico:
      Exemplo: "Perfeito, {nome}! Antes de irmos para o cadastro, só
      preciso de um detalhe rapidinho: em que dia do mês você nasceu?
      Por exemplo: 7"

    Se a intenção inicial for DESCOBRIR ou NEUTRO:
      Exemplo: "Ótimo, {nome}! Antes de te contar tudo que posso fazer,
      só um detalhe rapidinho: em que dia do mês você nasceu? Por
      exemplo: 7"` : ''}${context.classificacao_lgpd === 'recusa' ? `  O usuário RECUSOU o consentimento (ou não respondeu com clareza suficiente
    depois de algumas tentativas).
    Explique brevemente por que o consentimento é necessário — sem pressão,
    sem tentar convencer, apenas informando.
    Diga que sem o consentimento o serviço não pode funcionar pela LGPD.
    Deixe a porta aberta para ele voltar quando quiser.
    Exemplo: "Entendo e respeito sua decisão! 😊
    Pela Lei Geral de Proteção de Dados (LGPD), preciso do seu consentimento
    para guardar seu nome, telefone e data de nascimento — sem isso,
    infelizmente não consigo personalizar seus lembretes e o serviço não
    funciona.
    Se mudar de ideia, é só me chamar. Estarei aqui!"` : ''}${context.classificacao_lgpd === 'duvida' ? `  O usuário tem uma DÚVIDA sobre o uso dos dados — não aceitou nem recusou.
    Responda com transparência, em UMA ou duas frases: os dados são usados só
    para personalizar os lembretes, nunca são vendidos nem compartilhados com
    terceiros. Depois, reapresente o pedido de consentimento de forma natural.
    NÃO grave nada — ainda estamos aguardando a decisão do usuário.
    Exemplo: "Boa pergunta! Uso seus dados só pra personalizar seus lembretes
    — nunca vendo nem compartilho com ninguém. 😊 Posso guardar seu nome,
    telefone e data de nascimento?"` : ''}${context.classificacao_lgpd === 'indeterminado' ? `  A resposta do usuário não deixou claro se ele aceita ou recusa o
    consentimento. Repergunte de forma mais simples e direta, sem constranger
    e sem repetir o texto legal inteiro de novo.
    Exemplo: "Não entendi direito — posso guardar seu nome, telefone e data
    de nascimento pra personalizar seus lembretes? Pode responder só 'sim' ou
    'não' 🙂"` : ''}

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
  Exemplo: "Ótimo! Para eu poder te ajudar, preciso guardar seu nome,
  telefone e data de nascimento para personalizar seus lembretes. Seus
  dados ficam protegidos e são usados exclusivamente para esse fim,
  conforme a LGPD.
  Você concorda?"
  Aguarde um "Sim" explícito antes de continuar.

SE etapa = 'recep_nome_pos_lgpd':
${nomePosLgpdTexto}

  NÃO repita os termos da LGPD nem peça consentimento de novo — o usuário já
  concordou. NÃO mencione data de nascimento nem inicie o cadastro do
  medicamento ainda.

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

export async function handleRecepcionista({ user, message, context, historicoConversa = [] }) {
    const etapa = context?.etapa;
    let nextEtapa;
    let updatedContext = { ...context };
    let lgpdAccepted = false;
    let lgpdRecusado = false;
    let extras = {};

    if (!etapa) {
        // Primeira mensagem — classifica a intenção antes de decidir o fluxo
        // (MH-074): cadastrar/neutro pedem o nome direto; descobrir passa pela
        // antessala recep_apresentacao antes de pedir qualquer dado.
        const intencao = await classificarIntencaoInicial({ message: context.mensagem_inicial });

        if (intencao === 'descobrir') {
            nextEtapa = 'recep_apresentacao';
            updatedContext = {
                etapa: 'recep_apresentacao',
                mensagem_inicial: context.mensagem_inicial,
                intencao_inicial: 'descobrir',
                tentativas_ruido: 0,
                rodadas_duvida: 0
            };
            extras = { motivoApresentacao: 'primeira' };
        } else {
            nextEtapa = 'recep_boas_vindas';
            updatedContext = {
                etapa: 'recep_boas_vindas',
                nome_coletado: null,
                mensagem_inicial: context.mensagem_inicial,
                intencao_inicial: intencao,
                tentativas_nome: 0
            };
        }

    } else if (etapa === 'recep_apresentacao') {
        const categoria = await classificarRespostaConvite({ message, historicoConversa });

        if (categoria === 'afirmativo') {
            nextEtapa = 'recep_boas_vindas';
            updatedContext = {
                etapa: nextEtapa,
                nome_coletado: null,
                mensagem_inicial: context.mensagem_inicial,
                intencao_inicial: context.intencao_inicial,
                tentativas_nome: 0
            };
            extras = { modoBoasVindas: 'pos_convite' };

        } else if (categoria === 'negativo') {
            nextEtapa = 'apresentacao_declinada';
            updatedContext = {
                etapa: nextEtapa,
                mensagem_inicial: context.mensagem_inicial,
                intencao_inicial: context.intencao_inicial
            };
            extras = { motivoDeclinio: 'declinado' };

        } else if (categoria === 'nova_duvida') {
            // Não conta para o teto — servir a curiosidade é o propósito da etapa.
            nextEtapa = 'recep_apresentacao';
            const rodadas = (context.rodadas_duvida || 0) + 1;
            updatedContext = { ...context, etapa: nextEtapa, rodadas_duvida: rodadas };
            extras = { motivoApresentacao: 'nova_duvida', rodadasDuvida: rodadas };

        } else {
            // ruido — único ramo que consome tentativa.
            const tentativas = (context.tentativas_ruido || 0) + 1;
            if (tentativas >= MAX_TENTATIVAS_APRESENTACAO) {
                console.log(`👋 [RECEPCIONISTA] ${tentativas}ª tentativa de ruído em recep_apresentacao — encerrando em apresentacao_declinada (${user.phone})`);
                nextEtapa = 'apresentacao_declinada';
                updatedContext = {
                    etapa: nextEtapa,
                    mensagem_inicial: context.mensagem_inicial,
                    intencao_inicial: context.intencao_inicial
                };
                extras = { motivoDeclinio: 'limite_tentativas' };
            } else {
                nextEtapa = 'recep_apresentacao';
                updatedContext = { ...context, etapa: nextEtapa, tentativas_ruido: tentativas };
                extras = { motivoApresentacao: 'ruido' };
            }
        }

    } else if (etapa === 'apresentacao_declinada') {
        const categoria = await classificarRespostaConvite({ message, historicoConversa });

        if (categoria === 'afirmativo') {
            // Retorno com aceite ou pedido novo — a retomada ancora no que a
            // pessoa quer AGORA, não na curiosidade antiga (item 4 do briefing).
            nextEtapa = 'recep_boas_vindas';
            updatedContext = {
                etapa: nextEtapa,
                nome_coletado: null,
                mensagem_inicial: message,
                intencao_inicial: 'cadastrar',
                tentativas_nome: 0
            };
            extras = { modoBoasVindas: 'pos_convite', retornoDeclinado: true };

        } else if (categoria === 'nova_duvida') {
            nextEtapa = 'recep_apresentacao';
            updatedContext = {
                etapa: nextEtapa,
                mensagem_inicial: context.mensagem_inicial,
                intencao_inicial: context.intencao_inicial,
                tentativas_ruido: 0,
                rodadas_duvida: 0
            };
            extras = { motivoApresentacao: 'primeira' };

        } else {
            // negativo / ruido — permanece, acolhe sem pressionar.
            nextEtapa = 'apresentacao_declinada';
            updatedContext = { ...context, etapa: nextEtapa };
            extras = { motivoDeclinio: 'retorno' };
        }

    } else if (etapa === 'recep_boas_vindas') {
        const classificacaoNome = await classificarNome({ message, historicoConversa });

        if (classificacaoNome.tipo === 'nome') {
            nextEtapa = 'recep_coleta_nome';
            updatedContext = {
                etapa: nextEtapa,
                nome_coletado: classificacaoNome.valor,
                mensagem_inicial: context.mensagem_inicial,
                intencao_inicial: context.intencao_inicial
            };

        } else if (classificacaoNome.tipo === 'contexto_saude') {
            // Não é nome — atualiza mensagem_inicial com o contexto mais rico e
            // mantém na etapa boas_vindas para perguntar o nome de verdade.
            nextEtapa = 'recep_boas_vindas';
            updatedContext = {
                ...context,
                etapa: nextEtapa,
                nome_coletado: null,
                mensagem_inicial: message,
                contexto_medicamento: message
            };

        } else if (classificacaoNome.tipo === 'pergunta') {
            // Responde a dúvida e repede o nome — não consome tentativa.
            nextEtapa = 'recep_boas_vindas';
            updatedContext = { ...context, etapa: nextEtapa };
            extras = { motivoNome: 'pergunta' };

        } else {
            // saudacao | recusa | indeterminado — contam para o teto.
            const tentativas = (context.tentativas_nome || 0) + 1;
            if (tentativas >= MAX_TENTATIVAS_NOME) {
                console.log(`👋 [RECEPCIONISTA] ${tentativas}ª tentativa sem nome válido (${classificacaoNome.tipo}) — encerrando em apresentacao_declinada (${user.phone})`);
                nextEtapa = 'apresentacao_declinada';
                updatedContext = {
                    etapa: nextEtapa,
                    mensagem_inicial: context.mensagem_inicial,
                    intencao_inicial: context.intencao_inicial
                };
                extras = { motivoDeclinio: 'limite_tentativas' };
            } else {
                nextEtapa = 'recep_boas_vindas';
                updatedContext = { ...context, etapa: nextEtapa, tentativas_nome: tentativas };
                extras = { motivoNome: classificacaoNome.tipo };
            }
        }

    } else if (etapa === 'recep_coleta_nome' || etapa === 'recep_lgpd') {
        nextEtapa = 'recep_lgpd';
        const categoria = await classificarConsentimentoLgpd({ message, historicoConversa });

        if (categoria === 'aceite') {
            lgpdAccepted = true;
            updatedContext = { ...context, etapa: nextEtapa, classificacao_lgpd: 'aceite' };

        } else if (categoria === 'recusa') {
            lgpdRecusado = true;
            updatedContext = { ...context, etapa: nextEtapa, classificacao_lgpd: 'recusa' };

        } else if (categoria === 'duvida') {
            // Dúvida legítima sobre o uso dos dados — não conta para o teto de
            // tentativas (só indeterminado consome, ver tentativas_lgpd abaixo).
            updatedContext = { ...context, etapa: nextEtapa, classificacao_lgpd: 'duvida' };

        } else {
            // indeterminado — único ramo que consome tentativa.
            const tentativas = (context.tentativas_lgpd || 0) + 1;
            if (tentativas >= MAX_TENTATIVAS_LGPD) {
                // Saída de emergência (padrão da Parte A.1 item 6): teto atingido,
                // encerra em lgpd_recusado — estado morno e reversível.
                console.log(`🔒 Recepcionista: ${tentativas}ª tentativa indeterminada de LGPD — encerrando em lgpd_recusado (${user.phone})`);
                lgpdRecusado = true;
                updatedContext = { ...context, etapa: nextEtapa, classificacao_lgpd: 'recusa', tentativas_lgpd: tentativas };
            } else {
                updatedContext = { ...context, etapa: nextEtapa, classificacao_lgpd: 'indeterminado', tentativas_lgpd: tentativas };
            }
        }

    } else if (etapa === 'lgpd_recusado') {
        // Usuário volta após ter recusado LGPD — verificar se mudou de ideia.
        // Reaproveita o mesmo classificador: "mudou de ideia" é, em essência, a
        // mesma pergunta de consentimento respondida em contexto diferente — e
        // historicoConversa carrega o turno anterior ("mudou de ideia?"), então o
        // classificador tem o mesmo contexto que teria em recep_lgpd.
        const categoria = await classificarConsentimentoLgpd({ message, historicoConversa });
        const mudouDeIdeia = categoria === 'aceite';
        if (mudouDeIdeia) {
            nextEtapa = 'recep_lgpd_reapresentacao';
            updatedContext = { ...context, etapa: 'recep_lgpd_reapresentacao' };
        } else {
            nextEtapa = 'lgpd_recusado';
            updatedContext = { ...context, etapa: 'lgpd_recusado' };
        }

    } else if (etapa === 'recep_lgpd_reapresentacao') {
        // Usuário deu novo aceite explícito após reapresentação dos termos —
        // aguarda um "Sim" inequívoco; qualquer outra categoria é tratada como
        // não aceito e encerra em lgpd_recusado. BUG-89: o aceite aqui NÃO grava
        // mais direto — o nome foi apagado na recusa (seção 2 do briefing, decisão
        // preservada) e precisa ser recoletado antes da gravação. lgpd_aceito_em
        // marca o instante real do consentimento, para lgpd_accepted_at (seção
        // 3.5) não confundir esse instante com o da gravação, que agora acontece
        // um turno depois.
        const categoria = await classificarConsentimentoLgpd({ message, historicoConversa });

        if (categoria === 'aceite') {
            nextEtapa = 'recep_nome_pos_lgpd';
            updatedContext = {
                ...context,
                etapa: nextEtapa,
                lgpd_aceito_em: new Date().toISOString()
            };
        } else {
            lgpdRecusado = true;
            nextEtapa = 'lgpd_recusado';
            updatedContext = { ...context, etapa: nextEtapa };
        }

    } else if (etapa === 'recep_nome_pos_lgpd') {
        // BUG-89: coleta de nome após retorno de LGPD. Reusa classificarNome —
        // mesma função, mesmo contrato de recep_boas_vindas (princípio 14).
        // SEM teto de tentativas (decisão de Guilherme na v31, seção 3.3): quem
        // avança aqui é o usuário, que acabou de consentir duas vezes.
        const classificacaoNome = await classificarNome({ message, historicoConversa });

        if (classificacaoNome.tipo === 'nome') {
            lgpdAccepted = true;
            nextEtapa = 'recep_lgpd';
            updatedContext = {
                ...context,
                etapa: nextEtapa,
                nome_coletado: classificacaoNome.valor,
                classificacao_lgpd: 'aceite'
            };

        } else if (classificacaoNome.tipo === 'contexto_saude') {
            nextEtapa = 'recep_nome_pos_lgpd';
            updatedContext = {
                ...context,
                etapa: nextEtapa,
                mensagem_inicial: message,
                contexto_medicamento: message
            };
            extras = { motivoNomePosLgpd: 'contexto_saude' };

        } else {
            // saudacao | pergunta | recusa | indeterminado — permanece, sem teto.
            nextEtapa = 'recep_nome_pos_lgpd';
            updatedContext = { ...context, etapa: nextEtapa };
            extras = { motivoNomePosLgpd: classificacaoNome.tipo };
        }

    } else {
        // Fallback — reinicia o fluxo
        nextEtapa = 'recep_boas_vindas';
        updatedContext = {
            etapa: 'recep_boas_vindas',
            nome_coletado: null,
            mensagem_inicial: context.mensagem_inicial,
            tentativas_nome: 0
        };
    }

    const systemPrompt = buildSystemPrompt(nextEtapa, updatedContext, extras);
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || 'Olá' }]
    });

    const responseText = response.content[0].text.trim();

    if (lgpdAccepted) {
        // BUG-30: nome_coletado já chega tipado e normalizado por classificarNome
        // — a segunda validação que existia aqui (reusando pareceNome, a mesma
        // função que produziu o erro do BUG-30) foi removida.
        // BUG-89: leituras trocadas de `context` (o que ENTROU no turno) para
        // `updatedContext` (o que foi decidido NESTE turno). Em recep_nome_pos_lgpd
        // o nome é capturado no mesmo turno em que lgpdAccepted vira true — só
        // existe em updatedContext. Como updatedContext = {...context, ...} em
        // todos os ramos, ler dele nunca perde informação que ler de context teria.
        await updateUser(user.id, {
            name: updatedContext.nome_coletado || null,
            onboarded: true,
            lgpd_accepted: true,
            lgpd_accepted_at: updatedContext.lgpd_aceito_em || new Date().toISOString()
        });

        // MH-072 Parte A: onboarding não termina mais aqui — segue para a coleta de
        // data de nascimento, logo após o aceite da LGPD e antes do cadastro de
        // medicamento. definirEstadoPosOnboarding() (agora com chamador único, em
        // data_nascimento.js) decide adding_med vs. post_onboarding só ao FECHAR
        // aquele fluxo (com o dado gravado ou por recusa).
        await saveConversationState(user.id, {
            state: 'coletando_nascimento',
            context: {
                etapa: 'nasc_dia',
                dia: null, mes: null, ano: null,
                mensagem_inicial: updatedContext.mensagem_inicial || '',
                tentativas_indeterminado: 0
            }
        });
        console.log(`🎂 Recepcionista: onboarding aceito — roteando para coleta de data de nascimento (${user.phone})`);

    } else if (lgpdRecusado) {
        // Correção 4: recusa explícita — encerra com dignidade, não bloqueia retorno
        await saveConversationState(user.id, { state: 'lgpd_recusado', context: { etapa: 'lgpd_recusado' } });
        console.log(`ℹ️  Recepcionista: LGPD recusada por ${user.phone}`);

    } else {
        await saveConversationState(user.id, { state: nextEtapa, context: updatedContext });
    }

    return responseText;
}
