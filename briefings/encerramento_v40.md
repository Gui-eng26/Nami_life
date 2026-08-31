# Briefing de encerramento — sessão v40

**Para o Claude Code.** Este briefing é o contrato desta sessão de planejamento. Execute
os três blocos abaixo, nesta ordem, e valide cada um antes de seguir pro próximo.

---

## 1. Sobrescrever CONTEXT.md

Substitua o conteúdo integral de `CONTEXT.md` (raiz do repositório) pelo texto abaixo,
entre os marcadores. Não é um diff — é substituição completa do arquivo.

<<<CONTEXT_MD_INICIO>>>
# CONTEXT.md — Nami Life

> **Fonte única de verdade do estado técnico e arquitetural do projeto.**
> Atualizado no encerramento de cada sessão. O backlog **não** vive aqui — vive em
> `backlog_items` no Supabase.

**Última atualização:** 31/08/2026 (encerramento da sessão v40)

---

## 1. O que é a Nami

Assistente de gestão de saúde no WhatsApp que ajuda pessoas a não esquecerem de tomar
seus remédios, sem instalar nenhum aplicativo novo. Para famílias que cuidam de idosos,
conecta paciente e cuidador, dando visibilidade do tratamento.

**Persona em refinamento.** O público idoso foi a motivação original e principal do
desenvolvimento. A etapa de discovery levantou também o adulto de 30 a 50 anos, por rotina
agitada e dificuldade de lembrar das coisas. O Ciclo 2 investiga qual público demonstra
mais aderência à solução — a persona é objeto de descoberta, não premissa.

Modelo de monetização: B2B2C, via operadoras de saúde e farmácias.

---

## 2. Arquitetura

**Stack:** Node.js · Supabase (PostgreSQL) · Railway (hospedagem) · Z-API (WhatsApp) ·
Anthropic Claude API · node-cron (agendamento).

**Supabase:** projeto `nputymewnwmnhrtpizzs`, região sa-east-1.
**Repositório:** `Gui-eng26/Nami_life` (público).

**Ambiente de staging (desde a v40):** isolado em três camadas — Railway (Environment
`staging`, deploy a partir da branch `staging`), Supabase (projeto `Nami-staging`,
`pibzuwoyznywajyxeulj`, tier Free) e Z-API (instância dedicada, número próprio). Ver §10.

### 2.1 Agentes em produção

| Agente | Responsabilidade |
|---|---|
| `recepcionista` | Primeiro contato, onboarding, consentimento |
| `cadastro` | Cadastro e alteração de medicamentos |
| `principal` | Conversa geral, confirmação de dose |
| `lembrete` | Follow-up de doses não confirmadas |
| `relatorios` | Relatórios de adesão e balanço |
| `configuracao` | Ajustes de horário, pausa, encerramento |
| `data_nascimento` | Coleta de data de nascimento (fluxo dedicado) |
| `exclusaoConta` | Exclusão de conta (LGPD) |

Mais o `scheduler`, que não é agente: é o processo de cron que dispara lembretes e
follow-ups.

### 2.2 Módulos de template (ponto único de texto)

| Módulo | Responsabilidade |
|---|---|
| `src/templates/verbos.js` | Verbo por forma farmacêutica (tomar/usar/aplicar) |
| `src/templates/dose.js` | Rótulo de quantidade da dose e `normalizarFormaFarmaceutica()` |
| `src/templates/estoqueTemplates.js` | Textos de estoque |
| `src/templates/adesaoTemplates.js` | Textos de relatório de adesão |
| `src/templates/balancoTemplates.js` | Textos de balanço |
| `src/inventario.js` | **NOVO v39** — inventário de capacidades como dado (P55) |

---

## 3. Estado atual — o que está em produção

### 3.1 Entregue e validado

- **MH-009 (v39)** — dashboard de indicadores do Ciclo 2, em produção como serviço
  Railway separado. Ver §9.
