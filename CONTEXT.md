# 🌿 NAMI — Contexto do Projeto (v12 — Validações + Incidente de Duplicação resolvido — 02/07/2026)

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
O onboarding tem etapas necessárias (nome, LGPD), mas essas etapas devem ser apresentadas de forma que façam sentido para o objetivo do usuário. **Corolário:** o usuário nunca deve ficar preso em um fluxo. Todo fluxo precisa de saída de emergência.

**Cálculo de dado de saúde não depende do LLM.**
Aritmética que afeta segurança do tratamento — cálculo de horários de dose, contagem de estoque — deve ser feita em código determinístico, não por inferência do modelo.

**Status de dose nunca é alterado por timeout silencioso quando há ambiguidade reversível.**
nao_tomado só é registrado mediante declaração explícita do usuário. Status terminais (confirmado, nao_informado) devem permitir correção retroativa quando o usuário traz nova informação.

**Diferença entre Nami e bot genérico:**
Frases que mostram conexão com o que o usuário pediu, não seguir etapas de forma seca e fria.

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
**Webhook Z-API:** `POST /webhook/whatsapp` (aponta APENAS para o Railway)

⚠️ **Banco migrado em 29/06/2026:** Oregon (US) → Brasil (São Paulo) por LGPD e latência.

---

## Estrutura de Arquivos

```
nami-backend/
├── src/
│   ├── index.js              → Entry point + webhook + proteção idempotência
│   ├── agent.js              → Orquestrador — chama routeMessage
│   ├── router.js             → Roteador central (classificador LLM no else)
│   ├── database.js           → Todas as queries no Supabase
│   ├── whatsapp.js           → Envio de mensagens e parse Z-API
│   ├── scheduler.js          → Cron: lembretes + follow-ups + resumo semanal (agrupamento MH-032)
│   ├── prompts.js            → System prompt do agente_principal
│   └── agentes/
│       ├── recepcionista.js  → Onboarding de novos usuários (v3)
│       ├── principal.js      → Conversa geral + confirmação + ciclo de vida da dose (v11)
│       ├── cadastro.js       → Cadastro (cálculo determinístico + MH-038 duplicata no início)
│       ├── lembrete.js       → Follow-up espaçado (30min/1h/30min)
│       ├── relatorios.js     → Consultas de histórico (híbrido: query + Claude)
│       └── configuracao.js   → Pausar/reativar/encerrar/alterar horário
├── briefings/                → Briefings de implementação (na raiz da pasta, sem subpastas)
├── supabase/
│   └── migrations/
│       ├── 20260629000000_baseline.sql          → Schema completo v10 + auditoria v11
│       └── 20260701000000_mh032_horario_agendado.sql → Coluna horario_agendado (MH-032)
├── CONTEXT.md                → Este arquivo — ponto de partida de toda sessão
└── package.json
```

---

## Variáveis de Ambiente (.env)

```env
SUPABASE_URL=https://[PROJECT_ID].supabase.co   # SEM /rest/v1/ no final!
SUPABASE_SERVICE_KEY=sb_secret_...
ANTHROPIC_API_KEY=sk-ant-api03-...
ZAPI_INSTANCE_ID=[ID da instância]
ZAPI_TOKEN=[Token de integração]
ZAPI_CLIENT_TOKEN=[Client-Token da aba Segurança na Z-API]
PORT=3000
```

⚠️ `ZAPI_CLIENT_TOKEN` está em **Segurança** no painel Z-API — diferente do `ZAPI_TOKEN`.
⚠️ `SUPABASE_URL` deve ser apenas a URL base.

⚠️ **APRENDIZADO OPERACIONAL CRÍTICO (v12):** NUNCA deixar um servidor Node local rodando
com o `.env de produção`. Um processo local esquecido rodando em paralelo ao Railway causou
o incidente de duplicação de lembretes (ver seção dedicada). Recomendação: criar um
`.env.local` apontando para um banco de teste, isolando desenvolvimento de produção.

---

## Banco de Dados — Supabase (PostgreSQL)

### Schema versionado no repositório
Schema formalizado em `supabase/migrations/`. Baseline `20260629000000_baseline.sql` +
migration `20260701000000_mh032_horario_agendado.sql`. Toda alteração futura via novo arquivo
de migration numerado.

