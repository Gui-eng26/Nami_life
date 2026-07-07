// ============================================================
// TEMPLATES DETERMINÍSTICOS — ADESÃO AO TRATAMENTO
// Texto literal aprovado por Guilherme (BRIEFING_ADESAO_AO_TRATAMENTO.md, seção 4).
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
// ------------------------------------------------------------
const TEMPLATES_MENSAL = {
    '100': [
        `Olá, [Nome]! Fechamos o nosso mês e a sua taxa de adesão foi de 100%! 🎉 Que orgulho ver o seu compromisso com você. Um mês inteirinho cuidando da saúde com tanta constância é uma vitória gigante!`,
        `[Nome], você completou o mês com 100% de sucesso! 🚀 Esse resultado mostra que tomar seus medicamentos já virou uma parte natural do seu dia. Parabéns por esse cuidado tão bonito!`,
        `Que notícia maravilhosa para fechar o mês, [Nome]: 100% das doses confirmadas! 💎 Você protegeu a sua saúde todos os dias deste mês. Parabéns por esse carinho constante com você!`
    ],
    '80_99': [
        `Olá, [Nome]! Olhando para os últimos 30 dias, sua taxa de adesão foi de [Taxa]%. Que resultado excelente! 👏 Você esteve super perto de acertar todas as doses. No próximo mês, vamos continuar firmes para manter esse ótimo ritmo!`,
        `[Nome], fechamos o mês com [Taxa]% de adesão! Muito bom mesmo! Para facilitar ainda mais no mês que vem, que tal deixar a cartela bem visível ao lado de algo que você já usa todo dia de manhã, como a escova de dentes ou a garrafa de água?`,
        `Oi, [Nome]! Passando para contar que sua adesão deste mês ficou em [Taxa]%. Parabéns pela regularidade! Deixar o ambiente preparado e os remédios fáceis de pegar ajuda muito a não pular nenhuma dose na correria. Conte comigo!`
    ],
    '50_79': [
        `Olá, [Nome]! Analisei o nosso último mês e sua taxa de adesão ficou em [Taxa]%. Você se dedicou, mas sei que o dia a dia pode ser corrido. Para o próximo mês, uma dica simples é tirar os remédios do armário ou da gaveta e deixá-los bem à vista na mesa da cozinha ou na cabeceira.`,
        `Oi, [Nome]! Fechamos o mês com [Taxa]% de adesão. Estamos no caminho, mas podemos deixar essa rotina mais leve. Uma ideia que ajuda muito é usar aquelas caixinhas organizadoras divididas pelos dias da semana. Fica bem mais fácil de controlar!`,
        `Olá, [Nome]! Sua adesão nos últimos 30 dias foi de [Taxa]%. Para ajudar a lembrar com mais facilidade no próximo mês, tente combinar o remédio com algo que você já faz todo dia sem falta, como logo após tomar o café da manhã ou logo após almoçar.`
    ],
    'abaixo_50': [
        `Olá, [Nome], estou aqui para apoiar você. Olhando o nosso fechamento do mês, sua adesão ficou em [Taxa]%. Não desanime, criar uma nova rotina leva tempo e os primeiros passos são os mais desafiadores. Estou aqui para caminhar junto com você, um dia de cada vez.`,
        `Oi, [Nome]. Pensando no seu bem-estar, vi que nossa taxa mensal ficou em [Taxa]%. Quero muito ajudar a deixar esse processo mais simples e tranquilo. Vamos recomeçar com calma no próximo mês, focando em dar um passo pequeno por dia para proteger a sua saúde.`,
        `Olá, [Nome]! Fechamos o mês com [Taxa]% de adesão. Minha intenção por aqui é ser um suporte acolhedor na sua rotina, sem cobranças. Vamos seguir em frente com otimismo e buscar formas mais fáceis de incluir esse cuidado no seu dia. Seu bem-estar é o mais importante.`
    ]
};

