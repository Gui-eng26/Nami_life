-- -----------------------------------------------------------------------------
-- FUNIL ÚNICO DE SAÍDA (v44 M1, briefing §5.5)
-- Toda mensagem que sai da Nami — reativa e proativa, scheduler incluso — passa
-- por um único ponto de envio+log (src/funil.js:enviarAoUsuario) e vira uma
-- linha aqui. Registro de ENTREGA, escrito imediatamente após o envio.
--
-- zaap_id E message_id são gravados AMBOS até o T0 (teste de compatibilidade de
-- id da citação) decidir qual deles bate com o referenceMessageId do webhook —
-- a resolução de citação (§5.6) compara contra os dois.
-- -----------------------------------------------------------------------------
CREATE TABLE public.funil_envios (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid REFERENCES public.users(id) ON DELETE CASCADE,
    phone           text NOT NULL,
    texto           text NOT NULL,
    origem          text NOT NULL, -- 'agente:<nome>' | 'proativo:<tipo>' | 'cuidador:<tipo>'
    zaap_id         text,          -- id devolvido pela Z-API no envio (campo zaapId)
    message_id      text,          -- id devolvido pela Z-API no envio (campo messageId)
    agent_log_id    uuid REFERENCES public.agent_logs(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_funil_envios_zaap_id ON public.funil_envios(zaap_id);
CREATE INDEX idx_funil_envios_message_id ON public.funil_envios(message_id);
CREATE INDEX idx_funil_envios_user_created ON public.funil_envios(user_id, created_at DESC);

-- MH-032 (gap corrigido): o lembrete/follow-up AGRUPADO grava o envio vinculado
-- ao grupo — as N doses apontam para o registro do funil. Antes, scheduler.js
-- descartava o id da mensagem agrupada e a citação dela era irreconhecível.
ALTER TABLE public.dose_logs
    ADD COLUMN funil_envio_id uuid REFERENCES public.funil_envios(id) ON DELETE SET NULL;

CREATE INDEX idx_dose_logs_funil_envio ON public.dose_logs(funil_envio_id);
