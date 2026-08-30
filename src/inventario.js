// ============================================================
// INVENTÁRIO DE CAPACIDADES — ponto único (MH-009, Princípio 55).
//
// O que a Nami faz e o que ela ainda não faz existia em três lugares divergentes:
// router.js (classificador central), configuracao.js (ações de configuração) e
// prompts.js (narrativa ao usuário). Aqui é dado, não texto de prompt — os três
// pontos montam sua seção a partir deste módulo. Capacidade adicionada ou removida
// atualiza este arquivo na mesma mudança (mesma disciplina do Princípio 5).
//
// Também é a Corrente 3 da Visão Feedback do dashboard (BRIEFING_MH009 §10.1):
// o que a Nami faz, ao lado do que os usuários pediram e não obtiveram.
// ============================================================

export const CAPACIDADES = [
  {
    agente: 'cadastro',
    titulo: 'Cadastro de medicamentos',
    descricao: 'cadastrar novo medicamento, iniciar novo tratamento',
    resumoUsuario: 'lembrar de tomar remédio no horário certo'
  },
  {
    agente: 'relatorios',
    titulo: 'Relatórios e consultas',
    descricao: 'consultar o que foi tomado ou faltou em um dia (hoje, ontem ou dia nomeado), ' +
      'doses tomadas, adesão, estoque, próximos remédios, horários cadastrados, progresso do tratamento',
    resumoUsuario: 'avisar quando o estoque está acabando, e mostrar o histórico e a adesão ao tratamento',
    subtipos: [
      {
        chave: 'balanco_do_dia',
        descricao: 'o que foi tomado / o que faltou / o que ficou pendente em um dia ' +
          '(hoje, ontem, ou um dia nomeado). Use este subtipo para perguntas como "tomei meus ' +
          'remédios hoje?", "faltou algum remédio ontem?", "esqueci de tomar alguma coisa?", ' +
          '"ficou alguma dose pendente?", "pulei algum remédio no domingo?"'
      },
      { chave: 'meus_remedios', descricao: 'listar medicamentos cadastrados e seus horários' },
      { chave: 'estoque', descricao: 'consultar quantidade em estoque' },
      { chave: 'proximo_remedio', descricao: 'qual remédio tomar agora/a seguir' },
      {
        chave: 'adesao',
        descricao: 'taxa de adesão agregada de um período (7, 15 ou 30 dias). Use SOMENTE quando ' +
          'o usuário pedir explicitamente um percentual, uma taxa, ou um resumo de vários dias. ' +
          'Pergunta sobre UM dia específico é sempre balanco_do_dia, nunca adesao.'
      },
      { chave: 'progresso_tratamento', descricao: 'quantos dias/doses faltam para o tratamento acabar' }
    ]
  },
  {
    agente: 'configuracao',
    titulo: 'Configuração de tratamento',
    descricao: 'pausar, reativar, encerrar tratamento; alterar/remover/adicionar/redefinir horário de lembrete'
  },
  {
    agente: 'principal',
    titulo: 'Conversa geral e confirmação de doses',
    descricao: 'conversa geral, dúvidas, saudações, reações ("ok", "obrigado"), fechamentos, ' +
      'confirmação de doses, confirmação retroativa de doses (últimos 2 dias), reversão de ' +
      'confirmação por engano, correção/atualização de estoque (recompra, recontagem, perda)',
    resumoUsuario: 'registrar quando ele confirma que tomou'
  },
  {
    agente: 'excluir_conta',
    titulo: 'Exclusão de conta',
    descricao: 'o usuário quer EXCLUIR A CONTA dele / apagar TODOS os dados dele da Nami / se ' +
      'descadastrar por completo da Nami. Ex: "quero excluir minha conta", "apaga todos os meus ' +
      'dados", "quero me descadastrar da Nami", "cancelar meu cadastro na Nami", "não quero mais ' +
      'usar a Nami, pode apagar tudo". NÃO confundir com: excluir/remover UM remédio, lembrete ou ' +
      'horário (isso é configuracao); nem com cancelar um cadastro de medicamento em andamento ' +
      '(isso NÃO é exclusão de conta — geralmente é abortar o fluxo de cadastro).'
  }
];

// Conjunto fechado — pedidos que a Nami classifica como "nao_suportado". Os três primeiros
// (tratamento/dosagem/nome do medicamento) são também os únicos relevantes para o agente
// configuracao, que os referencia por fatia (ver configuracao.js).
export const NAO_SUPORTADO = [
  'alterar tempo/duração de tratamento',
  'alterar dosagem de um medicamento',
  'alterar nome de um medicamento',
  'registrar sintomas, pressão, glicemia ou outros dados de saúde',
  'falar com médico, agendar consulta',
  'exportar histórico em arquivo'
];
