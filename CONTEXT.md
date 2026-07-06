# 🌿 NAMI — Contexto do Projeto (v14 — MH-042 implementado e validado por completo, BUG-036 encontrado — 06/07/2026)

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

**Comunicação de resultado ao usuário também não depende do LLM (reforçado v14).**
Não basta o cálculo em si ser determinístico — a MENSAGEM que informa o resultado ao usuário também precisa nascer depois que a ação real já rodou, lendo o valor verdadeiro do banco. O LLM decide texto e ações na mesma chamada, antes de qualquer ação executar; qualquer número que ele declarar sobre o resultado é uma previsão não confiável, não o fato. Ver seção MH-042 Complemento.

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

⚠️ **Instabilidade observada (06/07/2026):** Supabase ficou fora do ar durante a sessão v14,
impedindo a validação de 2 cenários pendentes (ver Backlog). Sem causa raiz própria do projeto —
registrar apenas como fato operacional. Se recorrente, avaliar plano de contingência.

---

## Estrutura de Arquivos

```
nami-backend/
├── src/
│   ├── index.js              → Entry point + webhook + proteção idempotência
│   ├── agent.js              → Orquestrador — chama routeMessage
│   ├── router.js             → Roteador central (classificador LLM no else)
│   ├── database.js           → Todas as queries no Supabase; registrarMovimentoEstoque (MH-042) é o único ponto de escrita em estoque
│   ├── whatsapp.js           → Envio de mensagens e parse Z-API
│   ├── scheduler.js          → Cron: lembretes + follow-ups + resumo semanal (agrupamento MH-032)
│   ├── prompts.js            → System prompt do agente_principal
│   └── agentes/
│       ├── recepcionista.js  → Onboarding de novos usuários (v3)
│       ├── principal.js      → Conversa geral + confirmação + ciclo de vida da dose + UPDATE_STOCK (MH-042)
│       ├── cadastro.js       → Cadastro (cálculo determinístico + MH-038 duplicata no início)
│       ├── lembrete.js       → Follow-up espaçado (30min/1h/30min)
│       ├── relatorios.js     → Consultas de histórico (híbrido: query + Claude)
│       └── configuracao.js   → Pausar/reativar/encerrar/alterar horário
├── briefings/                → Briefings de implementação (na raiz da pasta, sem subpastas)
├── supabase/
│   └── migrations/
│       ├── 20260629000000_baseline.sql              → Schema completo v10 + auditoria v11
│       ├── 20260701000000_mh032_horario_agendado.sql → Coluna horario_agendado (MH-032)
│       └── 20260706000000_mh042_stock_movements.sql  → Tabela stock_movements (MH-042), aplicada manualmente
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

⚠️ **APRENDIZADO OPERACIONAL (v13):** o `origin` git local pode estar configurado para o nome
antigo do repositório (`Gui-eng26/nami-backend.git`), funcionando apenas por redirect automático
do GitHub para o nome atual (`Gui-eng26/Nami_life.git`). Corrigir com:
```
git remote set-url origin https://github.com/Gui-eng26/Nami_life.git
```

---

## Banco de Dados — Supabase (PostgreSQL)

### Schema versionado no repositório
Schema formalizado em `supabase/migrations/`. Baseline `20260629000000_baseline.sql` +
`20260701000000_mh032_horario_agendado.sql` + `20260706000000_mh042_stock_movements.sql`.
Toda alteração futura via novo arquivo de migration numerado.

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
horario_agendado (time, MH-032 — NULL em registros pré-migration, tratado como "não agrupa")
```

**medications**
```sql
id, user_id (FK), nome, dosagem, instrucoes, estoque_atual, estoque_minimo,
forma_farmaceutica, tipo_tratamento, tratamento_dias, tratamento_fim, ativo, created_at
```
⚠️ `estoque_atual` NUNCA deve ser escrito diretamente — sempre via `registrarMovimentoEstoque`
(database.js), único ponto de escrita desde o MH-042.

