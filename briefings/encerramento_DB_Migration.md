# Briefing de Encerramento — Sessão DB Migration (29/06/2026)

## Instruções para o Claude Code

Você receberá este arquivo ao final de cada sessão de desenvolvimento da Nami.
Sua única tarefa é executar os passos abaixo na ordem indicada, sem fazer perguntas.

---

## PASSO 1 — Sobrescrever o CONTEXT.md

Substitua **todo o conteúdo** do arquivo `CONTEXT.md` na raiz do projeto pelo conteúdo
abaixo. Não preserve nada do arquivo anterior.

```
# 🌿 NAMI — Contexto do Projeto (v10 + DB Migration — 29/06/2026)

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

## Persona central: Mariana

38 anos, professora, dois filhos, gerencia dois tratamentos contínuos em horários diferentes. O problema dela não é falta de vontade — é esquecimento causado pela rotina corrida. Toda decisão de produto deve passar pelo filtro: "isso resolve o problema da Mariana?"

**Insight de pesquisa importante:** o público idoso pode ser suficientemente auto-motivado. O público mais promissor são adultos em tratamento contínuo com rotina ocupada e cuidadores de familiares.

---

## Filosofia de produto — não negociável

**A Nami nunca ignora o que o usuário disse.**
Quando um usuário chega com uma mensagem rica ("preciso tomar nimesulida de 12 em 12 horas"), a Nami deve reagir a isso — não iniciar um script genérico como se a mensagem não existisse. Cada mensagem tem conteúdo próprio que merece resposta.

**O fluxo serve o usuário, não o contrário.**
O onboarding tem etapas necessárias (nome, LGPD), mas essas etapas devem ser apresentadas de forma que façam sentido para o objetivo do usuário. Se ele chegou querendo cadastrar um remédio, as etapas anteriores devem ser justificadas nesse contexto. **Corolário (reforçado na v9):** o usuário nunca deve ficar preso em um fluxo. Todo fluxo precisa de saída de emergência (ver regra anti-loop no cadastro).

**Cálculo de dado de saúde não depende do LLM (princípio reforçado na v9).**
Aritmética que afeta segurança do tratamento — como cálculo de horários de dose — deve ser feita em código determinístico, não por inferência do modelo. O LLM faz o que faz bem (entender linguagem natural); o código faz o que faz bem (aritmética exata).

**Diferença entre Nami e bot genérico:**
Frases como "Que ótimo! Estou aqui exatamente para isso..." mostram conexão com o que o usuário pediu. Não é seguir etapas de forma seca e fria.

---

## Stack Tecnológica

| Componente | Ferramenta |
|---|---|
| Canal | WhatsApp Business API via **Z-API** |
| Backend | **Node.js** + Express |
| IA | **Claude API** (claude-sonnet-4-6) |
| Banco de dados | **Supabase** (PostgreSQL) — **projeto Brasil (São Paulo)** |
| Scheduler | **node-cron** (lembretes automáticos) |
| Hospedagem | **Railway** (produção ativa) |
| Versionamento | **GitHub** — Gui-eng26/Nami_life (público) |

**URL de produção:** `https://namilife-production.up.railway.app`
**Webhook Z-API:** `POST /webhook/whatsapp`

⚠️ **Banco migrado em 29/06/2026:** Oregon (US) → Brasil (São Paulo) por LGPD e latência.
O Supabase não permite alterar região após criação — foi criado novo projeto e migrado manualmente.

---

## Estrutura de Arquivos

```
nami-backend/
├── src/
│   ├── index.js              → Entry point + webhook + proteção idempotência
│   ├── agent.js              → Orquestrador — chama routeMessage
│   ├── router.js             → Roteador central de agentes (com classificador LLM no else)
│   ├── database.js           → Todas as queries no Supabase
│   ├── whatsapp.js           → Envio de mensagens e parse Z-API
│   ├── scheduler.js          → Cron: lembretes + follow-ups + resumo semanal
│   ├── prompts.js            → System prompt do agente_principal
│   └── agentes/
│       ├── recepcionista.js  → Onboarding de novos usuários (v3)
│       ├── principal.js      → Conversa geral + confirmação de doses (actions array)
│       ├── cadastro.js       → Fluxo dedicado de cadastro (cálculo determinístico de horários)
│       ├── lembrete.js       → Follow-up espaçado (30min/1h/30min)
│       ├── relatorios.js     → Consultas de histórico (híbrido: query + Claude)
│       └── configuracao.js   → Pausar/reativar/encerrar/alterar horário
├── briefings/                → Briefings de implementação (na raiz da pasta, sem subpastas)
├── supabase/
│   └── migrations/
│       └── 20260629000000_baseline.sql  → Schema completo v10 + colunas v11 (ponto zero)
├── CONTEXT.md                → Este arquivo — ponto de partida de toda sessão
└── package.json
```

