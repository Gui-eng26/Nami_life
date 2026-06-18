# 🌿 NAMI — Contexto do Projeto (v7 — 18/06/2026)

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
O onboarding tem etapas necessárias (nome, LGPD), mas essas etapas devem ser apresentadas de forma que façam sentido para o objetivo do usuário. Se ele chegou querendo cadastrar um remédio, as etapas anteriores devem ser justificadas nesse contexto.

**Diferença entre Nami e bot genérico:**
Frases como "Que ótimo! Estou aqui exatamente para isso..." e "Antes de cadastrar seu medicamento..." mostram conexão com o que o usuário pediu. Não é seguir etapas de forma seca e fria.

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
| Versionamento | **GitHub** — Gui-eng26/Nami_life (público) |

**URL de produção:** `https://namilife-production.up.railway.app`
**Webhook Z-API:** `POST /webhook/whatsapp`

---

## Estrutura de Arquivos

```
nami-backend/
├── src/
│   ├── index.js              → Entry point + webhook + proteção idempotência
│   ├── agent.js              → Orquestrador — chama routeMessage
│   ├── router.js             → Roteador central de agentes
│   ├── database.js           → Todas as queries no Supabase
│   ├── whatsapp.js           → Envio de mensagens e parse Z-API
│   ├── scheduler.js          → Cron: lembretes + follow-ups + resumo semanal
│   ├── prompts.js            → System prompt do agente_principal
│   └── agentes/
│       ├── recepcionista.js  → Onboarding de novos usuários (v3)
│       ├── principal.js      → Conversa geral + confirmação de doses
│       ├── cadastro.js       → Fluxo dedicado de cadastro de medicamentos
│       ├── lembrete.js       → Follow-up espaçado (30min/1h/30min)
│       ├── relatorios.js     → Consultas de histórico (híbrido: query + Claude)
│       └── configuracao.js   → Pausar/reativar/encerrar/alterar horário ← NOVO
├── briefings/                → Briefings de implementação por tema ← NOVO
│   ├── bugs/
│   └── features/
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

### Tabelas

**users**
```sql
id, phone (unique), name, onboarded, lgpd_accepted, lgpd_accepted_at,
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
id, medication_id (FK), horario (time HH:MM), dias_semana (text[]), ativo
```

**dose_logs**
```sql
id, medication_id (FK), scheduled_at, reminder_sent, reminder_sent_at,
taken_at, confirmed, response_raw,
status (pendente/confirmado/nao_informado/nao_tomado/sem_estoque),
tentativas, ultima_tentativa_at, caregiver_notified, caregiver_notified_at,
zapi_message_id (text) ← para fast-path de confirmação via referenceMessageId
```

**conversation_state**
```sql
id, user_id (FK unique), state (text), context (jsonb), updated_at
```

**message_logs, agent_logs** — histórico de mensagens e interações por agente

**care_network** — rede de cuidado (estrutura preparada, ainda sem interface)
```sql
id, user_id, caregiver_id, relationship, permissions (jsonb), status
```

### ⚠️ Padrão crítico no Supabase JS SDK
Filtros via join NÃO funcionam: `.eq('medications.user_id', userId)` retorna todos os registros.
Sempre usar abordagem em duas etapas:
```javascript
const meds = await getUserMedications(userId);
const ids = meds.map(m => m.id);
.in('medication_id', ids)
```

### Stored Procedure: get_pending_reminders
Atualizada em 15/06/2026 (BUG-031): todas as comparações de data e dia da semana
usam `AT TIME ZONE 'America/Sao_Paulo'` para evitar duplicação de lembretes noturnos
que cruzam meia-noite UTC.

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
referenceMessageId + detectarConfirmacaoDose? → FAST-PATH (confirmação direta sem LLM)
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
agente_principal
```

### Agentes implementados

| Agente | Arquivo | Status |
|---|---|---|
| agente_roteador | src/router.js | ✅ Ativo |
| agente_recepcionista | src/agentes/recepcionista.js | ✅ v3 |
| agente_principal | src/agentes/principal.js | ✅ Ativo |
| agente_cadastro | src/agentes/cadastro.js | ✅ Ativo |
| agente_lembrete | src/agentes/lembrete.js | ✅ Ativo |
| agente_relatorios | src/agentes/relatorios.js | ✅ Ativo |
| agente_configuracao | src/agentes/configuracao.js | ✅ Ativo (novo em 17/06) |
| agente_medicacoes (RAG) | — | 🔜 Fase 3 |

---

## Recepcionista v3 — Fluxo Detalhado

### 3 categorias de intenção (primeira mensagem)
- **CADASTRAR** — usuário mencionou remédio, posologia, tratamento → `state: adding_med`
- **DESCOBRIR** — quer entender o que a Nami faz → `state: post_onboarding`
- **NEUTRO** — saudação simples → `state: post_onboarding`

