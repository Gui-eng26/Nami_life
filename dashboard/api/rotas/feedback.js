// Visão feedback — BRIEFING_MH009 §10. Três correntes lado a lado com o inventário.
// `intencao_nao_suportada` mora aqui (corrente 2), nunca em tecnica.js — é sinal de
// demanda de produto, não falha técnica (§6.1).
import { Router } from 'express';
import { supabase } from '../db.js';
import { CAPACIDADES, NAO_SUPORTADO } from '../definicoes.js';

const router = Router();

// Corrente 1 — feedback espontâneo classificado.
router.get('/espontaneo', async (req, res) => {
  const inicio = req.query.inicio || '2026-07-27';
  const fim = req.query.fim || new Date().toISOString();
  const { data, error } = await supabase.rpc('dash_feedback_espontaneo', { p_inicio: inicio, p_fim: fim });
  if (error) return res.status(500).json({ erro: error.message });
  res.json({
    feedbacks: data,
    // §10.1 — advertência obrigatória: com is_teste = false, este painel nasce vazio na
    // base atual (os 6 registros de `feedbacks` vieram do fundador em 27/07/2026).
    aviso: data.length === 0
      ? 'Nenhum feedback de usuário real ainda. Os registros existentes na base foram gerados pelo fundador durante a construção do extrator — não são percepção de usuário real.'
      : null
  });
});

// Corrente 2 — intenção não suportada (sinal de demanda de produto).
router.get('/intencao-nao-suportada', async (req, res) => {
  const { data, error } = await supabase.rpc('dash_feedback_intencao_nao_suportada');
  if (error) return res.status(500).json({ erro: error.message });
  res.json({
    eventos: data,
    aviso: data.length < 10
      ? 'Amostra pequena — não sustenta conclusão sobre frequência. Tratar como pergunta aberta do Ciclo 2, não como achado.'
      : null
  });
});

// Corrente 3 — o inventário, renderizado ao lado (mesma fonte de tecnica.js).
router.get('/inventario', (req, res) => {
  res.json({ capacidades: CAPACIDADES, naoSuportado: NAO_SUPORTADO });
});

export default router;
