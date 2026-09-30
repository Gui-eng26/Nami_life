# Briefing de execução — v47 Onda 1: dados e identidade (MH-100 parte A · BUG-114 · BUG-115)

Branch: `staging`. Fluxo padrão (v42 MH-89 C): implementar em staging → validar → merge em main no encerramento. `CONTEXT.md` não é tocado nesta execução.

**Restrição rígida de custo (29/09): o Claude Code não executa NENHUMA validação que dependa de chamada de LLM.** Nem via arnês, nem simulando turnos de usuário, nem disparando o webhook com mensagens de teste que cheguem ao principal. Todo o portão desta onda é composto de verificações sem LLM (§6). O que depende de LLM — precedência da citação (§3), comportamento do principal diante do evento `mensagem_direcionada` — é validado **manualmente pelo Guilherme** no staging, depois do portão verde.

## §0 — Contexto e objetivo

O desenho do ponto único de saída (MH-100) foi aprovado na v47: lógica de domínio produz **fatos tipados** → **compositor** (modo turno LLM / modo canônico determinístico) → **funil** com memória de assunto. A migração é em quatro ondas; esta é a **onda 1: dados e identidade** — nenhum compositor ainda, nenhum texto muda de comportamento (uma exceção de rótulo, ver §2). O objetivo prático: destravar o resgate (mensagem direcionada) e corrigir BUG-114 e BUG-115 pela causa raiz.

Causas raiz confirmadas na abertura da v47 (não re-derivar; evidência em produção, 29/09):

1. **BUG-114** — "Tomei" citando a mensagem final da cobrança da Creatina (09:02) confirmou o Ômega 3. Três camadas: (a) envios de `alerta_estoque_nao_informado` não chamam `vincularDosesAoEnvio` nem `updateDoseLogZapiMessageId` → citação resolve com zero doses, atalho exato desarma, principal recebe citação sem "→ grupo"; (b) a mensagem, no ramo `estoqueDesconhecido`, é puramente cobrança de dose mas carrega rótulo/casa de estoque → quadro interpretativo errado; (c) contrato do principal sem regra de precedência da citação. Tensão estrutural: `dose_logs.funil_envio_id` é 1:1 — só o último envio sobre a dose é citável com grupo.
2. **BUG-115** — `reverterConfirmacao` deriva o status por heurística (`tentativas < 3 → 'pendente'`, senão `'nao_tomado'`), conflando `nao_informado` (não respondeu) com `nao_tomado` (disse que não tomou) — uma afirmação que o usuário não fez, gravada no dado do inegociável. Decisão do Guilherme (29/09): **desfazer devolve a dose ao status anterior à confirmação errada.**

Inegociável de sempre: confirmar doses de forma correta e confiável, inclusive retroativas. Nada desta onda pode degradar o que funciona; toda migração de texto aqui é por **equivalência**.

## §1 — Vínculo envio ↔ assunto (N:N)

Nova tabela `funil_envio_assuntos`:

- `id`, `envio_id` (FK `funil_envios`), `fato` (text — ex.: `lembrete`, `follow_up`, `cobranca_encerrada`, `alerta_estoque_zerado`, `conclusao_tratamento`, `resumo_semanal`, `dose_confirmada`, `mensagem_direcionada`), `dose_log_id` (nullable), `medication_id` (nullable), `created_at`. Um envio, N linhas.

Passam a registrar assunto no ato do envio:

- **Proativas** (scheduler.js, lembrete.js, relatorios.js): lembrete individual e agrupado (uma linha por dose do grupo), follow-ups, cobrança encerrada (§2), alerta de estoque zerado, conclusão de tratamento, resumo semanal (linhas por medicamento do período; `dose_log_id` nulo).
- **Respostas de turno com fatos de dose** (router/dosesDoTurno): o turno já conhece os fatos executados pós-escrita — registrá-los como assunto do envio da resposta.

Resolução da citação (`processarTurno`): nova função `getAssuntoDoEnvio(envioId)` → doses/meds do assunto. `dosesCitadas` passa a vir daí. **Fallback legado:** para envios anteriores à migração (sem linhas de assunto), manter `getDosesDoEnvio` (via `funil_envio_id`) como segundo caminho. Não migrar dados retroativamente.

`dose_logs.funil_envio_id` e `updateDoseLogZapiMessageId` **permanecem** nesta onda (consumidores legados; remoção é avaliada na onda 3, com grep de consumidores). A fonte de verdade da citação passa a ser o assunto.

## §2 — Identidade da cobrança encerrada (camadas a+b do BUG-114)

O envio do ramo pós-esgotamento em `lembrete.js` (~190):

1. Origem do envio: `proativo:cobranca_encerrada` (substitui `proativo:alerta_estoque_nao_informado`). Evento proativo: tipo `cobranca_encerrada`, mantendo `medicationId` e `doseLogId`.
2. Passa a chamar `updateDoseLogZapiMessageId` e a registrar assunto (`fato: 'cobranca_encerrada'` + dose + med) — as duas amarras que o follow-up já faz e este envio não fazia.
3. **Texto: equivalência estrita.** Os dois ramos de `buildAlertaEstoqueNaoInformado` (com e sem estoque conhecido) saem byte-idênticos ao atual. A função pode ser renomeada (`buildCobrancaEncerrada`) sem mudar de casa; mover template é onda 3.
4. **Grep obrigatório de consumidores do rótulo antigo** antes do rename: dashboard, queries, observabilidade, `textoEventosProativos` (o contexto do principal precisa render o evento novo de forma legível — "cobrança encerrada do *X* de HH:mm"), filtros por `origem`. Todos migram juntos; nenhum consumidor pode continuar filtrando um rótulo que não existe mais.

