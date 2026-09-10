# Briefing de encerramento — sessão v42

**Data:** 09/09/2026
**Sessão:** v42 — Fluidez da jornada de chegada (mapeamento e arquitetura)
**Natureza:** sessão de análise e decisão arquitetural. **Nenhuma linha de código foi
alterada.** Este briefing registra estado e decisões; a implementação virá em briefings de
execução por fase.

---

## AÇÕES QUE EXIGEM GUILHERME

Nenhuma. Este briefing é executado inteiramente pelo Claude Code.

---

## O QUE O CLAUDE CODE DEVE EXECUTAR

1. Sobrescrever `CONTEXT.md` na branch `main` com o conteúdo da seção 3 deste documento.
2. Executar as escritas em `backlog_items` da seção 2, via `src/backlog.js`.
3. Commit e push.

**Não alterar nenhum arquivo em `src/`.** Se algum passo falhar, parar e reportar — não
tentar caminho alternativo.

---

## 1. Resumo da sessão

Dez dias de beta público expuseram que a jornada do "Oi" até o primeiro medicamento
cadastrado é o gargalo do produto: **68% de perda** entre chegar e ter um medicamento
(19 → 10 → 9 → 6). Três conversas reais foram auditadas em `agent_logs` e cruzadas com
`medications`, `users` e `system_events`.

O achado mais grave está confirmado como fato: a Nami afirmou a uma usuária que quatro
medicamentos estavam cadastrados, e `medications` não tem uma única linha para ela. Oito
causas raiz foram confirmadas por leitura direta de código (ver `CONTEXT.md` §11.2), entre
elas duas que estavam abertas como hipótese há meses:

- **MH-040 (73 dias em aberto)** — `src/index.js` não tem serialização por usuário.
- **BUG-104** — `router.js` chama `despacharCadastro` com `context: { etapa: 'cad_nome' }`
  literal, descartando a mensagem que carregava os dados.

E um achado que reduz o escopo da obra: **o extrator multi-campo já existe**
(`extrairCadastroCompleto`, MH-80, 14 campos numa chamada) e estava travado por dois
portões. Grande parte da arquitetura proposta é consolidação, não invenção.

A arquitetura decidida (três camadas, call único `{ intencao, campos }`, níveis de campo,
janela de 5s, retomada passiva) e o plano de 7 fases estão em `CONTEXT.md` §11.

**Correção de registro:** a coluna `users.onboarding_completo_at`, referida em resumos de
sessões anteriores como implementada, **não existe** — nem em produção
(`nputymewnwmnhrtpizzs`) nem em staging (`pibzuwoyznywajyxeulj`). Verificado via
`information_schema.columns` nos dois projetos.

---

## 2. Escritas em `backlog_items`

**Oito inserts** (itens 2.1 a 2.8) e **um update** (item 2.9), todos autorizados
explicitamente por Guilherme nesta sessão. Usar `src/backlog.js`. Campos do insert: `tipo`,
`numero`, `titulo`, `descricao`, `status = 'aberto'`, `prioridade`.

### 2.1 BUG-104 — alta

**Título:** `principal` promete cadastro e `cadastro` confirma persistência que nunca ocorre

**Descrição:** No bloco `post_onboarding` do `router.js`, `despacharCadastro` é chamado com
`context: { etapa: 'cad_nome' }` literal e a `message` do turno corrente. Uma mensagem com
quatro medicamentos e horários seguida de "Sim" faz o `cadastro` receber apenas o "Sim", no
primeiro degrau, com contexto vazio. O agente `principal`, que recebeu a mensagem rica, não
tem verbo de cadastro em seu vocabulário de ação (`CONFIRM_DOSE`, `UPDATE_STOCK`,
`REGISTER_NAO_TOMADO`, `REVERSE_CONFIRMATION`) e nenhuma regra o proíbe de prometer a ação —
gerou "Vou cadastrar os quatro agora". O `cadastro`, no turno seguinte, gerou "Tudo
cadastrado!" ecoando o histórico. Confirmado: zero linhas em `medications` para a usuária.
Fecha na Fase 2 do plano (`CONTEXT.md` §11.11).

### 2.2 MH-090 — alta

