-- =============================================================================
-- Adesão ao Tratamento (Cálculo + Apresentação + Chamadas)
-- Fecha BUG-031, "unificação de tipos" (sem ID), MH-037, BUG-037
-- Ver briefings/BRIEFING_ADESAO_AO_TRATAMENTO.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Popula tratamento_fim para tratamentos ativos com tratamento_dias definido,
-- calculado a partir de created_at. Novos cadastros passam a popular no momento
-- da criação (ver database.js: saveMedication / reativarComAtualizacao).
-- -----------------------------------------------------------------------------
UPDATE public.medications
SET tratamento_fim = (created_at::date + (tratamento_dias || ' days')::interval)
WHERE tratamento_dias IS NOT NULL
  AND tipo_tratamento != 'continuo'
  AND tratamento_fim IS NULL;


-- -----------------------------------------------------------------------------
-- ADESAO_ESTADO
-- Estado de acompanhamento de adesão por usuário — jornada de faixa/semana,
-- tendência (comparação com o envio anterior) e cadência semanal/mensal.
-- Mantém esse estado num único lugar, sem poluir `users`.
-- faixa_atual / melhor_faixa_atingida: '100' | '80_99' | '50_79' | 'abaixo_50'
-- -----------------------------------------------------------------------------
CREATE TABLE public.adesao_estado (
    user_id                     uuid PRIMARY KEY REFERENCES public.users(id),
    ultimo_fechamento_mensal_at timestamptz,
    faixa_atual                 text,
    percentual_ultimo_envio     numeric,
    semana_atual_na_faixa       int DEFAULT 1,
    melhor_faixa_atingida       text,
    updated_at                  timestamptz DEFAULT now()
);
