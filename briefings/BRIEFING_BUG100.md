# BRIEFING — BUG-100: verbo de administração incorreto para medicamentos não ingeridos

**Sessão:** v34 · **Data:** 20/08/2026
**Prioridade:** alta — atinge usuário em produção agora
**Independente de:** MH-073 Parte B.3 (pode ser implementado e validado em paralelo)
**Arquivos:** `src/templates/verbos.js` (novo), `src/scheduler.js`, `src/agentes/lembrete.js`,
`src/templates/estoqueTemplates.js`, `src/templates/balancoTemplates.js`, `src/database.js`
**Migration:** sim — `get_pending_reminders` precisa devolver `forma_farmaceutica`

---

## 1. O defeito

Lembrete entregue em produção em 20/08 às 16:06:

> ⏰ Olá, Guilherme!
> Hora do seu **tobradex colírio** — 0,3.
> **Já tomou?** Responda SIM ou NÃO

Colírio não se toma. Pomada não se toma. Injetável não se toma.

Para o público-alvo — idoso, muitas vezes com baixa familiaridade digital e às vezes com
dificuldade de leitura — um verbo errado não é um deslize de estilo: é uma instrução ambígua
sobre administração de medicamento. Alguém pode ingerir um colírio.

---

## 2. Causa raiz

O verbo é literal em texto determinístico, em oito pontos. Nenhum deles consulta qualquer
atributo do medicamento — o sistema nunca teve o conceito de "como este medicamento é
administrado".

Não é o mesmo defeito da Parte D (unidade hardcoded, "comprimidos"). Aquele é apresentação.
Este é **instrução de uso**.

---

## 3. Decisão de arquitetura — o discriminador é `forma_farmaceutica`, NÃO `unidade_dose`

⚠️ **Este é o ponto que mais importa neste briefing.**

O caso que originou o bug é um colírio em gotas. A tentação é derivar o verbo de `unidade_dose`
(`gota` → "usar"). **Isso estaria errado e criaria um bug novo:**

| Medicamento (cadastrado em produção) | `unidade_dose` | `forma_farmaceutica` | Verbo correto |
|---|---|---|---|
| tobradex colírio | `gota` | `colírio` | **usar** |
| Rivotril gotas | `gota` | `gotas` | **tomar** |

Mesma unidade de dose, verbos opostos. `unidade_dose` responde "quanto"; `forma_farmaceutica`
responde "como". Só a segunda serve aqui.

### Tabela de verbos

```js
// src/templates/verbos.js — ponto único (princípio 30).
// A chave é forma_farmaceutica: unidade_dose diz QUANTO, forma diz COMO.
const VERBO_POR_FORMA = {
    'colírio':   { infinitivo: 'usar',    passado: 'usou',    imperativoPergunta: 'Já usou?' },
    'pomada':    { infinitivo: 'usar',    passado: 'usou',    imperativoPergunta: 'Já usou?' },
    'injetável': { infinitivo: 'aplicar', passado: 'aplicou', imperativoPergunta: 'Já aplicou?' },
    'comprimido':{ infinitivo: 'tomar',   passado: 'tomou',   imperativoPergunta: 'Já tomou?' },
    'cápsula':   { infinitivo: 'tomar',   passado: 'tomou',   imperativoPergunta: 'Já tomou?' },
    'gotas':     { infinitivo: 'tomar',   passado: 'tomou',   imperativoPergunta: 'Já tomou?' },
    'xarope':    { infinitivo: 'tomar',   passado: 'tomou',   imperativoPergunta: 'Já tomou?' }
};

// Formas genéricas ('unidade', 'líquido') e desconhecidas: a convenção do projeto
// já estabelecida no cadastro — "toma ou usa" — cobre os dois casos sem errar.
const VERBO_NEUTRO = { infinitivo: 'tomar ou usar', passado: 'tomou ou usou', imperativoPergunta: 'Já tomou ou usou?' };

export function verboDoMedicamento(formaFarmaceutica) {
    return VERBO_POR_FORMA[formaFarmaceutica] || VERBO_NEUTRO;
}

// Mensagens que cobrem VÁRIOS medicamentos de formas diferentes não podem
// escolher um verbo — usam o neutro sempre.
export const VERBO_MULTIPLO = VERBO_NEUTRO;
```

