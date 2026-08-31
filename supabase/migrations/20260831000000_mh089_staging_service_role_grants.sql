-- MH-89 — Corrige privilégios do service_role suprimidos pela opção
-- "Automatically expose new tables" desmarcada na criação de um projeto Supabase.
-- Aplicado e validado manualmente no projeto Nami-staging (v40); este arquivo apenas
-- formaliza a correção como fonte única de verdade do schema.
-- Idempotente e inofensivo em produção, que já tem estes privilégios por padrão.

-- Objetos existentes
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Regra de fábrica para qualquer tabela, sequência ou função criada daqui pra frente
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;
