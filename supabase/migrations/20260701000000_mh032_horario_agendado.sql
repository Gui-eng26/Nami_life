-- MH-032: horário de cadastro (schedules.horario) que originou a dose.
-- Usado para agrupar lembretes/follow-ups de doses do mesmo horário exato.
-- NULL nos registros antigos (pré-migration) → tratados como não-agrupáveis (fallback individual).
-- Não confundir com scheduled_at (timestamp do disparo do cron, mantido intocado).
ALTER TABLE dose_logs
  ADD COLUMN horario_agendado time;