⚠️ `forma_farmaceutica` é preenchida pela tabela canônica desde a Parte B e nunca é `null`
(`derivarFormaFarmaceutica`). Registros anteriores à Parte B podem ter texto livre
("efervescente", "capsula" sem acento) — caem no neutro, que é seguro.

---

## 4. Os oito pontos (varredura completa do projeto)

### Mensagem sobre UM medicamento conhecido → verbo derivado da forma

| # | Arquivo:linha | Texto atual | Correção |
|---|---|---|---|
| 1 | `scheduler.js:402` | `Já tomou? Responda *SIM* ou *NÃO*` | `${verbo.imperativoPergunta} Responda...` |
| 2 | `lembrete.js:28` (tentativa 2) | `Já tomou? Responda *SIM* ou *NÃO*` | idem |
| 3 | `lembrete.js:36` (tentativa 3) | `Tomou? É só responder...` | `${verbo.passado.replace(...)}` — ver nota |
| 4 | `lembrete.js:41` (fallback) | `Já tomou? Responda...` | idem #1 |
| 5 | `estoqueTemplates.js:16` | `você acabou de tomar o último comprimido` | `você acabou de ${verbo.infinitivo} a última dose` |
| 6 | `estoqueTemplates.js:53` | `me avise se tomou` | `me avise se ${verbo.passado}` |

⚠️ **Ponto 5 tem também "comprimido" hardcoded.** A unidade é escopo da **Parte D** — aqui trocar
por "a última dose", que é neutro e correto em qualquer forma, sem antecipar a Parte D.

⚠️ **Ponto 3** usa a forma sem "Já". Manter a estrutura: `Usou?` / `Tomou?` / `Aplicou?` —
capitalizar `verbo.passado`.

### Mensagem sobre VÁRIOS medicamentos → verbo neutro obrigatório

| # | Arquivo:linha | Texto atual | Correção |
|---|---|---|---|
| 7 | `scheduler.js:251-252` e `310-311` | `Tomou todos?` / `Tomou só alguns?` | `Já tomou ou usou todos?` / `Tomou ou usou só alguns?` |
| 8 | `balancoTemplates.js:73` | `Se você tomou alguma dessas...` | `Se você tomou ou usou alguma dessas...` |

⚠️ Nesses pontos a lista pode misturar comprimido e colírio. Escolher um verbo erraria para
metade dos itens — o neutro é a única opção correta, não uma preguiça.

### FORA de escopo (verificado e deliberadamente não tocado)

- `adesaoTemplates.js` (linhas 27, 29, 33, 76, 77) — mensagens semanais de adesão, genéricas,
  não vinculadas a um medicamento específico. Reescrevê-las é trabalho de copy, não correção de
  instrução de uso. Não foi levantado nos testes.
- `balancoTemplates.js:25` (`'nao_tomado' → 'não tomado'`) e todos os `status = 'nao_tomado'` em
  `database.js`/`router.js` — **valor de domínio interno**, não texto de instrução. Renomear
  status é migração de dados sem benefício ao usuário.

---

## 5. Origem do dado — as duas fontes precisam de mudança

⚠️ **Nenhuma das duas fontes entrega `forma_farmaceutica` hoje.** Sem isso, todos os pontos
acima cairiam no verbo neutro e o bug ficaria "meio corrigido" — pior, porque pareceria
resolvido.

### 5.1 `get_pending_reminders` (migration nova)

A RPC devolve `unidade_dose`, `unidade_estoque`, `gotas_por_ml` desde a Parte A, mas **não**
`forma_farmaceutica`. Adicionar ao `RETURNS TABLE` e ao `SELECT`:

```sql
    forma_farmaceutica   text,
...
        m.forma_farmaceutica,
```

⚠️ Recriar a função com `DROP FUNCTION` + `CREATE FUNCTION` (não `CREATE OR REPLACE`) — mudar o
`RETURNS TABLE` exige drop, como já foi feito na migration da Parte A.

⚠️ Não alterar nenhuma outra coluna nem a cláusula `WHERE`. A RPC governa o disparo de todos os
lembretes do sistema.

### 5.2 `getPendingFollowUps` (`database.js:568`)

O `select` traz apenas `id, nome, dosagem, user_id`. Acrescentar `forma_farmaceutica` e
normalizar:

```js
            medications (
                id, nome, dosagem, forma_farmaceutica, user_id,
                users (id, phone, name)
            )
...
        med_forma: log.medications?.forma_farmaceutica,
```

### 5.3 `estoqueTemplates.js`

Verificar de onde vem o objeto do medicamento em cada chamada e garantir que
`forma_farmaceutica` chegue. Se a origem for `getEstoqueInfoParaAlerta` (`database.js`), incluir
a coluna no `select` — ela já seleciona `forma_farmaceutica` na consulta da linha 1279, confirmar
e reaproveitar.

---

## 6. Checklist de verificação

```bash
# 1. Nenhum "tomou" literal sobrou em texto de lembrete/estoque/balanço
grep -rn "tomou\|Tomou" src/scheduler.js src/agentes/lembrete.js src/templates/estoqueTemplates.js src/templates/balancoTemplates.js
# esperado: nenhuma ocorrência fora de interpolação ${verbo...} ou do valor 'nao_tomado'

# 2. O verbo nunca é derivado de unidade_dose
grep -rn "unidade_dose" src/templates/verbos.js
# esperado: nenhuma linha

# 3. A RPC devolve a forma
grep -n "forma_farmaceutica" supabase/migrations/*bug100*.sql
# esperado: presente no RETURNS TABLE e no SELECT

# 4. Follow-up carrega a forma
grep -n "forma_farmaceutica" src/database.js
# esperado: presente em getPendingFollowUps

# 5. Sintaxe
node --check src/templates/verbos.js && node --check src/scheduler.js && \
node --check src/agentes/lembrete.js && node --check src/templates/estoqueTemplates.js && \
node --check src/templates/balancoTemplates.js && node --check src/database.js
```

---

## 7. Cenários de validação

1. **Colírio** (tobradex, já cadastrado) → lembrete diz **"Já usou?"**.
2. **Gotas orais** (Rivotril gotas, já cadastrado) → lembrete diz **"Já tomou?"**.
   ⚠️ Este é o cenário que prova que o discriminador certo foi usado. Se disser "usou", a
   implementação derivou de `unidade_dose` e está errada.
3. **Comprimido** (Atenolol) → **"Já tomou?"** — não-regressão.
4. **Follow-up (tentativa 2)** de um colírio: não confirmar a dose e esperar → **"Já usou?"**.
5. **Follow-up (tentativa 3)** de um colírio → **"Usou?"**.
6. **Lembrete agrupado** com comprimido + colírio no mesmo horário → **"Já tomou ou usou todos?"**.
7. **Estoque zerado** de um colírio → mensagem sem "tomar o último comprimido".
8. **Medicamento antigo** com forma fora da tabela (ex: Vitamina C, `efervescente`) → cai no
   neutro, sem quebrar.
9. `SELECT forma_farmaceutica FROM get_pending_reminders()` retorna valor — confirma a migration.

---

## 8. Escritas em `backlog_items`

Este chat é read-only no Supabase. Via `src/backlog.js`:

- `INSERT` `BUG-100` — *"Lembrete e mensagens de estoque usam verbo de ingestão para medicamentos
  não ingeridos (colírio, pomada, injetável)"*, `prioridade: alta`, `sessao_criacao: 'v34'`.
- `UPDATE` para `em_validacao` ao fim da implementação — **nunca `resolvido` antes da validação
  em produção**.