# BRIEFING — Ajustes pontuais no CONTEXT.md (pós-migração do backlog, v16)

Duas edições pequenas, decorrentes de a migração do backlog para o Supabase (v16) ter deixado
resíduos de texto que agora duplicam ou contradizem o que o banco já garante.

## Edição 1 — remover o ponteiro fixo "próximo número livre"

Na seção **"Achado — correção de numeração histórica de bugs"**, substituir o parágrafo:

```
**Números corretos a partir de agora: próximo BUG livre é BUG-059. Próximo MH livre é MH-045.**
(BUG-055 a BUG-058 e MH-043/044 já foram atribuídos nesta sessão — ver backlog abaixo.)
```

por:

```
Esse ponteiro fixo foi removido em 08/07/2026: a tabela `backlog_items` (índice único parcial em
`(tipo, numero) WHERE status <> 'historico_substituido'`) já impede colisão de número
independentemente de qualquer texto aqui. Para saber o próximo número livre, consultar:

  SELECT tipo, MAX(numero) AS ultimo_usado
  FROM backlog_items
  WHERE status <> 'historico_substituido'
  GROUP BY tipo;
```

**Motivo:** o ponteiro já ficou desatualizado nesta mesma sessão (MH-045 foi atribuído a um item
novo durante a revisão de pendências, e o texto continuou dizendo "próximo MH livre é MH-045").
Manter um número fixo em texto livre é exatamente o tipo de duplicação que a migração para o
Supabase deveria eliminar.

## Edição 2 — atualizar o passo 4 do "Ritual de início de sessão"

Substituir:

```
4. **Antes de atribuir qualquer ID novo de BUG/MH, conferir `ls briefings/` no repositório real**
   — não confiar cegamente no ponteiro "próximo livre" sem essa checagem (ver Convenção de IDs)
```

por:

```
4. Antes de atribuir qualquer ID novo de BUG/FIX/MH, consultar `backlog_items` no Supabase
   (não mais `ls briefings/` — essa checagem manual foi substituída pela constraint do banco,
   que rejeita fisicamente qualquer tentativa de reaproveitar um número ativo).
```

## Sem outras mudanças

Nenhuma outra alteração de arquitetura foi decidida nesta sessão — as 13 decisões da revisão de
pendências (Fase 2, fusões, reprioridades, fechamentos, o novo MH-045) já estão inteiramente
cobertas pelo `BRIEFING_UPDATES_BACKLOG_v16.md` e não tocam o CONTEXT.md.