**Título:** Estender o contrato `{ message }` a `principal` e `recepcionista` — afirmação de
estado por leitura pós-escrita (P56)

**Descrição:** O MH-073 Parte C aplicou a disciplina ao `cadastro`; `principal` e
`recepcionista` seguem gerando livremente afirmações sobre estado do sistema ("Tudo
cadastrado", "Anotei as quatro vitaminas", "totalmente gratuita, sem mensalidade" — as três
observadas em produção). Toda mensagem que afirma persistência passa a ser montada a partir
de leitura pós-escrita. Inclui dar ao `principal` tratamento explícito para "usuário trouxe
medicamento novo" em vez de prosa livre (P51 aplicado ao vocabulário de ação).

### 2.3 MH-091 — alta

**Título:** Texto de acolhida enxuto

**Descrição:** 9 de 19 usuários do Ciclo 2 mandaram uma ou duas mensagens e sumiram sem dar
o nome — viram apenas o texto de acolhida, que soma apresentação, proposta de valor,
pergunta e aviso de transparência (MH-076) antes de qualquer interação. Maior perda isolada
do funil. Fase 0 do plano: independente das demais, é copy, não toca arquitetura. Guilherme
revisa o texto antes da geração.

### 2.4 MH-092 — alta

**Título:** Data de nascimento em um turno quando a mensagem já traz a data

**Descrição:** O MH-072 separou a coleta em dia → mês → ano → confirmação, decisão
deliberada para contornar o P44. O custo é **4 turnos como piso para todos os usuários**;
uma usuária gastou 10. Outra entregou a data completa junto do consentimento e ainda assim
percorreu a escada inteira. Com o runner de extração da Fase 7, a escada permanece como
fallback, nunca como padrão. Substitui os 4 classificadores de campo único de
`recepcionista.js` por um esquema.

### 2.5 MH-093 — média

**Título:** Formas por medida ou massa (pó, sachê, granulado) e dedução de estoque
correspondente

**Descrição:** `FORMAS_VALIDAS` em `cadastro.js` tem 7 formas e **não inclui "pó"**;
`UNIDADES_DOSE_VALIDAS` (`unidade`, `gota`, `ml`) não representa colher, scoop ou grama.
Usuária real tentou cadastrar cúrcuma em pó e o valor foi descartado por validação. Exige
decisão própria sobre dedução de estoque, análoga à do MH-073 para líquidos. Fora do escopo
da frente de fluidez — registrado para não travar a sessão.

### 2.6 MH-094 — alta

**Título:** Cadastro de múltiplos medicamentos declarados em uma única mensagem

**Descrição:** `extrairCadastroCompleto` devolve `nome` como string única — extrairia um de
quatro medicamentos e ignoraria três. **As duas usuárias auditadas bateram nesse limite**,
com o mesmo comportamento: listar todos os medicamentos de uma vez. Não é caso de borda — é
o comportamento natural de quem toma mais de um medicamento, que é o público-alvo. Sem este
item, os dois casos ficam parcialmente resolvidos. Exige decisão de desenho própria:
cadastro em sequência, confirmação da lista antes, e tratamento de falha parcial. Fase 5 do
plano.

### 2.7 MH-040 Parte B — alta

**Título:** Concorrência de turnos — `conversation_state` lido antes da persistência do
turno anterior

**Descrição:** Parte B do MH-040, aberto há 73 dias. Causa raiz agora **confirmada**:
`src/index.js` responde `200` e dispara `handleIncomingMessage` sem fila; o único mecanismo
é o dedupe de `messageId` idêntico. Mensagens próximas do mesmo usuário viram execuções
concorrentes de `routeMessage` que leem `conversation_state` antes de qualquer uma gravar.
Evidência: três turnos consecutivos de uma usuária, em 6 segundos, todos com
`estado_conversa = 'idle'`, produzindo três textos de acolhida completos. Atingiu 5 dos 19
usuários (26%). Solução decidida: **fila por usuário** (não-negociável) + **janela de
agregação de 5 segundos** (ajustável após medição). Fase 1 do plano.

### 2.8 ACH-008 — média

**Título:** Juiz Offline não marcou afirmação de persistência falsa