### Etapas
```
recep_boas_vindas    → apresentação + pede nome
recep_coleta_nome    → salva nome, apresenta LGPD
recep_lgpd           → aceite ou recusa
lgpd_recusado        → explica motivo + deixa porta aberta
```

### Estado post_onboarding (BUG-034)
Após LGPD aceito para intenção NEUTRO/DESCOBRIR, estado vai para `post_onboarding`.
O router mantém esse estado por até **1 troca** após roteamento para o principal
(contador `exchanges` no contexto). Isso garante que "Sim" como segunda resposta
ainda seja capturado como intenção de cadastro.

---

## Agente Configuracao — Fluxo

Arquitetura híbrida: detecção ampla no router (combinatória com word-boundary via
`contemPalavraLivre()`) + 1 chamada Claude para classificação precisa de intenção.

**Ações suportadas:** pausar lembretes, reativar, encerrar tratamento, alterar horário.

**State machine (6 etapas):**
```
identif_intencao → identif_acao (se ambíguo) → identif_medicamento →
identif_schedule → obter_horario → confirm_acao → executa + idle
```

Toda alteração no banco requer confirmação explícita do usuário.

---

## Agente Cadastro — Fluxo de 8 Etapas

```
cad_nome → cad_forma → cad_dosagem → cad_tipo_tratamento →
cad_horarios → cad_estoque → cad_confirmacao → cad_salvo
```

**Validação de estoque no cadastro (atualizado 18/06):**
Na etapa `cad_estoque`, calcula `diasRestantes = floor(estoque / horarios.length)`.
- Tratamento **agudo** (com `tratamento_dias`): alerta apenas se `diasRestantes < tratamento_dias`
- Tratamento **contínuo**: alerta quando `diasRestantes <= 5`

Mensagem de alerta para agudo menciona insuficiência para o tratamento (sem "recompra").

---

## Lógica de Alertas de Estoque (MH-026 — atualizado 15/06)

**Regra fundamental:** alertas de estoque NUNCA chegam junto com o lembrete.
O lembrete é enviado → usuário confirma → alerta embutido na resposta de confirmação.

| diasRestantes (pós-confirmação) | Comportamento |
|---|---|
| > 5 | Sem alerta |
| 1–5 | Alerta na 1ª confirmação do dia |
| 0 | Alerta em toda confirmação |

**Estoque zerado:** lembrete não é enviado. Uma mensagem alternativa é disparada
informando que o estoque está zerado e pedindo para informar a nova quantidade.
Um `dose_log` com `status: 'sem_estoque'` é criado para ativar a deduplicação
do scheduler (evita múltiplos envios).

---

## Confirmação de Dose — Regras Críticas

**detectarConfirmacaoDose:** filtra negações ANTES de verificar termos positivos.
"Não tomei" nunca será detectado como confirmação (BUG-036).

**REGISTER_NAO_TOMADO:** quando usuário diz explicitamente que não vai tomar
e pede para registrar ("pode registrar"), Claude usa esta action em vez de
CONFIRM_DOSE. O dose_log é marcado como `nao_tomado` e sai automaticamente
dos follow-ups (getPendingFollowUps filtra por status = 'pendente').

**Fast-path (BUG-029 — parcialmente implementado):** quando `referenceMessageId`
existe e aponta para um `dose_logs.zapi_message_id`, a dose é confirmada diretamente
sem chamar o LLM. Porém o Z-API retorna IDs no formato `019EC...` enquanto o
`referenceMessageId` usa formato WhatsApp nativo (`3EB...`). Fast-path está
implementado mas inativo até identificar o campo correto no response da Z-API.

---

## Contexto Injetado no agente_principal (buildUserMessage)

Para cada medicamento, o contexto inclui:
- `nome`, `dosagem`, `estoque_atual`, `horários`
- `tipo_tratamento` (contínuo/agudo)
- Se `tratamento_dias` preenchido: `duração total`, `doses totais do tratamento`,
  `dias decorridos desde o início`, `dias restantes`, `doses restantes estimadas`

Isso permite respostas corretas para perguntas como "quantas doses ainda faltam?"
sem o Claude precisar calcular.

---

## Agente Lembrete — Follow-up Espaçado

```
Tentativa 1: horário agendado
Tentativa 2: +30 minutos (tom gentil)
Tentativa 3: +1 hora (último aviso)
Após tent. 3: +30min → nao_informado + notifica cuidadores ativos
```

Após `nao_informado`, verifica alerta de estoque e envia se necessário.

---

## Agente Relatórios — Modelo Híbrido

