# Briefing de execução — v47 Onda 2: proativas por equivalência (MH-100 parte C)

Branch: `staging`, em cima do estado atual (Ondas 0 e 1 aplicadas). Fluxo padrão. `CONTEXT.md` não é tocado nesta execução.

**Restrição rígida de custo (29/09): o Claude Code não executa NENHUMA validação que dependa de chamada de LLM.** Esta onda nem deveria tentar: ela não toca nenhum caminho de LLM. O portão é 100% determinístico.

**Natureza da onda: refatoração por equivalência estrita.** Nenhum texto muda. Nenhum comportamento muda. Diferença visível para o usuário: **zero, byte a byte.** Qualquer melhoria de texto que parecer óbvia no caminho NÃO entra — vira nota no relatório final para decisão do Guilherme. Regra do projeto: se uma capacidade que funcionava piorar, a primeira verificação é comparar com a versão anterior — esta onda existe para que não haja o que comparar.

## §0 — Objetivo

Hoje os textos proativos moram em três casas: `templates/` (estoque, adesão, balanço), builders locais em `scheduler.js` (`buildReminderMessage`, `buildGroupedReminderMessage`, `buildGroupedFollowUpMessage`, textos de `alerta_estoque_zerado` e `conclusao_tratamento`) e builder local em `agentes/lembrete.js` (`buildFollowUpMessage` + helpers como `capitalize`). Esta onda unifica a **autoria**: todo texto proativo vira renderização canônica do catálogo de fatos, em `templates/`, e scheduler/lembrete passam a produzir o **fato tipado** e pedir a renderização — nunca mais montar string.

## §1 — O catálogo como módulo

Novo módulo `templates/catalogo.js`: o mapa único `fato → função de renderização canônica`.

- Entradas desta onda: `lembrete` (individual e agrupado), `follow_up` (tentativa 1 e 2, individual e agrupado), `cobranca_encerrada` (os dois ramos — a função já renomeada na Onda 0, que pode permanecer fisicamente em `estoqueTemplates.js`), `alerta_estoque_zerado`, `conclusao_tratamento`, `resumo_semanal` (aponta para a montagem existente em `adesaoTemplates`).
- Entradas que a Onda 1 criou para o fallback do compositor (fatos de dose e estoque do turno) migram para o mesmo mapa — **um** ponto de lookup para canônicos, usado por scheduler, lembrete, atalho exato e âncora/fallback.
- `mensagem_direcionada` entra no mapa como pass-through (o texto vem pronto do Guilherme; o catálogo não redige).
- O fato tipado carrega tudo que o builder atual recebe (reminder, doses do grupo, tentativa, quantidade, nome) — os campos viram estrutura explícita; a assinatura interna é a critério da implementação, o texto de saída não.

## §2 — Movimentação por equivalência

Método obrigatório, nesta ordem:

1. **Fotografar antes:** para cada builder e cada variação (individual/agrupado, tentativa 1/2, com/sem quantidade, 1/2/3+ medicamentos, ramos da cobrança), capturar a saída atual como fixture com entradas fixas.
2. Mover a função para `templates/` (casa por domínio) e registrá-la no catálogo.
3. Scheduler/lembrete passam a chamar via catálogo, produzindo o fato.
4. **Provar depois:** cada fixture reproduz byte-idêntico pela nova rota. Divergência de um caractere = a onda não está pronta.

Helpers locais (`capitalize` e afins): movem juntos ou apontam para os equivalentes já existentes em `templates/` — desde que a saída fique idêntica (fixtures decidem, não opinião).

## §3 — Grep-guards novos (estendendo o §8.2)

1. Nenhum template literal de mensagem ao usuário em `scheduler.js`, `agentes/lembrete.js` e `agentes/relatorios.js` — texto proativo vive só em `templates/`.
2. Nenhuma renderização canônica fora do catálogo: o lookup `fato → texto` acontece só via `templates/catalogo.js` (atalho, âncora e proativas inclusos).

## §4 — O que esta onda NÃO faz

- Não muda um caractere de nenhum texto (melhoria sugerida = nota no relatório, decisão do Guilherme).
- Não toca compositor, principal, porta, decisão, nem nenhum caminho de LLM.
- Não toca jornada, coleta, configuração (Onda 3 / Etapa 3).
- Não muda rótulos de origem nem eventos proativos (feito na Onda 0).
- Não remove nada legado além dos builders movidos (que deixam de existir na casa antiga — mover, não duplicar).

## §5 — Arnês e relatório final

Portão: todas as fixtures de equivalência (§2) + grep-guards (§3) + portão anterior das Ondas 0–1 verde. Relatório: (1) checks; (2) tabela builder antigo → casa nova → fixtures que o cobrem; (3) notas de melhoria de texto observadas no caminho (sem aplicar); (4) validação manual do Guilherme — leve nesta onda: receber em staging um lembrete e um follow-up reais e confirmar que nada mudou aos olhos dele.