**Descrição:** Três conversas com falha grave — incluindo a Nami afirmando que quatro
medicamentos estavam cadastrados sem nenhuma linha em `medications` — geraram **zero**
registros em `system_events`. Fato confirmado por consulta direta filtrando pelos três
`user_id`. Se é lacuna de taxonomia ou falha de disparo exige leitura do código do Juiz.
Ligado a BUG-104 e MH-090. Nota relacionada: há **10 eventos `desvio_comportamental` de
severidade crítica** desde 30/08 com `status_triagem = 'novo'` e `backlog_ref` nulo, nove
com título "Informação de saúde incorreta ao usuário", nenhum triado.

### 2.9 MH-89 Parte C — **UPDATE, não insert**

Item existente `tipo = 'MH'`, `numero = 89`, título **"Formalizar fluxo de promoção staging
→ produção"**, hoje com `status = 'aberto'`. Atualizar para `status = 'resolvido'`,
`sessao_fechamento = 'v42'`, `data_fechamento = 2026-09-09`.

**Nota de fechamento:** o fluxo foi formalizado no `CONTEXT.md` §7, subseção "Promoção
staging → produção e disciplina do `CONTEXT.md`". Cinco passos por entrega e três regras de
branch, sendo a decisiva que a `staging` recebe o `CONTEXT.md` **por merge, nunca por cópia
de arquivo** — cópia é edição, cria alteração independente do mesmo arquivo nos dois lados e
transforma merge trivial em reconciliação. Verificado na v42 que `main` e `staging` têm o
`CONTEXT.md` byte a byte idêntico (md5 `7e1ef26a2990`, 24.318 bytes), portanto não há
divergência a reconciliar no momento da adoção.

**Atenção:** há três itens com `numero = 89`. Atualizar **apenas** o de título "Formalizar
fluxo de promoção staging → produção". Os outros dois — "Provisionamento de ambiente de
staging isolado" (`em_validacao`) e "Auditoria de configuração 100% via variável de
ambiente" (`aberto`) — permanecem intocados.

---

## 3. `CONTEXT.md` atualizado

Sobrescrever `CONTEXT.md` na raiz do repositório, branch `main`, com exatamente o conteúdo
abaixo.

O que mudou em relação à v40:
- Cabeçalho: data e versão da sessão.
- §3.2: estado do backlog atualizado.
- §5.2: dois princípios novos — **P56** (afirmação de persistência por leitura pós-escrita)
  e **P57** (descartar dado já entregue é regressão de fluidez).
- §6: quatro padrões técnicos novos (itens 12 a 15), incluindo o invariante
  `medications.ativo` <-> `schedules`.
- §7: subseção nova **"Promoção staging → produção e disciplina do `CONTEXT.md`"**
  (MH-89 Parte C).
- §10.5: Parte C marcada como resolvida.
- **§11 inteira, nova** — jornada de chegada: evidência, 8 causas raiz confirmadas,
  inventário de LLM, arquitetura de três camadas, call único, níveis de campo, LGPD com
  recuperação de rascunho, fila e janela, retomada passiva, plano de 7 fases.

---

# CONTEXT.md — Nami Life

> **Fonte única de verdade do estado técnico e arquitetural do projeto.**
> Atualizado no encerramento de cada sessão. O backlog **não** vive aqui — vive em
> `backlog_items` no Supabase.

**Última atualização:** 09/09/2026 (encerramento da sessão v42)

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

Consultar `backlog_items` com `status = 'em_validacao'`. Ao fim da v42, 61 itens abertos
ou em validação; os de prioridade alta concentram-se na jornada de chegada (ver §11).

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
- **P56 — toda mensagem que afirma persistência é construída por leitura pós-escrita,
  nunca pela intenção pré-escrita.** Nasceu do BUG-104 (v42): o agente `principal`
  prometeu cadastrar quatro medicamentos e o agente `cadastro` respondeu "Tudo
  cadastrado!" sem que uma única linha existisse em `medications`. Afirmar estado do
  sistema a partir do que o LLM pretendia fazer, e não do que o banco confirma ter sido
  feito, é a forma mais direta de destruir confiança em produto de saúde.
