-- -----------------------------------------------------------------------------
-- EVENTOS_PROATIVOS (MH-70, v28)
-- Registro de ENTREGA (escrito no instante do envio), nunca de intenção — mesma
-- semântica de dose_logs, mas append-only: ao contrário de dose_logs, cada envio
-- gera uma linha própria, que nunca é sobrescrita por um envio posterior.
-- Existe para permitir ao contexto proativo do classificador central (Parte C
-- desta mesma sessão) reconstruir a linha do tempo real de mensagens que a Nami
-- enviou por iniciativa própria, sem depender do estado mutável de dose_logs.
-- Ver decisão de arquitetura na sessão v28: getContextoProativoRecente (MH-065)
-- reconstruía a partir de dose_logs, que só guarda o último follow-up — os
-- follow-ups intermediários se perdiam antes de qualquer leitura acontecer.
-- -----------------------------------------------------------------------------
CREATE TABLE public.eventos_proativos (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid REFERENCES public.users(id) ON DELETE CASCADE,
    tipo                text NOT NULL, -- 'lembrete' | 'follow_up' | 'alerta_estoque_zerado'
                                       -- | 'alerta_estoque_nao_informado' | 'resumo_semanal'
    medication_id       uuid REFERENCES public.medications(id) ON DELETE CASCADE,
    dose_log_id         uuid REFERENCES public.dose_logs(id) ON DELETE SET NULL,
    tentativa           int,           -- só relevante para tipo 'follow_up'
    horario_agendado    time,          -- copiado no momento do envio, não por join depois
    enviado_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_eventos_proativos_user_enviado ON public.eventos_proativos(user_id, enviado_at);
