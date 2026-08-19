# BRIEFING — MH-073 Parte A: separar unidade de estoque da unidade de dose

**Sessão:** v33
**Data:** 19/08/2026
**Executor:** Claude Code
**Item de backlog:** MH-073 (Parte A)

---

## 1. Objetivo

Quebrar a equação implícita que sustenta todo o sistema de estoque hoje:

```
1 schedule disparado  =  1 dose  =  1 unidade de estoque
```

Essa equação nunca foi escrita em lugar nenhum — está distribuída em quatro `delta: ±1`
hardcoded e em três cálculos de `estoque / número_de_schedules`. Ela é falsa para
medicamentos líquidos (dose em gotas ou ml, estoque em ml) **e já é falsa hoje para
sólidos** quando o usuário toma mais de uma unidade por vez.

Esta parte é **exclusivamente estrutural**: banco de dados, cálculo e backfill.

---

## 2. Fora do escopo (não implementar)

- **Qualquer alteração no fluxo de coleta do cadastro.** As etapas `cad_nome` → `cad_forma`
  → `cad_dosagem` → `cad_tipo_tratamento` → `cad_horarios` → `cad_estoque` →
  `cad_confirmacao` permanecem **exatamente como estão**. Nenhuma pergunta nova, nenhuma
  pergunta removida, nenhum texto alterado em `buildSystemPrompt` de `cadastro.js`.
- **Qualquer alteração de texto exibido ao usuário.** Os ~34 pontos que escrevem
  "unidade"/"unidades"/"comprimidos" continuam como estão. Isso é a Parte D.
- **Renomear a tabela `schedules`.** Avaliado e descartado na v33 (ver seção 10).
- **Recorrência** (1x/semana, dia sim dia não, dias específicos da semana). Item de
  backlog separado, fora da MH-073.
- **`forma_farmaceutica`**: não adicionar CHECK, não limpar valores divergentes, não
  alterar seu preenchimento. Permanece campo puramente descritivo (ver seção 4.3).
- **`cadastro.js:406-431`** (pré-cálculo de `alerta_estoque_baixo`): **não tocar**. Opera
  sobre contexto pré-salvamento, onde ainda não existe `medication_id`. Depende da coleta,
  que é Parte B. Ver seção 6.4.
- **Correção do estoque do "Omega 3"**: apenas relatar, não corrigir. Ver seção 8.3.

---

## 3. Contexto — evidência que motiva esta parte

Levantamento em produção durante a v33 (dados reais, não hipótese):

**Medicamento `Omega 3`** (`medication_id: af219595-9f67-48ba-b77e-6b5eceb8eae8`)

| Campo | Valor |
|---|---|
| `dosagem` | `"4 comprimidos por dia (2 às 10:00 e 2 às 21:30)"` |
| schedules ativos | 2 (`10:00:00` e `21:30:00`) |
| movimentos `dose_confirmada` | 15 |
| soma dos deltas | **−15** |

O usuário toma **2 comprimidos por dose**. O sistema debitou **1 por dose**. Consumo real
30 unidades, registrado 15 — **subcontabilização de 50% em produção, em medicamento sólido.**

Duas conclusões que orientam o desenho:

1. A lacuna "quantidade por dose" **não é exclusiva de líquidos**. Líquidos apenas tornam
   impossível continuar ignorando.
2. `dosagem` virou lixeira semântica: sem campo estruturado para "quanto se toma por vez",
   o LLM despejou a posologia inteira num campo `text` que nenhum cálculo consome.

**Nenhum medicamento líquido existe na base hoje** (16 comprimido, 3 cápsula/capsula,
1 efervescente). O backfill é trivial e não há dado a migrar.

---

## 4. Migration

Arquivo: `supabase/migrations/20260819000000_mh073_parteA_unidades_dose.sql`

**Aplicação manual via SQL Editor do Supabase** (padrão do projeto). Confirmar aplicação
antes de considerar o item entregue.

### 4.1 Script completo