## §3 — Precedência da citação (camada c do BUG-114)

No contrato do principal (prompt): quando o turno tem mensagem citada, **resposta curta de confirmação/negação refere-se ao assunto do envio citado**, com precedência sobre eventos proativos recentes e sobre a dose aberta mais recente. Regra pela motivação ("a pessoa está respondendo àquela mensagem"), nunca por lista de frases.

No bloco DOSES: com assunto resolvido, a linha `Mensagem citada:` sempre carrega o `→ grupo/refs` (hoje só quando `dosesCitadas` vem preenchido — com §1, passa a vir).

Validação deste contrato é **manual pelo Guilherme no staging** (decisão de 29/09: casos de arnês com LLM ficam fora do portão por custo).

## §4 — BUG-115: desfazer devolve ao status anterior

1. Nova coluna `dose_logs.status_pre_confirmacao` (text, nullable), gravada no momento da confirmação por **todas** as funções que confirmam: `confirmDoseByLogId`, `confirmarDoseRetroativa`, `confirmarDoseSemEstoque`.
2. `reverterConfirmacao` devolve a `status_pre_confirmacao`. Fallback apenas quando a coluna é nula (confirmações antigas): heurística corrigida — `tentativas < 3 → 'pendente'`, senão **`'nao_informado'`** (nunca mais `nao_tomado` por reversão).
3. Caso `sem_estoque`: devolve `sem_estoque`; a guarda existente de estoque (P49 — nunca re-incrementar o que não foi decrementado) permanece intocada.
4. Trilha: a reversão não pode apagar silenciosamente a trilha da confirmação (`revertido_*` é slot único). Requisito mínimo: registrar a transição completa (status anterior → confirmado → status devolvido, com motivo) em evento de observabilidade; forma a critério da implementação.

## §5 — Mecanismo de mensagem direcionada

Objetivo: Guilherme escreve/aprova uma mensagem individual; a Nami a envia pelo WhatsApp dela **sabendo que enviou**, para que a resposta da pessoa ("sim, pode") chegue ao principal com contexto.

1. Origem `proativo:mensagem_direcionada`; `registrarEventoProativo` tipo `mensagem_direcionada` (com resumo curto do conteúdo e, quando aplicável, `medicationId`); assunto no envio (§1) com os medicamentos referidos.
2. Script `scripts/enviar_mensagem_direcionada.js`: recebe telefone/usuário e o texto (argumento ou arquivo); resolve o usuário e mostra **preview completo** (destinatário, nome, texto, assunto registrado); **exige confirmação interativa explícita**; só então envia via funil e imprime `envio_id` + evento registrado. Sem confirmação, nada sai. Sem agendamento, sem lote.
3. O script **não redige nem altera** texto — o conteúdo vem pronto do Guilherme.
4. Nenhum disparo real nesta execução. O Claude Code pode testar o script **até o envio** ao número de teste do Guilherme em staging (envio via Z-API não custa LLM) e conferir no banco o envio + evento + assunto registrados. **Não pode** simular nem enviar resposta ao turno — a resposta atravessa o principal (LLM) e é validação manual do Guilherme (§0).

## §6 — Arnês e guards

Novos casos (todos sem LLM — o portão roda sem custo):

1. **Caso-ouro 29/09:** envio `cobranca_encerrada` vinculado + mensagem "tomei" citando-o → `avaliarAtalhoExato` (função pura) devolve a dose do assunto como candidata única; com envio **sem** assunto (legado), comportamento atual preservado via fallback.
2. **Desfazer:** confirmada com `status_pre_confirmacao='nao_informado'` → devolve `nao_informado`; `'pendente'` → `pendente`; `'sem_estoque'` → `sem_estoque`; coluna nula + tentativas esgotadas → `nao_informado`; trilha de observabilidade presente.
3. **Equivalência:** texto da cobrança encerrada byte-idêntico ao atual nos dois ramos.
4. **Grep-guard novo (§8.2 estendido):** todo envio com origem `proativo:*` que referencia dose/medicamento registra assunto — verificável por construção (o funil recebe o assunto no mesmo ato do envio) ou por grep das chamadas; requisito: regressão fica vermelha no portão.
5. Portão completo verde antes de declarar a onda pronta para validação.

## §7 — O que esta onda NÃO faz

- Não constrói o compositor nem altera o modo como o principal redige (onda 2).
- Não move builders de scheduler/lembrete para o catálogo (onda 3).
- Não reescreve nenhum texto da configuração (onda 4).
- Não remove `funil_envio_id` nem `zapi_message_id` legados.
- Não dispara nenhuma mensagem do resgate — o mecanismo é entregue testável; o uso é decisão do Guilherme após validação em produção.
- Não executa nenhuma validação que gere chamada de LLM (§0) — se um check parecer exigir LLM, ele está fora do portão e entra na lista de validação manual do relatório final (§8).

## §8 — Encerramento da execução

Ao final: relatar no chat do Claude Code (1) o resultado do portão (lista de checks, todos sem LLM), (2) os arquivos tocados e as migrações aplicadas no banco de staging, e (3) a **lista explícita do que ficou para validação manual do Guilherme** — no mínimo: precedência da citação (cenário "tomei" citando cobrança encerrada), desfazer em conversa real, e resposta a uma mensagem direcionada. Status de BUG-114/BUG-115 no `backlog_items` muda apenas no encerramento da sessão, pelo fluxo normal.