// Visão base de medicamentos — BRIEFING_MH009 §8. is_teste = false é aplicado dentro
// das funções RPC chamadas aqui (migration MH-009) — a mesma base real de todo painel.
import { Router } from 'express';
import { supabase } from '../db.js';
import { normalizarFormaFarmaceutica } from '../definicoes.js';

const router = Router();

// §8.1 — total e crescimento (medicamentos ativos de usuários reais).
router.get('/total', async (req, res) => {
  const [{ data: totalRow, error: e1 }, { data: mensal, error: e2 }] = await Promise.all([
    supabase.rpc('dash_medicamentos_total_crescimento'),
    supabase.rpc('dash_medicamentos_crescimento_mensal')
  ]);
  if (e1) return res.status(500).json({ erro: e1.message });
  if (e2) return res.status(500).json({ erro: e2.message });
  res.json({ ...totalRow[0], mensal: mensal.length >= 2 ? mensal : null });
});

// §8.2 / §4.9 — por forma farmacêutica. SQL devolve bruto; a normalização acontece
// aqui, importando src/templates/dose.js — nenhuma tabela de normalização própria.
router.get('/por-forma', async (req, res) => {
  const { data, error } = await supabase.rpc('dash_medicamentos_por_forma');
  if (error) return res.status(500).json({ erro: error.message });

  const agrupado = new Map();
  for (const linha of data) {
    const forma = normalizarFormaFarmaceutica(linha.forma_farmaceutica);
    agrupado.set(forma, (agrupado.get(forma) || 0) + Number(linha.n));
  }
  const total = [...agrupado.values()].reduce((a, b) => a + b, 0);
  const formas = [...agrupado.entries()]
    .map(([forma, n]) => ({ forma, n, percentual: total ? n / total : 0 }))
    .sort((a, b) => b.n - a.n);

  res.json({ formas, total });
});

// §8.3 — visão detalhada com filtro de data. Forma farmacêutica normalizada por
// medicamento; nunca retorna nome nem usuário (§12).
router.get('/detalhado', async (req, res) => {
  const inicio = req.query.inicio || '2026-06-05';
  const fim = req.query.fim || new Date().toISOString();
  const { data, error } = await supabase.rpc('dash_medicamentos_detalhado', { p_inicio: inicio, p_fim: fim });
  if (error) return res.status(500).json({ erro: error.message });

  const medicamentos = data.map(m => ({
    createdAt: m.created_at,
    forma: normalizarFormaFarmaceutica(m.forma_farmaceutica)
  }));
  res.json({ medicamentos });
});

export default router;