- **P57 — descartar dado que o usuário já entregou é regressão de fluidez, não
  economia.** Nasceu da v42: fazer a pessoa repetir o que já disse é o comportamento que
  mais custa na conversa. O extrator sempre procura todos os campos do esquema, e a
  transição entre etapas ou agentes carrega o que já foi coletado.
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

12. **Não há serialização por usuário no webhook.** `src/index.js` responde `200` e
    dispara `handleIncomingMessage` sem await de fila; o único mecanismo é o dedupe de
    `messageId` idêntico, que protege contra webhook duplicado da Z-API, não contra
    mensagens diferentes em sequência. Mensagens próximas do mesmo usuário viram execuções
    concorrentes de `routeMessage` que leem `conversation_state` antes de qualquer uma
    gravar. Causa raiz confirmada do MH-040 (v42).
13. **`agent_logs` guarda a conversa inteira** (`user_message` + `agent_response` +
    `estado_conversa` de entrada + `contexto_conversa`). É a fonte primária para auditar
    experiência de usuário real, sempre cruzada com o estado persistido (P24).
14. **`dose_logs` não tem `user_id`** — filtrar via join por `medications`.
15. **Invariante vigente:** todo `medications.ativo = true` tem ao menos um `schedules`
    ativo, e todo `ativo = false` tem zero. Verificado na v42 (13 e 56 registros). Qualquer
    mudança que introduza medicamento ativo sem horário quebra scheduler, relatórios,
    bloco "Medicamentos cadastrados" do prompt do `principal` e dashboard.

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

### Promoção staging → produção e disciplina do `CONTEXT.md` (MH-89 Parte C, v42)

**Fluxo por entrega:**

1. Briefing de execução da fase → Claude Code implementa na branch `staging`.
2. Validação no ambiente de staging (Railway + `Nami-staging` + Z-API staging, §10).
3. Merge `staging` → `main`.
4. Encerramento de sessão: `CONTEXT.md` atualizado **em `main`**, movendo a entrega de
   "validada em staging" para "em produção".
5. Merge `main` → `staging`, para a branch de trabalho herdar a documentação.

**Três regras, e a terceira é a que evita conflito de merge:**

- **O `CONTEXT.md` é editado exclusivamente em `main`**, no encerramento de sessão. É de
  `main` que o ritual de abertura faz o `curl` — documentação que viaja com o código deixaria
  `main` desatualizado justamente na janela em que o trabalho está acontecendo.
- **Toda entrega carrega estado explícito** — *validada em staging* ou *em produção*. O
  documento nunca afirma que algo está no ar antes de estar, e duas fases em andamento
  simultâneo não geram ambiguidade.
- **A `staging` recebe o `CONTEXT.md` por merge, nunca por cópia de arquivo.** Cópia é
  edição: cria alteração independente do mesmo arquivo nos dois lados e transforma um merge
  trivial em reconciliação. Merge faz a `staging` *herdar* a alteração — o ancestral comum
  anda para frente e o merge `staging → main` seguinte não conflita, porque a `staging` nunca
  editou o arquivo. Merge de `main` para `staging` também traz correções emergenciais que
  tenham entrado direto em produção, impedindo que a branch de trabalho fique para trás.

Nada em runtime lê o `CONTEXT.md` — ele não é configuração. O custo de deixá-lo defasado em
`staging` não é quebra de execução, é leitura errada: a inspeção de código por tarball de
branch traria a arquitetura antiga junto do código novo.

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
- **Parte C:** formalizada na v42 — fluxo de promoção e disciplina de branch do
  `CONTEXT.md` documentados no §7. **Resolvida.**

---

## 11. Jornada de chegada — arquitetura decidida na v42

### 11.1 Motivação e evidência

Dez dias de beta expuseram que a jornada do "Oi" até o primeiro medicamento cadastrado é o
gargalo do produto. Funil do Ciclo 2 em 09/09/2026 (base real, `is_teste = false`, usuários
criados a partir de 30/08):

| Etapa | Usuários |
|---|---|
| Mandaram a primeira mensagem | 19 |
| Deram o nome e aceitaram a LGPD | 10 |
| Completaram data de nascimento | 9 |
| Cadastraram ao menos 1 medicamento | 6 |