⚠️ **Migrations NÃO são aplicadas automaticamente** (não há Supabase CLI no deploy; Railway só
roda `node src/index.js`). Os arquivos em `supabase/migrations/` são documentação formal do
schema. Toda mudança de schema deve ser aplicada **manualmente** no SQL Editor do Supabase
ANTES do deploy do código que a utiliza.

### Tabelas principais

**dose_logs**
```sql
id, medication_id (FK), scheduled_at, reminder_sent, reminder_sent_at,
taken_at, confirmed, response_raw,
status (pendente/confirmado/nao_informado/nao_tomado/sem_estoque),
tentativas, ultima_tentativa_at, caregiver_notified, caregiver_notified_at,
zapi_message_id (text) ← formato zaapId (019E...), NÃO bate com referenceMessageId,
revertido (boolean), revertido_at, revertido_de, revertido_motivo,
horario_agendado (time) ← NOVO (MH-032): horário de cadastro que originou a dose
```
⚠️ **horario_agendado (v12/MH-032):** preenchido no nascimento do dose_log (sendReminder →
createDoseLog, lendo reminder.horario). Registros antigos ficam NULL (fallback individual —
não agrupam). Serve para agrupar lembretes/follow-ups de doses do mesmo horário exato e dá
granularidade por horário como bônus futuro para o MH-037. `scheduled_at` permanece com seu
significado original (timestamp do disparo do cron) e é lido por principal.js e lembrete.js.

Demais tabelas (users, medications, schedules, conversation_state, agent_logs,
intencoes_nao_suportadas, care_network) inalteradas em relação à v11.

### ⚠️ Padrão crítico no Supabase JS SDK
Filtros via join NÃO funcionam. Sempre usar abordagem em duas etapas com `.in()`.

### Stored Functions
- `get_pending_reminders()` — usada pelo scheduler; já retorna o campo `horario` (time) por lembrete.
- `get_dose_history(p_user_id, p_days)` — usada pelo agente_relatorios.
Comparações usam `AT TIME ZONE 'America/Sao_Paulo'`.

---

## VALIDAÇÕES CONCLUÍDAS NA v12 (evidência: logs + banco + prints)

### ✅ Ciclo de Vida da Dose — VALIDADO
Três caminhos confirmados em dados reais de dose_logs: confirmação retroativa
(nao_informado → confirmado), nao_tomado retroativo, e reversão de confirmação
(confirmado → outro status). Ver seção "Ciclo de Vida da Dose" abaixo para o design.

### ✅ MH-038 — VALIDADO (verificação de duplicata no início do cadastro)
Descoberto já implementado no código (comentário "TRABALHO 2" em cadastro.js ~368-497 e
database.js `verificarMedicamentoExistente` ~linha 156, usa `.ilike()` case-insensitive).
Validado nos 3 cenários: medicamento ativo, pausado/inativo, encerrado. Ao tentar cadastrar
um medicamento já existente, mostra os dados atuais sem reiniciar o fluxo completo.

### 🔄 MH-032 — Lembretes agrupados por horário (implementado, EM VALIDAÇÃO)
Ver seção dedicada abaixo. Validação anterior foi contaminada pelo processo local fantasma
(incidente de duplicação) — retomar com ambiente limpo. Requer usuário com 2+ medicamentos
no mesmo horário exato. 10 cenários no `briefings/BRIEFING_MH032.md`.

---

## 🆕 MH-032 — Lembretes Agrupados por Horário (v12)

**Status: implementado e pushado em 01/07/2026, aguardando validação em ambiente limpo.**

### Princípio central (NÃO VIOLAR)
Agrupamento é EXCLUSIVAMENTE camada de apresentação. O estado interno de cada dose permanece
100% individual (status, tentativas, ultima_tentativa_at, follow-up, nao_informado, cuidadores,
estoque). Só a mensagem de texto que o usuário lê é unificada.

### Regra de agrupamento
Doses do mesmo usuário com `horario_agendado` idêntico (mesmo HH:MM de cadastro). SEM janela,
SEM tolerância. Grupo de 1 dose → mensagem individual (inalterada). Grupo de 2+ → mensagem
agrupada. Vale para lembrete inicial E follow-up (mesma regra nos dois caminhos).

