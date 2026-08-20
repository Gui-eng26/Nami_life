-- =============================================================================
-- BUG-100 — verbo de administração incorreto para medicamentos não ingeridos.
--
-- get_pending_reminders não devolvia forma_farmaceutica, então o texto do
-- lembrete não tinha como diferenciar "tomar" de "usar"/"aplicar". Adiciona
-- a coluna ao RETURNS TABLE e ao SELECT. Nenhuma outra coluna nem a cláusula
-- WHERE são alteradas.
--
-- CREATE OR REPLACE não altera RETURNS TABLE — é obrigatório DROP (mesmo
-- padrão da migration da Parte A).
-- =============================================================================

DROP FUNCTION IF EXISTS public.get_pending_reminders();

CREATE FUNCTION public.get_pending_reminders()
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
    AND NOT EXISTS (
        SELECT 1 FROM dose_logs dl
        WHERE dl.medication_id = m.id
        AND (dl.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date
            = (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND dl.reminder_sent = true
        AND dl.reminder_sent_at > now() - interval '5 minutes'
    );
$$;
