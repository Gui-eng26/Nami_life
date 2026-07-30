# ENCERRAMENTO — Sessão v26 (30/07/2026)

**Nota de formato:** o `CONTEXT.md` está com 1567 linhas. Seguindo a decisão da v25, este briefing
especifica **edições cirúrgicas exatas** em vez de reproduzir o arquivo inteiro. Aplicar na ordem.

**Tema da sessão:** captação e mapeamento de erros — preparar a observabilidade para o beta.

---

## 1. CONTEXT.md — Edição 1: cabeçalho

**Localizar** (as três primeiras linhas do arquivo):
```
# 🌿 NAMI — Contexto do Projeto (v25 — FECHADA: redesenho do fluxo de relatórios — balanco_do_dia,
canal de parâmetros, telemetria do Juiz Offline (MH-058); BUG-058 fechado após 3 semanas; 4 briefings
encadeados com 2 regressões próprias detectadas e corrigidas no mesmo dia — 29/07/2026)
```

**Substituir por:**
```
# 🌿 NAMI — Contexto do Projeto (v26 — FECHADA: sessão de captação de erros — degradar() e MH-064
T1 (5 pontos instrumentados), isolamento de falha por episódio + temperature 0 no juiz, fingerprint
estável (8 pontos), barreira de forma no envio, status_triagem 'nao_valida'; seções v23 e v24
reconstruídas no CONTEXT.md — 30/07/2026)
```

---

## 2. CONTEXT.md — Edição 2: estrutura de arquivos

**Localizar:**
```
│   ├── whatsapp.js              → Envio de mensagens e parse Z-API
```
**Substituir por:**
```
│   ├── whatsapp.js              → Envio de mensagens e parse Z-API. v26: BARREIRA DE FORMA no início de sendTextMessage — rejeita message não-string, registra a FORMA (nunca o conteúdo) em system_events e lança TypeError. Fica FORA do try de propósito (dentro, o catch da Z-API registraria um 2º evento com fingerprint diferente). Não muda o desfecho para o usuário: hoje o objeto já vira 400 → catch global → mesma mensagem educada
```

**Localizar:**
```
│   │                     payload NUNCA contém texto do usuário — só agent_log_ids.
```
**Substituir por:**
```
│   │                     payload NUNCA contém texto do usuário — só agent_log_ids.
│   │                     v26: try/catch POR EPISÓDIO + retry (3 tentativas, backoff 1s/4s, sem retry
│   │                     em 4xx exceto 429) — antes, uma 500 transitória abortava a varredura inteira.
│   │                     status da telemetria passa a ser DERIVADO de episodios_falha_julgamento.
│   │                     temperature: 0 — o juiz classifica, não redige; cada episódio é julgado uma
│   │                     única vez (idempotência), então oscilação vira falso negativo silencioso.
```

**Localizar:**
```
│       └── 20260729000000_juiz_offline_execucoes.sql     → tabela juiz_offline_execucoes (MH-058, v25), aplicada manualmente
```
**Substituir por:**
```
│       ├── 20260729000000_juiz_offline_execucoes.sql     → tabela juiz_offline_execucoes (MH-058, v25), aplicada manualmente
│       └── 20260730000000_status_triagem_nao_valida.sql  → 'nao_valida' no status_triagem de system_events e feedbacks (v26), aplicada manualmente
```

**Localizar** (na linha do `scheduler.js`):
```
│   ├── scheduler.js             → Cron: lembretes + follow-ups + resumo de adesão (domingo 16h — mudou de segunda 08h na v15) + juiz offline (03:00 BRT, v24)
```
**Substituir por:**
```
│   ├── scheduler.js             → Cron: lembretes + follow-ups + resumo de adesão (⚠️ '0 16 * * 0' SEM timezone — se o processo roda em UTC dispara 13:00 BRT, não 16:00; discrepância registrada na v24, a verificar nos logs do Railway) + juiz offline (03:00 BRT com timezone explícito, v24). v26: os 6 pontos de registrarEvento usam tituloEstavel(error, 'Erro no scheduler (<funcao>)') — prefixo por função, senão falhas de lembrete e de resumo semanal colapsariam no mesmo fingerprint
```

---

## 3. CONTEXT.md — Edição 3: nova seção da sessão v26

**Localizar** a linha:
```
## Backlog (BUG/FIX/MH)
```

**Inserir ANTES dela** o bloco abaixo (mantendo o `## Backlog` intacto depois):

```
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

### A cadeia real de 28/07 (origem do MH-065)

`agent_log e9cbd89b`, 28/07 21:01 BRT: `estado_conversa` **`idle`**, `contexto_conversa` `{}`,
`user_message` **`"S"`**.

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
```