```sql
-- =============================================================================
-- MH-073 Parte A — separar unidade de estoque da unidade de dose.
--
-- Quebra a equação implícita "1 schedule = 1 dose = 1 unidade de estoque".
-- Habilita medicamentos líquidos (dose em gotas/ml, estoque em ml) e corrige a
-- subcontabilização já existente em sólidos com mais de uma unidade por dose.
--
-- IMPORTANTE: get_pending_reminders declara estoque_atual como int no RETURNS
-- TABLE. Como a coluna passa a numeric, a função DEVE ser recriada no mesmo
-- script — caso contrário ela falha na primeira execução do cron, não aqui.
-- =============================================================================

-- ── 1. Tipos numéricos: estoque passa a aceitar fração (ml) ──────────────────
ALTER TABLE medications  ALTER COLUMN estoque_atual    TYPE numeric;
ALTER TABLE medications  ALTER COLUMN estoque_minimo   TYPE numeric;

ALTER TABLE stock_movements ALTER COLUMN quantidade_delta TYPE numeric;
ALTER TABLE stock_movements ALTER COLUMN estoque_anterior TYPE numeric;
ALTER TABLE stock_movements ALTER COLUMN estoque_novo     TYPE numeric;

-- ── 2. Unidades — chaves de comportamento (conjunto fechado) ─────────────────
ALTER TABLE medications
    ADD COLUMN IF NOT EXISTS unidade_estoque text NOT NULL DEFAULT 'unidade',
    ADD COLUMN IF NOT EXISTS unidade_dose    text NOT NULL DEFAULT 'unidade',
    ADD COLUMN IF NOT EXISTS gotas_por_ml    numeric DEFAULT 20;

ALTER TABLE medications
    ADD CONSTRAINT medications_unidade_estoque_check
        CHECK (unidade_estoque IN ('unidade','ml')),
    ADD CONSTRAINT medications_unidade_dose_check
        CHECK (unidade_dose IN ('unidade','ml','gota')),
    ADD CONSTRAINT medications_gotas_por_ml_check
        CHECK (gotas_por_ml IS NULL OR gotas_por_ml > 0);

-- Coerência entre os dois eixos: dose em gota/ml exige estoque em ml;
-- dose em unidade exige estoque em unidade. Barreira de schema (Princípio 41).
ALTER TABLE medications
    ADD CONSTRAINT medications_coerencia_unidades_check CHECK (
        (unidade_dose = 'unidade' AND unidade_estoque = 'unidade')
     OR (unidade_dose IN ('ml','gota') AND unidade_estoque = 'ml')
    );

-- gotas_por_ml só faz sentido quando a dose é em gotas.
ALTER TABLE medications
    ADD CONSTRAINT medications_gotas_por_ml_exigido_check CHECK (
        unidade_dose <> 'gota' OR gotas_por_ml IS NOT NULL
    );

-- ── 3. Quantidade por dose — posologia, na linha de posologia ────────────────
-- NOTA: a tabela `schedules` é, na prática, a tabela de posologia — guarda
-- horario, dias_semana e agora quantidade_por_dose. O nome é histórico; o
-- disparo real dos lembretes é feito por get_pending_reminders + node-cron.
-- Decisão consciente de NÃO renomear (v33).
ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS quantidade_por_dose numeric NOT NULL DEFAULT 1;

ALTER TABLE schedules
    ADD CONSTRAINT schedules_quantidade_por_dose_check
        CHECK (quantidade_por_dose > 0);

-- ── 4. Vínculo dose ↔ posologia ──────────────────────────────────────────────
-- Sem esta coluna não há como saber QUANTO debitar quando a quantidade varia
-- por horário. O scheduler já recebe schedule_id de get_pending_reminders e o
-- descartava. NULL = dose anterior à Parte A (quantidade tratada como 1).
ALTER TABLE dose_logs
    ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dose_logs_schedule_id
    ON dose_logs(schedule_id) WHERE schedule_id IS NOT NULL;

-- ── 5. Recriar get_pending_reminders ─────────────────────────────────────────
-- CREATE OR REPLACE NÃO consegue alterar o tipo de retorno: é obrigatório DROP.
-- Aproveita-se para expor quantidade_por_dose (necessária na Parte D para o
-- texto do lembrete) e evitar um segundo DROP futuro.
DROP FUNCTION IF EXISTS public.get_pending_reminders();

CREATE FUNCTION public.get_pending_reminders()
RETURNS TABLE (
    schedule_id          uuid,
    medication_id        uuid,
    user_id              uuid,
    phone                text,
    user_name            text,
    med_nome             text,
    med_dosagem          text,
    horario              time,
    estoque_atual        numeric,
    estoque_minimo       numeric,
    quantidade_por_dose  numeric,
    unidade_dose         text,
    unidade_estoque      text,
    gotas_por_ml         numeric
)
LANGUAGE sql
AS $$
    SELECT
        s.id            AS schedule_id,
        m.id            AS medication_id,
        u.id            AS user_id,
        u.phone,
        u.name          AS user_name,
        m.nome          AS med_nome,
        m.dosagem       AS med_dosagem,
        s.horario,
        m.estoque_atual,
        m.estoque_minimo,
        s.quantidade_por_dose,
        m.unidade_dose,
        m.unidade_estoque,
        m.gotas_por_ml
    FROM schedules s
    JOIN medications m ON m.id = s.medication_id
    JOIN users u ON u.id = m.user_id
    WHERE s.ativo = true
    AND m.ativo = true
    AND s.horario BETWEEN
        (now() AT TIME ZONE 'America/Sao_Paulo')::time - interval '2 minutes'
        AND
        (now() AT TIME ZONE 'America/Sao_Paulo')::time + interval '2 minutes'
    AND (
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 1 AND 'seg' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 2 AND 'ter' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 3 AND 'qua' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 4 AND 'qui' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 5 AND 'sex' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 6 AND 'sab' = ANY(s.dias_semana)) OR
        (EXTRACT(dow FROM now() AT TIME ZONE 'America/Sao_Paulo') = 0 AND 'dom' = ANY(s.dias_semana))
    )
    AND NOT EXISTS (
        SELECT 1 FROM dose_logs dl
        WHERE dl.medication_id = m.id
        AND (dl.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date
            = (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND dl.reminder_sent = true
        AND dl.reminder_sent_at > now() - interval '5 minutes'
    );
$$;

-- ── 6. Backfill ──────────────────────────────────────────────────────────────
-- Todos os medicamentos existentes são sólidos com 1 unidade por dose.
-- Os DEFAULT já cobrem as linhas existentes; os UPDATEs são idempotentes e
-- explícitos para deixar o estado inicial documentado.
UPDATE medications SET unidade_estoque = 'unidade', unidade_dose = 'unidade'
WHERE unidade_estoque IS NULL OR unidade_dose IS NULL;

UPDATE schedules SET quantidade_por_dose = 1 WHERE quantidade_por_dose IS NULL;

-- Correção pontual: Omega 3 — usuário toma 2 comprimidos por dose (evidência na
-- própria coluna dosagem). NÃO corrige estoque_atual — ver seção 8.3 do briefing.
UPDATE schedules SET quantidade_por_dose = 2
WHERE medication_id = 'af219595-9f67-48ba-b77e-6b5eceb8eae8';

-- ── 7. Comentários ───────────────────────────────────────────────────────────
COMMENT ON COLUMN medications.unidade_estoque IS
  'Unidade em que estoque_atual é contado: unidade | ml. Chave de comportamento (MH-073).';
COMMENT ON COLUMN medications.unidade_dose IS
  'Unidade em que a dose é administrada: unidade | ml | gota. Chave de comportamento (MH-073).';
COMMENT ON COLUMN medications.gotas_por_ml IS
  'Convenção 20 gts/ml por padrão; editável por medicamento. Âncora de conversão gota→ml (MH-073).';
COMMENT ON COLUMN medications.forma_farmaceutica IS
  'DESCRITIVO — apenas exibido ao usuário. NUNCA usar como condicional de cálculo. Use unidade_dose/unidade_estoque (MH-073 Parte A).';
COMMENT ON COLUMN schedules.quantidade_por_dose IS
  'Quantas unidades_dose se toma neste horário. Posologia (MH-073 Parte A).';
COMMENT ON COLUMN dose_logs.schedule_id IS
  'Posologia que originou a dose. NULL = anterior à MH-073 Parte A (quantidade tratada como 1).';
```

