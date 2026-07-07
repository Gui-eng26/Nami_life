# Briefing de Encerramento — Sessão v15

## Instruções para o Claude Code

Você receberá este arquivo ao final de cada sessão de desenvolvimento da Nami.
Sua única tarefa é executar os passos abaixo na ordem indicada, sem fazer perguntas.

---

## PASSO 1 — Sobrescrever o CONTEXT.md

Substitua **todo o conteúdo** do arquivo `CONTEXT.md` na raiz do projeto pelo conteúdo
abaixo. Não preserve nada do arquivo anterior.

```
# 🌿 NAMI — Contexto do Projeto (v15 — Adesão ao Tratamento consolidada: cálculo unificado, apresentação determinística, roteamento sem Camada 3 — 07/07/2026)

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
Aritmética que afeta segurança do tratamento — cálculo de horários de dose, contagem de estoque, cálculo de adesão e progresso de tratamento — deve ser feita em código determinístico, não por inferência do modelo.

**Comunicação de resultado ao usuário também não depende do LLM (reforçado v14, aplicado à adesão em v15).**
Não basta o cálculo em si ser determinístico — a MENSAGEM que informa o resultado ao usuário também precisa nascer de templates fixos, nunca de geração livre do LLM. Ver seção MH-042 Complemento (origem do princípio) e seção "Adesão ao Tratamento v15" (aplicação mais recente, incluindo a jornada de hábitos e o progresso de tratamento).

**Status de dose nunca é alterado por timeout silencioso quando há ambiguidade reversível.**
nao_tomado só é registrado mediante declaração explícita do usuário. Status terminais (confirmado, nao_informado) devem permitir correção retroativa quando o usuário traz nova informação.

**Confirmação de dose pendente tem precedência sobre qualquer estado conversacional "esperando resposta" (estabelecido v15, BUG-057).**
Nenhum estado de espera (ex: aguardando período de relatório, aguardando escolha de tratamento) pode sequestrar uma confirmação de dose real — a checagem de dose pendente deve rodar antes de qualquer lógica de estado. **Ainda não formalizado como princípio permanente da lista abaixo** — Guilherme quer refletir mais antes de generalizar a regra para todo estado futuro (risco de "regra em cima de regra"). Tratar caso a caso até decisão explícita.

**Diferença entre Nami e bot genérico:**
Frases que mostram conexão com o que o usuário pediu, não seguir etapas de forma seca e fria. Saudação repetitiva ("Olá, [Nome]!" a cada resposta) numa sequência de perguntas rápidas quebra essa sensação — ver saudação condicional na seção de Adesão ao Tratamento.

---

## Stack Tecnológica

| Componente | Ferramenta |
|---|---|
| Canal | WhatsApp Business API via **Z-API** |
| Backend | **Node.js** + Express |
| IA | **Claude API** (claude-sonnet-4-6) |
| Banco de dados | **Supabase** (PostgreSQL) — **projeto Brasil (São Paulo)** |
| Scheduler | **node-cron** (lembretes automáticos + resumo de adesão) |
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
│   ├── agent.js               → Orquestrador — chama routeMessage
│   ├── router.js               → Roteador central (classificador LLM retorna JSON {agente, subtipoRelatorio} — v15)
│   ├── database.js             → Todas as queries no Supabase; registrarMovimentoEstoque (MH-042) é o único ponto de escrita em estoque; calcularAdesao/calcularProgressoTratamento (v15)
│   ├── whatsapp.js              → Envio de mensagens e parse Z-API
│   ├── scheduler.js             → Cron: lembretes + follow-ups + resumo de adesão (domingo 16h — mudou de segunda 08h na v15)
│   ├── prompts.js               → System prompt do agente_principal
│   ├── nlp_helpers.js           → NOVO (v15): isCancelamento, encontrarMedicamento — compartilhados entre agentes (evita duplicação, lição do BUG-036)
│   ├── templates/
│   │   └── adesaoTemplates.js  → NOVO (v15): templates 100% determinísticos de adesão/progresso — espinha semanal (16) + mensal (12) + blocos aditivos (motivo/turno/tendência/marco) + progresso de tratamento (3 fases + estoque) + fluxo de período
│   └── agentes/
│       ├── recepcionista.js    → Onboarding de novos usuários (v3)
│       ├── principal.js         → Conversa geral + confirmação + ciclo de vida da dose + UPDATE_STOCK (MH-042); perdeu o bloco ad-hoc de progresso de tratamento (v15, origem do BUG-055)
│       ├── cadastro.js          → Cadastro (cálculo determinístico + MH-038 duplicata no início)
│       ├── lembrete.js          → Follow-up espaçado (30min/1h/30min)
│       ├── relatorios.js        → 6 tipos de relatório determinísticos (v15: + progresso_tratamento), sem Camada 3 de reclassificação
│       └── configuracao.js      → Pausar/reativar/encerrar/alterar horário
├── briefings/                   → Briefings de implementação (na raiz da pasta, sem subpastas)
├── supabase/
│   └── migrations/
│       ├── 20260629000000_baseline.sql                  → Schema completo v10 + auditoria v11
│       ├── 20260701000000_mh032_horario_agendado.sql     → Coluna horario_agendado (MH-032)
│       ├── 20260706000000_mh042_stock_movements.sql      → Tabela stock_movements (MH-042), aplicada manualmente
│       └── 20260707000000_adesao_tratamento.sql          → tratamento_fim populado + tabela adesao_estado (v15), aplicada manualmente
├── CONTEXT.md                    → Este arquivo — ponto de partida de toda sessão
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
com o `.env de produção`. Recomendação: criar um `.env.local` apontando para um banco de teste.

⚠️ **APRENDIZADO OPERACIONAL (v13):** o `origin` git local pode estar configurado para o nome
antigo do repositório. Corrigir com:
```
git remote set-url origin https://github.com/Gui-eng26/Nami_life.git
```

---

## Banco de Dados — Supabase (PostgreSQL)

### Schema versionado no repositório
Baseline `20260629000000_baseline.sql` + `20260701000000_mh032_horario_agendado.sql` +
`20260706000000_mh042_stock_movements.sql` + `20260707000000_adesao_tratamento.sql`.

⚠️ **Migrations NÃO são aplicadas automaticamente.** Toda mudança de schema deve ser aplicada
**manualmente** no SQL Editor do Supabase ANTES do deploy do código que a utiliza.

### Tabelas principais

**dose_logs** — sem mudança de schema na v15.
```sql
id, medication_id (FK), scheduled_at, reminder_sent, reminder_sent_at,
taken_at, confirmed, response_raw,
status (pendente/confirmado/nao_informado/nao_tomado/sem_estoque),
tentativas, ultima_tentativa_at, caregiver_notified, caregiver_notified_at,
zapi_message_id, revertido, revertido_at, revertido_de, revertido_motivo,
horario_agendado (time, MH-032 — NULL em registros pré-migration)
```
⚠️ **`calcularAdesao` (v15) filtra por `scheduled_at`, nunca por `taken_at`** — isso atribui
confirmações retroativas ao dia devido (não ao dia da confirmação) e exclui doses revertidas
automaticamente, sem lógica extra.

**medications**
```sql
id, user_id (FK), nome, dosagem, instrucoes, estoque_atual, estoque_minimo,
forma_farmaceutica, tipo_tratamento, tratamento_dias, tratamento_fim, ativo, created_at
```
⚠️ `tratamento_fim` existia desde o baseline mas nunca era populada — **agora é a fonte de
verdade do progresso de tratamento (v15)**, escrita em `saveMedication` e
`reativarComAtualizacao`, sempre calculada a partir de **agora** (reativação reinicia o relógio
do tratamento — decisão confirmada, rastreabilidade de prorrogação fica para o MH-043).
⚠️ `estoque_atual` NUNCA deve ser escrito diretamente — sempre via `registrarMovimentoEstoque`.

**adesao_estado (novo — v15)**
```sql
user_id (PK, FK), ultimo_fechamento_mensal_at, faixa_atual, percentual_ultimo_envio,
semana_atual_na_faixa, melhor_faixa_atingida, updated_at
```
Estado de acompanhamento da jornada de adesão (faixa/semana, tendência, marco de celebração) —
uma linha por usuário. `ultimo_fechamento_mensal_at` é resetado no momento do próprio fechamento
mensal (bug de design pego antes da implementação: sem esse reset, todo envio seguinte seria
classificado como mensal para sempre).

**stock_movements** — sem mudança na v15. Ver v14 para detalhes completos.

**conversation_state** (sem "s") — dois estados novos na v15: `aguardando_periodo_adesao` e
`aguardando_escolha_tratamento`, ambos seguindo o mesmo padrão de precedência (dose pendente >
cancelamento > resposta esperada > classificador central) estabelecido no BUG-057.

**agent_logs** — fotografia diagnóstica imutável, nunca lida pelo fluxo operacional (exceto, na
v15, para decidir a saudação condicional — ver seção de Adesão ao Tratamento).

### ⚠️ Padrão crítico no Supabase JS SDK
Filtros via join NÃO funcionam: `.eq('medications.user_id', userId)` retorna todos os registros.
Sempre usar abordagem em duas etapas com `.in()`.

---

## Adesão ao Tratamento — Consolidação (v15)

Trabalho da sessão inteira: unificou o cálculo de adesão (fragmentado em 2 funções divergentes +
uma terceira via ad-hoc dentro do `principal.js`), eliminou geração livre de LLM na apresentação
(raiz do BUG-031), e corrigiu uma fragilidade de roteamento que fazia perguntas de relatório
caírem incorretamente no agente de conversa geral (BUG-055, era chamado de "BUG-037" durante a
sessão até a correção de numeração — ver seção dedicada abaixo).

### Cálculo

- **`calcularAdesao(userId, dias)`** — substitui `getAdesaoPeriodo` e `getAdesaoPorMedicamento`
  (removidas). Conta `dose_logs` reais filtrando por `scheduled_at`, não estimativa por
  multiplicação. `porStatus` com 4 buckets (confirmado/nao_informado/nao_tomado/sem_estoque —
  `sem_estoque` conta contra adesão, decisão de produto confirmada). Diagnóstico de padrão por
  turno (manhã 05-11h / tarde 12-17h / noite 18-04h) só quando `dias >= 28` (fechamento mensal),
  limiar 60%/mínimo 3 casos — constantes nomeadas, ajustáveis após dados reais dos testers.
- **`calcularProgressoTratamento(userId)`** — novo, não existia formalmente antes (vivia como
  cálculo ad-hoc dentro do contexto geral do `principal.js`, origem histórica: MH-028, 17/06).
  Só para medicamentos com `tipo_tratamento != continuo` e `tratamento_dias` preenchido. Exclui
  tratamentos com `tratamento_fim` já passado (comparado por data em UTC, nunca por
  `diasRestantes`/`dosesRestantes` — esses zeram no próprio último dia, mesmo com dose ainda
  pendente naquele dia; usar comparação de data evita excluir um tratamento no dia em que a
  última dose ainda não foi tomada).

### Apresentação — 100% determinística, sem geração livre do LLM

Estrutura de **espinha dorsal + blocos aditivos** (evita multiplicar templates por combinação):
- Espinha semanal: 4 faixas (100%/80-99%/50-79%/<50%) × 4 semanas de progressão (Hábitos
  Atômicos), reset categórico ao mudar de faixa, repete semana 4 indefinidamente da 5ª em diante
  (revisão de "jornada 2" fica para o MH-044, após dados reais).
- Espinha mensal: 4 faixas × 3 variações, fechamento de 30 dias.
- Blocos aditivos: motivo dominante (3, incluindo sem_estoque), turno (só mensal, só
  nao_tomado/nao_informado), tendência (subiu/caiu/estável ±5pp + marco de celebração).
- Progresso de tratamento: 3 fases (início/meio/reta final por `percentualDecorrido`) + bloco de
  estoque (suficiente/insuficiente, com número exato de dias cobertos) + fallback para uso
  contínuo + resumo compacto (2+ tratamentos, pedido genérico).
- **Saudação condicional (v15):** "Olá, [Nome]!" só aparece se a última interação do usuário foi
  há mais de 10 minutos (`agent_logs`); caso contrário omitida. Aplicado só nos templates sob
  demanda (adesão, progresso de tratamento) — templates automáticos (semanal/mensal) mantêm
  saudação fixa, sempre.
- Textos revisados com apoio do Gemini para tom/formatação (mais espaçamento, emojis, calor) —
  aprovados por Guilherme, incorporados literalmente nos briefings de implementação.

### Chamadas

- **Camada 3 eliminada** — `handleRelatorios` não reclassifica mais internamente; recebe
  `subtipo` já resolvido por quem chama (Camada 1 fast-path ou Camada 2, o classificador central
  `classificarIntencaoComContexto`, que agora retorna JSON `{agente, subtipoRelatorio}` em vez de
  texto solto).
- **6 tipos formais de relatório**: tomei_hoje, meus_remedios, estoque, proximo_remedio, adesao,
  **progresso_tratamento** (novo).
- Sob demanda de adesão: extrai período da mensagem (7/15/30); se ausente, pergunta; se inválido,
  registra em `intencoes_nao_suportadas` (mecanismo já existente, reaproveitado) + recusa gentil.
- Cron do resumo automático mudou de **segunda 08h para domingo 16h** (decisão de produto:
  segunda de manhã é dia mais tumultuado). Decide semanal vs. fechamento mensal via
  `adesao_estado.ultimo_fechamento_mensal_at` (28+ dias → mensal, com reset no momento do envio).
- **Novos estados conversacionais com proteção contra beco sem saída**, mesmo padrão nos dois:
  dose pendente (precedência total, zera o estado) > cancelamento explícito > resposta reconhecida
  determinística > fallback para o classificador central (nunca lista de exclusão de palavras —
  não escala, mesma lição do BUG-036/055).

### Bugs encontrados e corrigidos durante a validação em produção desta sessão

- **BUG-056** — `progresso_tratamento` não filtrava por medicamento mencionado, concatenava todos
  os tratamentos com saudação repetida. Corrigido: filtro por nome (`encontrarMedicamento`,
  extraída para `nlp_helpers.js`), resumo compacto para pedido genérico.
- **BUG-056 (complemento)** — o atalho de "escolha reconhecida" batia só pelo nome do medicamento
  aparecer na mensagem, sem confirmar o assunto — "qual estoque do Neosaldina" e "vou encerrar o
  Cataflam" (ambos mencionando nomes de tratamentos pendentes) foram incorretamente tratados como
  pedido de progresso. Corrigido: classificador central sempre consultado antes de tentar casar
  nome, sem lista de exclusão de palavras.
- **BUG-057** — estado `aguardando_periodo_adesao` bloqueava qualquer mensagem que não fosse
  resposta de período, incluindo confirmações de dose reais (efeito grave: dose de Dipirona real
  não registrada em produção, corrigida manualmente por Guilherme). Corrigido: dose pendente
  verificada com precedência total, zera o estado por completo (sem deixar pergunta de período
  pendente atrás). **Validado em produção**: cenário de dose durante `aguardando_escolha_tratamento`
  confirmado com sucesso (Ômega 3 das 15h, log real). Cenário de dose durante
  `aguardando_periodo_adesao` (o estado original do bug) ainda **pendente de validação** —
  depende do próximo lembrete de dose coincidir com o estado ativo.
- **Exclusão de tratamento finalizado** — Cataflam/Dipirona (0 dias restantes) continuavam
  aparecendo no relatório de progresso com o template de "reta final". Corrigido via comparação
  de data (`tratamento_fim >= hoje`, em UTC — cuidado de fuso identificado e corrigido pelo Claude
  Code durante a implementação, já que comparação em horário local causaria exclusão indevida de
  tratamentos terminando no próprio dia, dado o fuso America/Sao_Paulo UTC-3).

### Achado — correção de numeração histórica de bugs (importante, não repetir)

Durante esta sessão, foi descoberto que o CONTEXT.md apontava "próximo BUG livre: BUG-037", mas o
repositório tem um lote histórico de briefings (`BUG-019` a `BUG-054`, commitados em bloco em
17/06, com datas internas reais entre 12/06 e 23/06) nunca considerado por quem escreveu esse
ponteiro. **Números BUG-032, BUG-033, BUG-034 e BUG-036 estão colididos** — usados tanto por bugs
antigos já resolvidos (17/06) quanto pelos bugs atuais ainda abertos no backlog (ver lista abaixo,
que usa o significado ATUAL desses números). Decisão: manter os briefings antigos como estão
(órfãos de contexto, não reescrever), só corrigir o ponteiro daqui para frente. **MH não tem esse
problema** — numeração MH-017 a MH-042 é consistente.

**Números corretos a partir de agora: próximo BUG livre é BUG-059. Próximo MH livre é MH-045.**
(BUG-055 a BUG-058 e MH-043/044 já foram atribuídos nesta sessão — ver backlog abaixo.)

---

## MH-042 — Correção Manual de Estoque + Auditoria Sistêmica (v14)

*(sem alterações desde v14 — histórico preservado)*

**Problema original:** a Nami só reconhecia recompra como linguagem de atualização de estoque;
recontagem e perda não tinham gatilho algum.

**Entregue (commit `55e25be`):**
- Tabela `stock_movements`
- `registrarMovimentoEstoque` — único ponto de escrita em `estoque_atual`, clamp em 0
- Modos `soma`/`subtracao`/`set` em `UPDATE_STOCK`
- Exclusão deliberada: "tomei X mas não avisei" nunca aciona `UPDATE_STOCK`

**Complemento (commit `5e1dfdd`):** mensagem final sempre lida do banco após a ação real, nunca
declarada pelo LLM antes de rodar.

**Achado registrado, fora de escopo:** duas implementações de alerta de estoque distintas
(`buildAlertaEstoqueAjusteMessage` vs. `buildAlertaEstoqueMessage`) — consolidação fica para
quando o MH-029 for priorizado.

**Validado por completo em v14.**

**BUG-036** (achado em v14, ainda não implementado): "manter horários" não reconhecido como
confirmação em `reativ_horarios`/`reativ_estoque` — três listas de termos de confirmação
divergentes no `configuracao.js`. Solução sistêmica proposta: função única
`confirmouManterComoEsta(message)`.

---

## Ciclo de Vida da Dose (v11 — validado v12)

- Retroativa: janela de 2 dias, confirmação explícita obrigatória, `getDosesRetroativas`
- Reversão: `tentativas<3` → volta a `pendente`; `tentativas≥3` → `nao_tomado`; estoque sempre +1
- Scheduler e `ultima_tentativa_at` nunca resetam em reversão
- Auditoria: `revertido/revertido_at/revertido_de/revertido_motivo`

## MH-032 — Lembretes Agrupados por Horário (v12)
Coluna `horario_agendado` em `dose_logs`; agrupa lembretes/follow-ups do mesmo horário exato.
Ainda em validação (10 cenários em ambiente limpo) — não avançado nesta sessão.

## Agente Lembrete — Follow-up Espaçado
```
Tentativa 1: horário agendado
Tentativa 2: +30 minutos
Tentativa 3: +1 hora
Após tent. 3: +30min → nao_informado + notifica cuidadores
```

## Agente Relatórios — 6 tipos, todos determinísticos (atualizado v15)
tomei_hoje, meus_remedios, estoque, proximo_remedio, adesao, progresso_tratamento. Adesão e
progresso de tratamento deixaram de usar Claude para gerar texto — 100% templates fixos (v15).
Estoque e os demais tipos permanecem query direta, sem mudança.

---

## Status dos Bugs (atualizado 07/07/2026)

**Em validação:**
- MH-032 (lembretes agrupados) — validar 10 cenários em ambiente limpo (sem avanço nesta sessão).
- BUG-035 (fast-path resposta tardia ao esgotamento) — validar 7 cenários, `BRIEFING_BUG035.md` §5 (sem avanço nesta sessão).
- **BUG-057** — cenário de dose durante `aguardando_periodo_adesao` pendente (depende do próximo lembrete).
- **Apresentação v2 (Adesão ao Tratamento)** — saudação condicional e textos novos implementados, ainda sem validação real em produção.

**Fechados nesta sessão (evidência real de produção):**
BUG-031, item "unificação de tipos" (sem ID), MH-037, BUG-055, BUG-056 + complemento, exclusão de
tratamento finalizado.

**Limitação conhecida aceitável:**
- **BUG-029** — fast-path "responder": zaapId ≠ referenceMessageId. Fallback via texto funciona.

**Bugs abertos (numeração atual, cuidado com colisão histórica — ver seção de Adesão ao Tratamento):**
- **BUG-032** — encerramento de tratamento é fluxo sem saída (viola saída de emergência)
- **BUG-033** — dead-end residual em configuracao para alteração genérica sem tipo
- **BUG-034** — proteção sistêmica contra dose_logs duplicados (vacina, não urgente)
- **BUG-036** — "manter horários" não reconhecido como confirmação em `reativ_horarios`/`reativ_estoque`
- **BUG-027** — nome de medicamento pré-cadastro perdido no cad_nome
- **BUG-028** — "ta bom" interpretado como pergunta em contexto idle
- **BUG-030** — pareceNome() não filtra "Sim, quero continuar"
- **BUG-058** (novo, v15) — `relatorioEstoque` perdeu a capacidade de filtrar por medicamento
  nomeado; hoje sempre retorna a lista completa, independente do que foi pedido. Regressão a
  investigar (não sabemos ainda se foi introduzida por alguma mudança desta sessão ou se é
  anterior). Não trabalhar ainda — registrado para depois.

---

## Convenção de IDs de Backlog (formalizada v12, numeração corrigida v15)

Todo item novo recebe ID obrigatório, sem exceção.
- **BUG-xxx** = comportamento que já deveria funcionar e não funciona, ou viola princípio
  não-negociável.
- **MH-xxx** (Melhoria) = capacidade nova, ou ajuste de algo que já funciona mas pode ser melhor.
- Numeração sequencial contínua — nunca reusar.
- ⚠️ **Antes de atribuir um número novo, sempre conferir `ls briefings/` no repositório real** —
  a v14 apontava "próximo BUG livre: BUG-037" sem saber que BUG-037 a BUG-054 já existiam
  (lote histórico commitado em bloco em 17/06). Não confiar cegamente neste ponteiro sem
  checagem, mesmo que ele pareça atualizado.
- **Próximo BUG livre: BUG-059. Próximo MH livre: MH-045.**

---

## Backlog Priorizado (atualizado 07/07/2026, fim v15)

**Em validação:**
- MH-032 (lembretes agrupados) — validar 10 cenários em ambiente limpo.
- BUG-035 (fast-path resposta tardia ao esgotamento) — validar 7 cenários, `BRIEFING_BUG035.md` §5.
- BUG-057 — cenário de dose durante `aguardando_periodo_adesao` (depende do próximo lembrete).
- Apresentação v2 de Adesão ao Tratamento — saudação condicional e textos novos, aguardando teste real.

**Fechados na v15** (não entram mais no backlog): BUG-031, unificação de tipos (sem ID),
MH-037, BUG-055, BUG-056 + complemento, exclusão de tratamento finalizado.

1. **BUG-032** [30/06] — encerramento de tratamento é fluxo sem saída. Mesma família do BUG-033. ⚠️ Colisão de número com bug histórico já resolvido — ver nota de numeração.
2. **MH-039** [30/06] — avaliar fluxo de encerramento em lote ("encerrar todos"). Relacionado ao BUG-032.
3. **BUG-033** [28/06] — dead-end residual em configuracao (alteração genérica). Solução sistêmica única com BUG-032. ⚠️ Colisão de número — ver nota.
4. **BUG-034** [02/07] — proteção sistêmica contra dose_logs duplicados (vacina). Não urgente. ⚠️ Colisão de número — ver nota.
5. **BUG-036** [06/07] — "manter horários" não reconhecido como confirmação (configuracao.js). Causa raiz confirmada, solução sistêmica já desenhada (ver seção MH-042). ⚠️ Colisão de número — ver nota.
6. **BUG-058** [07/07, NOVO] — relatório de estoque perdeu filtro por medicamento nomeado. Não investigado ainda.
7. **MH-029** [19/06] — alerta de estoque incorreto para tratamento de tempo determinado com estoque suficiente.
8. **MH-040** [28/06] — mensagens fragmentadas do mesmo contexto recebem respostas independentes.
9. **MH-041** [30/06 — OBSERVAÇÃO] — dose do horário antigo continua cobrando follow-up após alteração de horário.
10. **MH-030** [19/06] — encerramento automático de tratamento agudo.
11. **MH-027** [19/06] — reagendamento de lembrete sob demanda.
12. **MH-043** [07/07, NOVO] — fim de tratamento: lembretes pós-encerramento, alertas de recompra vencidos, relatório automático ao concluir, prorrogação de tratamento com rastreabilidade de `tratamento_fim` (semântica de "soma ao fim previsto" vs. "reinicia a partir de hoje" fica a critério de confirmação explícita do usuário no momento).
13. **MH-044** [07/07, NOVO] — jornada 2 (mensagens) para usuários estáveis 5+ semanas na mesma faixa de adesão. Medir primeiro via `adesao_estado.semana_atual_na_faixa > 4` (sem tabela nova) antes de desenhar — depende de dados reais dos testers.
14. **BUG-027 / BUG-028 / BUG-030** [18-19/06] e outros menores.

**NOTA (sem ID, da v14):** avaliar se o comando direto "reativar [medicamento]" deveria perguntar
sobre mudança de estoque.

### Fase 3+ (deferred)
- MH-004 Whisper (áudio), MH-007 RAG ANVISA, avaliação de unificação router+principal (decisão revisável).

---

## Princípios de Engenharia (formalizados v10, reforçados v11-v15)

1. **Sistêmico vs. remendo** — resolver a classe inteira do problema, não só o caso que apareceu.
2. **Baixo acoplamento, alta coesão** — arquitetura deve permitir manutenção e expansão futura.
3. **Legibilidade** — outro desenvolvedor deve entender e conseguir manter o código.
4. **Cálculos de saúde determinísticos** — aritmética de horários, status de dose, contagem de
   estoque, cálculo de adesão e progresso de tratamento sempre em código.
5. **Inventário do roteador sempre atual** — classificarIntencaoComContexto (router.js) atualizado
   na mesma alteração que adicionar/remover capacidade.
6. **Propagação de histórico sistêmica** — buscar histórico uma vez no roteador e propagar a todos
   os agentes LLM; lembrete fica fora (determinístico puro).
7. **Schema de banco como código** — toda alteração via migration numerada. Migrations são
   aplicadas MANUALMENTE no Supabase.
8. **Status terminais devem ter saída quando reversível** — nunca desenhar status clínico como
   "sem volta" se há cenário de correção legítimo.
9. **Scheduler nunca é resetado por correções retroativas** — o horário original do tratamento é
   uma referência protegida.
10. **Isolamento de ambiente** — nunca rodar servidor local com .env de produção.
11. **Mensagem de resultado nunca antes da ação executar** — qualquer número que o usuário vê
    sobre o resultado de uma ação relevante à saúde deve vir de leitura determinística do banco
    feita DEPOIS que a ação real rodou — nunca do texto que o LLM escreveu antes.
12. **Informativo de resultado e regra de alerta são funções separadas** — não fundir "o que
    aconteceu" com "o que fazer a respeito" na mesma função, mesmo quando aparecem juntos.
13. **Apresentação de dado de saúde também é determinística (v15)** — o mesmo raciocínio do
    princípio 4/11 se estende à camada de apresentação: mensagens de adesão/progresso nascem de
    templates fixos aprovados previamente, nunca de geração livre do LLM — elimina a raiz do
    BUG-031, não só o sintoma.
14. **Classificação semântica central, nunca lista de exclusão de palavras (v15)** — quando um
    atalho determinístico precisa decidir "essa mensagem foge do padrão esperado?", a resposta
    correta é consultar o classificador central (`classificarIntencaoComContexto`), não crescer
    uma lista de palavras a excluir — não escala e sempre fica um passo atrás da próxima frase que
    escapa (mesma lição do BUG-036, reaplicada no BUG-056 complemento).
15. *(Em consideração, não formalizado)* **Confirmação de dose pendente tem precedência sobre
    qualquer estado conversacional** — estabelecido no BUG-057, correto na prática, mas Guilherme
    pediu para não generalizar como regra permanente ainda sem refletir mais sobre o risco de
    acumular regras. Tratar caso a caso até decisão explícita numa sessão futura.

---

## Modo de Trabalho — Ritmo Estabelecido

### Fluxo padrão de implementação
```
1. Identificar problema ou melhoria
2. Analisar causa raiz com evidências (logs, código, dados) — nunca hipóteses não identificadas
3. Gerar briefing em briefings/BRIEFING_[TEMA].md — sempre com texto literal completo embutido
   (nunca referenciar material externo que o Claude Code não tem acesso — lição repetida 2x na v15)