- **MH-081 (v37)** — quantidade da dose exibida em lembretes e follow-ups.
- **MH-073 Partes A, B, B.1, B.2, B.3, C** — suporte a medicamento líquido: unidade de
  dose derivada da resposta natural, blindagem de becos sem saída, contrato do LLM
  reduzido a `{ message }`, estoque aproximado de frasco aberto.
- **MH-072** — coleta de data de nascimento em três perguntas separadas.
- **MH-076** — aviso de transparência sobre estágio de desenvolvimento.
- **MH-020** — exclusão de conta (LGPD), com função SQL atômica e confirmação explícita.
- **MH-032** — lembrete e follow-up agrupados por usuário e horário.
- **MH-054 / MH-064** — Juiz Offline e auditoria de degradação silenciosa.
- **MH-071** — contexto proativo disponível ao classificador central.

### 3.2 Em validação

Consultar `backlog_items` com `status = 'em_validacao'`. Ao fim da v39: MH-073 B.1 e
MH-073 C.1 (reprovado, tratamento adiado).

### 3.3 Marco de produto — abertura do beta (30/08/2026)

O beta público foi aberto em 30/08/2026, encerrando o Ciclo 1 (teste fechado com o núcleo
familiar, iniciado em 05/06/2026) e iniciando o Ciclo 2. Meta desta primeira etapa: até 50
usuários, captados pelas redes sociais pessoais de Guilherme.

O Ciclo 2 é a primeira fase que mede geração de valor — o Ciclo 1 foi construção funcional.
Três hipóteses estão em teste, com indicadores já definidos:

| Hipótese | Indicador |
|---|---|
| H1 — Facilidade de uso | Conclusão de onboarding, de cadastro de medicamento e de confirmação de dose |
| H2 — Nível de engajamento | Taxa de confirmação de dose ao longo do tratamento |
| H3 — Perfil do público-alvo | Taxa de confirmação de dose cruzada com a idade do usuário |

**O Ciclo 1 não é baseline comparável — regra permanente.** Ele foi teste fechado com o
núcleo familiar de Guilherme: sua composição etária resulta de quem está na família, não de
captação. Comparar suas taxas com as do Ciclo 2 seria comparar um conjunto escolhido por
parentesco com um escolhido por interesse. Nenhuma distribuição observada no beta torna o
Ciclo 1 certo ou errado.

Números do Ciclo 1, registrados como **fato histórico, nunca como meta ou referência**
(base real, `is_teste = false`, doses com desfecho até 29/08/2026): 337 confirmadas de 557
— 60,5%. `nao_informado` em 30,3%, e sua causa segue desconhecida: pergunta aberta do
Ciclo 2, não conclusão. Composição etária: três usuários em 20–29, dois em 30–49, um em
60–69.

A constante `FRONTEIRA_CICLO` (`'2026-08-30'`, em `dashboard/api/definicoes.js`) existe para
que nenhuma série atravesse a divisa sem expor os dois períodos separados.

**A H3 é descoberta, não validação.** O dashboard apresenta a distribuição etária; nenhuma
faixa é tratada como resultado esperado ou desviante.

**Advertência metodológica registrada:** os 6 registros da tabela `feedbacks` foram todos
gerados pelo próprio fundador em 27/07/2026, durante a construção do extrator. Não são
percepção de usuário real e não devem ser lidos como tal. O canal de feedback espontâneo
ainda não foi validado com uso orgânico.

---

## 4. MH-081 — quantidade da dose (implementado na v37)

### 4.1 O que faz

Acrescenta uma linha `Quantidade: <valor> <unidade>` logo abaixo da linha que nomeia o
medicamento, em quatro mensagens:

| Função | Arquivo |
|---|---|
| `buildReminderMessage` | `src/scheduler.js` |
| `buildGroupedReminderMessage` | `src/scheduler.js` |
| `buildFollowUpMessage` | `src/agentes/lembrete.js` |
| `buildGroupedFollowUpMessage` | `src/scheduler.js` |

