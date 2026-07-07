// ============================================================
// TEMPLATES DETERMINÍSTICOS — ADESÃO AO TRATAMENTO
// Texto literal aprovado por Guilherme (BRIEFING_ADESAO_AO_TRATAMENTO.md, seção 4;
// BRIEFING_APRESENTACAO_V2.md, seções 2/3/4 — tom, formatação, saudação condicional).
// Não parafrasear. [Nome], [Taxa] etc. são placeholders substituídos em tempo de execução.
// Módulo só de dados + funções puras — sem I/O.
// ============================================================

// ------------------------------------------------------------
// 4.2 — Espinha dorsal semanal: jornada faixa × semana
// ------------------------------------------------------------
const TEMPLATES_SEMANAL = {
    '100': [
        `Olá, [Nome]! Passando para te dar os parabéns! 🎉 Sua taxa de adesão nesta semana foi de 100%. Você está priorizando a sua saúde e agindo como alguém que realmente se cuida. Continue assim!`,
        `Incrível, [Nome]! Mais uma semana com 100% de sucesso! 🚀 No mundo dos hábitos, o mais importante é não quebrar a corrente da consistência. Você está no caminho certo para o seu bem-estar!`,
        `100% de novo, [Nome]? Que orgulho! 🌟 Seu cérebro adora essa previsibilidade. Que tal aproveitar que esse hábito já está consolidado e celebrar fazendo algo que você gosta hoje? Você merece!`,
        `Fechamos o mês com chave de ouro, [Nome]: 100% de adesão! 💎 Tomar sua medicação já está se tornando parte automática do seu dia. Parabéns pela disciplina e pelo carinho com você mesmo.`
    ],
    '80_99': [
        `Parabéns pelo resultado, [Nome]! Sua adesão foi de [Taxa]%. Muito perto da meta! 👏 Para te ajudar a fechar os 100% na próxima, que tal deixar a cartela/frasco em um lugar bem visível, do lado de algo que você usa todo dia (como a escova de dentes)?`,
        `Olá, [Nome]! Sua taxa foi de [Taxa]% esta semana. Ótimo trabalho! Para não esquecer os detalhes, tente a técnica do empilhamento: diga para si mesmo "Logo após [Hábito Atual, ex: tomar café], eu vou tomar meu medicamento". Funciona muito!`,
        `Muito bem, [Nome]! Você alcançou [Taxa]% de adesão. Para facilitar o seu "eu do futuro", que tal separar as doses da semana em uma caixinha organizadora de remédios hoje? Reduzir esse pequeno esforço ajuda muito!`,
        `Boa semana, [Nome]! Sua adesão ficou em [Taxa]%. Excelente! Lembre-se de uma regra de ouro dos hábitos: falhar uma vez é um acidente, falhar duas vezes seguidas é o começo de um novo mau hábito. Se perder uma dose, foque tudo para não perder a próxima!`
    ],
    '50_79': [
        `Olá, [Nome]! Analisei sua taxa e ficamos em [Taxa]% esta semana. Vamos ajustar essa rotina juntos? Se o remédio fica guardado na gaveta, o cérebro esquece. Que tal tirá-lo do armário e deixá-lo em cima da mesa de cabeceira ou da mesa de jantar hoje mesmo?`,
        `Oi, [Nome]! Sua adesão foi de [Taxa]%. Está na média, mas podemos melhorar para garantir seu bem-estar. Uma dica de ouro: use uma caixinha organizadora dividida por dias da semana (Seg a Dom). Só de olhar para ela, você já sabe visualmente se tomou ou não. Bora testar?`,
        `Olá, [Nome]! Tivemos [Taxa]% de adesão. Percebeu se as falhas acontecem mais no meio da correria ou no fim de semana? Tente ancorar o remédio a um hábito que nunca muda, como almoçar ou ligar o computador para trabalhar. Me conta se deu certo!`,
        `Oi, [Nome]! Fechamos a semana com [Taxa]%. Para facilitar o processo, tente deixar um copo d'água sempre pronto no local onde você costuma tomar o remédio. Quanto menos passos você precisar dar na hora de tomar, mais fácil fica o hábito!`
    ],
    'abaixo_50': [
        `Olá, [Nome], estou aqui para cuidar de você. Notei que sua adesão ficou em [Taxa]% esta semana. Vamos conversar? Os horários atuais estão muito difíceis para a sua rotina? Se precisar, fale com seu médico para ajustar os horários, e depois me avise aqui para mudarmos o nosso plano!`,
        `Oi, [Nome]! Sua adesão ficou em [Taxa]%. Quero entender melhor: você acabou não tomando o medicamento ou tomou mas achou difícil entrar aqui no WhatsApp para confirmar? Me conta, seu feedback me ajuda a deixar nosso espaço mais simples para você.`,
        `Olá, [Nome]. Preocupado com a sua saúde, vi que nossa taxa ficou em [Taxa]%. Para melhorarmos juntos na próxima semana, o que você acha que mais ajudaria? Mudar o horário das minhas mensagens? Deixar o remédio em um lugar mais visível na sua casa? Me diz o que prefere ou me dê sua sugestão!`,
        `Oi, [Nome], estou aqui com você. Tivemos [Taxa]% de adesão. Não desanime, construir novos hábitos leva tempo! Vamos recomeçar do básico? Hoje, o seu único objetivo é colocar o medicamento do lado do seu prato ou do seu café da manhã. Vamos focar em acertar o dia de amanhã, um passo de cada vez. Fechado?`
    ]
};

