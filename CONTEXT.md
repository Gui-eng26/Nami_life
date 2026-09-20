# CONTEXT.md — Nami Life

> **Fonte única de verdade do estado técnico e arquitetural do projeto.**
> Atualizado no encerramento de cada sessão. O backlog **não** vive aqui — vive em
> `backlog_items` no Supabase.

**Última atualização:** 19/09/2026 (encerramento da sessão v44-M2 — runner+schema VALIDADO EM STAGING, ver §12.7)

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
| `src/inventario.js` | Inventário de capacidades como dado (P55); **v44: três listas** (FAZ com limites / AINDA_NAO / NUNCA) |
| `src/porta.js` | **NOVO v44** — porta única de interpretação (tool-use, 1 chamada/turno; proposta, nunca decisão) |
| `src/funil.js` | **NOVO v44** — funil único de saída (`enviarAoUsuario`): todo envio + log em `funil_envios` |
| `src/validadores/recorrencia.js` | **NOVO v44** — validador determinístico de recorrência (dias da semana/frequência) |
| `arnes/` | **NOVO v44** — arnês de regressão (`npm run arnes`): 20 casos-ouro de conversas reais |

---

## 3. Estado atual — o que está em produção

### 3.1 Entregue e validado

- **v44 M0+M1 (19/09/2026, EM PRODUÇÃO)** — arnês de regressão + arquitetura da porta
  única (porta, funil, autoria única de fatos, inventário três listas, citação). Ver §12.
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
- **P58 — todo estado novo de uma coluna exige varredura dos consumidores existentes
  antes do merge.** O Bloco C da v43 introduziu `estoque_atual = NULL` corretamente e
  cinco leitores ficaram para trás, um deles afirmando ao usuário que o remédio tinha
  acabado. A lição não é sobre estoque: é sobre a varredura.
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
16. A fila por usuário de `src/filaTurnos.js` vive na memória do processo. É correta APENAS
    com 1 réplica e serverless desligado. Subir para 2+ réplicas, ou ligar serverless,
    invalida a solução SILENCIOSAMENTE — sem erro, sem log, só o bug de concorrência de
    volta. Verificado em 18/09: produção e staging com 1 réplica, serverless off.
17. `system_events.tipo` tem CHECK que aceita apenas `erro_tecnico`, `desvio_comportamental`
    e `intencao_nao_suportada`. Tipo novo exige migração.
18. A Z-API NÃO garante ordem de entrega dos webhooks. Confirmado em 18/09: cinco mensagens
    digitadas em sequência chegaram embaralhadas. Qualquer agregação precisa ordenar pelo
    timestamp da mensagem.
19. Negrito do WhatsApp é UM asterisco de cada lado. A LLM escreve `**texto**` de markdown
    por padrão e os asteriscos externos aparecem literalmente na tela do usuário.
20. O projeto de staging NÃO era cópia fiel da produção: 8 chaves estrangeiras estavam sem
    `ON DELETE CASCADE` (users ← medications, conversation_state, agent_logs,
    intencoes_nao_suportadas, care_network ×2; medications ← schedules, dose_logs), o que
    quebrava `delete_user_account` apenas lá. Corrigido por SQL em 18/09. Outras diferenças
    podem existir e nunca foram auditadas.
21. **T0 (v44, empírico): o `referenceMessageId` do webhook de citação é o `messageId`
    do envio, NUNCA o `zaapId`.** O funil grava os dois por auditoria e a resolução
    compara contra ambos; o legado `dose_logs.zapi_message_id` prefere `messageId`
    (gravar zaapId primeiro era a causa raiz do BUG-029 nunca casar).
22. **A janela de rollout do Railway (~1–2 min) mantém o container ANTIGO respondendo
    webhooks.** Confirmado 2× em 19/09 (staging e produção): um turno processado pelo
    deploy velho no meio da troca produz comportamento já corrigido e pode corromper
    estado. Testes manuais logo após um push esperam o rollout assentar.
23. **`stock_movements` e `adesao_estado` têm FK sem CASCADE de propósito** —
    `delete_user_account` os apaga explicitamente. Qualquer limpeza de usuário passa
    pela função (o arnês usa exatamente ela, exercitando a LGPD a cada execução).