Nas mensagens agrupadas a linha é sub-linha do item, com recuo de dois espaços.

### 4.2 Regra de rótulo

`medications.unidade_dose` governa a **categoria** — é conjunto fechado garantido por
CHECK no schema (`unidade | ml | gota`).

`medications.forma_farmaceutica` escolhe **apenas o substantivo** quando a dose é
contável, via tabela fechada e normalizada (sem acento, minúscula), com fallback
`unidade(s)`. A base tem `capsula` e `cápsula` convivendo — daí a normalização.

```
ml       → "5 ml"            (nunca pluraliza)
gota     → "4 gotas" / "1 gota"
unidade  → "2 comprimidos" / "1 cápsula" / "2 unidades" (fallback)
```

Números em pt-BR: inteiro sem casas decimais, fracionário com vírgula (`2,5 ml`).

### 4.3 Origem do dado

- **Lembretes:** `get_pending_reminders` faz JOIN direto em `schedules`. A quantidade vem
  sempre. Não há caso de omissão.
- **Follow-ups:** `getPendingFollowUps` traz `schedules!dose_logs_schedule_id_fkey
  (quantidade_por_dose)`. Quando `dose_logs.schedule_id` é nulo, a linha é **omitida** e
  a mensagem fica idêntica à anterior ao MH-081, com registro em `system_events`
  (`lembrete:quantidade_dose_indisponivel`, severidade baixa).

### 4.4 O que NÃO fazer

- **Não reusar `resolverQuantidadePorDose` para exibição.** Ela existe para o débito de
  estoque, precisa devolver um número, e o degrau 4 devolve 1. Exibir 1 quando o sistema
  não sabe é afirmar posologia não sustentada.
- **Não fundir o discriminador de quantidade com o de verbo.** O verbo continua vindo só
  de `forma_farmaceutica` (BUG-100).
- **Não duplicar o rótulo `Quantidade:` nos call sites.** Ele existe uma vez só, em
  `src/templates/dose.js`.

---

## 5. Princípios de engenharia

### 5.1 Fundamentos de produto (não negociáveis)

1. Nunca ignorar o que o usuário diz na chegada — toda mensagem merece resposta.
2. O fluxo serve o usuário, não o contrário.
3. Toda correção de bug exige causa raiz confirmada por evidência (log, código, dado).
   Hipótese apresentada como hipótese, nunca como fato.
4. Briefings são o contrato entre o chat de planejamento e o Claude Code.

### 5.2 Princípios de arquitetura (seleção de maior valor)

- **Sistêmico vs. remendo:** toda análise de causa raiz pergunta se a solução elimina a
  classe inteira do problema, não só o caso que apareceu.
- **P24 — `agent_logs` registra a resposta pretendida, não a entregue.** Cruzar sempre
  com `conversation_state`, `medications`, `schedules`, `dose_logs`, `system_events`.
- **P25 — identidade de agrupamento nunca depende de geração livre do LLM.**
- **P26 — taxonomia de observabilidade classifica sintoma observável, nunca causa
  inferida.**
- **P29 — caminho que entrega ao usuário texto diferente do pretendido registra evento.**
- **P30 — ponto único.** Nasceu do BUG-065: três cópias divergentes de alerta de estoque
  criadas no mesmo commit. Texto repetido em N lugares diverge no N+1.
- **P31 — o fallback só existe como retorno da função que registra a degradação.**
- **P35 — coluna anulável em índice único quebra a unicidade.** Usar `NOT NULL DEFAULT ''`
  com sentinela.
- **P40 — quando decisão e persistência ocorrem no mesmo turno, ler do objeto do turno
  atual.**
- **P44 — `buildSystemPrompt` monta todas as instruções de etapa simultaneamente.** A
  flag de "etapa atual" não isola a lógica daquela etapa; perguntas devem ser
  renderizadas deterministicamente em código.
- **P45 — `forma_farmaceutica` é descritiva, com deriva conhecida.** Pode escolher
  palavra, nunca categoria nem número.
