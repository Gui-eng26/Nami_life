# ENCERRAMENTO v37 — tarefas para o Claude Code

**Data:** 29/08/2026
**Entrega da sessão:** MH-081 (implementado, validado e fechado) + varredura de validação (8 itens fechados)

Este briefing tem três tarefas, nesta ordem:

1. Sobrescrever `CONTEXT.md` com o conteúdo da seção 1.
2. Aplicar as escritas em `backlog_items` da seção 2.
3. `git add` / `commit` / `push`.

⚠️ **Não há alteração de código nesta entrega.** O MH-081 já foi implementado, verificado
e validado em produção durante a própria sessão v37.

---

# 1. CONTEXT.md — conteúdo integral a sobrescrever

Substituir o arquivo `CONTEXT.md` na raiz do repositório pelo conteúdo entre as marcas
`<<<INICIO_CONTEXT>>>` e `<<<FIM_CONTEXT>>>` (as marcas não fazem parte do arquivo).

<<<INICIO_CONTEXT>>>
# CONTEXT.md — Nami Life

> **Fonte única de verdade do estado técnico e arquitetural do projeto.**
> Atualizado no encerramento de cada sessão. O backlog **não** vive aqui — vive em
> `backlog_items` no Supabase.

**Última atualização:** 29/08/2026 (encerramento da sessão v37)

---

## 1. O que é a Nami

Assistente de gestão de saúde no WhatsApp que ajuda pessoas a não esquecerem de tomar
seus remédios, sem instalar nenhum aplicativo novo. Para famílias que cuidam de idosos,
conecta paciente e cuidador, dando visibilidade do tratamento.

Público principal: idosos brasileiros. Modelo de monetização: B2B2C, via operadoras de
saúde e farmácias.

---

## 2. Arquitetura

**Stack:** Node.js · Supabase (PostgreSQL) · Railway (hospedagem) · Z-API (WhatsApp) ·
Anthropic Claude API · node-cron (agendamento).

**Supabase:** projeto `nputymewnwmnhrtpizzs`, região sa-east-1.
**Repositório:** `Gui-eng26/Nami_life` (público).

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
| `src/templates/dose.js` | **NOVO v37** — rótulo de quantidade da dose |
| `src/templates/estoqueTemplates.js` | Textos de estoque |
| `src/templates/adesaoTemplates.js` | Textos de relatório de adesão |
| `src/templates/balancoTemplates.js` | Textos de balanço |

---

## 3. Estado atual — o que está em produção

### 3.1 Entregue e validado

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

Consultar `backlog_items` com `status = 'em_validacao'`. Ao fim da v37 são dois itens:
MH-073 B.1 e MH-073 C.1 (reprovado, tratamento adiado).

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
9. Timestamps armazenados em UTC. Brasil é UTC-3.
10. SQL multi-statement em uma única chamada de `execute_sql` pode retornar só o último
    result set — usar chamadas separadas.

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
- Busca por telefone: `WHERE phone LIKE '%5519988491053%'`
- Pasta do Drive dos relatórios: `17uNtuBHOHw41FBc0zxZjx_-kjTW7bRmN`
- Cache-busting no GitHub: `?cb=$(date +%s%N)` em URLs raw, ou tarball via
  `codeload.github.com`. Aguardar ~8s após push antes de refazer o fetch.
- Schema de tabela:
  `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='X' ORDER BY ordinal_position`
- CHECK constraints:
  `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='X'::regclass AND contype='c'`
- Definição de função:
  `SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='X'`
<<<FIM_CONTEXT>>>

---

# 2. Escritas em `backlog_items`

⚠️ Este é um briefing de **manutenção em lote**, portanto SQL direto em
`backlog_items` está autorizado aqui. Em código de produção continua valendo a regra:
só através de `src/backlog.js`.

Todas as escritas abaixo foram autorizadas por Guilherme na sessão v37.

## 2.1 Fechamentos — oito itens validados

Cada um foi confrontado com evidência de banco ou de código antes do fechamento.
A evidência vai registrada no campo de resolução para auditoria futura.

