# BRIEFING — MH-032: Lembretes agrupados por horário de cadastro

> **Contrato de implementação para o Claude Code.**
> Sessão v12 — 30/06/2026. Design fechado com o Guilherme.
> Ler este arquivo inteiro antes de implementar. Não improvisar além do escopo aqui definido.

---

## 1. O QUE É E POR QUE

Hoje, quando um usuário tem 2+ medicamentos cadastrados **no mesmo horário** (ex: Losartana 08:00 e Metformina 08:00), ele recebe **uma mensagem de WhatsApp separada para cada um**, com 1 segundo de intervalo. Da perspectiva do usuário, são vários alarmes para o mesmo momento — ruído que reduz a qualidade da experiência.

**MH-032 agrupa esses lembretes em uma única mensagem**, listando os medicamentos daquele horário.

### Princípio central (NÃO VIOLAR)

> **Agrupamento é EXCLUSIVAMENTE camada de apresentação.**
> O estado interno de cada dose permanece 100% individual: cada `dose_log` mantém seu próprio `status`, `tentativas`, `ultima_tentativa_at`, follow-up, `nao_informado`, notificação de cuidadores e alerta de estoque. **Nada disso é agrupado.** Só a mensagem de texto que o usuário lê é unificada.

Isso vale para **os dois caminhos de envio**: lembrete inicial E follow-up. Mesma regra nos dois.

---

## 2. REGRA DE AGRUPAMENTO (exata)

- Agrupam-se doses do **mesmo usuário** com **horário de cadastro idêntico** (mesmo `HH:MM` na tabela `schedules.horario`).
- **SEM janela, SEM tolerância.** 08:00 e 08:05 NÃO agrupam — são horários diferentes, recebem mensagens separadas. Apenas horário exatamente igual agrupa.
- Grupo de **1 dose** → mensagem individual (comportamento atual, inalterado).
- Grupo de **2+ doses** → uma mensagem agrupada.
- **Dose sem estoque** (`estoque_atual <= 0`) **sai do agrupamento** e recebe a mensagem individual de estoque zerado, mesmo que compartilhe horário com outras. A mensagem de estoque zerado tem chamada de ação própria (recompra) que não pode ser diluída.

---

## 3. MUDANÇA DE BANCO — nova coluna `horario_agendado`

### Causa raiz que esta coluna resolve

O `dose_log` hoje grava em `scheduled_at` o `new Date()` do **instante do disparo do cron**, não o horário de cadastro ("08:00"). No follow-up, o `getPendingFollowUps` parte de `dose_logs` (não de `schedules`) e por isso **não tem acesso ao horário de cadastro** — o que impediria agrupar o follow-up pelo mesmo critério do lembrete inicial. Além disso, `dose_logs` não tem `schedule_id`, então não há como recuperar o horário via join confiável.

**Solução sistêmica:** gravar o horário de cadastro no próprio `dose_log`, no momento em que ele nasce.

### Migration (novo arquivo em `supabase/migrations/`)

Criar migration numerada (seguir a convenção de timestamp do repositório, ex: `20260630000000_mh032_horario_agendado.sql`):

```sql
-- MH-032: horário de cadastro (schedules.horario) que originou a dose.
-- Usado para agrupar lembretes/follow-ups de doses do mesmo horário exato.
-- NULL nos registros antigos (pré-migration) → tratados como não-agrupáveis (fallback individual).
-- Não confundir com scheduled_at (timestamp do disparo do cron, mantido intocado).
ALTER TABLE dose_logs
  ADD COLUMN horario_agendado time;
```

### Tratamento dos registros antigos

- Registros existentes ficam com `horario_agendado = NULL`.
- **NÃO reconstruir** o valor dos antigos por adivinhação (ex: inferir do `scheduled_at` ou do `medication_id`). Motivo: medicamento com múltiplos horários não permite saber a qual horário um log antigo pertencia sem `schedule_id`; preencher por palpite gravaria dado clínico incorreto como se fosse fato. NULL é honesto.
- O código trata `horario_agendado = NULL` como **"não agrupa"** → cai no fallback de mensagem individual. Isso é seguro: doses antigas já foram entregues, não haverá lembrete retroativo.

