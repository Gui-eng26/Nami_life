# BRIEFING_MH042 — Correção manual de estoque + auditoria sistêmica de movimentação

**Data:** 06/07/2026
**Tipo:** MH (capacidade nova — hoje a Nami só reconhece recompra como linguagem de atualização de estoque)
**Prioridade:** Definida na sessão de planejamento; entra na fila conforme priorização do backlog geral (ver CONTEXT.md)
**Absorve:** a nota "sem ID" de rastreabilidade de estoque, registrada em 01/07 e ligada ao MH-037. Não é mais um item separado — este briefing É a implementação dela, com escopo completo.

---

## 1. Sintoma / demanda original

Guilherme relatou: "se eu pedir uma correção de estoque pq contei errado, ou pq perdi medicamentos, a Nami não atualiza. Ela só incrementa para novas compras."

## 2. Causa raiz confirmada (código real, não hipótese)

`updateMedicationStock(medicationId, novoEstoque)` (`database.js:182`) já é um **SET absoluto** — não incrementa por si só, apenas sobrescreve `estoque_atual`. A camada de dado já suportaria correção hoje.

O problema está inteiramente na camada de instrução do LLM. Em `prompts.js:79` e `prompts.js:158-163`, a ação `UPDATE_STOCK` só é descrita e disparada para o caso de **recompra**:

```
- UPDATE_STOCK: atualizar estoque de medicamento após recompra
...
ATUALIZAÇÃO DE ESTOQUE:
Se o usuário informar que comprou mais unidades de um medicamento
(ex: "comprei 30 comprimidos...", "renovei o estoque"...)
```

Frases de recontagem ou perda não têm gatilho nenhum — o LLM nunca foi instruído a reconhecer essa intenção, então a ação nunca é emitida. Confirma exatamente o sintoma relatado.

### 2.1 — Achado adicional durante a investigação (não é o bug relatado, mas está diretamente relacionado)

O `UPDATE_STOCK` de recompra hoje passa `action.quantidade` (extraído pelo LLM) **diretamente** para `updateMedicationStock`, que trata esse valor como absoluto. Mas o prompt dá exemplos ambíguos ("comprei 30 comprimidos" vs. "tenho 60 comprimidos agora") sem instruir o LLM a somar ou substituir — ou seja, hoje o LLM já pode estar fazendo aritmética implícita (decidir se soma ou substitui) para gerar esse número. Isso é uma violação silenciosa do princípio "cálculos de saúde determinísticos, nunca por LLM" que **já existia antes deste MH**. A solução abaixo corrige isso de tabela, sem exigir uma entrega separada.

---

## 3. Inventário completo de pontos que hoje escrevem em `estoque_atual`

Levantamento exaustivo — nenhum ponto deve ficar de fora do retrofit:

| # | Arquivo:linha | Função | Escrita hoje | Tipo de movimento no novo schema |
|---|---|---|---|---|
| 1 | `database.js:90` (`saveMedication`) | INSERT direto — cadastro novo | `cadastro_inicial` |
| 2 | `database.js:129` (`replaceMedication`) | UPDATE direto — cadastro substitui duplicata | `cadastro_substituicao` |
| 3 | `database.js:246` (`confirmDose`) | via `updateMedicationStock`, −1 | `dose_confirmada` |
| 4 | `database.js:391` (`confirmDoseByLogId`) | via `updateMedicationStock`, −1 | `dose_confirmada` |
| 5 | `database.js:560` (`confirmarDoseRetroativa`) | via `updateMedicationStock`, −1 | `dose_retroativa` |
| 6 | `database.js:593` (`reverterConfirmacao`) | via `updateMedicationStock`, +1 | `dose_revertida` |
| 7 | `principal.js:378` (ação `UPDATE_STOCK`) | via `updateMedicationStock`, valor absoluto do LLM | `recompra` / `correcao_soma` / `correcao_subtracao` / `correcao_set` (novos) |
| 8 | `configuracao.js:367,674` (`reativarComAtualizacao`) | UPDATE direto — reativação de tratamento pausado com estoque atualizado | `reativacao_com_estoque` |

Os itens 3–6 já convergem para `updateMedicationStock` — único ponto de interceptação para o ciclo de vida de dose. Os itens 1, 2 e 8 escrevem direto na tabela `medications` e precisam ser roteados para a nova função central.