**68% de perda entre chegar e ter um medicamento.** A maior perda é a primeira: 9 dos 19
mandaram uma ou duas mensagens e sumiram sem dar o nome — viram apenas o texto de acolhida.

Custo em turnos de quem chegou ao fim: `data_nascimento` custa **4 turnos como piso
arquitetural** (dia → mês → ano → confirmação) para todos; `cadastro` custa **7 a 10 turnos
por medicamento**. Fragmentação de mensagens atingiu **5 dos 19 usuários (26%)**.

**Público observado é jovem, não idoso** — a expectativa de agilidade é maior, e cada
pergunta a mais custa mais do que custaria com o público originalmente imaginado.

### 11.2 Causas raiz confirmadas por leitura de código (v42)

1. **Concorrência de turnos** — `src/index.js` sem serialização (ver §6, item 12).
2. **Descarte da mensagem rica no roteamento** — no bloco `post_onboarding` do
   `router.js`, `despacharCadastro` é chamado com `context: { etapa: 'cad_nome' }`
   **literal**, e a `message` repassada é a do turno corrente. Uma mensagem com quatro
   medicamentos e horários seguida de "Sim" faz o `cadastro` receber apenas o "Sim", no
   primeiro degrau, com contexto vazio. Mesmo padrão no bloco `cadastrando_medicamento`,
   que reinicia do zero por decisão explícita.
3. **`detectarIntencaoCadastro` é lista de substrings** (`'cadastrar'`, `'adicionar
   remédio'`, …). Uma mensagem como `"Suplemento Bariatron 12:00 / Fluxetina 08:00"` — a
   expressão mais inequívoca possível de intenção de cadastro — não contém nenhum termo e
   cai no `else`, indo para o `principal`.
4. **`principal` tem vocabulário de ação que não cobre cadastro.** Emite `CONFIRM_DOSE`,
   `UPDATE_STOCK`, `REGISTER_NAO_TOMADO`, `REVERSE_CONFIRMATION` — nada para "usuário
   trouxe medicamento novo" — e não há regra proibindo-o de prometer a ação. Recebeu uma
   lista de medicamentos, não tinha verbo, e escreveu prosa. É o P51 aplicado ao
   vocabulário de ação.
5. **O extrator multi-campo já existe e estava travado.** `cadastro.js`,
   `extrairCadastroCompleto` (MH-80), extrai **14 campos numa chamada** com validação
   determinística campo a campo e `degradar()` no fracasso. Dois portões o prendem:
   (a) só roda quando `etapaAtual === 'cad_nome'`; (b) só quando a mensagem tem dígito ou
   mais de 6 palavras. No caso real, a mensagem que chegou ao agente foi "Sim" — reprovada
   no portão (b). **O extrator funcionava; nunca viu os dados.**
6. **O rascunho morre na escalada, não no abandono.** O bloco `adding_med` repassa
   `context: state?.context || {}` — abandono puro preserva o rascunho indefinidamente,
   sem TTL. Quem zera é `despacharEscalada`, que faz
   `saveConversationState(user.id, { state: 'idle', context: {} })` ao escalar para
   qualquer agente que não seja `configuracao`. O mecanismo de preservação **já existe**
   para `configuracao` (`contextoPreservado` com `medicationId`, `medicationNome`,
   `schedulesAtivos`) — só não é aplicado ao cadastro.
7. **`extrairCadastroCompleto` devolve `nome` como string única** — não suporta múltiplos
   medicamentos em uma mensagem. As duas usuárias analisadas bateram nesse limite.
8. **O Juiz Offline não marcou a afirmação de persistência falsa.** Três conversas com
   falha grave, zero registros em `system_events`. Se é lacuna de taxonomia ou falha de
   disparo, exige leitura do código do Juiz (ACH-008).

### 11.3 Inventário de chamadas de LLM (v42)

**26 chamadas** de `messages.create`, todas em `claude-sonnet-4-6` (inclusive
`MODELO_JUIZ`). Destas, **17 são classificadores ou extratores**: 11 em `cadastro.js`,
4 em `recepcionista.js`, 1 em `router.js` (`classificarIntencaoComContexto`), 1 em
`data_nascimento.js`, mais `configuracao.js`, `exclusaoConta.js` e `estadoPosOnboarding.js`.