### ⚠️ AÇÃO MANUAL NECESSÁRIA (antes de validar, não antes de implementar)

A migration precisa ser aplicada no banco Supabase (Brasil/São Paulo). Se o fluxo de migrations do projeto não aplica automaticamente, rodar o `ALTER TABLE` acima no SQL Editor do Supabase antes de testar em produção.

---

## 4. MUDANÇAS EM `src/database.js`

### 4.1 `createDoseLog` — persistir `horario_agendado`

Adicionar o parâmetro `horarioAgendado` (default `null`) e gravá-lo no insert.

```javascript
export async function createDoseLog({
    medicationId, scheduledAt, reminderSent, reminderSentAt,
    zapiMessageId = null, status = 'pendente',
    horarioAgendado = null            // ← NOVO
}) {
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
            status: status,
            zapi_message_id: zapiMessageId,
            horario_agendado: horarioAgendado   // ← NOVO
        })
        .select()
        .single();

    if (error) throw new Error(`Erro ao criar log de dose: ${error.message}`);
    console.log(`📝 DoseLog criado — tentativas: ${data.tentativas}, status: ${data.status}${horarioAgendado ? `, horario: ${horarioAgendado}` : ''}`);
    return data;
}
```

### 4.2 `getPendingFollowUps` — garantir que `horario_agendado` volta

A query usa `select('*, medications(...)')`, então `horario_agendado` já vem incluído no `*` automaticamente. **Nenhuma mudança de query necessária.** Apenas confirmar que o objeto normalizado retornado NÃO descarta o campo (ele está em `...log`, então já é propagado). Deixar como está.

---

## 5. MUDANÇAS EM `src/scheduler.js`

### 5.1 Lembrete inicial — `checkAndSendReminders`

Hoje o loop envia um `sendReminder` por dose. Passa a:

1. Separar os `reminders` em dois conjuntos:
   - **sem estoque** (`estoque_atual !== null && estoque_atual <= 0`) → cada um segue o caminho individual de estoque zerado (comportamento atual, inalterado).
   - **com estoque** → candidatos a agrupamento.
2. Agrupar os "com estoque" por chave `${user_id}||${horario}` (o campo `horario` vem do `get_pending_reminders()`).
3. Para cada grupo:
   - **1 dose** → `sendReminder(reminder)` individual (comportamento atual).
   - **2+ doses** → `sendGroupedReminder(grupo)` (nova função).

> **IMPORTANTE:** cada dose do grupo ainda gera seu **próprio `dose_log`** via `createDoseLog`, passando `horarioAgendado: reminder.horario`. O agrupamento é só na mensagem — a criação dos logs continua individual, um por dose.

Esboço:

```javascript
async function checkAndSendReminders() {
    try {
        const reminders = await getPendingReminders();

        if (reminders.length > 0) {
            console.log(`💊 ${reminders.length} lembrete(s) para disparar...`);

            const semEstoque = reminders.filter(r => r.estoque_atual !== null && r.estoque_atual <= 0);
            const comEstoque = reminders.filter(r => !(r.estoque_atual !== null && r.estoque_atual <= 0));

            // Doses sem estoque: sempre individuais (mensagem de estoque zerado)
            for (const reminder of semEstoque) {
                await sendReminder(reminder);
                await sleep(1000);
            }

            // Doses com estoque: agrupar por (user_id + horario de cadastro)
            const grupos = agruparPorUsuarioEHorario(comEstoque);
            for (const grupo of grupos) {
                if (grupo.length === 1) {
                    await sendReminder(grupo[0]);
                } else {
                    await sendGroupedReminder(grupo);
                }
                await sleep(1000);
            }
        }

        await checkAndSendFollowUps();
    } catch (error) {
        console.error('❌ Erro no scheduler:', error.message);
    }
}
```