### 4.2 Verificação obrigatória após aplicar

```sql
-- deve retornar 1 linha, sem erro
SELECT * FROM get_pending_reminders() LIMIT 0;

-- deve retornar 2 linhas com quantidade_por_dose = 2
SELECT horario, quantidade_por_dose FROM schedules
WHERE medication_id = 'af219595-9f67-48ba-b77e-6b5eceb8eae8';

-- deve retornar 0
SELECT count(*) FROM schedules WHERE quantidade_por_dose IS NULL;
```

### 4.3 Nota de desenho — por que `forma_farmaceutica` não vira CHECK

`forma_farmaceutica` é preenchida por LLM em texto livre e já apresenta deriva em produção
(`cápsula` / `capsula` / `efervescente`, este último fora da lista sugerida no prompt).

Ela é lida em **um único ponto de todo o código** (`relatorios.js:336`), e apenas para
compor texto. Nenhum `if` depende dela.

**Decisão:** `forma_farmaceutica` permanece descritiva e livre. O comportamento é governado
exclusivamente por `unidade_estoque` e `unidade_dose`, que são conjunto fechado com CHECK.
Motivos:

- `forma_farmaceutica` **não determina a unidade nem em teoria**: colírio e xarope são ambos
  líquidos, mas colírio dosa em gotas e xarope em ml; "efervescente" é sólido apesar do nome.
  São eixos ortogonais.
