# BRIEFING DE EXECUÇÃO — v44 · M3: Configuração + Relatórios no runner

**Pré-requisito:** arnês 24/24 verde (expected-fail só A10/M4 e A20, que este marco fecha).
**Branch:** `staging`; promoção por marco (MH-89 C); arnês verde é o portão de merge.
**Governança:** nenhuma escrita em `backlog_items` a partir deste briefing.
**Fonte de verdade:** CONTEXT.md §12 + Constituição v1+emendas + este briefing.

---

## 0. Objetivo

`configuracao.js` (1.061 linhas, 10 ações artesanais, mensagens hardcoded) e os pontos fracos de `relatorios.js` (700 linhas) entram na arquitetura-alvo: edição vira o schema do cadastro em modo correção, reativação vira fluxo completo com estado explícito, relatórios ganham escopo e período livres, e as duas últimas chamadas LLM em JSON-texto-livre do sistema migram para tool-use. O motor de templates dos relatórios e o **copy do resumo semanal NÃO mudam** (decisão de Guilherme: funciona bem).

## P1 — Estado explícito do tratamento (fundação)

Hoje "pausado" é inferido (medicamento `ativo=true` com zero schedules ativos) — por isso a lista mistura, a reativação é cega e pausado×encerrado se confundem (BUG-61).

- Migração aditiva: `medications.status` com CHECK `('ativo','pausado','encerrado')` + `status_alterado_em`. Backfill inferindo o estado atual (ativo=false → encerrado; ativo com schedules todos inativos e ≥1 schedule → pausado; senão ativo). `ativo` boolean permanece durante o M3 como derivado (compat), com remoção avaliada no encerramento.
- A "foto congelada" da reativação são os próprios schedules preservados com `ativo=false` (incluindo `dias_semana`/`intervalo_dias` do M2 — preservação já garantida, ver CONTEXT §6 item 24).
- Pausar/encerrar/reativar escrevem `status` por ponto único em `database.js`.
- **MH-31 nasce aqui:** histórico de encerrados consultável ("quais tratamentos eu já encerrei?") — leitura simples por `status='encerrado'`.

## P2 — Edição = schema do cadastro em modo correção

O runner ganha o modo `corrigir(campo)` sobre um tratamento existente. Campos editáveis: **nome** (digitou errado), **dosagem**, **quantidade por dose**, **horários** (com recorrência do M2), **duração do tratamento** (encurtar/prolongar — recalcula `tratamento_fim`; parte de prorrogação do MH-43), **estoque**. Cada um usa o validador que já existe no schema; nenhuma pergunta nova fora dele.

- **Dados pessoais (MH-75):** segundo schema mínimo (`schemas/perfil.js`: nome, data de nascimento — reaproveitando o validador de data existente) no MESMO runner.
- **Regra de verdade (MH-41 absorvido):** alteração/remoção de horário CANCELA a dose pendente do horário antigo no mesmo ato (asserção A26) — nunca mais follow-up de horário que não existe.
- **MH-79 absorvido:** apresentação diferente do mesmo medicamento = novo tratamento com nome qualificado, oferecido quando a edição de forma/dosagem indica produto distinto.
- Confirmação de cada edição é template pós-escrita declarando o ANTES → DEPOIS (regra 2).

## P3 — Reativação em 5 passos, com duas portas

Fluxo (decisão de Guilherme): 1) mostrar remédio + posologia + horários congelados no pause; 2) "manter assim ou mudar algo?"; 3) alterações via P2; 4) confirmar reativação (+alterações); 5) convite de estoque — MESMO template do cadastro (tom de convite, porta de saída).

- **Porta 1:** pedido explícito ("reativar X").
- **Porta 2:** tentativa de cadastrar medicamento que já existe `pausado` OU `encerrado` → a Nami avisa, mostra a foto e oferece reativar/recadastrar — fecha o par com o M2 (que já despachava o caso `ativo` à configuração) e **mata o BUG-61**.
- Mensagem do passo 4 declara os horários que valem a partir de agora (nunca mais "reativados" sem dizer quais).