**stock_movements (novo — MH-042, 06/07/2026)**
```sql
id, medication_id (FK), tipo (cadastro_inicial | cadastro_substituicao | reativacao_com_estoque |
recompra | correcao_soma | correcao_subtracao | correcao_set | dose_confirmada | dose_retroativa |
dose_revertida), origem (manual | automatico), quantidade_delta, estoque_anterior, estoque_novo,
motivo (text, nullable), dose_log_id (FK, nullable), created_at
```
Append-only — nunca UPDATE ou DELETE. Auditoria completa de todo movimento de estoque, manual
e automático. Absorve a antiga nota de rastreabilidade que estava anexada ao MH-037.

**conversation_state** (sem "s") — estado operacional, jsonb livre.
**agent_logs** — fotografia diagnóstica imutável, nunca lida pelo fluxo operacional.

### ⚠️ Padrão crítico no Supabase JS SDK
Filtros via join NÃO funcionam: `.eq('medications.user_id', userId)` retorna todos os registros.
Sempre usar abordagem em duas etapas com `.in()`.

---

## MH-042 — Correção Manual de Estoque + Auditoria Sistêmica (v14)

**Problema original:** a Nami só reconhecia recompra como linguagem de atualização de estoque;
recontagem e perda não tinham gatilho algum.

**Entregue (commit `55e25be`):**
- Tabela `stock_movements` (ver Banco de Dados acima)
- `registrarMovimentoEstoque` (database.js) — único ponto de escrita em `estoque_atual`, com clamp
  determinístico em 0 (nunca negativo); todos os 8 pontos que já escreviam em estoque foram
  retrofitados para passar por ela (cadastro inicial/substituição, 4 funções do ciclo de vida de
  dose, recompra, reativação de tratamento pausado)
- Novos modos em `UPDATE_STOCK`: `soma` (recompra/recontagem para mais), `subtracao` (perda/quebra),
  `set` (correção absoluta); pergunta de acompanhamento quando a mensagem não traz número
- **Exclusão deliberada:** "tomei X mas não avisei" nunca aciona `UPDATE_STOCK` — permanece só em
  `CONFIRM_RETROATIVA`, protegendo o dado de adesão de ser corrompido por um atalho de estoque
- Inventário de capacidades do router (`classificarIntencaoComContexto`) atualizado

**Complemento (commit `5e1dfdd`) — correção de mensagem, não de cálculo:**
Validação em produção mostrou que a mensagem final podia declarar um número de estoque calculado
pelo LLM ("vai ficar em -3"), contradizendo o alerta determinístico real ("estoque zerado"), porque
`message` e `actions` nascem na mesma chamada do LLM, antes da ação (e do clamp) rodar de fato.
- `registrarMovimentoEstoque` agora retorna `{ estoqueAnterior, estoqueNovo, deltaAplicado }`
- Nova `buildEstoqueAtualizadoMessage` (principal.js) — monta "Estoque atualizado! Seu novo estoque
  de X é Y unidades" sempre a partir do banco, nunca do texto do LLM; explica quando o clamp foi
  aplicado (perda pedida > estoque disponível)
- `buildAlertaEstoqueAjusteMessage` mantida **intocada e desacoplada** — cuidado deliberado para não
  misturar o informativo de resultado com a regra de alerta de limiar, que vai receber a oferta de
  recompra via parceiro no futuro
- Prompt: regra absoluta proibindo o LLM de declarar qualquer número de estoque calculado; formalizada
  a confirmação prévia quando a perda informada ≥ estoque atual (sem declarar resultado calculado)

**Achado registrado, fora de escopo:** existem hoje DUAS implementações de alerta de estoque
distintas — `buildAlertaEstoqueAjusteMessage` (simples, limiar, usada em ajuste manual) e
`buildAlertaEstoqueMessage` (sofisticada, com `diasRestantes`/`tratamento`/debounce por
`confirmacoesDoDia`, usada em confirmação de dose, ligada ao MH-029 ainda em aberto). Não foram
unificadas — decisão de consolidação fica para quando o MH-029 for priorizado.

**Validado nesta sessão — 100% dos cenários, MH-042 encerrado:** recompra, recontagem (soma/set),
perda com clamp em 0 (banco), exclusão do "tomei mas não avisei", auditoria automática de
confirmação/reversão de dose, cadastro inicial, fluxo "sem número", reconciliação matemática
completa (soma dos deltas = estoque_atual final), reteste de "perdi X ≥ estoque" pós-complemento
(mensagem final limpa, sem contradição — evidência: teste com Cataflam, sem número calculado pelo
LLM), e reativação de tratamento pausado com estoque atualizado via recadastro (`tipo:
reativacao_com_estoque`, evidência: Dipirona 20→10 registrado corretamente em `stock_movements`).