// ------------------------------------------------------------
// 4.3 — Espinha dorsal mensal: fechamento de 30 dias (3 variações por faixa)
// Texto revisado (tom/formatação) — BRIEFING_APRESENTACAO_V2.md, seção 2.1.
// Mantém "Olá, [Nome]!" fixo — não entra na saudação condicional (envio automático).
// ------------------------------------------------------------
const TEMPLATES_MENSAL = {
    '100': [
        `Olá, [Nome]! ❤️\nPassando para contar que fechamos o nosso mês!\nA sua taxa de adesão foi de 100%! 🎉\nQue orgulho ver o seu compromisso com você. Um mês inteirinho cuidando da saúde com tanta dedicação é uma vitória gigante!`,
        `[Nome], você completou o mês com 100% de sucesso! 🚀\nEsse resultado maravilhoso mostra que tomar seus medicamentos já virou uma parte natural do seu dia a dia.\nParabéns por esse cuidado tão bonito com a sua vida! ✨`,
        `Que notícia linda para fechar o mês, [Nome]! 😍\nTivemos 100% das suas doses confirmadas! 💎\nVocê protegeu a sua saúde todos os dias deste mês. Parabéns por esse carinho constante com você!`
    ],
    '80_99': [
        `Olá, [Nome]! 🌟\nOlhando para os últimos 30 dias, sua taxa de adesão foi de [Taxa]%.\nQue resultado excelente! 👏\nVocê esteve super perto de acertar todas as doses. No próximo mês, vamos continuar de mãos dadas para manter esse ritmo ótimo!`,
        `[Nome], fechamos o mês com [Taxa]% de adesão! Muito bom mesmo! 🌸\nPara facilitar ainda mais no mês que vem, que tal deixar a cartela bem visível ao lado de algo que você já usa todo dia de manhã?\nPode ser do lado da escova de dentes ou da garrafa de água! 💧`,
        `Oi, [Nome]! Passando para contar que sua adesão deste mês ficou em [Taxa]%. 🎉\nParabéns pela regularidade!\nDeixar o ambiente preparado e os remédios fáceis de pegar ajuda muito a não pular nenhuma dose nos dias mais corridos. Conte sempre comigo! 🥰`
    ],
    '50_79': [
        `Olá, [Nome]! 😊\nAnalisei o nosso último mês e sua taxa de adesão ficou em [Taxa]%.\nVocê se dedicou, mas sei bem que o dia a dia pode ser confuso.\nPara o próximo mês, uma dica simples é tirar os remédios do armário ou da gaveta e deixá-los bem à vista na mesa da cozinha ou na cabeceira da cama! 🛏️`,
        `Oi, [Nome]! Fechamos o mês com [Taxa]% de adesão. 🌻\nEstamos no caminho, mas podemos deixar essa rotina mais leve para você.\nUma ideia que ajuda muito é usar aquelas caixinhas organizadoras divididas pelos dias da semana.\nFica bem mais fácil de controlar e olhar! 📅`,
        `Olá, [Nome]! Sua adesão nos últimos 30 dias foi de [Taxa]%. 💕\nPara ajudar a lembrar com mais facilidade no próximo mês, tente combinar o remédio com algo que você já faz todo dia sem falta.\nPor exemplo: tomar logo após o café da manhã ou logo após o almoço! ☕`
    ],
    'abaixo_50': [
        `Olá, [Nome]! Estou aqui para apoiar você de pertinho. ❤️\nOlhando o nosso fechamento do mês, sua adesão ficou em [Taxa]%.\nNão desanime, criar uma nova rotina leva tempo e os primeiros passos são os mais desafiadores.\nEstou aqui para caminhar junto com você, um dia de cada vez! 🌱`,
        `Oi, [Nome]. Pensando no seu bem-estar e no seu carinho, vi que nossa taxa mensal ficou em [Taxa]%. 🩹\nQuero muito ajudar a deixar esse processo mais simples e tranquilo para a sua vida.\nVamos recomeçar com calma no próximo mês, focando em dar um passo pequeno por dia para proteger a sua saúde! 🌤️`,
        `Olá, [Nome]! Fechamos o mês com [Taxa]% de adesão. 🤝\nMinha intenção por aqui é ser um suporte acolhedor na sua rotina, sem nenhuma cobrança.\nVamos seguir em frente com otimismo e buscar formas bem fáceis de incluir esse cuidado no seu dia. Seu bem-estar é o mais importante! 🌿`
    ]
};