## P4 — Relatórios: escopo e período livres

1. **Pergunta sobre UM medicamento responde sobre ELE.** O defeito é de roteamento: `relatorioMeusRemedios(user)` nem recebe a mensagem. Correção: a porta/Camada 2 passa `params.medicamento` e o subtipo com medicamento resolvido rende a visão daquele tratamento (posologia, horários, status, estoque, últimas doses). `resolverMedicamento` já existe.
2. **Lista completa ordenada `Ativos` → `Pausados`** (com cabeçalhos), via P1. Encerrados só sob pedido (MH-31).
3. **Período livre:** `validarJanela` de leitura passa a aceitar qualquer data ≥ `users.created_at` e intervalos ("de segunda a quarta", "semana passada", "dia 5"). A separação já existe no código: `JANELA_CONFIRMACAO_RETROATIVA_DIAS = 2` NÃO muda — além dela é leitura pura, sem oferta de confirmação (comportamento já especificado no prompt da moldura; vira asserção A28).
4. **Adesão reativa morre inteira (7/15/30)** — pedidos de adesão caem no período livre. O subtipo `adesao` e `extrairPeriodo` saem; a porta redireciona.
5. **Epistemologia de status vira asserção transversal (A31):** confirmado ≠ tomado. "Quais remédios tomei hoje?" responde com o que foi CONFIRMADO e o que ficou sem resposta — nunca "você não tomou" para `semRegistro`. A regra já está no prompt da moldura; o arnês a trava em todos os textos (incluindo `sem estoque` apenas quando houver estoque cadastrado).
6. **Copy dos diários revisto** sob a constituição (uma pergunta no fim, tom, negrito) — **semanal intocado**.
7. Correções pontuais de carona: **MH-63** (janela "agora" do próximo remédio alinhada ao enquadramento do balanço — sem "está na hora" 30 min antes), **MH-50** (bloco "insuficiente" do progresso com estoque real e fraseado correto quando cobertura=0), **MH-62** (decisão de escopo do `proximo_remedio` documentada no PR com base nos logs de uso).
8. **MH-60 — achado da verificação (20/09):** a cobertura por dias JÁ existe nos alertas (e o M2 a ajustou para consumo semanal ÷ 7); o subtipo "reposicao" citado no item nem existe mais. O que NÃO existe é ordenação da lista de estoque por cobertura. Fazer: `relatorioEstoque` ordena por dias de cobertura crescente (mais urgente primeiro). Uma linha de sort; fecha o item.

## P5 — Elegibilidade do proativo (cron de domingo 16h)

- Resumo **semanal**: só usuários com **>7 dias** de Nami (`users.created_at`).
- Fechamento **mensal** (a cada 4 semanas, mesmo cron): só **>28 dias**.
- Implementar como função pura `elegivelParaResumo(user, tipo, hoje)` → testável sem LLM (asserção determinística A29). Quem não é elegível simplesmente não recebe — sem mensagem substituta.

## P6 — Confiabilidade transversal do marco