24. **`schedules.dias_semana` é `text[]` ('seg'..'dom') com DEFAULT dos 7 dias, e a RPC
    `get_pending_reminders` SEMPRE filtrou pelo dia corrente** — descoberta do M2 (v44):
    a infraestrutura nunca foi dormente no SQL, só no JS (nada escrevia a coluna). O
    modelo text[] foi aproveitado pelo MH-77 (em vez de int[]); `intervalo_dias` +
    `data_inicio` são aditivos. Todo consumidor novo de schedules considera
    `dias_semana`/`intervalo_dias` antes de assumir dose diária (ponto único:
    `scheduleCobreDia`/`diasPorSemanaDoSchedule` em `database.js`).

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

## 11. Jornada de chegada — arquitetura e estado

### 11.1 Objetivo

Tornar fluido o caminho do "Oi" até o primeiro medicamento cadastrado. Linha de base do
Ciclo 2 (09/09): 19 chegaram → 10 deram nome e aceitaram a LGPD → 9 informaram data de
nascimento → 6 cadastraram um medicamento. Nove dos 19 pararam tendo visto apenas o texto
de acolhida. O público do beta é JOVEM, não idoso — tolera menos fricção do que a persona
originalmente imaginada.

### 11.2 Arquitetura em três camadas (decidida na v42)

Extrator (LLM, saída tipada, SEM autoridade — nunca condicionado à etapa corrente, sempre
procura todos os campos do schema) → máquina de estados (código determinístico: valida,
persiste, calcula o que falta) → renderização (o código decide o que dizer a partir de uma
leitura pós-escrita; a LLM apenas escreve na voz da Nami).

Três valores de campo nunca colapsados: extraído / ausente (`null`) / ambíguo
(`indeterminado`).

### 11.3 A jornada, como ficou (v43)

| # | Nami | Usuário |
|---|---|---|
| 1 | acolhida curta + pede o nome | nome |
| 2 | LGPD | sim |
| 3 | data de nascimento completa, com exemplo | 06/11/1989 |
| 4 | pede o primeiro remédio: nome, quantidade, horários | Losartana 50mg, 1 cp, 8h e 20h |
| 5 | **grava** + pergunta o estoque | 30 comprimidos |
| 6 | resumo lido do banco + "está tudo certo?" | sim |
| 7 | fecha + aviso de que ainda está sendo construída | |

Antes da v43 esse caminho custava cerca de 15 turnos.

### 11.4 As DUAS portas de entrada

A intenção da primeira mensagem decide a porta, e as duas precisam ser mantidas curtas:

- `cadastrar` ou `neutro` → `recep_boas_vindas`
- `descobrir` → `recep_apresentacao` (caminho do curioso, MH-074)

Quem chega por QR code de camiseta, folheto ou cartão cai em `descobrir`. Em evento
presencial essa é a porta PRINCIPAL, não a exceção. Desde a v43 o convite dessa porta pede
o nome na mesma mensagem, e responder com o nome é o aceite — ajuste deliberado da decisão
original do MH-074 de que a apresentação não pediria dado nenhum.

### 11.5 Níveis de campo no cadastro

- **Have-to-have** (sem isso não existe lembrete): `nome`, quantidade por dose, horário.
- **Nice-to-have** (nunca bloqueiam): `dosagem`, `estoque_atual`, `tipo_tratamento`.
- `forma_farmaceutica` é DERIVADA da unidade da dose e nunca perguntada.
- A gravação acontece assim que os have-to-have existem, **antes** da pergunta de estoque.
- **REVOGADO na v44 (§12):** o resumo vinha DEPOIS do estoque. Decisão de produto de 19/09:
  o resumo vem logo APÓS a gravação (a coleta de estoque nem sempre chega), continua lido de
  volta do banco, e o estoque respondido fecha com mensagem curta — a etapa de confirmação
  saiu do fluxo principal; correção depois do fechamento entra pela porta.
- Correção pós-fechamento edita o REGISTRO via porta — `configuracao` para horários,
  `UPDATE_STOCK` (principal) para estoque; dosagem/nome/duração seguem em AINDA_NAO.

