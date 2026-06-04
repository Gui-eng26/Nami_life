# 🌿 NAMI — Contexto do Projeto

---

## O que é a Nami

A Nami é um agente de IA via WhatsApp que ajuda pessoas a seguirem seus tratamentos médicos. O problema central que resolve: **baixa adesão a tratamentos**, especialmente em pacientes com doenças crônicas (hipertensão, diabetes, etc.). Segundo a OMS, menos de 50% dos pacientes com doenças crônicas seguem corretamente suas prescrições.

**Por que WhatsApp?**
- Não precisa de novo app
- É o canal mais usado pelo público em geral
- Diminui a curva de aprendizado
- Remove barreiras tecnológicas

**Inspiração de produto:** Magie (https://magie.com.br) — assistente financeira 100% via WhatsApp.

---

## Funcionalidades do MVP

1. Usuário cadastra medicamentos (texto, áudio ou foto da receita)
2. Nami envia lembretes nos horários certos via WhatsApp
3. Usuário confirma que tomou (SIM/NÃO)
4. Nami registra cada dose no banco
5. Usuário pode consultar histórico ("tomei hoje?")
6. Nami alerta quando o estoque estiver acabando
7. Usuário atualiza estoque após recompra

---

## Stack Tecnológica

| Componente | Ferramenta |
|---|---|
| Canal | WhatsApp Business API via **Z-API** |
| Backend | **Node.js** + Express |
| IA | **Claude API** (claude-sonnet-4-6) |
| Banco de dados | **Supabase** (PostgreSQL) |
| Scheduler | **node-cron** (lembretes automáticos) |
| Hospedagem | **Railway** (produção ativa) |

---

## Estrutura de Arquivos

```
nami-backend/
├── src/
│   ├── index.js              → Entry point + webhook receiver do Z-API
│   ├── agent.js              → Orquestrador principal — chama router, processa ações
│   ├── router.js             → Roteador de agentes — decide qual agente responde
│   ├── database.js           → Todas as queries no Supabase
│   ├── whatsapp.js           → Envio de mensagens e parse do payload Z-API
│   ├── scheduler.js          → Cron job — verifica e dispara lembretes a cada 2min
│   ├── prompts.js            → System prompt da Nami (agente principal)
│   └── agentes/
│       └── recepcionista.js  → Agente de boas-vindas para novos usuários
├── .env                      → Variáveis de ambiente (nunca subir pro GitHub)
├── .gitignore
├── package.json
├── CONTEXT.md                → Este arquivo
└── BRIEFING_V2.md            → Briefing de implementação da arquitetura multi-agente
```

---

## Variáveis de Ambiente (.env)

```env
SUPABASE_URL=https://[PROJECT_ID].supabase.co
SUPABASE_SERVICE_KEY=sb_secret_...   # secret key — bypassa RLS
ANTHROPIC_API_KEY=sk-ant-api03-...
ZAPI_INSTANCE_ID=[ID da instância]
ZAPI_TOKEN=[Token de integração]
ZAPI_CLIENT_TOKEN=[Client-Token da aba Segurança na Z-API]
PORT=3000
```

⚠️ `ZAPI_CLIENT_TOKEN` é obrigatório em toda requisição à Z-API. Está localizado
em **Segurança** no painel da Z-API — é diferente do `ZAPI_TOKEN`.

⚠️ `SUPABASE_URL` deve ser somente a URL base: `https://[ID].supabase.co`
Sem `/rest/v1/` ou qualquer sufixo — o cliente Supabase adiciona isso automaticamente.

---

## Banco de Dados — Supabase (PostgreSQL)

### Tabelas principais

**users** — cada paciente
```sql
id, phone (unique), name, onboarded, lgpd_accepted, lgpd_accepted_at,
created_at, updated_at
```

**medications** — medicamentos cadastrados
```sql
id, user_id (FK), nome, dosagem, instrucoes,
estoque_atual, estoque_minimo (default 7), ativo
```

**schedules** — horários de lembrete
```sql
id, medication_id (FK), horario (time), dias_semana (text[]), ativo
```

**dose_logs** — registro de cada dose
```sql
id, medication_id (FK), scheduled_at, reminder_sent, reminder_sent_at,
taken_at, confirmed, response_raw
```

**conversation_state** — estado atual da conversa por usuário
```sql
id, user_id (FK unique), state (text), context (jsonb), updated_at
```

**message_logs** — log de todas as mensagens
```sql
id, user_id (FK), direction (inbound/outbound), content, media_type, created_at
```

**agent_logs** — log de interações por agente
```sql
id, user_id (FK), agent (text), user_message (text), agent_response (text), created_at
```

### Função SQL importante
```sql
get_pending_reminders() -- retorna lembretes que devem ser disparados agora (±2min)
```

### Status do banco
- ✅ Schema criado e rodando no Supabase
- ✅ RLS habilitado em todas as tabelas (backend usa service_role key)

---

## Arquitetura Multi-Agente (v2)

A Nami evoluiu de um agente único para uma arquitetura multi-agente com roteador central.

### Roteador (`router.js`)

```
mensagem chega
      ↓
getOrCreateUser(phone)
      ↓
usuario.onboarded === false?
  → sim → agente_recepcionista
  → não → lê state da conversation_state
            ↓
        'cadastro'     → agente_cadastro (futuro)
        'lembrete'     → agente_lembrete (futuro)
        null / 'idle'  → agente_principal
```

### Agentes implementados

| Agente | Arquivo | Status |
|---|---|---|
| recepcionista | `src/agentes/recepcionista.js` | ✅ Implementado |
| principal | `src/agent.js` | ✅ Implementado |
| cadastro | `src/agentes/cadastro.js` | 🔜 Fase 2 |
| lembrete | `src/agentes/lembrete.js` | 🔜 Fase 2 |
| relatorios | `src/agentes/relatorios.js` | 🔜 Fase 3 |
| medicacoes | `src/agentes/medicacoes.js` | 🔜 Fase 3 (RAG) |

---

## Fluxo Principal de uma Mensagem

```
1. Usuário envia mensagem no WhatsApp
2. Z-API recebe e dispara webhook POST /webhook/whatsapp
3. index.js recebe → parseZApiPayload() extrai phone/text/audio/image
4. agent.js → handleIncomingMessage()
   ├── getOrCreateUser(phone)
   └── routeMessage({ user, message }) → router.js decide o agente
       ├── agente_recepcionista → se onboarded = false
       └── agente_principal     → se onboarded = true e state = idle
           ├── getConversationState(userId)
           ├── getUserMedications(userId)
           ├── getRecentDoses(userId)
           ├── callClaude() → retorna JSON {message, newState, context, action}
           ├── processAction() → SAVE_MEDICATION / CONFIRM_DOSE / SET_USER_NAME
           ├── updateConversationState()
           └── sendTextMessage(phone, message)
```

## Fluxo do Agente Recepcionista

```
Etapa 1: recep_boas_vindas
  → Nami se apresenta e pergunta o nome

Etapa 2: recep_coleta_nome
  → Nami salva o nome, explica o que faz, pede aceite LGPD

Etapa 3: recep_lgpd
  → Usuário confirma → lgpd_accepted=true, onboarded=true
  → Passa controle para agente principal
```

## Fluxo do Scheduler

```
A cada 2 minutos:
1. getPendingReminders() → busca via função SQL no Supabase
2. Para cada lembrete:
   ├── sendTextMessage() → envia lembrete no WhatsApp
   ├── createDoseLog() → registra envio no banco
   └── Se estoque_atual <= estoque_minimo → envia alerta de recompra
```

---

## Personalidade da Nami

- **Tom:** calorosa, empática, acolhedora — como uma enfermeira de confiança
- **Público:** adultos em tratamento contínuo — linguagem simples, frases curtas
- **Emojis:** com moderação — 💊 ✅ ⏰ 🌿
- **Limites:** NÃO dá conselhos médicos, NÃO altera posologia sem confirmação
- **Resposta (agente principal):** SEMPRE em JSON válido `{message, newState, context, action}`

### Estados da conversa (campo `state` na `conversation_state`)
- `idle` — aguardando
- `onboarding` — primeiro acesso, coletando nome (legado)
- `adding_med` — cadastrando medicamento
- `confirming` — aguardando confirmação de dose
- `recep_boas_vindas` — recepcionista: etapa 1
- `recep_coleta_nome` — recepcionista: etapa 2
- `recep_lgpd` — recepcionista: etapa 3

---

## Status Atual do Projeto

### ✅ Concluído
- Supabase com schema completo e RLS habilitado
- Z-API configurado, webhook apontando para Railway
- WhatsApp conectado à instância nami-mvp
- Backend em produção no Railway (24/7)
- URL pública: `https://namilife-production.up.railway.app`
- Nami respondendo mensagens reais em produção
- Arquitetura multi-agente implementada (router + recepcionista)

### 🔜 Próximas fases

**Fase 2 — Especialização de agentes**
- `agente_cadastro` — fluxo dedicado de cadastro de medicamentos
- `agente_lembrete` — lógica de follow-up e escalação
- Dashboard de relatórios para administrador
- Timestamp de confirmação real vs. horário agendado

**Fase 3 — Inteligência e escala**
- `agente_medicacoes` com RAG no bulário ANVISA
- `leitor_receita` — OCR de receitas médicas
- `agente_acompanhamento` — NPS e feedback
- Conformidade LGPD completa

---

## Como rodar localmente

```bash
npm install
node src/index.js
```

Para desenvolvimento local com webhook, use ngrok:
```bash
ngrok http 3000
# Atualizar URL do webhook no painel Z-API com a URL gerada
```

Em produção, o webhook aponta permanentemente para:
```
https://namilife-production.up.railway.app/webhook/whatsapp
```

---

## Dependências instaladas

```json
"dependencies": {
  "@anthropic-ai/sdk": "latest",
  "@supabase/supabase-js": "latest",
  "axios": "latest",
  "dotenv": "latest",
  "express": "latest",
  "node-cron": "latest",
  "node-fetch": "latest"
}
```