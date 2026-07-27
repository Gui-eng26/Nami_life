-- MH-53 — Backbone de observabilidade
-- system_events (sinais automáticos) + feedbacks (sinais do usuário)
-- delete_user_account NÃO é tocado: FKs ON DELETE SET NULL anonimizam sozinhas.

CREATE TABLE system_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo            text NOT NULL
                     CHECK (tipo IN ('erro_tecnico','desvio_comportamental','intencao_nao_suportada')),
    severidade      text NOT NULL
                     CHECK (severidade IN ('baixa','media','alta','critica')),
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    agent           text,
    origem          text NOT NULL
                     CHECK (origem IN ('catch_global','classificador_central','juiz_offline','scheduler','outro')),
    agent_log_id    uuid REFERENCES agent_logs(id) ON DELETE SET NULL,
    titulo          text,
    payload         jsonb,
    fingerprint     text,
    status_triagem  text NOT NULL DEFAULT 'novo'
                     CHECK (status_triagem IN ('novo','lido','arquivado','virou_backlog')),
    backlog_ref     text,
    revisado_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_system_events_status   ON system_events (status_triagem);
CREATE INDEX idx_system_events_tipo_sev ON system_events (tipo, severidade);
CREATE INDEX idx_system_events_created  ON system_events (created_at DESC);
CREATE INDEX idx_system_events_fp       ON system_events (fingerprint);

ALTER TABLE system_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE feedbacks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    categoria       text NOT NULL
                     CHECK (categoria IN ('elogio','critica','sugestao')),
    origem          text NOT NULL
                     CHECK (origem IN ('espontaneo','proativo_adesao','proativo_outro')),
    texto           text NOT NULL,
    agent_log_id    uuid REFERENCES agent_logs(id) ON DELETE SET NULL,
    status_triagem  text NOT NULL DEFAULT 'novo'
                     CHECK (status_triagem IN ('novo','lido','arquivado','virou_backlog')),
    backlog_ref     text,
    revisado_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_feedbacks_status    ON feedbacks (status_triagem);
CREATE INDEX idx_feedbacks_categoria ON feedbacks (categoria);
CREATE INDEX idx_feedbacks_created   ON feedbacks (created_at DESC);

ALTER TABLE feedbacks ENABLE ROW LEVEL SECURITY;

-- Verificação pós-migration (esperado: as duas FKs para users com delete_rule = SET NULL):
-- SELECT tc.table_name, kcu.column_name, rc.delete_rule
-- FROM information_schema.table_constraints tc
-- JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
-- JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
-- WHERE tc.constraint_type='FOREIGN KEY'
--   AND tc.table_name IN ('system_events','feedbacks');
