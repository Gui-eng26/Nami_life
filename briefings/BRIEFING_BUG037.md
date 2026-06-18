# BRIEFING — BUG-037
## Mensagem de estoque zerado disparada em duplicata por ausência de dose_log

**Data:** 17/06/2026  
**Origem:** Print de interação Vitor — duas mensagens idênticas de estoque zerado do Cimegrip às 6:34 e 6:36  
**Escopo:** `src/database.js`, `src/scheduler.js`  
**Complexidade:** Baixa — sem alteração de banco, dois arquivos, mudanças mínimas

---

## 1. Causa Raiz

O stored procedure `get_pending_reminders` deduplica via:

```sql
AND NOT EXISTS (
    SELECT 1 FROM dose_logs dl
    WHERE dl.medication_id = m.id
    AND (dl.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date
        = (now() AT TIME ZONE 'America/Sao_Paulo')::date
    AND dl.reminder_sent = true
    AND dl.reminder_sent_at > now() - interval '5 minutes'
);
```

O caminho normal de lembrete cria um `dose_log` → dedup funciona → sem duplicata.

O caminho de estoque zerado envia a mensagem e retorna **sem criar dose_log**:

```js
if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
    await sendTextMessage(reminder.phone, message);
    console.log(`📦 Aviso de estoque zerado enviado...`);
    return; // ← sem dose_log → dedup não funciona
}
```

Na próxima execução do scheduler (2 min depois), `get_pending_reminders` não encontra dose_log → retorna o mesmo medicamento → segunda mensagem enviada.

---

## 2. Solução

Criar um `dose_log` com `status: 'sem_estoque'` antes de retornar no caminho de estoque zerado. Isso ativa o dedup do stored procedure sem nenhuma outra mudança.

**Por que `sem_estoque` não gera side effects:**
- `getPendingFollowUps` filtra por `.eq('status', 'pendente')` → `sem_estoque` não gera follow-ups ✅
- `confirmDose` filtra por `confirmed = false` E `status = 'pendente'` → não interfere ✅
- `getAdesaoPeriodo` conta apenas doses com `status = 'confirmado'` → não afeta métricas ✅

---

## 3. Mudanças

### 3.1 — `src/database.js` — adicionar parâmetro `status` em `createDoseLog`

```js
// ANTES
export async function createDoseLog({ medicationId, scheduledAt, reminderSent, reminderSentAt, zapiMessageId = null }) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('dose_logs')
        .insert({
            medication_id: medicationId,
            scheduled_at: scheduledAt,
            reminder_sent: reminderSent,
            reminder_sent_at: reminderSentAt,
            tentativas: 1,
            ultima_tentativa_at: now,
            status: 'pendente',   // ← fixo
            zapi_message_id: zapiMessageId
        })

// DEPOIS
export async function createDoseLog({ medicationId, scheduledAt, reminderSent, reminderSentAt, zapiMessageId = null, status = 'pendente' }) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('dose_logs')
        .insert({
            medication_id: medicationId,
            scheduled_at: scheduledAt,
            reminder_sent: reminderSent,
            reminder_sent_at: reminderSentAt,
            tentativas: 1,
            ultima_tentativa_at: now,
            status: status,        // ← configurável, default 'pendente'
            zapi_message_id: zapiMessageId
        })
```

Apenas o parâmetro e o campo `status` mudam. Tudo que já chama `createDoseLog` sem passar `status` continua funcionando com `'pendente'` como default.

---

### 3.2 — `src/scheduler.js` — criar dose_log no caminho de estoque zerado

```js
// ANTES
if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
    const firstName = reminder.user_name?.split(' ')[0] || 'você';
    const message = buildEstoqueZeradoMessage(firstName, reminder);
    await sendTextMessage(reminder.phone, message);
    console.log(`📦 Aviso de estoque zerado enviado para ${reminder.phone} — ${reminder.med_nome}`);
    return;
}

// DEPOIS
if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
    const firstName = reminder.user_name?.split(' ')[0] || 'você';
    const message = buildEstoqueZeradoMessage(firstName, reminder);
    await sendTextMessage(reminder.phone, message);

    // Cria dose_log com status 'sem_estoque' para ativar deduplicação do scheduler
    // Sem isso, o stored procedure retorna o mesmo medicamento no próximo ciclo
    await createDoseLog({
        medicationId: reminder.medication_id,
        scheduledAt: new Date().toISOString(),
        reminderSent: true,
        reminderSentAt: new Date().toISOString(),
        status: 'sem_estoque'   // exclui de follow-ups e confirmações automaticamente
    });

    console.log(`📦 Aviso de estoque zerado enviado para ${reminder.phone} — ${reminder.med_nome}`);
    return;
}
```

---

## 4. Ordem de Execução

1. `src/database.js` — adicionar parâmetro `status` em `createDoseLog`
2. `src/scheduler.js` — adicionar `createDoseLog` no caminho de estoque zerado
3. Deploy

---

## 5. Validação

Zerar o estoque de um medicamento de teste no Supabase:
```sql
UPDATE medications SET estoque_atual = 0 WHERE nome = 'Cimegrip'
AND user_id = (SELECT id FROM users WHERE phone = '+5516997994376');
```

No horário do próximo lembrete, deve chegar **apenas uma** mensagem de estoque zerado.

Nos logs deve aparecer:
```
📦 Aviso de estoque zerado enviado para +5516997994376 — Cimegrip
📝 DoseLog criado — tentativas: 1, status: sem_estoque
```

E no ciclo seguinte (2 min depois), o scheduler não deve retornar o Cimegrip.