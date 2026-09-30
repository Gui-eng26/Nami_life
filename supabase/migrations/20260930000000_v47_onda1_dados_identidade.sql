-- -----------------------------------------------------------------------------
-- v47 ONDA 1 — dados e identidade (MH-100 parte A · BUG-114 · BUG-115)
--
-- §1 — Vínculo envio ↔ assunto (N:N). Um envio do funil passa a declarar, no
-- ato do envio, SOBRE O QUE ele é (fatos tipados, doses e medicamentos). A
-- fonte de verdade da resolução de citação passa a ser o assunto;
-- dose_logs.funil_envio_id permanece como fallback legado (envios anteriores
-- a esta migração) — remoção é avaliada na onda 3.
-- -----------------------------------------------------------------------------
CREATE TABLE public.funil_envio_assuntos (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    envio_id       uuid NOT NULL REFERENCES public.funil_envios(id) ON DELETE CASCADE,
    fato           text NOT NULL, -- 'lembrete' | 'follow_up' | 'cobranca_encerrada'
                                  -- | 'alerta_estoque_zerado' | 'conclusao_tratamento'
                                  -- | 'resumo_semanal' | 'dose_confirmada' | 'dose_nao_tomada'
                                  -- | 'dose_desfeita' | 'mensagem_direcionada'
    dose_log_id    uuid REFERENCES public.dose_logs(id) ON DELETE SET NULL,
    medication_id  uuid REFERENCES public.medications(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_funil_envio_assuntos_envio ON public.funil_envio_assuntos(envio_id);

-- §4 (BUG-115) — toda função que confirma grava o status anterior; o desfazer
-- devolve a dose a ele. Nulo = confirmação anterior à migração (heurística
-- corrigida: tentativas < 3 → 'pendente', senão 'nao_informado' — nunca mais
-- 'nao_tomado' por reversão).
ALTER TABLE public.dose_logs ADD COLUMN status_pre_confirmacao text;

-- §5 — mensagem direcionada: o evento proativo carrega um resumo curto do
-- conteúdo (o texto completo vive em funil_envios.texto).
ALTER TABLE public.eventos_proativos ADD COLUMN resumo text;

-- §4.4 — trilha da reversão: a transição completa (status anterior →
-- confirmado → status devolvido, com motivo) vira evento de observabilidade.
-- Novo tipo 'trilha_auditoria': registro de auditoria, não item de triagem.
ALTER TABLE public.system_events DROP CONSTRAINT IF EXISTS system_events_tipo_check;
ALTER TABLE public.system_events ADD CONSTRAINT system_events_tipo_check
    CHECK (tipo IN ('erro_tecnico','desvio_comportamental','intencao_nao_suportada','trilha_auditoria'));