---

## Variáveis de Ambiente (.env)

```env
SUPABASE_URL=https://[PROJECT_ID].supabase.co   # SEM /rest/v1/ no final!
SUPABASE_SERVICE_KEY=sb_secret_...               # secret key — bypassa RLS
ANTHROPIC_API_KEY=sk-ant-api03-...
ZAPI_INSTANCE_ID=[ID da instância]
ZAPI_TOKEN=[Token de integração]
ZAPI_CLIENT_TOKEN=[Client-Token da aba Segurança na Z-API]
PORT=3000
```

⚠️ `ZAPI_CLIENT_TOKEN` está em **Segurança** no painel Z-API — diferente do `ZAPI_TOKEN`.
⚠️ `SUPABASE_URL` deve ser apenas a URL base — sem sufixos.

---

## Banco de Dados — Supabase (PostgreSQL)

### Schema versionado no repositório

A partir de 29/06/2026, o schema do banco está formalizado em `supabase/migrations/`.
O arquivo `20260629000000_baseline.sql` representa o estado completo do banco (ponto zero).
Toda alteração futura no banco deve ser feita via novo arquivo de migration numerado.
O Claude pode ler o schema diretamente do GitHub em qualquer sessão.

### Tabelas

**users**
```sql
id, phone (unique, formato +55...), name, onboarded, lgpd_accepted, lgpd_accepted_at,
created_at, updated_at
```

**medications**
```sql
id, user_id (FK), nome, dosagem, instrucoes, estoque_atual,
estoque_minimo (default 7 — não mais usado para alerta),
forma_farmaceutica, tipo_tratamento, tratamento_dias,
tratamento_fim, ativo, created_at
```

**schedules**
```sql
id, medication_id (FK), horario (time HH:MM), dias_semana (text[]), ativo, created_at
```

**dose_logs**
```sql
id, medication_id (FK), scheduled_at, reminder_sent, reminder_sent_at,
taken_at, confirmed, response_raw,
status (pendente/confirmado/nao_informado/nao_tomado/sem_estoque),
tentativas, ultima_tentativa_at, caregiver_notified, caregiver_notified_at,
zapi_message_id (text) ← formato zaapId (019E...), NÃO bate com referenceMessageId
-- v11 (em andamento): trilha auditável de reversão de confirmação
revertido (boolean), revertido_at, revertido_de (text), revertido_motivo (text)
```

**conversation_state**
```sql
id, user_id (FK unique), state (text), context (jsonb), updated_at
```
⚠️ Papel: estado OPERACIONAL — lido e escrito a cada mensagem. Determina em que etapa
do fluxo o usuário está. Sem ela a Nami não funciona.
⚠️ Diferente de agent_logs.estado_conversa (diagnóstico histórico — nunca lido pelo fluxo).

**agent_logs** (LOGS-001 — v9)
```sql
id, user_id (FK), agent, user_message, agent_response, created_at,
estado_conversa (text), contexto_conversa (jsonb)
```
Papel: fotografia DIAGNÓSTICA — cópia imutável do estado no momento de cada interação.
Nunca lida pelo fluxo operacional. Essencial para investigar bugs pós-fato.
O fast-path registra null nesses campos.

**intencoes_nao_suportadas** (v10)
```sql
id, user_id (FK), mensagem (text), created_at, revisado (boolean default false)
```

**care_network** — rede de cuidado (estrutura preparada, ainda sem interface)
```sql
id, user_id, caregiver_id, relationship, permissions (jsonb), status
```

**message_logs** — NÃO EXISTE no banco Brasil. Estava vazia e sem uso no código Oregon.
Decisão consciente de não migrar. Será criada via migration se necessário no futuro.

### ⚠️ Padrão crítico no Supabase JS SDK
Filtros via join NÃO funcionam: `.eq('medications.user_id', userId)` retorna todos os registros.
Sempre usar abordagem em duas etapas:
```javascript
const meds = await getUserMedications(userId);
const ids = meds.map(m => m.id);
.in('medication_id', ids)
```

