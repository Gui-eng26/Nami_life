# BRIEFING — BUG-044 + BUG-046

**Sessão:** v10 — 22/06/2026  
**Arquivos afetados:** `src/database.js`, `src/router.js`, `src/agentes/principal.js`

---

## Contexto

Dois bugs identificados a partir de interações reais de ontem à noite (21/06), com causa raiz confirmada em código e dados do banco.

**BUG-044:** quando um medicamento é pausado, dose_logs com status `pendente` anteriores à pausa continuam ativos no sistema de follow-up — gerando lembretes de um medicamento que o usuário já pausou.

**BUG-046:** quando há múltiplas doses pendentes e o usuário especifica um medicamento ("Dipirona"), o sistema confirma todos os pendentes em vez de apenas o especificado. Causa raiz: o estado `confirming` não ancora qual medicamento está aguardando confirmação, e o "Sim" subsequente é interpretado como confirmação de tudo que está pendente.

Os dois bugs são independentes mas encadeados na prática: o BUG-044 criou a condição (dois pendentes simultaneamente) que tornou o BUG-046 visível.

---

## BUG-044 — `pausarMedicamento` não cancela dose_logs pendentes

### Causa raiz confirmada

`pausarMedicamento` em `database.js` desativa apenas os `schedules`:

```javascript
export async function pausarMedicamento(medicationId) {
    await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
}
```

Dose_logs com `status: 'pendente'` criados antes da pausa continuam na tabela sem alteração. O cron de follow-up (`getPendingFollowUps`) filtra por `status = 'pendente'` — e continua encontrando e disparando follow-ups desses logs após a pausa.

### Impacto secundário em `temDosePendente`

`temDosePendente` no `router.js` usa `getRecentDoses` e filtra `confirmed: false`. Dose_logs `pausado` terão `confirmed: false` — portanto continuariam aparecendo como "dose pendente" para o roteador mesmo após a correção, se não ajustarmos o filtro.

### Solução

**1. Em `database.js` — `pausarMedicamento`:**

Adicionar cancelamento dos dose_logs pendentes após desativar schedules:

```javascript
export async function pausarMedicamento(medicationId) {
    // Desativa schedules futuros
    const { error: errSched } = await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
    if (errSched) throw new Error(`Erro ao pausar schedules: ${errSched.message}`);

    // Cancela dose_logs pendentes — evita follow-ups após pausa
    const { error: errLogs } = await supabase
        .from('dose_logs')
        .update({ status: 'pausado' })
        .eq('medication_id', medicationId)
        .eq('status', 'pendente');
    if (errLogs) throw new Error(`Erro ao cancelar dose_logs pendentes: ${errLogs.message}`);

    console.log(`⏸️ Medicamento pausado — schedules desativados + dose_logs pendentes marcados como pausado — medication: ${medicationId}`);
}
```

**2. Em `router.js` — `temDosePendente`:**

Excluir status `pausado` do critério de dose pendente:

```javascript
async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return doses.some(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado'
    );
}
```

### Novo status `pausado` — mapa completo de status após esta correção

| Status | Significado | Origem |
|---|---|---|
| `pendente` | Lembrete enviado, aguardando resposta | `createDoseLog` |
| `confirmado` | Usuário confirmou que tomou | `confirmarDose` |
| `nao_tomado` | Usuário confirmou que NÃO tomou | resposta NÃO |
| `nao_informado` | Follow-ups esgotados sem resposta | `marcarNaoInformado` |
| `pausado` | Medicamento pausado antes da confirmação | `pausarMedicamento` (novo) |
| `sem_estoque` | Lembrete disparado com estoque zerado | `createDoseLog` |

---

## BUG-046 — Estado `confirming` sem âncora confirma todas as doses pendentes

### Causa raiz confirmada

Confirmada nos `agent_logs` (22:00 UTC de 21/06):

```
user_message: "Dipirona"
estado_conversa: confirming
contexto_conversa: {}
```

O contexto estava vazio — sem `medicationId`. Quando o usuário disse "Sim" na mensagem seguinte, o LLM do `principal` tinha dois dose_logs pendentes no contexto (Dipirona e Nimesulida) e nenhuma âncora de qual estava sendo confirmado. Confirmou os dois.