### Decisões de design
- Dose sem estoque (`estoque_atual <= 0`) sai do agrupamento → mensagem de estoque zerado individual.
- Confirmação parcial já funciona via `[ref:]` no principal.js (não mudou): "tomei todos"
  confirma o grupo; "só tomei o X" confirma só o X, o resto segue pendente e é cobrado no
  próximo follow-up (que virá agrupado só com o que falta).
- Follow-up agrupado (`handleGroupedFollowUp` em scheduler.js) reaproveita o `handleFollowUp`
  original de lembrete.js para os casos de esgotamento (nao_informado/cuidadores/estoque
  continuam individuais por dose). lembrete.js NÃO foi alterado.
- Mensagem = Variação C (instrutiva: "✅ Tomou todos? Responda SIM / 💬 Tomou só alguns? Me diga quais").

### Complemento aplicado na revisão (antes do push)
Doses agrupadas NÃO gravam `zapi_message_id` (ficam NULL). Uma mensagem agrupada tem 1
message_id para N doses, incompatível com o fast-path por natureza (que resolve 1 dose por
resposta). Elas confirmam pelo fluxo `[ref:]` do LLM. Doses individuais continuam gravando
zapi_message_id normalmente. Ao resolver o BUG-029 no futuro, NÃO tentar fazer doses agrupadas
usarem o fast-path — é uma incompatibilidade de desenho, não um esquecimento.

### Arquivos tocados
- `supabase/migrations/20260701000000_mh032_horario_agendado.sql` — coluna nova (aplicada manualmente no Supabase)
- `database.js` — createDoseLog aceita/grava horarioAgendado
- `scheduler.js` — separação sem/com estoque, agruparPorUsuarioEHorario, sendGroupedReminder,
  buildGroupedReminderMessage, handleGroupedFollowUp, buildGroupedFollowUpMessage

---

## ⚠️ INCIDENTE v12 — Lembretes/Follow-ups Duplicados (RESOLVIDO)

### Sintoma
Vários usuários (Guilherme, Gil, Julia, Ivete) recebendo lembretes e follow-ups repetidos —
2, 3 e até 4 vezes — sempre no mesmo horário. Efeito colateral grave: cada dose duplicada,
ao ser confirmada, debitava o estoque em DOBRO, corrompendo o saldo.

### Causa raiz CONFIRMADA (não hipótese)
**Um processo Node local esquecido rodando no terminal do VS Code do Guilherme**, aberto desde
a migração do banco (29/06), com o `.env de produção` e código PRÉ-MH-032 congelado em memória.
Dois schedulers concorrentes (local + Railway) criavam dose_logs duplicados quando os crons
colidiam na janela do guard `NOT EXISTS` (race de segundos).

**Prova definitiva:** toda duplicata pós-01/07 tinha exatamente 1 registro com `horario_agendado`
preenchido (Railway, código novo) + 1 com NULL (local, código antigo). Como a coluna só existe
no código pós-MH-032, isso provou que dois processos com versões diferentes gravavam no mesmo
banco. As conversas nunca duplicaram porque o webhook Z-API aponta só para o Railway — apenas o
cron, que roda sozinho, era executado em dobro.

### Resolução
Encerrar o processo local (Ctrl+C). A duplicação parou imediatamente. Limpeza pós-incidente
concluída: dose_logs órfãos deletados + estoque físico reconciliado nos medicamentos afetados.

### Hipóteses descartadas no caminho (registradas para não reabrir)
- Schedules duplicados no mesmo horário — refutado (era texto de dosagem, sem impacto em código).
- Falha do guard NOT EXISTS ao cruzar meia-noite — plausível mas não era a causa dominante.
- Doses nao_informado reentrando no fluxo — hipótese testada e refutada com ambiente limpo.
- Dois containers concorrentes no Railway — refutado pelo painel (1 deployment ativo, 1 réplica).

### Vacina registrada: BUG-034
Proteção sistêmica contra dose_logs duplicados: unique constraint/índice em dose_logs impedindo
2 registros do mesmo medicamento na mesma janela de disparo + insert tratando conflito
silenciosamente. Torna a duplicata fisicamente impossível independente de quantos processos
rodem. Não urgente (causa operacional já eliminada), mas recomendado.

---

## 🆕 Ciclo de Vida da Dose (v11 — VALIDADO na v12)