```sql
-- MH-064 — degradar() produzindo eventos reais e distintos em produção
UPDATE backlog_items SET status = 'resolvido'
WHERE tipo = 'MH' AND numero = 64;

-- MH-071 — par natural em 28/08: mesmo "S", 43s de diferença, só o evento proativo mudou
UPDATE backlog_items SET status = 'resolvido'
WHERE tipo = 'MH' AND numero = 71;

-- MH-073 Parte C — 4 caminhos de estoque exercitados em produção com flags corretas
UPDATE backlog_items SET status = 'resolvido'
WHERE tipo = 'MH' AND numero = 73 AND parte = 'C';

-- BUG-090 — fechado na v36 e reforçado pelo cadastro de 28/08
UPDATE backlog_items SET status = 'resolvido'
WHERE tipo = 'BUG' AND numero = 90;

-- BUG-091 — verificado por leitura de código: o caminho não existe mais
UPDATE backlog_items SET status = 'resolvido'
WHERE tipo = 'BUG' AND numero = 91;

-- BUG-092 — 33 cadastros consecutivos retornando a idle, corte limpo em 20/08
UPDATE backlog_items SET status = 'resolvido'
WHERE tipo = 'BUG' AND numero = 92;

-- BUG-093 — resumos desde 26/08 usando unidade de dose, não forma farmacêutica
UPDATE backlog_items SET status = 'resolvido'
WHERE tipo = 'BUG' AND numero = 93;

-- BUG-101 — validado na v35: 5 chamadas ao classificador, zero duplicatas
UPDATE backlog_items SET status = 'resolvido'
WHERE tipo = 'BUG' AND numero = 101;
```

## 2.2 MH-081 — resolvido

Validado em produção em 28–29/08 por transcript do WhatsApp cruzado com `agent_logs`,
`eventos_proativos` e `dose_logs`. Sete cenários cobertos. Não passa por `em_validacao`.

```sql
UPDATE backlog_items
SET status = 'resolvido',
    causa_raiz = 'Implementado na v37. Módulo novo src/templates/dose.js (ponto único, puro): '
                 'formatarQuantidadeDose + linhaQuantidadeDose. Categoria do rótulo vem de '
                 'medications.unidade_dose (CHECK fechado: unidade|ml|gota); forma_farmaceutica '
                 'escolhe apenas o substantivo, via tabela normalizada sem acento com fallback '
                 '"unidade(s)". getPendingFollowUps ampliado com unidade_dose e embed '
                 'schedules!dose_logs_schedule_id_fkey(quantidade_por_dose). Quando '
                 'dose_logs.schedule_id é nulo, a linha é omitida (nunca assume 1) e registra '
                 'lembrete:quantidade_dose_indisponivel. Sem migration, sem LLM. '
                 'Validado em produção em 28-29/08 em 7 cenários: líquido com concentração '
                 '(Forten Xarope, 5 ml), deriva de acento (Betaistina "capsula" -> "1 cápsula"), '
                 'corte antes/depois no mesmo medicamento e horário, lembrete agrupado, '
                 'follow-up individual t2 e t3, follow-up agrupado. Suíte da função pura: 20/20.'
WHERE tipo = 'MH' AND numero = 81;
```

## 2.3 MH-078 — correção de descrição (autorizada)

A descrição atual afirma que o sítio de aplicação já é capturado. É falso, e isso
subdimensiona o item.

```sql
UPDATE backlog_items
SET descricao = 'Hoje "2 gotas em cada olho" é armazenado e exibido como quantidade total '
                '(4 gotas). Melhoria: exibir a forma de aplicação mantendo o total no cálculo '
                'de estoque e consumo.',
    causa_raiz = 'CORRIGIDO NA v37 (a descrição anterior estava errada). O classificador '
                 'classificarPosologia (cadastro.js, REGRA 2) devolve APENAS o booleano '
                 'multiplicador_aplicado — nunca o nome do sítio. "2 gotas em cada olho" e '
                 '"2 gotas nos dois ouvidos" produzem saída idêntica. O campo '
                 'multiplicadorAplicado é montado no parser e tem ZERO consumidores: não entra '
                 'em contextUpdates, não é persistido, não é renderizado. A tabela schedules '
                 'não possui coluna de sítio. Portanto o item NÃO é uma mudança de renderização: '
                 'exige alterar o contrato do classificador, criar coluna em schedules e '
                 'propagar até o texto.'
WHERE tipo = 'MH' AND numero = 78;
```

## 2.4 MH-073 Parte C.1 — evidência de reprovação

Permanece em `em_validacao` por decisão de Guilherme (tratamento adiado). A evidência
fica registrada para não se perder.