- **P49 — `null` não é `0`.** Nunca colapsar valor de erro com valor legítimo.
- **P50 — a ordem canônica do fluxo é declarada em um lugar só.**
- **P51 — funções de decisão cobrem todas as categorias do classificador.**
- **P55 — o inventário de capacidades é dado, não texto de prompt.** Vive em
  `src/inventario.js` e é consumido tanto pelos prompts (`router.js`, `configuracao.js`,
  `prompts.js`) quanto pela interface de observação (dashboard). Capacidade adicionada ou
  removida atualiza o módulo na mesma mudança. Nasceu do MH-009: o inventário existia em
  três lugares divergentes, e um dash que o copiasse criaria o quarto.
- **Sem contador de tentativas em laço controlado pelo usuário.** Teto só onde o sistema
  pode iterar sozinho.
- **Cálculo de saúde é determinístico.** Resultado numérico relevante para saúde vem de
  leitura pós-execução, nunca de valor projetado pelo LLM.
- **Sem consentimento não há base legal para reter dado.** Limpeza de contexto na recusa
  é minimização de dados, não bug.

---

## 6. Padrões técnicos confirmados

1. Filtros via join no SDK do Supabase (`.eq('tabela_relacionada.campo', v)`) **não
   funcionam** — usar abordagem em duas etapas com `.in()`. **Seleção** aninhada
   (embed) funciona normalmente.
2. `SUPABASE_URL` deve ser a URL base, sem sufixo `/rest/v1/`.
3. `ZAPI_CLIENT_TOKEN` fica na aba "Segurança" do painel Z-API, separado do `ZAPI_TOKEN`.
4. `detectarConfirmacaoDose` deve sempre ser combinado com `temDosePendente` no router.
5. Ambiguidade de FK no PostgREST: usar hint explícito
   (`schedules!dose_logs_schedule_id_fkey`) quando houver mais de um caminho.
6. `agent_logs.estado_conversa` reflete o estado **de entrada**, antes do processamento.
7. Escritas em `backlog_items` passam por `src/backlog.js` — nunca SQL cru em código de
   produção.
8. `dose_logs.schedule_id` tem `ON DELETE SET NULL`. `replaceMedication`
   (`database.js`) apaga todos os schedules do medicamento e recria, anulando o vínculo
   de todo o histórico de doses daquele medicamento. `removerSchedule`, ao contrário,
   marca as doses pendentes como `pausado` antes de apagar — esse caminho se protege.
   **`schedule_id` nulo é estado válido de produção; tratar com omissão, nunca com valor
   padrão.**
9. Timestamps armazenados em UTC. Brasil é UTC-3. **Todo agrupamento por dia converte
   antes de truncar:** `(coluna AT TIME ZONE 'America/Sao_Paulo')::date`. Atalhos de data
   ("ontem", "últimos 7 dias") são dia-calendário em Brasília, nunca janela rolante de 24h.
10. SQL multi-statement em uma única chamada de `execute_sql` pode retornar só o último
    result set — usar chamadas separadas.
11. **Ao criar um projeto Supabase novo, desmarcar "Automatically expose new tables"
    também suprime os privilégios padrão (`SELECT/INSERT/UPDATE/DELETE` em tabelas,
    `USAGE` em sequências) do `service_role`** em qualquer objeto futuro — não só de
    `anon`/`authenticated`, como o nome da opção sugere. Confirmado via `pg_default_acl`
    na v40 (MH-89). Correção: `GRANT` explícito nos objetos existentes **e**
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public` para tabela, sequência e
    função, escopado só a `service_role` — nunca reabrir `anon`/`authenticated`, que é
    exatamente a superfície que a opção pretende fechar.

---

## 7. Ritual de sessão

### Abertura

1. Ler o `CONTEXT.md` fresco:
   `curl https://raw.githubusercontent.com/Gui-eng26/Nami_life/main/CONTEXT.md?cb=$(date +%s%N)`
