-- MH-009 — ajustes pós-revisão de Guilherme (v39): a visão detalhada de degradação
-- também precisa filtrar por tipo, não só severidade/origem — senão a lista cresce sem
-- controle conforme o beta avança (achado do próprio Guilherme testando o dashboard).

-- O parâmetro novo (p_tipo) muda a assinatura da função — CREATE OR REPLACE exige DROP
-- antes quando os tipos de parâmetro mudam.
DROP FUNCTION IF EXISTS dash_degradacao_lista(timestamptz, timestamptz, text, text);

CREATE OR REPLACE FUNCTION dash_degradacao_lista(
  p_inicio timestamptz DEFAULT '2026-08-01', p_fim timestamptz DEFAULT now(),
  p_tipo text DEFAULT NULL, p_severidade text DEFAULT NULL, p_origem text DEFAULT NULL
)
RETURNS TABLE(created_at timestamptz, tipo text, severidade text, origem text, titulo text, agent text, status_triagem text)
LANGUAGE sql STABLE AS $$
  SELECT se.created_at, se.tipo, se.severidade, se.origem, se.titulo, se.agent, se.status_triagem
  FROM system_events se
  WHERE se.tipo IN ('erro_tecnico','desvio_comportamental')
    AND se.created_at >= p_inicio AND se.created_at < p_fim
    AND (p_tipo IS NULL OR se.tipo = p_tipo)
    AND (p_severidade IS NULL OR se.severidade = p_severidade)
    AND (p_origem IS NULL OR se.origem = p_origem)
  ORDER BY se.created_at DESC;
$$;
