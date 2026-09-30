-- -----------------------------------------------------------------------------
-- v47 ONDA 3 — jornada catalogada (MH-100 parte D)
--
-- §2: os envios da jornada passam a registrar assunto. O fato da jornada
-- carrega um detalhe curto e estruturado (a etapa/campo corrente da coleta,
-- a chave do "ainda não") — nunca texto do usuário (o texto integral do
-- envio já vive em funil_envios.texto).
-- -----------------------------------------------------------------------------
ALTER TABLE public.funil_envio_assuntos ADD COLUMN detalhe text;