Consequência arquitetural: **não é possível avaliar troca de modelo por tarefa hoje**,
porque interpretação, decisão e redação acontecem na mesma chamada em cada agente.
Consolidar em um runner único é o que torna a medição possível. Nenhuma troca de modelo
está decidida ou recomendada — a decisão exige medição, não intuição.

### 11.4 A tensão arquitetural

**A rigidez do fluxo não é descuido — é o preço pago pela confiabilidade.** O MH-073 Parte
C reduziu o contrato do LLM a `{ message }` para acabar com a divergência entre o que o LLM
gerava e o que a máquina de estados decidia. Foi correto. A consequência é que o código só
avança **um degrau por turno**, porque só interpreta **uma resposta classificada por vez**.

Devolver autoridade de estado ao LLM devolveria fluidez e devolveria junto a afirmação
falsa. **Esse caminho está fechado.** A arquitetura precisa dar fluidez sem devolver
autoridade.

### 11.5 Arquitetura decidida — três camadas

**Camada 1 — Extrator de entrada (LLM, saída tipada, sem autoridade).** Roda uma vez por
turno, antes da máquina de estados. Recebe mensagem + estado atual + **esquema de campos do
fluxo corrente** (escolhido pelo estado, nunca todos os esquemas juntos — é o que evita o
P44 mudar de endereço). Devolve JSON estrito. Não decide estado, não escreve, não produz
texto ao usuário. **Não é gateado pela etapa atual** — sempre procura todos os campos do
esquema (P57).

Três valores distintos, nunca colapsados (P49): **valor extraído**, **ausente da mensagem**
(`null`), **presente mas ambíguo** (`indeterminado`). O terceiro é o que impede que "menos
perguntas" vire "dado errado em silêncio".

**Camada 2 — Máquina de estados (código, determinística).** Recebe o saco de campos,
valida, persiste o válido, calcula o que falta, decide o próximo estado. O número de turnos
deixa de ser propriedade do prompt e passa a ser propriedade do que o usuário disse.

**Camada 3 — Renderização (código decide o quê, LLM só escreve).** O código monta a lista
de fatos — o que foi persistido (lido de volta do banco, P56), o que falta, qual a próxima
pergunta. O LLM recebe isso e escreve na voz da Nami, contrato `{ message }`.

**Decisão D1:** uma função runner, N esquemas declarados como dado (mesmo padrão do P55).
Não N prompts que divergem.

### 11.6 Call único `{ intencao, campos }`

O extrator sozinho não fecha beco sem saída, porque extrai **campos**, não **intenção**. E
rodar extrator de esquema em mensagem fora de assunto aumenta a superfície de invenção.

Uma única chamada por turno devolve as duas coisas, nenhuma com autoridade:

```json
{ "intencao": "continuar_fluxo | corrigir | duvida | desistir | outro_fluxo",
  "campos":   { "nome": "Cataflam", "horarios": ["10:00"] } }
```

| `intencao` | O que o código faz com `campos` |
|---|---|
| `continuar_fluxo` | consome, persiste no rascunho, calcula o que falta |
| `corrigir` | consome, **sobrescreve** o campo correspondente |
| `duvida` | ignora, responde, **preserva o rascunho** e retoma |
| `desistir` | preserva o rascunho para retomada futura, sai do fluxo |
| `outro_fluxo` | preserva o rascunho, despacha para o agente certo |

Resolve `"na verdade é 20h"`, hoje beco sem saída: `intencao: corrigir` +
`campos: { horarios: ["20:00"] }` num turno.

**As duas metades já existem separadas:** `extrairCadastroCompleto` (campos) e
`classificarIndeterminadoCadastro` (que devolve exatamente `recusa | duvida |
nova_intencao | ruido`). Hoje rodam em sequência — a intenção só é avaliada **depois** que
a extração falha, o que torna impossível corrigir um campo e sinalizar intenção no mesmo
turno. Fundir as duas é o ganho.

