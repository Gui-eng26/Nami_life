# Briefing de execução — v47 Promoção: staging → main → produção (Etapa 1 completa)

**Restrição rígida de custo: o Claude Code não executa NENHUMA validação que dependa de chamada de LLM.** O smoke de produção é do planejamento + Guilherme, nunca deste briefing.

**O que está sendo promovido:** as Ondas 0–3 + ajuste-referente (commits de `f2ecbe7` a `3bd2239` e o que vier do §0), validados manualmente por Guilherme em 09/10, portão A0 + A61–A73 verde sem LLM. Backlog NÃO flipa aqui (fica para o encerramento da sessão). `CONTEXT.md` NÃO é tocado aqui (fica para o encerramento, no main).

## §0 — Antes do merge, ainda no staging

Marcar como **aposentados** os casos LLM do arnês escritos para o mundo pré-compositor (A40/A42/A43/A58 e demais que asserem texto canônico em turnos com fatos) — comentário referenciando o **MH-106** (corpus mínimo de casos-ouro, abertura da Etapa 2). **Sem rodar nada.** Commit no staging. Confirmar portão sem-LLM verde uma última vez.

## §1 — Migrações no banco de PRODUÇÃO (antes de qualquer deploy)

A única forma de esta promoção quebrar algo é inverter a ordem: código novo sem migração = erro em runtime; migração sem código novo = inofensiva (colunas nulas, tabelas vazias — todas aditivas). Portanto:

1. Levantar a lista completa das migrações da v47 aplicadas só no staging (`20260930000000`, `20260930100000` e as do ajuste — `funil_envio_assuntos` + coluna `detalhe`, `status_pre_confirmacao`, `eventos_proativos.resumo`, CHECK de `trilha_auditoria`, e o que mais houver na pasta de migrações).
2. Confirmar que cada uma é idempotente e autodocumentada (regra da casa); aplicar no projeto de produção (`nputymewnwmnhrtpizzs`).
3. **Verificar por leitura** (`information_schema.columns` / `pg_constraint`) que cada objeto existe em produção antes de prosseguir.

## §2 — Merge e deploy

1. Merge `staging` → `main`, push.
2. Railway produção deploya do `main`; confirmar deploy ativo e healthcheck do serviço.
3. Rodar o portão do arnês contra o `main` (sem LLM) — verde obrigatório.

## §3 — O que o Claude Code NÃO faz aqui

- Não simula turnos nem dispara webhook — o smoke é o primeiro turno real, verificado pelo planejamento em `agent_logs` (campo `composicao`, nomenclaturas), com Guilherme podendo mandar um "tomei" do número de teste.
- Não dispara nenhuma mensagem do resgate.
- Não flipa `backlog_items`, não edita `CONTEXT.md`, não faz merge `main` → `staging` (esse volta no encerramento, como sempre).

## §4 — Rollback, se necessário

Revert do deploy no Railway para o commit anterior do `main`. As migrações ficam — são aditivas e o código antigo as ignora com segurança (colunas novas nulas, tabela de assuntos sem leitores no código antigo).

## §5 — Relatório final

(1) Lista das migrações aplicadas em produção, cada uma com a verificação por leitura; (2) SHA do merge e do deploy ativo; (3) resultado do portão no `main`, check a check; (4) confirmação dos casos aposentados do §0; (5) uma linha: "pronto para o smoke do planejamento".