- Colocar CHECK nela obrigaria limpar valores divergentes (escopo de outra parte) e ainda
  assim não entregaria o dado que o cálculo precisa.
- Divergência entre os campos (ex: `forma = 'comprimido'` com `unidade_dose = 'gota'`) produz
  **texto estranho, nunca cálculo errado** — falha barata, coerente com a filosofia de fase beta.

---

## 5. Alterações em `src/database.js`

Todas as edições abaixo são **substituições cirúrgicas de texto**. Não reescrever os arquivos.

### 5.1 Novo helper — resolução determinística da quantidade por dose

Inserir **imediatamente antes** de `export async function confirmDose(medicationId) {`:

```js
// ============================================================
// MH-073 Parte A — QUANTIDADE POR DOSE E CONVERSÃO PARA ESTOQUE
// ============================================================

// Resolve quantas unidades_dose uma dose representa, na ordem de confiabilidade
// da evidência disponível. NUNCA infere: cada degrau é uma fonte determinística,
// e o degrau final registra system_event em vez de chutar silenciosamente.
//
// 1. dose_logs.schedule_id  → fonte da verdade (doses criadas a partir da Parte A)
// 2. dose_logs.horario_agendado casando com EXATAMENTE 1 schedule ativo
// 3. todos os schedules ativos do medicamento têm a mesma quantidade → usa ela
// 4. ambíguo → retorna 1 e registra degradação visível
export async function resolverQuantidadePorDose(doseLog) {
    const medicationId = doseLog.medication_id;

    // Degrau 1 — vínculo direto
    if (doseLog.schedule_id) {
        const { data: sched } = await supabase
            .from('schedules')
            .select('quantidade_por_dose')
            .eq('id', doseLog.schedule_id)
            .maybeSingle();
        if (sched) return Number(sched.quantidade_por_dose);
    }

    const { data: schedules } = await supabase
        .from('schedules')
        .select('id, horario, quantidade_por_dose')
        .eq('medication_id', medicationId)
        .eq('ativo', true);

    const lista = schedules || [];
    if (lista.length === 0) return 1;

    // Degrau 2 — casamento por horário agendado, apenas se não ambíguo
    if (doseLog.horario_agendado) {
        const alvo = String(doseLog.horario_agendado).substring(0, 5);
        const casados = lista.filter(s => String(s.horario).substring(0, 5) === alvo);
        if (casados.length === 1) return Number(casados[0].quantidade_por_dose);
    }

    // Degrau 3 — quantidade uniforme entre todos os horários
    const distintas = [...new Set(lista.map(s => Number(s.quantidade_por_dose)))];
    if (distintas.length === 1) return distintas[0];

    // Degrau 4 — ambíguo: não chuta em silêncio
    await registrarEvento({
        tipo: 'degradacao_silenciosa',
        severidade: 'media',
        origem: 'database',
        agent: 'database',
        titulo: 'Quantidade por dose ambígua — fallback para 1',
        payload: {
            funcao: 'resolverQuantidadePorDose',
            dose_log_id: doseLog.id,
            medication_id: medicationId,
            schedule_id: doseLog.schedule_id ?? null,
            horario_agendado: doseLog.horario_agendado ?? null,
            quantidades_distintas: distintas
        }
    });
    return 1;
}

// Converte a quantidade de uma dose para a unidade em que o estoque é contado.
// Âncora definida na v33: gotas_por_ml é a ponte entre dose em gotas e estoque em ml.
// Em Parte A todos os medicamentos são unidade→unidade, então esta função é
// identidade na prática; existe para que as Partes B–E não precisem tocar o núcleo.
export function converterDoseParaEstoque({ quantidade, unidade_dose, unidade_estoque, gotas_por_ml }) {
    if (unidade_dose === 'gota' && unidade_estoque === 'ml') {
        const fator = Number(gotas_por_ml) || 20;
        return quantidade / fator;
    }
    return quantidade;
}

// Quantidade a debitar do estoque por uma dose confirmada, já na unidade de estoque.
export async function calcularDeltaEstoqueDaDose(doseLog) {
    const quantidade = await resolverQuantidadePorDose(doseLog);

    const { data: med } = await supabase
        .from('medications')
        .select('unidade_dose, unidade_estoque, gotas_por_ml')
        .eq('id', doseLog.medication_id)
        .single();

    if (!med) return quantidade;

    return converterDoseParaEstoque({
        quantidade,
        unidade_dose: med.unidade_dose,
        unidade_estoque: med.unidade_estoque,
        gotas_por_ml: med.gotas_por_ml
    });
}

// Consumo diário total do medicamento, na unidade de estoque — soma de todos os
// horários ativos. Substitui a contagem de schedules como proxy de consumo.
export async function calcularConsumoDiario(medicationId) {
    const { data: med } = await supabase
        .from('medications')
        .select('unidade_dose, unidade_estoque, gotas_por_ml')
        .eq('id', medicationId)
        .single();

    const { data: schedules } = await supabase
        .from('schedules')
        .select('quantidade_por_dose')
        .eq('medication_id', medicationId)
        .eq('ativo', true);

    const lista = schedules || [];
    if (!med || lista.length === 0) return { consumoDiario: 0, dosesPerDia: 0 };

    const somaDoses = lista.reduce((acc, s) => acc + Number(s.quantidade_por_dose), 0);

    return {
        consumoDiario: converterDoseParaEstoque({
            quantidade: somaDoses,
            unidade_dose: med.unidade_dose,
            unidade_estoque: med.unidade_estoque,
            gotas_por_ml: med.gotas_por_ml
        }),
        dosesPerDia: lista.length
    };
}
```

