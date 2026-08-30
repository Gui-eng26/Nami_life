// Visão perfil dos usuários — BRIEFING_MH009 §7. Todos os painéis filtram is_teste = false
// (aplicado dentro das funções RPC chamadas aqui, ver migration MH-009).
import { Router } from 'express';
import { supabase } from '../db.js';
import { completarFaixasEtarias, estadoEpistemicoCobertura } from '../definicoes.js';

const router = Router();

function mediana(valoresOrdenados) {
  const n = valoresOrdenados.length;
  if (n === 0) return 0;
  const meio = Math.floor(n / 2);
  return n % 2 === 0 ? (valoresOrdenados[meio - 1] + valoresOrdenados[meio]) / 2 : valoresOrdenados[meio];
}

// Cobertura de idade: fração de usuários fora de `nao_informado`. Painéis por faixa
// etária exibem isso ao lado (§4.4) e renderizam em `hipotese` abaixo do limiar (§11).
function cobertura(linhasFaixa) {
  const total = linhasFaixa.reduce((acc, l) => acc + Number(l.n ?? l.usuarios ?? 0), 0);
  const naoInformado = linhasFaixa.find(l => l.faixa === 'nao_informado');
  const cobertos = total - Number(naoInformado?.n ?? naoInformado?.usuarios ?? 0);
  return { cobertos, total, percentual: total ? cobertos / total : 0, estado: estadoEpistemicoCobertura(cobertos, total) };
}

// §7.1 — total e crescimento (janela móvel de 7 dias, não D-1 vs D-2).
router.get('/total', async (req, res) => {
  const [{ data: totalRow, error: e1 }, { data: mensal, error: e2 }] = await Promise.all([
    supabase.rpc('dash_perfil_total_crescimento'),
    supabase.rpc('dash_perfil_crescimento_mensal')
  ]);
  if (e1) return res.status(500).json({ erro: e1.message });
  if (e2) return res.status(500).json({ erro: e2.message });
  res.json({ ...totalRow[0], mensal: mensal.length >= 2 ? mensal : null });
});

// §7.2 — interações por usuário: mediana e média, com abaixo/acima da mediana (absoluto
// + percentual). Sem histograma de faixas — decisão de Guilherme (v39): a contagem de
// interações depende de quantos medicamentos/lembretes a pessoa cadastrou, então uma
// faixa de interações isolada não orienta decisão nenhuma; o cruzamento que importa já
// existe na Visão Adesão.
router.get('/interacoes', async (req, res) => {
  const { data, error } = await supabase.rpc('dash_perfil_interacoes_por_usuario');
  if (error) return res.status(500).json({ erro: error.message });

  const turnos = data.map(r => Number(r.turnos)).sort((a, b) => a - b);
  const med = mediana(turnos);
  const media = turnos.length ? turnos.reduce((a, b) => a + b, 0) / turnos.length : 0;
  const abaixo = turnos.filter(t => t < med).length;
  const acima = turnos.filter(t => t > med).length;
  const naMediana = turnos.length - abaixo - acima;
  const total = turnos.length;

  res.json({
    mediana: med,
    media,
    usuarios: total,
    abaixoDaMediana: abaixo,
    percentualAbaixoDaMediana: total ? abaixo / total : 0,
    acimaDaMediana: acima,
    percentualAcimaDaMediana: total ? acima / total : 0,
    naMediana
  });
});

// §7.3 — inatividade (>7 dias sem interação), por faixa etária.
router.get('/inatividade', async (req, res) => {
  const { data, error } = await supabase.rpc('dash_perfil_inatividade');
  if (error) return res.status(500).json({ erro: error.message });
  const faixas = completarFaixasEtarias(data, 'faixa', 'usuarios');
  res.json({ faixas, cobertura: cobertura(faixas) });
});

// §7.4 — distribuição etária (contagem e percentual sobre a base real).
router.get('/distribuicao-etaria', async (req, res) => {
  const { data, error } = await supabase.rpc('dash_perfil_distribuicao_etaria');
  if (error) return res.status(500).json({ erro: error.message });
  const total = data.reduce((acc, l) => acc + Number(l.n), 0);
  const faixas = completarFaixasEtarias(data, 'faixa', 'n').map(f => ({
    ...f,
    percentual: total ? f.n / total : 0
  }));
  res.json({ faixas, total, cobertura: cobertura(faixas) });
});

// §7.5 — LGPD não aceito (IS NOT TRUE cobre false e null).
router.get('/lgpd-nao-aceito', async (req, res) => {
  const { data, error } = await supabase.rpc('dash_perfil_lgpd_nao_aceito');
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ total: Number(data) });
});

// §7.6 — cadastrou-se mas não cadastrou medicamento (nenhum jamais cadastrado).
router.get('/sem-medicamento', async (req, res) => {
  const { data, error } = await supabase.rpc('dash_perfil_sem_medicamento');
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ total: Number(data) });
});

// §7.7 — medicamentos por usuário (faixas 1 · 2 · 3 · 4 ou mais, medicamentos ativos).
router.get('/medicamentos-por-usuario', async (req, res) => {
  const { data, error } = await supabase.rpc('dash_perfil_medicamentos_por_usuario');
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ faixas: data });
});

// §7.8 / §4.8 — horários por medicamento (faixas semiabertas), + contagem de
// medicamentos ativos sem horário ativo (esperado 0).
router.get('/horarios-por-medicamento', async (req, res) => {
  const [{ data: faixas, error: e1 }, { data: semHorario, error: e2 }] = await Promise.all([
    supabase.rpc('dash_perfil_horarios_por_medicamento'),
    supabase.rpc('dash_medicamentos_sem_horario_ativo')
  ]);
  if (e1) return res.status(500).json({ erro: e1.message });
  if (e2) return res.status(500).json({ erro: e2.message });
  res.json({ faixas, medicamentosAtivosSemHorarioAtivo: Number(semHorario) });
});

export default router;