// ------------------------------------------------------------
// 4.4 — Blocos aditivos (texto revisado — BRIEFING_APRESENTACAO_V2.md, seção 2.2/2.3/2.4)
// ------------------------------------------------------------
const BLOCOS_MOTIVO = {
    nao_informado: [
        `💬 Percebi que muitas das suas doses ficaram sem confirmação por aqui. Para facilitar, verifique se as notificações das minhas mensagens estão chegando para você! Estou aqui pra te ajudar! 😄`,
        `📱 Notei que boa parte das doses ficou sem resposta no WhatsApp. Se você estiver tomando certinho e só não conseguir responder, tente deixar a nossa conversa fixada no topo da tela para facilitar!`
    ],
    nao_tomado: [
        `💧 Vi que em alguns dias você acabou ficando sem tomar o medicamento. Uma dica amiga para ajudar é deixar um copo de água sempre pronto e abastecido bem do lado do seu remédio.`,
        `☀️ Notei que algumas doses não foram tomadas no período. Não se preocupe se falhar um dia, o mais importante é focar a atenção para conseguir tomar o remédio certinho no dia seguinte e recuperar o ritmo!`
    ],
    sem_estoque: [
        `🛒 A maior parte das doses perdidas aconteceu porque o medicamento acabou. Eu vou sempre te enviar alertas de estoque antes dos seus remédios acabarem! Assim que receber a mensagem, já providencie a recompra!`,
        `📦 Vi que o estoque do seu remédio acabou no período. Para não interromper o tratamento, uma alternativa prática é pedir para alguém buscar na farmácia ou pedir para te entregarem em casa um pouquinho antes do frasco esvaziar!`
    ]
};

const BLOCOS_TURNO = {
    manha: [
        `🌅 Reparei que o período da manhã, no comecinho do dia, é o momento em que você encontra mais dificuldades com o medicamento.`,
        `☀️ Notei que as primeiras horas da manhã estão sendo o horário mais desafiador para conseguir tomar as doses.`
    ],
    tarde: [
        `🌤️ Percebi que o turno da tarde é o momento em que fica um pouco mais difícil de acompanhar e confirmar as doses.`,
        `🕒 O período da tarde tem sido o horário em que os compromissos do meio do dia mais atrapalham as suas confirmações.`
    ],
    noite: [
        `🌙 Notei que o período da noite é onde está acontecendo a maior parte das doses não confirmadas.`,
        `🌌 Parece que o turno da noite, no cansaço do fim do dia, está sendo o momento em que fica mais difícil manter a regularidade.`
    ]
};