### Solução — Opção A: confirmar imediatamente ao receber o medicamento especificado

Em vez de entrar em estado `confirming` sem âncora e aguardar "Sim", quando o usuário especifica um medicamento diretamente, confirmar aquela dose imediatamente.

**Comportamento atual (problema):**
```
Nami: "Você tomou qual remédio? 1️⃣ Dipirona 2️⃣ Nimesulida"
Você: "Dipirona"
Nami: "A dose da Dipirona está pendente. Você tomou agora?"   ← estado confirming, contexto {}
Você: "Sim"
Nami: "✅ Registrei Dipirona e Nimesulida"   ← confirma os dois
```

**Comportamento esperado após correção:**
```
Nami: "Você tomou qual remédio? 1️⃣ Dipirona 2️⃣ Nimesulida"
Você: "Dipirona"
Nami: "✅ Dipirona registrada! Continue assim 💊"   ← confirma imediatamente, sem estado intermediário
```

### Implementação em `principal.js`

Localizar o bloco que processa a resposta do usuário quando `estado_conversa === 'confirming'` e o usuário menciona um medicamento específico.

Quando o LLM identifica que o usuário especificou um medicamento (não "os dois" / "todos"), executar `CONFIRM_DOSE` imediatamente para aquele medicamento e retornar para `idle` — sem passar por um "Sim" adicional.

A lógica deve diferenciar:

- Usuário diz "Dipirona" ou "o primeiro" ou "1" → confirmar apenas aquele medicamento imediatamente → `idle`
- Usuário diz "os dois", "todos", "ambos" → confirmar todos os pendentes → `idle` (comportamento atual, correto)
- Usuário diz algo ambíguo → manter `confirming` com o medicamento identificado persistido no contexto (fallback seguro)

**Ajuste no prompt do `principal` para essa etapa:**

Instruir o LLM que quando o estado for `confirming` e o usuário especificar um medicamento, deve retornar `action: CONFIRM_DOSE` apenas para aquele medicamento, sem pedir confirmação adicional. A pergunta já foi feita — a resposta do usuário é a confirmação.

**Contexto a persistir quando houver ambiguidade (fallback):**

Se por algum motivo o sistema não conseguir identificar o medicamento com certeza e mantiver `confirming`, o contexto deve incluir obrigatoriamente:

```json
{
  "estado": "confirming",
  "medicationId": "uuid-do-medicamento-identificado",
  "medicationNome": "Dipirona"
}
```

Para que o "Sim" subsequente confirme apenas aquele medicamento — não todos os pendentes.

---

## Validação esperada após implementação

**BUG-044:**
1. Usuário pausa Nimesulida com dose pendente das 16:58 → dose_log das 16:58 muda para `pausado`
2. Follow-up das 18:32 não é disparado — `getPendingFollowUps` não retorna logs com status `pausado`
3. `temDosePendente` retorna false para a Nimesulida pausada — roteador não a inclui como dose pendente

**BUG-046:**
1. Dipirona e Nimesulida pendentes → Nami pergunta qual o usuário tomou
2. Usuário responde "Dipirona" → Nami confirma apenas Dipirona imediatamente
3. Nimesulida continua pendente para follow-up posterior
4. Usuário responde "os dois" → Nami confirma ambos (comportamento atual preservado)

---

## BUG-045 — Mapeado no backlog, não implementar agora

**Descrição:** frases no passado ("eu pausei", "já reativei") não são reconhecidas por `detectarIntencaoConfiguracao` — que só reconhece infinitivos. A mensagem cai fora do roteador de configuração e pode ser processada incorretamente.

**Por que não implementar agora:** o gatilho imediato (follow-up indevido após pausa) é eliminado pelo BUG-044. A solução correta requer detecção determinística + verificação real no banco + resposta contextual — não é trivial e merece design próprio.

**Cenários futuros que podem reativar:** "já reativei o losartana", "encerrei o dipirona semana passada", "eu já cadastrei esse remédio antes".

---

**Comando para Claude Code:**  
`Leia o briefings/BRIEFING_BUG044_046.md e implemente.`