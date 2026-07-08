# BRIEFING — Updates em `backlog_items` (revisão de pendências, v16)

**Contexto:** as 13 pendências deixadas pela auditoria/migração do backlog (ver `BRIEFING_LOG_AUDITORIA.md` e `BRIEFING_MIGRACAO_BACKLOG_DB.md`) foram revisadas uma a uma com o Guilherme no chat de planejamento. Este briefing contém só as escritas resultantes — nenhuma mudança de schema.

**Instrução para o Claude Code:** rodar o bloco SQL abaixo via `execute_sql` no projeto `nputymewnwmnhrtpizzs`. Rodar a query de verificação ao final antes de considerar concluído.

```sql
-- MH-008: Fase 2 (pós-MVP)
UPDATE backlog_items
SET status = 'deferred',
    notas = 'Decisão de 08/07/2026: considerado evolução relevante do produto, fase 2 pós-MVP (não descartado).',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 8 AND status <> 'historico_substituido';

-- MH-009: aberto, prioridade média
UPDATE backlog_items
SET status = 'aberto',
    prioridade = 'media',
    notas = 'Decisão de 08/07/2026: mantido no backlog ativo, prioridade média.',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 9 AND status <> 'historico_substituido';

-- MH-010: Fase 2 (pós-MVP)
UPDATE backlog_items
SET status = 'deferred',
    notas = 'Decisão de 08/07/2026: fase 2 pós-MVP.',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 10 AND status <> 'historico_substituido';

-- MH-012: Fase 2 (pós-MVP)
UPDATE backlog_items
SET status = 'deferred',
    notas = 'Decisão de 08/07/2026: fase 2 pós-MVP.',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 12 AND status <> 'historico_substituido';

-- MH-016: fundido com MH-030
UPDATE backlog_items
SET status = 'superseded',
    notas = 'Decisão de 08/07/2026: fundido com MH-030 — mesmo escopo (encerramento de tratamento por tempo determinado). Ver MH-030 como item canônico.',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 16 AND status <> 'historico_substituido';

-- MH-020: repriorizado, alta (conformidade legal)
UPDATE backlog_items
SET status = 'aberto',
    prioridade = 'alta',
    notas = 'Decisão de 08/07/2026: repriorizado como alta — questão de conformidade legal (LGPD), não apenas melhoria de produto.',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 20 AND status <> 'historico_substituido';

-- MH-031: mantido aberto, escopo esclarecido
UPDATE backlog_items
SET status = 'aberto',
    descricao = 'Histórico de vida do usuário: relatório de remédios já usados e por quanto tempo, incluindo tratamentos contínuos encerrados por decisão clínica (não apenas os de tempo determinado). Escopo distinto do MH-030.',
    notas = 'Decisão de 08/07/2026: NÃO se sobrepõe ao MH-030 (que trata só de tratamentos por tempo determinado) — esclarecido pelo Guilherme.',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 31 AND status <> 'historico_substituido';

-- MH-003: fechado como resolvido
UPDATE backlog_items
SET status = 'resolvido',
    sessao_fechamento = 'v16',
    data_fechamento = '2026-07-08',
    notas = 'Decisão de 08/07/2026: fechado como resolvido — confirmado pelo campo taken_at já existente no schema de dose_logs.',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 3 AND status <> 'historico_substituido';

-- MH-021: fechado como resolvido (independente da saudação condicional)
UPDATE backlog_items
SET status = 'resolvido',
    sessao_fechamento = 'v16',
    data_fechamento = '2026-07-08',
    notas = 'Decisão de 08/07/2026: fechado como resolvido. Explicitamente INDEPENDENTE da saudação condicional da v15 — escopos diferentes, não confundir no histórico.',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 21 AND status <> 'historico_substituido';

-- BUG-045: arquivado formalmente
UPDATE backlog_items
SET notas = 'Decisão de 08/07/2026: arquivado formalmente — confirmada baixa prioridade real, permanece fora da fila ativa.',
    updated_at = now()
WHERE tipo = 'BUG' AND numero = 45 AND status <> 'historico_substituido';

-- MH-024 (definição original): fechado como resolvido, ambiguidade removida
UPDATE backlog_items
SET notas = 'Decisão de 08/07/2026: fechamento confirmado (Ciclo de Vida da Dose, v11). O uso informal posterior do número para "cálculo preciso de doses restantes" foi desmembrado — ver MH-045 (novo).',
    updated_at = now()
WHERE tipo = 'MH' AND numero = 24 AND status <> 'historico_substituido';

-- FIX-004: fechado como resolvido
UPDATE backlog_items
SET status = 'resolvido',
    sessao_fechamento = 'v9',
    notas = 'Decisão de 08/07/2026: fechado como resolvido — coberto pelo Classificador LLM (v9, LOGS-001).',
    updated_at = now()
WHERE tipo = 'FIX' AND numero = 4 AND status <> 'historico_substituido';

-- MH-045 (NOVO): cálculo preciso de dosesRestantesEstimadas
INSERT INTO backlog_items (tipo, numero, titulo, descricao, status, sessao_criacao, data_criacao, notas)
VALUES (
  'MH', 45,
  'Cálculo preciso de dosesRestantesEstimadas via query real em dose_logs',
  'Hoje o cálculo de doses restantes usa estimativa por multiplicação em pontos como alertas de estoque. A v15 (calcularProgressoTratamento) já contornou a mesma imprecisão — diasRestantes/dosesRestantes zeram no último dia mesmo com dose pendente — usando comparação de data, mas só nesse ponto específico. Este item cobre o cálculo preciso de forma geral, via query real em dose_logs, fora do que já foi resolvido no progresso de tratamento.',
  'aberto', 'v16', '2026-07-08',
  'Desmembrado do uso informal antigo do MH-024 em 08/07/2026. Prioridade ainda não definida.'
);
```

## Verificação final

```sql
SELECT tipo, numero, titulo, status, prioridade
FROM backlog_items
WHERE status <> 'historico_substituido'
ORDER BY tipo, numero;
```

Confirmar visualmente que:
1. MH-045 aparece como novo item, aberto.
2. Nenhum `(tipo, numero)` aparece duplicado entre os resultados (a constraint já garante isso, mas vale olhar).
3. MH-009 e MH-020 aparecem com as novas prioridades (média e alta, respectivamente).