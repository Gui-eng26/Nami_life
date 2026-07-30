# BRIEFING — Ajuste do CONTEXT.md: reconstrução das seções das Sessões v23 e v24

**Sessão:** v26 (30/07/2026)
**Tipo:** correção de documentação. **Nenhuma alteração de código, schema ou template.**
**Nenhuma escrita em `backlog_items`.**

---

## Diagnóstico (contexto, não execução)

O `CONTEXT.md` tem seções de sessão de v17 a v22 e depois salta direto para v25. As sessões v23 e
v24 não têm seção própria. O conteúdo **não foi perdido** — está íntegro em
`briefings/encerramento_v23_tarefas_claude_code.md` e `briefings/encerramento_v24_juizoffline.md`.
As duas seções abaixo foram reconstruídas literalmente desses dois arquivos.

Duas causas distintas, ambas confirmadas por leitura dos arquivos:

1. **v23** — o briefing delegou a atualização do `CONTEXT.md` a uma ação manual fora do pipeline
   (*"atualizado manualmente por Guilherme (copiar/colar) — não precisa ser tocado por você"*) e
   **não embutiu o bloco a ser colado**. O passo não tinha artefato: falhou por construção.
2. **v24** — o briefing especificou apenas cabeçalho, princípios 24-26 e a entrada de
   `juizOffline.js` na estrutura de arquivos. Não pediu seção de sessão. O Claude Code executou o
   briefing corretamente; o briefing é que estava incompleto.

Padrão comum: **a seção de sessão não é herdada do ritual — ela existe só quando o briefing a
escreve explicitamente.** Mesma forma dos princípios 29 (observabilidade é opt-in) e 30 (o call
site esquecido volta silenciosamente ao comportamento antigo).

**Nota de formato:** seguindo a decisão da v25, este briefing especifica **edições cirúrgicas
exatas** em vez de reproduzir o arquivo inteiro (reprodução integral é propensa a perda silenciosa
de conteúdo). Aplicar na ordem.

**O cabeçalho do `CONTEXT.md` NÃO muda.** Ele descreve a última sessão fechada (v25) e a v26 ainda
está aberta. As duas seções reconstruídas carregam nota própria de reconstrução — o rastro de
quando e por que foram escritas fica no arquivo, não é reescrita silenciosa de histórico.

---

## Edição 1 — inserir as seções v23 e v24

**Localizar** a linha (é única no arquivo):

```
## Sessão v25 (29/07/2026) — MH-058 (telemetria do Juiz Offline) + redesenho do fluxo de relatórios
```

**Substituir por** todo o bloco abaixo (a linha localizada reaparece no fim do bloco — não
duplicar, não remover):

```
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
```

---

## Edição 2 — fechar a lacuna de processo no ritual de encerramento

**Localizar:**

```
### Ritual de encerramento de sessão
1. Gerar relatório .docx e apresentar para download (upload manual no Drive)
2. Gerar briefings/encerramento_vN.md com o CONTEXT.md atualizado para o Claude Code commitar
3. Incluir no encerramento a lista de escritas em `backlog_items` (inserts/updates) — este chat é
   READ-ONLY no Supabase; todas as escritas de backlog são responsabilidade do Claude Code.

⚠️ **Lição registrada (v13):** conferir que o nome do arquivo `encerramento_vN.md` bate com o
número de versão do CONTEXT.md que ele gera *antes* de salvar.
```

**Substituir por:**

```
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

⚠️ **Lição registrada (v13):** conferir que o nome do arquivo `encerramento_vN.md` bate com o
número de versão do CONTEXT.md que ele gera *antes* de salvar.

⚠️ **Lição registrada (v26):** as seções das sessões v23 e v24 faltaram no CONTEXT.md por duas
causas distintas — a v23 delegou a edição a uma ação manual e não embutiu o bloco a colar; a v24
especificou cabeçalho, princípios e estrutura de arquivos mas não pediu a seção. Em nenhum dos dois
casos houve perda de conteúdo (os briefings estavam íntegros no repositório), e em nenhum dos dois
o Claude Code errou. **A seção de sessão não é herdada do ritual — ela existe só quando o briefing
a escreve.** Mesma forma dos princípios 29 e 30, aplicada ao processo em vez do código. Os itens
4 a 6 acima existem para tornar isso verificável em vez de confiável.
```

---

## Checklist para o Claude Code

1. `grep -c "^## Sessão" CONTEXT.md` — **anotar o número antes** (esperado: 7).
2. Aplicar a Edição 1 (inserir as seções v23 e v24 antes da seção v25).
3. Aplicar a Edição 2 (ritual de encerramento).
4. `grep -c "^## Sessão" CONTEXT.md` — deve ser exatamente **9** (aumento de 2). Relatar antes e
   depois.
5. Confirmar que a seção da v25 continua íntegra e aparece **uma única vez**:
   `grep -n "^## Sessão v25" CONTEXT.md` deve retornar exatamente 1 linha.
6. Confirmar que nada foi perdido no fim do arquivo: `wc -l CONTEXT.md` deve ter **aumentado**
   (nunca diminuído) em relação às 1360 linhas atuais.
7. `git add -A && git commit -m "docs: reconstrói seções v23 e v24 no CONTEXT.md + invariante de seção de sessão no ritual de encerramento" && git push`.

**Não alterar código.** **Não escrever em `backlog_items`.** **Não alterar o cabeçalho do
CONTEXT.md** — ele descreve a última sessão fechada (v25) e a v26 está aberta.