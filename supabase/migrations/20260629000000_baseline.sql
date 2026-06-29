-- =============================================================================
-- NAMI LIFE — Database Schema Baseline
-- Gerado em: 2026-06-29
-- Estado: v10 consolidado + colunas de reversão da v11 (em andamento)
-- Banco: Supabase PostgreSQL (projeto Brasil — São Paulo)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- USERS
-- Usuários cadastrados na Nami via WhatsApp.
-- phone é único e armazenado com prefixo +55 (ex: +5511999999999).
-- -----------------------------------------------------------------------------
CREATE TABLE public.users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone               text NOT NULL UNIQUE,
    name                text,
    onboarded           boolean DEFAULT false,
    lgpd_accepted       boolean DEFAULT false,
    lgpd_accepted_at    timestamptz,
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- MEDICATIONS
-- Medicamentos cadastrados por usuário.
-- tipo_tratamento: 'continuo' | 'agudo'
-- forma_farmaceutica: 'comprimido' | 'capsula' | 'liquido' | etc.
-- tratamento_dias e tratamento_fim: preenchidos apenas para tratamentos agudos.
-- estoque_minimo: mantido por compatibilidade; alerta de estoque usa lógica no código.
-- ativo: false quando medicamento é pausado ou encerrado.
-- -----------------------------------------------------------------------------
CREATE TABLE public.medications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid REFERENCES public.users(id),
    nome                text NOT NULL,
    dosagem             text,
    instrucoes          text,
    estoque_atual       integer DEFAULT 0,
    estoque_minimo      integer DEFAULT 7,
    forma_farmaceutica  text DEFAULT 'comprimido',
    tipo_tratamento     text DEFAULT 'continuo',
    tratamento_dias     integer,
    tratamento_fim      date,
    ativo               boolean DEFAULT true,
    created_at          timestamptz DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- SCHEDULES
-- Horários de lembrete por medicamento.
-- Um medicamento pode ter múltiplos schedules (ex: 08:00 e 20:00).
-- dias_semana: array de texto com abreviações ['seg','ter','qua','qui','sex','sab','dom'].
-- ativo: false quando o schedule é pausado (ex: via agente_configuracao).
-- -----------------------------------------------------------------------------
CREATE TABLE public.schedules (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    medication_id   uuid REFERENCES public.medications(id),
    horario         time NOT NULL,
    dias_semana     text[] DEFAULT ARRAY['seg','ter','qua','qui','sex','sab','dom'],
    ativo           boolean DEFAULT true,
    created_at      timestamptz DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- DOSE_LOGS
-- Registro de cada dose agendada e seu ciclo de vida.
-- Uma entrada é criada pelo scheduler no momento do envio do lembrete.
--
-- status (ciclo de vida):
--   'pendente'      → lembrete enviado, aguardando confirmação
--   'confirmado'    → usuário confirmou que tomou
--   'nao_tomado'    → usuário disse explicitamente que não vai tomar
--   'nao_informado' → 3 follow-ups sem resposta; estado terminal
--   'sem_estoque'   → lembrete não enviado por falta de estoque
--
-- zapi_message_id: formato zaapId (019E...) — NÃO coincide com referenceMessageId
--   do WhatsApp (3EB0...). Limitação conhecida e aceita (BUG-029).
--
-- Colunas de reversão (v11 — em andamento):
--   revertido       → true quando uma confirmação foi revertida
--   revertido_at    → timestamp da reversão
--   revertido_de    → status anterior à reversão (ex: 'confirmado')
--   revertido_motivo → texto livre explicando o motivo da reversão
--   Propósito: trilha auditável de dado clínico — nunca sobrescrever silenciosamente.
-- -----------------------------------------------------------------------------
CREATE TABLE public.dose_logs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    medication_id           uuid REFERENCES public.medications(id),
    scheduled_at            timestamptz NOT NULL,
    reminder_sent           boolean DEFAULT false,
    reminder_sent_at        timestamptz,
    taken_at                timestamptz,
    confirmed               boolean DEFAULT false,
    response_raw            text,
    caregiver_notified      boolean DEFAULT false,
    caregiver_notified_at   timestamptz,
    status                  text DEFAULT 'pendente',
    tentativas              integer DEFAULT 0,
    ultima_tentativa_at     timestamptz,
    zapi_message_id         text,
    -- v11: trilha auditável de reversão de confirmação
    revertido               boolean DEFAULT false,
    revertido_at            timestamptz,
    revertido_de            text,
    revertido_motivo        text
);