---

## 4. CONTEXT.md — Edição 4: princípio 31

**Localizar** o fim do princípio 30:
```
    projeto: BUG-069 (1 de 6 call sites do `configuracao` sem interceptar escalada), BUG-065 (3
    cópias divergentes de alerta de estoque), BUG-036 (3 listas divergentes de termos de
    confirmação). O padrão comum é sempre o mesmo: **a cópia nasce por falta de um lugar comum, e
    depois diverge.**
```

**Substituir por:**
```
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
```

---

## 5. CONTEXT.md — Edição 5: ritual de encerramento

**Localizar:**
```
6. **Verificação obrigatória pelo Claude Code após aplicar as edições:**
   `grep -c "^## Sessão" CONTEXT.md` deve ter aumentado em exatamente 1 (ou pelo número de seções
   que o briefing declarou inserir). Relatar o número antes e depois.
```

**Substituir por:**
```
6. **Verificação obrigatória pelo Claude Code após aplicar as edições:**
   `grep -c "^## Sessão" CONTEXT.md` deve ter aumentado em exatamente 1 (ou pelo número de seções
   que o briefing declarou inserir). Relatar o número antes e depois.
7. **Todo briefing que instrumenta ou corrige uma CLASSE de defeito declara um comando de
   verificação que varre o projeto inteiro** — não a lista de pontos que o autor enumerou. Se o
   comando não voltar limpo, o trabalho não está concluído, independentemente do que o briefing
   listou (princípio 31, corolário).
```

---

## 6. Escritas em `backlog_items` (via `src/backlog.js`, nunca SQL direto)

### 6.1 Atualizar status

| tipo | numero | novo status | sessão | notas |
|---|---|---|---|---|
| MH | 57 | `superseded` | v26 | Fechado sem implementar, por decisão de Guilherme: rastrear ofertas espontâneas do principal como estado exige desenho de contexto novo, e não há caso real em produção que o justifique. **Gatilho de reabertura:** o Juiz Offline emitir `pedido_nao_atendido` ou `repeticao_sem_progresso` em episódio que começa com oferta espontânea do principal — aí existe o caso real e o item volta com dado. |
| MH | 64 | `em_validacao` | v26 | T1 entregue: helper `degradar()` em `observabilidade.js` (tabela `DEGRADACOES` com chave `origem:motivo`, severidade e título derivados) + 5 pontos instrumentados. T2 (`lembrete.js`, 4 catch que engolem tudo incl. falha de notificação a cuidador) e T3 (auditoria do restante contra os dois invariantes) seguem abertos. |

### 6.2 Atualizar notas (mantendo status)

| tipo | numero | status | notas a acrescentar |
|---|---|---|---|
| BUG | 69 | **`aberto`** | v26: correção da L473 avaliada e **deliberadamente adiada**. Volume: 1 ocorrência em todo o histórico. Corrigir troca um erro raro por risco de regressão no fluxo de escalada do `configuracao` (que existe para resolver becos sem saída, ex. correção de medicamento no meio do fluxo). Instrumentado pela barreira de forma em `sendTextMessage` (v26), testada em produção. **Gatilho de reavaliação:** evento `Payload inválido em sendTextMessage` aparecer em produção. Diagnóstico revisto: o vazamento é o último elo de uma cadeia de seis — causa a montante registrada no MH-065. |
| MH | 58 | `em_validacao` | Primeira execução (30/07 06:00 UTC) provou o valor da telemetria: detectou varredura incompleta (3 de 96 turnos) e o `erro_resumo` deu a causa raiz. Fechar após a execução de 31/07 confirmar cobertura completa. |

### 6.3 Inserir

| tipo | numero | titulo | status | prioridade | data_criacao |
|---|---|---|---|---|---|
| BUG | 80 | Juiz Offline abortava a varredura inteira no primeiro erro de API — try envolvia o loop, não o episódio | resolvido | alta | 2026-07-30 |
| BUG | 81 | Título de system_events com detalhe volátil interpolado quebrava o agrupamento por fingerprint em 8 pontos | resolvido | alta | 2026-07-30 |
| MH | 65 | Classificador central interpreta resposta curta contra o turno anterior errado — lembrete proativo não existe em agent_logs | aberto | media | 2026-07-30 |
| MH | 66 | Avaliar temperature explícito nas 5 chamadas de LLM restantes | aberto | baixa | 2026-07-30 |