### Stored Functions
- `get_pending_reminders()` — usada pelo scheduler a cada minuto
- `get_dose_history(p_user_id, p_days)` — usada pelo agente_relatorios
Ambas documentadas com SQL completo em `supabase/migrations/20260629000000_baseline.sql`.
Atualizada em 15/06/2026 (BUG-031): comparações usam `AT TIME ZONE 'America/Sao_Paulo'`.

---

## Anatomia da Arquitetura — Classificação por Tipo

| Componente | Arquivo | Natureza | Como funciona |
|---|---|---|---|
| index.js | src/index.js | **Determinístico** | Webhook, idempotência, parse de payload, filtro de mídia. Zero LLM. |
| agent.js | src/agent.js | **Determinístico** | Orquestrador: busca usuário, trata áudio com resposta fixa, chama router. |
| router.js | src/router.js | **Híbrido (v9)** | Decisões via if/else, regex e listas hardcoded. LLM no agente_configuracao E no classificador do else final (novo na v9). |
| recepcionista.js | src/agentes/ | **Híbrido** | LGPD e nome validados deterministicamente; respostas geradas via LLM. |
| principal.js | src/agentes/ | **LLM puro** | Claude decide resposta, actions (array) e newState via JSON estruturado. |
| cadastro.js | src/agentes/ | **Híbrido (v9)** | Fluxo de 8 etapas; LLM interpreta respostas; cálculo de horários é determinístico (código). |
| relatorios.js | src/agentes/ | **Híbrido** | Classificador e queries determinísticos; LLM para linguagem empática. |
| configuracao.js | src/agentes/ | **Híbrido** | Detecção no router determinística; LLM classifica intenção precisa. |
| lembrete.js | src/agentes/ | **Determinístico** | Template fixo, sem LLM. Mesma mensagem para todos os lembretes. |
| scheduler.js | src/ | **Determinístico** | node-cron + query banco + disparo via whatsapp.js. |

---

## Arquitetura Multi-Agente

### Fluxo do Roteador (ordem de verificação)

```
mensagem chega → index.js (proteção idempotência por messageId)
      ↓
getOrCreateUser(phone)
      ↓
user.onboarded === false? → agente_recepcionista
      ↓
referenceMessageId + detectarConfirmacaoDose? → FAST-PATH (ver BUG-029 — limitação conhecida)
      ↓
state === 'post_onboarding'? → cadastro (se afirmativo/cadastro) ou principal (exchanges counter)
      ↓
state === 'configurando'? → agente_configuracao
      ↓
state === 'idle' + detectarIntencaoConfiguracao? → agente_configuracao
      ↓
state === 'adding_med' ou 'cadastrando_medicamento'? → agente_cadastro
      ↓
state === 'idle' + detectarIntencaoCadastro? → agente_cadastro
      ↓
detectarConfirmacaoDose AND temDosePendente? → agente_principal
      ↓
classificarIntencaoRelatorio? → agente_relatorios (se retornar null → principal)
      ↓
[else] → CLASSIFICADOR LLM (classificarIntencaoComContexto) → roteia para o agente correto
```

### Agentes implementados

| Agente | Arquivo | Status |
|---|---|---|
| agente_roteador | src/router.js | ✅ Ativo (híbrido com classificador LLM) |
| agente_recepcionista | src/agentes/recepcionista.js | ✅ v3 |
| agente_principal | src/agentes/principal.js | ✅ Ativo (actions array) |
| agente_cadastro | src/agentes/cadastro.js | ✅ Ativo (cálculo determinístico) |
| agente_lembrete | src/agentes/lembrete.js | ✅ Ativo |
| agente_relatorios | src/agentes/relatorios.js | ✅ Ativo |
| agente_configuracao | src/agentes/configuracao.js | ✅ Ativo |
| agente_medicacoes (RAG) | — | 🔜 Fase 3 |

---

## Confirmação de Dose — Regras Críticas

### 🔑 SOLUÇÃO HÍBRIDA DE CONFIRMAÇÃO (v10 — 28/06/2026)

**Causa raiz:** `getHistoricoRecente` lê de `agent_logs`, que NÃO contém os lembretes do scheduler. O `principal` recebia "Sim" sem a pergunta "Já tomou?" no contexto — ficava órfão e era lido como social.

