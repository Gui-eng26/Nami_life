-- ============================================================================
-- v44 M2 (MH-77) — DESFAZER O PALIATIVO DA MANÔ (PRODUÇÃO)
--
-- Contexto (18/09): a Manô pediu "Desvenlafaxina seg-sex às 6h, sáb-dom às
-- 10h". Sem recorrência, o paliativo deixou o schedule das 06:00 DIÁRIO e o
-- das 10:00 desativado. Com o MH-77 EM PRODUÇÃO (promovido em 19/09), este
-- script restaura o pedido original dela.
--
-- IDs preenchidos em 19/09/2026 a partir do SELECT de conferência (produção):
--   medication  c7bd60ef-bdd9-4f60-a97f-45174bbfbc2c  (Desvenlafaxina, ativa)
--   schedule 06:00  a853eabe-da7a-47b6-97b6-8fefbb7f6572  (ativo, diário — paliativo)
--   schedule 10:00  10ffb7b8-ed46-4925-8db9-4b5dc9726505  (desativado, 3 cp)
--
-- AÇÃO DE GUILHERME (aprovação + execução no SQL Editor de PRODUÇÃO,
-- nputymewnwmnhrtpizzs). Avisar a Manô depois — mensagem dele, não da Nami.
-- ============================================================================

-- 1) Restringir o schedule das 06:00 a segunda–sexta:
UPDATE schedules
SET dias_semana = ARRAY['seg','ter','qua','qui','sex']
WHERE id = 'a853eabe-da7a-47b6-97b6-8fefbb7f6572';

-- 2) Reativar o schedule das 10:00 só no fim de semana:
UPDATE schedules
SET ativo = true, dias_semana = ARRAY['sab','dom']
WHERE id = '10ffb7b8-ed46-4925-8db9-4b5dc9726505';

-- 3) Conferência final (esperado: 06:00 seg-sex e 10:00 sab-dom, ambos ativos,
--    3 comprimidos cada):
SELECT s.horario, s.ativo, s.dias_semana, s.quantidade_por_dose
FROM schedules s
WHERE s.medication_id = 'c7bd60ef-bdd9-4f60-a97f-45174bbfbc2c'
ORDER BY s.horario;
