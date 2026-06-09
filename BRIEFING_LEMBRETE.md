# Briefing — agente_lembrete

Este documento é um briefing de implementação para o Claude Code.
Leia o CONTEXT.md antes de começar.

---

## Objetivo

Criar o `agente_lembrete` — responsável pelo follow-up de doses sem resposta.
Hoje o scheduler envia o lembrete e para. Com esse agente, a Nami vai
reenviar progressivamente até 3 tentativas e marcar como "não informado"
se não houver resposta.

---

## Comportamento esperado (Opção A — Espaçada)

```
Horário agendado     → Tentativa 1: lembrete normal
+30 minutos sem resp → Tentativa 2: reenvio gentil
+1 hora sem resp     → Tentativa 3: último aviso
+30 min sem resp     → Marca como "não informado", verifica cuidadores
```

Total: o ciclo dura até ~2h após o horário agendado.

---

## Ajustes necessários no banco (já aplicados no Supabase)

```sql
-- Já rodado — não rodar novamente
ALTER TABLE dose_logs
  ADD COLUMN IF NOT EXISTS tentativas integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultima_tentativa_at timestamptz,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pendente',
  ADD COLUMN IF NOT EXISTS caregiver_notified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS caregiver_notified_at timestamptz;

CREATE TABLE care_network (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  caregiver_id uuid REFERENCES users(id) ON DELETE CASCADE,
  relationship text,
  permissions jsonb DEFAULT '{}',
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, caregiver_id)
);
```

Os valores possíveis do campo `status` em `dose_logs`:
- `pendente` — lembrete enviado, aguardando confirmação
- `confirmado` — usuário confirmou que tomou
- `nao_informado` — 3 tentativas sem resposta
- `nao_tomado` — usuário confirmou que não tomou

---

## Arquivos a criar

```
src/agentes/lembrete.js   ← novo
```

## Arquivos a modificar

```
src/scheduler.js          ← adicionar verificação de follow-up
src/database.js           ← adicionar funções de follow-up
```

---

## Lógica do follow-up no scheduler

O scheduler já roda a cada 2 minutos. Adicionar uma segunda verificação
no mesmo ciclo para checar doses que precisam de follow-up:

```javascript
// Em checkAndSendReminders(), após enviar lembretes novos:
await checkAndSendFollowUps();
```

A função `checkAndSendFollowUps` deve:
1. Buscar dose_logs com status = 'pendente' E reminder_sent = true
2. Para cada um, verificar quanto tempo passou desde ultima_tentativa_at
3. Aplicar a lógica espaçada:
   - tentativas = 1 e passou 30min → enviar tentativa 2
   - tentativas = 2 e passou 60min → enviar tentativa 3
   - tentativas = 3 e passou 30min → marcar como nao_informado + verificar cuidadores

---

## Arquivo: src/agentes/lembrete.js

```javascript
// Responsabilidades:
// 1. Construir mensagens de follow-up por tentativa
// 2. Verificar cuidadores e notificar se necessário
// 3. Atualizar dose_log com nova tentativa

export async function handleFollowUp({ doseLog, reminder }) {
  const tentativa = (doseLog.tentativas || 1) + 1;

  if (tentativa <= 3) {
    const message = buildFollowUpMessage(tentativa, reminder);
    await sendTextMessage(reminder.phone, message);
    await updateDoseLogTentativa(doseLog.id, tentativa);
  } else {
    // Marca como não informado
    await markAsNaoInformado(doseLog.id);
    // Verifica cuidadores
    await notificarCuidadores(doseLog, reminder);
  }
}
```

### Mensagens por tentativa

**Tentativa 2 (tom: gentil, compreensivo):**
```
⏰ {nome}, só passando para lembrar!

Ainda não vi sua confirmação do *{remédio}*.
Já tomou? Responda *SIM* ou *NÃO* 💊
```

**Tentativa 3 (tom: cuidadoso, última chance):**
```
💊 {nome}, último aviso de hoje!

Seu *{remédio}* ainda está aguardando confirmação.
Tomou? É só responder *SIM* ou *NÃO* 🌿
```

**Após 3 tentativas sem resposta (tom: sem julgamento):**
- Não envia mensagem ao usuário
- Apenas registra internamente como `nao_informado`
- Verifica e notifica cuidadores se houver

### Notificação de cuidadores

Quando status = 'nao_informado', verificar tabela `care_network`:
- Buscar cuidadores com `status = 'active'` vinculados ao `user_id`
- Para cada cuidador ativo, enviar mensagem via WhatsApp:

```
⚠️ Atenção!

{nome_paciente} não confirmou a dose do *{remédio}*
que estava agendada para {horario}.

Esta foi a 3ª tentativa sem resposta.
```

- Registrar `caregiver_notified = true` e `caregiver_notified_at` no dose_log

---

## Funções novas no database.js

