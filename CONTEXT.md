# 🌿 NAMI — Contexto do Projeto (v10 — 28/06/2026)

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
id, medication_id (FK), horario (time HH:MM), dias_semana (text[]), ativo
```

**dose_logs**
```sql
id, medication_id (FK), scheduled_at, reminder_sent, reminder_sent_at,
taken_at, confirmed, response_raw,
status (pendente/confirmado/nao_informado/nao_tomado/sem_estoque),
tentativas, ultima_tentativa_at, caregiver_notified, caregiver_notified_at,
zapi_message_id (text) ← formato zaapId (019E...), NÃO bate com referenceMessageId
```

**conversation_state**
```sql
id, user_id (FK unique), state (text), context (jsonb), updated_at
```

**agent_logs** (LOGS-001 — v9)
```sql
id, user_id (FK), agent, user_message, agent_response, created_at,
estado_conversa (text), contexto_conversa (jsonb)
```
As colunas estado_conversa e contexto_conversa capturam o estado e contexto da
conversa no momento exato de cada interação. Essenciais para diagnóstico de bugs
de fluxo — sem elas, o estado já teria sido sobrescrito quando o bug é investigado.
Foram decisivas para diagnosticar o BUG-041. O fast-path registra null nesses campos.

**intencoes_nao_suportadas** (v10 — não-suportado em 3 camadas)
```sql
id, user_id (FK), mensagem (text), created_at, revisado (boolean default false)
```
Registra pedidos que a Nami ainda não atende (ex: alterar dosagem, alterar tempo de
tratamento, registrar sintomas), para análise de demanda. O classificarIntencaoComContexto
do roteador tem categoria `nao_suportado`; o principal recebe flag `intencaoNaoSuportada`
e responde com honestidade; agentes especializados têm rede de segurança. Coluna `revisado`
para o dev marcar o que já avaliou.

**message_logs** — existe mas está VAZIA / não usada. O histórico real de conversas
vive em agent_logs. message_logs pode ser descontinuada ou reaproveitada no futuro.

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

### Classificador LLM no else final (v9)

O bloco `else` final — antes a maior fragilidade do roteador — passou a usar um
classificador LLM. A função `classificarIntencaoComContexto` (em router.js) recebe:
- A mensagem atual e o estado atual
- As últimas 3 interações da conversa (via `getHistoricoRecente` em database.js,
  lendo agent_logs em ordem cronológica)

E retorna qual agente deve processar: cadastro, relatorios, configuracao ou principal.
- `max_tokens: 10` — só precisa devolver uma palavra. Custo marginal por mensagem.
- **Fallback seguro:** qualquer erro (rede, timeout, resposta inesperada) cai no
  agente principal — preservando o comportamento anterior. O classificador não pode
  ser ponto de falha que interrompe o usuário.

Isso resolve a classe inteira de falhas de roteamento de mensagens contextuais
("sim", "pode", "quero") em estado idle — incluindo o caso que era o FIX-004.

### Estado `idle` — o que significa
`idle` é o estado neutro: o usuário não está no meio de nenhum fluxo ativo.
Antes da v9 era onde o roteador mais falhava. Com o classificador LLM, mensagens
ambíguas em idle agora são roteadas com contexto conversacional.

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

## FIX-004 — RESOLVIDO via classificador LLM (v9)

**Sintoma original:** usuário responde "sim" a uma pergunta da Nami sobre cadastro →
agente_principal era acionado novamente em vez do agente_cadastro.

**Como foi resolvido:** em vez do `awaiting_medicamento` state (solução pontual
inicialmente planejada), o problema foi resolvido de forma estrutural pelo classificador
LLM no else final do roteador. O classificador lê o histórico recente e entende que
"sim" após um convite de cadastro significa intenção de cadastro. Isso resolve não só
o FIX-004 mas toda a classe de problemas similares (relatório, configuração, etc.).
Validado parcialmente em produção (sim→cadastro funcionou nos testes).

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
(contador `exchanges` no contexto).

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

### Cálculo determinístico de horários (BUG-041 — v9)

O cálculo de horários a partir de frequência saiu do LLM e passou para código
determinístico. Abordagem híbrida:
- **Horários explícitos** ("de manhã e à noite", "às 8 e às 20") → salvos direto.
- **Frequência regular** ("de 8 em 8h", "3x ao dia") → o LLM extrai os parâmetros
  (intervalo_horas / doses_por_dia + horario_inicio) e a função
  `calcularHorariosPorIntervalo` calcula os horários derivados em JavaScript.
  Ex: início 19:00, intervalo 8h → ["19:00", "03:00", "11:00"].

**Novos campos persistentes no contexto:** `doses_por_dia`, `intervalo_horas`,
`horario_inicio`. A frequência virou dado de primeira classe — antes não existia no
contexto JSONB e se perdia entre etapas.

**Regra de persistência de contexto:** o prompt instrui o Claude a SEMPRE propagar
todos os campos já coletados no novoContext, nunca retornar campo preenchido como null.
Corrige a perda de estado entre etapas de forma transversal.

**Regra anti-loop:** se o usuário demonstra confusão repetida ou a mesma etapa se
repete sem progresso, a Nami oferece uma saída clara ("me diga em uma frase: nome,
quantas vezes por dia e horário de início"). Garante que o usuário nunca fique preso.

### Validação de estoque no cadastro (BUG-039 — v9)
Na etapa `cad_estoque`, o resumo de confirmação é exibido JUNTO com a mensagem de
estoque (4 dos 5 casos), eliminando o passo extra em que o usuário ficava sem resposta.
A etapa `cad_confirmacao` não repete o resumo — apenas processa confirmação/correção.
Cálculo: `dosesPerDia = context.doses_por_dia || horarios.length || 1`.
- Tratamento **agudo** (com `tratamento_dias`): alerta apenas se estoque não cobre o tratamento.
- Tratamento **contínuo**: alerta quando `diasRestantes <= 5`.

---

## Confirmação de Dose — Regras Críticas

### 🔑 SOLUÇÃO HÍBRIDA DE CONFIRMAÇÃO (v10 — 28/06/2026) — núcleo da sessão

**Contexto:** o Briefing de continuidade conversacional (v10) injetou `historicoConversa`
no contexto do `principal` e introduziu uma REGRESSÃO CRÍTICA: o "Sim" em resposta a um
lembrete parou de confirmar doses em estado idle (~64% de falha; 0% antes).

**Causa raiz (confirmada por isolamento + comparação de versões):** `getHistoricoRecente`
lê de `agent_logs`, que NÃO contém os lembretes do scheduler (disparados pelo cron, fora
do roteador). O `principal` recebia o "Sim" com um histórico SEM a pergunta "Já tomou?" —
o "Sim" ficava órfão e era lido como social. "Tomei" sempre funcionou (autossuficiente
semanticamente); "Sim" é puramente contextual.

**Solução (híbrida, faseada em 2 deploys, ambos validados em produção):**

**Deploy A — âncora estruturada + doseLogId:**
- `buildUserMessage` monta um bloco destacado `=== DOSES AGUARDANDO CONFIRMAÇÃO ===` com
  cada dose pendente listada por nome, horário e `[ref: dose_log.id]`, substituindo o
  dump cru de JSON. Filtra: reminder_sent=true, confirmed=false, e exclui nao_informado/
  pausado/nao_tomado/sem_estoque. Instrução inline: se confirmar → CONFIRM_DOSE; se falar
  de outra coisa (estoque, horário) → ajude normalmente, NÃO force, dose segue pendente.
- "Doses recentes" mantido como contexto histórico separado, sem destaque.
- CONFIRM_DOSE migrado de `medicationId` para `doseLogId` (campo primário), com fallback
  retrocompatível para `medicationId`. Usa `confirmDoseByLogId` (que agora retorna o
  `medication_id` para o alerta de estoque, sem query extra). Resolve o cenário de mesmo
  medicamento em horários diferentes — onde `confirmDose(medicationId)` confirmaria a dose
  errada (sempre a mais recente).

**Deploy B — reintrodução do histórico com precedência:**
- `historicoConversa` voltou ao `buildUserMessage` do `principal`, posicionado após
  "Doses recentes" e com instrução de PRECEDÊNCIA explícita: o bloco de doses pendentes
  tem prioridade; "sim"/"tomei" com dose pendente é SEMPRE confirmação, nunca fechamento
  social. O histórico serve só para resolver pronomes ("dele") e fechamentos ("ok") quando
  NÃO há dose pendente.

**Validação em produção (ambos deploys):** confirmação 16/16 (0% falha), múltiplos
usuários; cenário 2 (Voltaren 11:58+17:58 confirmados individualmente via doseLogId);
"comprei 20 cps" durante dose pendente → UPDATE_STOCK sem forçar confirmação;
"ok"/"obrigado"/"dele" restaurados.

**Por que NÃO um estado rígido `aguardando_confirmacao_dose`:** travaria o fluxo se o
usuário respondesse outra coisa ("comprei mais 20 cps") durante uma dose pendente. O bloco
estruturado informa sem aprisionar.


### Confirmação de múltiplas doses (BUG-040 — v9)
O contrato de ação do agente_principal passou de singular (`action`) para lista
(`actions` array). Quando o usuário confirma várias doses de uma vez ("tomei todos",
"tomei os dois"), o Claude emite um CONFIRM_DOSE para cada medicamento pendente, e o
handler processa todos. Compatibilidade retroativa: se vier `action` singular, é
embrulhado em lista. **Causa raiz havia sido confirmada por código + dados:** com o
contrato singular, doses de horários com colisão ficavam todas `nao_informado`
(observado no Wellington por 4 dias seguidos); doses isoladas confirmavam normal.

**detectarConfirmacaoDose:** filtra negações ANTES de verificar termos positivos.
"Não tomei" nunca será detectado como confirmação (BUG-036).

**REGISTER_NAO_TOMADO:** quando usuário diz explicitamente que não vai tomar
e pede para registrar, Claude usa esta action. O dose_log é marcado como `nao_tomado`
e sai dos follow-ups.

**Fast-path (BUG-029 — LIMITAÇÃO CONHECIDA ACEITÁVEL):** quando `referenceMessageId`
existe, tenta confirmar a dose diretamente buscando `dose_logs.zapi_message_id`.
Porém, com evidência definitiva (v9): o ID salvo no envio é o `zaapId` da Z-API
(formato `019E...`) e o `referenceMessageId` recebido quando o usuário usa "responder"
é o messageId nativo do WhatsApp (formato `3EB0...`) — namespaces diferentes, nunca
coincidem. A correção via webhook de status exigiria configuração externa e
introduziria condição de corrida. **Decisão:** limitação conhecida aceitável. O
fallback do Claude via temDosePendente captura a confirmação por texto normalmente.

**Nota v10:** a migração de CONFIRM_DOSE para `doseLogId` NÃO depende do fast-path nem do
`referenceMessageId`. O `doseLogId` vem do bloco estruturado de doses pendentes (montado a
partir do banco via getRecentDoses), não do reply do WhatsApp. O fast-path permanece como
limitação conhecida, intocado.

---

## Contexto Injetado no agente_principal (buildUserMessage)

Para cada medicamento, o contexto inclui:
- `nome`, `dosagem`, `estoque_atual`, `horários`
- `tipo_tratamento` (contínuo/agudo)
- Se `tratamento_dias` preenchido: `duração total`, `doses totais do tratamento`,
  `dias decorridos desde o início`, `dias restantes`, `doses restantes estimadas`

---

## Agente Lembrete — Follow-up Espaçado

```
Tentativa 1: horário agendado
Tentativa 2: +30 minutos (tom gentil)
Tentativa 3: +1 hora (último aviso)
Após tent. 3: +30min → nao_informado + notifica cuidadores ativos
```

⚠️ O agente_lembrete é **100% determinístico** — usa template fixo, sem LLM.
Todos os lembretes têm a mesma mensagem. **MH-032 (backlog):** agrupar lembretes
de medicamentos no mesmo horário (ou janela próxima) em uma única mensagem, com
confirmação em lote. Depende do BUG-040 validado.

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

## Fragilidades Arquiteturais Conhecidas (atualizado 19/06/2026 — v9)

| # | Fragilidade | Urgência |
|---|---|---|
| 1 | Roteador determinístico — listas hardcoded | **Mitigada na v9** — classificador LLM no else cobre o caso mais crítico |
| 2 | Estado conversacional sem contrato formal — JSONB livre entre agentes | Média — BUG-041 deu contrato aos campos de frequência; resto ainda livre |
| 3 | Idempotência em memória — Set sem durabilidade cross-instance ou redeploy | Baixa — aceitável no estágio atual |
| 4 | Scheduler e webhook sem coordenação de sessão — sem lock de sessão | Baixa — sem lock implementado |
| 5 | Prompts sem teste automatizado — regressão detectada só em produção | Média — cresce com número de agentes |

---

## Padrões de Bugs Recorrentes

### Filtro via join no Supabase JS SDK
`.eq('tabela_relacionada.campo', valor)` não funciona. Usar abordagem em duas etapas com `.in()`.

### Timezone UTC/BRT
Stored procedures e comparações de data devem usar `AT TIME ZONE 'America/Sao_Paulo'`.

### Idempotência no webhook Z-API
Z-API pode entregar o mesmo evento duas vezes. Proteção via `processedMessages` Set no index.js com TTL de 30s.

### detectarConfirmacaoDose deve filtrar negações
Verificar negações ANTES dos termos positivos. Prioridade à negação — false negative é recuperável; false positive corrompe adesão.

### Word-boundary em detectarIntencaoConfiguracao
Usar `contemPalavraLivre()` em vez de `.includes()`. "voltar" é substring de "Voltaren".

### Cálculo de dado de saúde no código, não no LLM (v9)
Aritmética de horário (e similares que afetam segurança do tratamento) deve ser
determinística no código. O LLM erra aritmética de forma consistente (BUG-041).

### Persistência de contexto entre etapas (v9)
Campos coletados no contexto JSONB devem ser sempre propagados no novoContext.
O LLM tende a retornar campos como null quando não os menciona, apagando dados.

### Briefings na pasta /briefings
Todos os briefings ficam em `briefings/` (na raiz da pasta, sem subpastas como bugs/).
Comando para Claude Code: `Leia o briefings/NOME.md e implemente...`

---

## Status dos Bugs (atualizado 19/06/2026 — v9)

Total de **42 bugs/melhorias identificados e resolvidos**.

**Implementados na v9 (PENDENTE VALIDAÇÃO com Wellington, exceto LOGS-001):**
- **LOGS-001** — colunas estado_conversa/contexto_conversa em agent_logs (VALIDADO)
- **Classificador LLM** no roteador — resolve FIX-004 e classe de roteamento contextual
- **BUG-038** — cad_horarios distingue horário específico de frequência
- **BUG-039** — resumo exibido junto com mensagem de estoque
- **BUG-040** (crítico) — confirmação de múltiplas doses (actions array)
- **BUG-041** (crítico) — cálculo determinístico de horários por frequência + anti-loop

**Limitação conhecida aceitável:**
- **BUG-029** — fast-path "responder": zaapId (019E...) ≠ referenceMessageId (3EB0...).
  Fallback do Claude via texto funciona. Sem ação imediata.

**Bugs ainda abertos:**
- **BUG-027** — nome de medicamento pré-cadastro perdido no `cad_nome`
- **BUG-028** — "ta bom" interpretado como pergunta em contexto idle
- **BUG-030** — `pareceNome()` não filtra respostas como "Sim, quero continuar"

---

## Backlog Priorizado (atualizado 19/06/2026 — v9)

### Topo — início da v10
- **VALIDAR implementações da v9** com novas interações do Wellington — especialmente
  BUG-040 (reexecutar SQL de dose_logs: doses de horário com colisão devem ficar
  'confirmado') e BUG-041 (cadastro com "8 em 8h" deve salvar os 3 horários calculados).
- **Trabalho 2** — verificação de medicamento no INÍCIO do cadastro (hoje a duplicata
  só é detectada no fim do fluxo; deve verificar se existe ativo/pausado/encerrado antes).

### Alta prioridade
- **MH-032** (novo) — lembretes agrupados por janela de horário (depende de BUG-040
  validado; usar janela de tolerância, não horário exato; requer design antes do briefing)
- **MH-029** — alerta de estoque semântico correto para agudo
- **MH-030** — encerramento automático de tratamento agudo (último dia + relatório final)

### Média prioridade
- **P3** — classificador verificar temDosePendente antes de classificar (fallback já protege)
- **MH-024** — confirmação retroativa de dose ("tomei mas esqueci de registrar")
- **MH-027** — reagendamento sob demanda ("me lembre em 5 minutos")
- **MH-031** — histórico de tratamentos encerrados via conversa
- **MH-003** — timestamp real de confirmação vs. horário agendado
- **BUG-027** — nome de medicamento pré-cadastro perdido no cad_nome

### Fase 3+
- **MH-004** — transcrição de áudio via Whisper
- **MH-007** — RAG no bulário ANVISA (agente_medicacoes)
- **MH-008** — leitura de receitas por imagem
- Rede de cuidado — interface para adicionar cuidadores

---

## Alertas de Escalabilidade (pós-MVP)

- **Número WhatsApp:** hoje usa número Business não oficial. Risco de ban se usuários
  reportarem. Migrar para API oficial Meta antes de escalar.
- **Custo de LLM:** não é prioridade agora. Otimizar após PMF com volume real. Nota:
  o classificador LLM no roteador adiciona uma chamada por mensagem ambígua em idle.
- **Idempotência:** Set em memória sem durabilidade. Endereçar antes de múltiplas instâncias.

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

### Ritual de encerramento de sessão
1. Atualizar itens 1 e 2 do memory
2. Gerar `Nami_Relatorio_vN+1.docx` e apresentar para download (upload manual no Drive)
3. Gerar briefings/encerramento_vN+1.md com o CONTEXT.md atualizado para Claude Code commitar

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

---

## Princípios de Engenharia (formalizados v10)

1. **Sistêmico vs. remendo** — toda análise de problema/causa-raiz/solução pergunta:
   estou resolvendo de forma sistêmica ou apenas remendando? Preferir eliminar a classe
   inteira do problema, não só o caso que apareceu.
2. **Baixo acoplamento, alta coesão** — arquitetura deve permitir manutenção e expansão
   futura com facilidade.
3. **Legibilidade** — outro desenvolvedor deve entender o código e conseguir mantê-lo.
   Objetivo: programa leve, eficiente e escalável, não denso ou mal escrito.
4. **Cálculos de saúde determinísticos** — aritmética de horários, status de dose,
   contagem de estoque sempre em código, nunca por inferência do LLM.
5. **Inventário do roteador sempre atual** — sempre que uma capacidade de agente for
   adicionada/removida, o inventário do `classificarIntencaoComContexto` (router.js) DEVE
   ser atualizado na mesma alteração. Inventário desatualizado causa misclassificação.
6. **Propagação de histórico sistêmica** — buscar histórico uma vez no roteador e propagar
   uniformemente a todos os agentes LLM via `formatarHistoricoConversa`; lembrete fica fora
   (determinístico puro).

### Decisão arquitetural revisável: roteador + principal separados
Mantidos separados (não unificados) na v10. O roteador determinístico é barato, rápido e
previsível para intenções claras (confirmação de dose, pausar) sem custo de LLM, e a
previsibilidade tem valor clínico em adesão. Gatilho para reavaliar a unificação (principal
como orquestrador único): quando as interações exigirem raciocínio conversacional rico que
o roteador não comporte (Fase 3+: áudio, RAG, rede de cuidado).

---

## ⚠️ Investigação Pendente — Ciclo de Vida da Dose (registrado v10)

Investigação dedicada para sessão futura. Integridade de dado de saúde — três casos com
raiz comum na sincronia entre status da dose, estoque e retroatividade:

1. **Reversão de confirmação + estoque dessincronizado:** "Sim" confirmou dois medicamentos
   juntos, estoque zerou e disparou alerta de "último comprimido"; correção posterior
   reverteu a dose e recreditou o estoque. PERGUNTAS DE DESIGN: confirmação deve ser
   reversível? Sob quais condições? Recreditar estoque? Deve deixar rastro auditável (não
   sobrescrever silenciosamente — é dado clínico)?
2. **Confirmação retroativa registra dose errada:** "tomei o ômega 3 de ontem" parece
   confirmar a dose de hoje. MH-024 não interpreta "de ontem" para localizar a dose correta.
3. **Dose expirada para nao_informado não é confirmável:** após 3 follow-ups, a dose vira
   nao_informado e o "Sim" tardio se perde. Caso RECORRENTE (Gil, Julia e outro usuário).
   O sistema só considera 'pendente' o status pendente ativo.

Bug menor relacionado: dose_logs salva `nao_informado` quando o usuário diz "não tomei"
(deveria ser `nao_tomado`).

**Ajuste menor (backlog):** mensagens fragmentadas do mesmo contexto ("Não" / "Só isso" /
"Tks" em sequência) recebem respostas independentes. Abordagem futura: agrupamento/debounce
temporal, ou reconhecer fechamentos consecutivos.
