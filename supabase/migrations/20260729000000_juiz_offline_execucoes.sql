-- MH-58: telemetria de execução do Juiz Offline (prova de vida diária, independente de desvio encontrado)
CREATE TABLE juiz_offline_execucoes (
    id BIGSERIAL PRIMARY KEY,
    data_avaliada DATE NOT NULL,               -- dia sendo avaliado (janela UTC do dia anterior), NÃO a data de execução
    turnos_totais INTEGER,                     -- total de agent_logs na janela; NULL se quebrou antes de coletar
    episodios_totais INTEGER,                  -- total de episódios formados; NULL se quebrou antes de coletar
    episodios_pulados_idempotencia INTEGER NOT NULL DEFAULT 0, -- já julgados com desvio em execução anterior (ver seção 4)
    episodios_avaliados INTEGER NOT NULL DEFAULT 0,            -- enviados ao LLM E com veredito interpretável (parse ok)
    episodios_falha_julgamento INTEGER NOT NULL DEFAULT 0,     -- enviados ao LLM, retorno não interpretável (JSON/categoria inválida)
    turnos_avaliados INTEGER NOT NULL DEFAULT 0,               -- soma de turnos só dos episódios em episodios_avaliados
    eventos_registrados INTEGER NOT NULL DEFAULT 0,            -- quantos system_events (desvios) esta execução gerou
    status TEXT NOT NULL CHECK (status IN ('sucesso', 'falha_parcial', 'falha_total')),
    erro_resumo TEXT,                          -- resumo curto do erro quando status <> 'sucesso'; detalhe completo já mora em system_events
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()  -- quando esta linha foi de fato gravada (= quando a execução rodou)
);

CREATE INDEX idx_juiz_offline_execucoes_data ON juiz_offline_execucoes (data_avaliada);
