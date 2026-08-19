-- =============================================================================
-- MH-073 Parte A — separar unidade de estoque da unidade de dose.
--
-- Quebra a equação implícita "1 schedule = 1 dose = 1 unidade de estoque".
-- Habilita medicamentos líquidos (dose em gotas/ml, estoque em ml) e corrige a
-- subcontabilização já existente em sólidos com mais de uma unidade por dose.
--
-- IMPORTANTE: get_pending_reminders declara estoque_atual como int no RETURNS
-- TABLE. Como a coluna passa a numeric, a função DEVE ser recriada no mesmo
-- script — caso contrário ela falha na primeira execução do cron, não aqui.
-- =============================================================================

-- ── 1. Tipos numéricos: estoque passa a aceitar fração (ml) ──────────────────
ALTER TABLE medications  ALTER COLUMN estoque_atual    TYPE numeric;
ALTER TABLE medications  ALTER COLUMN estoque_minimo   TYPE numeric;

ALTER TABLE stock_movements ALTER COLUMN quantidade_delta TYPE numeric;
ALTER TABLE stock_movements ALTER COLUMN estoque_anterior TYPE numeric;
ALTER TABLE stock_movements ALTER COLUMN estoque_novo     TYPE numeric;

-- ── 2. Unidades — chaves de comportamento (conjunto fechado) ─────────────────
ALTER TABLE medications
    ADD COLUMN IF NOT EXISTS unidade_estoque text NOT NULL DEFAULT 'unidade',
    ADD COLUMN IF NOT EXISTS unidade_dose    text NOT NULL DEFAULT 'unidade',
    ADD COLUMN IF NOT EXISTS gotas_por_ml    numeric DEFAULT 20;

ALTER TABLE medications
    ADD CONSTRAINT medications_unidade_estoque_check
        CHECK (unidade_estoque IN ('unidade','ml')),
    ADD CONSTRAINT medications_unidade_dose_check
        CHECK (unidade_dose IN ('unidade','ml','gota')),
    ADD CONSTRAINT medications_gotas_por_ml_check
        CHECK (gotas_por_ml IS NULL OR gotas_por_ml > 0);

-- Coerência entre os dois eixos: dose em gota/ml exige estoque em ml;
-- dose em unidade exige estoque em unidade. Barreira de schema (Princípio 41).
ALTER TABLE medications
    ADD CONSTRAINT medications_coerencia_unidades_check CHECK (
        (unidade_dose = 'unidade' AND unidade_estoque = 'unidade')
     OR (unidade_dose IN ('ml','gota') AND unidade_estoque = 'ml')
    );

-- gotas_por_ml só faz sentido quando a dose é em gotas.
ALTER TABLE medications
    ADD CONSTRAINT medications_gotas_por_ml_exigido_check CHECK (
        unidade_dose <> 'gota' OR gotas_por_ml IS NOT NULL
    );

-- ── 3. Quantidade por dose — posologia, na linha de posologia ────────────────
-- NOTA: a tabela `schedules` é, na prática, a tabela de posologia — guarda
-- horario, dias_semana e agora quantidade_por_dose. O nome é histórico; o
-- disparo real dos lembretes é feito por get_pending_reminders + node-cron.
-- Decisão consciente de NÃO renomear (v33).
ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS quantidade_por_dose numeric NOT NULL DEFAULT 1;

ALTER TABLE schedules
    ADD CONSTRAINT schedules_quantidade_por_dose_check
        CHECK (quantidade_por_dose > 0);

-- ── 4. Vínculo dose ↔ posologia ──────────────────────────────────────────────
-- Sem esta coluna não há como saber QUANTO debitar quando a quantidade varia
-- por horário. O scheduler já recebe schedule_id de get_pending_reminders e o
-- descartava. NULL = dose anterior à Parte A (quantidade tratada como 1).
ALTER TABLE dose_logs
    ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dose_logs_schedule_id
    ON dose_logs(schedule_id) WHERE schedule_id IS NOT NULL;

-- ── 5. Recriar get_pending_reminders ─────────────────────────────────────────
-- CREATE OR REPLACE NÃO consegue alterar o tipo de retorno: é obrigatório DROP.
-- Aproveita-se para expor quantidade_por_dose (necessária na Parte D para o
-- texto do lembrete) e evitar um segundo DROP futuro.
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
    gotas_por_ml         numeric
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
        m.gotas_por_ml
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

-- ── 6. Backfill ──────────────────────────────────────────────────────────────
-- Todos os medicamentos existentes são sólidos com 1 unidade por dose.
-- Os DEFAULT já cobrem as linhas existentes; os UPDATEs são idempotentes e
-- explícitos para deixar o estado inicial documentado.
UPDATE medications SET unidade_estoque = 'unidade', unidade_dose = 'unidade'
WHERE unidade_estoque IS NULL OR unidade_dose IS NULL;

UPDATE schedules SET quantidade_por_dose = 1 WHERE quantidade_por_dose IS NULL;

-- Correção pontual: Omega 3 — usuário toma 2 comprimidos por dose (evidência na
-- própria coluna dosagem). NÃO corrige estoque_atual — ver seção 8.3 do briefing.
UPDATE schedules SET quantidade_por_dose = 2
WHERE medication_id = 'af219595-9f67-48ba-b77e-6b5eceb8eae8';

-- ── 7. Comentários ───────────────────────────────────────────────────────────
COMMENT ON COLUMN medications.unidade_estoque IS
  'Unidade em que estoque_atual é contado: unidade | ml. Chave de comportamento (MH-073).';
COMMENT ON COLUMN medications.unidade_dose IS
  'Unidade em que a dose é administrada: unidade | ml | gota. Chave de comportamento (MH-073).';
COMMENT ON COLUMN medications.gotas_por_ml IS
  'Convenção 20 gts/ml por padrão; editável por medicamento. Âncora de conversão gota→ml (MH-073).';
COMMENT ON COLUMN medications.forma_farmaceutica IS
  'DESCRITIVO — apenas exibido ao usuário. NUNCA usar como condicional de cálculo. Use unidade_dose/unidade_estoque (MH-073 Parte A).';
COMMENT ON COLUMN schedules.quantidade_por_dose IS
  'Quantas unidades_dose se toma neste horário. Posologia (MH-073 Parte A).';
COMMENT ON COLUMN dose_logs.schedule_id IS
  'Posologia que originou a dose. NULL = anterior à MH-073 Parte A (quantidade tratada como 1).';