### 11.6 Estoque tem três estados, não dois

`estoque_atual` NULL significa "nunca informado" e é diferente de zero (P49). Ramos:

| Resposta | Grava |
|---|---|
| "30 comprimidos" | valor + movimento `cadastro_inicial` |
| "acho que uns 20" | valor + `estoque_estimado = true` |
| "não sei" | `NULL`, sem movimento, sem insistir |

Enquanto for NULL, a primeira confirmação de dose de cada dia traz um convite para informar
o estoque. Quando o estoque recebe valor, o convite cessa e o alerta normal de recompra
assume. O convite vive apenas no caminho da confirmação — não entra no lembrete agendado
nem na cobrança de dose não confirmada.

### 11.7 Fila e janela de agregação

`src/filaTurnos.js` serializa turnos por usuário e agrupa mensagens fragmentadas.

- Fila por `phone`, em memória do processo. **Correta apenas com 1 réplica** (ver §6).
- Janela DESLIZANTE: cada mensagem reinicia o timer (`JANELA_AGREGACAO_MS`, default 5000),
  com teto desde a primeira (`JANELA_TETO_MS`, default 15000). Janela fixa foi tentada e
  falhou: medição em staging mostrou fragmentos legítimos a 6s de intervalo.
- Concatenação ordenada pelo timestamp da mensagem, não pela ordem de chegada — a Z-API
  entrega webhooks fora de ordem (confirmado por print em 18/09).
- Lembrete agendado que dispara com a janela aberta ENTRA NA FILA e espera o turno corrente
  fechar. Nunca fura a fila.
- **Pendente de ajuste pós-evento:** 5000ms não cobre o intervalo de 6s observado. Valor
  recomendado 7000ms, adiado por tempo. Medir antes de fixar.

### 11.8 Data de nascimento

Etapa inicial `nasc_data` pede a data completa com exemplo obrigatório. Dia/mês/ano isolados
continuam existindo como fallback quando chega só um pedaço.

Confirmação segue uma regra única: **a Nami só confirma o que ela inferiu ou montou.**

| Entrada | Confirmação |
|---|---|
| data completa, ano de 4 dígitos | não |
| data completa, ano de 2 dígitos (`06/11/89`) | sim, mostrando o ano expandido |
| data montada por partes | sim |

Expansão do ano de 2 dígitos: assume o século atual; se cair no futuro, usa o anterior.
Ponto cego aceito: 00–26 colide com 1900–1926, faixa que a validação de idade já limita.
Medição por log `🎂 [ANO2D]` no Railway — `system_events.tipo` tem CHECK que não aceita tipo
novo sem migração.

### 11.9 Guia de composição visual

`src/templates/composicao.js` é ponto único (mesmo padrão do P55): curto não é cru, itens em
linhas próprias com emoji semântico, negrito do WhatsApp com UM asterisco, pergunta sozinha
na última linha. Aplicado em `recepcionista.js`, `data_nascimento.js` e `cadastro.js`.

**Ainda NÃO aplicado** em `principal.js`, `configuracao.js`, `relatorios.js`, `lembrete.js` e
`exclusaoConta.js` — esses agentes ainda podem emitir `**`. Mensagens renderizadas em código
(`src/templates/*.js`) não passam pelo guia e precisam de edição manual.

### 11.10 O que falta das 7 fases

| Fase | Estado |
|---|---|
| 0 acolhida enxuta | entregue (MH-091 A e B) |
| 1 fila + janela | entregue (MH-040 A e B) |
| 2 verdade no roteamento | entregue (BUG-104, MH-090) |
| 3 níveis de campo | entregue (MH-094) |
| 4 destravar o extrator | entregue (dentro do Bloco C) |
| 5 múltiplos medicamentos numa mensagem | **entregue no M2** (validada em staging, §12.7) |
| 6 call único `{ intencao, campos }` | **entregue na v44** (porta única, §12) |
| 7 runner do onboarding | runner entregue no M2 (§12.7); onboarding fica no **M4** |

A limitação "corrigir e continuar no mesmo turno" foi parcialmente resolvida na v44:
correção de estoque/horário pós-fechamento entra pela porta (BUG-103 resolvido); correção
de campo NO MEIO da coleta segue para o M2 (runner).

