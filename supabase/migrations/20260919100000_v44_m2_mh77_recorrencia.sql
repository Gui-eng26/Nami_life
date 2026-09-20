-- =============================================================================
-- v44 M2 — MH-77: recorrência de posologia (dias da semana, dia sim/dia não,
-- 1x por semana).
--
-- DESCOBERTA DE CÓDIGO (corrige a premissa do briefing §4): schedules.dias_semana
-- JÁ EXISTE como text[] ('seg'..'dom'), com DEFAULT de todos os 7 dias, e a RPC
-- get_pending_reminders JÁ filtra pelo dia corrente — a infraestrutura não era
-- dormente no SQL, só no JS (nenhum código escrevia a coluna). APROVEITADA, não
-- recriada: o modelo text[] com default cheio é 100% compatível com o legado
-- (todo schedule existente dispara todos os dias, como sempre).
--
-- ADITIVO nesta migração:
--   1. intervalo_dias  — "dia sim, dia não" (=2) e "a cada N dias" (N>=2).
--   2. data_inicio     — âncora do módulo do intervalo.
--   3. get_pending_reminders ganha o filtro de intervalo: dose de dia não
--      coberto NUNCA nasce (o filtro de dias_semana já existia).
--
-- Zero impacto no legado: colunas novas NULL = comportamento diário de sempre.
-- =============================================================================

ALTER TABLE public.schedules ADD COLUMN IF NOT EXISTS intervalo_dias integer;
ALTER TABLE public.schedules ADD COLUMN IF NOT EXISTS data_inicio date;

ALTER TABLE public.schedules DROP CONSTRAINT IF EXISTS schedules_intervalo_dias_check;
ALTER TABLE public.schedules ADD CONSTRAINT schedules_intervalo_dias_check
    CHECK (intervalo_dias IS NULL OR intervalo_dias >= 2);

-- Mesmo RETURNS TABLE do BUG-100 — só a cláusula WHERE ganha o filtro de
-- intervalo (CREATE OR REPLACE é suficiente quando a assinatura não muda).
CREATE OR REPLACE FUNCTION public.get_pending_reminders()
RETURNS TABLE (
    schedule_id          uuid,
    medication_id        uuid,
    user_id              uuid,
    phone                text,
    user_name            text,
    med_nome             text,
    med_dosagem          text,
    horario              time,
    estoque_atual        numeric,
    estoque_minimo       numeric,
    quantidade_por_dose  numeric,
    unidade_dose         text,
    unidade_estoque      text,
    gotas_por_ml         numeric,
    forma_farmaceutica   text
)
LANGUAGE sql
AS $$
    SELECT
        s.id            AS schedule_id,
        m.id            AS medication_id,
        u.id            AS user_id,
        u.phone,
        u.name          AS user_name,
        m.nome          AS med_nome,
        m.dosagem       AS med_dosagem,
        s.horario,
        m.estoque_atual,
        m.estoque_minimo,
        s.quantidade_por_dose,
        m.unidade_dose,
        m.unidade_estoque,
        m.gotas_por_ml,
        m.forma_farmaceutica
    FROM schedules s
    JOIN medications m ON m.id = s.medication_id
    JOIN users u ON u.id = m.user_id
    WHERE s.ativo = true
    AND m.ativo = true
    AND s.horario BETWEEN
        (now() AT TIME ZONE 'America/Sao_Paulo')::time - interval '2 minutes'
        AND
        (now() AT TIME ZONE 'America/Sao_Paulo')::time + interval '2 minutes'
    AND (
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 1 AND 'seg' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 2 AND 'ter' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 3 AND 'qua' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 4 AND 'qui' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 5 AND 'sex' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 6 AND 'sab' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 0 AND 'dom' = ANY(s.dias_semana))
    )
    -- MH-77: intervalo de dias ("dia sim, dia não" = 2). Sem data_inicio não há
    -- âncora — trata como diário (nunca silencia dose por dado incompleto).
    AND (
        s.intervalo_dias IS NULL
        OR s.data_inicio IS NULL
        OR MOD(((now() AT TIME ZONE 'America/Sao_Paulo')::date - s.data_inicio), s.intervalo_dias) = 0
    )
    AND NOT EXISTS (
        SELECT 1 FROM dose_logs dl
        WHERE dl.medication_id = m.id
        AND (dl.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date
            = (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND dl.reminder_sent = true
        AND dl.reminder_sent_at > now() - interval '5 minutes'
    );
$$;
