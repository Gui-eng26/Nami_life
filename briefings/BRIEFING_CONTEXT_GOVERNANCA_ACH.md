# BRIEFING: Atualizar CONTEXT.md — Governança de Backlog (ACH/Partes, v29)

**Contexto:** a migration e o `src/backlog.js` da categoria ACH/Partes já foram
aplicados e verificados (commit `68e6ac3`). Falta só o CONTEXT.md refletir esse
estado — regra do próprio arquivo (seção "Ritual de encerramento", item 5): nenhuma
edição do CONTEXT.md acontece fora do pipeline de briefing.

Duas edições, ambas em `CONTEXT.md`. Aplicar com `str_replace` (texto literal abaixo).
**Não é a seção `## Sessão v29` de encerramento** — essa continua para o briefing de
fechamento da sessão, junto com o resto do resumo. Isso aqui é só a atualização das
duas seções de referência permanente que já existiam e ficaram desatualizadas.

---

## Edição 1 — Seção "Backlog"

**Texto atual (substituir):**
```markdown
## Backlog (BUG/FIX/MH)

A partir de 07/07/2026, o backlog completo vive na tabela `backlog_items`
do Supabase (projeto Nami_Life Brazil, project_id nputymewnwmnhrtpizzs).
Não é mais mantido neste arquivo. Consultar via Supabase MCP:

  SELECT tipo, numero, titulo, status, prioridade, data_criacao
  FROM backlog_items
  WHERE status IN ('aberto', 'em_validacao')
  ORDER BY prioridade, data_criacao;

---
```

**Texto novo:**
```markdown
## Backlog (BUG/FIX/MH/ACH)

A partir de 07/07/2026, o backlog completo vive na tabela `backlog_items`
do Supabase (projeto Nami_Life Brazil, project_id nputymewnwmnhrtpizzs).
Não é mais mantido neste arquivo. Consultar via Supabase MCP:

  SELECT tipo, numero, titulo, status, prioridade, parte, relacionado, data_criacao
  FROM backlog_items
  WHERE status IN ('aberto', 'em_validacao')
  ORDER BY prioridade, data_criacao;

### Governança de backlog (decisão v29, 05/08/2026)

A lista de BUG/MH crescia mais rápido do que fechava, ameaçando o objetivo de MVP
leve pro beta. A partir da v29:

- **Nenhum item novo (BUG, MH ou ACH) entra em `backlog_items` sem autorização
  EXPLÍCITA de Guilherme** na conversa do chat de planejamento — candidato a
  bug/melhoria encontrado durante investigação é apresentado como candidato, nunca
  registrado direto.
- **Item grande demais para uma sessão → Parte (A, B, C...) do MESMO número**, nunca
  item novo. Coluna `parte` (`text NOT NULL DEFAULT ''`, nunca NULL — ver comentário
  da migration) distingue as partes; índice único
  `backlog_items_tipo_numero_parte_ativo` cobre `(tipo, numero, parte)`.
- **Categoria ACH (achado)** — observação de sessão que não é necessariamente bug
  fechado nem melhoria definida. Coluna `relacionado` (texto livre, ex: `"MH-071"`)
  aponta pro BUG/MH relacionado, quando existir; nulo quando solto.
- Migration: `supabase/migrations/20260805000000_ach_e_partes_backlog.sql`. Racional
  completo em `briefings/BRIEFING_ACH_PARTES.md`.

---
```

---

## Edição 2 — "Ritual de início de sessão", item 4

**Texto atual (substituir):**
```markdown
4. Antes de atribuir qualquer ID novo de BUG/FIX/MH, consultar `backlog_items` no Supabase
   (não mais `ls briefings/` — essa checagem manual foi substituída pela constraint do banco,
   que rejeita fisicamente qualquer tentativa de reaproveitar um número ativo).
```

**Texto novo:**
```markdown
4. Antes de atribuir qualquer ID novo de BUG/FIX/MH/ACH, consultar `backlog_items` no Supabase
   (não mais `ls briefings/` — essa checagem manual foi substituída pela constraint do banco,
   que rejeita fisicamente qualquer tentativa de reaproveitar um número ativo). **A partir da
   v29, nenhum item novo é registrado sem autorização explícita de Guilherme** — ver
   "Governança de backlog" na seção Backlog.
```

---

## Verificação obrigatória (relatar antes/depois)

```bash
grep -c "Backlog (BUG/FIX/MH/ACH)" CONTEXT.md   # esperado: 1
grep -c "Governança de backlog" CONTEXT.md      # esperado: 1
grep -c "BUG/FIX/MH,$" CONTEXT.md               # esperado: 0 (heading antigo não deve sobrar)
```

Git add/commit/push. Nenhum outro arquivo é tocado por este briefing.