**Achado importante durante a validação — dois fluxos de reativação distintos (não é bug, é desenho
intencional, mas gerou confusão na hora de testar):**
- Comando direto "reativar [medicamento]" → `agente_configuracao` → `reativarMedicamento` — rápido,
  não toca estoque, pressupõe que os dados continuam válidos.
- Recadastro de medicamento já existente mas pausado → `agente_cadastro` detecta duplicata pausada
  (`todosInativos`) → fluxo completo (tipo de tratamento → estoque → horários) → `reativarComAtualizacao`
  com valor real de estoque. É este o caminho que gera auditoria em `stock_movements`.
Vale considerar, em sessão futura, se o comando direto "reativar" deveria ao menos perguntar se o
estoque mudou (hoje ele assume que não) — não decidido ainda, registrar como observação, sem ID.

**BUG-036 encontrado durante esta mesma validação (`configuracao.js`):** na etapa `reativ_horarios`
(fluxo de recadastro acima), a resposta "manter horários" não foi reconhecida como confirmação —
a Nami pediu os horários de novo, só funcionando quando reformulado para "continua igual". Causa
raiz confirmada (código real): a lista de termos aceitos como "manter como está" —
`['sim','s','ok','continua','mesmo','igual','está certo','tá bom','pode']` — está duplicada
literalmente em duas etapas (`reativ_estoque` linha 621 e `reativ_horarios` linha 651) e não inclui
"manter" nem sinônimos comuns ("deixa assim", "sem alteração", "permanece"). Existe ainda uma
terceira lista parecida mas distinta, `isConfirmacao` (linha 242), usada em outras etapas do mesmo
agente — três listas de "o usuário concordou" espalhadas pelo arquivo, cada uma incompleta à sua
maneira. Mesma classe de fragilidade já documentada no projeto (ex: "voltar" substring de
"Voltaren"). Solução sistêmica proposta (não implementada ainda): extrair uma única função
`confirmouManterComoEsta(message)` com lista de sinônimos expandida, usada nas duas etapas — mantendo
`isConfirmacao` separada por ser semanticamente distinta ("sim, prossiga" vs. "mantenha o valor atual").

---

## Ciclo de Vida da Dose (v11 — validado v12)

- Retroativa: janela de 2 dias, confirmação explícita obrigatória, `getDosesRetroativas`
- Reversão: `tentativas<3` → volta a `pendente`; `tentativas≥3` → `nao_tomado`; estoque sempre +1
- Scheduler e `ultima_tentativa_at` nunca resetam em reversão
- Auditoria: `revertido/revertido_at/revertido_de/revertido_motivo`

## MH-032 — Lembretes Agrupados por Horário (v12)
Coluna `horario_agendado` em `dose_logs`; agrupa lembretes/follow-ups do mesmo horário exato.

## Agente Lembrete — Follow-up Espaçado
```
Tentativa 1: horário agendado
Tentativa 2: +30 minutos
Tentativa 3: +1 hora
Após tent. 3: +30min → nao_informado + notifica cuidadores
```

## Agente Relatórios — Modelo Híbrido
Query direta para: tomei hoje, meus remédios, estoque, próximo remédio. Claude empático para
adesão e resumo semanal (segunda 08h).

---

## Status dos Bugs (atualizado 06/07/2026)

**Em validação:**
- MH-032 (lembretes agrupados) — validar 10 cenários em ambiente limpo
- BUG-035 (fast-path resposta tardia ao esgotamento) — validar 7 cenários, `BRIEFING_BUG035.md` §5

**MH-042 (correção de estoque + auditoria) — VALIDADO POR COMPLETO nesta sessão.** Todos os
cenários, incluindo os 2 que ficaram pendentes por instabilidade do Supabase, foram testados com
evidência real (ver seção MH-042 acima). Sai da lista de validação.

**Limitação conhecida aceitável:**
- **BUG-029** — fast-path "responder": zaapId (019E...) ≠ referenceMessageId (3EB0...). Fallback via texto funciona.