### Situação 1 — Confirmação retroativa
Dose virou nao_informado após 3 follow-ups sem resposta, mas o usuário tomou e quer registrar
depois. Janela de 2 dias (ontem e anteontem). Busca determinística por medicamento + data
(`getDosesRetroativas`), apresenta a dose específica e exige confirmação explícita antes de
registrar. nao_informado → confirmado, estoque -1, revertido_de = 'nao_informado'. Fora da
janela: resposta de limite + oferta de UPDATE_STOCK manual.

### Situação 2 — Reversão de confirmação
O campo `tentativas` decide o destino: `tentativas < 3` → confirmado → pendente (reentra no
fluxo); `tentativas >= 3` → confirmado → nao_tomado. Estoque sempre +1. **Scheduler e
ultima_tentativa_at NUNCA são resetados** — preserva a referência do horário original.
(Nota: na prática, reversões horas depois caem em tentativas >= 3 → nao_tomado; a branch
pendente só é atingida se a reversão ocorrer dentro dos ~30min do primeiro follow-up.)

### Semântica nao_tomado vs nao_informado
- Dentro do follow-up + "não tomei" simples → fica pendente (ainda pode tomar)
- Dentro do follow-up + "não vou tomar / sem estoque / registra" → nao_tomado explícito
- Fora do follow-up (já nao_informado) + "não tomei" → nao_tomado via fluxo retroativo
- nao_tomado só é registrado mediante declaração explícita, nunca por timeout

### Auditoria
Overwrite em `status` (sempre reflete a realidade atual) + colunas revertido/revertido_at/
revertido_de/revertido_motivo preservam o histórico.

### Implementação (briefing: briefings/BRIEFING_CICLO_VIDA_DOSE.md)
database.js (getDosesRetroativas, getDosesConfirmadasHoje, confirmarDoseRetroativa,
reverterConfirmacao, registrarNaoTomado estendida); prompts.js (actions CONFIRM_RETROATIVA e
REVERSE_CONFIRMATION, prefixos [ref-retro:] e [ref-conf:] com separação absoluta de contextos);
principal.js (blocos condicionais em buildUserMessage, novos cases em processAction);
router.js (inventário do classificador atualizado).

---

## Agente Lembrete — Follow-up Espaçado

```
Tentativa 1: horário agendado (lembrete chega ~2min antes do horário cadastrado)
Tentativa 2: +30 minutos (tom gentil)
Tentativa 3: +1 hora (último aviso)
Após tent. 3: +30min → nao_informado + notifica cuidadores ativos
```
A partir da v12, quando há 2+ doses do mesmo horário, a apresentação é agrupada (MH-032),
mas o processamento interno de tentativas/nao_informado/cuidadores continua individual por dose.

---

## Agente Relatórios — Modelo Híbrido

| Consulta | Tipo |
|---|---|
| Tomei hoje? / Meus remédios / Estoque / Próximo remédio | Query direta |
| Adesão | Claude empático |
| Resumo semanal | Claude proativo (segunda 08h) |

⚠️ **BUG-031 (URGENTE — resolver antes de segunda 06/07):** o bloco "Claude empático" gera
linguagem inadequada no relatório semanal sem guardrail/template — casos reais: "nudezinha"
(conotação indesejada) e sugestão de "criar lembrete no celular" (contradiz a proposta de valor
da Nami, que existe justamente para substituir esse hack). Montar templates padrão para o envio.
⚠️ Cálculo de adesão (MH-037) ainda não considera o impacto de `revertido = true`.

---

## Status dos Bugs (atualizado 02/07/2026)

**Resolvido na v12:**
- **Incidente de duplicação de lembretes/follow-ups** — processo local esquecido (ver seção dedicada).

**Limitação conhecida aceitável:**
- **BUG-029** — fast-path "responder": zaapId (019E...) ≠ referenceMessageId (3EB0...). Fallback via texto funciona.

**Bugs abertos:**
- **BUG-031** — linguagem inadequada no relatório semanal (URGENTE, prazo segunda 06/07)
- **BUG-032** — encerramento de tratamento é fluxo sem saída (viola saída de emergência)
- **BUG-033** — dead-end residual em configuracao para alteração genérica sem tipo
- **BUG-034** — proteção sistêmica contra dose_logs duplicados (vacina, não urgente)
- **BUG-027** — nome de medicamento pré-cadastro perdido no cad_nome
- **BUG-028** — "ta bom" interpretado como pergunta em contexto idle
- **BUG-030** — pareceNome() não filtra "Sim, quero continuar"