2. Consultar o backlog direto no Supabase:
   ```sql
   SELECT tipo, numero, titulo, status, prioridade, data_criacao
   FROM backlog_items
   WHERE status IN ('aberto','em_validacao')
   ORDER BY prioridade, data_criacao;
   ```
3. Confirmar o estado atual com Guilherme antes de começar.

### Encerramento

1. Gerar `Nami_Relatorio_vN.docx` para o Drive, usando
   `assets/templates/nami_identidade.py`.
2. Gerar `briefings/encerramento_vN.md` com o `CONTEXT.md` atualizado e a lista de
   escritas em `backlog_items`.
3. Guilherme aciona o Claude Code: "Leia o `briefings/encerramento_vN.md` e execute".

### Governança de backlog (decisão de Guilherme, v29)

- **Nenhum item BUG, MH ou ACH entra em `backlog_items` sem autorização explícita de
  Guilherme** no chat de planejamento. Apresentar candidatos e aguardar confirmação.
- Item grande demais para uma sessão vira **Partes (A, B, C) do mesmo número** — nunca um
  número novo para continuação.
- **ACH** (achados) são observações de sessão ainda não confirmadas como bug ou melhoria,
  sempre ligadas a um BUG/MH relacionado.

### Disciplina de verificação

O auto-relato do Claude Code **nunca** é aceito como verdade. A verificação usa snapshot
fresco do GitHub (`curl -sL https://codeload.github.com/Gui-eng26/Nami_life/tar.gz/refs/heads/main`),
`node --check`, greps específicos do briefing e, quando cabível, diff contra o snapshot
pré-implementação para confirmar o escopo real do commit.

### Geração de documento

Os relatórios usam `assets/templates/nami_identidade.py`. Requisitos:
- Exatamente **8 parágrafos em branco** antes do conteúdo, para os slots de
  `aplicar_capa()`.
- Passar o parâmetro `sumario` (via API Python, não pelo CLI) para evitar que capa e
  conteúdo dividam a página.
- **Remover parágrafos vazios que precedem um `Heading 1`** antes de salvar: o pipeline
  aplica quebra de página antes de H1, e o espaçador vira página em branco.

---

## 8. Referências rápidas

- `user_id` de Guilherme: `e3e838c3-9443-46be-b03e-655f46fdf24a`
- **Contas de teste** (`users.is_teste = true`, desde a v39): `+5511941065858` (principal),
  `+5519996078506`, `+5519998093582`. Toda análise de base real filtra `is_teste = false`.
- Busca por telefone: `WHERE phone LIKE '%5511941065858%'` (telefone de Guilherme;
  `%5519988491053%` é o Wellington, não conta de teste — corrigido no MH-009 v39, ver
  briefing §15)
- Pasta do Drive dos relatórios: `17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN`
- Cache-busting no GitHub: `?cb=$(date +%s%N)` em URLs raw, ou tarball via
  `codeload.github.com`. Aguardar ~8s após push antes de refazer o fetch.
- Schema de tabela:
  `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='X' ORDER BY ordinal_position`
- CHECK constraints:
  `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='X'::regclass AND contype='c'`
- Definição de função:
  `SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='X'`
- **Staging (v40):** projeto Supabase `Nami-staging` (`pibzuwoyznywajyxeulj`, sa-east-1,
  Free); Railway Environment `staging`, domínio `namilife-staging.up.railway.app`;
  instância Z-API "Nami Staging", webhook "Ao receber" em `/webhook/whatsapp`. Branch
  git dedicada: `staging`.

## 9. MH-009 — Dashboard de indicadores (implementado na v39)

### 9.1 Arquitetura

Vive em `dashboard/` **no mesmo repositório**, mas deploya como **serviço Railway separado**
do bot. O código fica junto porque o dashboard importa `src/templates/dose.js`
(normalização de forma farmacêutica) e `src/inventario.js` (capacidades) — duplicá-los
violaria o P30. O deploy fica separado porque uma publicação do dashboard não pode derrubar
a Nami.

