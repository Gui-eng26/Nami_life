// Visão de adesão ao tratamento — BRIEFING_MH009 §9. Regras de §4.5 (status válidos —
// nunca 'pendente' nem 'pausado', corte em D-1, acumulado desde 05/06/2026) e §4.6
// (confirmação retroativa definida pelo par) vivem nas funções RPC da migration MH-009,
// que também aplicam is_teste = false em toda leitura desta rota.
import { Router } from 'express';
import { supabase } from '../db.js';
import { completarFaixasEtarias, estadoEpistemicoCobertura, FRONTEIRA_CICLO } from '../definicoes.js';

const router = Router();

function parseIntervalo(req) {
  const inicio = req.query.inicio || '2026-06-05';
  const fim = req.query.fim || new Date().toISOString();
  return { inicio, fim };
}

// §9.1 — geral, por status (com filtro de data para a visão detalhada).
router.get('/geral', async (req, res) => {
  const { inicio, fim } = parseIntervalo(req);
  const { data, error } = await supabase.rpc('dash_adesao_geral', { p_inicio: inicio, p_fim: fim });
  if (error) return res.status(500).json({ erro: error.message });
  const total = data.reduce((acc, l) => acc + Number(l.n), 0);
  res.json({
    status: data.map(l => ({ ...l, percentual: total ? Number(l.n) / total : 0 })),
    total,
    fronteiraCiclo: FRONTEIRA_CICLO
  });
});

// §9.2 — status cruzado com faixa etária. Para cada status, distribuição percentual
// DENTRO daquele status, com a faixa dominante destacada. O Ciclo 1 nunca aparece como
// referência/meta/baseline — este endpoint só olha para o período pedido, sem herdar
// nada de antes da fronteira quando o chamador não pedir explicitamente.
router.get('/por-faixa-etaria', async (req, res) => {
  const { inicio, fim } = parseIntervalo(req);
  const { data, error } = await supabase.rpc('dash_adesao_por_faixa_etaria', { p_inicio: inicio, p_fim: fim });
  if (error) return res.status(500).json({ erro: error.message });

  const porStatus = {};
  for (const linha of data) {
    if (!porStatus[linha.status]) porStatus[linha.status] = [];
    porStatus[linha.status].push({ faixa: linha.faixa, n: Number(linha.n) });
  }

  const resultado = Object.entries(porStatus).map(([status, linhas]) => {
    const faixas = completarFaixasEtarias(linhas, 'faixa', 'n');
    const total = faixas.reduce((acc, f) => acc + f.n, 0);
    const comPercentual = faixas.map(f => ({ ...f, percentual: total ? f.n / total : 0 }));
    const dominante = comPercentual.filter(f => f.faixa !== 'nao_informado').sort((a, b) => b.n - a.n)[0] || null;
    return {
      status,
      faixas: comPercentual,
      total,
      faixaDominante: dominante?.faixa || null,
      cobertura: estadoEpistemicoCobertura(
        total - (faixas.find(f => f.faixa === 'nao_informado')?.n || 0),
        total
      )
    };
  });

  res.json({ porStatus: resultado, fronteiraCiclo: FRONTEIRA_CICLO });
});

// §9.3 Painel A — confirmações por número de tentativa, excluindo retroativas.
router.get('/tentativas', async (req, res) => {
  const { inicio, fim } = parseIntervalo(req);
  const { data, error } = await supabase.rpc('dash_adesao_tentativas', { p_inicio: inicio, p_fim: fim });
  if (error) return res.status(500).json({ erro: error.message });

  const porTentativa = {};
  for (const linha of data) {
    const chave = linha.tentativas;
    if (!porTentativa[chave]) porTentativa[chave] = [];
    porTentativa[chave].push({ faixa: linha.faixa, n: Number(linha.n) });
  }
  const bruto = Object.entries(porTentativa).map(([tentativas, linhas]) => ({
    tentativas: Number(tentativas),
    faixas: completarFaixasEtarias(linhas, 'faixa', 'n'),
    total: linhas.reduce((acc, l) => acc + l.n, 0)
  })).sort((a, b) => a.tentativas - b.tentativas);

  // Percentual de cada tentativa sobre o total de confirmações não-retroativas do
  // período — a dimensão que faltava na leitura puramente absoluta (§9.3).
  const somaGeral = bruto.reduce((acc, t) => acc + t.total, 0);
  const resultado = bruto.map(t => ({ ...t, percentual: somaGeral ? t.total / somaGeral : 0 }));

  res.json({ porTentativa: resultado, totalGeral: somaGeral });
});

// §9.3 Painel B — confirmações retroativas (métrica de destaque, não linha escondida).
router.get('/retroativas', async (req, res) => {
  const { inicio, fim } = parseIntervalo(req);
  const [{ data: faixasRaw, error: e1 }, { data: resumo, error: e2 }] = await Promise.all([
    supabase.rpc('dash_adesao_retroativas', { p_inicio: inicio, p_fim: fim }),
    supabase.rpc('dash_adesao_retroativas_resumo', { p_inicio: inicio, p_fim: fim })
  ]);
  if (e1) return res.status(500).json({ erro: e1.message });
  if (e2) return res.status(500).json({ erro: e2.message });

  const { total_confirmados, total_retroativas } = resumo[0] || { total_confirmados: 0, total_retroativas: 0 };
  const totalRetroativasNum = Number(total_retroativas);
  // Percentual de cada faixa etária sobre o TOTAL DE RETROATIVAS (não sobre a base geral)
  // — responde "das retroativas, quanto veio de cada faixa", que é a leitura do painel.
  const faixas = completarFaixasEtarias(faixasRaw, 'faixa', 'n').map(f => ({
    ...f,
    percentual: totalRetroativasNum ? f.n / totalRetroativasNum : 0
  }));
  res.json({
    faixas,
    totalConfirmados: Number(total_confirmados),
    totalRetroativas: totalRetroativasNum,
    percentual: total_confirmados ? totalRetroativasNum / Number(total_confirmados) : 0
  });
});

export default router;
