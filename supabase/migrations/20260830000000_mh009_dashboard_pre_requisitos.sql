-- MH-009 — pré-requisitos do dashboard de indicadores do Ciclo 2 (§5 do briefing).

-- §5.1: marcação de conta de teste. Coluna no banco, não lista em env — contas de teste
-- continuam sendo criadas durante o beta, e lista em env diverge do banco sem aviso.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_teste boolean NOT NULL DEFAULT false;

UPDATE users SET is_teste = true
WHERE phone IN (
  '+5519996078506',
  '+5519998093582',
  '+5511941065858'
);

COMMENT ON COLUMN users.is_teste IS
  'Conta de teste do fundador/família — excluída das métricas de perfil, medicamentos,
   adesão e feedback do dashboard (MH-009). Painel de sinais de degradação é exceção
   deliberada (system_events não filtra, ver §4.1 do briefing).';

-- §5.2: faixa etária calculada em tempo de consulta, nunca armazenada.
CREATE OR REPLACE FUNCTION faixa_etaria(nascimento date)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN nascimento IS NULL THEN 'nao_informado'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 20 THEN 'menor_20'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 30 THEN '20_29'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 50 THEN '30_49'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 60 THEN '50_59'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 70 THEN '60_69'
    ELSE '70_mais'
  END
$$;

-- §5.3: backfill administrativo das datas de nascimento (decisão v39), preservando o
-- histórico do Ciclo 1 em vez de apagar e recadastrar.
UPDATE users SET data_nascimento = '1989-11-06' WHERE phone IN ('+5519996078506','+5519998093582','+5511941065858');
UPDATE users SET data_nascimento = '1966-04-01' WHERE phone = '+5519988811053';
UPDATE users SET data_nascimento = '1987-02-26' WHERE phone = '+554184800404';
UPDATE users SET data_nascimento = '1997-05-27' WHERE phone = '+5519993961820';
UPDATE users SET data_nascimento = '1997-09-30' WHERE phone = '+5519994349690';
UPDATE users SET data_nascimento = '2000-01-01' WHERE phone = '+5516997994376';
UPDATE users SET data_nascimento = '1991-04-29' WHERE phone = '+5519988491053';

-- §5.4: índices para as consultas de leitura do dashboard.
CREATE INDEX IF NOT EXISTS idx_dose_logs_scheduled_at ON dose_logs (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_agent_logs_user_created ON agent_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_created_tipo ON system_events (created_at, tipo);