| Camada | Escolha |
|---|---|
| API | Express, `dashboard/api/`. Autenticação Supabase Auth (JWT, admin único) |
| Front | Vite + React + Recharts, PWA instalável |
| Consultas | 26 funções SQL `dash_*`, chamadas por `supabase.rpc()` |
| Leitura | Consulta direta, sem camada de snapshot |

**Railway:** Root Directory é a **raiz do repositório** (não `dashboard/`, que isolaria
`src/`), com Build e Start Command customizados (`cd dashboard && ...`). O servidor escuta
em `process.env.PORT` além de `DASHBOARD_PORT`.

Nenhuma rota executa `INSERT`, `UPDATE` ou `DELETE`. A service key vive apenas no servidor.
Nenhum endpoint devolve `users.phone`.

### 9.2 Definições canônicas (`dashboard/api/definicoes.js`)

Estas regras existem **uma vez só**. Nenhum painel as reescreve.

- **Base real:** `users.is_teste = false` em perfil, medicamentos, adesão e feedback.
  **Exceção deliberada:** o painel de degradação **não** filtra — falha técnica independe de
  quem a disparou, e `system_events.user_id` é nulo em `scheduler` e `catch_global`.
- **Fuso:** todo agrupamento diário usa
  `(created_at AT TIME ZONE 'America/Sao_Paulo')::date` antes de truncar. Sem isso, tudo
  entre 21h e 23h59 cai no dia seguinte — e o lembrete mais tardio da Nami é noturno.
- **Faixa etária:** função SQL `faixa_etaria(date)`, calculada em tempo de consulta, nunca
  armazenada. Faixas fechadas: `<20 · 20–29 · 30–49 · 50–59 · 60–69 · 70+ · nao_informado`.
  `nao_informado` é faixa de primeira classe e nunca é omitida (P49).
- **Adesão:** allowlist `status IN ('confirmado','nao_informado','sem_estoque','nao_tomado')`.
  `pendente` e `pausado` ficam fora por construção — status novo criado no futuro também
  fica, em vez de entrar num balde silencioso.
- **Confirmação retroativa:** definida pelo **par**
  `revertido IS TRUE AND revertido_de = 'nao_informado' AND status = 'confirmado'`.
  `revertido` isolado mistura quatro fenômenos distintos.
- **Tentativas:** teto real é **3**. Todo `nao_informado` tem exatamente 3 — é o estado
  terminal do esgotamento dos lembretes, por construção, não categoria de causa desconhecida.
- **Horários por medicamento:** denominador são medicamentos ativos **com ao menos um
  horário ativo**. Faixas semiabertas `[1,2) [2,3) [3,4) [4,∞)`.
- **Forma farmacêutica:** SQL devolve bruto; a **API normaliza** via
  `normalizarFormaFarmaceutica()` em `src/templates/dose.js`. Não criar segunda tabela (P30,
  P45).

### 9.3 O que NÃO fazer

- **Não somar `erro_tecnico` e `desvio_comportamental` numa série única.** Falha técnica e
  achado de qualidade do Juiz Offline pedem reações opostas.
- **Não colocar `intencao_nao_suportada` no painel de degradação.** É sinal de demanda de
  produto e vive na visão de Feedback, ao lado do inventário — é ali que a comparação
  "o que a Nami faz × o que pediram e não obtiveram" acontece sozinha.
- **Não incluir retroativas no painel de tentativas.** Elas carregam `tentativas = 3` por
  construção e empilhariam na terceira, fazendo confirmação tardia parecer falha de
  follow-up. São dois fenômenos e dois painéis.
- **Não apresentar o Ciclo 1 como baseline, meta ou referência** em nenhum ponto da
  interface (ver §3.3).

### 9.4 Limitação conhecida

