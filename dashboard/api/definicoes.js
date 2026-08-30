// ============================================================
// DEFINIÇÕES CANÔNICAS — ponto único (BRIEFING_MH009_DASHBOARD.md §4).
//
// Toda regra de negócio do dashboard mora aqui: SQL fragments e helpers. Nenhuma rota
// reescreve nenhuma delas. Qualquer painel que precise de uma destas noções importa
// daqui — o mesmo espírito do Princípio 30 (ponto único) aplicado ao dashboard.
// ============================================================

import { formatarQuantidadeDose, normalizarFormaFarmaceutica } from '../../src/templates/dose.js';
import { CAPACIDADES, NAO_SUPORTADO } from '../../src/inventario.js';

export { formatarQuantidadeDose, normalizarFormaFarmaceutica, CAPACIDADES, NAO_SUPORTADO };

// §4.2 — timestamps são gravados em UTC; todo agrupamento por dia converte antes de truncar.
export const DIA_BRASILIA_SQL = (coluna) => `(${coluna} AT TIME ZONE 'America/Sao_Paulo')::date`;

// §4.5 — fronteira de ciclo. Constante única: toda série que atravessa esta data marca a
// fronteira e expõe os dois períodos separados. O Ciclo 1 nunca é apresentado como
// referência, meta ou linha de comparação do Ciclo 2 (§9.2 do briefing).
export const FRONTEIRA_CICLO = '2026-08-30';

// §4.10 — janelas de início real por tabela. O atalho "desde o início" significa datas
// diferentes conforme o painel; cada painel exibe a sua.
export const INICIO_TABELA = {
  users: '2026-06-05',
  agent_logs: '2026-06-05',
  dose_logs: '2026-06-05',
  system_events: '2026-07-27',
  eventos_proativos: '2026-08-01',
  feedbacks: '2026-07-27'
};

// §6.1 — corte de leitura do painel de degradação (antes disso não é considerado sinal
// confiável de produção).
export const INICIO_DEGRADACAO = '2026-08-01';

// §4.5 — status de dose_logs que entram em métricas de adesão (desfechos). `pendente`
// (estado vivo) e `pausado` (interrupção por remoção de horário, não desfecho) ficam fora.
export const STATUS_ADESAO_VALIDOS = ['confirmado', 'nao_informado', 'sem_estoque', 'nao_tomado'];

// §4.6 — confirmação retroativa é definida pelo PAR, nunca pelo booleano `revertido`
// sozinho: `revertido = true` isolado devolve quatro fenômenos distintos.
export const CONDICAO_RETROATIVA_SQL =
  `d.revertido IS TRUE AND d.revertido_de = 'nao_informado' AND d.status = 'confirmado'`;

// §6.1 — tipos de system_events que compõem "sinais de degradação". `intencao_nao_suportada`
// fica de fora deliberadamente: é sinal de demanda de produto, não falha técnica, e vive na
// Visão Feedback (corrente 2).
export const TIPOS_DEGRADACAO = ['erro_tecnico', 'desvio_comportamental'];

// §6.2 Bloco 1 — capacidades acionáveis pelo usuário (o ranking propriamente dito).
export const AGENTES_ACIONAVEIS = ['cadastro', 'relatorios', 'configuracao', 'principal'];

// §6.2 Bloco 2 — caminhos de sistema e onboarding, contados sem ranking.
export const AGENTES_SISTEMA = ['recepcionista', 'data_nascimento', 'fast_path_resposta_tardia', 'erro'];

// §4.8 — faixas semiabertas de horários por medicamento (razão é fracionária).
export function faixaHorariosPorMedicamento(razao) {
  if (razao < 2) return '1 a menos de 2';
  if (razao < 3) return '2 a menos de 3';
  if (razao < 4) return '3 a menos de 4';
  return '4 ou mais';
}

// §7.7 — faixas de medicamentos ativos por usuário.
export function faixaMedicamentosPorUsuario(n) {
  if (n === 1) return '1';
  if (n === 2) return '2';
  if (n === 3) return '3';
  return '4 ou mais';
}

// §11 — limiar de cobertura de idade abaixo do qual um indicador renderiza como
// `hipotese` (âmbar) em vez de `dado_verificado`.
export const LIMIAR_COBERTURA_IDADE = 0.6;

export function estadoEpistemicoCobertura(cobertos, total) {
  if (!total) return 'hipotese';
  return (cobertos / total) >= LIMIAR_COBERTURA_IDADE ? 'dado_verificado' : 'hipotese';
}

// Faixas etárias de primeira classe, na ordem de exibição — `nao_informado` nunca é
// omitida de um gráfico (Princípio 49: null não é 0).
export const ORDEM_FAIXAS_ETARIAS = ['menor_20', '20_29', '30_49', '50_59', '60_69', '70_mais', 'nao_informado'];

export const ROTULO_FAIXA_ETARIA = {
  menor_20: 'menor de 20',
  '20_29': '20 a 29',
  '30_49': '30 a 49',
  '50_59': '50 a 59',
  '60_69': '60 a 69',
  '70_mais': '70 ou mais',
  nao_informado: 'não informado'
};

// Preenche faixas ausentes com zero, na ordem canônica — garante que `nao_informado`
// sempre apareça mesmo quando a consulta não devolveu nenhuma linha para ela.
export function completarFaixasEtarias(linhas, chaveFaixa = 'faixa', chaveValor = 'n') {
  const porFaixa = Object.fromEntries(linhas.map(l => [l[chaveFaixa], l[chaveValor]]));
  return ORDEM_FAIXAS_ETARIAS.map(faixa => ({
    faixa,
    rotulo: ROTULO_FAIXA_ETARIA[faixa],
    [chaveValor]: porFaixa[faixa] ?? 0
  }));
}