const BLOCOS_TENDENCIA = {
    subiu: [
        `📈 E olha que conquista linda: sua adesão subiu de [TaxaAnterior]% para [TaxaAtual]%! Você está melhorando muito a cada dia!`,
        `✨ Que evolução maravilhosa! Sua taxa subiu comparada ao período anterior (de [TaxaAnterior]% para [TaxaAtual]%). Parabéns por todo o esforço!`
    ],
    caiu: [
        `📉 Sua taxa oscilou um pouquinho em relação ao período anterior, indo de [TaxaAnterior]% para [TaxaAtual]%. Fique em paz, essas variações são normais quando estamos nos acostumando com uma rotina nova!`,
        `🍃 Tivemos uma leve queda comparado ao período passado, de [TaxaAnterior]% para [TaxaAtual]%. Vamos encarar isso como uma chance de deixar os remédios em um lugar ainda mais fácil nos próximos dias!`
    ],
    estavel: [
        `🔍 Sua taxa se manteve firme e estável em [TaxaAtual]%, igualzinho ao período anterior. Manter a regularidade já é uma grande vitória!`,
        `⚖️ Você manteve a sua constância! Sua adesão continuou estável em [TaxaAtual]%. Seguimos no mesmo caminho firme cuidando da sua saúde!`
    ]
};

const MARCO_TEMPLATE = `🏆 E temos um marco histórico por aqui: esta é a sua primeira vez alcançando os 100%! O melhor resultado registrado desde que começamos!`;

// ------------------------------------------------------------
// 4.5 — Progresso do tratamento (texto revisado — BRIEFING_APRESENTACAO_V2.md, seção 4)
// Sem saudação embutida — concatenada condicionalmente por quem chama (relatorios.js).
// ------------------------------------------------------------
const TEMPLATES_PROGRESSO = {
    inicio: `Vim te mostrar como está o começo do seu tratamento com [Medicamento]. 🌱\nVocê está no dia [DiasDecorridos] de [TratamentoDias] — ainda bem no comecinho da jornada!\nAo todo, restam [DiasRestantes] dias e [DosesRestantes] doses até o fim.\n[BlocoEstoque]`,
    meio: `Seu tratamento com [Medicamento] já está na metade do caminho! 🌤️\nVocê está no dia [DiasDecorridos] de [TratamentoDias].\nFaltam [DiasRestantes] dias e [DosesRestantes] doses para concluir.\n[BlocoEstoque]`,
    final: `Estamos quase lá com o [Medicamento]! 🥰\nVocê já está no dia [DiasDecorridos] de [TratamentoDias] — faltam só [DiasRestantes] dias e [DosesRestantes] doses pra terminar.\nContinue firme, você está mandando bem! 💪\n[BlocoEstoque]`
};

const BLOCO_ESTOQUE = {
    suficiente: `✅ Seu estoque atual, de [Estoque] unidades, é suficiente pra terminar o tratamento tranquilamente.`,
    insuficiente: `⚠️ Um aviso: seu estoque atual dá pra mais [DiasCobertos] dias — mas ainda faltam [DiasRestantes] dias de tratamento. Vale a pena providenciar mais em breve, pra não interromper o cuidado! 💊`
};

const FALLBACK_CONTINUO = `Como o seu medicamento é de uso contínuo, ele não tem uma data de término ou um número de dias pra acabar, sabe? ✨\nEle faz parte do seu cuidado diário com a saúde a longo prazo.\nMas se você quiser, posso te mostrar sua taxa de adesão e ver como está a sua regularidade nos últimos tempos. Quer dar uma olhada? 📊`;