`agent_logs` persiste apenas `agent`, não `subtipoRelatorio`. O classificador distingue seis
subtipos de relatório, mas o dashboard só consegue mostrar `relatorios` como bloco único —
qual relatório as pessoas realmente usam segue sem resposta.

---

## 10. MH-89 — Ambiente de staging isolado (v40)

### 10.1 Motivação

Com o Ciclo 2 aberto a usuários reais desde 30/08/2026, o impacto de uma regressão em
deploy deixou de ser controlado (restrito às contas de teste) para potencialmente crítico.
Três opções foram avaliadas — isolamento total de infraestrutura, feature flag por usuário
em produção, ou só formalizar o checklist pré-merge — com decisão por isolamento total: o
objetivo inclui rodar testes e validações continuadas com a Nami em execução, não apenas
revisão pontual antes do deploy.

### 10.2 Arquitetura

| Camada | Isolamento |
|---|---|
| Railway | Environment `staging`, deploy a partir da branch git `staging`, domínio próprio (`namilife-staging.up.railway.app`) |
| Supabase | Projeto separado `Nami-staging` (`pibzuwoyznywajyxeulj`, Free, sa-east-1) em vez de branch persistente — evita exigência do plano Pro. GitHub Integration aplica migrations automaticamente a cada push em `staging` |
| Z-API | Instância dedicada "Nami Staging", número de WhatsApp próprio, webhook "Ao receber" em `/webhook/whatsapp` |

**Decisão registrada:** Evolution API (já incluída no plano Cloudfy, sem custo adicional)
foi cogitada no lugar da Z-API paga, mas descartada — `src/whatsapp.js` tem o domínio
`api.z-api.io` e o parser de payload específicos da Z-API; trocar exigiria escrever uma
integração nova, fazendo staging testar um caminho de código que produção não usa.

**Migrations em staging não são automáticas via merge do git** — a GitHub Integration do
Supabase aplica a partir do push na branch configurada (`staging` para este projeto). Em
produção, continua sendo o Claude Code, via MCP, quem aplica cada migration explicitamente;
esse padrão não muda com o staging — só passa a ter dois alvos em vez de um.

### 10.3 Incidente e causa raiz

Primeiro teste de ponta a ponta falhou com `permission denied for table users` (depois
`system_events`) — GRANT ausente, não política de RLS. Causa raiz confirmada via
`pg_default_acl`: a opção "Automatically expose new tables", desmarcada na criação do
projeto, suprimiu os privilégios padrão do `service_role` (ver §6, item 11). Corrigido com
`GRANT` nos objetos existentes e `ALTER DEFAULT PRIVILEGES` para objetos futuros, validado
por comparação direta com produção.

### 10.4 Validação

Schema comparado programaticamente com produção antes do teste funcional: 158 colunas em
15 tabelas, RLS e as 33 funções, idênticos. Teste real (mensagem "Oi" ao número de staging)
confirmado não só pela resposta recebida, mas por consulta direta à tabela `users` do
projeto `Nami-staging` (`+5511941065858`, `onboarded = true`).

### 10.5 Pendente

- **Parte A:** infraestrutura construída e validada. Falta formalizar a correção de GRANT
  (hoje aplicada só via SQL Editor) como migration versionada em `supabase/migrations/`.
- **Parte B:** auditoria completa de que nenhuma credencial é decidida por `NODE_ENV`
  hardcoded no código — não iniciada.
- **Parte C:** formalizar o fluxo de promoção staging → produção como parte deste ritual
  de sessão — não iniciada.

---
<<<CONTEXT_MD_FIM>>>

---

## 2. Nova migration — correção de permissões do service_role em staging

O erro `permission denied for table users` (e depois `system_events`) apareceu ao testar
o ambiente de staging pela primeira vez. Causa raiz confirmada via `pg_default_acl`: a
opção "Automatically expose new tables", desmarcada na criação do projeto Supabase
`Nami-staging`, suprime os privilégios padrão do `service_role` — não só de
`anon`/`authenticated`. A correção já foi aplicada manualmente no SQL Editor do projeto
`Nami-staging` e validada; falta apenas versioná-la.