---

## Convenção de IDs de Backlog (formalizada v12)

Todo item novo recebe ID obrigatório, sem exceção (nunca "Trabalho X" ou "NOVO" como
identificador permanente).
- **BUG-xxx** = comportamento que já deveria funcionar e não funciona, ou viola princípio
  não-negociável (regressão, erro factual, fluxo sem saída de emergência).
- **MH-xxx** (Melhoria) = capacidade nova que nunca existiu, ou ajuste de algo que já funciona
  mas pode ser melhor/mais completo.
- Numeração sequencial contínua a partir do maior número já usado em cada série — nunca reusar.
- Próximo BUG livre: **BUG-035**. Próximo MH livre: **MH-042**.

---

## Backlog Priorizado (atualizado 02/07/2026, fim v12)

**Em validação:** MH-032 (lembretes agrupados) — validar 10 cenários em ambiente limpo.

1. **BUG-031** [30/06] — linguagem inadequada no relatório semanal. URGENTE (envio segunda 06/07). Conectado ao item 5.
2. **BUG-032** [30/06] — encerramento de tratamento é fluxo sem saída. Mesma família do BUG-033.
3. **MH-039** [30/06] — avaliar fluxo de encerramento em lote ("encerrar todos"). Relacionado ao BUG-032.
4. **BUG-034** [02/07] — proteção sistêmica contra dose_logs duplicados (vacina). Não urgente.
5. **Relatório de adesão — unificação de tipos** [28/06] — getAdesaoPeriodo(7) retornando só dados do dia; considerar revertido=true. Conecta ao BUG-031. Sem ID próprio.
6. **BUG-033** [28/06] — dead-end residual em configuracao (alteração genérica). Solução sistêmica única com BUG-032.
7. **MH-029** [19/06] — alerta de estoque incorreto para tratamento de tempo determinado com estoque suficiente.
8. **MH-040** [28/06] — mensagens fragmentadas do mesmo contexto recebem respostas independentes.
9. **MH-041** [30/06 — OBSERVAÇÃO] — dose do horário antigo continua cobrando follow-up após alteração de horário (alterarHorarioSchedule só atualiza schedules). Observar antes de tratar.
10. **MH-030** [19/06] — encerramento automático de tratamento agudo.
11. **MH-027** [19/06] — reagendamento de lembrete sob demanda.
12. **MH-037** [28/06] — cálculo de adesão via COUNT dose_logs (horario_agendado do MH-032 dá granularidade por horário como bônus).
13. **BUG-027 / BUG-028 / BUG-030** [18-19/06] e outros menores.

**NOTA (estoque — sem ID, ligada ao MH-037):** evoluir para rastreabilidade de estoque por
dose_log (registrar posição de estoque a cada movimentação: dose confirmada -1, reversão +1,
ajuste/recompra do usuário) + colunas em medications (estoque inicial estável, ajustes_estoque,
estoque_atual como consulta rápida consistente com dose_logs). Proposta esboçada em 01/07,
retomar desenho quando priorizar auditoria de estoque.

### Fase 3+ (deferred)
- MH-004 Whisper (áudio), MH-007 RAG ANVISA, avaliação de unificação router+principal (decisão revisável).

---

## Princípios de Engenharia (formalizados v10, reforçados v11-v12)

1. **Sistêmico vs. remendo** — resolver a classe inteira do problema, não só o caso que apareceu.
2. **Baixo acoplamento, alta coesão** — arquitetura deve permitir manutenção e expansão futura.
3. **Legibilidade** — outro desenvolvedor deve entender e conseguir manter o código.
4. **Cálculos de saúde determinísticos** — aritmética de horários, status de dose, contagem de estoque sempre em código.
5. **Inventário do roteador sempre atual** — classificarIntencaoComContexto (router.js) atualizado na mesma alteração que adicionar/remover capacidade.
6. **Propagação de histórico sistêmica** — buscar histórico uma vez no roteador e propagar a todos os agentes LLM; lembrete fica fora (determinístico puro).
7. **Schema de banco como código** — toda alteração via migration numerada. Migrations são aplicadas MANUALMENTE no Supabase (não há automação no deploy).
8. **Status terminais devem ter saída quando reversível** — nunca desenhar status clínico como "sem volta" se há cenário de correção legítimo. Toda transição de correção exige trilha auditável.
9. **Scheduler nunca é resetado por correções retroativas** — o horário original do tratamento é uma referência protegida.
10. **Isolamento de ambiente (v12)** — nunca rodar servidor local com .env de produção; um processo fantasma concorrente causou o incidente de duplicação.

