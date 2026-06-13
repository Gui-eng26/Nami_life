# BRIEFING — BUG-029 + BUG-025 + MH-022
## Solução Wellington: referenceMessageId + Estoque Zerado

**Data:** 13/06/2026  
**Origem:** Análise de logs Railway + revisão de código  
**Escopo:** `whatsapp.js`, `index.js`, `agent.js`, `router.js`, `scheduler.js`, `agentes/lembrete.js`, `database.js`

---

## 1. Contexto

O usuário Wellington utiliza consistentemente a função **"responder"** do WhatsApp — ou seja, ele seleciona uma mensagem específica e responde sobre ela, em vez de mandar uma mensagem solta. Essa funcionalidade é muito comum no WhatsApp, especialmente para usuários com múltiplos medicamentos cadastrados.

Quando alguém usa essa função, o webhook da Z-API inclui um campo `referenceMessageId` contendo o ID WhatsApp da mensagem original. Hoje o sistema **recebe esse campo no payload mas nunca extrai nem usa essa informação**, causando os bugs descritos abaixo.

---

## 2. Bugs a Corrigir

### BUG-029 — `referenceMessageId` ignorado em todo o pipeline
**Causa raiz confirmada em código:**  
`parseZApiPayload()` em `whatsapp.js` extrai apenas `phone`, `text`, `audio`, `image`. O campo `referenceMessageId` está presente no `req.body`, é visível no log, mas é descartado silenciosamente. Nenhuma camada downstream (agent.js, router.js) o recebe.

**Impacto:** O sistema não sabe a qual mensagem o usuário está respondendo. Quando Wellington responde "Sim" ao lembrete da Losartana, o sistema trata o "Sim" como uma mensagem solta e precisa adivinhar qual dose confirmar — o que falha ou gera ambiguidade quando há múltiplas doses pendentes.

### BUG-025 — Resposta duplicada de confirmação de dose
**Causa raiz confirmada nos logs (08:15:14 UTC):**  
Wellington enviou dois "Sim" separados com 5 segundos de diferença, cada um respondendo a um lembrete diferente via função "responder". Ambos chegaram quase simultaneamente, geraram dois `handlePrincipal()` em paralelo. O segundo Claude call retornou `action: undefined` (race condition no estado do usuário), causando o erro `⚠️ Ação desconhecida no agente principal: undefined` e duas respostas enviadas.

**A solução pelo `referenceMessageId` elimina o problema na raiz:** cada "Sim" identificará a dose exata sem passar pelo LLM, a operação será muito mais rápida, eliminando a janela de race condition.

### MH-022 — Lembrete disparado com estoque zerado
**Causa identificada em código:**  
Em `sendReminder()` no `scheduler.js`, a verificação de estoque é feita **após** o envio do lembrete. Se `estoque_atual === 0`, o lembrete é enviado mesmo assim, e logo depois vem o alerta de estoque zerado — mensagens contraditórias para o usuário (lembre de tomar + mas você não tem mais comprimidos).

---

## 3. Solução Arquitetural

### Fluxo ANTES (atual)
```
Wellington usa "responder" no lembrete da Losartana → "Sim"
→ webhook: { text: "Sim", referenceMessageId: "3EB017..." }
→ parseZApiPayload descarta referenceMessageId
→ router recebe apenas "Sim", não sabe qual dose
→ chama handlePrincipal → chama Claude → Claude adivinha → inconsistente
```

### Fluxo DEPOIS (proposto)
```
Nami envia lembrete da Losartana
→ Z-API retorna { zaapId: "3EB017..." }
→ scheduler captura esse ID e salva no dose_log: { zapi_message_id: "3EB017..." }

Wellington usa "responder" → "Sim"
→ webhook: { text: "Sim", referenceMessageId: "3EB017..." }
→ parseZApiPayload inclui referenceMessageId no retorno
→ router verifica: existe dose_log com zapi_message_id = "3EB017..."? SIM
→ confirma aquele dose_log diretamente — sem LLM, sem ambiguidade, sem race condition
→ responde ao usuário imediatamente
```

### Degradação graciosa
Se `referenceMessageId` não encontrar um dose_log (mensagem antiga, sem `zapi_message_id`, resposta a outra coisa), o sistema cai no fluxo normal atual. Não há breaking change.

---

## 4. Mudanças por Arquivo