**Explicitamente fora de escopo:** a frase "eu tomei X mas não te avisei" **não** deve disparar `UPDATE_STOCK`. Ela permanece exclusivamente coberta por `CONFIRM_RETROATIVA` (dentro da janela de 2 dias) e pelo fallback textual já existente em `prompts.js:101-104` (fora da janela). Não criar nenhum gatilho de linguagem novo que capture essa frase para o fluxo de estoque — o risco é o usuário aparecer como não-aderente numa dose que na realidade tomou.

---

## 4. Desenho da solução

### 4.1 — Migration: tabela `stock_movements`

Novo arquivo em `supabase/migrations/`, seguindo a convenção de nome (`YYYYMMDDHHMMSS_descricao.sql`):

```sql
-- 20260706000000_mh042_stock_movements.sql

CREATE TABLE stock_movements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    medication_id       uuid NOT NULL REFERENCES medications(id),
    tipo                text NOT NULL CHECK (tipo IN (
                            'cadastro_inicial',
                            'cadastro_substituicao',
                            'reativacao_com_estoque',
                            'recompra',
                            'correcao_soma',
                            'correcao_subtracao',
                            'correcao_set',
                            'dose_confirmada',
                            'dose_retroativa',
                            'dose_revertida'
                        )),
    origem              text NOT NULL CHECK (origem IN ('manual', 'automatico')),
    quantidade_delta    integer NOT NULL,      -- valor efetivamente aplicado, com sinal
    estoque_anterior    integer,               -- null apenas em cadastro_inicial
    estoque_novo        integer NOT NULL,
    motivo              text,                  -- texto livre extraído da mensagem (quando manual)
    dose_log_id         uuid REFERENCES dose_logs(id),  -- preenchido quando o movimento vem de uma dose
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_movements_medication ON stock_movements(medication_id, created_at DESC);
```

Append-only — nunca dar UPDATE ou DELETE em linhas existentes.

### ⚠️ AÇÃO MANUAL NECESSÁRIA (antes de validar, não antes de implementar)

O fluxo de migrations deste projeto **não aplica automaticamente** no banco — versionar o arquivo em
`supabase/migrations/` só documenta a mudança em código (mesmo padrão já registrado no `BRIEFING_MH032.md`).
Depois do Claude Code criar o arquivo de migration, Guilherme precisa:
1. Abrir o painel do Supabase (projeto Brasil/São Paulo)
2. Ir em **SQL Editor**
3. Colar e rodar manualmente o `CREATE TABLE stock_movements` + `CREATE INDEX` acima
4. Só então testar em produção — se o código tentar gravar em `stock_movements` antes da tabela existir,
   qualquer ação de estoque (recompra, correção, confirmação de dose) quebra com erro de tabela inexistente.

### 4.2 — Função central: `registrarMovimentoEstoque` (`database.js`)

Substitui `updateMedicationStock` como único ponto de escrita em estoque (a função antiga pode ser removida depois que todos os 8 pontos forem migrados, ou mantida como wrapper interno privado — decisão de implementação do Claude Code, desde que nenhum código externo continue chamando `updateMedicationStock` diretamente).

```js
export async function registrarMovimentoEstoque({
    medicationId, tipo, origem, motivo = null, doseLogId = null,
    delta = null,        // use quando o movimento é um incremento/decremento conhecido
    valorAbsoluto = null // use quando o movimento é "setar para X" (recontagem, cadastro)
}) {
    const { data: med, error: fetchError } = await supabase
        .from('medications')
        .select('estoque_atual')
        .eq('id', medicationId)
        .single();

    if (fetchError || !med) throw new Error(`Medicamento não encontrado: ${medicationId}`);

    const estoqueAnterior = med.estoque_atual ?? 0;
    let estoqueNovo;
    let deltaAplicado;

    if (valorAbsoluto !== null) {
        estoqueNovo = Math.max(0, valorAbsoluto);
        deltaAplicado = estoqueNovo - estoqueAnterior;
    } else {
        estoqueNovo = Math.max(0, estoqueAnterior + delta);
        deltaAplicado = estoqueNovo - estoqueAnterior; // já reflete o clamp em 0
    }

    const { error: updateError } = await supabase
        .from('medications')
        .update({ estoque_atual: estoqueNovo })
        .eq('id', medicationId);

    if (updateError) throw new Error(`Erro ao atualizar estoque: ${updateError.message}`);

    const { error: logError } = await supabase
        .from('stock_movements')
        .insert({
            medication_id: medicationId,
            tipo,
            origem,
            quantidade_delta: deltaAplicado,
            estoque_anterior: estoqueAnterior,
            estoque_novo: estoqueNovo,
            motivo,
            dose_log_id: doseLogId
        });

    if (logError) throw new Error(`Erro ao registrar movimento de estoque: ${logError.message}`);

    console.log(`📦 Movimento de estoque — tipo: ${tipo}, medication: ${medicationId}, ${estoqueAnterior} → ${estoqueNovo}`);

    return estoqueNovo;
}
```

