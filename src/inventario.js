// ============================================================
// INVENTÁRIO DE CAPACIDADES EM TRÊS LISTAS — ponto único (P55, v44 §5.9)
//
// FAZ (CAPACIDADES, com LIMITES explícitos por entrada) · AINDA_NAO ·
// NUNCA. O limite é parte da capacidade — foi a ausência dele que deixou
// "recorrência semanal" no vazio entre as listas (evidência A3, Manô 18/09).
//
// É dado, não texto de prompt: consumido pela porta (portão de composição:
// nenhuma mensagem confirma o que não mapeia para uma entrada do FAZ dentro
// do limite), por prompts.js, configuracao.js e pelo dashboard (Corrente 3).
// Capacidade adicionada ou removida atualiza este arquivo na mesma mudança.
//
// Posturas (Constituição regra 6):
//   FAZ       → executa.
//   AINDA_NAO → honestidade + expectativa ("está chegando").
//   NUNCA     → fronteira de segurança, SEM "ainda" — redireciona a
//               médico/farmacêutico; emergência → SAMU 192.
// ============================================================

export const CAPACIDADES = [
  {
    agente: 'cadastro',
    titulo: 'Cadastro de medicamentos',
    descricao: 'cadastrar novo medicamento, iniciar novo tratamento',
    resumoUsuario: 'lembrar de tomar remédio no horário certo',
    limites: 'MESMOS horários todos os dias (nunca horários por dia da semana); ' +
      'formas comprimido/cápsula/líquido (gotas/ml)/unidade; estoque opcional ' +
      '(contagem ou frascos); tratamento contínuo ou por X dias; um medicamento ' +
      'por mensagem (vários de uma vez ainda não)'
  },
  {
    agente: 'relatorios',
    titulo: 'Relatórios e consultas',
    descricao: 'consultar o que foi tomado ou faltou em um dia (hoje, ontem ou dia nomeado), ' +
      'doses tomadas, adesão, estoque, próximos remédios, horários cadastrados, progresso do tratamento',
    resumoUsuario: 'avisar quando o estoque está acabando, e mostrar o histórico e a adesão ao tratamento',
    limites: 'adesão agregada em janelas de 7, 15 ou 30 dias; balanço por dia-calendário',
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
    descricao: 'pausar, reativar, encerrar tratamento; alterar/remover/adicionar/redefinir horário de lembrete',
    limites: 'só horário e status do tratamento — dosagem, nome e duração de um ' +
      'medicamento já cadastrado ainda não podem ser alterados'
  },
  {
    agente: 'principal',
    titulo: 'Conversa geral e confirmação de doses',
    descricao: 'conversa geral, dúvidas, saudações, reações ("ok", "obrigado"), fechamentos, ' +
      'confirmação de doses, confirmação retroativa de doses (últimos 2 dias), reversão de ' +
      'confirmação por engano, correção/atualização de estoque (recompra, recontagem, perda)',
    resumoUsuario: 'registrar quando ele confirma que tomou',
    limites: 'confirmação retroativa só dos últimos 2 dias'
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

// AINDA NÃO FAZ — resposta: honestidade + expectativa ("está chegando").
// `escopo` marca a fatia consumida por um agente específico.
export const AINDA_NAO = [
  { chave: 'audio', rotulo: 'ouvir áudios' },
  { chave: 'foto', rotulo: 'entender fotos e imagens' },
  { chave: 'conectar_cuidador', rotulo: 'conectar um cuidador ou familiar' },
  { chave: 'horarios_por_dia_da_semana', rotulo: 'horários diferentes por dia da semana' },
  { chave: 'dia_sim_dia_nao', rotulo: 'remédio em dias alternados (dia sim, dia não)' },
  { chave: 'uma_vez_por_semana', rotulo: 'remédio 1x por semana' },
  { chave: 'multiplos_medicamentos', rotulo: 'vários medicamentos numa mensagem só (por enquanto, um por vez)' },
  { chave: 'alterar_dosagem', rotulo: 'alterar dosagem de um medicamento já cadastrado', escopo: 'configuracao' },
  { chave: 'alterar_nome', rotulo: 'alterar nome de um medicamento já cadastrado', escopo: 'configuracao' },
  { chave: 'alterar_duracao', rotulo: 'alterar tempo/duração de um tratamento já cadastrado', escopo: 'configuracao' },
  { chave: 'sintomas_medidas', rotulo: 'registrar sintomas, pressão, glicemia ou outros dados de saúde' },
  { chave: 'exportar_historico', rotulo: 'exportar histórico em arquivo' },
  { chave: 'falar_com_medico', rotulo: 'falar com médico, agendar consulta' },
  { chave: 'parada_automatica_uso_agudo', rotulo: 'parar lembretes sozinha no fim de um tratamento por X dias (campo existe; comportamento a confirmar no M2)' }
];

// NUNCA FARÁ — fronteira de segurança, SEM "ainda". Redireciona a
// médico/farmacêutico; emergência → SAMU 192.
export const NUNCA = [
  { chave: 'orientar_medicacao', rotulo: 'orientar sobre medicação' },
  { chave: 'indicar_remedio', rotulo: 'indicar ou recomendar remédios' },
  { chave: 'prescrever_ajustar_dose', rotulo: 'prescrever ou ajustar dose por decisão própria' },
  { chave: 'interpretar_sintomas_exames', rotulo: 'interpretar sintomas ou exames' },
  { chave: 'interacao_medicamentosa', rotulo: 'dizer se pode combinar um remédio com outro' },
  { chave: 'emergencia', rotulo: 'atender emergência (emergência é SAMU 192)' }
];

// Resposta honesta padrão para um item da lista AINDA_NAO (Constituição regra 6:
// honestidade + expectativa, nunca prometer o que não se executa neste turno).
export function respostaHonestaAindaNao(chave) {
  const item = AINDA_NAO.find(i => i.chave === chave);
  const rotulo = item ? item.rotulo : 'isso';
  return `Ainda não consigo ${rotulo} — é uma das coisas que estou aprendendo a fazer. 😊`;
}

// Compatibilidade: consumidores que enxergam o "ainda não" como lista plana de
// rótulos (porta, dashboard Corrente 3). Ponto único continua sendo AINDA_NAO.
export const NAO_SUPORTADO = AINDA_NAO.map(i => i.rotulo);