**Solução (dois deploys, validados em produção — 16/16 confirmações, 0% falha):**
- **Deploy A:** bloco estruturado "DOSES AGUARDANDO CONFIRMAÇÃO" em `buildUserMessage` + migração CONFIRM_DOSE de `medicationId` para `doseLogId` (`confirmDoseByLogId`).
- **Deploy B:** `historicoConversa` reintroduzido com precedência explícita do bloco de doses pendentes.

---

## Agente Lembrete — Follow-up Espaçado

```
Tentativa 1: horário agendado
Tentativa 2: +30 minutos (tom gentil)
Tentativa 3: +1 hora (último aviso)
Após tent. 3: +30min → nao_informado + notifica cuidadores ativos
```

---

## Agente Relatórios — Modelo Híbrido

| Consulta | Tipo |
|---|---|
| Tomei hoje? | Query direta |
| Meus remédios | Query direta |
| Estoque | Query direta |
| Próximo remédio | Query direta |
| Adesão | Claude empático |
| Resumo semanal | Claude proativo (segunda 08h) |

---

## Fragilidades Arquiteturais Conhecidas

| # | Fragilidade | Urgência |
|---|---|---|
| 1 | Roteador determinístico — listas hardcoded | **Mitigada na v9** — classificador LLM no else cobre o caso mais crítico |
| 2 | Estado conversacional sem contrato formal — JSONB livre entre agentes | Média |
| 3 | Idempotência em memória — Set sem durabilidade cross-instance | Baixa |
| 4 | Scheduler e webhook sem coordenação de sessão | Baixa |
| 5 | Prompts sem teste automatizado | Média |

---

## Padrões de Bugs Recorrentes

### Filtro via join no Supabase JS SDK
`.eq('tabela_relacionada.campo', valor)` não funciona. Usar abordagem em duas etapas com `.in()`.

### Timezone UTC/BRT
Stored procedures e comparações de data devem usar `AT TIME ZONE 'America/Sao_Paulo'`.

### Idempotência no webhook Z-API
Z-API pode entregar o mesmo evento duas vezes. Proteção via `processedMessages` Set no index.js com TTL de 30s.

### detectarConfirmacaoDose deve filtrar negações
Verificar negações ANTES dos termos positivos.

### Word-boundary em detectarIntencaoConfiguracao
Usar `contemPalavraLivre()` em vez de `.includes()`. "voltar" é substring de "Voltaren".

### Cálculo de dado de saúde no código, não no LLM (v9)
Aritmética de horário deve ser determinística no código.

### Persistência de contexto entre etapas (v9)
Campos coletados no contexto JSONB devem ser sempre propagados no novoContext.

### Briefings na pasta /briefings
Todos os briefings ficam em `briefings/` (na raiz da pasta, sem subpastas).

---

## Status dos Bugs (atualizado 29/06/2026)

**Limitação conhecida aceitável:**
- **BUG-029** — fast-path "responder": zaapId (019E...) ≠ referenceMessageId (3EB0...). Fallback do Claude via texto funciona.

**Bugs ainda abertos:**
- **BUG-027** — nome de medicamento pré-cadastro perdido no `cad_nome`
- **BUG-028** — "ta bom" interpretado como pergunta em contexto idle
- **BUG-030** — `pareceNome()` não filtra respostas como "Sim, quero continuar"

---

## Backlog Priorizado (atualizado 29/06/2026)

### Topo — início da v11
1. **CICLO DE VIDA DA DOSE** *(highest priority — clinical data integrity)*:
   - *Caso 1 — Confirmation reversal + stock desync:* Confirmed two medications together → stock of one zeroed and triggered alert; user corrected → dose reversed, stock recredited. Design questions unresolved. Colunas de reversão já criadas no banco (revertido, revertido_at, revertido_de, revertido_motivo em dose_logs).
   - *Caso 2 — Retroactive confirmation registers wrong dose:* "Tomei o ômega 3 DE ONTEM" appears to have confirmed today's dose, not yesterday's.
   - *Caso 3 — Expired dose (nao_informado) not retroactively confirmable:* After 3 failed follow-ups, dose transitions to terminal nao_informado. Recurrent and common.

2. **Trabalho 2** — verificar medicamento existente no INÍCIO do cadastro.
3. **MH-032** — lembretes agrupados por janela de horário.
4. **Relatório de adesão** — dois tipos distintos gerando experiência inconsistente.
5. **Dead-end em configuracao** — pedido genérico sem tipo específico.
6. **MH-029** — alerta de estoque incorreto para tratamentos agudos com estoque suficiente.
7. **Mensagens fragmentadas** — debounce/agrupamento temporal.
8. **MH-030** — encerramento automático de tratamento agudo.
9. **MH-027** — reagendamento sob demanda.
10. **MH-037** — cálculo de adesão via COUNT dose_logs.
11. BUG-027, BUG-028, BUG-030.