**Import necessário no topo de `database.js`:** `registrarEvento` de `./observabilidade.js`.
Verificar se já existe; se houver risco de import circular (`observabilidade.js` importando
`database.js`), usar import dinâmico dentro da função (`const { registrarEvento } = await
import('./observabilidade.js')`). **Confirmar qual caminho foi usado no relato.**

### 5.2 Os quatro pontos de `delta: ±1`

**(1) `confirmDose`** — o log já está em mãos na variável `log`:

```js
    // Decrementa o estoque
    await registrarMovimentoEstoque({
        medicationId,
        tipo: 'dose_confirmada',
        origem: 'automatico',
        delta: -1,
        doseLogId: log.id
    });
```

→

```js
    // Decrementa o estoque (MH-073: quantidade vem da posologia, não é mais fixa em 1)
    const deltaDose = await calcularDeltaEstoqueDaDose(log);
    await registrarMovimentoEstoque({
        medicationId,
        tipo: 'dose_confirmada',
        origem: 'automatico',
        delta: -deltaDose,
        doseLogId: log.id
    });
```

**(2) `confirmDoseByLogId`** — `log` já foi carregado no início da função:

```js
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_confirmada',
        origem: 'automatico',
        delta: -1,
        doseLogId
    });

    return log.medication_id;
```

→

```js
    const deltaDose = await calcularDeltaEstoqueDaDose(log);
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_confirmada',
        origem: 'automatico',
        delta: -deltaDose,
        doseLogId
    });

    return log.medication_id;
```

**(3) `confirmarDoseRetroativa`**:

```js
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_retroativa',
        origem: 'automatico',
        delta: -1,
        doseLogId
    });
```

→

```js
    const deltaDose = await calcularDeltaEstoqueDaDose(log);
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_retroativa',
        origem: 'automatico',
        delta: -deltaDose,
        doseLogId
    });
```

**(4) `reverterConfirmacao`** — reversão devolve **exatamente** o que foi debitado:

```js
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_revertida',
        origem: 'automatico',
        delta: 1,
        doseLogId
    });
```

→

```js
    const deltaDose = await calcularDeltaEstoqueDaDose(log);
    await registrarMovimentoEstoque({
        medicationId: log.medication_id,
        tipo: 'dose_revertida',
        origem: 'automatico',
        delta: deltaDose,
        doseLogId
    });
```

> **Atenção — assimetria conhecida e aceita:** se a `quantidade_por_dose` for alterada entre
> a confirmação e a reversão, a devolução usa o valor **novo**, não o histórico. O valor
> exato debitado está em `stock_movements.quantidade_delta` da linha com o mesmo
> `dose_log_id`. Ler de lá seria mais correto, mas exige tratar o caso de múltiplos
> movimentos por dose. **Não implementar agora** — registrar como ACH ao fim da sessão.

