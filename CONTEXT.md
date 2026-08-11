# 🌿 NAMI — Contexto do Projeto (v28 — FECHADA: cadeia BUG-082→085 no fluxo de
configuração + MH-70/71 reestruturação do contexto proativo (tabela eventos_proativos
append-only substituindo reconstrução via dose_logs); BUG-086 identificado como
bloqueador da validação do MH-71 — 01-05/08/2026)

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
Nami_life/
├── src/
│   ├── index.js              → Entry point + webhook + proteção idempotência
│   ├── agent.js               → Orquestrador — chama routeMessage
│   ├── router.js               → Roteador central (classificador LLM retorna JSON {agente, subtipoRelatorio} — v15); temDosePendente() exclui nao_informado (v17, BUG-035); despacharEscalada() (v18) — função compartilhada que recebe o sinal { escalarParaRoteador: true } de qualquer agente e decide o próximo destino usando classificarIntencaoComContexto, preservando medicationId/medicationNome/schedulesAtivos quando o destino ainda é configuracao. v27 (MH-065): classificarIntencaoComContexto recebe contextoProativo como campo paralelo (princípio 22) em 4 call sites; despacharEscalada propaga em 5 call sites, sem query nova (princípio 6). renderizarContextoProativo() insere o evento no FIM da cronologia do bloco CONVERSA RECENTE — sem seção destacada e sem instrução de precedência, para não cegar o classificador do lado reativo. Sem evento proativo, o prompt é idêntico ao anterior.
│   ├── database.js             → Todas as queries no Supabase; registrarMovimentoEstoque (MH-042) é o único ponto de escrita em estoque; calcularAdesao/calcularProgressoTratamento (v15); getHistoricoRecente() (v18) agora também seleciona estado_conversa/contexto_conversa de agent_logs, usado pelo classificador central pra resolver referências em mensagens futuras sem context vivo; classificarNivelEstoquePorDias() (v19, BUG-065) — classifica zerado/urgente/ok a partir de estoque real + dias de cobertura, nunca infere uma métrica a partir da outra. getContextoProativoRecente() (v27, MH-065) — reconstrói o ÚLTIMO evento proativo (lembrete ou follow-up) a partir de dose_logs, que é registro de ENTREGA (escrito depois de sendTextMessage), ao contrário de agent_logs que é registro de INTENÇÃO (princípio 24). Duas etapas com .in(), regra padrão do projeto. Consumida SÓ pelo classificador central.
│   ├── whatsapp.js              → Envio de mensagens e parse Z-API. v26: BARREIRA DE FORMA no início de sendTextMessage — rejeita message não-string, registra a FORMA (nunca o conteúdo) em system_events e lança TypeError. Fica FORA do try de propósito (dentro, o catch da Z-API registraria um 2º evento com fingerprint diferente). Não muda o desfecho para o usuário: hoje o objeto já vira 400 → catch global → mesma mensagem educada
│   ├── scheduler.js             → Cron: lembretes + follow-ups + resumo de adesão ('0 16 * * 0' COM timezone explícito, `America/Sao_Paulo` — scheduler.js:45; pendência aberta na v24 fechada por evidência na v27: `adesao_estado.updated_at` em 26/07 19:00 UTC = 16:00 BRT confirma o disparo correto) + juiz offline (03:00 BRT com timezone explícito, v24). v26: os 6 pontos de registrarEvento usam tituloEstavel(error, 'Erro no scheduler (<funcao>)') — prefixo por função, senão falhas de lembrete e de resumo semanal colapsariam no mesmo fingerprint
│   ├── observabilidade.js       → Ponto único de escrita em system_events/juiz_offline_execucoes (registrarEvento/registrarFeedback/registrarExecucaoJuizOffline); degradar() (v26, MH-064) registra evento E devolve o fallback na mesma chamada (princípio 31); tituloEstavel() deriva fingerprint estável por classe de erro. v27: entrada 'contexto_proativo:query_falhou' no catálogo DEGRADACOES (severidade media — a degradação devolve ao comportamento anterior, que é a ausência que o MH-065 corrige).
│   ├── juizOffline.js  → Juiz Offline (MH-054, v24) — varredura diária de agent_logs agrupada em
│   │                     episódios (user_id + gap 30min), enriquecida com system_events e dose_logs;
│   │                     LLM classifica em taxonomia canônica de sintoma com precedência; severidade
│   │                     derivada por tabela; emite system_events(origem='juiz_offline').
│   │                     payload NUNCA contém texto do usuário — só agent_log_ids.
│   │                     v26: try/catch POR EPISÓDIO + retry (3 tentativas, backoff 1s/4s, sem retry
│   │                     em 4xx exceto 429) — antes, uma 500 transitória abortava a varredura inteira.
│   │                     status da telemetria passa a ser DERIVADO de episodios_falha_julgamento.
│   │                     temperature: 0 — o juiz classifica, não redige; cada episódio é julgado uma
│   │                     única vez (idempotência), então oscilação vira falso negativo silencioso.
│   ├── prompts.js               → System prompt do agente_principal
│   ├── nlp_helpers.js           → isCancelamento (v18: regex apertado — "para" solto removido, exige "para de/com"/"parar"; vocabulário ampliado), encontrarMedicamento (agora também exportada como normalizar) — compartilhados entre agentes (evita duplicação, lição do BUG-036)
│   ├── dataReferencia.js        → NOVO (v25): resolução determinística de data. O LLM devolve a EXPRESSÃO ("ontem", "domingo", "19/07"); o cálculo da data real acontece só aqui. extrairExpressaoData() (texto-primeiro, princípio 17) · resolverDataReferencia() · validarJanela() (30 dias) · diasAtras() · rotularData() · janelaDiaBRT() (offset fixo -03:00; Brasil sem DST desde 2019 — único arquivo a revisar se isso mudar)
│   ├── templates/
│   │   ├── adesaoTemplates.js  → NOVO (v15): templates 100% determinísticos de adesão/progresso — espinha semanal (16) + mensal (12) + blocos aditivos (motivo/turno/tendência/marco) + progresso de tratamento (3 fases + estoque) + fluxo de período
│   │   ├── estoqueTemplates.js → NOVO (v19, BUG-065): buildAlertaEstoquePosConfirmacao + buildAlertaEstoqueNaoInformado — únicas funções de texto de alerta de estoque pós-confirmação/pós-lembrete; substituem 3 cópias divergentes que existiam em router.js, principal.js e lembrete.js desde o commit f967a0c (MH-026, 15/06)
│   │   └── balancoTemplates.js → NOVO (v25): núcleo factual determinístico do balanco_do_dia. montarBlocoFactual() (lista de doses, renderizada em código e inserida LITERALMENTE na mensagem) · montarCabecalhoData() (a data resolvida precisa de lugar determinístico porque o LLM é proibido de citá-la) · resumirSituacao() (contadores + cenário) · molduraPadrao() (fallback quando a chamada de moldura ao LLM falha)
│   └── agentes/
│       ├── recepcionista.js    → Onboarding de novos usuários (v3)
│       ├── principal.js         → Conversa geral + confirmação + ciclo de vida da dose + UPDATE_STOCK (MH-042); perdeu o bloco ad-hoc de progresso de tratamento (v15, origem do BUG-055); calcularRotuloDia() + âncora "Agora é..." no context (v17, BUG-059)
│       ├── cadastro.js          → Cadastro (cálculo determinístico + MH-038 duplicata no início)
│       ├── lembrete.js          → Follow-up espaçado (30min/1h/30min)
│       ├── relatorios.js        → 6 subtipos, sem Camada 3 de reclassificação. v25: tomei_hoje SUBSTITUÍDO por balanco_do_dia (status das doses de QUALQUER dia, filtrado por scheduled_at); handleRelatorios recebe params {medicamento, expressaoData}; resolverMedicamento() aplica princípio 17; gerarMoldura() é a única chamada de LLM do arquivo — devolve só {abertura, fechamento} em JSON e é proibida de citar dado factual
│       └── configuracao.js      → Pausar/reativar/encerrar/alterar horário. Reescrito na v18 com modelo de 3 camadas em todas as 12 etapas do state machine (parser determinístico → isCancelamentoGenuino → escalada ao roteador via despacharEscalada) — ver seção "Sessão v18" para detalhes. processarIntencaoOuEscalar() unifica a lógica de identif_intencao, reaproveitada por qualquer etapa que precise reconfirmar intenção (BUG-060)
├── briefings/                   → Briefings de implementação (na raiz da pasta, sem subpastas)
├── supabase/
│   └── migrations/
│       ├── 20260629000000_baseline.sql                  → Schema completo v10 + auditoria v11
│       ├── 20260701000000_mh032_horario_agendado.sql     → Coluna horario_agendado (MH-032)
│       ├── 20260706000000_mh042_stock_movements.sql      → Tabela stock_movements (MH-042), aplicada manualmente
│       ├── 20260707000000_adesao_tratamento.sql          → tratamento_fim populado + tabela adesao_estado (v15), aplicada manualmente
│       ├── 20260729000000_juiz_offline_execucoes.sql     → tabela juiz_offline_execucoes (MH-058, v25), aplicada manualmente
│       └── 20260730000000_status_triagem_nao_valida.sql  → 'nao_valida' no status_triagem de system_events e feedbacks (v26), aplicada manualmente
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
⚠️ **Reforço (v17):** o mesmo redirect (`Gui-eng26/nami-backend` → `Gui-eng26/Nami_life`) ainda
aparece como aviso do GitHub no push do Claude Code — o push funciona normalmente via redirect,
não é bloqueante, mas ainda não foi corrigido na origem. Rodar o `git remote set-url` acima numa
janela tranquila quando possível.

✅ **Resolvido (v19):** `git remote set-url` executado, `origin` aponta direto para
`Gui-eng26/Nami_life.git` — aviso de redirect não aparece mais. Nome também unificado em
`package.json`/`package-lock.json` (`nami_life`, minúsculo — regra do npm) e `.claude/launch.json`
(`Nami_life`). Histórico em `briefings/` mantido com o nome antigo de propósito (registro de
época, nunca reescrever).

⚠️ **APRENDIZADO OPERACIONAL (v19) — Preview do Claude Code Desktop (`.claude/launch.json`):**
o Claude Code Desktop pode subir a Nami localmente via seu recurso de Preview (detecta o servidor
e salva a config em `.claude/launch.json`). Confirmado em código que isso NÃO é uma sandbox
isolada pra este projeto:
1. `sendTextMessage` (`whatsapp.js`) chama a Z-API real de produção sempre — não existe modo mock.
   Qualquer resposta gerada localmente tenta mandar mensagem de WhatsApp de verdade.
2. `src/index.js` chama `startScheduler()` ao subir — rodar local em paralelo com o Railway de
   produção liga um SEGUNDO processo de lembretes consultando a mesma tabela `dose_logs`, sem
   nenhuma trava contra concorrência (mesma lacuna do BUG-034, ainda não implementado) — risco
   real de lembrete duplicado pra usuários reais.
3. `POST /webhook/whatsapp` não tem autenticação — aceita qualquer payload, o que é o que torna a
   simulação tecnicamente possível, mas também confirma que não há barreira nenhuma contra uso
   acidental.
**Decisão (v19):** não usar o Preview pra simular conversas contra este projeto por enquanto.
`autoVerify: false` setado em `launch.json` pra evitar auto-start silencioso após edições futuras
do Claude Code. Reavaliar só depois de desenhar isolamento de ambiente (`.env.local` + mock de
`sendTextMessage`) — não existe hoje.

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
v15, para decidir a saudação condicional — ver seção de Adesão ao Tratamento). **Desde a v22,
`logAgentInteraction` retorna o `id` da linha inserida** (antes não retornava nada) — é a chave de
correlação (`agent_log_id`) usada por `system_events`/`feedbacks` para amarrar um evento ao turno
exato sem duplicar o texto do usuário em outro lugar.

**system_events (novo — v22, MH-053)** — sinais automáticos que o sistema emite sobre si mesmo.
```sql
id, tipo (erro_tecnico/desvio_comportamental/intencao_nao_suportada), severidade (baixa/media/alta/critica),
user_id (FK → users, ON DELETE SET NULL), agent, origem (catch_global/classificador_central/juiz_offline/scheduler/outro),
agent_log_id (FK → agent_logs, ON DELETE SET NULL), titulo, payload (jsonb), fingerprint,
status_triagem (novo/lido/arquivado/virou_backlog), backlog_ref, revisado_at, created_at
```
⚠️ **Invariante de LGPD — `system_events.payload` NUNCA guarda texto cru do usuário.** O texto vive
só em `agent_logs` (que é `CASCADE` na exclusão de conta); `system_events` referencia por
`agent_log_id`. Quando o usuário é excluído, `agent_logs` some e `system_events` fica com `user_id`/
`agent_log_id` anulados (FK `SET NULL`) — anonimizado, sem precisar tocar em `delete_user_account`.
`titulo` deve ser um resumo ESTÁVEL/templatizado (nunca a mensagem dinâmica) — é o que o
`fingerprint` agrupa para distinguir erro transitório de persistente (consumido pelo MH-052).

**feedbacks (novo — v22, MH-053)** — sinais explícitos do usuário (elogio/crítica/sugestão),
ortogonais ao roteamento.
```sql
id, user_id (FK → users, ON DELETE SET NULL), categoria (elogio/critica/sugestao),
origem (espontaneo/proativo_adesao/proativo_outro), texto, agent_log_id (FK → agent_logs, ON DELETE SET NULL),
status_triagem (novo/lido/arquivado/virou_backlog), backlog_ref, revisado_at, created_at
```
⚠️ Ao contrário de `system_events`, aqui o `texto` do usuário é guardado DE PROPÓSITO — é o
aprendizado de produto que deve sobreviver à exclusão de conta (anonimizado por `user_id` → NULL).

Ponto único de escrita das duas tabelas: `src/observabilidade.js` (`registrarEvento`/
`registrarFeedback`) — nunca insert direto em outro lugar (princípio 16). Ambas as funções são
defensivas (try/catch interno, nunca lançam — ver princípio 23).

**eventos_proativos (novo — v28, MH-70)** — registro **append-only** de mensagens que a Nami
enviou por iniciativa própria (`lembrete`, `follow_up`, `alerta_estoque_zerado`,
`alerta_estoque_nao_informado`, `resumo_semanal`). Escrita no **instante do envio**, ponto único
`registrarEventoProativo()` em `database.js`. Semanticamente distinta de `dose_logs` (estado
mutável da dose) e de `agent_logs` (registro de intenção, escrito antes do envio, princípio 24):
aqui cada envio gera uma linha própria que **nunca é sobrescrita**. Existe porque reconstruir
histórico a partir de `dose_logs` perdia os follow-ups intermediários. `user_id` e
`medication_id` com `ON DELETE CASCADE` (princípio 34).

**intencoes_nao_suportadas** — **descontinuada a partir da v22.** Mantida só como histórico (11
linhas, última escrita 10/07/2026); nenhum código novo escreve nela. O não-suportado agora vira
`system_events(tipo=intencao_nao_suportada)`. As 11 linhas antigas NÃO foram migradas de propósito
(são `CASCADE`/texto cru; migrar para uma tabela `SET NULL` faria o texto sobreviver à exclusão —
regressão de LGPD).

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

Esse ponteiro fixo foi removido em 08/07/2026: a tabela `backlog_items` (índice único parcial em
`(tipo, numero) WHERE status <> 'historico_substituido'`) já impede colisão de número
independentemente de qualquer texto aqui. Para saber o próximo número livre, consultar:

  SELECT tipo, MAX(numero) AS ultimo_usado
  FROM backlog_items
  WHERE status <> 'historico_substituido'
  GROUP BY tipo;

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

## Sessão v17 (08/07/2026) — BUG-035, BUG-057, MH-046, BUG-059

### BUG-035 — Fast-path de resposta tardia ao esgotamento nunca era alcançado

**Causa raiz confirmada:** `temDosePendente()` (`router.js`) excluía apenas os status
`pausado` e `nao_tomado`, mas não `nao_informado` — então uma dose já esgotada
(`nao_informado`) ainda satisfazia `temDosePendente()`, fazendo o roteador tratar um "Sim"
tardio como confirmação direta (`agentName = 'principal'`) em vez de cair no fast-path
dedicado (`tentarConfirmarRespostaTardia`, bloco 4b, que já existia e nunca era alcançado).
Dentro do `handlePrincipal`, o filtro de `dosesPendentes` já excluía `nao_informado`
corretamente — a divergência entre as duas definições de "dose pendente" era a causa raiz.
Confirmado com `agent_logs` reais de dois usuários (Guilherme/Cataflam, Ivete/Betaistina):
`agent: principal` no momento exato do "Sim" tardio, quando deveria ser
`fast_path_resposta_tardia`.

**Correção:** `temDosePendente()` agora também exclui `nao_informado`. Afeta os 3 pontos que a
usam no `router.js` (idle, `aguardando_periodo_adesao`, `aguardando_escolha_tratamento`) — o
que é o comportamento desejado (ver MH-046 abaixo sobre o que isso NÃO resolve sozinho).

