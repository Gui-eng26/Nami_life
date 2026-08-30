// Visão técnica — BRIEFING_MH009 §6. Sinais de degradação (§6.1) e agentes acionados
// (§6.2). O inventário de funcionalidades (§6.3) vive só na Visão Feedback
// (/api/feedback/inventario) — mostrá-lo aqui também era duplicação, removido a pedido
// de Guilherme (v39): a comparação "o que a Nami faz × o que pediram e não têm" só faz
// sentido lado a lado com as correntes de feedback.
//
// Exceção deliberada de §4.1: esta rota NÃO filtra is_teste — uma falha técnica é uma
// falha técnica independentemente de quem a disparou, e system_events.user_id é nulo
// em eventos de scheduler/catch_global (filtrar descartaria os eventos mais graves).
import { Router } from 'express';
import { supabase } from '../db.js';
import { INICIO_DEGRADACAO } from '../definicoes.js';

const router = Router();

function parseIntervalo(req, defaultInicio) {
  const inicio = req.query.inicio || defaultInicio;
  const fim = req.query.fim || new Date().toISOString();
  return { inicio, fim };
}

// §6.1 — visão geral: série diária dos últimos 30 dias, duas séries separadas.
router.get('/degradacao/serie', async (req, res) => {
  const dias = Number(req.query.dias) || 30;
  const { data, error } = await supabase.rpc('dash_degradacao_serie', { dias });
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ serie: data });
});

// §6.1 — detalhamento macro: por tipo, severidade e origem.
router.get('/degradacao/detalhamento', async (req, res) => {
  const { inicio, fim } = parseIntervalo(req, INICIO_DEGRADACAO);
  const [detalhamento, contagemTeste] = await Promise.all([
    supabase.rpc('dash_degradacao_detalhamento', { p_inicio: inicio, p_fim: fim }),
    supabase.rpc('dash_degradacao_contagem_teste', { p_inicio: inicio, p_fim: fim })
  ]);
  if (detalhamento.error) return res.status(500).json({ erro: detalhamento.error.message });
  if (contagemTeste.error) return res.status(500).json({ erro: contagemTeste.error.message });
  res.json({
    detalhamento: detalhamento.data,
    contagemTeste: contagemTeste.data?.[0] || { total: 0, de_conta_teste: 0 }
  });
});

// §6.1 — visão detalhada: lista com filtros de data/tipo/severidade/origem. Existe para
// não virar uma lista sem fim conforme o beta avança — o usuário escolhe os campos e só
// volta o que bate com a busca.
router.get('/degradacao/lista', async (req, res) => {
  const { inicio, fim } = parseIntervalo(req, INICIO_DEGRADACAO);
  const { tipo, severidade, origem } = req.query;
  const { data, error } = await supabase.rpc('dash_degradacao_lista', {
    p_inicio: inicio,
    p_fim: fim,
    p_tipo: tipo || null,
    p_severidade: severidade || null,
    p_origem: origem || null
  });
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ eventos: data, total: data.length });
});

// §6.2 — agentes acionados: ranking (bloco 1, capacidades acionáveis pelo usuário) + nota
// de calibragem (proporção de teste, sem filtrar). O bloco 2 (caminhos de sistema e
// onboarding) foi removido da UI a pedido de Guilherme (v39): sem contexto para orientar
// decisão, os números ficavam soltos. A função dash_agentes_sistema segue no banco caso
// volte a fazer sentido mostrá-la com mais contexto.
router.get('/agentes', async (req, res) => {
  const { inicio, fim } = parseIntervalo(req, '2026-06-05');
  const [ranking, proporcaoTeste] = await Promise.all([
    supabase.rpc('dash_agentes_ranking', { p_inicio: inicio, p_fim: fim }),
    supabase.rpc('dash_agentes_proporcao_teste', { p_inicio: inicio, p_fim: fim })
  ]);
  if (ranking.error) return res.status(500).json({ erro: ranking.error.message });
  if (proporcaoTeste.error) return res.status(500).json({ erro: proporcaoTeste.error.message });
  res.json({ ranking: ranking.data, proporcaoTeste: proporcaoTeste.data });
});

export default router;