| Consulta | Tipo | Ativadores |
|---|---|---|
| Tomei hoje? | Query direta | "tomei hoje?", "já tomei meus remédios"... |
| Meus remédios | Query direta | "quais meus remédios", "que remédios tenho"... |
| Estoque | Query direta | "quanto tenho de cada", "tô ficando sem remédio"... |
| Próximo remédio | Query direta | "o que tenho que tomar", "qual o próximo remédio"... |
| Adesão | Claude empático | "quantas vezes esqueci", "minha adesão tá boa"... |
| Resumo semanal | Claude proativo | Automático toda segunda às 08h |

---

## Padrões de Bugs Recorrentes

### Filtro via join no Supabase JS SDK
`.eq('tabela_relacionada.campo', valor)` não funciona.
Sempre usar abordagem em duas etapas com `.in()`.

### Timezone UTC/BRT
Stored procedures e comparações de data devem usar `AT TIME ZONE 'America/Sao_Paulo'`.
Lembretes noturnos (21h–23h BRT) cruzam meia-noite UTC — causa duplicação sem correção.

### Idempotência no webhook Z-API
Z-API pode entregar o mesmo evento duas vezes. Proteção implementada via
`processedMessages` Set no index.js com TTL de 30 segundos.

### detectarConfirmacaoDose deve filtrar negações
Verificar lista de negações ANTES dos termos positivos. "Não tomei" contém "tomei"
mas não é confirmação. Prioridade à negação — false negative é recuperável via
follow-up; false positive corrompe dados de adesão.

### Word-boundary em detectarIntencaoConfiguracao
Usar `contemPalavraLivre()` em vez de `.includes()`. "voltar" é substring de "Voltaren"
e causava false positives sem word-boundary.

### Briefings na pasta /briefings
Todos os briefings de implementação ficam em `briefings/` (não na raiz).
Comando para Claude Code: `Leia o briefings/NOME.md e implemente...`

---

## Status dos Bugs (atualizado 18/06/2026)

Total de 37 bugs identificados e corrigidos (BUG-001 a BUG-037).

**Bugs ainda abertos:**
- **FIX-004** — agente_principal sem memória entre turnos: quando principal pergunta
  "qual medicamento?" e usuário responde com o nome, principal não lembra da pergunta
  e responde "não encontrei esse medicamento". Precisa de estado `awaiting_medicamento`.
- **BUG-029** — fast-path Wellington: Z-API send retorna formato `019EC...` mas
  `referenceMessageId` usa formato WhatsApp nativo `3EB...`. Confirmação via Claude
  ainda funciona; fast-path implementado mas inativo.
- **BUG-027** — nome de medicamento pré-cadastro perdido no `cad_nome`
- **BUG-028** — "ta bom" interpretado como pergunta em contexto idle
- **BUG-030** — `pareceNome()` não filtra respostas como "Sim, quero continuar"

---

## Backlog Priorizado

### Alta prioridade
- **FIX-004** — awaiting_medicamento state (principal sem memória entre turnos)
- **MH-029** — alerta de estoque semântico correto para agudo (FIX-002 abordou parcialmente)
- **MH-030** — encerramento automático de tratamento agudo (último dia + relatório final)

### Média prioridade
- **MH-024** — confirmação retroativa de dose ("tomei mas esqueci de registrar")
- **MH-027** — reagendamento sob demanda ("me lembre em 5 minutos")
- **MH-031** — histórico de tratamentos encerrados via conversa
- **MH-003** — timestamp real de confirmação vs. horário agendado
- **BUG-029** — identificar campo Z-API com ID nativo (logar response.data)

### Fase 3+
- **MH-004** — transcrição de áudio via Whisper
- **MH-007** — RAG no bulário ANVISA (agente_medicacoes)
- **MH-008** — leitura de receitas por imagem
- **MH-021** — variação natural do nome nos prompts
- Rede de cuidado — interface para adicionar cuidadores

---

## Modo de Trabalho — Ritmo Estabelecido

### Fluxo padrão de implementação
```
1. Identificar problema ou melhoria
2. Analisar causa raiz com evidências (logs, código) — nunca hipóteses não identificadas
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

### Ritual de encerramento de sessão
1. Gerar `Nami_Relatorio_vN+1.docx` e fazer upload no Google Drive
2. Gerar CONTEXT.md atualizado para Guilherme commitar no GitHub
3. Atualizar itens 1 e 2 do memory

### Filosofia de debugging — inegociável
- **Nunca propor solução sem causa raiz confirmada.** Hipóteses devem ser identificadas como hipóteses.
- **Analisar no contexto completo da Nami** — não o bug como fato isolado.
- **Evidências primeiro:** logs do Railway, código atual, dados do Supabase — nessa ordem.
- **Correções cirúrgicas** — mexer apenas no que precisa.

---

## Como Rodar Localmente

```bash
npm install
node src/index.js
```

Para testes com webhook local:
```bash
ngrok http 3000
# Atualizar URL em Z-API > Webhooks
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