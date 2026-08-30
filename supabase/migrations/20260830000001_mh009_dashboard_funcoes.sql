-- MH-009 — funções de leitura do dashboard de indicadores do Ciclo 2.
--
-- Uma função por consulta canônica do briefing (§4, §6-10). A API do dashboard chama
-- estas funções via supabase-js .rpc() com a service key — nunca monta SQL dinâmico a
-- partir de entrada do usuário. Todas STABLE, somente leitura, sem efeito colateral.

-- ============================================================
-- §6.1 — sinais de degradação
-- ============================================================

CREATE OR REPLACE FUNCTION dash_degradacao_serie(dias int DEFAULT 30)
RETURNS TABLE(dia date, tipo text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
         tipo,
         count(*) AS n
  FROM system_events
  WHERE tipo IN ('erro_tecnico','desvio_comportamental')
    AND created_at >= (current_date - dias * interval '1 day')
  GROUP BY 1, 2
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION dash_degradacao_detalhamento(p_inicio timestamptz DEFAULT '2026-08-01', p_fim timestamptz DEFAULT now())
RETURNS TABLE(tipo text, severidade text, origem text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT tipo, severidade, origem, count(*) AS n
  FROM system_events
  WHERE tipo IN ('erro_tecnico','desvio_comportamental')
    AND created_at >= p_inicio AND created_at < p_fim
  GROUP BY 1,2,3
  ORDER BY n DESC;
$$;

CREATE OR REPLACE FUNCTION dash_degradacao_lista(
  p_inicio timestamptz DEFAULT '2026-08-01', p_fim timestamptz DEFAULT now(),
  p_severidade text DEFAULT NULL, p_origem text DEFAULT NULL
)
RETURNS TABLE(created_at timestamptz, tipo text, severidade text, origem text, titulo text, agent text, status_triagem text)
LANGUAGE sql STABLE AS $$
  SELECT se.created_at, se.tipo, se.severidade, se.origem, se.titulo, se.agent, se.status_triagem
  FROM system_events se
  WHERE se.tipo IN ('erro_tecnico','desvio_comportamental')
    AND se.created_at >= p_inicio AND se.created_at < p_fim
    AND (p_severidade IS NULL OR se.severidade = p_severidade)
    AND (p_origem IS NULL OR se.origem = p_origem)
  ORDER BY se.created_at DESC;
$$;

-- Número secundário exigido por §4.1: quantos dos eventos de degradação vieram de conta
-- de teste — o painel não filtra is_teste, mas precisa expor a proporção.
CREATE OR REPLACE FUNCTION dash_degradacao_contagem_teste(p_inicio timestamptz DEFAULT '2026-08-01', p_fim timestamptz DEFAULT now())
RETURNS TABLE(total bigint, de_conta_teste bigint)
LANGUAGE sql STABLE AS $$
  SELECT count(*) AS total,
         count(*) FILTER (WHERE u.is_teste IS TRUE) AS de_conta_teste
  FROM system_events se
  LEFT JOIN users u ON u.id = se.user_id
  WHERE se.tipo IN ('erro_tecnico','desvio_comportamental')
    AND se.created_at >= p_inicio AND se.created_at < p_fim;
$$;

-- ============================================================
-- §6.2 — agentes acionados
-- ============================================================

CREATE OR REPLACE FUNCTION dash_agentes_ranking(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(agent text, acionamentos bigint, usuarios bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.agent, count(*) AS acionamentos, count(DISTINCT a.user_id) AS usuarios
  FROM agent_logs a
  JOIN users u ON u.id = a.user_id
  WHERE u.is_teste = false
    AND a.agent IN ('cadastro','relatorios','configuracao','principal')
    AND a.created_at >= p_inicio AND a.created_at < p_fim
  GROUP BY 1
  ORDER BY acionamentos DESC;
$$;

CREATE OR REPLACE FUNCTION dash_agentes_sistema(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(agent text, acionamentos bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.agent, count(*) AS acionamentos
  FROM agent_logs a
  JOIN users u ON u.id = a.user_id
  WHERE u.is_teste = false
    AND a.agent IN ('recepcionista','data_nascimento','fast_path_resposta_tardia','erro')
    AND a.created_at >= p_inicio AND a.created_at < p_fim
  GROUP BY 1
  ORDER BY acionamentos DESC;
$$;

-- Nota de calibragem do painel (§6.2): proporção de turnos vindos de conta de teste,
-- sem o filtro is_teste — é o número que justifica por que o filtro existe.
CREATE OR REPLACE FUNCTION dash_agentes_proporcao_teste(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(agent text, total bigint, de_conta_teste bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.agent,
         count(*) AS total,
         count(*) FILTER (WHERE u.is_teste IS TRUE) AS de_conta_teste
  FROM agent_logs a
  JOIN users u ON u.id = a.user_id
  WHERE a.created_at >= p_inicio AND a.created_at < p_fim
  GROUP BY 1
  ORDER BY total DESC;
$$;

-- ============================================================
-- §7 — perfil dos usuários (todas as funções filtram is_teste = false)
-- ============================================================

CREATE OR REPLACE FUNCTION dash_perfil_total_crescimento()
RETURNS TABLE(total bigint, novos_7d bigint, novos_7d_anterior bigint)
LANGUAGE sql STABLE AS $$
  SELECT
    count(*) FILTER (WHERE is_teste = false) AS total,
    count(*) FILTER (WHERE is_teste = false AND created_at >= now() - interval '7 days')  AS novos_7d,
    count(*) FILTER (WHERE is_teste = false AND created_at >= now() - interval '14 days'
                                            AND created_at <  now() - interval '7 days')  AS novos_7d_anterior
  FROM users;
$$;

CREATE OR REPLACE FUNCTION dash_perfil_crescimento_mensal()
RETURNS TABLE(mes date, novos bigint)
LANGUAGE sql STABLE AS $$
  SELECT date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo')::date AS mes, count(*) AS novos
  FROM users
  WHERE is_teste = false
  GROUP BY 1 ORDER BY 1;
$$;

-- Uma linha por usuário real, com o total de turnos (agent_logs) — mediana, média e
-- histograma são calculados na API para não duplicar percentile_cont em cada variante.
CREATE OR REPLACE FUNCTION dash_perfil_interacoes_por_usuario()
RETURNS TABLE(user_id uuid, turnos bigint)
LANGUAGE sql STABLE AS $$
  SELECT u.id, count(a.id) AS turnos
  FROM users u
  LEFT JOIN agent_logs a ON a.user_id = u.id
  WHERE u.is_teste = false
  GROUP BY u.id;
$$;

CREATE OR REPLACE FUNCTION dash_perfil_inatividade()
RETURNS TABLE(faixa text, usuarios bigint)
LANGUAGE sql STABLE AS $$
  WITH ultimo AS (
    SELECT u.id, u.data_nascimento, max(a.created_at) AS ultima_interacao
    FROM users u
    LEFT JOIN agent_logs a ON a.user_id = u.id
    WHERE u.is_teste = false
    GROUP BY u.id, u.data_nascimento
  )
  SELECT faixa_etaria(data_nascimento) AS faixa, count(*) AS usuarios
  FROM ultimo
  WHERE ultima_interacao IS NULL
     OR ultima_interacao < now() - interval '7 days'
  GROUP BY 1;
$$;

CREATE OR REPLACE FUNCTION dash_perfil_distribuicao_etaria()
RETURNS TABLE(faixa text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT faixa_etaria(data_nascimento) AS faixa, count(*) AS n
  FROM users
  WHERE is_teste = false
  GROUP BY 1;
$$;

CREATE OR REPLACE FUNCTION dash_perfil_lgpd_nao_aceito()
RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM users
  WHERE is_teste = false AND lgpd_accepted IS NOT TRUE;
$$;

CREATE OR REPLACE FUNCTION dash_perfil_sem_medicamento()
RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM users u
  WHERE u.is_teste = false
    AND NOT EXISTS (SELECT 1 FROM medications m WHERE m.user_id = u.id);
$$;

-- §7.7 — usuários com pelo menos 1 medicamento entram aqui, por faixa de contagem de
-- medicamentos ATIVOS. Quem tem zero aparece só em dash_perfil_sem_medicamento.
CREATE OR REPLACE FUNCTION dash_perfil_medicamentos_por_usuario()
RETURNS TABLE(faixa text, usuarios bigint)
LANGUAGE sql STABLE AS $$
  WITH por_usuario AS (
    SELECT u.id, count(m.id) AS n
    FROM users u
    JOIN medications m ON m.user_id = u.id AND m.ativo IS TRUE
    WHERE u.is_teste = false
    GROUP BY u.id
  )
  SELECT CASE WHEN n = 1 THEN '1'
              WHEN n = 2 THEN '2'
              WHEN n = 3 THEN '3'
              ELSE '4 ou mais' END AS faixa,
         count(*) AS usuarios
  FROM por_usuario
  GROUP BY 1 ORDER BY 1;
$$;

-- §4.8/§7.8 — razão de horários ativos por medicamento ativo qualificado (medicamento
-- ativo sem horário ativo é estado inválido, protegido em configuracao.js:921, e fica
-- fora do denominador).
CREATE OR REPLACE FUNCTION dash_perfil_horarios_por_medicamento()
RETURNS TABLE(faixa text, usuarios bigint)
LANGUAGE sql STABLE AS $$
  WITH med_qualificado AS (
    SELECT m.id, m.user_id, count(s.id) FILTER (WHERE s.ativo) AS horarios
    FROM medications m
    LEFT JOIN schedules s ON s.medication_id = m.id
    WHERE m.ativo IS TRUE
    GROUP BY m.id, m.user_id
    HAVING count(s.id) FILTER (WHERE s.ativo) > 0
  ),
  razao AS (
    SELECT u.id, sum(mq.horarios)::numeric / count(*) AS horarios_por_med
    FROM med_qualificado mq
    JOIN users u ON u.id = mq.user_id
    WHERE u.is_teste = false
    GROUP BY u.id
  )
  SELECT
    CASE WHEN horarios_por_med < 2 THEN '1 a menos de 2'
         WHEN horarios_por_med < 3 THEN '2 a menos de 3'
         WHEN horarios_por_med < 4 THEN '3 a menos de 4'
         ELSE '4 ou mais' END AS faixa,
    count(*) AS usuarios
  FROM razao GROUP BY 1 ORDER BY 1;
$$;

-- Contagem exibida à parte no painel §7.8 — esperado 0; acima disso é cadastro incompleto.
CREATE OR REPLACE FUNCTION dash_medicamentos_sem_horario_ativo()
RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM (
    SELECT m.id
    FROM medications m
    LEFT JOIN schedules s ON s.medication_id = m.id AND s.ativo IS TRUE
    JOIN users u ON u.id = m.user_id
    WHERE m.ativo IS TRUE AND u.is_teste = false
    GROUP BY m.id
    HAVING count(s.id) = 0
  ) sem_horario;
$$;

-- ============================================================
-- §8 — base de medicamentos
-- ============================================================

CREATE OR REPLACE FUNCTION dash_medicamentos_total_crescimento()
RETURNS TABLE(total bigint, novos_7d bigint, novos_7d_anterior bigint)
LANGUAGE sql STABLE AS $$
  SELECT
    count(*) FILTER (WHERE u.is_teste = false AND m.ativo IS TRUE) AS total,
    count(*) FILTER (WHERE u.is_teste = false AND m.ativo IS TRUE
                       AND m.created_at >= now() - interval '7 days') AS novos_7d,
    count(*) FILTER (WHERE u.is_teste = false AND m.ativo IS TRUE
                       AND m.created_at >= now() - interval '14 days'
                       AND m.created_at <  now() - interval '7 days') AS novos_7d_anterior
  FROM medications m
  JOIN users u ON u.id = m.user_id;
$$;

CREATE OR REPLACE FUNCTION dash_medicamentos_crescimento_mensal()
RETURNS TABLE(mes date, novos bigint)
LANGUAGE sql STABLE AS $$
  SELECT date_trunc('month', m.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS mes, count(*) AS novos
  FROM medications m
  JOIN users u ON u.id = m.user_id
  WHERE u.is_teste = false AND m.ativo IS TRUE
  GROUP BY 1 ORDER BY 1;
$$;

-- Bruto: a API normaliza importando src/templates/dose.js (§4.9) — não há normalização
-- de forma farmacêutica no banco.
CREATE OR REPLACE FUNCTION dash_medicamentos_por_forma()
RETURNS TABLE(forma_farmaceutica text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT m.forma_farmaceutica, count(*) AS n
  FROM medications m
  JOIN users u ON u.id = m.user_id
  WHERE u.is_teste = false AND m.ativo IS TRUE
  GROUP BY 1;
$$;

-- §8.3 — visão detalhada. Nunca junta nome do medicamento a usuário identificável (§12):
-- devolve só data e forma bruta, sem nome nem id de usuário.
CREATE OR REPLACE FUNCTION dash_medicamentos_detalhado(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(created_at timestamptz, forma_farmaceutica text)
LANGUAGE sql STABLE AS $$
  SELECT m.created_at, m.forma_farmaceutica
  FROM medications m
  JOIN users u ON u.id = m.user_id
  WHERE u.is_teste = false AND m.ativo IS TRUE
    AND m.created_at >= p_inicio AND m.created_at < p_fim
  ORDER BY m.created_at DESC;
$$;

-- ============================================================
-- §9 — adesão ao tratamento
-- ============================================================

CREATE OR REPLACE FUNCTION dash_adesao_geral(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(status text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT d.status, count(*) AS n
  FROM dose_logs d
  JOIN medications m ON m.id = d.medication_id
  JOIN users u       ON u.id = m.user_id
  WHERE u.is_teste = false
    AND d.status IN ('confirmado','nao_informado','sem_estoque','nao_tomado')
    AND d.scheduled_at >= p_inicio AND d.scheduled_at < p_fim
    AND (d.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date <= current_date - 1
  GROUP BY 1
  ORDER BY n DESC;
$$;

CREATE OR REPLACE FUNCTION dash_adesao_por_faixa_etaria(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(status text, faixa text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT d.status, faixa_etaria(u.data_nascimento) AS faixa, count(*) AS n
  FROM dose_logs d
  JOIN medications m ON m.id = d.medication_id
  JOIN users u       ON u.id = m.user_id
  WHERE u.is_teste = false
    AND d.status IN ('confirmado','nao_informado','sem_estoque','nao_tomado')
    AND d.scheduled_at >= p_inicio AND d.scheduled_at < p_fim
    AND (d.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date <= current_date - 1
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

-- Painel A (§9.3): confirmações por número de tentativa, excluindo retroativas — que
-- carregam tentativas = 3 por construção e empilhariam na 3ª tentativa.
CREATE OR REPLACE FUNCTION dash_adesao_tentativas(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(tentativas int, faixa text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT d.tentativas, faixa_etaria(u.data_nascimento) AS faixa, count(*) AS n
  FROM dose_logs d
  JOIN medications m ON m.id = d.medication_id
  JOIN users u       ON u.id = m.user_id
  WHERE u.is_teste = false
    AND d.status = 'confirmado'
    AND d.revertido IS NOT TRUE
    AND d.scheduled_at >= p_inicio AND d.scheduled_at < p_fim
    AND (d.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date <= current_date - 1
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

-- Painel B (§9.3, §4.6): confirmação retroativa é o PAR (revertido_de = 'nao_informado'
-- AND status = 'confirmado'), nunca o booleano revertido sozinho.
CREATE OR REPLACE FUNCTION dash_adesao_retroativas(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(faixa text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT faixa_etaria(u.data_nascimento) AS faixa, count(*) AS n
  FROM dose_logs d
  JOIN medications m ON m.id = d.medication_id
  JOIN users u       ON u.id = m.user_id
  WHERE u.is_teste = false
    AND d.revertido IS TRUE AND d.revertido_de = 'nao_informado' AND d.status = 'confirmado'
    AND d.scheduled_at >= p_inicio AND d.scheduled_at < p_fim
    AND (d.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date <= current_date - 1
  GROUP BY 1
  ORDER BY 1;
$$;

-- Métrica de destaque do Painel B: "N de M confirmações foram retroativas".
CREATE OR REPLACE FUNCTION dash_adesao_retroativas_resumo(p_inicio timestamptz DEFAULT '2026-06-05', p_fim timestamptz DEFAULT now())
RETURNS TABLE(total_confirmados bigint, total_retroativas bigint)
LANGUAGE sql STABLE AS $$
  SELECT
    count(*) FILTER (WHERE d.status = 'confirmado') AS total_confirmados,
    count(*) FILTER (WHERE d.revertido IS TRUE AND d.revertido_de = 'nao_informado' AND d.status = 'confirmado') AS total_retroativas
  FROM dose_logs d
  JOIN medications m ON m.id = d.medication_id
  JOIN users u       ON u.id = m.user_id
  WHERE u.is_teste = false
    AND d.scheduled_at >= p_inicio AND d.scheduled_at < p_fim
    AND (d.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date <= current_date - 1;
$$;

-- ============================================================
-- §10 — feedback
-- ============================================================

-- Corrente 1: feedback espontâneo classificado, com faixa etária do usuário (is_teste = false).
CREATE OR REPLACE FUNCTION dash_feedback_espontaneo(p_inicio timestamptz DEFAULT '2026-07-27', p_fim timestamptz DEFAULT now())
RETURNS TABLE(categoria text, texto text, origem text, status_triagem text, created_at timestamptz, faixa text)
LANGUAGE sql STABLE AS $$
  SELECT f.categoria, f.texto, f.origem, f.status_triagem, f.created_at, faixa_etaria(u.data_nascimento) AS faixa
  FROM feedbacks f
  JOIN users u ON u.id = f.user_id
  WHERE u.is_teste = false
    AND f.created_at >= p_inicio AND f.created_at < p_fim
  ORDER BY f.created_at DESC;
$$;

-- Corrente 2: intenção não suportada — sinal de demanda de produto (system_events),
-- exatamente a query confirmada em router.js:1161 (§10.1).
CREATE OR REPLACE FUNCTION dash_feedback_intencao_nao_suportada()
RETURNS TABLE(created_at timestamptz, titulo text, user_message text, faixa text)
LANGUAGE sql STABLE AS $$
  SELECT se.created_at, se.titulo, al.user_message, faixa_etaria(u.data_nascimento) AS faixa
  FROM system_events se
  LEFT JOIN agent_logs al ON al.id = se.agent_log_id
  LEFT JOIN users u       ON u.id = se.user_id
  WHERE se.tipo = 'intencao_nao_suportada'
    AND (u.is_teste = false OR u.id IS NULL)
  ORDER BY se.created_at DESC;
$$;