### 5.3 `createDoseLog` — persistir o vínculo

```js
export async function createDoseLog({
    medicationId, scheduledAt, reminderSent, reminderSentAt,
    zapiMessageId = null, status = 'pendente',
    horarioAgendado = null
}) {
```

→

```js
export async function createDoseLog({
    medicationId, scheduledAt, reminderSent, reminderSentAt,
    zapiMessageId = null, status = 'pendente',
    horarioAgendado = null, scheduleId = null
}) {
```

E no objeto do insert:

```js
            zapi_message_id: zapiMessageId,
            horario_agendado: horarioAgendado
        })
```

→

```js
            zapi_message_id: zapiMessageId,
            horario_agendado: horarioAgendado,
            schedule_id: scheduleId
        })
```

### 5.4 `getEstoqueInfoParaAlerta` — consumo real, não contagem de horários

```js
    const { data: schedules } = await supabase
        .from('schedules')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('ativo', true);

    const dosesPerDia = (schedules || []).length;
    if (dosesPerDia === 0) return null;

    const diasRestantes = Math.floor(med.estoque_atual / dosesPerDia);
```

→

```js
    // MH-073: dias de cobertura dependem do CONSUMO diário (soma das quantidades),
    // não do número de horários. Com 2 comprimidos por dose e 2 horários, o consumo
    // é 4/dia — contar schedules daria 2 e dobraria a projeção de cobertura.
    const { consumoDiario, dosesPerDia } = await calcularConsumoDiario(medicationId);
    if (dosesPerDia === 0 || consumoDiario <= 0) return null;

    const diasRestantes = Math.floor(Number(med.estoque_atual) / consumoDiario);
```

O objeto de retorno ganha `consumoDiario`, mantendo `dosesPerDia` (usado em textos):

```js
    return {
        medNome: med.nome,
        novoEstoque: med.estoque_atual,
        dosesPerDia,
        consumoDiario,
        diasRestantes,
```

### 5.5 `calcularProgressoTratamento` — mesma correção

```js
        const dosesPorDia = (med.schedules || []).filter(s => s.ativo).length || 1;
        const dosesRestantes = diasRestantes * dosesPorDia;
```

→

```js
        const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);
        const dosesPorDia = schedulesAtivos.length || 1;
        const dosesRestantes = diasRestantes * dosesPorDia;
        // MH-073: consumo diário na unidade de estoque (soma das quantidades por dose)
        const consumoDiario = schedulesAtivos.reduce(
            (acc, s) => acc + Number(s.quantidade_por_dose ?? 1), 0
        ) || 1;
```

E acrescentar `consumoDiario` ao objeto retornado, junto de `estoqueAtual` e `dosesPorDia`.

> **Pré-requisito:** `getUserMedications` precisa trazer o campo novo. Alterar o select
> aninhado de `schedules (id, horario, dias_semana, ativo)` para
> `schedules (id, horario, dias_semana, ativo, quantidade_por_dose)`.
> **Não alterar a chave `schedules`** do join — ela nomeia a propriedade retornada e é lida
> em 10 pontos do código.

### 5.6 `replaceMedication` — blindar contra perda da posologia

`replaceMedication` faz `.delete()` de todos os schedules e recria. Isso **apagaria a
quantidade por dose silenciosamente**. Preservar antes de apagar:

```js
    // Apaga horários antigos e recria
    await supabase.from('schedules').delete().eq('medication_id', medicationId);

    if (horarios && horarios.length > 0) {
        for (let horario of horarios) {
            if (typeof horario === 'object') {
                horario = horario.horario || horario.hora || Object.values(horario)[0];
            }
            const horarioStr = String(horario).trim().substring(0, 5);
            await saveSchedule({ medicationId, horario: horarioStr });
        }
    }
```

→

```js
    // MH-073: preserva quantidade_por_dose antes de recriar os horários — sem isso,
    // uma substituição de cadastro zeraria a posologia silenciosamente.
    const { data: schedulesAntigos } = await supabase
        .from('schedules')
        .select('horario, quantidade_por_dose')
        .eq('medication_id', medicationId);

    const quantidadePorHorario = new Map(
        (schedulesAntigos || []).map(s => [
            String(s.horario).substring(0, 5),
            Number(s.quantidade_por_dose)
        ])
    );
    const quantidadesDistintas = [...new Set(quantidadePorHorario.values())];
    const quantidadePadrao = quantidadesDistintas.length === 1 ? quantidadesDistintas[0] : 1;

    // Apaga horários antigos e recria
    await supabase.from('schedules').delete().eq('medication_id', medicationId);

    if (horarios && horarios.length > 0) {
        for (let horario of horarios) {
            if (typeof horario === 'object') {
                horario = horario.horario || horario.hora || Object.values(horario)[0];
            }
            const horarioStr = String(horario).trim().substring(0, 5);
            await saveSchedule({
                medicationId,
                horario: horarioStr,
                quantidadePorDose: quantidadePorHorario.get(horarioStr) ?? quantidadePadrao
            });
        }
    }
```