**Precedência:** os portões determinísticos existentes (fast-path de confirmação de dose,
portão de exclusão de conta) permanecem **antes** do call. São baratos, corretos e têm
precedência declarada.

### 11.7 Níveis de campo — fronteira de commit

Hoje `cadastro.js` trata todos os campos como igualmente obrigatórios; a lista de
pré-requisitos está achatada, e é daí que vêm os 7 a 10 turnos.

| Nível | Campos | Sem eles |
|---|---|---|
| **Have to have** | `nome`, `quantidade_por_dose`, `horario` | não existe registro, ou existe registro que nunca lembra |
| **Nice to have** | `dosagem`, `estoque_atual`, `tipo_tratamento` | lembrete funciona; alerta de recompra e relatório ficam pobres |
| **Derivados** | `unidade_estoque`, `unidade_dose` | derivam da quantidade por dose |
| **Eliminado** | `instrucoes` | — |

**A unidade de dose vem junto da quantidade.** "1 cp" / "10 ml" / "20 gts" já carrega
`UNIDADES_DOSE_VALIDAS` (`unidade`, `gota`, `ml`), e `FORMAS_COMPATIVEIS` deriva a forma a
partir dela. A derivação é **de uma para várias** (`unidade` → comprimido, cápsula, pomada,
injetável): suficiente para o lembrete, possivelmente insuficiente para contagem de estoque
— verificar quando o alerta de recompra for tocado.

**A fronteira de commit fica entre have to have e nice to have.** A Nami persiste assim que
tiver os três; tudo do nice to have é enriquecimento posterior, nunca bloqueio.

**O acumulado parcial continua em `conversation_state.context`, não em `medications`** —
gravar rascunho na tabela quebraria o invariante do §6 item 15.

### 11.8 Consentimento LGPD com recuperação de rascunho

Decisão de Guilherme, corrigindo proposta anterior de descarte:

- **Consentimento explícito + dados na mesma mensagem** → persiste tudo, um turno.
- **Dados sem consentimento explícito** → guarda no rascunho, refaz a pergunta. Resposta
  positiva recupera os dados e segue; resposta negativa descarta tudo.

Descartar dado já entregue e obrigar o usuário a repetir é o comportamento que mais destrói
fluidez (P57), e pune quem leu a pergunta corretamente.

**Duas salvaguardas obrigatórias:** nada vai para `users` antes do consentimento — o
rascunho vive só em `conversation_state.context`, e a gravação em `users` ocorre no mesmo
instante do aceite; e o descarte na recusa é **explícito e verificável** (apagar o
`context`, não apenas sair do fluxo).

### 11.9 Fragmentação — fila e janela

São dois problemas distintos:

- **Fila por usuário** — nunca processar dois turnos concorrentes do mesmo `user_id`.
  Corrige decisão tomada sobre estado obsoleto. **Não-negociável**; sem ela, qualquer fluxo
  mais curto fica mais frágil, não menos.
- **Janela de agregação — 5 segundos** (decisão de Guilherme, ajustável após medição).
  Mensagens que chegam na janela viram **uma entrada só**. Corrige o usuário receber N
  respostas para um pensamento fragmentado.

A janela pressupõe a fila. Definir no briefing de execução a precedência quando um lembrete
agendado dispara com a janela aberta.

### 11.10 Retomada de rascunho

**Passiva** (decisão de Guilherme): a Nami retoma quando o usuário volta, sem puxar
proativamente. **Sem TTL** — o rascunho já sobrevive indefinidamente hoje e adicionar prazo
seria restrição nova disfarçada de correção. O trabalho é estender o `contextoPreservado`
de `despacharEscalada` ao cadastro, replicando padrão que já existe no mesmo arquivo.

### 11.11 Plano de implementação — 7 fases

| # | Fase | Item | Muda o quê | Staging |
|---|---|---|---|---|
| 0 | Acolhida enxuta | MH-091 | copy do `recepcionista` | direto |
| 1 | Fila + janela 5s | MH-040 A+B | `index.js` | sim |
| 2 | Verdade + rascunho | BUG-104, MH-090 | `router.js` (L587, bloco `post_onboarding`), `principal.js` | sim |
| 3 | Níveis have/nice-to-have | — | `primeiraEtapaFaltante` em `cadastro.js` | sim |
| 4 | Destravar MH-80 em qualquer etapa | — | portão `cad_nome` em `calcularDecisaoEtapa` | sim |
| 5 | Múltiplos medicamentos | MH-094 | extrator: `nome` string → lista | sim |
| 6 | Call único `{ intencao, campos }` | — | runner novo | sim |
| 7 | Runner + esquema do onboarding | MH-092 | `recepcionista.js`, 4 classificadores → 1 esquema | sim |

