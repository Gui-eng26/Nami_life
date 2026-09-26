-- =============================================================================
-- v45 P1 §6.4 / §8 — Estoque contestado.
--
-- Quando a pessoa confirma uma dose de um medicamento com estoque_atual <= 0,
-- a palavra dela prevalece: o estoque passa a NULO (desconhecido) e o
-- comportamento de estoque nulo que já existe assume (convite sem insistência;
-- o scheduler para de criar sem_estoque). O movimento fica registrado com o
-- tipo novo `estoque_contestado`, cujo estoque_novo é NULL — daí o DROP NOT NULL.
--
-- Idempotência: DROP NOT NULL é no-op se a coluna já aceita nulo; o CHECK é
-- derrubado com IF EXISTS e recriado com a lista completa — reaplicar dá o
-- mesmo estado final.
--
-- Ordem de aplicação: staging no início do P1; produção ANTES do merge.
-- =============================================================================

ALTER TABLE public.stock_movements ALTER COLUMN estoque_novo DROP NOT NULL;

ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_tipo_check;
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_tipo_check CHECK (tipo = ANY (ARRAY[
  'cadastro_inicial','cadastro_substituicao','reativacao_com_estoque','recompra',
  'correcao_soma','correcao_subtracao','correcao_set',
  'dose_confirmada','dose_retroativa','dose_revertida','estoque_contestado']));
