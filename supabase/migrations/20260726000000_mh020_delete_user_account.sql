-- MH-020: exclusão atômica de conta de usuário a pedido explícito (LGPD).
-- Ordem de deleção necessária por causa de duas FKs com NO ACTION:
--   stock_movements (-> medications, -> dose_logs) e adesao_estado (-> users).
-- A função roda numa transação implícita: ou apaga tudo, ou nada (rollback em erro).

CREATE OR REPLACE FUNCTION delete_user_account(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- 1) stock_movements referencia medications e dose_logs com NO ACTION.
    --    Todo movimento tem medication_id (invariante do MH-042), então apagar por
    --    medication_id do usuário cobre 100% das linhas, inclusive as que apontam para dose_logs.
    DELETE FROM stock_movements
    WHERE medication_id IN (SELECT id FROM medications WHERE user_id = p_user_id);

    -- 2) adesao_estado referencia users com NO ACTION -> apagar antes de users.
    DELETE FROM adesao_estado WHERE user_id = p_user_id;

    -- 3) users -> CASCADE cobre o resto:
    --    medications (-> dose_logs, schedules), agent_logs, care_network,
    --    conversation_state, intencoes_nao_suportadas.
    DELETE FROM users WHERE id = p_user_id;
END;
$$;
