-- =============================================================================
-- v44 M3 P1 — Estado explícito do tratamento (fundação do marco).
--
-- Hoje "pausado" é INFERIDO (ativo=true com zero schedules ativos) — por isso
-- a lista mistura, a reativação é cega e pausado×encerrado se confundem
-- (BUG-61). O estado vira coluna com CHECK; `ativo` (boolean) permanece
-- durante o M3 como derivado de compatibilidade (remoção avaliada no
-- encerramento do marco).
--
-- Backfill inferindo o estado atual:
--   ativo=false                              → encerrado
--   ativo=true, ≥1 schedule, todos inativos  → pausado
--   senão                                    → ativo
--
-- MH-31 nasce aqui: histórico de encerrados consultável por status='encerrado'.
-- =============================================================================

ALTER TABLE public.medications
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ativo'
        CONSTRAINT medications_status_check CHECK (status IN ('ativo', 'pausado', 'encerrado')),
    ADD COLUMN IF NOT EXISTS status_alterado_em timestamptz;

UPDATE public.medications m
SET status = 'encerrado'
WHERE m.ativo = false
  AND m.status <> 'encerrado';

UPDATE public.medications m
SET status = 'pausado'
WHERE m.ativo = true
  AND m.status = 'ativo'
  AND EXISTS (SELECT 1 FROM public.schedules s WHERE s.medication_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM public.schedules s WHERE s.medication_id = m.id AND s.ativo = true);

-- Consulta do histórico de encerrados (MH-31) e da lista ordenada (P4).
CREATE INDEX IF NOT EXISTS idx_medications_user_status
    ON public.medications (user_id, status);