1. **BUG-86 (resíduo) — precedência de confirmação curta com dupla pendência:** confirmação curta com pergunta de fluxo pendente E dose pendente → vence **a pergunta feita por último**; em ambiguidade genuína (as duas na mesma janela), pergunta de desambiguação de uma linha. Caso A30 em duas partes: (a) o cenário registrado de 01/08 (coleta aberta + follow-up + "Sim") asserido no comportamento pós-M1 — se verde, a parte registrada do bug morreu no M1; (b) o inverso (usuário em `confirm_acao`, dose chega no meio, "Sim" era para a ação) resolvido pela regra da pergunta mais recente.
2. **Tool-use nas duas chamadas JSON-texto-livre restantes:** `classificarIntencao` do configuracao e a moldura dos relatórios — mesmo padrão da porta (schema + 1 retry + degradar). Zera a família `parse_json_falhou` no sistema (asserção A0 estendida: nenhum `JSON.parse` de saída de LLM fora de tool-use).
3. **Contrato universal completo no configuracao:** escalada devolve com estado/etapa REAIS (mata BUG-69 e ACH-5) e registra sinal em `agent_logs` (MH-48).
4. **Lote (MH-82/39):** "encerrar todos" / seleção múltipla com UMA confirmação agregada — **A20 vira verde**. Vale também para pausar em lote (mesmo mecanismo, custo marginal zero).
5. **Mensagens hardcoded viram templates sob a constituição (MH-47)** — inclusive `isConfirmacao` deixa de decidir sozinho: confirmações curtas passam pela regra do item 1; **BUG-36 morre aqui** ("manter horários"/"manter" reconhecido como confirmação de manutenção no novo fluxo — verificação de 20/09: o termo continua FORA da lista atual de `isConfirmacao`, linha 307).
6. **MH-51:** pergunta de esclarecimento no meio de pausar/encerrar reconhecida como dúvida (contrato: `duvida` → responde → retoma), não como ruído.
7. **MH-27 fica FORA (decisão de Guilherme)** e entra no inventário **AINDA_NAO**: "ajustar o horário de UMA dose pontual (hoje/só desta vez)" → resposta honesta com expectativa; oferecer o que já existe (alterar o horário fixo, ou confirmar retroativo depois).

## Arnês — casos novos (numeração após A23)

| Caso | O quê | Asserções-chave |
|---|---|---|
| A24 | Reativação 5 passos (porta 1) | foto congelada exibida (horários+posologia+recorrência); "manter ou mudar"; confirmação declara horários vigentes; convite de estoque no template do cadastro |
| A25 | Porta 2 — cadastrar med pausado/encerrado | aviso + foto + oferta; BUG-61: recadastro pós-encerramento avança; nunca registro duplicado silencioso |
| A26 | Edição (nome, dosagem, qtd/dose, duração, horário) | template antes→depois pós-escrita; dose pendente do horário antigo CANCELADA (MH-41); duração recalcula `tratamento_fim` |
| A27 | Pergunta sobre medicamento específico | responde sobre ELE (nunca a lista completa); dados do banco |
| A28 | Período livre | dia antigo qualquer = leitura pura sem oferta de confirmação; dia ≤2d mantém oferta; intervalo funciona; data anterior ao `created_at` → resposta honesta |
| A29 | Elegibilidade proativa (determinístico) | função pura: <7d sem semanal; <28d sem mensal; ≥ recebe |
| A30 | BUG-86 duas partes | (a) cenário 01/08 pós-M1; (b) dupla pendência → pergunta mais recente vence |
| A31 | Epistemologia de status (transversal) | nunca "não tomou" para `semRegistro`; "tomei hoje?" = confirmados + pendências; "sem estoque" só com estoque cadastrado |
| A20 | (existente) | vira verde com o lote |

## Commit 0 — Correção quente (defeito de produção 20/09, caso Evandro)

Evidência: Evandro, 20/09 12:51, produção — "Marevan 1 comprimido às 17hs / Kepra 1 comprimido às 19hs". O lote não disparou; o 2º medicamento entrou na fila sem a posologia da própria linha; a correção de nome "Keppra" na etapa de estoque foi engolida. Causa raiz confirmada empiricamente.

1. **`RE_HORARIO` (`validadores/recorrencia.js:49`) aceita as variantes reais de sufixo:** `hs`, `hrs`, `hr` (além de `h`, `horas`, `:`). Teste executado na sessão: `"às 17hs"` → `[]` com a regex atual. Um lugar só — propaga para divisão multi-med, recorrência e porta (todos usam a mesma regex).
2. **Caso A32 no arnês (variante Evandro):** input real com "às 17hs" em duas linhas → lote dispara, os DOIS gravados com o horário da sua linha, zero repergunta de dado presente. (O A16 usa formato ":" — lacuna de variante que deixou o arnês verde com produção falhando.)
3. **Correção de campo na etapa de estoque — matriz do A9 completa:** mensagem não-numérica na pergunta de estoque passa pela interpretação antes do repergunta; correção de NOME (e de tipo) é aplicada e o fluxo segue ("Keppra" → renomeia e repergunta o estoque do nome certo). Asserção estendendo A9/A32. Cobre a célula "nome" do escopo original do BUG-103 sem item novo de backlog.
4. **Resposta ao convite de estoque agregado (fila/lote):** o convite diz "de cada um", mas não existe atribuição por nome na resposta. Passa a aceitar: (a) forma nomeada — "Marevan 30, Kepra 29" — com atribuição por nome usando a fronteira de palavra que já existe em `multiMed.js`; (b) número seco APENAS quando há um único medicamento sem estoque no contexto — havendo mais de um, pergunta de qual é (uma pergunta, última linha). Asserção no A32.

