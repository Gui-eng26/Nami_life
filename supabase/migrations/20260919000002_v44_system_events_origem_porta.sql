-- -----------------------------------------------------------------------------
-- v44: o CHECK de system_events.origem não conhecia os pontos novos da
-- arquitetura ('porta', 'funil') — o evento intencao_nao_suportada da porta
-- estava sendo PERDIDO no insert (achado da 1ª execução do arnês, 19/09).
-- 'classificador_central' permanece por causa das linhas históricas.
-- -----------------------------------------------------------------------------
ALTER TABLE public.system_events
    DROP CONSTRAINT system_events_origem_check;

ALTER TABLE public.system_events
    ADD CONSTRAINT system_events_origem_check
    CHECK (origem = ANY (ARRAY[
        'catch_global'::text,
        'classificador_central'::text,
        'juiz_offline'::text,
        'scheduler'::text,
        'outro'::text,
        'porta'::text,
        'funil'::text
    ]));