```javascript
// Buscar doses pendentes para follow-up
export async function getPendingFollowUps() {
  // Retorna dose_logs com:
  // status = 'pendente'
  // reminder_sent = true
  // confirmed = false
  // ultima_tentativa_at não nula
  // Join com medications, schedules e users para ter phone, nome, etc.
}

// Atualizar tentativa no dose_log
export async function updateDoseLogTentativa(doseLogId, tentativas) {
  await supabase
    .from('dose_logs')
    .update({
      tentativas,
      ultima_tentativa_at: new Date().toISOString()
    })
    .eq('id', doseLogId);
}

// Marcar dose como não informada
export async function markAsNaoInformado(doseLogId) {
  await supabase
    .from('dose_logs')
    .update({ status: 'nao_informado' })
    .eq('id', doseLogId);
}

// Buscar cuidadores ativos de um usuário
export async function getCaregivers(userId) {
  const { data } = await supabase
    .from('care_network')
    .select(`
      *,
      caregiver:caregiver_id (id, phone, name)
    `)
    .eq('user_id', userId)
    .eq('status', 'active');
  return data || [];
}

// Marcar cuidadores como notificados
export async function markCaregiverNotified(doseLogId) {
  await supabase
    .from('dose_logs')
    .update({
      caregiver_notified: true,
      caregiver_notified_at: new Date().toISOString()
    })
    .eq('id', doseLogId);
}
```

---

## Ajuste no createDoseLog

Quando o scheduler cria um dose_log ao enviar o primeiro lembrete,
já inicializar os novos campos:

```javascript
export async function createDoseLog({
  medicationId, scheduledAt, reminderSent, reminderSentAt
}) {
  const { data, error } = await supabase
    .from('dose_logs')
    .insert({
      medication_id: medicationId,
      scheduled_at: scheduledAt,
      reminder_sent: reminderSent,
      reminder_sent_at: reminderSentAt,
      tentativas: 1,                              // já começa em 1
      ultima_tentativa_at: new Date().toISOString(), // registra primeira tentativa
      status: 'pendente'                          // status inicial
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar log de dose: ${error.message}`);
  return data;
}
```

---

## Ajuste no confirmDose

Quando o usuário confirmar a dose, atualizar o status:

```javascript
export async function confirmDose(medicationId) {
  // ... código existente ...

  // Adicionar ao update:
  await supabase
    .from('dose_logs')
    .update({
      confirmed: true,
      taken_at: new Date().toISOString(),
      status: 'confirmado'        // ← adicionar este campo
    })
    .eq('id', log.id);
}
```

---

## Ajuste no scheduler.js

```javascript
import { handleFollowUp } from './agentes/lembrete.js';
import { getPendingFollowUps } from './database.js';

async function checkAndSendReminders() {
  try {
    // 1. Lembretes novos (lógica existente)
    const reminders = await getPendingReminders();
    if (reminders.length > 0) {
      for (const reminder of reminders) {
        await sendReminder(reminder);
        await sleep(1000);
      }
    }

    // 2. Follow-ups de doses sem resposta (novo)
    await checkAndSendFollowUps();

  } catch (error) {
    console.error('❌ Erro no scheduler:', error.message);
  }
}

async function checkAndSendFollowUps() {
  try {
    const pendentes = await getPendingFollowUps();
    if (pendentes.length === 0) return;

    console.log(`🔔 ${pendentes.length} follow-up(s) para verificar...`);

    for (const item of pendentes) {
      const minutosSinceUltima = getMinutosSince(item.ultima_tentativa_at);
      const tentativas = item.tentativas || 1;

      const deveReenviar =
        (tentativas === 1 && minutosSinceUltima >= 30) ||
        (tentativas === 2 && minutosSinceUltima >= 60) ||
        (tentativas === 3 && minutosSinceUltima >= 30);

      if (deveReenviar) {
        await handleFollowUp({ doseLog: item, reminder: item });
        await sleep(1000);
      }
    }
  } catch (error) {
    console.error('❌ Erro nos follow-ups:', error.message);
  }
}

function getMinutosSince(timestamp) {
  if (!timestamp) return 0;
  return (Date.now() - new Date(timestamp).getTime()) / 60000;
}
```

---

## Função SQL — verificar se precisa de ajuste

A função `get_pending_reminders()` no Supabase retorna lembretes para
disparar no horário. Ela NÃO deve retornar doses que já foram enviadas
(reminder_sent = true). Verificar se já tem essa condição na função SQL.
Se não tiver, adicionar:

```sql
AND dl.reminder_sent IS NOT TRUE
```

---

## Ordem de implementação

1. Adicionar funções novas ao `database.js`
   (getPendingFollowUps, updateDoseLogTentativa, markAsNaoInformado,
   getCaregivers, markCaregiverNotified)
2. Atualizar `createDoseLog` com novos campos
3. Atualizar `confirmDose` com status = 'confirmado'
4. Criar `src/agentes/lembrete.js`
5. Atualizar `scheduler.js` para chamar checkAndSendFollowUps
6. Verificar função SQL get_pending_reminders no Supabase

---

## Critérios de sucesso

- Dose sem resposta recebe follow-up após 30 minutos
- Segunda dose sem resposta recebe follow-up após 1 hora
- Após 3 tentativas, status muda para nao_informado
- Cuidadores ativos são notificados após 3 tentativas (tabela vazia por ora)
- Dose confirmada não recebe follow-up
- Scheduler existente continua funcionando sem regressão
- Logs claros no Railway para cada tentativa e ação tomada