# 🌿 NAMI — Contexto do Projeto

---

## O que é a Nami

A Nami é um agente de IA via WhatsApp que ajuda pessoas a seguirem seus tratamentos médicos. O problema central que resolve: **baixa adesão a tratamentos**, especialmente em pacientes com doenças crônicas (hipertensão, diabetes, etc.). Segundo a OMS, menos de 50% dos pacientes com doenças crônicas seguem corretamente suas prescrições.

**Por que WhatsApp?**
- Não precisa de novo app
- É o canal mais usado pelo público idoso
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
| Túnel local | **ngrok** |
| Hospedagem futura | Railway |

---

## Estrutura de Arquivos

```
nami-backend/
├── src/
│   ├── index.js        → Entry point + webhook receiver do Z-API
│   ├── agent.js        → Orquestrador principal — chama Claude, processa ações
│   ├── database.js     → Todas as queries no Supabase
│   ├── whatsapp.js     → Envio de mensagens e parse do payload Z-API
│   ├── scheduler.js    → Cron job — verifica e dispara lembretes a cada 2min
│   └── prompts.js      → System prompt completo da Nami
├── .env                → Variáveis de ambiente (nunca subir pro GitHub)
├── .gitignore
├── package.json
└── CONTEXT.md          → Este arquivo
```

---

## Variáveis de Ambiente (.env)

```env
SUPABASE_URL=https://[PROJECT_ID].supabase.co
SUPABASE_SERVICE_KEY=eyJ...          # service_role key — bypassa RLS
ANTHROPIC_API_KEY=sk-ant-api03-...
ZAPI_INSTANCE_ID=[ID da instância]
ZAPI_TOKEN=[Token de integração]
PORT=3000
```

---

## Banco de Dados — Supabase (PostgreSQL)

### Tabelas principais

**users** — cada paciente
```sql
id, phone (unique), name, onboarded, created_at, updated_at
```

**medications** — medicamentos cadastrados
```sql
id, user_id (FK), nome, dosagem, instrucoes, estoque_atual, estoque_minimo (default 7), ativo
```

**schedules** — horários de lembrete
```sql
id, medication_id (FK), horario (time), dias_semana (text[]), ativo
```

**dose_logs** — registro de cada dose
```sql
id, medication_id (FK), scheduled_at, reminder_sent, reminder_sent_at, taken_at, confirmed, response_raw
```

**conversation_state** — estado atual da conversa por usuário
```sql
id, user_id (FK unique), state (idle/onboarding/adding_med/confirming), context (jsonb), updated_at
```

**message_logs** — log de todas as mensagens
```sql
id, user_id (FK), direction (inbound/outbound), content, media_type, created_at
```

### Função SQL importante
```sql
get_pending_reminders() -- retorna lembretes que devem ser disparados agora (±2min)
```

### Status do banco
- ✅ Schema criado e rodando no Supabase
- ✅ RLS habilitado (backend usa service_role key)

---

## Fluxo Principal de uma Mensagem

```
1. Usuário envia mensagem no WhatsApp
2. Z-API recebe e dispara webhook POST /webhook/whatsapp
3. index.js recebe → parseZApiPayload() extrai phone/text/audio/image
4. agent.js → handleIncomingMessage()
   ├── getOrCreateUser(phone)
   ├── getConversationState(userId)
   ├── getUserMedications(userId)
   ├── getRecentDoses(userId)
   ├── buildUserMessage() → monta contexto para o Claude
   ├── callClaude() → retorna JSON com {message, newState, context, action}
   ├── processAction() → executa SAVE_MEDICATION / CONFIRM_DOSE / SET_USER_NAME
   ├── updateConversationState()
   └── sendTextMessage(phone, message)
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

- **Tom:** calorosa, empática, como uma enfermeira de confiança
- **Público:** idosos e pacientes crônicos — linguagem simples, frases curtas
- **Emojis:** com moderação — 💊 ✅ ⏰ 🌿
- **Limites:** NÃO dá conselhos médicos, NÃO altera posologia sem confirmação
- **Resposta:** SEMPRE em JSON válido `{message, newState, context, action}`

### Estados da conversa
- `idle` — aguardando
- `onboarding` — primeiro acesso, coletando nome
- `adding_med` — cadastrando medicamento
- `confirming` — aguardando confirmação de dose

---

## Status Atual do Projeto

### ✅ Concluído
- Supabase criado com schema completo
- Z-API configurado, webhook apontando para ngrok
- WhatsApp conectado à instância nami-mvp
- Todos os arquivos do backend criados e configurados
- .env com todas as chaves (Supabase, Z-API, Anthropic)
- ngrok configurado e funcionando

### ⏳ Pendente
- Testar em rede adequada (erro atual é bloqueio de rede corporativa)
- Primeiro teste real: mandar "Oi" para a Nami no WhatsApp
- Validar fluxo completo de cadastro de medicamento
- Recrutar primeiros 10 usuários beta

### 🔜 Próximas fases
- Dashboard web para cuidadores
- Integração com farmácias para recompra
- Deploy permanente no Railway (substituir ngrok)
- B2B: planos de saúde, clínicas, farmácias

---

## Como rodar localmente

```bash
# Terminal 1 — ngrok
ngrok http 3000

# Terminal 2 — backend
node src/index.js
```

⚠️ Após iniciar o ngrok, atualizar a URL do webhook no painel Z-API
(a URL muda a cada reinício do ngrok)

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