> ✅ **Migração de banco já concluída.** A coluna `zapi_message_id TEXT` e o índice correspondente já foram adicionados à tabela `dose_logs` no Supabase. Não é necessário nenhuma alteração de banco — pode implementar direto no código.

### 4.1 — `src/whatsapp.js`

**Mudança 1: `parseZApiPayload()` — incluir `referenceMessageId` no retorno**

```js
// ANTES
export function parseZApiPayload(body) {
    if (body.fromMe) return null;
    if (body.isGroup) return null;

    const phone = body.phone ? `+${body.phone.replace(/\D/g, '')}` : null;
    if (!phone) return null;

    const text = body.text?.message || null;
    const audio = body.audio?.audioUrl || null;
    const image = body.image?.imageUrl || null;

    return { phone, text, audio, image };
}

// DEPOIS
export function parseZApiPayload(body) {
    if (body.fromMe) return null;
    if (body.isGroup) return null;

    const phone = body.phone ? `+${body.phone.replace(/\D/g, '')}` : null;
    if (!phone) return null;

    const text = body.text?.message || null;
    const audio = body.audio?.audioUrl || null;
    const image = body.image?.imageUrl || null;
    const referenceMessageId = body.referenceMessageId || null;  // NOVO

    return { phone, text, audio, image, referenceMessageId };
}
```

**Mudança 2: `sendTextMessage()` — logar e retornar o ID da mensagem enviada**

```js
// ANTES
export async function sendTextMessage(phone, message) {
    try {
        const cleanPhone = phone.replace(/\D/g, '');
        console.log(`📤 Enviando para ${cleanPhone}`);
        const response = await axios.post(`${ZAPI_URL}/send-text`, {
            phone: cleanPhone,
            message
        }, {
            headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }
        });
        console.log(`✅ Mensagem enviada para ${cleanPhone}`);
        return response.data;
    } catch (error) {
        console.error(`❌ Erro Z-API:`, error.response?.status, error.response?.data || error.message);
        throw error;
    }
}

// DEPOIS
export async function sendTextMessage(phone, message) {
    try {
        const cleanPhone = phone.replace(/\D/g, '');
        console.log(`📤 Enviando para ${cleanPhone}`);
        const response = await axios.post(`${ZAPI_URL}/send-text`, {
            phone: cleanPhone,
            message
        }, {
            headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }
        });

        // Captura o messageId retornado pela Z-API (campo pode variar)
        const zapiMessageId = response.data?.zaapId
            || response.data?.messageId
            || response.data?.id
            || null;

        console.log(`✅ Mensagem enviada para ${cleanPhone}${zapiMessageId ? ` — msgId: ${zapiMessageId}` : ''}`);
        return { ...response.data, zapiMessageId };  // garante que zapiMessageId está sempre no retorno

    } catch (error) {
        console.error(`❌ Erro Z-API:`, error.response?.status, error.response?.data || error.message);
        throw error;
    }
}
```

**Atenção:** Após implementar, validar nos logs qual campo a Z-API usa de fato (`zaapId`, `messageId` ou `id`). Se nenhum funcionar, adicionar `console.log('Z-API response:', JSON.stringify(response.data))` temporariamente para inspecionar.

---

### 4.2 — `src/index.js`

**Mudança: extrair e passar `referenceMessageId` para `handleIncomingMessage()`**

```js
// ANTES
const { phone, text, audio, image } = parsed;
// ...
await handleIncomingMessage({ phone, text, audio, image, messageId });

// DEPOIS
const { phone, text, audio, image, referenceMessageId } = parsed;  // NOVO: extrair referenceMessageId
// ...
await handleIncomingMessage({ phone, text, audio, image, messageId, referenceMessageId });  // NOVO: passar adiante
```

---

### 4.3 — `src/agent.js`

**Mudança: receber e repassar `referenceMessageId` para `routeMessage()`**

```js
// ANTES
export async function handleIncomingMessage({ phone, text, audio, image, messageId }) {
    // ...
    const response = await routeMessage({ user, message: text, image, messageId });

// DEPOIS
export async function handleIncomingMessage({ phone, text, audio, image, messageId, referenceMessageId }) {  // NOVO
    // ...
    const response = await routeMessage({ user, message: text, image, messageId, referenceMessageId });  // NOVO
```

---

### 4.4 — `src/router.js`