```sql
UPDATE backlog_items
SET causa_raiz = 'REPROVADO em teste de produção em 28/08/2026 (agent_logs, cadastro do '
                 'Forten Xarope). Sequência: usuário respondeu "Fechado com 100ml" -> Nami '
                 'perguntou "Quantos frascos"; usuário respondeu "1" -> Nami perguntou "E qual '
                 'o VOLUME desse frasco, em ml?"; usuário repetiu "100ml". O volume informado '
                 'na mensagem de status foi descartado, custando um turno a mais. Ramo '
                 '"fechado" (determinado) — a classificação do status funcionou; o que falhou '
                 'foi o aproveitamento do dado presente na mesma mensagem, que é o alvo da C.1. '
                 'Causa raiz ainda NÃO investigada (decisão de Guilherme: adiar).'
WHERE tipo = 'MH' AND numero = 73 AND parte = 'C.1';
```

## 2.5 MH-073 Parte D — remover a linha absorvida pelo MH-081

```sql
UPDATE backlog_items
SET descricao = '~34 pontos com unidade/unidades/comprimidos hardcoded — 7 em '
                'estoqueTemplates.js, 8 em cadastro.js, 6 em prompts.js, restante em '
                'relatorios.js, principal.js, configuracao.js, scheduler.js, '
                'adesaoTemplates.js. A exibição de quantidade nos lembretes e follow-ups '
                'saiu do escopo: foi entregue pelo MH-081 na v37. O módulo '
                'src/templates/dose.js criado lá é a peça compartilhada que esta parte deve '
                'consumir nos pontos restantes, em vez de reimplementar a formatação. '
                'Inclui também relatorios.js:403 (proximo_remedio), declarado fora do '
                'escopo do MH-081.'
WHERE tipo = 'MH' AND numero = 73 AND parte = 'D';
```

## 2.6 BUG-066 — hipótese avança para medição confirmada

```sql
UPDATE backlog_items
SET causa_raiz = 'PARCIALMENTE CONFIRMADO na v37 por medição direta em dose_logs. '
                 'CONFIRMADO: existe drift de ~1 segundo entre doses do mesmo grupo no '
                 'instante da criação (28/08 15:00 — Repoflor 14:58:01.389, Memoriol '
                 '14:58:02.203; 28/08 23:00 — 22:58:00.973 e 22:58:01.837; 29/08 07:00 — '
                 '06:58:03.043 e 06:58:04.205). CONFIRMADO: as quebras observadas têm '
                 'exatamente 2 minutos de separação, um tick do cron (15:28/15:30 e '
                 '00:30/00:32), enquanto o grupo das 07:00 saiu unificado. '
                 'AINDA INFERIDO: o encadeamento final entre o drift e o tick, porque '
                 'ultima_tentativa_at é sobrescrito a cada envio e não preserva o valor do '
                 'momento da decisão do follow-up. O drift sozinho não explica a '
                 'intermitência — ele existe nos três casos; o que decide é o alinhamento '
                 'com o tick, como a hipótese original já postulava. Fechar exige logar o '
                 'valor no momento da decisão (relacionado a MH-088).'
WHERE tipo = 'BUG' AND numero = 66;
```

## 2.7 Verificação após as escritas

Rodar e reportar o resultado:

```sql
SELECT tipo, numero, parte, titulo, status, prioridade
FROM backlog_items
WHERE status IN ('aberto','em_validacao')
ORDER BY prioridade, data_criacao;
```

**Esperado:** exatamente **dois** itens em `em_validacao` — MH-073 B.1 e MH-073 C.1.
Se aparecer um terceiro, alguma das escritas das seções 2.1 ou 2.2 não aplicou.

---

# 3. Commit

```
git add CONTEXT.md briefings/encerramento_v37.md
git commit -m "docs: encerramento v37 — MH-081 entregue e validado; 8 itens fechados"
git push
```

---

# 4. Instrução final

Se algum trecho deste briefing estiver incorreto ao ser confrontado com o repositório ou
com o banco, **corrija e reporte no resumo** em vez de aplicar literalmente. Em especial:
se alguma das linhas de `parte` não casar (`'C'`, `'C.1'`, `'D'`), verificar o valor real
na tabela antes de rodar o `UPDATE` — um `WHERE` que não casa não gera erro, só não
atualiza nada.