-- v26: acrescenta 'nao_valida' ao status_triagem de system_events e feedbacks.
-- Motivo: a partir da v26 o juiz opera com tolerância deliberada a falso positivo
-- (falso positivo é barato, falso negativo é caro). O fluxo de triagem precisa
-- distinguir "avaliei e não era defeito" de "é defeito real, arquivado por ora".
-- Sem essa distinção, 'arquivado' vira balde único e o dash não consegue medir
-- a taxa de falso positivo do juiz.

ALTER TABLE system_events DROP CONSTRAINT system_events_status_triagem_check;
ALTER TABLE system_events ADD CONSTRAINT system_events_status_triagem_check
    CHECK (status_triagem IN ('novo','lido','arquivado','virou_backlog','nao_valida'));

ALTER TABLE feedbacks DROP CONSTRAINT feedbacks_status_triagem_check;
ALTER TABLE feedbacks ADD CONSTRAINT feedbacks_status_triagem_check
    CHECK (status_triagem IN ('novo','lido','arquivado','virou_backlog','nao_valida'));
