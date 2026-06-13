# 🌿 NAMI — Contexto do Projeto (v6 — 12/06/2026)

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
| Versionamento | **GitHub** — Gui-eng26/Nami_life |

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
│       └── relatorios.js     → Consultas de histórico (híbrido: query + Claude)
├── CONTEXT.md                → Este arquivo — ponto de partida de toda sessão
├── BRIEFING_V2.md            → Briefing da arquitetura multi-agente
├── BRIEFING_CADASTRO.md      → Briefing do agente_cadastro
├── BRIEFING_LEMBRETE.md      → Briefing do agente_lembrete
├── BRIEFING_RELATORIOS.md    → Briefing do agente_relatorios
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
taken_at, confirmed, response_raw, status (pendente/confirmado/nao_informado/nao_tomado),
tentativas, ultima_tentativa_at, caregiver_notified, caregiver_notified_at
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
Funções já corrigidas: `getDosesHoje`, `getRecentDoses`.

---

## Arquitetura Multi-Agente

### Fluxo do Roteador

```
mensagem chega → index.js (proteção idempotência por messageId)
      ↓
getOrCreateUser(phone)
      ↓
user.onboarded === false? → agente_recepcionista
      ↓
detectarConfirmacaoDose(msg) AND temDosePendente(userId)? → agente_principal
      ↓
state === 'adding_med'? → agente_cadastro
      ↓
detectarIntencaoCadastro(msg)? → agente_cadastro
      ↓
classificarIntencaoRelatorio(msg)? → agente_relatorios (se retornar null → principal)
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
| agente_medicacoes (RAG) | — | 🔜 Fase 3 |
| leitor_receita | — | 🔜 Fase 4 |
| agente_acompanhamento | — | 🔜 Fase 4 |

---

## Recepcionista v3 — Fluxo Detalhado

### 3 categorias de intenção (primeira mensagem)
- **CADASTRAR** — usuário mencionou remédio, posologia, tratamento
- **DESCOBRIR** — quer entender o que a Nami faz
- **NEUTRO** — saudação simples

### Etapas
```
recep_boas_vindas    → apresentação + pede nome
                       SE mensagem parece remédio (pareceNome() = false):
                         não salva como nome, pede nome de verdade