// ------------------------------------------------------------
// 4.6 — Fluxo de escolha de período (sem saudação embutida)
// ------------------------------------------------------------
const PERGUNTA_PERIODO = `Posso gerar o seu relatório de adesão agora mesmo. 📝\nPara qual período você gostaria de olhar?\nÚltimos 7 dias\nÚltimos 15 dias\nÚltimos 30 dias\nÉ só me dizer o período que você prefere! 👍`;

const RECUSA_PERIODO = `Peço desculpas! 🌸\nComo ainda estou aprendendo e em constante desenvolvimento, hoje eu só consigo calcular a sua adesão nesses três períodos fechados: últimos 7, 15 ou 30 dias.\nGostaria de escolher um desses três para darmos uma olhadinha hoje?`;

// ============================================================
// FUNÇÕES
// ============================================================

function substituir(texto, valores) {
    let resultado = texto;
    for (const [chave, valor] of Object.entries(valores)) {
        resultado = resultado.split(`[${chave}]`).join(valor);
    }
    return resultado;
}

function sortear(opcoes) {
    return opcoes[Math.floor(Math.random() * opcoes.length)];
}

export function escolherFaixa(percentual) {
    if (percentual >= 100) return '100';
    if (percentual >= 80) return '80_99';
    if (percentual >= 50) return '50_79';
    return 'abaixo_50';
}

export function montarMensagemSemanal({ nome, taxa, faixa, semana }) {
    const semanaValida = Math.min(Math.max(semana, 1), 4);
    const template = TEMPLATES_SEMANAL[faixa][semanaValida - 1];
    return substituir(template, { Nome: nome, Taxa: taxa });
}

export function montarMensagemMensal({ nome, taxa, faixa }) {
    const template = sortear(TEMPLATES_MENSAL[faixa]);
    return substituir(template, { Nome: nome, Taxa: taxa });
}

export function montarBlocoMotivo(motivo) {
    return sortear(BLOCOS_MOTIVO[motivo]);
}

export function montarBlocoTurno(turno) {
    return sortear(BLOCOS_TURNO[turno]);
}

export function montarBlocoTendencia(tipo, { taxaAnterior, taxaAtual }) {
    const template = sortear(BLOCOS_TENDENCIA[tipo]);
    return substituir(template, { TaxaAnterior: taxaAnterior, TaxaAtual: taxaAtual });
}

export function montarBlocoMarco() {
    return MARCO_TEMPLATE;
}

export function montarBlocoEstoque({ suficiente, estoque, diasRestantes, diasCobertos }) {
    const template = suficiente ? BLOCO_ESTOQUE.suficiente : BLOCO_ESTOQUE.insuficiente;
    return substituir(template, { Estoque: estoque, DiasRestantes: diasRestantes, DiasCobertos: diasCobertos });
}

export function escolherFaseProgresso(percentualDecorrido) {
    if (percentualDecorrido < 33) return 'inicio';
    if (percentualDecorrido <= 66) return 'meio';
    return 'final';
}

export function montarMensagemProgresso({ medicamento, diasDecorridos, tratamentoDias, diasRestantes, dosesRestantes, blocoEstoque, fase }) {
    const template = TEMPLATES_PROGRESSO[fase];
    return substituir(template, {
        Medicamento: medicamento,
        DiasDecorridos: diasDecorridos,
        TratamentoDias: tratamentoDias,
        DiasRestantes: diasRestantes,
        DosesRestantes: dosesRestantes,
        BlocoEstoque: blocoEstoque
    });
}

export function montarFallbackContinuo() {
    return FALLBACK_CONTINUO;
}

export function montarResumoCompacto(progressos) {
    const linhas = progressos.map(p =>
        `💊 *${p.nome}* — dia ${p.diasDecorridos} de ${p.tratamentoDias}, ${p.diasRestantes} dias restantes`
    ).join('\n');

    return `Aqui está o progresso dos seus tratamentos: 💊\n\n${linhas}\n\nQuer detalhes de algum específico? É só me dizer o nome! 😊`;
}

export function montarPerguntaPeriodo() {
    return PERGUNTA_PERIODO;
}

export function montarRecusaPeriodo() {
    return RECUSA_PERIODO;
}
