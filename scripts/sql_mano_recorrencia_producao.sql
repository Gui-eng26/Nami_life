-- ============================================================================
-- v44 M2 (MH-77) — DESFAZER O PALIATIVO DA MANÔ (PRODUÇÃO, APÓS O MERGE)
--
-- Contexto (18/09): a Manô pediu "Desvenlafaxina seg-sex às 6h, sáb-dom às
-- 10h". Sem recorrência, o paliativo deixou o schedule das 06:00 DIÁRIO e o
-- das 10:00 desativado (ou inexistente). Com o MH-77 em produção, este script
-- restaura o pedido original dela:
--   • 06:00 restrito a seg-sex  (dias_semana = {seg,ter,qua,qui,sex})
--   • 10:00 ativo só em sáb-dom (dias_semana = {sab,dom})
--
-- AÇÃO DE GUILHERME (aprovação + execução manual no projeto de PRODUÇÃO,
-- nputymewnwmnhrtpizzs), rodando o SELECT antes para preencher os IDs.
-- Avisar a Manô depois — mensagem dela, não da Nami.
-- ============================================================================

-- 1) Conferir o medicamento e os schedules atuais da Manô:
SELECT m.id AS medication_id, m.nome, m.ativo AS med_ativo,
       s.id AS schedule_id, s.horario, s.ativo, s.dias_semana, s.quantidade_por_dose
FROM medications m
JOIN users u ON u.id = m.user_id
LEFT JOIN schedules s ON s.medication_id = m.id
WHERE m.nome ILIKE 'Desvenlafaxina%'
  AND u.name ILIKE 'Man%'           -- ajustar se necessário (ou filtrar por u.phone)
ORDER BY s.horario;

-- 2) Restringir o schedule das 06:00 a segunda–sexta:
-- UPDATE schedules
-- SET dias_semana = ARRAY['seg','ter','qua','qui','sex']
-- WHERE id = '<SCHEDULE_ID_06H>';

-- 3a) Se o schedule das 10:00 ainda existir (desativado): reativar só fim de semana:
-- UPDATE schedules
-- SET ativo = true, dias_semana = ARRAY['sab','dom']
-- WHERE id = '<SCHEDULE_ID_10H>';

-- 3b) Se o schedule das 10:00 NÃO existir mais: criar (mesma quantidade do 06:00):
-- INSERT INTO schedules (medication_id, horario, quantidade_por_dose, ativo, dias_semana)
-- VALUES ('<MEDICATION_ID>', '10:00', 3, true, ARRAY['sab','dom']);

-- 4) Conferência final (deve mostrar 06:00 seg-sex e 10:00 sab-dom, ambos ativos):
-- SELECT s.horario, s.ativo, s.dias_semana FROM schedules s
-- WHERE s.medication_id = '<MEDICATION_ID>' ORDER BY s.horario;
