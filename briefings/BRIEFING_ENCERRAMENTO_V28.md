# BRIEFING DE ENCERRAMENTO — Sessão v28

**Data:** 01/08/2026 (trabalho) — encerramento em 05/08/2026
**Escopo:** cadeia de correções no fluxo de configuração (BUG-082→085) + reestruturação do contexto proativo (MH-70/71)

Claude Code deve executar, nesta ordem: (1) atualizações de backlog, (2) atualização do CONTEXT.md, (3) commit + push.

---

## PARTE 1 — Atualizações de backlog

Via `atualizarStatusBacklogItem` (`src/backlog.js`), nunca SQL direto.

```js
// BUG-082 — validado em 31/07 (9 casos do briefing), fechamento pendente desde então
await atualizarStatusBacklogItem({
    tipo: 'BUG', numero: 82, novoStatus: 'resolvido',
    notas: 'Validado em produção 31/07/2026 — 9 casos do briefing rodados. 8 passaram limpos; o caso 9 (resposta direta com horário em pos_alteracao) gerou achado que virou BUG-084, já resolvido. Fechamento formal feito no encerramento da v28.',
    dataFechamento: '2026-08-05'
});

// MH-70 — dados confirmados populando corretamente em produção
await atualizarStatusBacklogItem({
    tipo: 'MH', numero: 70, novoStatus: 'resolvido',
    notas: 'Validado em produção 01-05/08/2026 via consulta a eventos_proativos: os 5 tipos gravando corretamente (lembrete, follow_up, alerta_estoque_zerado, alerta_estoque_nao_informado, resumo_semanal), com medication_id, horario_agendado e enviado_at corretos. Instrumentação append-only funcionando conforme desenhado.',
    dataFechamento: '2026-08-05'
});

// MH-65 — substituído: sua implementação (reconstrução via dose_logs) não existe mais
await atualizarStatusBacklogItem({
    tipo: 'MH', numero: 65, novoStatus: 'substituido',
    notas: 'Substituído por MH-70 + MH-71 (v28). A implementação original (reconstrução do evento proativo a partir de dose_logs) foi inteiramente removida: a fonte de dados passou a ser a tabela eventos_proativos, e o filtro por status da dose foi identificado como erro de modelagem (misturava pergunta operacional com pergunta conversacional). NOTA DE HONESTIDADE: a validação do MH-65 nunca foi conclusiva — o cenário-alvo ("S" isolado em idle após lembrete → principal) apresentava sucesso em produção JÁ ANTES do deploy do fix (ocorrências de 30/07 anteriores ao deploy de 31/07 14:17 UTC), e a única falha registrada (28/07) foi na verdade o BUG-069 (objeto de escalada vazando literalmente), não falta de contexto proativo. O caso de teste é herdado pelo MH-71.',
    dataFechamento: '2026-08-05'
});
```

**Atualizações de nota (sem mudar status) — MH-67 e MH-68:**

```js
// MH-68 — escopo reduziu: getContextoProativoRecente não lê mais dose_logs
await atualizarStatusBacklogItem({
    tipo: 'MH', numero: 68, novoStatus: 'aberto',
    notas: 'ESCOPO ATUALIZADO na v28: getContextoProativoRecente passou a ler de eventos_proativos (MH-71), não mais de dose_logs. A sobreposição descrita originalmente (3 vias: getRecentDoses × temDosePendente × getContextoProativoRecente) virou 2 vias (getRecentDoses × temDosePendente).'
});

// MH-67 — a migração aproxima a convergência com o Juiz Offline
await atualizarStatusBacklogItem({
    tipo: 'MH', numero: 67, novoStatus: 'aberto',
    notas: 'NOTA v28: com o MH-70/71, o classificador central passou a reconstruir contexto proativo a partir de um log de eventos imutável (eventos_proativos) em vez de dose_logs. Se o Juiz Offline migrar para a mesma fonte, os contratos convergem naturalmente — este item fica mais próximo de ser viável.'
});
```

**Novos itens a registrar** — via `registrarItemBacklog`:

```js
// BUG-086 — o bloqueador principal identificado no fim da v28
await registrarItemBacklog({
    tipo: 'BUG', numero: 86,
    titulo: 'Confirmação válida ("Sim") é consumida pela máquina de estados sem consultar o classificador, mesmo após interrupção proativa da Nami',
    status: 'aberto', prioridade: 'alta',
    descricao: 'Reproduzido em produção 01/08/2026: usuário abre fluxo de configuração (Pausar Cataflam, 15:54), Nami envia follow-up proativo do Ômega 3 (15:56), usuário responde "Sim" (15:57) referindo-se ao follow-up — mas isConfirmacao("Sim") é verdadeiro em confirm_acao, então a máquina de estados executa a pausa do Cataflam sem nunca chamar o classificador. O contextoProativo é buscado (router.js linha ~613) e descartado sem uso, porque só é consumido no ramo de escalada. A escalada do BUG-082 não cobre este caso: ela só dispara quando a mensagem NÃO é reconhecida como confirmação. CAUSA RAIZ CONFIRMADA. Regra que falta (enunciada por Guilherme na v28): quando a Nami se intromete num fluxo aberto com mensagem proativa, uma confirmação curta não pode mais ser assumida como resposta à pergunta pendente — precisa ir ao classificador. DECISÃO DE ESCOPO EM ABERTO: restringir a configurando ou generalizar a todos os estados conversacionais. COMPLICAÇÃO IDENTIFICADA: despacharEscalada hoje reentra com currentState fixo e etapa identif_intencao, o que descartaria o fluxo pendente em vez de retomá-lo — resolver isso pode exigir mexer em como a escalada preserva a etapa, não só em quando dispara.'
});

// BUG-087 — achado lateral, não investigado
await registrarItemBacklog({
    tipo: 'BUG', numero: 87,
    titulo: 'Turnos com agent="erro" e agent_response=null em produção (6 ocorrências em 02/08)',
    status: 'aberto', prioridade: 'media',
    descricao: 'Encontrado durante consulta de validação da v28, não investigado. 6 turnos em 02/08/2026 com estado_conversa="erro", agent="erro" e agent_response=null, todos com user_message="Sim", de usuários reais (não do ambiente de teste). Precisa de investigação: verificar system_events e logs do Railway do período para identificar a causa. Relevante para MH-064 (degradação silenciosa) e MH-052 (monitoramento de erros técnicos).'
});
```

---

## PARTE 2 — CONTEXT.md

### 2.1 — Substituir o cabeçalho (linhas 1-4)

```markdown
# 🌿 NAMI — Contexto do Projeto (v28 — FECHADA: cadeia BUG-082→085 no fluxo de
configuração + MH-70/71 reestruturação do contexto proativo (tabela eventos_proativos
append-only substituindo reconstrução via dose_logs); BUG-086 identificado como
bloqueador da validação do MH-71 — 01-05/08/2026)
```

### 2.2 — Inserir nova seção de sessão, imediatamente ANTES da linha `## Backlog (BUG/FIX/MH)` (linha ~1715)

```markdown
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
```

### 2.3 — Adicionar dois princípios ao fim da seção "Princípios de Engenharia" (após o princípio 32, linha ~1895)

```markdown
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
```

### 2.4 — Atualizar a seção `## Banco de Dados — Supabase (PostgreSQL)` (linha ~179)

Adicionar `eventos_proativos` à lista de tabelas, no mesmo formato das demais:

```markdown
- **`eventos_proativos`** (v28, MH-70) — registro **append-only** de mensagens que a Nami enviou
  por iniciativa própria (`lembrete`, `follow_up`, `alerta_estoque_zerado`,
  `alerta_estoque_nao_informado`, `resumo_semanal`). Escrita no **instante do envio**, ponto único
  `registrarEventoProativo()` em `database.js`. Semanticamente distinta de `dose_logs` (estado
  mutável da dose) e de `agent_logs` (registro de intenção, escrito antes do envio, princípio 24):
  aqui cada envio gera uma linha própria que **nunca é sobrescrita**. Existe porque reconstruir
  histórico a partir de `dose_logs` perdia os follow-ups intermediários. `user_id` e
  `medication_id` com `ON DELETE CASCADE` (princípio 34).
```

---

## PARTE 3 — Commit

```
docs: encerramento v28 — BUG-082→085, MH-70/71, princípios 33-34
```

CONTEXT.md sobrescrito, commit e push.