### 11.11 Métrica

Turnos em `agent='cadastro'` por medicamento cadastrado. Base v42: 7 a 10. Alvo com níveis de
campo: 3 a 4. Com extrator destravado numa mensagem rica: 1 a 2. **Ainda não medido depois da
v43** — primeira ação da próxima sessão.

Cada fase precisa do próprio briefing de execução, gerado perto da execução: briefing é
contrato, e contrato de 7 fases envelhece antes de ser cumprido.

---

## 12. v44 — M0 (arnês) + M1 (porta única): EM PRODUÇÃO (19/09/2026)

Decisão de Guilherme ("sem medo"): ajustar a arquitetura agentiva com poucos usuários,
staging isolado e a base real (2.833 turnos) como rede de segurança. Norte do produto:
**"você fala com a Nami como se tivesse falando com alguém da sua família."**
Marcos: M0 arnês · M1 porta+funil (**entregues, em produção**) · M2 runner+schema
(**entregue, VALIDADO EM STAGING — aguarda promoção, §12.7**) · M3 configuração/relatórios ·
M4 onboarding (LGPD, por último).
Promoção por marco: cada um sobe isolado para `main`, com o arnês verde como portão.

### 12.1 Arquitetura entregue

- **Porta única** (`src/porta.js`): para usuário onboarded, os antigos ramos 4–15 do
  `routeMessage` viraram fast-paths determinísticos → porta → despacho. UMA chamada de
  interpretação por turno (tool-use com schema, nunca JSON em texto livre; 1 retry →
  `degradar()` → repergunta segura). A saída é **proposta, nunca decisão**: campos passam
  pelos validadores dos especialistas, transição é computada em código. No meio de uma
  coleta, 'principal' proposto = continuação do fluxo.
- **Fast-paths que ficaram**: citação+confirmação (grupo do funil), **dose vence coleta**
  (regra 5 — confirma determinístico e retoma a coleta na mesma mensagem), resposta
  tardia (BUG-035), cancelamento/período dos relatórios, aceite com `mensagem_rica`
  (guardada SEMPRE no post_onboarding, com os `campos_rica` da porta — P57).
- **Entrada única no cadastro** (`entrarNoCadastro`): mescla rascunho + campos da porta +
  mensagem original. Multi-medicamento = reconhece todos + um-por-vez (até M2).
  **Medicamento DIFERENTE citado no meio de um cadastro é cadastro NOVO** — fecha o
  anterior pela verdade do banco, nunca repete a pergunta pendente.
- **Contrato universal de devolução**: `principal` ganhou `escalarParaRoteador` (campo
  `devolver` no JSON) — nunca promete ação de outro agente; a porta reinterpreta sem a
  opção 'principal'. Mata a classe do MH-090.
- **Funil único de saída** (`src/funil.js`): TODO envio (reativo, proativo, scheduler,
  cuidador) passa por `enviarAoUsuario` e vira linha em `funil_envios` (texto, origem,
  zaapId E messageId, agent_log_id). Doses de lembrete agrupado apontam para o envio
  (`dose_logs.funil_envio_id`) — citação de agrupada confirmável (gap MH-032). Recusa de
  áudio entrou no pipeline (registrada em `agent_logs`). Critério permanente: **nenhum
  `sendTextMessage` fora de `whatsapp.js`/`funil.js`** (verificável por grep).
- **Autoria única de fatos**: números de estado (estoque/dias/doses) têm autor único —
  template lendo o banco PÓS-escrita. A LLM nunca os escreve (CONFIRM_DOSE incluída);
  estoque pré-débito é neutralizado no contexto quando há dose pendente.
- **Inventário em três listas** (`src/inventario.js`, P55 mantido): CAPACIDADES com
  **limites explícitos**, AINDA_NAO (`{chave, rotulo, escopo}`), NUNCA (fronteira de
  segurança, sem "ainda", SAMU 192). A porta consulta as três como portão; mensagem que
  TRAZ medicamento é sempre `cadastro` (o especialista faz a honestidade de limite sem
  descartar dados) — `nao_suportado` é para pedido sem caminho nenhum.