Crie o arquivo `supabase/migrations/20260831000000_mh089_staging_service_role_grants.sql`
com exatamente este conteúdo:

```sql
-- MH-89 — Corrige privilégios do service_role suprimidos pela opção
-- "Automatically expose new tables" desmarcada na criação de um projeto Supabase.
-- Aplicado e validado manualmente no projeto Nami-staging (v40); este arquivo apenas
-- formaliza a correção como fonte única de verdade do schema.
-- Idempotente e inofensivo em produção, que já tem estes privilégios por padrão.

-- Objetos existentes
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Regra de fábrica para qualquer tabela, sequência ou função criada daqui pra frente
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;
```

Commit e push desse arquivo **na branch `staging`** (não `main`) — a GitHub Integration do
projeto `Nami-staging` vai reaplicar automaticamente (é idempotente, sem efeito colateral
por já estar aplicado). Não aplicar em produção agora: produção já tem esses privilégios
por padrão desde a criação do projeto; este arquivo entra na história de migrations dela
naturalmente quando `staging` for promovido para `main` no futuro.

---

## 3. Escritas em `backlog_items`

Autorizado por Guilherme nesta sessão ("sim, registra"). Usar `src/backlog.js`, nunca SQL
cru.

### Inserir MH-89 Parte A

```
tipo: MH
numero: 89
parte: A
titulo: Provisionamento de ambiente de staging isolado
status: em_validacao
prioridade: alta
sessao_criacao: v40
data_criacao: 2026-08-31
causa_raiz: Toggle "Automatically expose new tables" do Supabase, desmarcado na criação do projeto Nami-staging, suprime privilégios padrão (SELECT/INSERT/UPDATE/DELETE em tabelas, USAGE em sequências) do service_role em objetos futuros — não só de anon/authenticated, como presumido inicialmente. Confirmado via pg_default_acl, comparando staging e produção.
notas: Railway Environment "staging" (deploy a partir da branch staging), projeto Supabase "Nami-staging" (pibzuwoyznywajyxeulj, Free, sa-east-1) com GitHub Integration aplicando migrations automaticamente, instância Z-API "Nami Staging" com webhook em /webhook/whatsapp — todos operacionais e validados com teste real de ponta a ponta (usuário +5511941065858 criado com sucesso em `users`). Pendente: a correção de permissões foi aplicada via SQL Editor; a migration formal (bloco 2 deste briefing) fecha essa pendência quando commitada.
relacionado: MH-89 B, MH-89 C
```

### Inserir MH-89 Parte B

```
tipo: MH
numero: 89
parte: B
titulo: Auditoria de configuração 100% via variável de ambiente
status: aberto
prioridade: media
sessao_criacao: v40
data_criacao: 2026-08-31
descricao: Garantir que nenhuma parte do código decide credenciais ou comportamento por NODE_ENV hardcoded, em vez de só variável de ambiente — pré-requisito para múltiplos ambientes Railway funcionarem sem gambiarra. Checagem pontual em src/index.js na v40 não encontrou branching por NODE_ENV, mas não substitui auditoria completa do restante do código.
relacionado: MH-89 A, MH-89 C
```

### Inserir MH-89 Parte C

```
tipo: MH
numero: 89
parte: C
titulo: Formalizar fluxo de promoção staging → produção
status: aberto
prioridade: media
sessao_criacao: v40
data_criacao: 2026-08-31
descricao: Documentar como parte do ritual de sessão (CONTEXT.md §7) o fluxo de promoção de mudanças validadas em staging para produção, incluindo a aplicação explícita de migrations em produção pelo Claude Code via MCP — que já é a prática vigente, mas nunca foi escrita como processo formal.
relacionado: MH-89 A, MH-89 B
```

---

## Commit sugerido

```
docs: encerramento v40 — ambiente de staging isolado (MH-89)
```