**Status:** corrigido, commitado e pushado, verificado direto no repositório. `em_validacao`
no backlog — falta um ciclo real de esgotamento em produção mostrando
`agent: fast_path_resposta_tardia` nos logs para fechar de vez.

### BUG-057 — Validado em produção e fechado

Os dois cenários de precedência (dose real chegando durante `aguardando_periodo_adesao` e
durante `aguardando_escolha_tratamento`) foram confirmados com `agent_logs`/`dose_logs` reais
de produção. **Status: resolvido.**

### MH-046 — Registrado, não implementado (monitoramento)

Estender `tentarConfirmarRespostaTardia` para dentro dos estados
`aguardando_periodo_adesao`/`aguardando_escolha_tratamento` resolveria o roteamento de um "Sim"
tardio nesses estados (hoje cai no classificador central e geralmente repete a pergunta de
período/tratamento — UX subótima, sem prejuízo de dado de saúde). Não implementado porque
`usuarioRespondeuDesde()` só verifica SE o usuário respondeu algo desde a última tentativa, não
SE o bot fez uma pergunta nova nesse meio-tempo. **Risco identificado, não observado em
produção ainda:** se o usuário entrar num desses estados de espera ANTES de uma dose (de outro
remédio) esgotar, e a primeira resposta dele depois for algo tipo "sim"/"ok" (que bate em
`detectarConfirmacaoDose`), o fast-path confirmaria a dose antiga silenciosamente e ignoraria a
pergunta de período/tratamento em aberto. Decisão explícita desta sessão: não implementar sem
evidência real desse cenário; monitorar via `agent_logs`.

### BUG-059 — Rótulo de dia incorreto ("ontem"/"hoje") em confirmações retroativas

**Causa raiz confirmada:** o Claude nunca recebia a data/hora atual como referência em nenhum
lugar do contexto (`prompts.js`/`principal.js`) — o único campo calculado deterministicamente
com essa natureza era "próxima dose (hoje|amanhã)". O `blocoRetroativo` entregava só a data
numérica (`dd/mm`) sem rótulo relativo, forçando o Claude a adivinhar em texto livre se uma
data era "hoje" ou "ontem" — e errava. Confirmado com dados reais de produção em dois usuários
(Guilherme: doses do mesmo dia da mensagem rotuladas "ontem"; Julia: dose do mesmo dia rotulada
"ontem", causando em cascata a frase "a dose de hoje está agendada para amanhã").

**Correção (dois níveis, mesma causa raiz):**
1. `calcularRotuloDia()` novo em `principal.js` — calcula hoje/ontem/anteontem
   deterministicamente (mesmo princípio já usado em `calcularProximaDose`), aplicado ao
   `blocoRetroativo`.
2. Âncora explícita `"Agora é [data], [hora] (horário de Brasília)"` adicionada ao início do
   `context` geral — rede de segurança sistêmica para qualquer outra menção livre a datas
   relativas que o Claude venha a fazer (inclusive ao ler o JSON bruto de `recentDoses`).

**Status:** corrigido, commitado e pushado, verificado direto no repositório. `em_validacao`
no backlog — falta testar em produção com uma dose de hoje e uma dose retroativa real de 1-2
dias antes de fechar.

---

## Sessão v18 (10/07/2026) — BUG-032/033, BUG-060, BUG-062/063/064, MH-047 registrado

Sessão iniciada com objetivo de planejar a expansão beta (100 usuários em 4 semanas). Ao mapear
riscos de abrir pra desconhecidos, a revisão de causa raiz revelou que o `configuracao.js` tinha
becos sem saída estruturais — a sessão virou uma blindagem completa desse agente antes de
qualquer trabalho de expansão. **O mecanismo de vagas/fila de espera e o aviso de beta continuam
não desenhados** — retomar antes de abrir a campanha pra desconhecidos.

### BUG-032 + BUG-033 — Encerramento/alteração de tratamento eram fluxos sem saída

**Causa raiz confirmada:** de 12 etapas no state machine do `configuracao.js`, apenas 3
(`confirm_acao`, `reativ_confirmar`, `pos_alteracao`) verificavam `isCancelamento()`. As outras 9
(incluindo `identif_intencao` reentrando com medicamento já resolvido) repetiam a mesma pergunta
indefinidamente se o usuário tentasse desistir com uma frase não reconhecida.

**Correção — modelo de 3 camadas, aplicado às 12 etapas:**
1. Parser determinístico da própria etapa (horário, medicamento, número, tipo de tratamento).
2. `isCancelamento()` (lista fixa, apertada — "para" solto removido, exige "para de/com"/"parar";
   vocabulário ampliado com deixa/sair/chega/não precisa mais).
3. Escalada: `handleConfiguracao` retorna `{ escalarParaRoteador: true }` em vez de mensagem de
   retry. `router.js` (`despacharEscalada`, novo) roda `classificarIntencaoComContexto` e decide
   o destino, preservando `medicationId`/`medicationNome`/`schedulesAtivos` quando o destino ainda
   é `configuracao` — nunca reinicia do zero.

**Enriquecimento complementar (mecanismo separado, serve mensagens futuras sem contexto vivo):**
`getHistoricoRecente()` agora seleciona `estado_conversa`/`contexto_conversa` de `agent_logs`;
`classificarIntencaoComContexto` usa isso pra resolver referências ("ele"/"aquele remédio") em
conversas que retomam um assunto depois de sair do fluxo.

**Status:** implementado e commitado (commit `479dcb1`). 31/31 testes automatizados (cenários
determinísticos) + validação manual real em produção confirmando escalada correta, retomada
preservando contexto, e resposta de "não suportado" gerada pelo LLM em vez de string fixa.
`em_validacao` no backlog — validação de ausência de vazamento de contexto entre conversas não
relacionadas (cenário 5) segue como monitoramento contínuo, não bloqueante.

### BUG-060 — `identif_medicamento` ignorava mudança de intenção quando o remédio era reconhecido

**Causa raiz confirmada:** a etapa só rodava `encontrarMedicamento(message, ...)` e, se
encontrasse o remédio, seguia cego com a `acao` que já estava fixada no contexto — "quero parar
o Neosaldina" (mudança de assunto) era tratado só como confirmação de qual remédio.

**Correção:** `sobrouConteudoAlemDoNome(message, medNome)` (reaproveita `normalizar()`, exportada
de `nlp_helpers.js`, mais remoção de pontuação local) detecta se sobra conteúdo além do nome do
remédio. Se sobrar, chama `processarIntencaoOuEscalar()` — o corpo de `identif_intencao` extraído
pra função reaproveitável — em vez de seguir com a ação antiga.

**Status:** implementado e commitado. Testes automatizados da função pura + validação manual real
em produção (cenários de reconhecimento comum, pontuação, cancelamento combinado, escalada pra
outro agente). `em_validacao` no backlog.

### BUG-062, BUG-063, BUG-064 — encontrados validando o BUG-060 em produção

Três problemas de interpretação de intenção, nenhum dead-end — descobertos cruzando testes reais
no WhatsApp com `agent_logs` e `console.log` do Railway (evidência direta, não inferência, no
caso do BUG-064).

- **BUG-062** — "parar [remédio]" lido como cancelamento genérico em vez de encerrar tratamento,
  porque `isCancelamento()` tem precedência cega mesmo quando um medicamento é citado junto.
  Correção: `isCancelamentoGenuino(message, medicationsAtivos)` — só aceita cancelamento puro
  quando nenhum medicamento é mencionado — aplicada em 8 pontos do arquivo (ver princípio 18).
- **BUG-063** — medicamento preservado no `context` vencia sobre um remédio citado explicitamente
  na mensagem atual (ex: usuário em fluxo do Cataflam diz "quero alterar dipirona" e a Nami
  continua no Cataflam). Correção: prioridade reordenada — texto atual > contexto > palpite do
  classificador (ver princípio 17). Validado com log real do Railway mostrando que o palpite do
  classificador não era alucinação, e sim reflexo de um assunto que já não era mais o atual.
- **BUG-064** — o classificador interno (`classificarIntencao`) não tem categoria pra "usuário
  recusou a lista de opções oferecida" (ex: "Nenhum" em resposta a "qual desses horários?"),
  então acaba reafirmando a ação em andamento e repetindo a pergunta. Correção: nova categoria
  `recusa_opcoes_oferecidas` no prompt (generalizada pra qualquer lista — medicamentos, horários,
  pausar/encerrar, contínuo/temporário), não uma palavra nova em `isCancelamento()` — decisão
  deliberada pra não repetir o antipadrão do BUG-030/036 (ver princípio 14).

**Status:** implementado e commitado. `em_validacao` no backlog — 17 cenários de teste específicos
preparados (`CENARIOS_TESTE_BUG062_063_064.md`, entregue mas não commitado no repositório),
aguardando execução em produção.

### MH-047 — Registrado, não implementado (tom/voz do `configuracao.js`)

Confirmado com `agent_logs` real: a mesma intenção do usuário gera texto com voz completamente
diferente dependendo de qual agente responde — `principal.js` tem instrução de persona
("linguagem simples, clara e carinhosa") em `prompts.js` e gera resposta via LLM;
`configuracao.js` responde com strings fixas escritas sem esse filtro (mais formal, menos
emoji, frases como "Qual medicamento você quer alterar o horário de?"). Decisão: reescrever as
strings manualmente (não passar a resposta final por uma camada de reescrita via LLM — isso
arriscaria alterar nome de remédio/horário/número no processo, o que fere os princípios 4/11 pra
mensagens que afirmam fato de saúde já executado). Não iniciado nesta sessão — próximo item da
fila.

### BUG-061 — Registrado, causa raiz NÃO investigada (hipótese em aberto)

Recadastro de medicamento após encerramento não avança depois da confirmação "Isso" — só
evidência de print de produção, sem `agent_logs`/código investigado ainda. Não tratar como causa
raiz confirmada até investigação própria.

---

## Sessão v19 (13/07/2026) — BUG-065, MH-049/050 registrados, higiene de nome de repositório

Sessão iniciada a partir de um print de produção: alerta de estoque pós-confirmação afirmando
"último comprimido"/estoque zerado quando o banco já mostrava 1 unidade real restante.

### BUG-065 — Alerta de estoque pós-confirmação afirma "zerado" quando ainda há unidades

**Causa raiz confirmada** (stock_movements, schedules, git blame — não hipótese): `diasRestantes
= Math.floor(estoque_atual / dosesPerDia)` é uma métrica de dias de cobertura, correta em si.
O bug estava em 3 funções de texto — `router.js` e `agentes/principal.js` (`buildAlertaEstoqueMessage`,
cópias idênticas) e `agentes/lembrete.js` (`buildAlertaEstoqueNaoInformadoMessage`, mesma lógica)
— que tratavam `diasRestantes === 0` como sinônimo de "estoque físico = 0". Isso só é verdade
quando `dosesPerDia === 1`; com `dosesPerDia >= 2`, o floor pode zerar com estoque real positivo
(reproduzido com Dipirona: 2x/dia, 1 unidade restante). As três cópias nasceram no mesmo commit
`f967a0c` (MH-026, 15/06) — antes de o projeto adotar o padrão de módulo de templates
compartilhado (que só surgiu na v15 com `adesaoTemplates.js`).

**Correção:** `classificarNivelEstoquePorDias` (`database.js`, nova) classifica em 3 níveis —
zerado (`novoEstoque <= 0`) / urgente (`diasRestantes === 0` mas `novoEstoque > 0`) / ok
(`diasRestantes >= 1`) — e `templates/estoqueTemplates.js` (novo módulo) constrói o texto de cada
um dos 3 call sites, substituindo as 3 cópias divergentes. Ver princípio 19 (novo).

**Status:** implementado, commitado, deployado em produção. `em_validacao` no backlog — aguardando
confirmação real via WhatsApp (idealmente com um medicamento `dosesPerDia >= 2` e estoque baixo).

### MH-049, MH-050 — Registrados durante a investigação, não implementados

- **MH-049:** `calcularAlertaEstoque` não trata `tipo_tratamento = 'temporario'` no limiar de
  alerta — cai no padrão de 5 dias (igual `continuo`), não no limiar apertado de 1 dia do `agudo`
  curto. Hipótese em aberto, não investigada — descoberta ao confirmar que o Dipirona do print
  tinha esse `tipo_tratamento`.
- **MH-050:** bloco "insuficiente" de `montarBlocoEstoque` (`adesaoTemplates.js`, relatório de
  progresso de tratamento) nunca exibe a quantidade real de estoque, só dias — fica com fraseado
  estranho quando `diasCobertos=0`. Relacionado ao mesmo tema do BUG-065, ponto de código
  diferente, registrado separado por disciplina de escopo.