- **Validador de recorrência** (`src/validadores/recorrencia.js`): padrão de dia-da-semana/
  frequência bloqueia gravação de horários, preserva os demais campos e oferece o
  subconjunto — grava só com consentimento. Notação de receita "N/N hrs" tem resgate
  determinístico (caso Nimesulida); quantidade por HORÁRIO já é suportada (caso A12);
  variação por DIA é M2 (MH-77).
- **Vocabulário canônico obrigatório**: `porta`, `schema`, `runner`, `validador`,
  `template`, `adaptador`, `funil`, `inventario`. Função nova com trabalho igual a uma
  existente é defeito de revisão.

### 12.2 Constituição da Nami — v1 (aprovada 19/09) + emendas

Critério de aceite de TODO texto ao usuário; cada regra é asserção do arnês. Resumo:
(1) nunca tom de obrigação — pedido opcional carrega a porta de saída; (2) fato só
depois de gravado e só do banco — confirmação de cadastro é declarativa ("X cadastrado!
Vou te lembrar..."); "Anotei" só para captura intermediária; (3) nada do que a pessoa
disse é ignorado; (4) nunca reperguntar dado já dito; (5) confirmação de dose vence
qualquer fluxo; (6) honestidade em três níveis (inventário); (7) padrão não representável
→ recusa honesta, nunca gravação errada; (8) no máximo uma pergunta, no fim; (9) voz de
família, nunca de sistema (GUIA_COMPOSICAO); (10) mensagem proativa também é conversa.

**Emendas da v44 (evidência do replay):**
- **Regra 8**: a única coisa que pode vir DEPOIS da pergunta é UM exemplo curto que a
  ilustre ("Por exemplo: ..."), em linha própria — nunca conteúdo novo.
- **Conexão de contexto**: a abertura confirma a ação em curso, conectando o que a pessoa
  acabou de dizer com o que a Nami pergunta ("Certo! Vamos cadastrar o X pra você.").
- **Regra 6 do guia (micro-entrega, validação humana do A18)**: NUNCA repetir informação
  que a Nami acabou de dar na conversa recente — agradecimento/encerramento recebe
  fechamento curto e caloroso, sem reexplicação (aceno de porta aberta é permitido).

### 12.3 Decisões de produto do replay (19/09, revisam a v43)

- **Posologia composta primeiro**: a pergunta pede quantidade E horários juntos; faltando
  um pedaço, a pergunta seguinte cita o que já veio. Caminho invertido: formato composto
  primeiro, decomposição só no que faltar.
- **Resumo logo após a gravação** (revoga parte do §11.5): mensagem pós-gravação é
  determinística — declaração + resumo do banco (sem linha 📦 quando estoque NULL) +
  convite de estoque leve ("📦 *Estoque:* se você souber... Se não souber agora, tudo
  bem também."). Estoque respondido (ou "não sei") fecha curto; SEM etapa de confirmação.
- **Campos incidentais nunca se perdem** (P57): estoque ("tenho 40cps"), tratamento
  ("por 5 dias") e quantidade ditos junto da posologia são resgatados pelo extrator
  completo — que só preenche vazio, nunca sobrescreve o classificador especializado.
- **Dosagem pura nunca vira nome** (regra 7): "1000mg" em cad_nome é recusado e o nome
  reperguntado.

### 12.4 Arnês de regressão (M0)

`npm run arnes` — 20 casos-ouro (A1–A20) reproduzindo conversas reais de `agent_logs`
contra o código, com asserções determinísticas sobre texto final e banco. Banco de teste:
projeto de STAGING (guarda dura recusa o ref de produção; telefones `+5500000000xx`;
limpeza via `delete_user_account`). Mock no ponto do funil
(`configurarTransporteParaTestes`). Casos por marco com expected-fail para M2/M4
(A2-pleno, A10). NUNCA usar classificações do juizOffline como evidência. **Portão de
promoção: arnês 100% verde antes de todo merge para `main`.** Ver `arnes/README.md`.

### 12.5 Registros do encerramento

- Backlog (script `scripts/backlog_encerramento_v44.js`): **MH-95** criado/resolvido
  (citação de primeira classe) · **BUG-029** superseded → MH-95 · **BUG-103** resolvido
  antecipado (caso A9 verde) · **MH-77** remapeado M2 · **MH-96** criado (runner +
  multi-medicamento, ex-Fase 5) · **ACH-9** (porta classifica "med já cadastrado +
  dosagem" como consulta — Predsin, sem dano).
- Correções manuais de dados (19/09): staging — medications "1000mg" → Caltrat D/1000mg;
  produção — Nimesulida de Guilherme → temporário, 5 dias (tratamento_fim 24/09).
- T0 concluído: ver §6 item 21.

### 12.6 Micro-entrega pré-M2 (19/09, EM PRODUÇÃO — a0c426c)

Casos A16–A20 (transcrições reais de 30/08–02/09) + copy do recepcionista:

- **A16 Aline** (dano máximo do BUG-104): verdade de persistência asserida a cada turno;
  M2 expected-fail = 4 medicamentos, cada um com o horário DA SUA linha.
- **A17 Priscila** (intenção pura → lista só-nomes → "Pó"): coleta sem promessa vazia;
  apresentação não-representada reconhecida com honestidade (sachê/dose = unidade);
  nome nunca reperguntado; M2 = iterar a lista item a item.
- **A18 Juliana** ("é para outra pessoa"): copy nova do recepcionista — postura AINDA_NAO
  + caminho real de hoje OBRIGATÓRIO (a própria pessoa usar a Nami) + retomada; o turno
  de fechamento ("obrigado") originou a regra 6 do guia.
- **A19 Flávia** ("Regenesis e ofolato D"): gravado como um, a confirmação declara o nome
  exato do banco; M2 = dois registros com confirmação.
- **A20 Guilherme** ("Encerrar todos"): um-a-um atual documentado como evidência M3
  (MH-82/MH-39); `ORDEM_MARCOS` do arnês ganhou M3.

Correções de M1 forçadas pelos casos: entrada multi-medicamento usa a LINHA original do
1º medicamento (nunca a grade inteira da mensagem — regra 7) e semeia horários
compartilhados normalizados ("às HH:MM") direto no contexto (dado determinístico da
porta); o salto do extrator em cad_nome decide a etapa considerando o contexto já
coletado (P57).

**Guia do M2 (próxima janela):** critérios de aceite JÁ escritos e amarelos no arnês —
A2-pleno/A16-M2 (N medicamentos da mesma mensagem, horário por linha), A17-M2 (lista
iterada sem perda), A19-M2 (nome composto → dois registros), MH-77 (recorrência com
schema; validador M1 já garante a honestidade), MH-96 é o item guarda-chuva. A20 (M3) e
A10 (M4) ficam para as fases seguintes.

### 12.7 v44 — M2 (runner + schema): VALIDADO EM STAGING (19/09/2026, aguarda promoção)

**Estado explícito: validada em staging — NÃO está em produção.** Commits
`3b8f7ac..fca6b39` na branch `staging`; promoção pendente de: merge `staging` → `main`,
migrações `20260919100000` (MH-77) e `20260919110000` (MH-30) aplicadas em produção via
MCP, e o SQL da Manô (`scripts/sql_mano_recorrencia_producao.sql`, aprovação e execução
de Guilherme, com aviso a ela).

**Entrega (briefing `briefings/execucao_v44_m2.md`, 5 commits, arnês verde entre cada um):**

- `cadastro.js` (3.709 linhas, 13 etapas artesanais) morreu → `src/schemas/cadastro.js`
  (campos declarados como dado + TODAS as perguntas de coleta renderizadas em código,
  MH-85/P54) + `src/runner.js` (4 responsabilidades: o que falta — `proximaPendencia`,
  função ÚNICA; absorver; gravar por ponto único; devolver pelo contrato universal) +
  `src/validadores/*` (classificadores mudaram de ENDEREÇO, não de lógica). O cadastro
  não faz mais nenhuma chamada de LLM de geração — só classificadores. `sujeito` por
  tratamento modelado (default: o próprio usuário), nenhuma UI nova.
- **MH-96 multi-medicamento:** divisão determinística em N candidatos (linhas, " e ",
  vírgulas) no runner+extrator — os caminhos especiais da porta (§12.6) morreram. LOTE
  com confirmação única quando todos têm horário (A2-pleno/A16: cada um com o horário DA
  SUA linha); FILA que sobrevive a desvio e a pivô (A17); nome composto → dois registros
  com posologia compartilhada (A19); MH-83 absorvido (reset total no pivô, asserção A11).
- **MH-77 recorrência:** dias da semana por horário, dia sim/dia não (`intervalo_dias`),
  1x por semana com dia nomeado; validador PREENCHE em vez de bloquear (A3 grava seg-sex
  6h + sáb-dom 10h no MESMO turno); ciclos por semanas seguem AINDA_NAO. Consumidores de
  dose diária revisados: consumo POR SEMANA ÷ 7 (cobertura de estoque), balanço do dia,
  próximos medicamentos, preservação de dias em replace/reativação (ver §6 item 24).
- **MH-30 conclusão automática:** job diário 09:00 BRT desativa tratamento vencido e
  avisa PELO FUNIL (`proativo:conclusao_tratamento`); a RPC filtra `tratamento_fim` —
  dose de tratamento vencido nunca nasce (A21, com controle positivo).
- **MH-49:** alerta de estoque de temporário compara com os dias RESTANTES do tratamento
  (A22). O ramo antigo comparava tipo "agudo" — valor inexistente no CHECK, inalcançável.
- **MH-86:** estoque líquido num turno só (status+frascos+volume+fração; resgates
  determinísticos; A23). Absorve MH-73 C.1/C.2.
- **Guardas de construção (A0):** grep-guards do §8.2 do briefing como asserções
  executáveis (sendTextMessage só no funil; BUG-102 morto; escrita de schedules só em
  `database.js`; pergunta de coleta só no schema) + ACH-3 vivo (saveSchedule recusa
  horário duplicado) + ACH-4 (formato de dosagem).

**Arnês:** 24 casos (A0–A23), 169 asserções, 0 falhas no alvo M2; expected-fail apenas
A20 (M3) e A10 (M4). A0/A21/A22/A23 são determinísticos (rodam sem custo de LLM).

**Replay manual (Guilherme, 19/09):** Aline ×4 OK · horários por dia da semana OK ·
Priscila OK após 5 correções na própria sessão (ACH-10): divisão com fronteira de
palavra ("Vitamina D" nunca casa dentro de "Vitamina de A a Z"), alteração de medicamento
JÁ ATIVO despachada à configuração (nunca mais o beco "é só me dizer"), copy da fila
compacta com negrito, fila sobrevive ao pivô, e a decisão de produto de GRAMAS.
Conclusão automática (MH-30) validada só pelo arnês (A21), sem replay manual.

**Decisão de produto — gramas (19/09, Guilherme):** gramas ditos na posologia ("5gr às
10h", "10grs às 11h") são POSOLOGIA por horário, NUNCA dosagem do produto (a posologia
de pó varia por horário — caso real: creatina "1 scoop às 10h, 10grs às 11h, 1 sachê às
20h"). Até o MH-93 (repriorizado para alta), vale a convenção DECLARADA: cada dose de pó
= 1 unidade, coerção POR VALOR, e a resposta avisa a conversão (regra 7). Nada é escrito
em `dosagem` a partir de gramas.

**Backlog do encerramento (`scripts/backlog_encerramento_v44_m2.js`):** MH-96, MH-77,
MH-30, MH-49, MH-86, MH-85, MH-83, BUG-102, ACH-3, ACH-4 e MH-73 C.1/C.2 →
`em_validacao` (viram `resolvido` na promoção) · ACH-10 criado (achados do replay) ·
MH-93 repriorizado para alta com a decisão de gramas.

**Incidente registrado:** a chave da API Anthropic ficou temporariamente sem créditos no
meio da sessão (bloqueia porta e classificadores — derrubaria a Nami inteira) e voltou
sozinha. O arnês falha com clareza nesse cenário; os casos determinísticos continuam
rodando. Conferir o billing.

**Na promoção, além do fluxo do §7:** mover esta entrega para "em produção", remover
`cadastro.js` do §2.1/§2.2 (substituído por runner+schema+validadores) e flipar os 12
itens de backlog para `resolvido`.

