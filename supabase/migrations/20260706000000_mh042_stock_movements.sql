-- MH-042: tabela de auditoria de movimentação de estoque.
-- Append-only — nunca dar UPDATE ou DELETE em linhas existentes.
-- Aplicada manualmente no SQL Editor do Supabase (mesmo padrão do MH-032).
CREATE TABLE stock_movements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    medication_id       uuid NOT NULL REFERENCES medications(id),
    tipo                text NOT NULL CHECK (tipo IN (
                            'cadastro_inicial',
                            'cadastro_substituicao',
                            'reativacao_com_estoque',
                            'recompra',
                            'correcao_soma',
                            'correcao_subtracao',
                            'correcao_set',
                            'dose_confirmada',
                            'dose_retroativa',
                            'dose_revertida'
                        )),
    origem              text NOT NULL CHECK (origem IN ('manual', 'automatico')),
    quantidade_delta    integer NOT NULL,      -- valor efetivamente aplicado, com sinal
    estoque_anterior    integer,               -- null apenas em cadastro_inicial
    estoque_novo        integer NOT NULL,
    motivo              text,                  -- texto livre extraído da mensagem (quando manual)
    dose_log_id         uuid REFERENCES dose_logs(id),  -- preenchido quando o movimento vem de uma dose
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_movements_medication ON stock_movements(medication_id, created_at DESC);