### Fase 3+ (deferred)
- MH-004 Whisper, MH-007 RAG ANVISA, avaliação de unificação router+principal.

---

## Princípios de Engenharia (formalizados v10)

1. **Sistêmico vs. remendo** — resolver a classe inteira do problema, não só o caso que apareceu.
2. **Baixo acoplamento, alta coesão** — arquitetura deve permitir manutenção e expansão futura.
3. **Legibilidade** — outro desenvolvedor deve entender e conseguir manter o código.
4. **Cálculos de saúde determinísticos** — aritmética de horários, status de dose, contagem de estoque sempre em código.
5. **Inventário do roteador sempre atual** — `classificarIntencaoComContexto` (router.js) DEVE ser atualizado na mesma alteração que adicionar/remover capacidade.
6. **Propagação de histórico sistêmica** — buscar histórico uma vez no roteador e propagar uniformemente a todos os agentes LLM; lembrete fica fora (determinístico puro).
7. **Schema de banco como código** — toda alteração no banco via migration em `supabase/migrations/`. Nunca alterar o banco diretamente sem registrar a migration.

---

## Modo de Trabalho — Ritmo Estabelecido

### Fluxo padrão de implementação
```
1. Identificar problema ou melhoria
2. Analisar causa raiz com evidências (logs, código, dados) — nunca hipóteses não identificadas
3. Gerar briefing em briefings/BRIEFING_[TEMA].md
4. Guilherme salva o briefing na pasta briefings/ do projeto
5. Guilherme abre Claude Code: "Leia o briefings/BRIEFING_[TEMA].md e implemente..."
6. git add . && git commit -m "descrição" && git push
7. Railway redeploy automático
8. Verificar logs e testar no WhatsApp
```

### Ritual de início de sessão
1. Ler CONTEXT.md via `curl -s "https://raw.githubusercontent.com/Gui-eng26/Nami_life/main/CONTEXT.md"`
2. Verificar relatório mais recente no Google Drive (pasta Desenvolvimento Nami, ID: 17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN)
3. Confirmar estado atual com Guilherme antes de começar
4. **Schema do banco:** ler `supabase/migrations/` no repositório — não depender de exports manuais.

### Ritual de encerramento de sessão
1. Atualizar memory
2. Gerar relatório `.docx` e apresentar para download (upload manual no Drive)
3. Gerar briefings/encerramento_[nome].md com o CONTEXT.md atualizado para Claude Code commitar

### Filosofia de debugging — inegociável
- **Nunca propor solução sem causa raiz confirmada.** Hipóteses devem ser identificadas como hipóteses.
- **Analisar no contexto completo da Nami** — não o bug como fato isolado.
- **Evidências primeiro:** logs do Railway, código atual, dados do Supabase.
- **Correções cirúrgicas** — mexer apenas no que precisa.

---

## Como Rodar Localmente

```bash
npm install
node src/index.js
```

---

## Dependências

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

---

## Ferramentas e Recursos

- **GitHub:** `Gui-eng26/Nami_life` (público) — raw content via `curl -s "https://raw.githubusercontent.com/Gui-eng26/Nami_life/main/[filepath]"`.
- **Schema do banco:** `supabase/migrations/20260629000000_baseline.sql` no repositório.
- **Google Drive:** pasta Desenvolvimento Nami, ID `17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN`. Último relatório: `Nami_Relatorio_DB_Migration.docx`.
- **Supabase:** banco Brasil (São Paulo) — `agent_logs` é o histórico conversacional real. `conversation_state` é o estado operacional (sem 's').
- **Railway:** produção com auto-deploy no git push.
- **Claude Code (VS Code):** implementação via briefings `.md`.
```

---

## PASSO 2 — Commit e push

```bash
git add CONTEXT.md
git commit -m "docs: CONTEXT.md atualizado — sessão DB Migration (29/06/2026)"
git push
```

---

## PASSO 3 — Confirmar

Após o push, responda com:
- O hash do commit gerado
- Confirmação de que o CONTEXT.md foi atualizado com sucesso

Não faça mais nada além do que está descrito acima.