Correção de dado do usuário real (Kepra → Keppra) é ação de Guilherme fora do briefing — **executada em 20/09**.

## Sequência de commits sugerida (arnês entre cada um)

0. **Commit 0** (correção quente acima) → A32 verde. Sai na frente de tudo e pode ser promovido sozinho se o restante do M3 demorar — produção tem usuário real batendo nesse formato hoje.
1. **P1** estado explícito (migração + backfill + ponto único) — paridade de comportamento, só a lista ganha ordenação. O commit de fundação, isolado.
2. **P6.2–P6.3** tool-use + contrato universal — confiabilidade antes de mexer nos fluxos.
3. **P2** edição via runner (+ schema perfil) → A26.
4. **P3** reativação (2 portas) → A24/A25.
5. **P4** relatórios (roteamento, período, morte da adesão reativa, carona MH-60/62/63/50, copy diários) → A27/A28/A31.
6. **P5** elegibilidade + **P6.4** lote + **P6.1** precedência + **P6.7** inventário MH-27 → A29/A30/A20.

## Critérios de aceite

1. Arnês 100% no alvo M3 (≈32 casos, A32 incluído); expected-fail restante APENAS A10 (M4); nenhum caso regredido.
2. A0 estendida: zero `JSON.parse` de saída de LLM fora de tool-use em TODO o sistema.
3. Replay manual (Guilherme): reativar com alteração de horário · corrigir nome digitado errado · "quais remédios eu tomei terça?" · pergunta sobre um medicamento específico · "encerrar todos" · alguém com <7 dias NÃO recebe o semanal de domingo.
4. Semanal: copy byte a byte igual ao atual para usuários elegíveis (asserção de não-mudança).

## Fora de escopo do M3

Onboarding/`recepcionista`/`data_nascimento` (M4) · MH-93 (alta — domínio do cadastro/estoque de pó; candidata a micro-entrega própria pós-M3) · MH-73 D e E (alta — varredura de textos de apresentação e frasco lacrado; entrega própria) · exclusão de conta (funciona; intocada) · care_network/áudio/foto · MH-44 (Jornada 2) · MH-27 (só a honestidade entra).

## Registros para o encerramento (dependem de "sim, registra")

- **Verificados em 20/09:** ACH-1 → `resolvido` (reversão devolve o delta efetivamente debitado via `calcularDeltaEstoqueDaDose`, com guarda P49 para NULL — `database.js:1053`) · MH-60 → resolvido com a linha de ordenação do P4.8 · BUG-36 → morre no P6.5 (termo confirmadamente ausente da lista atual).
- **Caso Evandro (20/09):** registrar no §12 do CONTEXT como defeito de produção do M2 corrigido pelo Commit 0 (regex de horário "hs" + matriz de correção na etapa de estoque + atribuição do estoque agregado); correção de dado (Kepra→Keppra) executada por Guilherme em 20/09. Sem item novo de backlog — coberto por A32.
- **Resolvidos pelo M3:** MH-75, MH-79, MH-41, MH-31, MH-47, MH-51, MH-82, MH-39, MH-62, MH-63, MH-50, BUG-61, BUG-69, BUG-86, ACH-5, MH-48; MH-43 parcial (prorrogação via edição de duração; pós-encerramento e alertas vencidos permanecem).
- MH-27 permanece aberto como feature, com a honestidade entregue.