Nota de implementação: se a Supabase JS SDK não garantir atomicidade entre os dois `.update`/`.insert` acima (não há transação client-side nativa), avaliar mover essa lógica para uma stored procedure (`rpc`) que faça as duas escritas na mesma transação Postgres — consistente com o padrão já usado em `get_pending_reminders`. Decisão de implementação do Claude Code; se optar por manter em JS puro, documentar o risco de inconsistência entre `medications.estoque_atual` e `stock_movements` em caso de falha parcial.

### 4.3 — Retrofit dos 8 pontos (nenhum pode ficar de fora)

| # | Antes | Depois |
|---|---|---|
| 1 `saveMedication` | INSERT direto | Manter o INSERT (cria o registro), e logo em seguida chamar `registrarMovimentoEstoque` com `tipo: 'cadastro_inicial'`, `origem: 'manual'`, `valorAbsoluto: estoque`, `estoqueAnterior` tratado como 0 nesse caso específico (medicamento acabou de nascer) |
| 2 `replaceMedication` | UPDATE direto | Trocar por `registrarMovimentoEstoque({ tipo: 'cadastro_substituicao', origem: 'manual', valorAbsoluto: estoque })` |
| 3 `confirmDose` | `updateMedicationStock(id, atual - 1)` | `registrarMovimentoEstoque({ tipo: 'dose_confirmada', origem: 'automatico', delta: -1, doseLogId: log.id })` |
| 4 `confirmDoseByLogId` | idem | idem, com `doseLogId` já disponível |
| 5 `confirmarDoseRetroativa` | idem | `tipo: 'dose_retroativa'`, `delta: -1`, `doseLogId` |
| 6 `reverterConfirmacao` | `updateMedicationStock(id, atual + 1)` | `tipo: 'dose_revertida'`, `delta: +1`, `doseLogId` |
| 7 ação `UPDATE_STOCK` (`principal.js:378`) | chamada direta | Ver §4.4 — passa a se ramificar em 4 tipos |
| 8 `reativarComAtualizacao` | UPDATE direto | `registrarMovimentoEstoque({ tipo: 'reativacao_com_estoque', origem: 'manual', valorAbsoluto: estoque })` |

### 4.4 — Novo desenho da ação `UPDATE_STOCK` (LLM só extrai, nunca calcula)

Novo formato de ação emitida pelo `agente_principal`:

```json
{ "type": "UPDATE_STOCK", "medicationId": "", "modo": "soma|subtracao|set", "quantidade": 0, "motivo": "" }
```

- `modo: "soma"` → `registrarMovimentoEstoque({ tipo: motivo === 'recompra' ? 'recompra' : 'correcao_soma', delta: +quantidade, motivo })`
- `modo: "subtracao"` → `registrarMovimentoEstoque({ tipo: 'correcao_subtracao', delta: -quantidade, motivo })`
- `modo: "set"` → `registrarMovimentoEstoque({ tipo: 'correcao_set', valorAbsoluto: quantidade, motivo })`

Em todos os casos, `quantidade` é um número que o usuário informou diretamente (quantas comprou, quantas perdeu, ou qual o total atual) — o LLM nunca subtrai nem soma nada; só extrai o número e classifica o `modo`. A conta sempre acontece em `registrarMovimentoEstoque`.

### 4.5 — Atualização de `prompts.js`

Substituir o bloco atual (linhas 79 e 158-163) por:

```
- UPDATE_STOCK: atualizar estoque de medicamento (recompra, correção por recontagem, ou perda/quebra)

ATUALIZAÇÃO DE ESTOQUE:
Identifique três situações possíveis e o "modo" correspondente:

1. RECOMPRA/SOMA (modo: "soma") — usuário informa que ganhou ou comprou mais unidades,
   ou corrigiu a contagem para MAIS do que estava registrado:
   ex: "comprei 30 comprimidos", "renovei o estoque", "contei errado, tenho mais 10",
   "achei mais alguns aqui", "sobrou mais que eu pensava".
   quantidade = a quantidade adicionada (nunca o total).

2. CORREÇÃO PARA MENOS / PERDA (modo: "subtracao") — usuário perdeu, quebrou, descartou
   ou emprestou/doou unidades:
   ex: "perdi 10 comprimidos", "quebrei um vidro com 15", "derramou metade",
   "venceu e joguei fora 5", "dei 3 pra minha mãe".
   quantidade = a quantidade perdida (nunca o total).

3. CORREÇÃO ABSOLUTA (modo: "set") — usuário informa o total atual, sem intenção de
   dizer quanto mudou:
   ex: "tá errado, tenho 20 comprimidos", "precisa mudar o estoque, tenho 20 no total",
   "na verdade são 15".
   quantidade = o valor final total.

Se o usuário disser apenas "quero atualizar o estoque", "estoque tá errado", "preciso
corrigir o estoque" SEM informar nenhum número, NÃO dispare UPDATE_STOCK ainda — pergunte
"Qual a quantidade atual em estoque?" (newState: "confirming") e aguarde a resposta numérica
antes de disparar a ação.

NUNCA use UPDATE_STOCK para "tomei X mas não avisei" — esse caso é sempre
CONFIRM_RETROATIVA (dentro de 2 dias) ou o fallback textual já existente (fora de 2 dias).

Use o id do medicamento correto a partir do contexto de medicamentos cadastrados.
Preencha "motivo" com um resumo curto da frase do usuário (ex: "recompra", "perda por quebra",
"recontagem").
```

Atualizar também o exemplo de ação em `prompts.js:154`:
```
- { "type": "UPDATE_STOCK", "medicationId": "", "modo": "soma|subtracao|set", "quantidade": 0, "motivo": "" }
```

### 4.6 — Atualização do inventário de capacidades do router (princípio #5)

`router.js:259`, capacidade de `principal`, hoje:
```
- principal: conversa geral, dúvidas, saudações, reações ("ok", "obrigado"), fechamentos,
  confirmação de doses, confirmação retroativa de doses (últimos 2 dias), reversão de
  confirmação por engano
```
Adicionar: `, correção/atualização de estoque (recompra, recontagem, perda)` — sem isso, o classificador pode rotear frases como "perdi 10 comprimidos" para `relatorios` (que hoje trata "estoque" como tópico de consulta) em vez de `principal`.

### 4.7 — Alerta de estoque pós-ajuste

Depois de qualquer `registrarMovimentoEstoque` que resulte em `estoque_novo <= 0` ou `estoque_novo <= estoque_minimo`, reaproveitar a lógica de alerta já existente (`database.js:1042-1048`, usada em `relatorios.js`) para informar o usuário na mesma resposta — não criar um segundo mecanismo de alerta.

---

## 5. Cenários de teste (rodar antes de considerar concluído)

1. "comprei 30 comprimidos de Losartana" → `recompra`, +30, log criado
2. "contei errado, tenho mais 10 de Losartana" → `correcao_soma`, +10
3. "tá errado, tenho 20 comprimidos de Losartana" (estoque atual era 35) → `correcao_set`, delta calculado = −15
4. "perdi 10 comprimidos" (estoque atual era 5) → `correcao_subtracao`, clamp em 0, não em −5
5. "quero atualizar o estoque" (sem número) → Nami pergunta a quantidade, aguarda resposta, só então dispara a ação
6. "eu tomei 2 mas não te avisei" (dose dentro de 2 dias) → deve ir para `CONFIRM_RETROATIVA`, nunca para `UPDATE_STOCK` — confirmar que nenhum novo texto do prompt capturou essa frase
7. Confirmação normal de dose (`confirmDose`/`confirmDoseByLogId`) → gera linha em `stock_movements` com `tipo: dose_confirmada`, `origem: automatico`
8. Reversão de confirmação → gera linha `dose_revertida`, +1, e o `estoque_atual` bate com o valor antes da confirmação original
9. Cadastro de medicamento novo → gera linha `cadastro_inicial`
10. Reativação de tratamento pausado com novo estoque informado → gera linha `reativacao_com_estoque`
11. Consultar `stock_movements` para um medicamento com histórico misto (dose + recompra + correção) e confirmar que a soma dos deltas bate com `estoque_atual` final

---

## 6. Fora de escopo deste briefing

- Relatório ou visualização de histórico de movimentação para o usuário final (poderia ser um MH futuro, ex: "me mostra o histórico do meu estoque")
- Qualquer mudança em `MH-037` (cálculo de adesão) além de já existir a tabela para uso futuro
- Alterar o comportamento de `getRecentDoses` ou qualquer lógica de adesão