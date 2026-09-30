# Briefing de execução — v47 Onda 1: compositor modo-turno (MH-100 parte B)

Branch: `staging`, em cima do estado atual (Onda 0 aplicada). Fluxo padrão. `CONTEXT.md` não é tocado nesta execução.

**Nota de numeração (30/09):** as ondas da Etapa 1 foram renumeradas — o briefing anterior (`execucao_v47_onda1.md`, dados e identidade) corresponde à **Onda 0**. Este é o da **Onda 1** (compositor). Seguem-se Onda 2 (proativas por equivalência) e Onda 3 (jornada catalogada).

**Restrição rígida de custo (29/09): o Claude Code não executa NENHUMA validação que dependa de chamada de LLM.** Nem arnês, nem turnos simulados, nem webhook de teste que chegue ao principal ou ao compositor. O portão desta onda é 100% sem LLM (§6). Tudo que depende de LLM — inclusive a qualidade do texto composto — é validado manualmente pelo Guilherme no staging.

**Decisões do Guilherme (30/09) que governam esta onda:**
- Segunda chamada de LLM por turno **aceita** — apenas em turnos conversacionais **com fatos executados**; atalho exato, lembretes e todo o volume proativo seguem sem LLM, permanentemente.
- Modelo da composição: **`claude-sonnet-4-6`**, o mesmo do principal. Nenhum experimento de modelo menor nesta onda.
- A Onda 0 está em validação manual em paralelo; nada desta onda depende do resultado dessa validação. Se ela reprovar algo, corrige-se em cima.

## §0 — Objetivo

Hoje, a mensagem de um turno com fatos é uma concatenação em ordem de execução: abertura sorteada + linhas de fato (dosesDoTurno) + convite (estoqueTemplates) + `message` do LLM ao final. O caso-ouro de 29/09 17:24 mostra o resultado: "Que bom!" abrindo uma correção, "Vou corrigir" (futuro) depois de a correção já narrada, estoque dito duas vezes. Esta onda introduz o **compositor**: uma única etapa escreve a mensagem do turno a partir dos **fatos tipados pós-execução**, sob o guia de composição, com **âncora** de verificação por código e **fallback determinístico** (o texto atual). Um autor, uma mensagem, ciente da natureza do turno.

Anti-over-engineering (regras da v45, valem aqui): o compositor é **uma função com um prompt** — nada de framework, nada de serviço novo, nada de orquestração.

## §1 — Contrato da composição

Nova função (sugestão: `comporMensagemDoTurno`), chamada pelo fluxo do turno **após** a execução dos fatos e a leitura pós-escrita (P56):

**Entrada:**
- `fatos[]` — tipados, lidos do banco pós-escrita: dose (`dose_confirmada` com retroativa/sem-estoque, `dose_nao_tomada`, `dose_revertida {status_devolvido}`, `dose_ja_registrada`, `ainda_nao`), estoque (`estoque_atualizado`, `alerta_estoque {nivel}`, `convite_estoque {motivo}`). Cada fato carrega os dados prontos: nome do medicamento, rótulo de dia/hora **calculado por código** (BUG-059), quantidades, rótulos de estoque. Sujeito do fato incluído desde já ("quem fala, sobre quem" — hoje sempre o próprio usuário; o campo existe para o cuidador não exigir reescrita de contrato).
- `natureza_do_turno` — `normal` | `correcao` (houve `dose_revertida` ou contestação) | `chegada`. Derivada por código dos fatos, nunca pelo LLM.
- `intencao_conversacional` — o `message` que o principal escreveu na decisão. Deixa de ir ao usuário como está; vira insumo: o compositor pode reformulá-lo e o entrelaça na mensagem, mas **os fatos mandam** — em conflito, o fato vence.
- `assunto_citacao` (quando o turno citou um envio — Onda 0), `historico_curto` (últimas respostas da Nami, para não repetir abertura — mecanismo que dosesDoTurno já tem), `user`.

**Saída:** UMA mensagem, que segue ao funil com os fatos registrados como assunto do envio (tabela da Onda 0).

**Regras de composição** (entram como seção de turno do `GUIA_COMPOSICAO` — fonte única, nada de segundo guia): correção narrada antes de qualquer celebração; abertura compatível com a natureza do turno; fato principal primeiro; convites por último; cada assunto aparece uma vez; nunca prometer no futuro o que os fatos dizem que já aconteceu.