**MH-029** (título antigo parecido, "Alerta de estoque incorreto para tratamento de tempo
determinado", sem causa_raiz preenchida desde a criação) permanece separado — decisão pendente
sobre se trata do mesmo tema; Guilherme optou por não fundir sem confirmação futura.

### Higiene de repositório (paralela, não fazia parte do briefing de bug)

`origin` git local ainda apontava pro nome antigo do repositório (`nami-backend`), gerando aviso
de redirect do GitHub em praticamente todo push desde a v13 (reforçado v17, nunca corrigido antes
de agora). Corrigido: `git remote set-url` + nome unificado em `package.json`/`package-lock.json`
(`nami_life`) e `.claude/launch.json` (`Nami_life`) + raiz da árvore em `CONTEXT.md`. Histórico em
`briefings/` mantido intocado de propósito.

### Avaliação do recurso de Preview do Claude Code Desktop (`.claude/launch.json`)

Guilherme perguntou sobre o potencial de usar esse recurso pra simular um "usuário de teste"
conversando com a Nami. Investigação em código (não documentação genérica) confirmou riscos reais
específicos deste projeto — ver nota operacional v19 na seção de Variáveis de Ambiente. Decisão:
não perseguir agora; `autoVerify: false` setado pra não subir o servidor local sem ação explícita.

## Sessão v20 (26/07/2026) — Validação de backlog em produção, MH-032 fechado, BUG-066 e MH-051 registrados

Sessão dedicada inteiramente a **validar em produção** itens que já estavam implementados e
aguardando confirmação (`em_validacao`) ou registrados sem investigação (`aberto`). Nenhuma
mudança de código nesta sessão — só leitura de `agent_logs`/`dose_logs`/`stock_movements` via
Supabase MCP, cruzada com commits reais do GitHub (para saber com precisão o que é "antes" e
"depois" de cada deploy) e, ao final, com o export do WhatsApp do próprio Guilherme.

### 9 bugs fechados com evidência real de produção

Todos confirmados com ocorrências reais **posteriores ao deploy de cada correção** (não apenas
"implementado e commitado"):

- **BUG-035** (fast-path de resposta tardia): `agent: fast_path_resposta_tardia` aparece
  repetidamente em `agent_logs` entre 11/07 e 25/07, múltiplos usuários.
- **BUG-059** (rótulo ontem/hoje/anteontem): rótulos corretos confirmados em várias conversas reais
  09/07–26/07, incluindo o cenário mais exigente (dois dias retroativos simultâneos, 13/07).
- **BUG-032 + BUG-033** (fluxos de encerramento/alteração sem saída): 4 conversas reais completas
  (23/07, 24/07) mostram saída limpa via "Não"/"Deixa pra lá"/"Não, era só aquele mesmo", sem loop.
- **BUG-060** (mudança de intenção com remédio reconhecido): comportamento geral do
  `configuracao.js` pós-deploy consistente, sem recorrência do padrão original.
- **BUG-062** ("parar remédio" ≠ cancelamento cego): confirmado 23/07 — "Parar com o Cataflam" abre
  pausar/encerrar corretamente; "Quero encerrar dipirona" vai direto à confirmação.
- **BUG-063** (medicamento do contexto vs. citado explicitamente): confirmado 26/07 — "Mudar
  horário do Cataflam" → "Na vdd quero alterar o dipirona" trocou corretamente para Dipirona.
- **BUG-064** (recusa de lista de opções, "Nenhum"): confirmadas as 3 variações do checklist em
  26/07 — lista de horários, pergunta pausar/encerrar, lista de medicamentos para encerrar.
- **BUG-065** (alerta "zerado" com estoque real positivo): confirmado com várias ocorrências reais
  13/07–25/07, sempre com contagem real exibida ("mais 1/2 unidade(s)") em cenário `dosesPerDia
  >= 2`, nunca mais "zerado" com estoque positivo.

### MH-032 — Lembretes agrupados por horário — fechado (escopo do lembrete inicial)

Validado com evidência real: Guilherme já tem, diariamente, Vitamina C + Dipirona no mesmo
horário (20:00) — cenário 1 do checklist original ocorrendo organicamente todo dia. Cruzando
`dose_logs`/`stock_movements` com o export do WhatsApp:

- **Lembrete inicial:** agrupado corretamente em todos os dias verificados (20, 21, 22, 23, 24,
  25/07) — uma única mensagem listando os medicamentos do horário, formato Variação C.
- **Follow-up agrupado:** comportamento **inconsistente** — agrupado em 21/07, 22/07, 24/07;
  quebrou em 2 mensagens separadas (2 minutos de diferença entre elas, exatamente 1 tick do cron)
  em 23/07 e 25/07. Vira o BUG-066 abaixo, separado por disciplina de escopo — MH-032 fecha só
  com o lembrete inicial validado.

### BUG-066 (novo, registrado nesta sessão) — Follow-up agrupado do MH-032 quebra intermitentemente

**Causa raiz:** hipótese fundamentada em código + padrão de horário observado, **não confirmada
100%** (faltam os valores exatos de `ultima_tentativa_at` nos logs do Railway para fechar com
certeza). `createDoseLog` e `updateDoseLogTentativa` (`database.js`) calculam `new
Date().toISOString()` independentemente a cada chamada, dentro de um loop sequencial que grava um
`dose_log`/atualização por dose do grupo — não existe um timestamp único compartilhado entre as
doses do mesmo grupo. O filtro de follow-up (`checkAndSendFollowUps`, `scheduler.js`) usa `>=`
rígido checado a cada 2 minutos (granularidade do cron `*/2 * * * *`). O drift de milissegundos
entre as doses do grupo pode ocasionalmente colocá-las em ticks de cron diferentes, quebrando o
agrupamento naquele ciclo — o que explica a intermitência (depende do alinhamento entre o instante
exato em que o limiar de tempo se completa e os ticks do cron, que varia dia a dia).

**Correção proposta (não implementada ainda):** gerar um único timestamp compartilhado no início
de `sendGroupedReminder`/`handleGroupedFollowUp` e passar esse mesmo valor para todas as
chamadas de `createDoseLog`/`updateDoseLogTentativa` do grupo, eliminando o drift na raiz (garantia
estrutural, não depende de sorte de alinhamento com o cron).

**Evidência:** `dose_logs.zapi_message_id` NULL (assinatura de agrupado) em 20/07, 21/07, 22/07,
24/07; preenchido com IDs reais distintos (assinatura de mensagens individuais) em 23/07 e 25/07.
Confirmado com o texto literal das mensagens no export do WhatsApp: follow-up agrupado ("Ainda não
vi sua confirmação dos remédios das 20:00: • Vitamina C • Dipirona") em 21/22/24; duas mensagens
individuais 2 minutos apartadas em 23/25. Estoque descartado como causa (`stock_movements`
confirma estoque confortável, 14-21 unidades, nos dias que quebraram).

**Status:** aberto, causa raiz em nível de hipótese fundamentada — não implementar sem confirmar
via logs do Railway (ou aceitar a hipótese e implementar a correção sistêmica proposta, que é
segura independentemente da causa exata, já que elimina a fonte do drift).

### MH-051 (novo, registrado nesta sessão) — Bot não reconhece pergunta de esclarecimento do
usuário quando nenhum medicamento foi identificado no fluxo de pausar/encerrar

Achado durante os testes do BUG-064 (26/07), fora do escopo dos cenários testados. Sequência
observada: "Parar lembrete" → bot pergunta pausar/encerrar sobre "esse medicamento" (nenhum remédio
identificado ainda) → usuário responde "Qual medicamento?" tentando esclarecer → bot não entende a
pergunta e repete a mesma pergunta de pausar/encerrar ("Parar" também repetiu). Só resolveu quando
o usuário disse "Encerrar" diretamente.

**Causa raiz:** hipótese, baseada em uma única ocorrência — não investigada a fundo. Quando a ação
já está clara mas nenhum medicamento foi citado nem está no contexto, o placeholder "esse
medicamento" fica sem referente e o classificador não reconhece uma pergunta de esclarecimento do
usuário como tal (é tratada como mais uma tentativa de responder à pergunta pausar/encerrar).

**Status:** registrado, não investigado, não implementado. Prioridade baixa — não trava nenhum
fluxo, só gera 2-3 mensagens repetidas até o usuário achar o caminho.

---

---

## Sessão v21 (26/07/2026) — MH-020: exclusão de conta (LGPD), implementada e validada em produção

Primeiro item crítico para a expansão beta. A Nami ganhou a capacidade de **excluir a conta do
usuário a pedido explícito dele**, exigida pela LGPD. O fluxo de recusa de LGPD durante o onboarding
(recepcionista) foi mantido **intacto** — o escopo foi apenas a exclusão solicitada por usuário já
onboarded. Briefings: `BRIEFING_MH020.md` (implementação) e `BRIEFING_MH020_FIX_DETECCAO.md` (correção).

### Arquitetura entregue
- **Função SQL atômica `delete_user_account(uuid)`** (migration `20260726000000_...`): apaga na ordem
  correta `stock_movements` → `adesao_estado` → `users`. Necessária porque essas duas tabelas têm FK
  `NO ACTION` e fariam um `DELETE FROM users` ingênuo **falhar** para qualquer usuário real. Transação
  tudo-ou-nada: se falhar, rollback e nada é apagado. Wrapper único `excluirContaUsuario` em `database.js`.
- **Detecção em 2 estágios** no fluxo: pré-filtro determinístico `pareceExclusaoConta` (nlp_helpers.js,
  ação + objeto de CONTA, disjunto dos objetos de configuração) + confirmação semântica via LLM em
  `agentes/exclusaoConta.js` (distingue exclusão de conta de "cancelar cadastro" de remédio, de excluir
  um remédio/lembrete, de negação e de perguntas sobre dados).
- **Novo estado `aguardando_confirmacao_exclusao`** + confirmação por palavra explícita (CONFIRMAR).
  Sucesso apaga e responde SEM nome (não conhecemos mais o usuário); erro técnico não apaga nada e
  direciona ao Guilherme.
- **Seção `DADOS E PRIVACIDADE (LGPD)`** no `NAMI_SYSTEM_PROMPT` — a Nami agora responde com clareza a
  perguntas sobre quais dados guarda, por quê, onde, e o direito de exclusão.

### ⚠️ Decisão arquitetural — redundância INTENCIONAL de detecção de exclusão de conta (NÃO remover)
A intenção de exclusão de conta é detectada por **dois caminhos que apontam para o MESMO handler**
(`handleExclusaoConta`), de propósito. **Isto não é duplicação acidental — é defesa em profundidade
para uma ação crítica e irreversível.** Os dois cobrem **alcances diferentes** e nenhum sozinho cobre
tudo:
1. **Portão early** (`pareceExclusaoConta` + `confirmarIntencaoExclusaoConta`), colocado ANTES de todos
   os branches de estado no `routeMessage`. Papel exclusivo: dar **precedência dentro de fluxos que
   NÃO passam pelo classificador central** — em especial `adding_med`/`cadastro`, que chama seu handler
   direto e não escala para o roteador como o `configuracao` faz. Sem ele, um "quero excluir minha
   conta" no meio de um cadastro seria engolido pelo agente do fluxo.
2. **Categoria `excluir_conta` no classificador central** (`classificarIntencaoComContexto`). Papel:
   detecção **robusta a typo/fraseado no caminho idle/geral e nas escaladas**. Sem ela, um typo em
   estado idle vaza para o `principal` — que foi exatamente a falha crítica corrigida na v21 (falsa
   confirmação de exclusão).

**Regra para quem mexer nisso no futuro:** NÃO "desduplicar" removendo um dos dois caminhos achando
que é redundância supérflua. Remover o portão early reabre a classe "pedido de exclusão engolido por
fluxo mid-flow"; remover a categoria do classificador reabre a classe "typo/fraseado vaza para o
principal e vira falsa exclusão". Se for consolidar, é obrigatório **preservar os dois alcances**
(mid-flow + idle/geral). Isto NÃO contradiz o princípio 1 (que condena remendar o mesmo caso duas
vezes): aqui são caminhos de código distintos protegendo alcances distintos de uma ação destrutiva.

### Falha crítica encontrada na 1ª validação e corrigida (BRIEFING_MH020_FIX_DETECCAO)
O 1º teste real expôs o **pior caso de LGPD**: com um typo ("descad**r**astar"), a mensagem escapou do
pré-filtro determinístico e caiu no `principal`, que — ensinado pela nova seção LGPD — **encenou** a
confirmação e **afirmou falso sucesso** ("sua conta foi excluída"), sem apagar nada. Duas causas raiz:
(1) a capacidade `exclusao_conta` **não estava no inventário** do `classificarIntencaoComContexto`
(violação do princípio 5 — corrigida registrando `excluir_conta` no classificador central e tratando o
retorno nos 4 pontos que o consomem: `despacharEscalada`, `aguardando_periodo_adesao`,
`aguardando_escolha_tratamento` e o `else` final); (2) o `principal` não tinha trava contra conduzir/
afirmar exclusão (violação dos princípios 11/13 — corrigida com regra absoluta no prompt). Terceira
melhoria (UX): no estado de confirmação, afirmativo ambíguo ("sim", "ok") **re-orienta** para escrever
CONFIRMAR em vez de cancelar silenciosamente.

### Validação end-to-end em produção (evidência real, não resumo do Claude Code)
Cruzando `agent_logs` + export do WhatsApp + estado do banco, pós-deploy da correção:
- Detecção robusta: "Quero me descadrastar" (o mesmo typo), "Quero sumir da Nami", "Não quero mais
  conta na Nami", "Encerra meu cadastro", "Quero que apague meu cadastro" → todos `agent: exclusao_conta`.
- Re-orientação: "Sim" no estado de confirmação → pediu CONFIRMAR, **sem apagar nem afirmar sucesso**.
- Não-regressão: "Excluir losartana" e "Apagar o lembrete das 8" → continuaram indo para `configuracao`.
- Exclusão real: baseline do usuário de teste (users 1, medications 1, schedules 2, dose_logs 2,
  **stock_movements 4**, agent_logs 76, conversation_state 1, **adesao_estado 1**, intencoes 1) →
  após CONFIRMAR, **todas as 10 tabelas zeraram**. Prova em produção de que a ordem da função atômica
  cobre `stock_movements` e `adesao_estado` (o achado crítico). Escopo cirúrgico confirmado: só o
  usuário-alvo caiu; "Teste 2" e o usuário do Guilherme intactos. "Olá" seguinte caiu no onboarding
  (recepcionista) como usuário novo — o "volte quando quiser" funcionando.

### Registrado para próxima sessão
- **MH-052** (monitoramento/alerta estruturado de erros técnicos): hoje erros só vão para `console.error`
  no Railway (reativo, sem alerta). Casos sensíveis como falha de exclusão deveriam gerar alerta proativo
  ao Guilherme e distinguir erro transitório de persistente. Prioridade média.

---

## Sessão v22 (27/07/2026) — MH-053: estrutura sistêmica de observabilidade

Motivação: com poucos usuários (família/conhecidos), Guilherme acompanha cada interação de perto.
Isso deixa de ser viável na expansão beta (~100 usuários desconhecidos). Objetivo: dar à Nami
mecanismos sistêmicos para capturar (a) falha técnica, (b) desvio comportamental, (c) feedback
explícito (elogio/crítica/sugestão) e (d) intenção não suportada — alimentando um dashboard futuro
(MH-9) e um alerta proativo (MH-52). Trabalho fundido às melhorias MH-48 e MH-52 já registradas.

### Diagnóstico que precedeu o desenho
Leitura de código (não de documentação) revelou três coisas: (1) `agent_logs` já é escrito no fim de
`routeMessage` para TODO turno concluído, de qualquer agente/estado — é sistêmico por acidente, mas
guarda transcrição, não telemetria de sucesso/falha; (2) `intencoes_nao_suportadas` só era escrita em
5 pontos (4 em `router.js`, 1 em `relatorios.js`) — `cadastro`, `recepcionista`, `configuracao` nunca
escreviam nela, e o resultado no banco era só 11 linhas, paradas desde 10/07; (3) os templates de
adesão (`adesaoTemplates.js`) já pedem sugestão explícita ao usuário num momento proativo, e a
resposta do usuário era descartada sem registro. Não havia nenhuma captura de feedback.

### Decisão central — backbone híbrido
Duas tabelas: `system_events` (sinais automáticos: erro/desvio/não-suportado) + `feedbacks` (sinais
do usuário: elogio/crítica/sugestão), cada uma com um envelope de triagem compartilhado
(`status_triagem`/`backlog_ref`) que conecta observação → item de backlog. Rejeitada a alternativa de
tabela especializada por sinal — reproduziria o mesmo mecanismo de apodrecimento que already matou
`intencoes_nao_suportadas` (cada capacidade nova = tabela+função+query novas, fácil de esquecer).

### Cobertura sem refatorar cada agente — a "viga" da sessão
Decisão explícita de NÃO adicionar escalada de observabilidade em cada agente (`cadastro` e
`recepcionista` continuam sem escalar — risco de regressão em agentes LLM-driven, e o padrão
"cada agente lembra de chamar" é a causa raiz do apodrecimento acima). Cobertura garantida por DUAS
camadas complementares, exaustivas por construção:
1. **Turno concluído** → tem linha em `agent_logs` (universal) → sinais semânticos extraídos
   PÓS-FATO, por leitura de `agent_logs` — cobre automaticamente todo agente presente e futuro, sem
   tocar em nenhum. Esta é a camada do juiz offline (MH-54, ainda não implementado).
2. **Turno que crasha** → a exceção sobe ANTES do log final, então não há linha em `agent_logs` —
   por isso capturado IN-LINE, no `catch` único de `agent.js`.
`{turnos concluídos} ∪ {turnos que crasham}` = todo turno, sem depender de nenhum agente cooperar.

⚠️ **Scheduler é entrypoint paralelo, fora do funil** — não passa por `agent.js`/`routeMessage`. Cada
função dele (`checkAndSendReminders`, `sendGroupedReminder` etc.) já tinha try/catch próprio;
recebeu hookup próprio de `registrarEvento(origem='scheduler')`. É onde a classe de erro do BUG-066
(follow-up agrupado) passa a ficar visível fora do Railway.

### LGPD — anonimização via FK, sem tocar em `delete_user_account`
`system_events.user_id` e `feedbacks.user_id` são `ON DELETE SET NULL` (verificado: `agent_logs.user_id`
já era `CASCADE`). Consequência: quando `delete_user_account` roda seu `DELETE FROM users`, as duas
tabelas novas se anonimizam sozinhas — **nenhuma linha nova na função da v21**, risco de regressão
próximo de zero. Invariante que sustenta isso: `system_events` nunca guarda texto cru (fica em
`agent_logs`, referenciado por `agent_log_id`); `feedbacks.texto` é guardado de propósito (aprendizado
que deve sobreviver, anonimizado). Teste de não-regressão rodado em produção: usuário de teste com 1
`feedbacks` + 1 `system_events` → exclusão não falhou, as duas linhas sobreviveram com `user_id = NULL`,
`agent_logs` do usuário zerou.

### Feedback como dimensão ORTOGONAL do classificador — não um novo agente
Cuidado explícito com o princípio 5: feedback não é destino de roteamento (uma mensagem pode pedir um
relatório E elogiar; um pedido de feature inexistente pode ser `nao_suportado` E `sugestao`). Tratar
feedback como novo valor de `agente` forçaria um falso ou/ou e perderia sinal. Solução: o classificador
central (`classificarIntencaoComContexto`) ganhou um TERCEIRO campo de retorno, `feedback`
(elogio/critica/sugestao/null), paralelo ao `agente` — que manteve seus 6 valores originais intactos
(zero mudança no roteamento). `max_tokens` subiu de 60 para 80 para acomodar o campo extra.

### Validado em produção (código real lido no GitHub após push, não resumo do Claude Code)
Migration aplicada (FKs confirmadas `SET NULL`); `src/observabilidade.js` criado como ponto único de
escrita, funções defensivas (nunca lançam — novo princípio 23); `agent.js` captura erro técnico no
catch global; `router.js` propaga `agent_log_id` e a dimensão de `feedback` por todos os 4 pontos que
chamam o classificador, inclusive `despacharEscalada`; `relatorios.js`, `scheduler.js` (6 pontos) e
`whatsapp.js` instrumentados. `node --check` OK nos 7 arquivos tocados.

⚠️ **Não testado ponta a ponta via WhatsApp/Z-API na implementação inicial** (ambiente de
implementação sem acesso ao webhook ao vivo) — por isso MH-053 ficou primeiro em `em_validacao`.

### Validação de ponta a ponta via WhatsApp (concluída no mesmo dia) — MH-053 → resolvido
Guilherme executou os 6 cenários diretos no WhatsApp e o chat de planejamento conferiu cada um
direto no Supabase: feedback `elogio`, `critica` e `sugestao` (3 mensagens, 3 linhas em
`feedbacks` com `origem='espontaneo'`); intenção não suportada (`system_events`); e o teste mais
importante — uma mensagem de coocorrência ("seria ótimo se vocês também registrassem minha
pressão") gerou **as duas linhas no mesmo segundo**, `system_events(intencao_nao_suportada)` **e**
`feedbacks(sugestao)`, confirmando que a dimensão ortogonal de feedback no classificador central
funciona como desenhado — sem regressão no roteamento normal (dose/estoque/pausar continuaram
indo para os agentes certos). MH-053 fechado como `resolvido`.

### Dois efeitos colaterais descobertos durante o teste (não são falhas do MH-053 em si)

**BUG-67 — JSON malformado vazava cru ao usuário no fluxo de estoque.** Em `principal.js`,
`callClaude()` tenta `JSON.parse` e um regex de fallback; quando os dois falham, uma rede de
segurança decidia se expunha o `rawText` cru **só pelo tamanho** (`10 < length < 500`). No cenário
real (`UPDATE_STOCK` sem quantidade informada), o Claude gerou exemplos com aspas retas não
escapadas dentro do JSON ("Comprei mais 30", "Tenho 20 no total", "Perdi 5"), quebrando a sintaxe;
o texto resultante (417 caracteres) caiu na faixa aceita e vazou o JSON inteiro (chaves, `newState`,
`context`, `actions`) como mensagem do WhatsApp. Confirmado que `cadastro.js` tem o mesmo padrão de
parse mas NUNCA expõe `rawText` — o risco era isolado em `principal.js`. Corrigido trocando o
critério de tamanho por critério de **forma**: texto que começa com `{` nunca é exposto cru,
independente do tamanho. Resolvido.

**BUG-68 — Nami mencionava "o sistema" como entidade separada dela mesma.** Ao responder a uma
crítica sobre a frequência de confirmações, a Nami ofereceu ajuda dizendo "...é só me dizer assim
que **o sistema** já entende!" — quebra de personagem (pra usuário não existe sistema, existe só a
Nami). Causa raiz confirmada: a justificativa de uma regra nova do prompt (adicionada nesta mesma
sessão, ver Opção A abaixo) usava linguagem de bastidor a poucas linhas do exemplo de resposta ao
usuário, e o modelo ecoou essa frase na saída real. Avaliação de risco feita com Guilherme antes de
corrigir: das 4 ocorrências de "o sistema" no prompt, só essa tinha causa raiz **confirmada**; as
outras 3 (handoff de exclusão de conta, handoff de cadastro, handoff de configuração) são
instruções antigas, já em produção há sessões, sem nenhum vazamento jamais observado — decisão
deliberada de NÃO mexer nelas (mesmo padrão de decisão do MH-046 na v17: não adicionar rigor a
risco hipotético sem evidência de produção). Correção aplicada: (1) nova regra absoluta permanente
no topo do prompt proibindo qualquer menção a "o sistema" como entidade separada da Nami, cobrindo
as 3 ocorrências antigas por regra geral; (2) reescrita pontual só da frase com causa confirmada.
Validado por teste real no WhatsApp — resposta correta, sem menção a "sistema", cancelamento
("Não precisa") funcionando normalmente. Resolvido.

### Achado sobre a "Opção A" (restrição de pergunta sim/não do principal, ver MH-057 abaixo)
Durante o mesmo teste, confirmou-se que o ajuste de prompt da Opção A (Nami nunca mais pergunta
"quer que eu faça isso?" para ações de outro agente, e em vez disso diz a frase exata que o
usuário pode enviar) funciona corretamente em produção — testado com "Pausar os lembretes do
omega 3" → fluxo de configuração conduzido normalmente até a confirmação.

### Registrado para próximas sessões (Guilherme quer retomar nesta ordem)
- **MH-54** — Juiz offline (LLM-as-judge): leitura pós-fato de `agent_logs` (em lote, fora do caminho
  quente) para detectar desvios comportamentais e não-suportados invisíveis às capturas in-line — ex:
  parser rejeitando resposta válida 3× seguidas, ou perda completa de contexto (\"seis\" no meio de um
  cadastro faz a Nami perguntar de novo o nome do medicamento). Evidenciado por uma conversa de teste
  real anexada nesta sessão. Design intencionalmente adiado para sessão dedicada — é peça estrutural
  (dá cobertura universal) e não deve ser apressado.
- **MH-55** — Captura proativa de feedback no relatório de adesão: os templates de adesão (linhas
  ~33/34 de `adesaoTemplates.js`) já pedem sugestão explícita e a resposta hoje é descartada. Exige
  um flag de "pergunta proativa em aberto" (scheduler grava, router lê) → tem implicação de
  comportamento de produto que Guilherme quer amadurecer antes de desenhar.
- **MH-56** — Melhorar UX dos fallbacks de erro técnico ("tive um probleminha") e de não-entendimento
  ("não entendi") — hoje fazem o usuário redigitar e a mensagem original se perde. Prioridade baixa
  agora, mas reavaliar quando o beta escalar (atrito pesa mais com usuários desconhecidos). Nota: a
  MH-053 já captura a mensagem que causou a falha no `catch` global — uma versão futura do fallback
  poderia reaproveitar esse texto em vez de pedir para redigitar.
- **MH-57** — Rastrear ofertas espontâneas do principal como estado (Opção B, complemento à Opção A
  já aplicada): hoje uma pergunta sim/não do principal não gera nenhum estado estruturado —
  `newState` continua `idle`, `context` continua `{}` — então uma resposta ambígua de 1 palavra
  ("quero", "sim") a uma pergunta feita pelo próprio bot não tem como ser interpretada corretamente
  por nenhum classificador downstream. Desenho provável: novo tipo de `context` (ex.
  `{ ofertaPendente: '...', medicationId }`) populado pelo principal quando oferece uma ação de
  outro agente, e checagem de precedência no router (mesmo padrão já usado para dose pendente/
  cancelamento). Maior complexidade — decisão de arquitetura para sessão dedicada.

---

## Sessão v23 (27/07/2026) — MH-055 fechado como `superseded` (sessão de decisão, sem código)

> Seção reconstruída na v26 a partir de `briefings/encerramento_v23_tarefas_claude_code.md`. Não
> foi escrita no encerramento da própria v23: o briefing delegou a atualização do CONTEXT.md a uma
> ação manual e não embutiu o bloco a ser colado.

Sessão **exclusivamente de decisão** — nenhuma linha de código, nenhum schema, nenhum template
alterado. Única escrita: fechar o MH-055 no backlog como `superseded`.

O MH-055 propunha captura proativa de feedback no relatório de adesão — flag no scheduler +
leitura no router para marcar respostas do usuário logo após o resumo de adesão com
`origem = 'proativo_adesao'`. A sessão concluiu que o item **não sobrevive como trabalho
independente**, por três razões apuradas com evidência no código:

1. **O MH-053 já cobre o essencial.** Se o usuário reage ao relatório com feedback real sobre a
   Nami (elogio/crítica/sugestão), o classificador central já capta isso no estado `idle`
   (`router.js` ~839-844 → `registrarFeedback(origem='espontaneo')`), independentemente de ter
   vindo após o relatório de adesão.
2. **Os templates de adesão foram escritos para ser calorosos, não para elicitar feedback.**
   Frases como "me conta se deu certo" e "me dá sua sugestão" (`templates/adesaoTemplates.js`) são
   tom de cuidado, não call-to-action. A premissa que justificava uma origem "proativa" não se
   sustenta diante do texto real dos templates.
3. **Não há casos mapeados** de reação a relatório de adesão. Construir o mecanismo agora seria
   resolver comportamento de usuário ainda não evidenciado — contra o princípio de esperar
   evidência de produção.

O único delta que o MH-055 traria era o **rótulo de origem** (`proativo_adesao` vs `espontaneo`), e
esse valor **já existe** no enum de `feedbacks.origem` (migration
`20260727000000_observabilidade.sql`: `CHECK (origem IN ('espontaneo','proativo_adesao','proativo_outro'))`).
O terreno para reabrir no futuro está pronto, sem retrabalho de schema.

O **resíduo genuíno** do MH-055 — respostas curtas/ambíguas que só fazem sentido dada a pergunta
específica de um template (ex.: usuário responde só "o horário" à pergunta binária do template
`abaixo_50` var. 3) — é **a mesma classe de problema do MH-057** (resposta ambígua de 1 palavra a
uma pergunta feita pelo próprio bot, sem estado que a sustente). O resíduo pertence ao MH-057, não
a um mecanismo próprio.

**Gancho de reabertura:** evidência de que usuários reagem a relatórios de adesão em volume **e** a
distinção de origem virar acionável → reconsiderar, provavelmente fundido ao MH-057.

**Lição de método desta sessão:** um item de backlog pode ser fechado por absorção, não só por
implementação. Fechar com o gancho de reabertura registrado preserva a opção sem carregar o item
na fila.

---

## Sessão v24 (28/07/2026) — MH-054: Juiz Offline (desenho e calibração)

> Seção reconstruída na v26 a partir de `briefings/encerramento_v24_juizoffline.md`. Não foi
> escrita no encerramento da própria v24: aquele briefing especificou cabeçalho, princípios 24-26 e
> a entrada de `juizOffline.js` na estrutura de arquivos, mas não pediu seção de sessão.

Sessão dedicada ao desenho e calibração do Juiz Offline. A rubrica foi **validada empiricamente
contra 8 episódios reais de `agent_logs` antes de qualquer linha de código ir para produção** —
8/8 em detecção, 8/8 em categoria, com convergência de fingerprint confirmada entre BUG-064 e
MH-051 (mesmo sintoma → mesma categoria). Sem migration: o `system_events` da v22 já tinha
`origem = 'juiz_offline'` e `tipo = 'desvio_comportamental'` no enum.

### As seis decisões de arquitetura

**1. A unidade de julgamento é o EPISÓDIO, não o turno.**
Um turno isolado quase nunca é avaliável — `"Sim"` → `"Dose confirmada"` está certo ou errado?
Impossível dizer sem o que veio antes. O defeito que motivou o MH-054 (o MH-051) só existe na
sequência: três respostas idênticas e o usuário perguntando "Qual medicamento?" sendo ignorado.
Nenhum turno isolado dali parece errado. `agent_logs` não tem noção de conversa — só linhas
soltas; o coletor precisa construí-la.

**2. Agrupamento por `user_id` + gap de 30 minutos — medido, não chutado.**
Distribuição real dos intervalos entre turnos consecutivos do mesmo usuário: **799 turnos com gap
≤5min contra apenas 71 na faixa inteira de 5-60min**. Vale largo e vazio, então qualquer corte
entre 15 e 30min dá o mesmo resultado. Escolhido 30min por segurança — juntar dois episódios por
engano é recuperável (o juiz percebe pelo texto); partir um episódio ao meio destrói a evidência.
O `PARTITION BY user_id` é **obrigatório**: já com 8 usuários ativos há 329 trocas de usuário na
sequência cronológica da tabela, 28 delas com menos de 5 minutos. Sem particionar, o episódio de um
usuário se mistura com o de outro e o juiz reporta "perda de contexto" em conversas que nunca
existiram. Com 100 usuários isso vira a regra.

**3. Nenhum pré-filtro heurístico — julgar todos os episódios.**
67% dos episódios têm 1 turno só (confirmações de dose), e a tentação é filtrá-los como "sem
interesse". Decisão explícita de **não** fazer isso: o BUG-067 aconteceu em turno único, e um
filtro por tamanho o teria escondido — exatamente a mesma classe de erro que causou o BUG-067
(decidir por forma superficial em vez de conteúdo). Volume atual ~8 episódios/dia; ~100/dia com o
beta cheio. Eficiência vem de processar em sequência com `sleep`, nunca de excluir.

**4. `agent_logs` registra a resposta PRETENDIDA, não a ENTREGUE.**
Descoberta desta sessão e a mais importante para o juiz — origem do princípio 24.
`logAgentInteraction` roda dentro de `routeMessage` (`router.js` ~897), **antes** de
`sendTextMessage` (`agent.js`:22). Caso real de 28/07 00:01: `agent_response` gravado como
`{"escalarParaRoteador":true}`, mas o usuário recebeu *"Desculpe, tive um probleminha aqui. Pode
repetir o que você disse?"* — o Z-API recusou o objeto com 400. Sem tratar isso, o juiz reportaria
"estrutura interna exposta ao usuário" em **todo turno com falha de envio**. Por isso o coletor
cruza com `system_events` (±60s) e injeta nota técnica explícita no episódio. Custou um diagnóstico
errado nesta sessão antes de ser descoberto.

**5. Taxonomia canônica de SINTOMA — o fingerprint usa categoria, não título.**
Na primeira calibração o juiz acertou 8/8 na detecção mas gerou **títulos livres divergentes para o
mesmo sintoma** ("Nami repete resposta anterior ignorando redirecionamento e desistência do
usuário" vs "Resposta idêntica repetida em turnos consecutivos sem tratar dúvida"). Fingerprints
diferentes ⇒ 40 ocorrências do mesmo defeito viram 40 casos solitários e o MH-052 nunca distingue
transitório de persistente. Causa raiz: pedir a um LLM identificador estável por texto livre não
funciona por construção (princípio 25). Correção: **detecção continua aberta e contextual** — é o
que faz o juiz acertar; a **etiquetagem** vira canônica, com o `titulo` persistido derivado por
tabela. Não é lista fixa de detecção, é lista de arquivamento do que já foi encontrado.
A taxonomia classifica **sintoma observável, nunca causa provável** (princípio 26): era tentador
criar categoria `referencia_vazia` para o placeholder do MH-051, mas isso é a causa — e o episódio
P1, que não tem placeholder, cairia noutra categoria, refragmentando o agrupamento.
**Precedência é obrigatória:** o episódio P4 exibe dois desvios simultâneos ("acesse o aplicativo" +
"no sistema"); sem regra de desempate a escolha vira sorteio e o fingerprint oscila. Ordem:
`informacao_saude_incorreta` > `conteudo_tecnico_exposto` > `capacidade_inexistente` >
`repeticao_sem_progresso` > `quebra_de_persona` > `pedido_nao_atendido` > `outro`.

**6. Severidade é derivada, nunca escolhida pelo juiz.**
Na primeira calibração o mesmo sintoma saiu `alta` num episódio e `media` noutro. Severidade passou
a vir da tabela `TAXONOMIA`, em código — o juiz não retorna esse campo.

### Enriquecimento determinístico do episódio

Duas notas técnicas, ambas em código:
- **Falha de entrega** — `system_events` com `tipo='erro_tecnico'` do mesmo `user_id` em ±60s de
  qualquer turno do episódio.
- **Lembrete proativo** — o `scheduler.js` **não escreve em `agent_logs`**, então mensagem proativa
  da Nami é invisível ali. Reconstruído de `dose_logs` (`reminder_sent_at`, `horario_agendado`)
  quando houver lembrete até 60min antes do primeiro turno. Sem isso, o caso mais frequente do
  sistema (`"Sim"` respondendo a um lembrete) parece mensagem sem contexto e vira falso positivo.

`agent_response` **nunca é truncado**: durante a calibração, ler o texto cortado em 130 caracteres
quase produziu um gabarito errado — o desvio do BUG-068 estava na última frase da mensagem.

### Invariante de LGPD do `payload`

O `payload` de `system_events` guarda **apenas dados estruturais**: `categoria`, `n_turnos`,
`agent_log_ids`. Nada de `titulo_descritivo`, nada de `evidencia`, nada de trecho de conversa —
esses campos do LLM podem conter texto literal do usuário, e o invariante da v22 é explícito:
`payload` nunca duplica texto cru fora de `agent_logs`. Isso não perde informação —
`agent_log_ids` recupera o texto íntegro por join na triagem. Os campos livres do LLM só vão para
`console.log`, nunca persistidos.

### Parse defensivo

Se `JSON.parse` falhar ou a `categoria` não estiver em `TAXONOMIA`, o julgamento é **descartado**
com `console.warn`. Nunca inserir evento com categoria inválida; nunca deixar texto cru virar
título. Decidir por FORMA, não por tamanho (lição do BUG-067).

### Cron e fuso — `timezone` explícito é obrigatório

O hook do juiz usa `cron.schedule('0 3 * * *', ..., { timezone: 'America/Sao_Paulo' })`. O
`timezone` declarado não é opcional: sem ele o `node-cron` usa o TZ do processo, que no Railway não
é garantido ser `America/Sao_Paulo`.

⚠️ **Discrepância pré-existente registrada nesta sessão, não corrigida (fora do escopo do
MH-054):** o job de resumo semanal usa `cron.schedule('0 16 * * 0', ...)` **sem `timezone`**, com
comentário dizendo "horário de Brasília". Se o processo roda em UTC, dispara às **13:00 BRT**, não
16:00 — e este arquivo afirma "domingo 16h" na descrição do `scheduler.js`. A verificar nos logs do
Railway (procurar `📊 Enviando resumos semanais...` num domingo e conferir a hora) antes de
alterar. Ainda em aberto na v26.

> **Corrigido na v27:** a afirmação acima está superada. O código tem `{ timezone:
> 'America/Sao_Paulo' }` (`scheduler.js:45`) e o dado de produção confirma o disparo correto:
> `adesao_estado.updated_at` das 6 linhas em 26/07 19:00 UTC = **16:00 BRT**. Se o processo
> rodasse em UTC sem timezone, teria disparado 13:00 BRT. Pendência fechada por evidência.

### BUG-069 — registrado com causa raiz confirmada, correção NÃO implementada

Em escalada dupla (usuário em `configurando` → `configuracao` escala → `despacharEscalada` →
classificador devolve `configuracao` → reentra em `handleConfiguracao` → agente escala de novo), o
objeto `{ escalarParaRoteador: true }` cai direto em `response` sem interceptação.
`logAgentInteraction` grava o objeto serializado em `agent_response` e `sendTextMessage` recebe
objeto onde espera string → Z-API 400 → catch global. O usuário **não** vê conteúdo interno (recebe
a mensagem de erro educada), mas perde o turno e precisa repetir. Ocorrência real: 28/07/2026
00:01 UTC, `agent_log e9cbd89b`, `system_events` 00:01:14 e 00:01:15.

**Causa raiz (leitura de código, não hipótese):** `router.js` L369, dentro de `despacharEscalada`,
é a **única das seis** chamadas a `handleConfiguracao` que atribui o retorno direto a `response`
sem checar `escalarParaRoteador`. As outras cinco (L599→603, L684→688, L722→726, L743→747,
L863→867) usam a variável intermediária `resultadoConfig` justamente para poder checar antes.

**Decisão de escopo em aberto** — duas opções na mesa:
(a) corrigir pontualmente a L369;
(b) barreira sistêmica no ponto de envio que rejeite qualquer `response` que não seja string,
transformando a classe inteira em defeito impossível.
BUG-067 (27/07) e BUG-069 (28/07) são a mesma classe — "estrutura de controle interna alcança o
ponto de saída" — em arquivos diferentes e por causas diferentes, o que sugere (b). Decisão de
Guilherme, ainda pendente na v26.

### Observação para verificação futura (não é item de backlog)

A ocorrência de "o sistema" em `agent_logs` de **27/07 22:55** (`687cf572`, mensagem termina com
*"é só me dizer assim que o sistema já entende!"*) é **posterior ao fechamento do BUG-068 no mesmo
dia**. Pode ser anterior ao deploy do fix ou reincidência genuína — não dá para distinguir sem o
horário exato do deploy no Railway. Não registrado como bug novo por falta de evidência
conclusiva. **Gatilho:** se o Juiz Offline emitir `quebra_de_persona` em episódio posterior a
28/07, é reincidência confirmada e aí vira item.

---

## Sessão v25 (29/07/2026) — MH-058 (telemetria do Juiz Offline) + redesenho do fluxo de relatórios

Sessão longa, com 4 briefings encadeados. Dois deles corrigiram regressões introduzidas pelos
briefings anteriores da MESMA sessão — registrado aqui na íntegra porque as duas causas são
lições reutilizáveis, não acidentes.

### MH-058 — Telemetria de execução do Juiz Offline

Problema: o Juiz Offline (MH-054, v24) só deixa rastro quando ENCONTRA desvio. Um dia sem desvios
— o caso comum — é indistinguível de "o cron nunca rodou".

Tabela nova `juiz_offline_execucoes` (append-only, um insert por invocação): `data_avaliada`
(dia avaliado, não data de execução), contadores brutos, `status`
(`sucesso`/`falha_parcial`/`falha_total`) e `erro_resumo`. Escrita por ponto único
(`registrarExecucaoJuizOffline` em `observabilidade.js`).

Decisões de desenho:
- **Contadores incrementados dentro do loop**, nunca calculados no fim — é isso que permite
  distinguir `falha_parcial` (exceção no meio, sobrou episódio nunca tentado) de `sucesso`.
- **`turnos_totais`/`episodios_totais` ficam NULL** quando a coleta falha antes de rodar — é o
  sinal de `falha_total`.
- **Percentuais NÃO são colunas** — calculados na leitura, a partir dos brutos. Guardar derivada
  junto do bruto cria dois lugares para a mesma informação divergir (princípio 19).
- **Tabela separada de `system_events` de propósito**: `system_events` guarda sinal que precisa de
  triagem; telemetria de execução é prova de vida operacional que ninguém tria. Um `tipo` novo
  dentro de `system_events` poluiria a fila de triagem com uma linha por dia.
- **Escopo restrito de `episodios_pulados_idempotencia`**: conta só episódios que já geraram
  `system_events` de desvio em execução anterior. Episódios julgados e LIMPOS não deixam rastro
  hoje, então são reavaliados a cada nova execução do mesmo dia — esperado, não bug.
- **Cenário "o cron nunca rodou" não é coberto pela tabela** (um heartbeat escrito pelo próprio
  processo não prova a própria ausência). Decisão: query manual / futuro item do dashboard (MH-9),
  sem monitor externo por ora.

### Redesenho do fluxo de relatórios — diagnóstico

O gatilho foi o BUG-058 (estoque não filtrava por medicamento nomeado), aberto desde a v15 sem
investigação. A causa raiz revelou algo maior:

- `relatorioEstoque` **nunca** recebeu `message` — desde o commit `d7fc32d` que o criou. Não era
  regressão. Funcionava antes da v15 porque a pergunta VAZAVA para o `principal`, que respondia
  bem por acaso. A v15 corrigiu esse vazamento (BUG-055) e expôs a lacuna real.
- **Lição transversal:** um comportamento que "funcionava" pode estar apoiado em outro defeito.
  Consertar o defeito revela a lacuna — e isso não é regressão, é dívida aparecendo.

Investigando os outros subtipos com dados reais de produção, apareceram 4 causas raiz:

1. **`getDosesHoje` filtrava por `taken_at`, não por `scheduled_at`.** Evidência: às 10:26 BRT o
   relatório "de hoje" mostrou 6 doses, das quais **5 eram de ontem**, confirmadas retroativamente
   naquela manhã. O CONTEXT.md já documentava a regra correta desde a v15 — mas aplicada só a
   `calcularAdesao`. Mesma classe do BUG-035 (duas definições divergentes convivendo).
2. **O bloco `pendentes` não consultava `dose_logs`** — derivado de `medications`+`schedules`, com
   `schedules[0]` só, e suprimido inteiro se houvesse qualquer dose confirmada no dia. Não
   conseguia representar `nao_tomado`/`nao_informado`/`sem_estoque`.
3. **Lacuna de inventário**: não existia "status das doses de um dia específico". `tomei_hoje` era
   fixo em hoje; `adesao` fixo em agregado 7/15/30. Perguntas equivalentes caíram em 3 destinos
   diferentes — o classificador arredondava para a categoria existente mais próxima.
4. **Não existia canal de parâmetros**: `handleRelatorios` recebia `subtipo` como string nua, então
   "dipirona" ou "ontem" morriam na fronteira do roteador. Generalização do BUG-058.

### Redesenho — arquitetura entregue

Três peças separadas, cada uma fazendo o que sabe fazer:

1. **Entender o pedido (LLM)** — o classificador central passa a devolver
   `params: {medicamento, expressaoData}` como campo paralelo (princípio 22). Devolve a
   EXPRESSÃO, nunca a data calculada.
2. **Buscar os fatos (código)** — `getDosesDoDia(userId, dataISO, medicationId?)` filtra por
   `scheduled_at`, sem janela de 3 dias e sem corte de registros, para qualquer data.
3. **Escrever (LLM, com moldura)** — `gerarMoldura` devolve só `{abertura, fechamento}`; o bloco
   factual é renderizado em código e inserido literalmente entre os dois.

Complementos:
- `detectarConfirmacaoDose` reescrita (pré-requisito): termos fracos removidos, word boundary via
  `contemPalavraLivre`, guarda de interrogativa (pontuação **e** abertura interrogativa).
- `despacharRelatorio` — ponto único, substituiu **8** call sites de `handleRelatorios`.
- Regra de janela: ≤2 dias oferece confirmação retroativa; acima disso é leitura pura.
- Data resolvida afirmada direto na resposta, **sem estado conversacional novo** — a correção do
  usuário ("não, o outro domingo, 19") chega em `idle` e é reclassificada com histórico. Menos
  superfície de beco sem saída.

### Medição que fundamentou a limpeza de `detectarConfirmacaoDose`

Contra TODO o histórico de `agent_logs`: os termos `tá`, `foi`, `pode`, `ok`, `claro` e `feito`
tiveram **zero ocorrências** em confirmações reais — só geravam falso positivo (`'tá'` casava
dentro de "está", fazendo "como está meu estoque" ser lido como confirmação de dose). Removidos
com base em dado, não em palpite. Se o usuário responder com uma dessas palavras, a mensagem cai
no classificador e chega ao `principal`, cujo system prompt já trata todas elas como CONFIRM_DOSE
— custa uma chamada de LLM a mais, não perde a confirmação.

Residuais aceitos e documentados: `"Simsim"` deixa de casar no fast-path (o classificador resolve);
`"tomei X hoje"` sem "?" e sem abertura interrogativa continua ambíguo — é estruturalmente idêntico
a uma declaração real ("Tomei de hoje e de ontem" é confirmação verdadeira do histórico).

### As DUAS regressões próprias — causas e lições

**C-3 — `JSON.parse` do classificador sem remover cercas markdown.** Ao acrescentar `params`, o
JSON ficou mais longo e o modelo passou a devolvê-lo como bloco de código. O parse falhava e caía
no `fallback` = `principal`. Medição: **0 falhas em 19 chamadas antes / 5 em 17 (29%) depois**.
A proteção já existia no projeto (`parseJulgamento` em `juizOffline.js`) e foi até replicada em
`gerarMoldura` no mesmo briefing — mas não no classificador, que era o ponto alterado.
Consequência: o `principal` respondia com contexto truncado e **afirmou fato falso sobre saúde**
("Vitamina C e Cataflam não tinham doses agendadas para ontem" — tinham) e alucinou um contato
telefônico. Origem do princípio 27.

**C-1 — contradição entre duas seções do próprio briefing.** A seção 2.2 acrescentou frases com
data à Camada 1 (`'faltou algum remédio'`); a seção 2.4 estabelecia que a Camada 1 passa `params`
vazio. Resultado: as frases que carregam data eram exatamente as que perdiam a data.
Correção **sistêmica**, não reversão: `extrairExpressaoData` passa a extrair a data do TEXTO
deterministicamente, com o `params` do classificador como fallback (princípio 17). A Camada 1
volta a ser atalho inofensivo e o fluxo deixa de ter ponto único de falha para a data.

### Achados residuais da validação (N-1 a N-4, A-1 a A-4)

- **`dose_logs` só nasce quando o scheduler envia o lembrete** (~2 min antes do horário). Doses
  futuras do dia não existem no banco — "tomei dipirona hoje?" às 14:20 respondia "não encontrei
  nenhuma dose" com as doses das 16:00 e 20:00 por vir. Correção: complementar **só o dia de hoje**
  com horários sem linha (status sintético `agendado`). Dias passados não podem ser reconstruídos
  com segurança porque os `schedules` podem ter mudado.
- **O status `pendente` significa "lembrete enviado, aguardando resposta"**, não "dose futura" — o
  texto inicial dizia "ainda não chegou o horário", afirmação falsa. Três estados distintos hoje:
  `confirmado` / `aguardando sua confirmação` / `ainda não chegou o horário`.
- **`proximo_remedio` contradizia o `balanco_do_dia`** sobre o mesmo dado: dose confirmada era
  anunciada como "está na hora de tomar". Três causas: a linha "agora" ignorava `confirmado`; a
  confirmação era resolvida por MEDICAMENTO e não por dose/horário; e a função ainda consumia
  `getDosesHoje` (o `taken_at`). Correção sistêmica: `getProximosMedicamentos` passa a consumir
  `getDosesDoDia`, casando por `medicationId + horario` — os dois relatórios passam a ler a mesma
  fonte, eliminando a possibilidade de divergirem.
- **A data resolvida não chegava ao usuário**: o LLM parafraseava "quarta-feira (15/07)" como
  "desta quarta-feira" e a data desaparecia. Como o bloco factual só tem horários, a data não
  existia em lugar nenhum. Origem do princípio 28 (corolário).
- **Precedência invertida em `extrairExpressaoData`**: "o outro domingo, 19" resolvia para o
  domingo mais recente, porque número solto só era aceito com prefixo "dia" e o dia da semana
  vencia apesar de ser menos específico. Corrigido aceitando número **adjacente** ao dia da semana
  — a proteção contra "tomei 2 comprimidos" continua valendo.
- Ordenação: estoque por **unidades crescente** (com desempate por nome para estabilidade) — o que
  está acabando aparece primeiro. Aproximação consciente até o MH-60 (dias de cobertura).
  `meus_remedios` em ordem alfabética, feita **localmente** no handler porque
  `getUserMedications` tem 7 consumidores.

### Descoberta sobre o alcance da observabilidade (origem do princípio 29)

A falha de parse do C-3 rodou por horas em produção **sem gerar nenhum `system_events`**. Motivo:
não era exceção — era um `catch` local que devolvia fallback. Do ponto de vista do `catch_global`
do `agent.js`, nada deu errado: a mensagem foi roteada e respondida. O Juiz Offline também não
pegou, porque `agent_logs` registrava `principal` respondendo coerentemente.

Mapeamento dos 15 pontos de `registrarEvento` no código: **um único é genérico** (o `catch_global`);
os outros 14 são instrumentações manuais. Conclusão registrada: **a observabilidade é opt-in, não
orgânica.** Uma peça nova herda só `agent_logs` (se passar pelo `routeMessage`), o `catch_global`
(só exceção não tratada) e o Juiz Offline. NÃO herda registro de degradação silenciosa nem de
exceção capturada localmente — e nada, se rodar fora do `routeMessage` (foi por isso que o
`scheduler.js` precisou de 6 instrumentações manuais, e o `enviarResumoSemanal` até hoje não gera
`agent_logs`).

### Validação em produção

Todos os cenários validados no mesmo dia, com evidência cruzada de `agent_logs`, `dose_logs` e
logs do Railway. Destaques:
- 0 falhas de parse em 11 classificações (era 29%)
- `proximo_remedio` e `balanco_do_dia` consultados com 33s de diferença concordaram sobre o status
  de todas as doses; resolução por dose confirmada (Dipirona 16:00 não contaminou a das 20:00)
- data resolvida correta nos 4 formatos: `quarta-feira (15/07)`, `ontem (28/07)`,
  `domingo (26/07)`, `domingo (19/07)`
- mensagens interceptadas pela Camada 1 (sem `params`) resolveram a data corretamente via extração
  determinística — prova de que o ponto único de falha foi eliminado

---

## Sessão v26 (30/07/2026) — Captação de erros: degradar(), robustez do juiz, fingerprint estável

Sessão temática: preparar a camada de captação para o beta. O critério que orientou tudo:
**falso positivo é barato, falso negativo é caro** — o juiz deve capturar demais e a triagem
descarta. Decisão explícita de Guilherme, registrada para não ser desfeita por engano depois.

### O número que motivou a sessão

Query de sombra contra todo o histórico de `agent_logs` (assinaturas literais dos fallbacks
conhecidos × `system_events` em ±60s): **5 degradações conhecidas desde 15/06/2026, 5 de 5 sem
nenhum evento correspondente.** No dia 29/07 — 96 turnos, duas regressões próprias, 29% das
classificações descartadas, uma afirmação falsa sobre saúde ao usuário — `system_events` registrou
**zero** linhas.

### Correção de documentação: seções v23 e v24 reconstruídas

O `CONTEXT.md` saltava de v22 para v25. O conteúdo nunca se perdeu (estava íntegro em
`briefings/`), mas por duas causas distintas nunca chegou ao arquivo:
- **v23:** o briefing delegou a atualização a uma ação manual (*"atualizado manualmente por
  Guilherme (copiar/colar)"*) e **não embutiu o bloco a colar**. Falhou por construção.
- **v24:** o briefing especificou cabeçalho, princípios 24-26 e estrutura de arquivos, mas **não
  pediu seção de sessão**. O Claude Code executou corretamente; o briefing é que estava incompleto.

Padrão comum: **a seção de sessão não é herdada do ritual — ela existe só quando o briefing a
escreve.** Mesma forma dos princípios 29 e 30, aplicada ao processo. Os itens 4-6 do ritual de
encerramento existem para tornar isso verificável em vez de confiável.

### Juiz Offline — a telemetria provou o próprio valor na primeira execução

Primeira linha de `juiz_offline_execucoes` (30/07 06:00 UTC): 96 turnos, 11 episódios,
**3 avaliados**, `status` `falha_parcial`, `erro_resumo` com uma 500 da API. Cobertura real:
**3,1%**. O stack trace capturado em `system_events` deu a causa: o `try` de `executarJuizOffline`
envolvia **o loop inteiro** — uma exceção em qualquer episódio abortava a varredura.
`episodios_falha_julgamento = 0` provava que a exceção escapou sem ser contabilizada.

Sem o MH-058, esse dia teria parecido "o juiz rodou e não achou nada".

Correções: `try/catch` por episódio, retry (3 tentativas, backoff 1s/4s, sem retry em 4xx exceto
429), evento por episódio perdido.

⚠️ **Armadilha tratada explicitamente:** com o isolamento, o loop passa a TERMINAR mesmo com
falhas, e a linha final gravaria `status: 'sucesso'` numa varredura incompleta — o oposto do
propósito do MH-058. O `status` passou a ser **derivado** de `episodios_falha_julgamento`.

### `temperature: 0` no juiz

Diagnóstico do falso positivo rodou o **mesmo episódio, mesmo prompt, mesma nota, 3 vezes**:
vereditos `false`, `true`, `false` — e quando deu `true`, com categoria diferente da do incidente
real. Nenhuma chamada de LLM do projeto definia `temperature`; todas herdavam o default (1), por
omissão, não por decisão.

Por que importa: cada episódio é julgado **uma única vez** (idempotência por `agent_log_id`). Com
sorteio, um desvio real pode cair no lado `false` na única chance que teve e sumir sem rastro de
que foi avaliado. E instrumento que varia não pode ser calibrado — o 8/8 da v24 é amostra de uma
execução.

Alterado **só no juiz**: caminho isolado, sem impacto no usuário. As outras 5 chamadas continuam no
default (MH-066). `gerarMoldura` **deve** manter variedade — ela redige, e é proibida de citar dado
factual.

### Fingerprint estável — o contrato que dois produtores violavam

`fingerprint = sha1(tipo|titulo|agent)`, e o comentário do próprio `observabilidade.js:16` define:
*"titulo: resumo ESTÁVEL/templatizado — NUNCA a mensagem crua"*. Auditoria do projeto inteiro
encontrou **8 pontos** violando: `juizOffline.js` (título carregava o `request_id` da API),
`agent.js`, e **6 em `scheduler.js`** — estes últimos não estavam no briefing original e foram
encontrados pelo próprio comando de verificação do checklist.

Solução: `tituloEstavel(error, prefixo)` em `observabilidade.js`, que deriva uma **classe** do erro
(`APIError 500`, `AxiosError 400`) em vez de zerar o conteúdo. Nem cru nem genérico demais — título
totalmente genérico colapsaria toda exceção global num balde só.

Nos 6 pontos do `scheduler.js` o prefixo é **por função** (`Erro no scheduler (sendReminder)`),
senão falha de lembrete e falha de resumo semanal cairiam no mesmo fingerprint.

**Lição de processo:** o critério de conclusão deve ser um comando que varre o projeto, nunca a
lista de pontos que o autor do briefing conseguiu enumerar. Foi o `grep` do checklist que pegou a
omissão do autor.

### `status_triagem = 'nao_valida'`

Decorre do critério da sessão: capturar demais só funciona se existir o gesto de descartar, e
`arquivado` confundia *"vi, não era nada"* com *"é real, adiado"*. Sem a distinção, o dash não
consegue medir a taxa de falso positivo do juiz. Migration aplicada em `system_events` e
`feedbacks`.

### Barreira de forma no envio — instrumentação sem correção

`sendTextMessage` passa a rejeitar `message` não-string, registrando a **forma** (tipo do valor e,
se objeto, os nomes das chaves — nunca o conteúdo) antes de lançar.

**Não muda nada para o usuário:** hoje o objeto já produz 400 na Z-API → throw → catch global →
mensagem educada. Com a barreira, mesmo desfecho, mas o evento diz o que vazou em vez de
`AxiosError 400` mudo. String vazia **não** é barrada — seria mudança de comportamento real, sem
evidência de que ocorra.

**Testada em produção** (30/07 18:46): bloqueou `{escalarParaRoteador: true}`, nada foi enviado,
evento gravado com `payload.forma = 'object:escalarParaRoteador'`. A linha foi marcada
`nao_valida` — primeira da base, e exatamente o caso de uso que justificou o valor.

### BUG-069 — decisão de NÃO corrigir, e por quê

O BUG-069 continua `aberto`. A correção da L473 do `router.js` foi escrita, revisada duas vezes e
**descartada**. O registro do porquê importa mais que a correção:

- Volume: **1 ocorrência em todo o histórico** (`agent_response LIKE '%escalarParaRoteador%'`).
- O fluxo de escalada do `configuracao` foi construído deliberadamente para resolver becos sem
  saída (usuário corrige o medicamento no meio do fluxo: *"não, é do cataflam"*). Mexer nele troca
  um erro raro por risco de regressão num fluxo conversacional cuidadoso.
- A barreira instrumenta a classe sem tocar em fluxo nenhum. **Gatilho de reavaliação:** o evento
  `Payload inválido em sendTextMessage` aparecer em produção.

**E o diagnóstico do BUG-069 estava incompleto.** A investigação da ocorrência real revelou que o
vazamento é o **último** elo de uma cadeia de seis, e a causa está a montante — ver MH-065.

### A cadeia real de 27/07 (origem do MH-065)

`agent_log e9cbd89b`, 27/07 21:01 BRT (= 28/07 00:01 UTC — a v26 registrou a data em UTC por
engano): `estado_conversa` **`idle`**, `contexto_conversa` `{}`, `user_message` **`"S"`**.

1. Lembrete proativo do Ômega 3 às 20:58, respondido com `"S"` às 21:01.
2. `detectarConfirmacaoDose("S")` devolve `false` — o ramo 12 do roteador (dose pendente) não
   dispara. **Isto não é defeito:** o caminho previsto é cair no classificador e chegar ao
   principal, cujo system prompt trata afirmação curta como CONFIRM_DOSE.
3. O classificador central vê o `historicoConversa` — e o lembrete **não existe em `agent_logs`**
   (o `scheduler.js` não escreve lá). O histórico visível era a conversa de configuração de 6
   minutos antes (pausar lembretes do Ômega 3). Roteou para `configuracao`.
4. `configuracao` não tem o que fazer com `"S"` → escala.
5. `despacharEscalada` refaz a mesma pergunta ao mesmo classificador, passando `currentState:
   'configurando'` **fixo** — informação falsa, o usuário estava em `idle`. Volta `configuracao`.
6. L473 não intercepta → objeto vaza → 400 → *"Desculpe, tive um probleminha"*.

Consequência: a dose não foi confirmada e o usuário recebeu follow-ups às 21:28 e 22:30 cobrando o
que já havia respondido.

**Contraprova que fecha o diagnóstico:** em 30/07 15:48 (`agent_log b3a73e23`) o mesmo `"S"`,
também em `idle`, foi roteado para `principal` e confirmou a dose corretamente — a diferença é que
o histórico recente não continha conversa de outro domínio. O defeito é **condicional ao histórico
enviesado**, o que explica 1 ocorrência em todo o período.

### MH-064 T1 — `degradar()`

Une "devolver fallback" e "registrar que degradou" numa expressão só. A regra não é que a função
seja dona do texto — é que **o valor de fallback só existe como retorno dela**. Quem quer o
fallback passa por quem registra. Mesma forma do princípio 30, aplicada à degradação.

Dois invariantes:
1. Todo caminho que entrega ao usuário um texto que não é a resposta pretendida registra evento.
2. Todo caminho que devolve **valor default assumido** no lugar de resultado real registra evento —
   decisão, classificação ou booleano. O mais perigoso dos dois: não deixa nem assinatura de texto
   para procurar depois.

Chave da tabela é `origem:motivo`, não só `motivo`: `parse_json_falhou` no `principal` (perde
confirmação de dose) e no `cadastro` (usuário repete uma etapa) não têm a mesma gravidade. Origem é
o local no código, fixo por call site — continua **derivada**, não escolhida no ponto de chamada.

5 pontos instrumentados: `principal.js:307` (parse), `cadastro.js:309` (parse),
`configuracao.js:106` (classificação cai no default), `exclusaoConta.js:61` (detecção assume NÃO —
LGPD), `exclusaoConta.js:186` (exclusão falhou — `critica`).

**`stop_reason` capturado nos dois pontos de parse.** O objeto `response` da API está no escopo, e
`stop_reason === 'max_tokens'` é **prova** de truncamento. Isso transforma a hipótese levantada na
v26 (falhas de parse causadas por truncamento) em medição: se vier `max_tokens`, a correção é o
limite de tokens; se vier `end_turn`, o problema é de formato e a correção é outra.

O caso com evidência: 29/07 10:09:43 (`agent_log 0af1a7bf`), usuário em `confirming` disse *"Ah
tomei ontem sim"* e recebeu o fallback. `action: null` + `newState: 'idle'` — a confirmação
retroativa foi descartada e o contexto pendente apagado. Ele refez na mão. Um idoso não refaz.

Em `principal.js` e `cadastro.js` o `user` não está no escopo de `callClaude()`; passa `userId:
null` sem alterar assinatura de função (o `agent_log_id` já seria nulo — a degradação ocorre antes
do `logAgentInteraction`, princípio 24). Correlação na triagem é por `user_id` + janela.

### Query pack de observabilidade

Entregue como insumo para o dash (sessão futura): 8 blocos — painel diário, fila de triagem,
agrupamento por fingerprint (transitório × rajada × persistente), desvios do juiz com o texto do
turno por join, prova de vida e cobertura, detecção de dia sem execução, **métrica de sombra**
(degradação conhecida × evento correspondente) e denominador de volume. Q3, Q5b e Q6b testadas
contra produção.

### Pendências de validação

O juiz só roda 31/07 03:00 BRT. Até lá, MH-058 e as correções do juiz permanecem `em_validacao`.
Critério: `episodios_avaliados + episodios_pulados_idempotencia = episodios_totais`, **ou**
`episodios_falha_julgamento > 0` com `status = 'falha_parcial'`. O que não pode acontecer é a soma
não fechar sem ninguém contabilizado — isso significaria caminho de saída silenciosa remanescente.

> **Fechada na v27:** execução de 31/07 03:00 BRT sobre os dados de 30/07 — 7 de 7 episódios
> avaliados, 0 falhas, `status: sucesso`. Critério `avaliados + pulados = totais` atendido.
> Cobertura 100% (era 3,1%).

## Sessão v27 (31/07/2026) — MH-065: contexto proativo para o classificador central

Sessão de uma frente só. O gatilho foi o diagnóstico da v26: o vazamento do BUG-069 era o
**último** elo de uma cadeia de seis, e a causa está a montante — o classificador central não
enxerga nada que a Nami envie por iniciativa própria.

### A medição que definiu o problema

`logAgentInteraction` tem 3 call sites, **todos no caminho reativo** (`router.js:569`,
`router.js:1040`, `agent.js:31`). Os 8 pontos de `sendTextMessage` fora desse caminho —
lembrete individual e agrupado, follow-up individual e agrupado, aviso de estoque zerado,
alerta pós-`nao_informado`, cuidador, resumo semanal — não escrevem em `agent_logs`.

Turnos de usuário que chegaram até 15 min depois de um `reminder_sent_at`, em todo o histórico
(05/06 → 30/07):

| Métrica | Valor |
|---|---|
| Turnos na janela | 294 |
| Turnos em que o lembrete era o turno real anterior (invisível ao classificador) | **169** |
| Destes, com histórico visível de outro assunto na última hora | **30** |
| Destes, mensagens curtas (≤4 caracteres) | 127 |

**Reenquadramento do BUG-069:** o "1 ocorrência em todo o histórico" registrado na v26 mediu o
*sintoma na ponta da cadeia* (o objeto vazando no envio). A *condição a montante* ocorre 169
vezes.

### Por que o dano é raro apesar da frequência

Dos 169 turnos, **158 foram para `principal`** — o destino correto. Duas camadas mascaram a
lacuna: o fast-path `detectarConfirmacaoDose` intercepta a maioria das confirmações curtas
antes do classificador, e `principal` é o fallback natural.

Dos 11 que não foram para `principal`, **10 eram roteamento correto** — mensagens
auto-suficientes (`"Qual meu estoque de dipirona?"`, `"Parar losartana"`, `"Quero cadastrar
dipirona"`). Princípio 17 em ação: o texto literal resolveu sozinho, o lembrete invisível não
fez falta.

Isso permitiu a formulação precisa da causa raiz:

> O histórico incompleto só causa dano quando a mensagem do usuário **não é auto-suficiente** —
> resposta curta ou anafórica cujo significado depende inteiramente do que a Nami acabou de
> dizer. Mensagens auto-suficientes atravessam a lacuna sem consequência.

### A decisão de arquitetura — e a opção descartada

**Descartada:** inserir os turnos proativos em `agent_logs`.

O motivo é **semântico, não de risco**. `agent_logs` registra a resposta PRETENDIDA
(princípio 24: `logAgentInteraction` roda antes de `sendTextMessage`). Já `dose_logs` é escrito
**depois** do envio em todos os pontos verificados (`scheduler.js:203/259/309/333`,
`lembrete.js:103`) — é **registro de entrega**. Inserir um fato de entrega numa tabela de
intenção teria forçado uma escolha entre duas semânticas erradas.

**Sinal de diagnóstico registrado:** a opção descartada exigia 5 adaptações — dois formatadores,
decisão sobre `contexto_conversa`, limite do histórico, valor do campo `agent`, ordem
log/envio. **A quantidade de adaptação necessária era o diagnóstico**: um dado que só entra numa
tabela mediante nulos e três decisões de semântica não pertence àquela tabela.

**Escolhida:** reconstruir o evento proativo a partir de `dose_logs` na leitura, como campo
paralelo ao `historicoConversa` (forma do princípio 22 — dimensão ortogonal não vira novo valor
do eixo existente). Nenhum consumidor de `agent_logs` muda.

### Regra de inclusão — estado, sequência e rede de segurança

```
(1) ESTADO — dose ainda aguardando resposta:
    reminder_sent = true, confirmed = false,
    status ∉ {pausado, nao_tomado, nao_informado, sem_estoque}

(2) SEQUÊNCIA — o evento é mais recente que o último turno registrado:
    instanteEvento > created_at do turno mais recente em historicoConversa

(3) REDE DE SEGURANÇA — scheduled_at dentro do dia de hoje (BRT)
```

**(1) é de estado, não de relógio** — e isso eliminou a única constante de tempo arbitrária do
desenho. A cadência de follow-up é 30min + 1h + 30min, e então `markAsNaoInformado`: o próprio
ciclo de vida da dose fecha a janela em ~2h. A condição é idêntica à de `temDosePendente`
(`router.js:48-54`), mantendo as duas leituras consistentes.

**(2) sozinha não basta.** Cenário: último `agent_log` na segunda, lembrete na terça sem
resposta, usuário escreve na sexta. O lembrete de terça É mais recente que segunda e passaria em
(2), sendo injetado como "turno imediatamente anterior".

**(3) existe porque (1) tem uma premissa.** Se o scheduler cair, uma dose fica `pendente`
indefinidamente e o estado não a fecha. Rede, não regra principal.

### O bloco não é predominante — decisão explícita

O modo de falha simétrico ao que estamos corrigindo: hoje o classificador é cego para o
proativo; um bloco predominante o cegaria para o reativo. Três decisões garantem o equilíbrio:

1. **Integração cronológica, não seção destacada.** O evento entra no fim da mesma linha do
   tempo do bloco `CONVERSA RECENTE` — por (2) ele é mais recente que os 3 turnos.
2. **Zero linguagem instrucional.** Nenhuma frase de precedência. A cronologia carrega a
   informação sozinha. O rótulo entre colchetes é descritivo, existe só para o LLM não ler a
   linha como turno de usuário (sem ele, a alternativa seria `Usuário: null`).
3. **Renderização condicional.** Sem evento proativo, o prompt fica **byte a byte idêntico** ao
   anterior — o que limita o raio de qualquer regressão aos casos-alvo.

**Divisão de trabalho preservada:** o classificador responde apenas *qual agente*. Quem decide
confirmação de dose é o `principal`, que já tem o bloco `DOSES AGUARDANDO CONFIRMAÇÃO` com
`[ref:]` e instrução de precedência. Duplicar essa regra no classificador criaria dois donos da
mesma decisão.

### Escopo de propagação — só o classificador

`principal.js:72` já chama `getRecentDoses(user.id, 3)` e monta o bloco de doses pendentes com
`doseLogId`. Ele **já tem** esse contexto, em formato mais forte que qualquer reconstrução. A
cegueira é exclusiva do roteador. `cadastro`, `configuracao` e `exclusaoConta` não precisam.

`despacharEscalada` recebe **obrigatoriamente** — é o passo 5 da cadeia do `"S"`; sem isso a
reclassificação repete a decisão cega e a cadeia continua inteira.

### Redundância intencional com o Juiz Offline — documentada, não unificada

`juizOffline.js:205-232` já faz uma reconstrução de lembrete a partir de `dose_logs`. A extração
de função compartilhada foi **deliberadamente adiada**: os contratos ainda diferem — o juiz
ancora num instante passado para julgar retrospectivamente, em batch; o classificador ancora no
agora para rotear, por mensagem. O princípio 30 trata de *mesmo contrato replicado*, e ainda não
é o caso.

**Gatilho de revisão (MH-067):** na próxima reavaliação do Juiz Offline, comparar as duas
implementações; se o contrato tiver convergido, unificar.

Efeito colateral positivo: a função nova segue a **regra padrão do projeto** (duas etapas com
`.in()`), sem herdar o `!inner` que hoje existe só no juiz.

### Lição de forma herdada do diagnóstico do juiz (H3)

O diagnóstico do falso positivo da v26 revelou que a `notaLembrete` do juiz — *"lembrete
automático de Elani"* — é **gramaticalmente ambígua** quando o nome do medicamento soa como nome
próprio: lê tanto como "lembrete do medicamento Elani" quanto como "lembrete [pertencente a]
Elani [pessoa]". O juiz resolveu para o lado errado e produziu um `informacao_saude_incorreta`
de severidade **crítica** — falso positivo.

**Nenhuma correção foi aplicada no juiz nesta sessão** (decisão de escopo). Mas o texto novo
nasceu sem o defeito: campos rotulados, sem genitivo solto.

```
[mensagem automática da Nami — sem resposta do usuário até aqui]
Nami: lembrete de dose — medicamento: Ômega 3 (dose das 20:00) — enviado 3 min atrás
```

Origem do princípio 32.

### Fora de cobertura, declarado

| Envio proativo | Registro | Coberto? |
|---|---|---|
| `lembrete.js:133` — alerta de estoque pós-`nao_informado` | nenhum | ❌ |
| `relatorios.js:665` — resumo semanal | só `adesao_estado.updated_at` | ❌ |
| `lembrete.js:76` — cuidador | `caregiver_notified` | ❌ (outro telefone, não é contexto do paciente) |

Exposição medida do resumo semanal: **1 turno de usuário** em todo o histórico dentro de 1h30
depois de um domingo 16:00 (28/06, `"Tomei"`, roteado corretamente). Lacuna conhecida, não
oculta.

### Decisão explícita: uma camada por vez

O sinal determinístico — passar `temDosePendente` ao classificador — ficou **fora** desta
rodada. Hoje esse fato só é consultado atrás de `detectarConfirmacaoDose(message) &&`
(`router.js:654/749/910/919`), ou seja, nunca é olhado quando o parser não reconhece a mensagem.
É provavelmente um sinal mais forte que a reconstrução do histórico.

Motivo do adiamento: empilhar as duas camadas de uma vez torna impossível saber qual funcionou.
O projeto já tem histórico de correção sistêmica boa sendo mascarada por camada extra. Medir
primeiro.

### Validação da v26 — fechada

O Juiz Offline rodou em 31/07 03:00 BRT sobre os dados de 30/07:
`turnos_totais 16 · episodios_totais 7 · episodios_avaliados 7 · pulados_idempotencia 0 ·
falha_julgamento 0 · status sucesso`.

Critério da v26 atendido: `avaliados + pulados = totais`. Cobertura **100%**, contra 3,1% na
execução anterior. As correções do juiz (try/catch por episódio, retry, `status` derivado de
`episodios_falha_julgamento`) e o MH-058 estão validados.

### Pendências de validação da v27

O MH-065 permanece `em_validacao`. Os testes exigem tráfego real e correm ao longo de 31/07:
cenário-alvo (reprodução do `"S"` com histórico enviesado), lembrete agrupado (20:00 —
Dipirona + Vitamina C), follow-up, os 10 casos nominais de não-regressão, e as condições de
exclusão — com destaque para a regra de sequência, cuja falha faria o bloco aparecer em todas as
mensagens seguintes do dia.

**Limite de observabilidade do teste:** o prompt do classificador não é logado em lugar nenhum.
Testar só por WhatsApp mostra o desfecho do roteamento, mas não distingue "bloco renderizado
certo" de "renderizado errado e o LLM acertou assim mesmo". `getContextoProativoRecente` é
exportada e pode ser inspecionada por script read-only; a renderização é função pura do objeto.

## Sessão v28 (01-05/08/2026) — Cadeia BUG-082→085 + MH-70/71: contexto proativo reestruturado

### Origem da sessão

Guilherme testou o MH-065 (v27) em produção e encontrou um cenário **pior que antes do fix**:
com um fluxo de configuração pendente (`Pausar Dipirona`, aberto há 2h30) e quatro mensagens
proativas da Nami no meio (lembrete + 2 follow-ups + alerta de estoque, todas sobre outro
medicamento), a mensagem `"Tomei o ômega 3"` — autossuficiente, inequívoca — foi **completamente
ignorada**: a Nami repetiu palavra por palavra a pergunta de confirmação de pausar.

Investigação separou dois problemas independentes, nenhum deles regressão do MH-065 (que não
tocou `configuracao.js`):

1. **Escalada ausente** em 3 das 12 etapas do state machine (BUG-082).
2. **Erro de modelagem** no contexto proativo: `getContextoProativoRecente` reconstruía a partir
   de `dose_logs`, tabela de estado **mutável** (MH-70/71).

### BUG-082 — escalada ausente em `confirm_acao`, `reativ_confirmar`, `pos_alteracao`

Na v18 (09/07), o modelo de 3 camadas (parser → `isCancelamentoGenuino` → `escalarParaRoteador`)
foi aplicado a 9 das 12 etapas. As 3 restantes ficaram de fora por já terem uma checagem de
`isCancelamento()` própria — mas essa checagem nunca cobriu conteúdo genuíno não reconhecido:

- `confirm_acao`: repetia a pergunta indefinidamente, nunca escalava.
- `reativ_confirmar`: não checava confirmação nenhuma — qualquer coisa que não fosse cancelamento
  virava "sim" implícito e o fluxo avançava sozinho.
- `pos_alteracao`: qualquer conteúdo não-cancelamento virava "quer alterar mais um horário".

Confirmado como pré-existente desde antes da v18: precedentes em `agent_logs` de 23/06/2026
(`"Sim, tomei"` e `"Tomei"` em `confirm_acao` produzindo erro genérico). Corrigido aplicando o
mesmo padrão das outras 9 etapas. **Validado: 9 casos em produção, 31/07.**

### Cadeia de bugs revelados pela correção (BUG-083, 084, 085)

A restauração da escalada tornou alcançáveis três caminhos de código que nunca tinham sido
exercitados nessa combinação. Todos **pré-existentes**, nenhum regressão:

- **BUG-083** (`continuarComAcao`): duas extrações independentes rodavam sobre a mesma mensagem —
  `normalizarHorario` pegando o **primeiro** número (seleção) e `interpretarHorarioLivre` pegando
  o **último** (destino). Com um número único, ambas colapsavam no mesmo token → confirmação
  `"mudar de 12:40 para 12:40"`. Correção: só confiar em `novoHorario` como destino quando a
  mensagem trouxer **dois números distintos**.
- **BUG-084** (`pos_alteracao`): a mensagem `"12:40"` escalava para o classificador geral
  (`classificarIntencao`), cujo prompt só tem exemplos **com verbo** — diante da ambiguidade,
  escolheu `remover_horario`. Correção: a pergunta *"quer alterar algum?"* já embute uma **lista
  implícita** (os horários restantes, conhecidos com precisão em `context.schedulesAtivos`);
  reconhecer diretamente com o mesmo casador determinístico antes de escalar.
- **BUG-085** (dois defeitos): (a) `normalizarHorario` não reconhecia número por extenso nem
  número solto embutido em frase; (b) **mais grave** — `identif_schedule` reaproveitava
  `context.novoHorario` de uma tentativa **anterior**, confirmando destino obsoleto.
  Reproduzido em produção: `"das dez para as onze"` (falha) seguido de `"das 10:00 para as nove"`
  → confirmou **11:00** (da tentativa anterior), não 09:00. Correção: `identif_schedule` extrai o
  destino sempre **fresco da mensagem atual**, com a mesma trava de dois números do BUG-083.

Todos validados em produção 01/08. O caminho específico do BUG-083 (`continuarComAcao` alcançado
diretamente do `idle`) foi validado com teste dedicado, após constatar que os testes anteriores o
exercitavam apenas por equivalência via `identif_schedule`.

### MH-70 — tabela `eventos_proativos` (Parte B)

**Erro de modelagem identificado:** `getContextoProativoRecente` (MH-065) tentava reconstruir a
linha do tempo de mensagens proativas a partir de `dose_logs`. Dois defeitos estruturais:

1. `dose_logs` é **estado mutável** — `ultima_tentativa_at` é sobrescrito a cada follow-up, então
   os follow-ups intermediários se perdiam antes de qualquer leitura acontecer. Não existia
   "construção incremental do contexto": a função só rodava quando o usuário mandava mensagem, e
   nesse instante o dado já tinha sido apagado.
2. O filtro por status da dose (idêntico ao de `temDosePendente`) misturava duas perguntas
   diferentes: *"esta dose ainda está pendente?"* (operacional) e *"isso apareceu na tela do
   usuário?"* (conversacional). Uma dose já `nao_informado` continua tendo acontecido.

Solução: tabela **append-only** `eventos_proativos`, escrita no **instante do envio**, com ponto
único de escrita (`registrarEventoProativo` em `database.js`, defensiva — nunca lança). 7 pontos
de instrumentação cobrindo 5 tipos: `lembrete`, `follow_up`, `alerta_estoque_zerado`,
`alerta_estoque_nao_informado`, `resumo_semanal`. Isso fechou também os 3 gaps que a v27 já
documentava como "fora de cobertura" mais um quarto não mapeado (`scheduler.js` — alerta de
estoque zerado disparado na hora do lembrete, em vez do lembrete normal).

Notificação a cuidador ficou **deliberadamente de fora**: é mensagem para outro telefone, e o
contexto proativo é sobre o que o **paciente** viu na própria tela.

**Validado:** os 5 tipos gravando corretamente em produção.

### MH-71 — leitura reescrita (Parte C)

`getContextoProativoRecente` passou a ler de `eventos_proativos`, sem filtro de status, com janela
de até 6 eventos (número escolhido como ponto de partida pragmático, a calibrar com mais volume —
mesmo espírito do gap de 30min do Juiz Offline). Retorna array (nunca `null`).

Adicionado **rótulo de tempo determinístico em cada linha**, reativa e proativa
(`formatarTempoRelativo`): antes desta sessão, **nenhum dos dois blocos** tinha noção de distância
temporal alguma — o classificador precisava inferir pela posição no texto. Isso resolve o cenário
levantado por Guilherme: 3 turnos reativos de 2 dias atrás ficam explicitamente marcados como
"há 2 dias", enquanto eventos proativos recentes ficam "há 5 min".

**Decisão de janela:** os 3 turnos reativos permanecem fixos e independentes (orçamentos
separados, não janela única) — evita que muitos eventos proativos empurrem turnos reativos reais
para fora do contexto.

**Não reagrupa mais lembretes combinados** (2 remédios no mesmo horário = 2 linhas em vez de 1) —
decisão deliberada, a revisar se o volume incomodar.

**NÃO VALIDADO** — ver BUG-086.

### BUG-086 — o bloqueador (identificado no encerramento)

Teste de validação do MH-71 falhou, mas **não por defeito do MH-71: ele nunca foi invocado**.

Linha do tempo reconstruída cruzando `agent_logs` + `eventos_proativos` (exatamente o cruzamento
que a tabela nova torna possível):

```
15:54:29  [REATIVO]   "Pausar Cataflam" → Nami pergunta confirmação
15:56:02  [PROATIVO]  follow-up Ômega 3 (tentativa 2)
15:57:37  [REATIVO]   "Sim" → configuracao → pausou Cataflam ❌
```

O `"Sim"` respondia ao follow-up de 1min35s antes, não à pergunta de 3min antes. Mas
`isConfirmacao("Sim")` é verdadeiro em `confirm_acao` → `executarAcao` roda direto. A escalada do
BUG-082 só cobre "não reconheci o que você disse"; um token de confirmação **válido** é consumido
localmente. O `contextoProativo` é buscado e **descartado sem uso**.

**Distinção importante que só ficou clara no fechamento:** `detectarConfirmacaoDose` reconhece
`'sim'` mas **não** `'s'`. Isso separa completamente dois cenários:

| Mensagem | Estado | Caminho |
|---|---|---|
| `"S"` | `idle` | Não bate no fast-path → **chega ao classificador** → caso do MH-65/71 |
| `"Sim"` | `configurando` | Consumido por `isConfirmacao` → **nunca chega ao classificador** → BUG-086 |

Portanto o MH-71 **não está bloqueado para validação** — precisa do teste certo (`"S"` em `idle`
após lembrete proativo), não do cenário que foi testado.

### Princípios novos (33 e 34) — ver seção de Princípios de Engenharia

### Lição de processo

Ao investigar a falha do MH-71, o próprio Claude consultou apenas `agent_logs` e não cruzou com
`eventos_proativos` — cometendo exatamente o erro que a tabela foi criada para corrigir. Guilherme
apontou: *"Se você não conseguiu ter a visualização cronológica de como a conversa aconteceu, o
classificador vai acertar de que jeito?"* O cruzamento das duas fontes tornou a causa imediatamente
visível. **A ferramenta só serve se for usada.**

## Backlog (BUG/FIX/MH/ACH)

A partir de 07/07/2026, o backlog completo vive na tabela `backlog_items`
do Supabase (projeto Nami_Life Brazil, project_id nputymewnwmnhrtpizzs).
Não é mais mantido neste arquivo. Consultar via Supabase MCP:

  SELECT tipo, numero, titulo, status, prioridade, parte, relacionado, data_criacao
  FROM backlog_items
  WHERE status IN ('aberto', 'em_validacao')
  ORDER BY prioridade, data_criacao;

### Governança de backlog (decisão v29, 05/08/2026)

A lista de BUG/MH crescia mais rápido do que fechava, ameaçando o objetivo de MVP
leve pro beta. A partir da v29:

- **Nenhum item novo (BUG, MH ou ACH) entra em `backlog_items` sem autorização
  EXPLÍCITA de Guilherme** na conversa do chat de planejamento — candidato a
  bug/melhoria encontrado durante investigação é apresentado como candidato, nunca
  registrado direto.
- **Item grande demais para uma sessão → Parte (A, B, C...) do MESMO número**, nunca
  item novo. Coluna `parte` (`text NOT NULL DEFAULT ''`, nunca NULL — ver comentário
  da migration) distingue as partes; índice único
  `backlog_items_tipo_numero_parte_ativo` cobre `(tipo, numero, parte)`.
- **Categoria ACH (achado)** — observação de sessão que não é necessariamente bug
  fechado nem melhoria definida. Coluna `relacionado` (texto livre, ex: `"MH-071"`)
  aponta pro BUG/MH relacionado, quando existir; nulo quando solto.
- Migration: `supabase/migrations/20260805000000_ach_e_partes_backlog.sql`. Racional
  completo em `briefings/BRIEFING_ACH_PARTES.md`.

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
13. **Apresentação de dado de saúde também é determinística (v15, reforçado v17)** — o mesmo
    raciocínio do princípio 4/11 se estende à camada de apresentação: mensagens de
    adesão/progresso nascem de templates fixos aprovados previamente, nunca de geração livre do
    LLM — elimina a raiz do BUG-031, não só o sintoma. **v17 estende isso a rótulos de data
    relativa** (hoje/ontem/anteontem): o Claude não deve inferir esse cálculo sozinho — ver
    BUG-059, `calcularRotuloDia()` e a âncora de data/hora atual no contexto geral.
14. **Classificação semântica central, nunca lista de exclusão de palavras (v15)** — quando um
    atalho determinístico precisa decidir "essa mensagem foge do padrão esperado?", a resposta
    correta é consultar o classificador central (`classificarIntencaoComContexto`), não crescer
    uma lista de palavras a excluir — não escala e sempre fica um passo atrás da próxima frase que
    escapa (mesma lição do BUG-036, reaplicada no BUG-056 complemento).
15. *(Em consideração, não formalizado)* **Confirmação de dose pendente tem precedência sobre
    qualquer estado conversacional** — estabelecido no BUG-057, correto na prática, mas Guilherme
    pediu para não generalizar como regra permanente ainda sem refletir mais sobre o risco de
    acumular regras. Tratar caso a caso até decisão explícita numa sessão futura.
16. **Escrita em tabela de auditoria/registro sempre via função única, nunca SQL direto (v16)** —
    igual ao stock_movements (princípio já implícito no MH-042), backlog_items só é escrito pelo
    código de produção através de src/backlog.js (registrarItemBacklog/atualizarStatusBacklogItem).
    SQL direto (execute_sql) é aceitável apenas em briefings de correção/manutenção em lote
    revisados explicitamente como exceção — nunca como caminho padrão de escrita.
17. **Texto literal da mensagem atual > contexto preservado > inferência do classificador (v18,
    BUG-063)** — quando um fluxo precisa resolver uma referência ambígua (ex: qual medicamento é
    "ele"/o assunto atual), a ordem de confiança é: (1) o que a mensagem atual, como texto puro,
    já resolve deterministicamente (ex: `encontrarMedicamento(message, ...)`); (2) o que já estava
    preservado no `context` da conversa; (3) por último, o palpite de um classificador LLM que
    recebe `historicoConversa` — esse palpite pode refletir um assunto que já não é mais o atual.
    Nunca inverter essa ordem.
18. **Cancelamento/desistência não tem precedência cega sobre um assunto citado explicitamente
    (v18, BUG-062)** — palavras de desistência (ex: "parar", "cancela") podem coexistir com uma
    intenção real quando citam um medicamento (ex: "parar a dipirona" = encerrar tratamento, não
    desistir da operação). Uma checagem de cancelamento genérica deve primeiro confirmar que a
    mensagem não cita nenhum medicamento conhecido antes de aceitar como desistência pura.
19. **Uma métrica derivada nunca substitui a métrica bruta que ela resume (v19, BUG-065)** — quando
    um cálculo converte um valor bruto relevante à saúde (ex: unidades de estoque) numa métrica
    derivada mais conveniente pra decisão (ex: dias de cobertura, via divisão por doses/dia), o
    texto apresentado ao usuário nunca pode inferir o valor bruto a partir da derivada. A mensagem
    deve checar o valor bruto diretamente antes de qualquer afirmação categórica sobre ele (ex:
    "zerado", "esgotado") — a derivada serve pra decidir a urgência, nunca pra descrever o fato.
20. **Operação em lote precisa de UM timestamp compartilhado, nunca um por item (v20, hipótese do
    BUG-066)** — quando uma função processa múltiplos itens do mesmo lote/grupo em loop (ex:
    doses de um lembrete agrupado), qualquer `new Date()` usado como referência de tempo para esse
    lote deve ser calculado UMA VEZ, fora do loop, e passado explicitamente para cada chamada —
    nunca calculado de novo dentro de cada iteração. Deixar cada item calcular seu próprio "agora"
    introduz um drift de milissegundos que pode, em código sensível a limiares de tempo checados
    em ciclos (ex: cron), colocar itens do mesmo lote em ciclos diferentes silenciosamente.
21. **Toda capacidade nova de roteamento precisa ser registrada no classificador central na MESMA
    mudança (v21, MH-020 fix — reforço do princípio 5)** — ao criar uma capacidade acionada por um
    portão determinístico próprio (ex: exclusão de conta), é obrigatório também adicioná-la ao
    inventário do `classificarIntencaoComContexto`. Uma lista fixa de palavras/frases sempre deixa
    escapar typo/fraseado novo; quando escapa, a mensagem cai no `principal`, que — se souber da
    capacidade pelo system prompt mas não puder executá-la — pode ENCENAR o fluxo e AFIRMAR um
    resultado falso (no MH-020, falsa confirmação de exclusão de dados, o pior caso de LGPD). Corolário:
    o `principal` nunca deve conduzir nem afirmar ações críticas que pertencem a fluxos determinísticos
    (reforço dos princípios 11/13 aplicado a exclusão de conta). Consequência intencional dessa regra: a detecção de exclusão de conta vive em DOIS caminhos (portão early + categoria no classificador central) apontando para o mesmo handler — redundância proposital que NÃO deve ser removida (ver "Decisão arquitetural — redundância INTENCIONAL" na seção da Sessão v21).
22. **Dimensão ortogonal no classificador central não deve virar novo valor do eixo de roteamento
    (v22, MH-053)** — quando um sinal novo a capturar (ex: feedback explícito do usuário) pode
    coexistir com qualquer agente escolhido (ex: um elogio dentro de um pedido de relatório), a
    resposta correta é adicionar um CAMPO PARALELO ao retorno do classificador (`{ agente,
    subtipoRelatorio, feedback }`), nunca expandir o enum de `agente`. Forçar num único eixo cria um
    falso ou/ou (o sinal ortogonal só é capturado quando "ganha" do roteamento) e aumenta o risco de
    misclassificação do eixo principal — o oposto do que o princípio 5 protege.
23. **Escrita de observabilidade nunca pode lançar exceção (v22, MH-053)** — funções que registram
    eventos/feedback (`registrarEvento`/`registrarFeedback` em `observabilidade.js`) são sempre
    defensivas (try/catch interno, fallback a `console.error`). Muitas vezes essas funções são
    chamadas de DENTRO de um catch que já capturou uma falha real; se a escrita de observabilidade
    também lançar, a exceção escapa do catch e impede até o fallback ao usuário — o ato de observar
    não pode piorar a experiência que estava sendo observada.
24. **`agent_logs` registra a resposta PRETENDIDA, não a ENTREGUE (v24, MH-054).**
    `logAgentInteraction` roda dentro de `routeMessage`, antes de `sendTextMessage`. Quando a entrega
    falha, o log fica congelado na intenção enquanto o usuário recebe a mensagem de erro do catch
    global. Nenhuma análise sobre `agent_logs` pode afirmar o que o usuário viu sem cruzar com
    `system_events` na mesma janela. Custou um diagnóstico errado na v24 antes de ser descoberto.
25. **Identidade de agrupamento nunca depende de geração livre de LLM (v24, MH-054).**
    Extensão do princípio 4 (cálculo de saúde determinístico) ao domínio da observabilidade. Pedir a
    um LLM que gere identificador estável por texto livre não funciona por construção. Detecção pode
    ser aberta e contextual; etiquetagem que alimenta `fingerprint` tem que ser canônica e fechada,
    com categoria `outro` como saída para o que não foi antecipado.
26. **Taxonomia de observabilidade classifica sintoma, nunca causa (v24, MH-054).**
    Categorizar por causa provável exige que o LLM infira causa — justamente o que ele não faz com
    confiabilidade, e que é trabalho humano com evidência de código. Categorias de causa também
    refragmentam o agrupamento: dois episódios com o mesmo sintoma e causas diferentes receberiam
    fingerprints distintos.
27. **Proteção que já existe no projeto é replicada, nunca reimplementada pela metade (v25, C-3).**
    Ao criar um ponto novo que pertence a uma classe de problema já resolvida em outro lugar do
    código, a proteção existente é reaproveitada — não reescrita parcialmente nem esquecida. Caso
    concreto: extração tolerante de JSON de LLM já existia em `parseJulgamento` (`juizOffline.js`);
    ao acrescentar `params` ao classificador, a proteção foi replicada em `gerarMoldura` mas NÃO no
    classificador, que era justamente o ponto alterado — 29% das classificações passaram a ser
    descartadas silenciosamente. **Corolário operacional:** toda saída de LLM parseada como JSON
    passa por extrator tolerante (cercas markdown + isolamento do primeiro objeto), e o `max_tokens`
    é revisto sempre que o formato de saída cresce — truncamento produz o mesmo sintoma.
28. **Comunicação de dado de saúde pode ser escrita por LLM, desde que o dado não passe por ele
    (v25) — refinamento do princípio 13.** O princípio 13 proíbe geração livre para apresentação de
    dado de saúde. A v25 estabelece o desenho que preserva a intenção sem sacrificar a qualidade da
    conversa: **núcleo factual determinístico + moldura pelo LLM**. O bloco de fatos (nomes,
    horários, status) é renderizado em código e inserido LITERALMENTE na mensagem; o LLM escreve
    apenas abertura e fechamento, a partir de contadores estruturais, com proibição explícita de
    citar qualquer dado factual. O montador da mensagem final é código, nunca o LLM.
    **Corolário (N-1):** se o LLM é proibido de citar um dado, esse dado precisa ter um lugar
    determinístico próprio na mensagem. Proibir sem criar o lugar faz o dado desaparecer — foi o que
    aconteceu com a data resolvida, que o LLM parafraseou como "desta quarta-feira" enquanto o bloco
    factual só continha horários.
29. **Degradação silenciosa exige instrumentação explícita — a observabilidade é opt-in, não
    orgânica (v25).** O `catch_global` do `agent.js` só captura exceção NÃO TRATADA. Todo caminho de
    degradação controlada — `catch` local que devolve fallback, valor default assumido, parse que
    falha, sinal não interceptado — é invisível por construção: o código não quebra, ele piora, e
    tanto `agent_logs` quanto o Juiz Offline registram uma interação aparentemente saudável. Esses
    caminhos devem registrar em `system_events`. **Corolário de processo:** todo agente, fluxo ou
    função nova declara explicitamente seus pontos de instrumentação no briefing que a cria — do
    mesmo modo que o princípio 5 exige atualizar o inventário do classificador. Peça nova NÃO herda
    observabilidade automaticamente: fora do `routeMessage` não há nem `agent_logs` (é por isso que
    `scheduler.js` tem 6 instrumentações manuais e `enviarResumoSemanal` não gera log nenhum).
30. **Contrato de chamada que muda precisa de ponto único de despacho (v25) — aplicação do
    princípio 1.** Quando um handler é chamado de vários lugares e o contrato dele muda (ex:
    acrescentar `params`), a mudança vai para uma função de despacho única em vez de ser replicada
    em cada call site. Motivo: o modo de falha é **degradação silenciosa** — o call site esquecido
    recebe `undefined`, volta ao comportamento antigo e não gera erro nem log. Precedentes no
    projeto: BUG-069 (1 de 6 call sites do `configuracao` sem interceptar escalada), BUG-065 (3
    cópias divergentes de alerta de estoque), BUG-036 (3 listas divergentes de termos de
    confirmação). O padrão comum é sempre o mesmo: **a cópia nasce por falta de um lugar comum, e
    depois diverge.**
31. **O valor de fallback só existe como retorno da função que o registra (v26, MH-064) —
    aplicação do princípio 29.** O princípio 29 diagnosticou que a observabilidade é opt-in;
    instrumentar N pontos à mão reproduz a mesma fragilidade, porque o ponto N+1 depende de alguém
    lembrar. A saída é estrutural: `degradar()` registra o evento **e** devolve o fallback na mesma
    chamada, então quem quer o fallback passa obrigatoriamente por quem registra. Dois invariantes
    definem o que passa por ali: (a) todo caminho que entrega ao usuário texto que não é a resposta
    pretendida; (b) todo caminho que devolve valor default assumido no lugar de resultado real
    (decisão, classificação, booleano) — este é o mais perigoso, porque não deixa nem assinatura de
    texto para procurar depois. **Corolário de verificação:** o critério de conclusão de um briefing
    é um comando que varre o projeto, nunca a lista de pontos que o autor conseguiu enumerar. Na
    v26 o autor do briefing afirmou "dois produtores violam o contrato de título estável"; o `grep`
    do próprio checklist encontrou oito.
32. **Transporte de fato estruturado entre camadas não depende de desambiguação de linguagem
    natural (v27, H3 do juiz).** Quando um dado estruturado (nome de medicamento, horário,
    status) é transportado para dentro do prompt de outra camada, ele vai em **campos
    rotulados**, nunca embutido em prosa com genitivo ou aposto. Caso concreto: a nota
    `"lembrete automático de Elani"` do Juiz Offline é ambígua quando o nome do medicamento soa
    como nome próprio — o juiz leu "Elani" como o nome da usuária, concluiu que a Nami errara o
    nome dela e emitiu `informacao_saude_incorreta` de severidade crítica. Extensão dos
    princípios 25 e 26: lá, identidade de agrupamento não pode depender de geração livre de LLM;
    aqui, o significado de um campo não pode depender de leitura correta de uma construção
    gramatical ambígua. **Corolário:** se dois nomes próprios podem aparecer no mesmo bloco
    (usuário e medicamento), ambos precisam de rótulo — desambiguar um só deixa o outro exposto.
33. **Lista implícita numa pergunta fechada é resolvida pelo casador determinístico local, nunca
    pelo classificador geral (v28, BUG-084).** Quando uma etapa faz uma pergunta de sim/não que
    **embute uma lista** ("você ainda tem lembretes: 09:00, 12:40 — quer alterar algum?"), uma
    resposta que nomeia diretamente um item dessa lista deve ser reconhecida ali mesmo, com o
    mesmo casador que a etapa já usa para essa lista, **antes** de qualquer escalada. Motivo: a
    etapa conhece a lista com precisão (`context.schedulesAtivos`); o classificador geral não a
    recebe, e decide com menos informação. Caso concreto: `"12:40"` respondendo a "quer alterar
    algum?" foi classificado como `remover_horario` — o prompt do classificador só tem exemplos
    **com verbo** ("tirar o das 8h"), e nada cobria "só o número, respondendo a uma pergunta de
    continuação". **Corolário:** escalar não é sempre a opção mais segura — escalar para uma
    camada que tem *menos* contexto que a atual é uma perda de informação, não um fallback.
34. **Toda nova tabela ou escrita que armazene dado de usuário decide sua cobertura de exclusão
    LGPD no momento da criação (v28).** `CASCADE` quando o dado é puramente operacional e não tem
    valor após a exclusão da conta (`dose_logs`, `eventos_proativos`); `SET NULL` quando tem valor
    de aprendizado de produto que deve sobreviver anonimizado (`system_events`, `feedbacks`).
    Verificar contra `delete_user_account` (MH-020) antes de considerar a tabela pronta — a função
    só precisa de passos manuais explícitos para FKs com `NO ACTION` (`stock_movements`,
    `adesao_estado`); todo o resto é resolvido pela cascata do único `DELETE FROM users`. Nunca
    deixar essa decisão implícita ou para depois. **Dívida conhecida:** o comentário da função
    `delete_user_account` lista as tabelas cobertas pela cascata e não inclui `eventos_proativos`
    (cosmético — o `CASCADE` do banco não depende do comentário; corrigir na próxima vez que a
    função for tocada).

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
4. Antes de atribuir qualquer ID novo de BUG/FIX/MH/ACH, consultar `backlog_items` no Supabase
   (não mais `ls briefings/` — essa checagem manual foi substituída pela constraint do banco,
   que rejeita fisicamente qualquer tentativa de reaproveitar um número ativo). **A partir da
   v29, nenhum item novo é registrado sem autorização explícita de Guilherme** — ver
   "Governança de backlog" na seção Backlog.

### Ritual de encerramento de sessão
1. Gerar relatório .docx e apresentar para download (upload manual no Drive)
2. Gerar briefings/encerramento_vN.md com o CONTEXT.md atualizado para o Claude Code commitar
3. Incluir no encerramento a lista de escritas em `backlog_items` (inserts/updates) — este chat é
   READ-ONLY no Supabase; todas as escritas de backlog são responsabilidade do Claude Code.
4. **Todo encerramento inclui a seção `## Sessão vN` do CONTEXT.md — sem exceção, inclusive em
   sessão que não alterou nenhuma linha de código.** Sessão de decisão pura tem a decisão como
   entregável, e é justamente o raciocínio que não está em lugar nenhum além do briefing.
5. **Nenhuma edição do CONTEXT.md é delegada a passo manual fora do pipeline.** Toda mudança de
   estado do arquivo vai no briefing, com texto literal, e é aplicada pelo Claude Code — o mesmo
   caminho verificável de todo o resto.
6. **Verificação obrigatória pelo Claude Code após aplicar as edições:**
   `grep -c "^## Sessão" CONTEXT.md` deve ter aumentado em exatamente 1 (ou pelo número de seções
   que o briefing declarou inserir). Relatar o número antes e depois.
7. **Todo briefing que instrumenta ou corrige uma CLASSE de defeito declara um comando de
   verificação que varre o projeto inteiro** — não a lista de pontos que o autor enumerou. Se o
   comando não voltar limpo, o trabalho não está concluído, independentemente do que o briefing
   listou (princípio 31, corolário).

⚠️ **Lição registrada (v13):** conferir que o nome do arquivo `encerramento_vN.md` bate com o
número de versão do CONTEXT.md que ele gera *antes* de salvar.

⚠️ **Lição registrada (v26):** as seções das sessões v23 e v24 faltaram no CONTEXT.md por duas
causas distintas — a v23 delegou a edição a uma ação manual e não embutiu o bloco a colar; a v24
especificou cabeçalho, princípios e estrutura de arquivos mas não pediu a seção. Em nenhum dos dois
casos houve perda de conteúdo (os briefings estavam íntegros no repositório), e em nenhum dos dois
o Claude Code errou. **A seção de sessão não é herdada do ritual — ela existe só quando o briefing
a escreve.** Mesma forma dos princípios 29 e 30, aplicada ao processo em vez do código. Os itens
4 a 6 acima existem para tornar isso verificável em vez de confiável.

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
- **Google Drive:** pasta Desenvolvimento Nami, ID `17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN`. Último relatório: `Nami_Relatorio_v21.docx` (v20 não gerou relatório — foi só validação de backlog).
- **Supabase:** banco Brasil (São Paulo). `agent_logs` = histórico conversacional (também usado para saudação condicional, v15). `conversation_state` = estado operacional (sem 's').
- **Railway:** produção com auto-deploy no git push. Logs exportados em UTC.
- **Claude Code (VS Code):** implementação via briefings `.md`, sempre com texto literal embutido.

---

## Convenções do Projeto

Identidade visual. Todo relatório e apresentação da Nami segue `docs/GUIDANCE_IDENTIDADE_VISUAL.md`. Documentos `.docx` são gerados por `assets/templates/nami_identidade.py`; apresentações por `assets/templates/nami_slides_template.js`. Cor, fonte e espaçamento têm ponto único de escrita no dicionário `TOKENS` de cada gerador — nenhum documento define esses valores por conta própria. Paleta: laranja `#FC4C02` (marca), `#C43C00` (laranja em texto), marinho `#0F2B46`, e os quatro estados epistêmicos (dado verificado / hipótese / advertência-lacuna / decisão).