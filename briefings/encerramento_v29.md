# Encerramento — Sessão v29 (05/08/2026)

Sessão de decisão pura — nenhuma linha de código de produção tocada, nenhum item novo
em `backlog_items`. A decisão em si é o entregável (mesma regra do "Ritual de
encerramento", item 4 do CONTEXT.md).

Duas edições em `CONTEXT.md`, ambas literais abaixo. **Nenhum outro arquivo é tocado
por este briefing** — a migration e o `src/backlog.js` já foram commitados em sessão
anterior (commit `68e6ac3`) e as edições anteriores do CONTEXT.md (heading da seção
Backlog + item 4 do ritual de início) já foram commitadas (commit `2f12565`). Isso
aqui é só a seção de fechamento da sessão + o princípio novo.

---

## Edição 1 — Inserir seção `## Sessão v29`

**Inserir ANTES desta linha exata** (início da seção Backlog, hoje logo após o
fechamento da Lição de processo da v28):
```markdown
## Backlog (BUG/FIX/MH/ACH)
```

**Texto a inserir:**
```markdown
## Sessão v29 (05/08/2026) — Governança de backlog: categoria ACH e Partes (A/B/C)

### Origem da sessão

Guilherme abriu a sessão apontando um padrão: toda sessão termina com a lista de
BUG/MH maior do que começou. "Achados" de sessão viravam item novo no backlog mesmo
quando eram desdobramento de um item já existente, gerando títulos/conteúdos
sobrepostos e confusão sobre origem. O objetivo de MVP leve pro beta estava sendo
diretamente ameaçado pelo acúmulo.

### Decisão de processo (Guilherme)

1. **Nenhum item novo (BUG, MH ou ACH) entra em `backlog_items` sem autorização
   EXPLÍCITA de Guilherme** na conversa — candidato encontrado durante investigação é
   apresentado como candidato, nunca registrado direto.
2. **Item grande demais para uma sessão → Parte (A, B, C...) do MESMO número**, nunca
   item novo.
3. **Nova categoria ACH (achado)** — observação de sessão que não é necessariamente
   bug fechado nem melhoria definida, com referência ao BUG/MH relacionado quando
   existir.

### Implementação (schema + `src/backlog.js`)

- Migration `supabase/migrations/20260805000000_ach_e_partes_backlog.sql`: `tipo`
  passa a aceitar `'ACH'`; coluna `relacionado` (nullable, texto livre); coluna
  `parte` (`NOT NULL DEFAULT ''` — ver Princípio 35); índice único trocado de
  `backlog_items_tipo_numero_ativo` `(tipo, numero)` para
  `backlog_items_tipo_numero_parte_ativo` `(tipo, numero, parte)`.
- `src/backlog.js`: `registrarItemBacklog` e `atualizarStatusBacklogItem` passam a
  aceitar `relacionado`/`parte`; `parte` (default `''`) entra no filtro do update —
  sem isso um update numa Parte B poderia casar com a Parte A.
- Aplicado e verificado de forma independente (schema no Supabase + `diff` do
  `src/backlog.js` no GitHub contra o texto do briefing) — commit `68e6ac3`.
- CONTEXT.md: seção "Backlog" renomeada para `(BUG/FIX/MH/ACH)`, subseção
  "Governança de backlog" documentando as 3 regras acima, e item 4 do "Ritual de
  início de sessão" atualizado — commit `2f12565`, também verificado
  independentemente.

### Princípio novo (35) — ver seção de Princípios de Engenharia

### BUG-86 / BUG-87 — investigação iniciada e pausada por decisão explícita

Comecei a ler `router.js` e `configuracao.js` para entender a causa raiz completa do
BUG-86 (decisão de escopo em aberto: restringir a `configurando` ou generalizar a
todos os estados; complicação identificada — `despacharEscalada` reentra com
`currentState` fixo, o que descartaria o fluxo pendente em vez de retomá-lo).
Guilherme pausou explicitamente: sessão v29 é só o desenho de governança. **Nenhuma
conclusão nova sobre a causa raiz, nenhum código alterado.** BUG-86 e BUG-87
continuam exatamente como estavam no fechamento da v28 — mesma prioridade, mesmo
status, sem nenhum campo tocado.

### Backlog — nenhuma escrita nesta sessão

Confirmado via `updated_at` em `backlog_items`: nenhum registro foi tocado desde o
fechamento da v28. Primeira sessão sob a nova governança, e ela já se provou na
prática — nenhum item novo nasceu sem alguém pedir.

### Lição de processo

Ao desenhar a coluna `parte`, a primeira versão do desenho (nullable) teria reaberto
silenciosamente a mesma classe de colisão de número que o índice único de
`backlog_items` foi criado para fechar em 08/07 — porque Postgres trata dois `NULL`
como não-iguais dentro de um índice único. Isso só apareceu por checar o
comportamento do Postgres antes de escrever a migration, não por teste posterior.
Formalizado como Princípio 35.

### Próximos passos

- Investigar causa raiz do BUG-86 (decisão de escopo: restringir a `configurando` ou
  generalizar) e do BUG-87 (ainda não investigado — pode ser sintoma do mesmo
  problema, já que ambos giram em torno de "Sim" mal-roteado).
- Validar o MH-71 com o cenário correto, herdado da v28: resposta curta fora da lista
  de termos de confirmação, em estado ocioso, logo após um lembrete proativo.

```

---

## Edição 2 — Inserir Princípio 35

**Inserir ANTES desta linha exata** (o `---` que fecha a lista de princípios, logo
após o fim do Princípio 34):
```markdown
    função for tocada).

---
```
*(atenção: o texto de busca inclui a linha final do Princípio 34 + a linha em branco
+ o separador, para garantir posição única — não usar só `---` isolado, que se repete
várias vezes no arquivo)*

**Texto a inserir logo antes do `---`:**
```markdown

35. **Coluna usada para diferenciar linhas dentro de um índice único nunca pode ser
    NULLABLE quando o "sem valor" também precisa de proteção de unicidade (v29).**
    Postgres trata `NULL` como distinto de qualquer outro `NULL` em índice único —
    duas linhas com o mesmo `(tipo, numero)` e `parte = NULL` não colidiriam,
    reabrindo a mesma classe de erro que o índice foi criado para fechar. Um valor
    sentinela não-nulo (`''` para "sem parte") preserva a proteção original. Aplicado
    em `backlog_items.parte` (categoria ACH/Partes).
```

---

## Verificação obrigatória (relatar os números antes e depois)

```bash
grep -c "^## Sessão" CONTEXT.md    # esperado: 12 antes → 13 depois
grep -c "^35\. \*\*"  CONTEXT.md   # esperado: 0 antes → 1 depois
```

Git add/commit/push. Nenhum outro arquivo é tocado por este briefing.