**Descrição do BUG-80:** *"Execução de 30/07 06:00 UTC: 96 turnos, 11 episódios, apenas 3
avaliados, status falha_parcial por uma 500 transitória da API. `episodios_falha_julgamento = 0`
provava que a exceção escapou do loop sem ser contabilizada. Causa raiz: o `try` de
`executarJuizOffline` envolvia o loop inteiro. Corrigido na v26 com try/catch por episódio, retry
(3 tentativas, backoff 1s/4s, sem retry em 4xx exceto 429) e evento por episódio perdido. Armadilha
tratada junto: com o isolamento o loop passa a terminar mesmo com falhas, então o `status` da
telemetria passou a ser derivado de `episodios_falha_julgamento` — sem isso gravaria 'sucesso' numa
varredura incompleta."*

**Descrição do BUG-81:** *"`fingerprint = sha1(tipo|titulo|agent)` e o contrato escrito em
`observabilidade.js:16` exige título estável/templatizado. Violado em 8 pontos: `juizOffline.js`
(título carregava o request_id da API — cada 500 gerava fingerprint único), `agent.js`, e 6 em
`scheduler.js`. Impede a distinção transitório × persistente, que é a razão de existir do MH-052.
Corrigido na v26 com `tituloEstavel(error, prefixo)`, que deriva a classe do erro em vez de zerar o
conteúdo; nos 6 do scheduler o prefixo é por função. Fingerprints anteriores não foram
recalculados — o agrupamento vale a partir de 30/07. Os 6 pontos do scheduler não estavam no
briefing original; foram encontrados pelo comando de verificação do checklist (origem do corolário
do princípio 31)."*

**Descrição do MH-65:** *"O `scheduler.js` não escreve em `agent_logs`, então o lembrete proativo
não existe no `historicoConversa` que o classificador central consulta. Consequência: resposta
curta a um lembrete é interpretada contra o turno anterior visível, que pode ser de outro domínio.
Ocorrência: 28/07 21:01 (`agent_log e9cbd89b`) — lembrete do Ômega 3 às 20:58, usuário respondeu
'S' às 21:01, histórico visível era a conversa de configuração de 6 min antes (pausar lembretes do
Ômega 3), roteou para `configuracao`. A dose não foi confirmada e o usuário recebeu follow-ups às
21:28 e 22:30 cobrando o que já havia respondido. Contraprova: 30/07 15:48 (`agent_log b3a73e23`)
o mesmo 'S' em `idle`, com histórico sem viés, foi para `principal` e confirmou corretamente — o
defeito é condicional ao histórico enviesado, o que explica 1 ocorrência no período. NOTA:
`detectarConfirmacaoDose('S')` devolver `false` NÃO é o defeito; o caminho previsto (classificador
→ principal) funciona. Solução candidata: injetar o lembrete proativo no `historicoConversa`
reconstruindo de `dose_logs`, como o `enriquecerEpisodio` do Juiz Offline já faz. Efeito colateral
relacionado: `despacharEscalada` passa `currentState: 'configurando'` fixo, o que pode ser
informação falsa quando a escalada vem de `idle`."*

**Descrição do MH-66:** *"Nenhuma chamada de LLM do projeto definia `temperature` — todas herdavam
o default da API (1), por omissão e não por decisão. A v26 alterou apenas o juiz (`temperature: 0`,
caminho isolado, sem impacto no usuário). Restam: classificador central, principal, cadastro,
classificação interna da configuração e `gerarMoldura`. As quatro primeiras são classificação ou
produção de estrutura, onde variedade é ruído; `gerarMoldura` DEVE manter variedade (ela redige e é
proibida de citar dado factual — princípio 28). Hipótese não testada: a variabilidade contribui
para as falhas de parse (BUG-072 e o fallback de `principal.js`). O `stop_reason` instrumentado no
MH-064 T1 vai dar o dado para decidir. Não mexer nas chamadas do caminho quente do usuário sem essa
medição."*

---

## 7. Checklist para o Claude Code

1. `grep -c "^## Sessão" CONTEXT.md` — anotar o número antes (esperado: 10).
2. Aplicar as 5 edições do `CONTEXT.md` (seções 1 a 5), na ordem.
3. `grep -c "^## Sessão" CONTEXT.md` — deve ser **11**. Relatar antes e depois.
4. `grep -n "^## Sessão v26" CONTEXT.md` deve retornar exatamente 1 linha.
5. `wc -l CONTEXT.md` deve ter **aumentado** em relação às 1567 linhas atuais.
6. `git add -A && git commit && git push`.
7. Escritas em `backlog_items` (seção 6) via `src/backlog.js`.
8. Confirmar as escritas com query de leitura e relatar o resultado.