**Mudança 1: receber `referenceMessageId` na assinatura**

```js
// ANTES
export async function routeMessage({ user, message, image, messageId }) {

// DEPOIS
export async function routeMessage({ user, message, image, messageId, referenceMessageId }) {  // NOVO
```

**Mudança 2: adicionar novo import para a nova função de database**

```js
// Adicionar à linha de imports do database.js:
import { getConversationState, logAgentInteraction, getRecentDoses,
    getDoseLogByZapiMessageId, confirmDoseByLogId } from './database.js';  // NOVOS: últimos dois
```

**Mudança 3: fast-path no início de `routeMessage()`, ANTES de qualquer outra verificação**

Inserir logo após a verificação de `isDuplicateMessage`:

```js
// FAST-PATH: confirmação por referência de mensagem (função "responder" do WhatsApp)
// Só ativa quando: (a) mensagem tem referenceMessageId, (b) aponta para um dose_log conhecido,
// (c) conteúdo é uma confirmação de dose
if (referenceMessageId && detectarConfirmacaoDose(message)) {
    const doseLog = await getDoseLogByZapiMessageId(referenceMessageId);
    if (doseLog && doseLog.confirmed === false) {
        await confirmDoseByLogId(doseLog.id);
        const nomeRemedio = doseLog.med_nome || 'seu remédio';
        console.log(`✅ [FAST-PATH] Dose confirmada via referenceMessageId — ${user.phone} — ${nomeRemedio}`);

        await logAgentInteraction({
            userId: user.id,
            agent: 'fast_path_reference',
            userMessage: message,
            agentResponse: `Dose confirmada: ${nomeRemedio}`
        });

        const firstName = user.name ? user.name.split(' ')[0] : 'você';
        return `✅ Anotei! Dose do *${nomeRemedio}* confirmada, ${firstName}. Continue assim! 💪💊`;
    }
}
// Se referenceMessageId não encontrou um dose_log, cai no fluxo normal abaixo
```

**Importante:** esse bloco vai depois do `isDuplicateMessage()` e antes do `if (!user.onboarded)`.

---

### 4.5 — `src/scheduler.js`

**Mudança 1: capturar `zapiMessageId` ao enviar lembrete e salvar no dose_log**

```js
// ANTES
async function sendReminder(reminder) {
    try {
        const firstName = reminder.user_name ? reminder.user_name.split(' ')[0] : 'você';
        const message = buildReminderMessage(firstName, reminder);

        await sendTextMessage(reminder.phone, message);

        await createDoseLog({
            medicationId: reminder.medication_id,
            scheduledAt: new Date().toISOString(),
            reminderSent: true,
            reminderSentAt: new Date().toISOString()
        });

        console.log(`✅ Lembrete enviado para ${reminder.phone} — ${reminder.med_nome}`);
        await sleep(2000);
        await verificarEstoqueBaixo(reminder);

    } catch (error) {
        console.error(`❌ Erro ao enviar lembrete para ${reminder.phone}:`, error.message);
    }
}

// DEPOIS
async function sendReminder(reminder) {
    try {
        // MH-022: Não enviar lembrete se estoque zerado
        if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
            console.log(`⚠️ Lembrete ignorado — estoque zerado para ${reminder.med_nome} (${reminder.phone})`);
            // O alerta de estoque zerado já foi enviado em ciclos anteriores — não reenviar aqui
            return;
        }

        const firstName = reminder.user_name ? reminder.user_name.split(' ')[0] : 'você';
        const message = buildReminderMessage(firstName, reminder);

        // BUG-029: capturar o ID da mensagem enviada pela Z-API
        const zapiResult = await sendTextMessage(reminder.phone, message);
        const zapiMessageId = zapiResult?.zapiMessageId || null;

        await createDoseLog({
            medicationId: reminder.medication_id,
            scheduledAt: new Date().toISOString(),
            reminderSent: true,
            reminderSentAt: new Date().toISOString(),
            zapiMessageId  // NOVO
        });

        console.log(`✅ Lembrete enviado para ${reminder.phone} — ${reminder.med_nome}`);
        await sleep(2000);
        await verificarEstoqueBaixo(reminder);

    } catch (error) {
        console.error(`❌ Erro ao enviar lembrete para ${reminder.phone}:`, error.message);
    }
}
```

---

### 4.6 — `src/agentes/lembrete.js`

