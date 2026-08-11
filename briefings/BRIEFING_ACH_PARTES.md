# BRIEFING: Categoria ACH e Partes (A/B/C) no backlog_items

**Sessão v29 (05/08/2026) — mudança de governança/processo, ZERO impacto em fluxo de produção.**

## Contexto (por que isso existe)

Guilherme identificou que a lista de BUG/MH está crescendo mais rápido do que fecha,
ameaçando o objetivo de MVP leve pro beta. Decisão de processo, a partir de agora:

1. **Nenhum item novo (BUG ou MH) entra em `backlog_items` sem autorização explícita
   de Guilherme na conversa do chat de planejamento.** Isso é regra de processo (deste
   chat), não precisa de nada em código.
2. **Item grande demais para uma sessão se divide em PARTES (A, B, C) do MESMO
   número** — nunca abre número novo para a continuação. Precisa de suporte de schema
   (este briefing).
3. **Nova categoria `ACH` (achado)** para observações de sessão que não são
   necessariamente um bug fechado nem uma melhoria definida — registradas com
   referência a qual BUG/MH se relacionam (ou nenhum). Precisa de suporte de schema
   (este briefing).

Este briefing entrega só o suporte técnico dos itens 2 e 3. Nenhum item novo de
backlog é criado por este briefing.

## Escopo

- Migration nova em `supabase/migrations/`.
- Alteração em `src/backlog.js` (único ponto de escrita em `backlog_items` —
  princípio 16 do projeto).

## Fora de escopo (não fazer)

- Nenhuma mudança em `router.js`, `agentes/*` ou qualquer fluxo de produção.
- Nenhum insert de item novo em `backlog_items`.
- Nenhuma mudança em CONTEXT.md — a seção "Modo de Trabalho" será atualizada no
  briefing de encerramento da própria sessão v29, junto com o resto do resumo da
  sessão (mesmo padrão de sempre: todo o texto de sessão nasce no briefing de
  encerramento, nunca em passo avulso).

---

## Passo 1 — Migration

**Arquivo:** `supabase/migrations/20260805000000_ach_e_partes_backlog.sql`

⚠️ Lembrete do próprio projeto: migrations NÃO são aplicadas automaticamente — aplicar
manualmente no SQL Editor do Supabase ANTES do deploy do código que a usa.

```sql
-- Governança de backlog (decisão de Guilherme, sessão v29, 05/08/2026): a partir de
-- agora, item novo só entra em backlog_items com autorização explícita, itens grandes
-- demais para uma sessão se dividem em PARTES do MESMO número (nunca item novo), e
-- achados de sessão que não são bug/melhoria fechados ganham categoria própria (ACH).
-- Ver briefings/BRIEFING_ACH_PARTES.md para o racional completo.

-- 1. Categoria ACH (achado) — substitui o CHECK constraint de tipo.
ALTER TABLE public.backlog_items DROP CONSTRAINT backlog_items_tipo_check;
ALTER TABLE public.backlog_items ADD CONSTRAINT backlog_items_tipo_check
  CHECK (tipo IN ('BUG', 'FIX', 'MH', 'ACH'));

-- 2. Vínculo do ACH a um BUG/MH relacionado (texto livre, ex: 'MH-071' ou 'BUG-086').
-- Nulo quando o achado não se conecta a nenhum item existente. Texto livre, não FK
-- estruturada — volume baixo esperado, não justifica normalizar agora (mesma lógica
-- de escopo já usada em outras decisões do projeto, ex: MH-046/MH-055).
ALTER TABLE public.backlog_items ADD COLUMN relacionado text NULL;

-- 3. Coluna de parte (A/B/C) para item grande demais para uma sessão.
-- NOT NULL DEFAULT '' (nunca NULL) — motivo: o índice único abaixo distingue linhas
-- por (tipo, numero, parte). Se parte fosse NULLABLE, dois itens sem parte (ambos
-- NULL) NÃO colidiriam no índice — Postgres trata NULL <> NULL em índice único —
-- reabrindo a mesma classe de colisão de número que backlog_items_tipo_numero_ativo
-- foi criado para fechar em 08/07/2026. Com '' como valor não-nulo padrão, itens sem
-- parte continuam protegidos entre si exatamente como hoje.
ALTER TABLE public.backlog_items ADD COLUMN parte text NOT NULL DEFAULT '';

-- 4. Substitui o índice único para incluir parte — sem isso, Parte A e Parte B do
-- mesmo item colidiriam como se fossem o mesmo registro (índice atual só olha
-- tipo+numero).
DROP INDEX public.backlog_items_tipo_numero_ativo;
CREATE UNIQUE INDEX backlog_items_tipo_numero_parte_ativo
  ON public.backlog_items (tipo, numero, parte)
  WHERE status <> 'historico_substituido';

COMMENT ON COLUMN public.backlog_items.relacionado IS
  'Referência textual (ex: "MH-071") ao BUG/MH relacionado. Usada principalmente por itens tipo=ACH. Nulo quando não há relação.';
COMMENT ON COLUMN public.backlog_items.parte IS
  'Parte (A, B, C...) quando um item foi dividido entre sessões. Vazio ('''') para item não dividido — nunca NULL, ver comentário da migration que introduziu a coluna.';
```