---

## Modo de Trabalho — Ritmo Estabelecido

### Fluxo padrão de implementação
```
1. Identificar problema ou melhoria
2. Analisar causa raiz com evidências (logs, código, dados) — nunca hipóteses não identificadas
3. Gerar briefing em briefings/BRIEFING_[TEMA].md
4. Guilherme salva o briefing e aciona o Claude Code
5. Claude Code implementa → git add/commit/push
6. Railway redeploy automático
7. Verificar logs e testar no WhatsApp
Este chat = planejamento/análise/arquitetura. Claude Code (VS Code) = implementação.
```

### 🔔 Rito de abertura de sessão (formalizado v12)
Quando o Guilherme disser frases como **"o que temos pra hoje"**, **"no que precisamos
trabalhar"**, **"quais as prioridades"** (ou equivalentes pedindo direção/foco do dia),
responder IMEDIATAMENTE com o quadro completo da fila de backlog, incluindo para cada item:
- ID (BUG-xxx / MH-xxx quando existir)
- descrição breve
- **"há quantos dias está aguardando"**, calculado dinamicamente a partir da data de entrada
  registrada e da data atual da sessão — NUNCA usar um número de dias gravado fixo.

Objetivo: ajudar o Guilherme a calibrar rapidamente o que tem sido deixado para trás e por
quanto tempo. Cada item de backlog carrega sua data de entrada para permitir esse cálculo.

### Ritual de início de sessão
1. Ler CONTEXT.md via `curl -s "https://raw.githubusercontent.com/Gui-eng26/Nami_life/main/CONTEXT.md"`
2. Verificar relatório mais recente no Google Drive (pasta Desenvolvimento Nami, ID: 17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN)
3. Confirmar estado atual com Guilherme antes de começar
4. Schema do banco: ler supabase/migrations/ no repositório

### Ritual de encerramento de sessão
1. Atualizar memory (itens de estado de projeto e backlog, cada item com data de entrada)
2. Gerar relatório .docx e apresentar para download (upload manual no Drive)
3. Gerar briefings/encerramento_[nome].md com o CONTEXT.md atualizado para o Claude Code commitar

### Filosofia de debugging — inegociável
- **Nunca propor solução sem causa raiz confirmada.** Hipóteses devem ser identificadas como hipóteses e testadas/eliminadas uma a uma.
- **Analisar no contexto completo da Nami** — não o bug como fato isolado. Rever estrutura se necessário (inclusive modelo de IA usado nas respostas).
- **Evidências primeiro:** logs do Railway, código atual, dados do Supabase.
- **Atenção a fuso horário:** timestamps nos arquivos de log exportados do Railway estão em UTC; o painel exibe em GMT-3. Sempre ancorar a qual fuso um horário se refere (lição da v12).
- **Verificar implementação direto no repositório antes de assumir que está completa** — afirmações de "tudo implementado" devem ser confirmadas lendo o código real.

---

## Como Rodar Localmente

```bash
npm install
node src/index.js
```
⚠️ Ver aviso sobre .env de produção acima. Preferir .env.local com banco de teste.

---

## Ferramentas e Recursos

- **GitHub:** `Gui-eng26/Nami_life` (público) — raw via `curl -s "https://raw.githubusercontent.com/Gui-eng26/Nami_life/main/[filepath]"`.
- **Schema:** `supabase/migrations/` (baseline + mh032_horario_agendado).
- **Google Drive:** pasta Desenvolvimento Nami, ID `17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN`. Último relatório: `Nami_Relatorio_v12.docx`.
- **Supabase:** banco Brasil (São Paulo). `agent_logs` = histórico conversacional. `conversation_state` = estado operacional (sem 's'). Migrations aplicadas manualmente no SQL Editor.
- **Railway:** produção com auto-deploy no git push. Logs exportados em UTC.
- **Claude Code (VS Code):** implementação via briefings `.md`.
