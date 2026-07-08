-- Migração do backlog (BUG/FIX/MH) de texto livre no CONTEXT.md para tabela.
-- Aplicada manualmente no SQL Editor do Supabase (mesmo padrão das anteriores).
-- Ver briefings/BRIEFING_BACKLOG_MIGRACAO_DB.md para o backfill e o racional completo.
CREATE TABLE public.backlog_items (
  id                serial PRIMARY KEY,
  tipo              text NOT NULL CHECK (tipo IN ('BUG', 'FIX', 'MH')),
  numero            integer NOT NULL,
  titulo            text NOT NULL,
  descricao         text,
  causa_raiz        text,
  status            text NOT NULL CHECK (status IN (
                      'aberto', 'em_validacao', 'resolvido',
                      'superseded', 'deferred', 'backlog_orfao',
                      'limitacao_aceitavel', 'historico_substituido'
                    )),
  prioridade        text CHECK (prioridade IN ('alta', 'media', 'baixa')),
  sessao_criacao    text,          -- ex: 'v7'
  data_criacao      date,
  sessao_fechamento text,
  data_fechamento   date,
  notas             text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- Constraint de unicidade que elimina a classe inteira do problema de colisão:
-- só pode haver UM item "vivo" por (tipo, numero). Itens históricos já
-- colididos e resolvidos ficam com status = 'historico_substituido' e
-- ficam de fora dessa checagem — preservando o registro sem permitir
-- que aconteça de novo.
CREATE UNIQUE INDEX backlog_items_tipo_numero_ativo
  ON public.backlog_items (tipo, numero)
  WHERE status <> 'historico_substituido';

CREATE INDEX backlog_items_status_idx ON public.backlog_items (status);

COMMENT ON TABLE public.backlog_items IS
  'Backlog único de BUG/FIX/MH da Nami. Fonte de verdade — substitui a seção de backlog do CONTEXT.md a partir de 07/07/2026.';