---

## Passo 2 — `src/backlog.js` (substituir arquivo inteiro)

```javascript
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Único ponto de escrita em backlog_items — nunca fazer insert/update direto
// em outro lugar do código (mesmo princípio do stock_movements / MH-042).
//
// v29 (governança de backlog, 05/08/2026): tipo aceita também 'ACH' (achado de
// sessão, nem sempre um bug/melhoria fechados) e todo item carrega 'parte'
// (''/'A'/'B'/'C'...) para dividir trabalho grande demais para uma sessão sem abrir
// número novo. 'parte' nunca é omitida do filtro de update — ver comentário abaixo.

export async function registrarItemBacklog({
    tipo, numero, titulo, descricao, causaRaiz,
    status, prioridade, sessaoCriacao, dataCriacao,
    relacionado = null, parte = ''
}) {
    const { data, error } = await supabase
        .from('backlog_items')
        .insert({
            tipo, numero, titulo, descricao,
            causa_raiz: causaRaiz, status, prioridade,
            sessao_criacao: sessaoCriacao, data_criacao: dataCriacao,
            relacionado, parte
        })
        .select()
        .single();

    if (error) {
        // Se for violação do índice único (23505), o número (+ parte) já existe ativo —
        // isso é o comportamento CORRETO: força decisão explícita em vez de
        // sobrescrever silenciosamente (a causa raiz das 6 colisões anteriores).
        throw new Error(`Falha ao registrar ${tipo}-${numero}${parte ? ` Parte ${parte}` : ''}: ${error.message}`);
    }
    return data;
}

export async function atualizarStatusBacklogItem({
    tipo, numero, novoStatus, sessaoFechamento, dataFechamento, notas,
    parte = ''
}) {
    // parte SEMPRE no filtro (default '') — desde a v29, tipo+numero sozinhos não
    // identificam mais uma linha única quando o item foi dividido em partes. Omitir
    // esse filtro faria .single() falhar (mais de uma linha bate) ou, pior, arriscar
    // um update na linha errada quando só uma parte existir no momento da chamada.
    const { data, error } = await supabase
        .from('backlog_items')
        .update({
            status: novoStatus,
            sessao_fechamento: sessaoFechamento,
            data_fechamento: dataFechamento,
            notas,
            updated_at: new Date().toISOString()
        })
        .eq('tipo', tipo)
        .eq('numero', numero)
        .eq('parte', parte)
        .neq('status', 'historico_substituido') // nunca edita o par histórico por engano
        .select()
        .single();

    if (error) throw new Error(`Falha ao atualizar ${tipo}-${numero}${parte ? ` Parte ${parte}` : ''}: ${error.message}`);
    return data;
}
```

---

## Passo 3 — Execução

1. Aplicar a migration manualmente no SQL Editor do Supabase (copiar o SQL do Passo 1).
2. Substituir `src/backlog.js` pelo conteúdo do Passo 2.
3. `git add / commit / push`.
4. Railway redeploy automático.

## Passo 4 — Verificação obrigatória (rodar e relatar o resultado)

```bash
node --check src/backlog.js
```

```bash
# Confirma que backlog_items continua com UM único ponto de escrita no código —
# nenhum outro arquivo deve aparecer aqui além de src/backlog.js.
grep -rn "from('backlog_items')" src/
```

No Supabase, confirmar que o schema ficou como esperado:

```sql
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'backlog_items'::regclass AND contype = 'c';

SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'backlog_items';

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'backlog_items' AND column_name IN ('relacionado', 'parte');
```

Esperado: `tipo` aceita `'ACH'`; índice único chama-se
`backlog_items_tipo_numero_parte_ativo` e cobre `(tipo, numero, parte)`; `parte` é
`NOT NULL` com default `''`; `relacionado` é nullable.

Relatar os resultados das três queries acima antes de considerar o item concluído.