-- -----------------------------------------------------------------------------
-- CONVERSATION_STATE
-- Estado conversacional por usuário (um registro por usuário, upsert).
-- state: string que identifica o agente/etapa atual (ex: 'idle', 'adding_med',
--   'cadastrando_medicamento', 'configurando', 'post_onboarding').
-- context: JSONB livre — cada agente persiste os dados da conversa em andamento.
-- ATENÇÃO: tabela é 'conversation_state' (sem 's') — 'conversation_states' não existe.
-- -----------------------------------------------------------------------------
CREATE TABLE public.conversation_state (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid UNIQUE REFERENCES public.users(id),
    state       text DEFAULT 'idle',
    context     jsonb DEFAULT '{}',
    updated_at  timestamptz DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- AGENT_LOGS
-- Histórico de todas as interações processadas pelos agentes LLM.
-- É a fonte de verdade do histórico conversacional (getHistoricoRecente lê daqui).
-- NOTA: message_logs existe no banco Oregon mas está vazia e não é usada.
--
-- estado_conversa / contexto_conversa: capturam o estado no momento exato
--   da interação — essenciais para diagnóstico, pois o estado já foi sobrescrito
--   quando o bug é investigado. Fast-path registra null nesses campos.
-- -----------------------------------------------------------------------------
CREATE TABLE public.agent_logs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid REFERENCES public.users(id),
    agent               text NOT NULL,
    user_message        text,
    agent_response      text,
    estado_conversa     text,
    contexto_conversa   jsonb,
    created_at          timestamptz DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- INTENCOES_NAO_SUPORTADAS
-- Registra pedidos que a Nami ainda não atende (ex: alterar dosagem,
-- registrar sintomas). Alimentado em 3 camadas: classificador do roteador
-- (categoria nao_suportado), flag intencaoNaoSuportada no principal, e
-- rede de segurança nos agentes especializados.
-- revisado: coluna para o dev marcar o que já avaliou para roadmap.
-- -----------------------------------------------------------------------------
CREATE TABLE public.intencoes_nao_suportadas (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid REFERENCES public.users(id),
    mensagem    text NOT NULL,
    revisado    boolean DEFAULT false,
    created_at  timestamptz DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- CARE_NETWORK
-- Rede de cuidado: conecta paciente (user_id) e cuidador (caregiver_id).
-- Estrutura preparada para Fase 3 — sem interface implementada ainda.
-- permissions: JSONB para configurar o que o cuidador pode ver/fazer.
-- status: 'pending' | 'active' | 'revoked'
-- -----------------------------------------------------------------------------
CREATE TABLE public.care_network (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid REFERENCES public.users(id),
    caregiver_id    uuid REFERENCES public.users(id),
    relationship    text,
    permissions     jsonb DEFAULT '{}',
    status          text DEFAULT 'pending',
    created_at      timestamptz DEFAULT now()
);


-- =============================================================================
-- STORED FUNCTIONS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- get_pending_reminders()
-- Usada pelo scheduler (node-cron) a cada minuto para buscar doses a enviar.
-- Filtra por: schedules ativos, medicamentos ativos, janela de ±2 minutos
-- em horário de Brasília, dia da semana correto, e exclui doses já enviadas
-- nos últimos 5 minutos (proteção contra duplicação).
-- Atualizada em 15/06/2026 (BUG-031): todas as comparações usam
-- AT TIME ZONE 'America/Sao_Paulo' para evitar duplicação ao cruzar meia-noite UTC.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_pending_reminders()
RETURNS TABLE (
    schedule_id     uuid,
    medication_id   uuid,
    user_id         uuid,
    phone           text,
    user_name       text,
    med_nome        text,
    med_dosagem     text,
    horario         time,
    estoque_atual   int,
    estoque_minimo  int
)
LANGUAGE sql
AS $$
    SELECT
        s.id            AS schedule_id,
        m.id            AS medication_id,
        u.id            AS user_id,
        u.phone,
        u.name          AS user_name,
        m.nome          AS med_nome,
        m.dosagem       AS med_dosagem,
        s.horario,
        m.estoque_atual,
        m.estoque_minimo
    FROM schedules s
    JOIN medications m ON m.id = s.medication_id
    JOIN users u ON u.id = m.user_id
    WHERE s.ativo = true
    AND m.ativo = true
    AND s.horario BETWEEN
        (now() AT TIME ZONE 'America/Sao_Paulo')::time - interval '2 minutes'
        AND
        (now() AT TIME ZONE 'America/Sao_Paulo')::time + interval '2 minutes'
    AND (
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 1 AND 'seg' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 2 AND 'ter' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 3 AND 'qua' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 4 AND 'qui' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 5 AND 'sex' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 6 AND 'sab' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 0 AND 'dom' = ANY(s.dias_semana))
    )
    AND NOT EXISTS (
        SELECT 1 FROM dose_logs dl
        WHERE dl.medication_id = m.id
        AND (dl.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date
            = (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND dl.reminder_sent = true
        AND dl.reminder_sent_at > now() - interval '5 minutes'
    );
$$;


-- -----------------------------------------------------------------------------
-- get_dose_history(p_user_id uuid, p_days int)
-- Usada pelo agente_relatorios para buscar histórico de doses do usuário.
-- Retorna doses dos últimos p_days dias, ordenadas da mais recente para a mais antiga.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dose_history(p_user_id uuid, p_days int)
RETURNS TABLE (
    med_nome        text,
    scheduled_at    timestamptz,
    confirmed       boolean,
    taken_at        timestamptz
)
LANGUAGE sql
AS $$
    SELECT
        m.nome AS med_nome,
        dl.scheduled_at,
        dl.confirmed,
        dl.taken_at
    FROM dose_logs dl
    JOIN medications m ON m.id = dl.medication_id
    WHERE m.user_id = p_user_id
    AND dl.scheduled_at >= now() - (p_days || ' days')::interval
    ORDER BY dl.scheduled_at DESC;
$$;