// ------------------------------------------------------------
// 4.4 — Blocos aditivos
// ------------------------------------------------------------
const BLOCOS_MOTIVO = {
    nao_informado: [
        `Percebi que muitas das suas doses ficaram sem confirmação por aqui. Para facilitar, verifique se está recebendo as minhas notificações no seu WhatsApp corretamente. Assim consigo te ajudar nas confirmações!`,
        `Notei que boa parte das doses ficou sem resposta no WhatsApp. Se você estiver tomando certinho e só não estiver conseguindo confirmar na mensagem, tente deixar a nossa conversa fixada na tela para facilitar.`
    ],
    nao_tomado: [
        `Vi que em alguns dias você acabou ficando sem tomar o medicamento. Uma dica para ajudar é deixar um copo de água sempre pronto e abastecido bem do lado do seu remédio.`,
        `Notei que algumas doses não foram tomadas no período. Não se preocupe se falhar um dia, o mais importante é focar toda a atenção para conseguir tomar o remédio certinho no dia seguinte e recuperar o ritmo.`
    ],
    sem_estoque: [
        `A maior parte das doses perdidas aconteceu porque o medicamento acabou. Aqui na nossa conversa eu sempre aviso quando seu remédio vai acabar com antecedência para você garantir a recompra!`,
        `Vi que o estoque do seu remédio acabou durante o período. Para não interromper o tratamento no mês que vem, uma alternativa prática é programar a compra ou pedir para alguém buscar na farmácia um pouquinho antes do frasco esvaziar.`
    ]
};

const BLOCOS_TURNO = {
    manha: [
        `Reparei que o período da manhã, no comecinho do dia, é o momento em que você encontra mais dificuldades com o medicamento.`,
        `Notei que as primeiras horas da manhã estão sendo o horário mais desafiador para conseguir tomar as doses.`
    ],
    tarde: [
        `Percebi que o turno da tarde é o momento em que fica um pouco mais difícil de acompanhar e confirmar as doses.`,
        `O período da tarde tem sido o horário em que os compromissos do meio do dia mais atrapalham as suas confirmações.`
    ],
    noite: [
        `Notei que o período da noite é onde está acontecendo a maior parte das doses não confirmadas.`,
        `Parece que o turno da noite, no cansaço do fim do dia, está sendo o momento em que fica mais difícil manter a regularidade.`
    ]
};

const BLOCOS_TENDENCIA = {
    subiu: [
        `E olha que conquista: sua adesão subiu de [TaxaAnterior]% para [TaxaAtual]%! Você está melhorando muito a cada dia!`,
        `Que evolução linda! Sua taxa subiu comparada ao período anterior (de [TaxaAnterior]% para [TaxaAtual]%). Parabéns por todo o esforço!`
    ],
    caiu: [
        `Sua taxa oscilou um pouquinho em relação ao período anterior, indo de [TaxaAnterior]% para [TaxaAtual]%. Fique em paz, essas variações são completamente normais quando estamos nos acostumando com uma rotina nova.`,
        `Tivemos uma leve queda comparado ao período passado, de [TaxaAnterior]% para [TaxaAtual]%. Vamos encarar isso como uma oportunidade para deixar os remédios em um lugar ainda mais fácil nos próximos dias.`
    ],
    estavel: [
        `Sua taxa se manteve firme e estável em [TaxaAtual]%, igualzinho ao período anterior. Manter a regularidade já é uma grande vitória!`,
        `Você manteve a sua constância! Sua adesão continuou estável em [TaxaAtual]%. Seguimos no mesmo caminho firme cuidando da saúde.`
    ]
};

const MARCO_TEMPLATE = `E temos um marco histórico por aqui: esta é a sua primeira vez alcançando os 100%! O melhor resultado registrado desde que começamos! 🏆`;