recep_coleta_nome    → salva nome, apresenta LGPD
recep_lgpd           → aceite ou recusa
lgpd_recusado        → explica motivo + deixa porta aberta
lgpd_recusado_retorno → usuário volta, Nami pergunta se mudou de ideia  
recep_lgpd_reapresentacao → reapresenta termos para novo aceite explícito
```

### Validações críticas
- `pareceNome(message)` — detecta padrões de medicamento antes de salvar nome
- `isLgpdAccepted(message)` — keywords: sim, s, pode, concordo, aceito, ok, claro...
- `contemRecusa(message)` — keywords: não, nao, recuso, não aceito...
- Nome inválido nunca chega ao banco — validação antes do `updateUser`

### Transição pós-LGPD
- Intenção CADASTRAR → `state: 'adding_med'` → agente_cadastro assume automaticamente
- Outras intenções → `state: 'idle'` → agente_principal

---

## Agente Cadastro — Fluxo de 8 Etapas

```
cad_nome → cad_forma → cad_dosagem → cad_tipo_tratamento →
cad_horarios → cad_estoque → cad_confirmacao → cad_salvo
```

**Validação de estoque no cadastro (MH-018):**
Na etapa `cad_estoque`, calcula `diasRestantes = floor(estoque / horarios.length)`.
Se `<= 5`, injeta `alerta_estoque_baixo` no contexto — Claude menciona antes de confirmar.

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

| Consulta | Tipo | Ativadores |
|---|---|---|
| Tomei hoje? | Query direta | "tomei hoje?", "já tomei meus remédios"... |
| Meus remédios | Query direta | "quais meus remédios", "que remédios tenho"... |
| Estoque | Query direta | "quanto tenho de cada", "tô ficando sem remédio"... |
| Próximo remédio | Query direta | "o que tenho que tomar", "qual o próximo remédio"... |
| Adesão | Claude empático | "quantas vezes esqueci", "minha adesão tá boa"... |
| Resumo semanal | Claude proativo | Automático toda segunda às 08h |

⚠️ Termos muito genéricos como "meus remédios" sozinho não ativam o agente —
precisa de contexto de pergunta explícita.

---

## Lógica de Estoque em Dias (MH-017)

```javascript
diasRestantes = floor(estoque_atual / dosesPerDia)
dosesPerDia   = schedules ativos do medicamento
threshold     = 5 dias
```

Alerta dispara junto com o **primeiro lembrete do dia** quando `diasRestantes <= 5`.
Alerta diário até usuário informar nova quantidade.
Usuário pode responder "comprei 30 comprimidos de X" → ação `UPDATE_STOCK`.

---

## Decisões Arquiteturais — Raciocínio por trás

### Por que subagentes em vez de prompt único?
Prompt único com toda a complexidade da Nami causa sobrecarga — o modelo
confunde contextos, mistura cadastro com confirmação de dose, perde etapas.
Subagentes com prompts focados performam melhor do que um modelo mais caro
com prompt sobrecarregado. Essa foi a decisão central da v2.

### Por que NÃO abandonar subagentes mesmo com bugs de contexto?
Tentação recorrente — mas os bugs de contexto (BUG-020, 021) não são falha
da arquitetura multi-agente. São falhas de design do primeiro turno e de
filtros SQL quebrados. A correção é cirúrgica, não estrutural.

### Por que modelo híbrido no agente_relatorios?
Consultas estruturadas (tomei hoje?, estoque) não precisam do Claude —
query direta é mais rápida, mais barata e mais previsível. Consultas abertas
(adesão, motivação) precisam de linguagem empática — aí o Claude agrega.

### Por que não LangGraph?
Considerado na fase de planejamento. Decisão: começar com orquestração manual
(router.js) por ser mais simples de debugar e suficiente para o estágio atual.
LangGraph entra quando a complexidade justificar — ainda não chegou lá.

### Por que RAG ainda não foi implementado?
O bulário ANVISA (especialista_medicacoes) é Fase 3. Antes disso, o fluxo
básico de cadastro, lembrete e confirmação precisa estar sólido. RAG em cima
de base instável gera mais problemas do que resolve.

---

## Padrões de Bugs Recorrentes

### Filtro via join no Supabase JS SDK (BUG-017, BUG-023)
`.eq('tabela_relacionada.campo', valor)` não funciona.
Sempre usar abordagem em duas etapas com `.in()`.

### Variáveis de ambiente no Railway
Sempre verificar: SUPABASE_URL sem /rest/v1/, ZAPI_CLIENT_TOKEN em Segurança.

### Idempotência no webhook Z-API
Z-API pode entregar o mesmo evento duas vezes. Proteção implementada via
`processedMessages` Set no index.js com TTL de 30 segundos.

### Detecção de confirmação de dose agressiva demais
`detectarConfirmacaoDose` deve sempre ser combinada com `temDosePendente`.
Sem dose real no banco, qualquer "sim" vai para o contexto correto da conversa.

---

## Status dos Bugs (atualizado 12/06/2026)

Todos os 24 bugs identificados até hoje estão corrigidos.
BUG-025 (duplicação de confirmação de dose) — aguardando validação nos logs.

---

## Backlog Priorizado

### Alta prioridade
- MH-014 — Remover/pausar lembrete via conversa (agente_cadastro)
- MH-015 — Alterar horário de lembrete via conversa (agente_cadastro)
- MH-003 — Timestamp real de confirmação vs. horário agendado
- MH-004 — Transcrição de áudio via Whisper

### Média prioridade
- MH-016 — Confirmação de encerramento para tratamento temporário
- MH-020 — Conformidade LGPD: exclusão de dados ao recusar
- MH-021 — Variação natural do nome nos prompts (evitar "Ótimo, {nome}!" repetido)
- MH-009 — Dashboard de relatórios para administrador

### Fase 3+
- MH-007 — RAG no bulário ANVISA (agente_medicacoes)
- MH-008 — Leitura de receitas por imagem
- MH-010 — agente_acompanhamento (NPS)
- MH-012 — Dosagem com propriedade via bulário
- Rede de cuidado — interface para adicionar cuidadores, convites, permissões

---

## Decisões em Aberto / Tensões Não Resolvidas

**Tensão: confirmação de dose vs. resposta contextual**
O router precisa decidir se "Sim" é confirmação de dose ou resposta à
conversa. Solução atual (dose pendente + pattern matching) funciona mas
é frágil. Em algum momento pode precisar de uma abordagem baseada em
estado explícito da conversa.

**Tensão: agente_relatorios capturando frases da Nami**
Quando a Nami menciona horários ou remédios na própria resposta, o usuário
às vezes repete a frase e o classificador captura. Solução atual: termos
mais específicos. Solução definitiva pode precisar de análise de contexto
conversacional.

**Em aberto: MH-014 e MH-015**
Como o usuário expressa que quer parar ou alterar um lembrete é muito variado.
"Não preciso mais", "pode parar", "mudei o horário", "tô bem agora"...
Precisará de classificador robusto, provavelmente via Claude em vez de regex.

**Em aberto: tratamento de tratamentos temporários**
Quando `tratamento_fim` chega, o scheduler deve perguntar se o usuário quer
encerrar ou prorrogar — antes de desativar. Ainda não implementado.

---

## Modo de Trabalho — Ritmo Estabelecido

### Fluxo padrão de implementação
```
1. Identificar problema ou melhoria
2. Analisar causa raiz com evidências (logs, código) — nunca hipóteses não identificadas
3. Gerar BRIEFING_[TEMA].md com causa raiz confirmada, correção cirúrgica e critérios de sucesso
4. Guilherme salva o briefing na raiz do projeto
5. Guilherme abre Claude Code no terminal: claude
6. Instrução ao Code: "Leia o CONTEXT.md e o BRIEFING_[TEMA].md. Implemente na ordem indicada."
7. Code mostra diff antes de salvar — Guilherme aprova
8. git add . && git commit -m "descrição" && git push
9. Railway detecta push e faz redeploy automático
10. Verificar logs do Railway para confirmar deploy limpo
11. Testar no WhatsApp e trazer logs/prints para análise
```

### Filosofia de debugging — inegociável
- **Nunca propor solução sem causa raiz confirmada.** Hipóteses devem ser identificadas como hipóteses.
- **Analisar no contexto completo da Nami** — não o bug como fato isolado.
- **Evidências primeiro:** logs do Railway, código atual, dados do Supabase — nessa ordem.
- **Correções cirúrgicas** — mexer apenas no que precisa. Não refatorar por refatorar.
- **Se a causa raiz não está clara**, dizer isso explicitamente e propor como investigar antes de implementar.

### Filosofia de produto — inegociável
- A Nami nunca ignora o que o usuário disse. Toda mensagem tem conteúdo próprio.
- O fluxo serve o usuário, não o contrário. Etapas necessárias devem ser justificadas no contexto do objetivo do usuário.
- Antes de qualquer decisão técnica, passar pelo filtro: "isso resolve o problema da Mariana?"
- Qualidade conversacional não é negociável — a Nami deve soar como uma assistente calorosa, não um bot com scripts.

### Dois contextos de trabalho
- **Este chat (Claude.ai):** arquitetura, decisões estratégicas, análise de bugs, geração de briefings e relatórios
- **Claude Code (VS Code terminal):** implementação, leitura de arquivos, edição de código, git
- O handoff entre os dois é feito via BRIEFING_[TEMA].md — o briefing é o contrato entre os dois contextos

### Estrutura de documentação
- `CONTEXT.md` — documento vivo, atualizado a cada sessão, ponto de partida de todo trabalho
- `BRIEFING_[TEMA].md` — instrução de implementação para o Claude Code, com causa raiz e critérios de sucesso
- `Nami_Relatorio_v[N].docx` — relatório de sessão no Google Drive (pasta Desenvolvimento Nami)
- Relatórios capturam o quê foi feito. CONTEXT.md captura o porquê e o como.



1. Ler este CONTEXT.md completo
2. Verificar o relatório mais recente em Google Drive > Desenvolvimento Nami
3. Checar os logs do Railway para qualquer erro recente
4. Confirmar qual é o próximo item prioritário do backlog

**Prompt de início recomendado:**
"Leia o CONTEXT.md. Estamos retomando o projeto Nami. O último relatório
foi o v[X]. Vamos continuar com [próximo item]."

---

## Como Rodar Localmente

```bash
npm install
node src/index.js
```

Para testes com webhook local:
```bash
ngrok http 3000
# Atualizar URL em Z-API > Webhooks e configurações gerais > Ao receber
```

Em produção, webhook aponta permanentemente para Railway.

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