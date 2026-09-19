-- -----------------------------------------------------------------------------
-- CITAÇÃO COMO CONTEXTO DE PRIMEIRA CLASSE (v44 M1, briefing §5.6 — supera BUG-029)
-- agent_logs.reference_message_id: observabilidade de uso da função "responder"
-- do WhatsApp — quantos turnos chegam citando uma mensagem anterior.
-- A resolução do conteúdo citado acontece via funil_envios (zaap_id/message_id).
-- -----------------------------------------------------------------------------
ALTER TABLE public.agent_logs
    ADD COLUMN reference_message_id text;
