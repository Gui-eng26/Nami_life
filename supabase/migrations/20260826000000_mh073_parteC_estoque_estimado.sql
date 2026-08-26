ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS estimado boolean NOT NULL DEFAULT false;

ALTER TABLE medications
    ADD COLUMN IF NOT EXISTS estoque_estimado boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN stock_movements.estimado IS
  'true quando o valor não veio de contagem exata (fração de frasco aberto, piso de segurança
   por falta de resposta, ou valor exato autorrelatado num frasco já aberto). MH-073 Parte C.';
COMMENT ON COLUMN medications.estoque_estimado IS
  'Snapshot vivo — true enquanto o valor atual de estoque_atual não vier de contagem exata.
   Consumido pela Parte E (limiar de alerta) e resetado para false na recompra com frasco
   lacrado (Parte E). MH-073 Parte C.';