4. Guilherme salva o briefing e aciona o Claude Code
5. Claude Code implementa → git add/commit/push
6. Railway redeploy automático
7. Verificar logs e testar no WhatsApp
8. Ler o código real no GitHub para confirmar a implementação — nunca aceitar o resumo do Claude
   Code sem verificação (lição repetida e reforçada na v15)
Este chat = planejamento/análise/arquitetura. Claude Code (VS Code) = implementação.
```

### 🔔 Rito de abertura de sessão (formalizado v12)
Quando o Guilherme disser frases como **"o que temos pra hoje"**, **"no que precisamos
trabalhar"**, **"quais as prioridades"** (ou equivalentes), responder IMEDIATAMENTE com o quadro
completo da fila de backlog, incluindo para cada item: ID, descrição breve, e **dias aguardando**
calculado dinamicamente a partir da data de entrada e da data atual da sessão — nunca um número fixo.

### Ritual de início de sessão
1. Ler CONTEXT.md via `curl -s "https://raw.githubusercontent.com/Gui-eng26/Nami_life/main/CONTEXT.md"`
2. Confirmar estado atual com Guilherme antes de começar
3. Schema do banco: ler supabase/migrations/ no repositório
4. **Antes de atribuir qualquer ID novo de BUG/MH, conferir `ls briefings/` no repositório real**
   — não confiar cegamente no ponteiro "próximo livre" sem essa checagem (ver Convenção de IDs)

### Ritual de encerramento de sessão
1. Gerar relatório .docx e apresentar para download (upload manual no Drive)
2. Gerar briefings/encerramento_vN.md com o CONTEXT.md atualizado para o Claude Code commitar

⚠️ **Lição registrada (v13):** conferir que o nome do arquivo `encerramento_vN.md` bate com o
número de versão do CONTEXT.md que ele gera *antes* de salvar.

### Filosofia de debugging — inegociável
- **Nunca propor solução sem causa raiz confirmada.** Hipóteses devem ser identificadas como
  hipóteses e testadas/eliminadas uma a uma.
- **Analisar no contexto completo da Nami** — não o bug como fato isolado. Rever estrutura se
  necessário (inclusive modelo de IA usado nas respostas).
- **Evidências primeiro:** logs do Railway/Supabase (`agent_logs`), código atual, dados reais.
- **Atenção a fuso horário:** timestamps podem estar em UTC; comparações de data devem ser
  explícitas sobre qual fuso usam dos dois lados (lição reforçada v15, ver exclusão de tratamento
  finalizado).
- **Verificar implementação direto no repositório antes de assumir que está completa** —
  afirmações de "tudo implementado" devem ser confirmadas lendo o código real.
- **Briefings sempre com texto literal embutido, nunca por referência** — se o conteúdo (ex:
  templates de mensagem) foi definido em conversa, colar o texto completo no arquivo do briefing.
  O Claude Code só lê o que está no arquivo.

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
- **Schema:** `supabase/migrations/` (baseline + mh032 + mh042 + adesao_tratamento).
- **Google Drive:** pasta Desenvolvimento Nami, ID `17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN`. Último relatório: `Nami_Relatorio_v15.docx`.
- **Supabase:** banco Brasil (São Paulo). `agent_logs` = histórico conversacional (também usado para saudação condicional, v15). `conversation_state` = estado operacional (sem 's').
- **Railway:** produção com auto-deploy no git push. Logs exportados em UTC.
- **Claude Code (VS Code):** implementação via briefings `.md`, sempre com texto literal embutido.

```

---

## PASSO 2 — Commit e push

Execute os seguintes comandos no terminal:

```bash
git add CONTEXT.md
git commit -m "docs: CONTEXT.md atualizado — sessão v15, Adesão ao Tratamento consolidada (07/07/2026)"
git push
```

---

## PASSO 3 — Confirmar

Após o push, responda com:
- O hash do commit gerado
- Confirmação de que o CONTEXT.md foi atualizado com sucesso

Não faça mais nada além do que está descrito acima.