**Bugs abertos:**
- **BUG-031** — linguagem inadequada no relatório semanal (URGENTE, prazo segunda 06/07)
- **BUG-032** — encerramento de tratamento é fluxo sem saída (viola saída de emergência)
- **BUG-033** — dead-end residual em configuracao para alteração genérica sem tipo
- **BUG-034** — proteção sistêmica contra dose_logs duplicados (vacina, não urgente)
- **BUG-036** — "manter horários" não reconhecido como confirmação em `reativ_horarios`/`reativ_estoque`
  (lista de termos duplicada e incompleta — ver seção MH-042 acima). Encontrado nesta sessão, não implementado.
- **BUG-027** — nome de medicamento pré-cadastro perdido no cad_nome
- **BUG-028** — "ta bom" interpretado como pergunta em contexto idle
- **BUG-030** — pareceNome() não filtra "Sim, quero continuar"

---

## Convenção de IDs de Backlog (formalizada v12)

Todo item novo recebe ID obrigatório, sem exceção.
- **BUG-xxx** = comportamento que já deveria funcionar e não funciona, ou viola princípio
  não-negociável.
- **MH-xxx** (Melhoria) = capacidade nova, ou ajuste de algo que já funciona mas pode ser melhor.
- Numeração sequencial contínua — nunca reusar.
- Próximo BUG livre: **BUG-037**. Próximo MH livre: **MH-043**.

---

## Backlog Priorizado (atualizado 06/07/2026, fim v14)

**Em validação:**
- MH-032 (lembretes agrupados) — validar 10 cenários em ambiente limpo.
- BUG-035 (fast-path resposta tardia ao esgotamento) — validar 7 cenários, `BRIEFING_BUG035.md` §5.

**MH-042 validado por completo nesta sessão** — não entra mais na lista de validação nem no backlog priorizado.

1. **BUG-031** [30/06] — linguagem inadequada no relatório semanal. URGENTE (envio segunda 06/07). Conectado ao item 4.
2. **BUG-032** [30/06] — encerramento de tratamento é fluxo sem saída. Mesma família do BUG-033.
3. **MH-039** [30/06] — avaliar fluxo de encerramento em lote ("encerrar todos"). Relacionado ao BUG-032.
4. **Relatório de adesão — unificação de tipos** [28/06] — getAdesaoPeriodo(7) retornando só dados do dia; considerar revertido=true. Conecta ao BUG-031. Sem ID próprio.
5. **BUG-033** [28/06] — dead-end residual em configuracao (alteração genérica). Solução sistêmica única com BUG-032.
6. **BUG-034** [02/07] — proteção sistêmica contra dose_logs duplicados (vacina). Não urgente.
7. **BUG-036** [06/07] — "manter horários" não reconhecido como confirmação em `reativ_horarios`/`reativ_estoque` (configuracao.js). Causa raiz confirmada, solução sistêmica já desenhada (ver seção MH-042). Não urgente, mas simples de corrigir.
8. **MH-029** [19/06] — alerta de estoque incorreto para tratamento de tempo determinado com estoque suficiente. Ver também nota de consolidação de alertas ligada ao MH-042.
9. **MH-040** [28/06] — mensagens fragmentadas do mesmo contexto recebem respostas independentes.
10. **MH-041** [30/06 — OBSERVAÇÃO] — dose do horário antigo continua cobrando follow-up após alteração de horário. Observar antes de tratar.
11. **MH-030** [19/06] — encerramento automático de tratamento agudo.
12. **MH-027** [19/06] — reagendamento de lembrete sob demanda.
13. **MH-037** [28/06] — cálculo de adesão via COUNT dose_logs (horario_agendado do MH-032 dá granularidade por horário como bônus). Nota de rastreabilidade de estoque que estava anexada aqui foi absorvida pelo MH-042 (implementada).
14. **BUG-027 / BUG-028 / BUG-030** [18-19/06] e outros menores.

**NOTA (sem ID, observação da v14):** avaliar se o comando direto "reativar [medicamento]" deveria
perguntar sobre mudança de estoque, hoje ele assume que nada mudou (ver seção MH-042 acima).

### Fase 3+ (deferred)
- MH-004 Whisper (áudio), MH-007 RAG ANVISA, avaliação de unificação router+principal (decisão revisável).

---

## Princípios de Engenharia (formalizados v10, reforçados v11-v14)