**Regra de preservação:** horário que existia antes mantém sua quantidade; horário novo herda
a quantidade padrão **apenas se ela for uniforme** entre os antigos — caso contrário, 1.

### 5.7 `saveSchedule` — aceitar a quantidade

```js
export async function saveSchedule({ medicationId, horario }) {
    const { error } = await supabase
        .from('schedules')
        .insert({
            medication_id: medicationId,
            horario
        });
```

→

```js
export async function saveSchedule({ medicationId, horario, quantidadePorDose = 1 }) {
    const { error } = await supabase
        .from('schedules')
        .insert({
            medication_id: medicationId,
            horario,
            quantidade_por_dose: quantidadePorDose
        });
```

### 5.8 `reativarComAtualizacao` — mesma blindagem

O fluxo desativa todos os schedules (`ativo = false`) e **insere linhas novas**. Aplicar a
mesma preservação da seção 5.6: ler `horario` + `quantidade_por_dose` dos schedules
existentes **antes** do update de desativação, e usar o mesmo `Map` + regra de padrão
uniforme ao inserir os novos.

### 5.9 `adicionarSchedule` — herdar quantidade

Horário adicionado a um medicamento existente deve herdar a quantidade dos demais quando ela
for uniforme; caso contrário, 1. Aplicar a mesma regra e passar o valor no insert.

---

## 6. Alterações em `src/scheduler.js`

### 6.1 Passar `scheduleId` nas três chamadas de `createDoseLog`

O objeto `reminder` já contém `schedule_id` (vindo da RPC). As três chamadas estão nas
linhas ~209, ~329 e ~359. Em cada uma, acrescentar ao objeto de argumentos:

```js
                horarioAgendado
            });
```

→

```js
                horarioAgendado,
                scheduleId: reminder.schedule_id
            });
```

Aplicar nas **três** ocorrências (lembrete agrupado, estoque zerado, lembrete individual).
Atenção à indentação, que difere entre elas.

### 6.2 Portão de estoque zerado — não alterar nesta parte

As comparações `r.estoque_atual !== null && r.estoque_atual <= 0` (linhas 65-66 e 322)
funcionam corretamente com `numeric` (o driver entrega número). **Não alterar.**

> Limitação conhecida e **aceita nesta parte**: o portão dispara apenas em estoque ≤ 0, não
> em "estoque insuficiente para esta dose" (ex: 1 ml restante para uma dose de 5 ml). Isso é
> escopo da Parte E, junto com a revisão de `estoque_minimo`. Registrar como ACH.

---

## 7. Alterações em `src/agentes/relatorios.js`

Em `montarBlocoIndividual`:

```js
    const diasCobertosPeloEstoque = Math.floor(p.estoqueAtual / p.dosesPorDia);
```

→

```js
    const diasCobertosPeloEstoque = Math.floor(p.estoqueAtual / (p.consumoDiario || 1));
```

Nenhuma outra alteração em `relatorios.js`. Os textos com "unidades" (linhas 371-376)
permanecem — são Parte D.

---

## 8. Backfill e dados

### 8.1 Estado esperado após a migration

| Tabela | Coluna | Valor em todas as linhas |
|---|---|---|
| `medications` | `unidade_estoque` | `'unidade'` |
| `medications` | `unidade_dose` | `'unidade'` |
| `medications` | `gotas_por_ml` | `20` |
| `schedules` | `quantidade_por_dose` | `1` (exceto Omega 3 = `2`) |
| `dose_logs` | `schedule_id` | `NULL` |

### 8.2 `dose_logs.schedule_id` — sem backfill retroativo

**Decisão: não fazer backfill.** Das 978 linhas existentes, **311 (32%) têm
`horario_agendado` NULL** (anteriores à MH-032), tornando impossível reconstruir o vínculo
para um terço da base. Reconstruir só os 67% seria criar um dado parcialmente confiável —
pior que a ausência declarada.