### 5.2 Helper de agrupamento (novo)

```javascript
// Agrupa uma lista de itens (reminders ou dose_logs pendentes) por usuário + horário.
// keyHorario: função que extrai o horário de cada item (difere entre reminder e dose_log).
// keyUser: função que extrai o user_id de cada item.
// Itens sem horário (null) retornam cada um em seu próprio grupo (fallback individual).
function agruparPorUsuarioEHorario(itens, keyUser, keyHorario) {
    const mapa = new Map();
    const individuais = [];

    for (const item of itens) {
        const horario = keyHorario(item);
        if (!horario) {                 // NULL → não agrupa
            individuais.push([item]);
            continue;
        }
        const chave = `${keyUser(item)}||${horario}`;
        if (!mapa.has(chave)) mapa.set(chave, []);
        mapa.get(chave).push(item);
    }

    return [...mapa.values(), ...individuais];
}
```

> Para o **lembrete inicial**, `keyUser = r => r.user_id` e `keyHorario = r => r.horario` (campo da stored function, tipo `time`, ex `'08:00:00'`).
> Para o **follow-up**, `keyUser = i => i.user_id` e `keyHorario = i => i.horario_agendado` (nova coluna).
> Normalizar o horário para `HH:MM` (substring 0,5) antes de compor a chave, para robustez.

### 5.3 `sendGroupedReminder` (nova função)

Envia UMA mensagem para o grupo, mas cria os `dose_logs` individualmente (um por dose), cada um com seu `horario_agendado`.