// ------------------------------------------------------------
// 4.5 — Progresso do tratamento
// ------------------------------------------------------------
const TEMPLATES_PROGRESSO = {
    inicio: `Olá, [Nome]! Vim te mostrar como está o começo do seu tratamento com [Medicamento]. Você está no dia [DiasDecorridos] de [TratamentoDias] — ainda no início da jornada! Ao todo, restam [DiasRestantes] dias e [DosesRestantes] doses até o fim. [BlocoEstoque]`,
    meio: `Olá, [Nome]! Seu tratamento com [Medicamento] já está na metade do caminho: dia [DiasDecorridos] de [TratamentoDias]. Faltam [DiasRestantes] dias e [DosesRestantes] doses para concluir. [BlocoEstoque]`,
    final: `Olá, [Nome]! Estamos quase lá com o [Medicamento] — você já está no dia [DiasDecorridos] de [TratamentoDias]. Faltam só [DiasRestantes] dias e [DosesRestantes] doses pra terminar. Continue firme! 🥰 [BlocoEstoque]`
};

const BLOCO_ESTOQUE = {
    suficiente: `Seu estoque atual, de [Estoque] unidades, é suficiente para terminar o tratamento tranquilamente.`,
    insuficiente: `Um aviso importante: com [Estoque] unidades no estoque, seu remédio cobre só mais alguns dias — mas ainda faltam [DiasRestantes] dias de tratamento. Vale a pena providenciar mais em breve, pra não interromper o cuidado! 💊`
};

const FALLBACK_CONTINUO = `Olá, [Nome]! Como o seu medicamento é de uso contínuo, ele não tem uma data de término ou um número de dias para acabar, sabe? Ele faz parte do seu cuidado diário com a saúde a longo prazo.\nMas se você quiser, posso gerar agora um relatório para te mostrar a sua taxa de adesão e ver como está a sua regularidade nos últimos tempos. Deseja dar uma olhada?`;

// ------------------------------------------------------------
// 4.6 — Fluxo de escolha de período
// ------------------------------------------------------------
const PERGUNTA_PERIODO = `Claro, [Nome]! Posso gerar o seu relatório de adesão agora mesmo. Para qual período você gostaria de olhar?\nÚltimos 7 dias\nÚltimos 15 dias\nÚltimos 30 dias\nÉ só me dizer o período que você prefere!`;

const RECUSA_PERIODO = `Ah, [Nome], peço desculpas! Como ainda estou aprendendo e em constante desenvolvimento, hoje eu só consigo calcular a sua adesão nesses três períodos fechados: últimos 7, 15 ou 30 dias.\nGostaria de escolher um desses três para darmos uma olhadinha hoje? Se preferir deixar para depois, está tudo bem também, é só me avisar!`;

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

export function montarBlocoEstoque({ suficiente, estoque, diasRestantes }) {
    const template = suficiente ? BLOCO_ESTOQUE.suficiente : BLOCO_ESTOQUE.insuficiente;
    return substituir(template, { Estoque: estoque, DiasRestantes: diasRestantes });
}

export function escolherFaseProgresso(percentualDecorrido) {
    if (percentualDecorrido < 33) return 'inicio';
    if (percentualDecorrido <= 66) return 'meio';
    return 'final';
}

export function montarMensagemProgresso({ nome, medicamento, diasDecorridos, tratamentoDias, diasRestantes, dosesRestantes, blocoEstoque, fase }) {
    const template = TEMPLATES_PROGRESSO[fase];
    return substituir(template, {
        Nome: nome,
        Medicamento: medicamento,
        DiasDecorridos: diasDecorridos,
        TratamentoDias: tratamentoDias,
        DiasRestantes: diasRestantes,
        DosesRestantes: dosesRestantes,
        BlocoEstoque: blocoEstoque
    });
}

export function montarFallbackContinuo(nome) {
    return substituir(FALLBACK_CONTINUO, { Nome: nome });
}

export function montarPerguntaPeriodo(nome) {
    return substituir(PERGUNTA_PERIODO, { Nome: nome });
}

export function montarRecusaPeriodo(nome) {
    return substituir(RECUSA_PERIODO, { Nome: nome });
}
