# BRIEFING COMPLEMENTAR — MH-032: não gravar zapi_message_id em doses agrupadas

> Correção pontual a aplicar ANTES do push do MH-032.
> Sessão v12 — 01/07/2026.

## Contexto (por que)

Uma mensagem agrupada é UMA única mensagem no WhatsApp → tem UM único `message_id`, mas representa 2+ doses (2+ `dose_logs`). O fast-path de confirmação por "responder" (`getDoseLogByZapiMessageId` no router.js) é desenhado para resolver UMA dose por resposta — ele usa `.single()`, que quebra se o mesmo `zapi_message_id` aparecer em múltiplas linhas.

Hoje o fast-path já não funciona (BUG-029: namespace zaapId `019E...` ≠ referenceMessageId `3EB0...`), então isso é inócuo no presente. Mas gravar o mesmo `zapi_message_id` em doses agrupadas é uma **mina adormecida**: no dia em que o BUG-029 for resolvido, doses agrupadas quebrariam o fast-path silenciosamente.

Correção: doses agrupadas simplesmente **não gravam `zapi_message_id`** (fica NULL). Elas pertencem ao fluxo de confirmação por LLM (`[ref:]` no principal.js), que sabe lidar com múltiplas doses. O `getDoseLogByZapiMessageId` já ignora NULL na primeira linha (`if (!zapiMessageId) return null`), então isso é seguro e limpo.

**IMPORTANTE — escopo:** esta mudança vale SÓ para doses em grupo de 2+ (`sendGroupedReminder` e `handleGroupedFollowUp`). Doses individuais (grupo de 1, `sendReminder`) e estoque zerado CONTINUAM gravando `zapi_message_id` normalmente — para elas "uma mensagem → uma dose" é verdade, e o fast-path funcionará corretamente quando o BUG-029 for resolvido.

## Mudanças em `src/scheduler.js`

### 1. `sendGroupedReminder` — não gravar zapiMessageId nos dose_logs do grupo

Remover a captura e a gravação do `zapiMessageId` no loop de criação. A mensagem ainda é enviada normalmente; apenas não persistimos o ID nas doses do grupo.

```javascript
async function sendGroupedReminder(grupo) {
    try {
        const primeiro = grupo[0];
        const firstName = primeiro.user_name?.split(' ')[0] || 'você';
        const horario = String(primeiro.horario).substring(0, 5);

        const message = buildGroupedReminderMessage(firstName, horario, grupo);

        await sendTextMessage(primeiro.phone, message);   // envia, mas não usamos o zaapId

        // Doses agrupadas NÃO gravam zapi_message_id (fica NULL) — ver briefing.
        // A confirmação delas ocorre pelo fluxo [ref:] do principal.js, não pelo fast-path.
        for (const reminder of grupo) {
            await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                // zapiMessageId omitido de propósito (default null)
                horarioAgendado: String(reminder.horario).substring(0, 5)
            });
        }

        const nomes = grupo.map(r => r.med_nome).join(', ');
        console.log(`✅ Lembrete agrupado (${grupo.length} doses: ${nomes}) enviado para ${primeiro.phone} — horário ${horario}`);
    } catch (error) {
        console.error(`❌ Erro ao enviar lembrete agrupado:`, error.message);
    }
}
```

### 2. `handleGroupedFollowUp` — não atualizar zapiMessageId nos dose_logs do grupo

Remover a chamada a `updateDoseLogZapiMessageId` no loop. O `updateDoseLogTentativa` (estado individual por dose) PERMANECE — só o zapi_message_id não é atualizado.

```javascript
async function handleGroupedFollowUp(grupo) {
    try {
        const primeiro = grupo[0];
        const tentativa = (primeiro.tentativas || 1) + 1;
        const firstName = primeiro.user_name?.split(' ')[0] || 'você';
        const horario = String(primeiro.horario_agendado).substring(0, 5);

        const message = buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo);
        await sendTextMessage(primeiro.phone, message);   // envia, mas não usamos o zaapId

        // Atualiza estado individualmente por dose (tentativas), mas NÃO grava zapi_message_id
        // (doses agrupadas não usam o fast-path — ver briefing).
        for (const item of grupo) {
            const tentativaItem = (item.tentativas || 1) + 1;
            await updateDoseLogTentativa(item.id, tentativaItem);
        }

        const nomes = grupo.map(i => i.med_nome).join(', ');
        console.log(`🔔 Follow-up agrupado tentativa ${tentativa} (${grupo.length} doses: ${nomes}) enviado para ${primeiro.phone}`);
    } catch (error) {
        console.error(`❌ Erro no follow-up agrupado:`, error.message);
    }
}
```

> Se `updateDoseLogZapiMessageId` deixar de ser usado em qualquer lugar do scheduler.js após esta mudança, remover do import. Verificar antes — o `handleFollowUp` individual em lembrete.js pode ainda usá-lo (não mexer nesse).

## Checklist

- [ ] `sendGroupedReminder` não passa `zapiMessageId` ao `createDoseLog`.
- [ ] `handleGroupedFollowUp` não chama `updateDoseLogZapiMessageId`.
- [ ] `updateDoseLogTentativa` (estado por dose) permanece intacto no follow-up agrupado.
- [ ] `sendReminder` individual e estoque zerado CONTINUAM gravando `zapi_message_id` (não tocar).
- [ ] Import de `updateDoseLogZapiMessageId` removido do scheduler.js se não mais usado ali.