**Ordem justificada.** A Fase 0 é independente, é copy, e ataca a maior perda isolada do
funil. A Fase 1 é pré-requisito de tudo. A Fase 2 sozinha já melhora o caso real: com a
mensagem rica chegando ao `cad_nome`, o portão de heurística do MH-80 aprova (tem dígitos) e
o extrator roda — um medicamento dos quatro seria cadastrado de fato. O onboarding fica por
último **de propósito**: é a fase de maior risco de regressão (mexe em consentimento LGPD e
na porta de entrada de 100% dos usuários) e a que mais se beneficia de o runner já ter
rodado no cadastro; sua perda é atacada antes pela Fase 0.

**Métrica de validação, medível em `agent_logs`:** turnos em `agent = 'cadastro'` por
medicamento cadastrado. Baseline v42: **7 a 10**. Alvo com níveis: 3 a 4. Alvo com extrator
destravado, para mensagem rica: 1 a 2.

### 11.12 Fora de escopo, registrado

- **MH-093** — formas por medida ou massa (pó, sachê, granulado). `FORMAS_VALIDAS` tem 7
  formas e **não inclui "pó"**; `UNIDADES_DOSE_VALIDAS` não representa colher, scoop ou
  grama. Usuária real tentou cadastrar cúrcuma em pó e o valor foi descartado por
  validação. Exige decisão própria sobre dedução de estoque.
- **Design das mensagens ao usuário** — Guilherme pediu conversa dedicada, posterior à
  arquitetura.


---

## 4. Commit

```
docs(context): v42 - arquitetura da jornada de chegada e 8 itens de backlog

- P56 (afirmacao de persistencia por leitura pos-escrita) e P57 (nao descartar
  dado ja entregue) registrados
- 8 causas raiz da jornada de chegada confirmadas por leitura de codigo
- arquitetura de tres camadas, call unico {intencao, campos} e plano de 7 fases
- padroes tecnicos 12-15, incluindo invariante medications.ativo <-> schedules
- MH-89 Parte C: fluxo de promocao staging->producao formalizado no §7
```

---

## 5. Verificação após execução

1. `curl` do `CONTEXT.md` raw com cache-busting, após `sleep 8`, confirmando §11 presente e
   cabeçalho em 09/09/2026.
2. `SELECT tipo, numero, titulo, status, prioridade FROM backlog_items WHERE numero IN
   (104, 90, 91, 92, 93, 94, 40, 8) ORDER BY tipo, numero` — confirmar os 8 itens, com
   MH-040 tendo Parte B distinta da Parte A já existente.
2b. `SELECT titulo, status FROM backlog_items WHERE tipo='MH' AND numero=89` — confirmar que
   "Formalizar fluxo de promoção staging → produção" está `resolvido` e que os outros dois
   itens de número 89 seguem inalterados (`em_validacao` e `aberto`).
3. `git log -1 --stat` confirmando que **apenas** `CONTEXT.md` mudou.

---

## 6. Próxima sessão (v43)

Ritual de abertura normal, mais:

- O plano de 7 fases está em `CONTEXT.md` §11.11. **A Fase 0 (MH-091, acolhida) é
  entregável imediato** — copy, sem dependência, maior perda isolada do funil. Guilherme
  revisa o texto antes da geração.
- Cada fase precisa de **briefing de execução próprio**, gerado perto da execução.
  Briefing é contrato, e contrato de sete fases envelhece antes de ser cumprido.
- Fases 1 a 7 rodam em **staging** antes de produção — primeira validação continuada real
  do ambiente construído na v40.
- Métrica de acompanhamento: turnos em `agent = 'cadastro'` por medicamento cadastrado.
  Baseline v42: 7 a 10.