1. **Sistêmico vs. remendo** — resolver a classe inteira do problema, não só o caso que apareceu.
2. **Baixo acoplamento, alta coesão** — arquitetura deve permitir manutenção e expansão futura.
3. **Legibilidade** — outro desenvolvedor deve entender e conseguir manter o código.
4. **Cálculos de saúde determinísticos** — aritmética de horários, status de dose, contagem de estoque sempre em código.
5. **Inventário do roteador sempre atual** — classificarIntencaoComContexto (router.js) atualizado na mesma alteração que adicionar/remover capacidade.
6. **Propagação de histórico sistêmica** — buscar histórico uma vez no roteador e propagar a todos os agentes LLM; lembrete fica fora (determinístico puro).
7. **Schema de banco como código** — toda alteração via migration numerada. Migrations são aplicadas MANUALMENTE no Supabase.
8. **Status terminais devem ter saída quando reversível** — nunca desenhar status clínico como "sem volta" se há cenário de correção legítimo.
9. **Scheduler nunca é resetado por correções retroativas** — o horário original do tratamento é uma referência protegida.
10. **Isolamento de ambiente** — nunca rodar servidor local com .env de produção.
11. **Mensagem de resultado nunca antes da ação executar (formalizado v14)** — qualquer número que o
    usuário vê sobre o resultado de uma ação relevante à saúde (estoque, dose) deve vir de uma leitura
    determinística do banco feita DEPOIS que a ação real rodou — nunca do texto que o LLM escreveu antes.
12. **Informativo de resultado e regra de alerta são funções separadas** — não fundir "o que aconteceu"
    com "o que fazer a respeito" (limiar de alerta) na mesma função, mesmo quando aparecem na mesma
    mensagem — a regra de alerta evolui por conta própria (ex: oferta de recompra via parceiro).

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
trabalhar"**, **"quais as prioridades"** (ou equivalentes), responder IMEDIATAMENTE com o quadro
completo da fila de backlog, incluindo para cada item: ID, descrição breve, e **dias aguardando**
calculado dinamicamente a partir da data de entrada e da data atual da sessão — nunca um número fixo.

### Ritual de início de sessão
1. Ler CONTEXT.md via `curl -s "https://raw.githubusercontent.com/Gui-eng26/Nami_life/main/CONTEXT.md"`
2. Confirmar estado atual com Guilherme antes de começar
3. Schema do banco: ler supabase/migrations/ no repositório

### Ritual de encerramento de sessão
1. Gerar relatório .docx e apresentar para download (upload manual no Drive)
2. Gerar briefings/encerramento_vN.md com o CONTEXT.md atualizado para o Claude Code commitar

⚠️ **Lição registrada (v13):** conferir que o nome do arquivo `encerramento_vN.md` bate com o
número de versão do CONTEXT.md que ele gera *antes* de salvar.

### Filosofia de debugging — inegociável
- **Nunca propor solução sem causa raiz confirmada.** Hipóteses devem ser identificadas como hipóteses e testadas/eliminadas uma a uma.
- **Analisar no contexto completo da Nami** — não o bug como fato isolado. Rever estrutura se necessário (inclusive modelo de IA usado nas respostas).
- **Evidências primeiro:** logs do Railway, código atual, dados do Supabase.
- **Atenção a fuso horário:** timestamps de logs exportados do Railway estão em UTC; o painel exibe em GMT-3.
- **Verificar implementação direto no repositório antes de assumir que está completa** — afirmações de "tudo implementado" devem ser confirmadas lendo o código real, nunca aceitas pelo resumo do Claude Code.

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
- **Schema:** `supabase/migrations/` (baseline + mh032_horario_agendado + mh042_stock_movements).
- **Google Drive:** pasta Desenvolvimento Nami, ID `17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN`. Último relatório: `Nami_Relatorio_v14.docx`.
- **Supabase:** banco Brasil (São Paulo). `agent_logs` = histórico conversacional. `conversation_state` = estado operacional (sem 's'). Migrations aplicadas manualmente no SQL Editor. Instabilidade pontual observada em 06/07/2026.
- **Railway:** produção com auto-deploy no git push. Logs exportados em UTC.
- **Claude Code (VS Code):** implementação via briefings `.md`.