```javascript
async function sendGroupedReminder(grupo) {
    try {
        const primeiro = grupo[0];
        const firstName = primeiro.user_name?.split(' ')[0] || 'você';
        const horario = String(primeiro.horario).substring(0, 5);

        const message = buildGroupedReminderMessage(firstName, horario, grupo);

        const zapiResult = await sendTextMessage(primeiro.phone, message);
        const zapiMessageId = zapiResult?.zapiMessageId || null;

        // Cria um dose_log por dose do grupo (estado individual preservado).
        // O mesmo zapiMessageId é associado a todas — a confirmação por [ref:] no
        // principal.js opera por dose_log.id, então isso não causa ambiguidade de estado.
        for (const reminder of grupo) {
            await createDoseLog({
                medicationId: reminder.medication_id,
                scheduledAt: new Date().toISOString(),
                reminderSent: true,
                reminderSentAt: new Date().toISOString(),
                zapiMessageId,
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

### 5.4 `buildGroupedReminderMessage` (nova função) — Variação C

```javascript
function buildGroupedReminderMessage(firstName, horario, grupo) {
    const lista = grupo.map(r => {
        const dosagem = r.med_dosagem ? ` — ${r.med_dosagem}` : '';
        return `• *${r.med_nome}*${dosagem}`;
    }).join('\n');

    return (
        `⏰ ${firstName}, hora dos seus remédios das *${horario}*! 💊\n\n` +
        `${lista}\n\n` +
        `✅ Tomou todos? Responda *SIM*\n` +
        `💬 Tomou só alguns? Me diga quais (ex: "só o ${grupo[0].med_nome}")`
    );
}
```

> A `buildReminderMessage` individual atual **permanece inalterada** — usada para grupos de 1 dose e doses sem estoque.

---

## 6. FOLLOW-UP AGRUPADO — `checkAndSendFollowUps` + `lembrete.js`

### Princípio (repetir): estado individual, mensagem agrupada

Cada dose pendente ainda precisa passar **individualmente** por toda a máquina do `handleFollowUp`: incremento de `tentativas`, atualização de `ultima_tentativa_at` e `zapi_message_id`, e — na 3ª tentativa esgotada — `markAsNaoInformado`, `notificarCuidadores` e alerta de estoque. **Isso NÃO é agrupado.** Só a mensagem de texto enviada ao usuário é unificada.

### 6.1 `checkAndSendFollowUps`

1. Coletar as doses que **devem reenviar neste ciclo** (mesma lógica atual de `deveReenviar`, por dose).
2. Dessas, separar as que vão de fato enviar mensagem (`tentativa <= 3`) das que vão esgotar (`tentativa > 3` → `nao_informado`). As que esgotam seguem individualmente (não faz sentido agrupar mensagens de esgotamento; cada uma dispara nao_informado/cuidadores/estoque próprios).
3. Para as que enviam mensagem: agrupar por `(user_id + horario_agendado)` usando o mesmo helper.
   - Grupo de 1 (ou `horario_agendado` NULL) → fluxo individual atual (`handleFollowUp`).
   - Grupo de 2+ → **enviar uma mensagem de follow-up agrupada** e, para cada dose do grupo, executar as atualizações de estado individuais.

> **Detalhe de coerência de `tentativas`:** doses que saíram juntas no lembrete inicial compartilham o mesmo `ultima_tentativa_at`, logo cruzam o limite (30/60/30) no mesmo ciclo do cron e têm a mesma `tentativa`. A mensagem agrupada usa o número de tentativa do grupo (todas iguais nesse caso). Se por algum motivo as tentativas divergirem dentro de um grupo, agrupar mesmo assim pela apresentação, usando o texto da menor tentativa do grupo (mais conservador) — mas isso é caso de borda; o comportamento normal é tentativas iguais.

### 6.2 Refatoração sugerida em `lembrete.js`

Separar o **envio da mensagem** da **atualização de estado**, para que o follow-up agrupado reutilize a lógica de estado sem duplicar código:

- `handleFollowUp({ doseLog, reminder })` — mantém a assinatura atual (para grupos de 1). Internamente pode passar a chamar as duas partes abaixo.
- `buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo)` — nova, monta a mensagem agrupada de follow-up.
- Uma função de **atualização de estado por dose** (extrair do corpo atual do `handleFollowUp`): dado um `doseLog`/`reminder` e a `tentativa`, faz `updateDoseLogTentativa` + `updateDoseLogZapiMessageId`, OU (se esgotou) `markAsNaoInformado` + `notificarCuidadores` + alerta de estoque. Essa função é chamada **uma vez por dose**, tanto no caminho individual quanto no agrupado.

### 6.3 Mensagem de follow-up agrupada (Variação C adaptada)

```javascript
function buildGroupedFollowUpMessage(tentativa, firstName, horario, grupo) {
    const lista = grupo.map(r => `• *${r.med_nome}*`).join('\n');
    const abertura = tentativa === 3
        ? `💊 ${firstName}, último aviso de hoje!`
        : `⏰ ${firstName}, só passando para lembrar!`;

    return (
        `${abertura}\n\n` +
        `Ainda não vi sua confirmação dos remédios das *${horario}*:\n` +
        `${lista}\n\n` +
        `✅ Tomou todos? Responda *SIM*\n` +
        `💬 Tomou só alguns? Me diga quais 🌿`
    );
}
```

> O `zapi_message_id` do follow-up agrupado é o mesmo para todas as doses do grupo (atualizado por dose via `updateDoseLogZapiMessageId`). Como a confirmação opera por `dose_log.id` (via `[ref:]` no principal.js), não há ambiguidade.

---

## 7. O QUE NÃO MUDA (confirmado em código)

- **`principal.js` — confirmação:** já lista as doses pendentes com `[ref: dose_log.id]` e o prompt já instrui o LLM a emitir um `CONFIRM_DOSE` por dose quando o usuário confirma coletivamente ("tomei todos"), ou só a dose citada quando parcial ("só o Losartana"). **Nenhuma alteração necessária.** A confirmação parcial já cai naturalmente: confirma o que foi dito, o resto segue pendente e é cobrado no próximo follow-up (que virá agrupado só com o que falta).
- **`scheduled_at`:** permanece com o significado atual (timestamp do disparo). É lido por `principal.js` (exibir hora da dose) e `lembrete.js` (notificação de cuidadores). **Não tocar.**
- **Ciclo de vida da dose** (retroativa/reversão): intocado.
- **`alterarHorarioSchedule`:** confirmado que só faz `UPDATE` em `schedules`, não toca `dose_logs`. MH-032 não interage com alteração de horário.

---

## 8. CENÁRIOS DE TESTE (validação em produção)

Testar com usuário real no WhatsApp. Pré-requisito: um usuário com 2+ medicamentos no **mesmo horário exato**.

1. **Lembrete agrupado básico:** 2 medicamentos com estoque, mesmo horário (ex: 08:00). → Uma única mensagem no formato Variação C, listando os dois. Verificar no banco: 2 `dose_logs` criados, cada um com `horario_agendado = '08:00'`.
2. **Horários diferentes NÃO agrupam:** medicamentos 08:00 e 08:05. → Duas mensagens separadas.
3. **Confirmação total:** responder "SIM" à mensagem agrupada. → Ambas as doses confirmadas (2× `CONFIRM_DOSE`), estoque de cada uma −1.
4. **Confirmação parcial:** responder "só o Losartana". → Só Losartana confirmada; Metformina segue pendente.
5. **Follow-up agrupado:** ignorar o lembrete agrupado. → Após 30 min, follow-up agrupado (tentativa 2) só com as doses ainda pendentes, no formato agrupado.
6. **Follow-up após confirmação parcial:** confirmar só uma no lembrete inicial; ignorar. → Follow-up vem **individual** (só a dose restante), porque o grupo agora tem 1 elemento.
7. **Estoque zerado no grupo:** 2 medicamentos mesmo horário, um com estoque 0. → Mensagem agrupada só com o que tem estoque + mensagem de estoque zerado individual para o outro.
8. **Esgotamento (3ª tentativa):** ignorar todos os follow-ups de um grupo. → Cada dose vira `nao_informado` individualmente, cuidadores notificados por dose, entra no fluxo de confirmação retroativa (ciclo de vida da dose).
9. **Dose única (não-regressão):** usuário com 1 só medicamento naquele horário. → Mensagem individual idêntica à de hoje (Variação C NÃO aplicada). Confirma que grupos de 1 não quebraram.
10. **`horario_agendado` NULL (não-regressão):** dose_log antigo (pré-migration) ainda pendente. → Tratado como individual (fallback), sem erro.

---

## 9. RESUMO DOS ARQUIVOS TOCADOS

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/<nova>.sql` | Nova coluna `horario_agendado time` em `dose_logs` |
| `src/database.js` | `createDoseLog` aceita e grava `horarioAgendado`; `getPendingFollowUps` inalterado (campo já vem no `*`) |
| `src/scheduler.js` | Separar sem-estoque; agrupar por user+horário; `sendGroupedReminder`; `buildGroupedReminderMessage`; helper `agruparPorUsuarioEHorario`; passar `horarioAgendado` em todos os `createDoseLog` |
| `src/agentes/lembrete.js` | Follow-up agrupado: separar envio de mensagem da atualização de estado; `buildGroupedFollowUpMessage`; estado continua por dose |

**Sem alteração em:** `principal.js`, `router.js`, `prompts.js`, `cadastro.js`, `configuracao.js`, `recepcionista.js`.

---

## 10. CHECKLIST DE COERÊNCIA (antes do git push)

- [ ] Todos os `createDoseLog` no `scheduler.js` passam `horarioAgendado` (inclusive o de estoque zerado, para consistência de dados novos).
- [ ] Agrupamento usa `horario` (lembrete) / `horario_agendado` (follow-up), NUNCA `scheduled_at`.
- [ ] `horario_agendado = NULL` cai em fallback individual, sem erro.
- [ ] Estado por dose (tentativas, nao_informado, cuidadores, estoque) permanece individual no follow-up agrupado.
- [ ] Mensagem individual atual (`buildReminderMessage`) preservada para grupos de 1 e estoque zerado.
- [ ] `scheduled_at` não teve seu significado alterado.