`NULL` passa a significar, sem ambiguidade: *dose anterior à MH-073 Parte A, quantidade 1*.
`resolverQuantidadePorDose` trata isso corretamente nos degraus 2-4.

### 8.3 Estoque do Omega 3 — relatar, não corrigir

O `estoque_atual = 28` está inflado: 15 doses foram debitadas com 1 quando deveriam ter sido
2, ou seja, **~15 unidades a mais do que o real**.

**Não corrigir automaticamente.** Motivos: pode ser dado de teste; a correção é um
`correcao_set` que precisa de valor real conferido pelo usuário; e alterar estoque sem
evidência do valor verdadeiro violaria o princípio de causa raiz confirmada.

**Ação:** apenas relatar o número no fechamento, para decisão do Guilherme.

---

## 9. Critérios de aceite

A Parte A está entregue quando **todos** forem verdadeiros:

1. Migration aplicada; as três queries da seção 4.2 retornam o esperado.
2. `get_pending_reminders()` executa sem erro e o cron dispara lembretes normalmente.
3. **Comportamento externo idêntico ao anterior para todos os medicamentos de 1 unidade
   por dose** — mesmos textos, mesmos alertas, mesmos horários. Esta parte não muda nada
   que o usuário veja.
4. Confirmação de dose do **Omega 3** debita **2** do estoque (verificar em
   `stock_movements`: `quantidade_delta = -2`).
5. Reversão de confirmação do Omega 3 devolve **+2**.
6. Novos `dose_logs` criados pelo scheduler têm `schedule_id` preenchido.
7. Nenhum `system_event` de `degradacao_silenciosa` com
   `funcao = 'resolverQuantidadePorDose'` em operação normal.
8. `npm start` sobe sem erro de import (atenção ao possível ciclo `database.js` ↔
   `observabilidade.js`, seção 5.1).

### 9.1 Teste manual sugerido

Usar o medicamento de teste do Guilherme (user_id `e3e838c3-9443-46be-b03e-655f46fdf24a`):
cadastrar um medicamento, `UPDATE schedules SET quantidade_por_dose = 3` manualmente,
confirmar uma dose e verificar `quantidade_delta = -3` em `stock_movements`.

---

## 10. Decisões de arquitetura registradas nesta parte

**10.1 — Quantidade por dose mora em `schedules`, não em `medications`.**
Posologia é um conjunto de tuplas `(quanto, quando)`, não um escalar. Um campo único em
`medications` não representaria "2 de manhã e 1 à noite", que é realidade clínica confirmada
pelo Guilherme (desmame de corticoide, pediatria). `schedules` já é a tabela de posologia —
guarda `horario` e `dias_semana`, ambos fatos de prescrição, não de agendamento.

**10.2 — A tabela `schedules` NÃO foi renomeada.**
O rename para `posologia` foi avaliado e descartado na v33. O inventário mostrou dois riscos
desproporcionais ao ganho (que era apenas de clareza conceitual): a chave do join aninhado do
Supabase muda `med.schedules` → `med.posologia` em **10 pontos de leitura** que um grep por
`from('schedules')` não encontra; e há janela de indisponibilidade entre a migration e o
deploy, com o cron rodando a cada minuto. **Não relitigar sem motivo novo.**

**10.3 — `forma_farmaceutica` é descritiva; `unidade_*` é chave de comportamento.**
Ver seção 4.3.

**10.4 — Convenção de gotas: 20 gts/ml, editável por medicamento.**
Caminho escolhido entre três avaliados. RAG sobre o bulário da ANVISA foi descartado: além
do custo (scraping de PDF, normalização comercial→apresentação, vector store), faria
inferência de LLM alimentar aritmética de dose, violando o princípio de cálculo determinístico
em dado de saúde. Evolução prevista, se houver demanda: **tabela curada** de 30-50
medicamentos versionada no repo — determinística e auditável.

---

## 11. Relato esperado do Claude Code

1. Confirmação de aplicação da migration + saída das três queries da seção 4.2.
2. Diff resumido por arquivo (`database.js`, `scheduler.js`, `relatorios.js`).
3. Qual caminho foi usado para o import de `registrarEvento` (direto ou dinâmico) e por quê.
4. Resultado do teste manual da seção 9.1.
5. Valor atual de `estoque_atual` do Omega 3 (seção 8.3), sem alterá-lo.
6. Qualquer ponto onde o texto real do arquivo divergiu do `old_str` deste briefing —
   **não improvisar a substituição; relatar e aguardar.**