**Mudança: capturar `zapiMessageId` ao enviar follow-up e atualizar o dose_log**

```js
// ANTES — imports
import { updateDoseLogTentativa, markAsNaoInformado, getCaregivers, markCaregiverNotified } from '../database.js';

// DEPOIS — imports (adicionar updateDoseLogZapiMessageId)
import { updateDoseLogTentativa, updateDoseLogZapiMessageId, markAsNaoInformado,
    getCaregivers, markCaregiverNotified } from '../database.js';
```

```js
// ANTES — dentro de handleFollowUp
if (tentativa <= 3) {
    const message = buildFollowUpMessage(tentativa, reminder);
    await sendTextMessage(reminder.phone, message);
    await updateDoseLogTentativa(doseLog.id, tentativa);
    console.log(`🔔 Follow-up tentativa ${tentativa} enviado para ${reminder.phone} — ${reminder.med_nome}`);
}

// DEPOIS
if (tentativa <= 3) {
    const message = buildFollowUpMessage(tentativa, reminder);
    const zapiResult = await sendTextMessage(reminder.phone, message);
    const zapiMessageId = zapiResult?.zapiMessageId || null;

    await updateDoseLogTentativa(doseLog.id, tentativa);

    // BUG-029: atualizar o zapi_message_id com o ID do follow-up mais recente
    // Assim, se o usuário responder ao follow-up mais recente, a confirmação funciona
    if (zapiMessageId) {
        await updateDoseLogZapiMessageId(doseLog.id, zapiMessageId);
    }

    console.log(`🔔 Follow-up tentativa ${tentativa} enviado para ${reminder.phone} — ${reminder.med_nome}`);
}
```

---

### 4.7 — `src/database.js`

**Mudança 1: atualizar `createDoseLog()` para aceitar e salvar `zapiMessageId`**

```js
// ANTES
export async function createDoseLog({ medicationId, scheduledAt, reminderSent, reminderSentAt }) {
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
            status: 'pendente'
        })
        .select()
        .single();

    if (error) throw new Error(`Erro ao criar log de dose: ${error.message}`);
    console.log(`📝 DoseLog criado — tentativas: ${data.tentativas}, status: ${data.status}`);
    return data;
}

// DEPOIS
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
            status: 'pendente',
            zapi_message_id: zapiMessageId  // NOVO (null se não capturado)
        })
        .select()
        .single();

    if (error) throw new Error(`Erro ao criar log de dose: ${error.message}`);
    console.log(`📝 DoseLog criado — tentativas: ${data.tentativas}, status: ${data.status}${zapiMessageId ? `, msgId: ${zapiMessageId}` : ''}`);
    return data;
}
```

**Mudança 2: nova função `updateDoseLogZapiMessageId()`**

Adicionar após `updateDoseLogTentativa`:

```js
export async function updateDoseLogZapiMessageId(doseLogId, zapiMessageId) {
    const { error } = await supabase
        .from('dose_logs')
        .update({ zapi_message_id: zapiMessageId })
        .eq('id', doseLogId);

    if (error) console.error(`⚠️ Erro ao atualizar zapi_message_id no dose_log: ${error.message}`);
    // Não lança erro — falha silenciosa aceitável, o log ainda existe
}
```

**Mudança 3: nova função `getDoseLogByZapiMessageId()`**

Adicionar após `updateDoseLogZapiMessageId`:

```js
export async function getDoseLogByZapiMessageId(zapiMessageId) {
    if (!zapiMessageId) return null;

    const { data, error } = await supabase
        .from('dose_logs')
        .select(`
            *,
            medications (id, nome, user_id)
        `)
        .eq('zapi_message_id', zapiMessageId)
        .eq('confirmed', false)
        .single();

    if (error || !data) return null;

    return {
        ...data,
        med_nome: data.medications?.nome
    };
}
```

**Mudança 4: nova função `confirmDoseByLogId()`**

Essa função confirma um dose_log ESPECÍFICO pelo ID — diferente de `confirmDose(medicationId)` que busca "o mais recente". Adicionar junto às funções de confirmação:

```js
export async function confirmDoseByLogId(doseLogId) {
    // 1. Busca o log para ter o medicationId
    const { data: log, error: fetchError } = await supabase
        .from('dose_logs')
        .select('*, medications(id, nome, estoque_atual)')
        .eq('id', doseLogId)
        .single();

    if (fetchError || !log) throw new Error(`Dose log não encontrado: ${doseLogId}`);

    // 2. Confirma a dose
    const { error: updateError } = await supabase
        .from('dose_logs')
        .update({
            confirmed: true,
            taken_at: new Date().toISOString(),
            status: 'confirmado'
        })
        .eq('id', doseLogId);

    if (updateError) throw new Error(`Erro ao confirmar dose: ${updateError.message}`);
    console.log(`✅ Dose confirmada por log id: ${doseLogId}`);

    // 3. Decrementa estoque do medicamento
    const estoque = log.medications?.estoque_atual;
    if (estoque !== null && estoque > 0) {
        await updateMedicationStock(log.medication_id, estoque - 1);
    }
}
```

---

## 5. Ordem de Execução

> ✅ Migração de banco já concluída — começar direto no código.

1. **Implementar mudanças em `database.js`** (novas funções + parâmetro em createDoseLog)
2. **Implementar mudança em `whatsapp.js`** (parseZApiPayload + sendTextMessage)
3. **Implementar mudanças em `index.js` e `agent.js`** (pipeline do referenceMessageId)
4. **Implementar mudança em `router.js`** (fast-path)
5. **Implementar mudanças em `scheduler.js`** (capturar zapiMessageId + MH-022)
6. **Implementar mudança em `agentes/lembrete.js`** (capturar zapiMessageId no follow-up)
7. **Deploy + validar nos logs**

---

## 6. Validação Pós-Deploy

### Verificar captura do Z-API message ID
Nos logs, após o próximo lembrete disparado, deve aparecer:
```
✅ Mensagem enviada para 5519988491053 — msgId: 3EB...
📝 DoseLog criado — tentativas: 1, status: pendente, msgId: 3EB...
```
Se `msgId` aparecer como `null`, o campo retornado pela Z-API tem nome diferente — inspecionar com log temporário.

### Verificar fast-path ativando
Quando Wellington usar a função "responder" e mandar "Sim", o log deve mostrar:
```
✅ [FAST-PATH] Dose confirmada via referenceMessageId — +5519988491053 — Losartana
```
Em vez de:
```
💊 Confirmação de dose detectada, roteando para principal
🤖 Chamando Claude para: "Sim"
```

### Verificar degradação graciosa
Quando Wellington mandar "Sim" sem usar a função "responder" (mensagem solta), o log **não** deve mostrar o fast-path, e deve cair no fluxo normal (`🤖 Chamando Claude para: "Sim"`).

### Verificar MH-022
Quando um medicamento com estoque zerado chegar no scheduler, o log deve mostrar:
```
⚠️ Lembrete ignorado — estoque zerado para Dorforte (+5519988491053)
```
E **nenhuma mensagem deve ser enviada** para o usuário para esse medicamento.

---

## 7. Riscos e Pontos de Atenção

1. **Campo Z-API desconhecido:** O nome do campo que a Z-API retorna ao enviar uma mensagem precisa ser validado nos logs. Se `zaapId`, `messageId` e `id` não funcionarem, inspecionar `response.data` completo antes de assumir o campo certo.

2. **fast-path só funciona para dose_logs novos:** Dose logs criados antes desta implementação não terão `zapi_message_id`. Replies a mensagens antigas cairão no fluxo normal — comportamento correto e esperado.

3. **MH-022 — estoque_atual null:** O campo `estoque_atual` pode ser `null` se o usuário não informou estoque. O check deve ser `reminder.estoque_atual !== null && reminder.estoque_atual <= 0` para não bloquear lembretes de medicamentos sem controle de estoque.

4. **follow-up e lembrete compartilham o mesmo dose_log:** O `zapi_message_id` é sobrescrito a cada follow-up. Isso é intencional — o usuário provavelmente vai responder ao follow-up mais recente.

---

## 8. Bugs Adicionais Identificados (NÃO cobertos por este briefing)

Os itens abaixo foram identificados na mesma sessão de análise de logs mas serão tratados em briefings separados:

- **BUG-026:** Perda de contexto pós-LGPD — "Sim" vai para agente_principal sem âncora da pergunta anterior
- **BUG-027:** Nome do medicamento mencionado antes do fluxo formal de cadastro é descartado no `cad_nome`
- **BUG-028:** "ta bom" interpretado como pergunta em contexto idle (Ivete)