**Escopo da chamada:** SOMENTE turnos com fatos executados. Turnos `responder`/`perguntar`/`nao_suportado` puros (sem fato) seguem exatamente como hoje — o `message` do principal já é a composição, sem segunda chamada. O texto do "ainda não" honesto continua do sistema (inventario.js), intocado.

## §2 — A âncora (verificação por código, pós-composição)

Função pura `verificarComposicao(fatos, texto)`:

1. **Presença:** todo fato aparece no texto — nome do medicamento (normalizado), rótulo de dia/hora do fato, quantidade quando o fato a tem.
2. **Não-invenção:** nenhum nome de medicamento do usuário fora dos fatos; números e horários do texto pertencem ao conjunto dos fatos (heurística precisa a critério da implementação, com testes que documentem os limites — cuidado com falsos positivos de palavras numéricas; na dúvida, reprovar é o lado seguro).
3. Falha em qualquer checagem, erro ou timeout da chamada → **fallback**: o texto canônico determinístico dos mesmos fatos — que é exatamente a montagem atual do dosesDoTurno + templates, preservada como renderização canônica. O usuário nunca vê erro nem mensagem vazia; beco sem saída zero.
4. Toda queda no fallback registra evento de observabilidade (`compositor_fallback`, com motivo e fatos) — é o nosso sinal de qualidade da composição em produção.

O canônico não é reescrito nesta onda: dosesDoTurno vira **produtor de fatos + dono da renderização canônica**. O atalho exato continua respondendo pelo canônico direto, sem compositor.

## §3 — O que muda no fluxo do turno

1. Execução dos fatos: intocada (TABELA status × fato, funções de escrita, P56).
2. Montagem da resposta: em vez de concatenar fragmentos, o fluxo coleta os fatos executados + intenção do principal → `comporMensagemDoTurno` → âncora → (texto composto | fallback canônico) → funil com assunto.
3. Convites de estoque e alertas pós-confirmação deixam de ser apêndices concatenados: entram como fatos na mesma composição.
4. `agent_logs`: o turno registra qual caminho saiu (composto | fallback | canônico-direto) para observabilidade — sem tabela nova, campo ou sufixo no agent a critério.

## §4 — Custo e latência

Segunda chamada só em turnos com fatos (hoje ≤ ~20/dia em produção). `max_tokens` curto (mensagens do WhatsApp são breves). Registrar duração da chamada no log. Sem streaming, sem retry além de 1 tentativa — falha cai no fallback.

## §5 — Prompt do compositor

Claude Code redige a primeira versão (guia + regras de turno + fatos serializados de forma legível), **e a lista no relatório final para revisão do Guilherme** — a qualidade do texto composto é validação manual dele no staging, nunca do portão.

## §6 — Arnês e guards (todos sem LLM)

1. **Caso-ouro 17:24:** fatos = `dose_confirmada` (Creatina, retroativa-corrigida) + `dose_revertida` (Ômega 3) + `convite_estoque` + natureza `correcao`. Verificações: (a) a âncora aprova um texto-fixture bem composto desses fatos; (b) a âncora reprova fixtures com número inventado, medicamento ausente e medicamento estranho; (c) o fallback canônico desses fatos é determinístico e equivale à montagem atual.
3. **Roteamento do escopo:** turno sem fatos não chama compositor (verificável por construção/teste de unidade do fluxo).
4. **Isenções:** atalho exato e proativos não passam pelo compositor (guard por construção).
5. **Grep-guard:** a montagem antiga por concatenação não sobrevive como segundo caminho vivo — vive apenas como renderização canônica chamada pela âncora/atalho (um autor por formato; verificar por grep que nenhum fluxo concatena `message` do principal após fatos).
6. Portão completo verde antes de declarar pronto para validação manual.

## §7 — O que esta onda NÃO faz

- Não toca proativas, builders do scheduler/lembrete, nem templates de relatório (Onda 2).
- Não toca jornada, coleta ou configuração (Onda 3 / Etapa 3).
- Não altera a decisão do principal (tipos, doses, contrato da porta) além de repassar `message` como intenção ao compositor.
- Não experimenta modelo menor nem streaming.
- Não executa validação com custo de LLM (regra do topo).

## §8 — Relatório final

(1) Resultado do portão, check a check; (2) arquivos tocados e migrações (se houver); (3) o prompt do compositor na íntegra, para revisão do Guilherme; (4) lista explícita da validação manual dele no staging — no mínimo: confirmação simples, o cenário 17:24 reproduzido (correção com desfazer), retroativa com convite de estoque, e um turno misto (confirmação + pergunta na mesma mensagem) para ver a intenção conversacional entrelaçada.