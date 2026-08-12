-- MH-072 Parte A: coleta de data de nascimento no onboarding.
-- Finalidade declarada: idade média agregada do público da Nami — sem
-- personalização por faixa etária neste escopo (ver briefings/BRIEFING_MH072_PARTEA.md).

ALTER TABLE users ADD COLUMN IF NOT EXISTS data_nascimento date;

COMMENT ON COLUMN users.data_nascimento IS
  'Data de nascimento informada pelo usuário no onboarding (MH-072). Dado bruto —
   idade é sempre calculada em tempo de consulta, nunca armazenada (princípio 19).';
