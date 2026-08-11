-- Governança de backlog (decisão de Guilherme, sessão v29, 05/08/2026): a partir de
-- agora, item novo só entra em backlog_items com autorização explícita, itens grandes
-- demais para uma sessão se dividem em PARTES do MESMO número (nunca item novo), e
-- achados de sessão que não são bug/melhoria fechados ganham categoria própria (ACH).
-- Ver briefings/BRIEFING_ACH_PARTES.md para o racional completo.

-- 1. Categoria ACH (achado) — substitui o CHECK constraint de tipo.
ALTER TABLE public.backlog_items DROP CONSTRAINT backlog_items_tipo_check;
ALTER TABLE public.backlog_items ADD CONSTRAINT backlog_items_tipo_check
  CHECK (tipo IN ('BUG', 'FIX', 'MH', 'ACH'));

-- 2. Vínculo do ACH a um BUG/MH relacionado (texto livre, ex: 'MH-071' ou 'BUG-086').
-- Nulo quando o achado não se conecta a nenhum item existente. Texto livre, não FK
-- estruturada — volume baixo esperado, não justifica normalizar agora (mesma lógica
-- de escopo já usada em outras decisões do projeto, ex: MH-046/MH-055).
ALTER TABLE public.backlog_items ADD COLUMN relacionado text NULL;

-- 3. Coluna de parte (A/B/C) para item grande demais para uma sessão.
-- NOT NULL DEFAULT '' (nunca NULL) — motivo: o índice único abaixo distingue linhas
-- por (tipo, numero, parte). Se parte fosse NULLABLE, dois itens sem parte (ambos
-- NULL) NÃO colidiriam no índice — Postgres trata NULL <> NULL em índice único —
-- reabrindo a mesma classe de colisão de número que backlog_items_tipo_numero_ativo
-- foi criado para fechar em 08/07/2026. Com '' como valor não-nulo padrão, itens sem
-- parte continuam protegidos entre si exatamente como hoje.
ALTER TABLE public.backlog_items ADD COLUMN parte text NOT NULL DEFAULT '';

-- 4. Substitui o índice único para incluir parte — sem isso, Parte A e Parte B do
-- mesmo item colidiriam como se fossem o mesmo registro (índice atual só olha
-- tipo+numero).
DROP INDEX public.backlog_items_tipo_numero_ativo;
CREATE UNIQUE INDEX backlog_items_tipo_numero_parte_ativo
  ON public.backlog_items (tipo, numero, parte)
  WHERE status <> 'historico_substituido';

COMMENT ON COLUMN public.backlog_items.relacionado IS
  'Referência textual (ex: "MH-071") ao BUG/MH relacionado. Usada principalmente por itens tipo=ACH. Nulo quando não há relação.';
COMMENT ON COLUMN public.backlog_items.parte IS
  'Parte (A, B, C...) quando um item foi dividido entre sessões. Vazio ('''') para item não dividido — nunca NULL, ver comentário da migration que introduziu a coluna.';
