# BRIEFING — MH-026
## Reestruturação completa dos alertas de estoque

**Data:** 15/06/2026  
**Origem:** Revisão de produto — lógica de alertas de estoque  
**Escopo:** `src/scheduler.js`, `src/database.js`, `src/agentes/principal.js`, `src/router.js`, `src/agentes/lembrete.js`  
**Supersede:** MH-025 (alerta apenas no 1º lembrete do dia) — não implementar MH-025  
**Complexidade:** Média — sem alteração de banco, sem novos agentes

---

## 1. Regras do produto aprovadas

### Regra fundamental
**O alerta de estoque NUNCA chega junto com o lembrete.** O lembrete é enviado. O usuário confirma. O alerta vem embutido na resposta de confirmação.

### Tabela de comportamento (por `diasRestantes` no momento do lembrete)

| `diasRestantes` (pré-confirmação) | Com o lembrete | Após confirmação |
|---|---|---|
| > 5 | Nada | Nada |
| 2 a 5 | Nada | Alerta — apenas na **1ª confirmação do dia** |
| 1 | Nada | Alerta — em **toda** confirmação |
| 0 | **Mensagem especial** (ver seção 2.1) | — |

**Se o usuário não confirmar após 3 follow-ups:** alerta enviado como mensagem separada ao marcar `nao_informado` (sem verificação de "1ª do dia" — urgência prevalece).

### Tratamento agudo com `tratamento_dias <= 5`
- Não envia alerta na faixa 2-5 dias
- Segue a lógica acima apenas quando `diasRestantes <= 1`

---

## 2. Mudanças por arquivo

### 2.1 — `src/scheduler.js`

**Mudança 1: substituir silêncio por mensagem quando estoque é zero**

```js
// ANTES — silêncio quando estoque zerado
if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
    console.log(`⚠️ Lembrete ignorado — estoque zerado para ${reminder.med_nome} (${reminder.phone})`);
    return;
}

// DEPOIS — mensagem alternativa (sem criar dose_log)
if (reminder.estoque_atual !== null && reminder.estoque_atual <= 0) {
    const firstName = reminder.user_name?.split(' ')[0] || 'você';
    const message = buildEstoqueZeradoMessage(firstName, reminder);
    await sendTextMessage(reminder.phone, message);
    console.log(`📦 Aviso de estoque zerado enviado para ${reminder.phone} — ${reminder.med_nome}`);
    return; // não cria dose_log — não há dose real para confirmar
}
```

**Mudança 2: remover chamada de `verificarEstoqueBaixo` do final de `sendReminder()`**

```js
// REMOVER estas linhas do final de sendReminder():
await sleep(2000);
await verificarEstoqueBaixo(reminder);
```

**Mudança 3: remover as funções de alerta antigas (não são mais usadas)**

Remover completamente do arquivo:
- `verificarEstoqueBaixo(reminder)`
- `buildEstoqueBaixoMessage(firstName, reminder, diasRestantes)`
- `sendEstoqueBaixoAlert(reminder, diasRestantes, dosesPerDia)`

**Mudança 4: adicionar nova função de mensagem para estoque zerado**

```js
function buildEstoqueZeradoMessage(firstName, reminder) {
    return (
        `⏰ ${firstName}, está na hora do seu *${reminder.med_nome}*!\n\n` +
        `⚠️ Seu estoque está zerado — não foi possível registrar a dose.\n\n` +
        `Quando fizer a recompra, me avise a nova quantidade:\n` +
        `*"Comprei 30 comprimidos de ${reminder.med_nome}"* 💊`
    );
}
```

**Mudança 5: remover `getMedicamentoDosesPerDia` dos imports** (não é mais usado no scheduler)

---

### 2.2 — `src/database.js`

**Adicionar três novas funções exportadas:**

```js
// ============================================================
// ALERTA DE ESTOQUE — SUPORTE PÓS-CONFIRMAÇÃO
// ============================================================

// Retorna info de estoque do medicamento para decisão de alerta
export async function getEstoqueInfoParaAlerta(medicationId) {
    const { data: med } = await supabase
        .from('medications')
        .select('nome, estoque_atual, tipo_tratamento, tratamento_dias')
        .eq('id', medicationId)
        .single();

    if (!med) return null;

    const { data: schedules } = await supabase
        .from('schedules')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('ativo', true);

    const dosesPerDia = (schedules || []).length;
    if (dosesPerDia === 0) return null;

    const diasRestantes = Math.floor(med.estoque_atual / dosesPerDia);

    return {
        medNome: med.nome,
        novoEstoque: med.estoque_atual,
        dosesPerDia,
        diasRestantes,
        tipo_tratamento: med.tipo_tratamento || 'continuo',
        tratamento_dias: med.tratamento_dias || null
    };
}

// Conta confirmações de hoje para o medicamento (determina se é 1ª do dia)
export async function contarConfirmacoesHoje(medicationId) {
    const agora = new Date();
    const dataBRT = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const [dia, mes, ano] = dataBRT.split('/');
    const inicioDiaBRT = new Date(`${ano}-${mes}-${dia}T00:00:00-03:00`);

    const { data } = await supabase
        .from('dose_logs')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('confirmed', true)
        .gte('taken_at', inicioDiaBRT.toISOString());

    return (data || []).length;
}

// Decide se deve enviar alerta de estoque após confirmação
// Retorna false se não deve alertar, ou o nível de urgência se deve
export function calcularAlertaEstoque({ diasRestantes, tipo_tratamento, tratamento_dias, confirmacoesDoDia }) {
    // Agudo com tratamento curto (<=5 dias): ignora faixa 2-5, só alerta no último dia
    const limiteAlerta = (tipo_tratamento === 'agudo' && tratamento_dias && tratamento_dias <= 5)
        ? 1
        : 5;

    if (diasRestantes > limiteAlerta) return false;

    // diasRestantes = 0: alerta sempre (último comprimido tomado)
    if (diasRestantes === 0) return true;

    // diasRestantes 1-5 (ou 1 para agudo curto): só na 1ª confirmação do dia
    return confirmacoesDoDia <= 1;
}
```

---

### 2.3 — `src/agentes/principal.js`

**Mudança 1: adicionar imports**

```js
import {
    // ...imports existentes...
    getEstoqueInfoParaAlerta,
    contarConfirmacoesHoje,
    calcularAlertaEstoque
} from '../database.js';
```

**Mudança 2: adicionar função de mensagem de alerta**

Adicionar no arquivo (fora da função principal):

```js
function buildAlertaEstoqueMessage(info) {
    const { medNome, novoEstoque, diasRestantes } = info;

    if (diasRestantes === 0) {
        return (
            `\n\n⚠️ *Atenção:* você acabou de tomar o último comprimido do *${medNome}* disponível. ` +
            `Não esqueça de providenciar a recompra!\n` +
            `Quando comprar, me avise: *"Comprei 30 comprimidos de ${medNome}"* 💊`
        );
    }

    const prazo = diasRestantes === 1
        ? 'mais *1 dia*'
        : `mais *${diasRestantes} dias*`;

    return (
        `\n\n⚠️ *Lembrete de estoque:* você tem *${novoEstoque}* ${novoEstoque === 1 ? 'unidade' : 'unidades'} ` +
        `do *${medNome}* — suficiente para ${prazo}. ` +
        `Bom momento para planejar a recompra! 💊`
    );
}
```

**Mudança 3: verificar alerta após CONFIRM_DOSE em `processAction`**

```js
case 'CONFIRM_DOSE':
    await confirmDose(action.medicationId);

    // Verificar se deve emitir alerta de estoque pós-confirmação
    try {
        const estoqueInfo = await getEstoqueInfoParaAlerta(action.medicationId);
        if (estoqueInfo) {
            const confirmacoesDoDia = await contarConfirmacoesHoje(action.medicationId);
            const deveAlertar = calcularAlertaEstoque({
                diasRestantes: estoqueInfo.diasRestantes,
                tipo_tratamento: estoqueInfo.tipo_tratamento,
                tratamento_dias: estoqueInfo.tratamento_dias,
                confirmacoesDoDia
            });
            if (deveAlertar) {
                // Será anexado à mensagem de confirmação já gerada pelo Claude
                return { alertaEstoque: buildAlertaEstoqueMessage(estoqueInfo) };
            }
        }
    } catch (e) {
        console.error('⚠️ Erro ao verificar alerta de estoque pós-confirmação:', e.message);
    }
    return null;
```

**Mudança 4: aplicar o alerta à mensagem em `handlePrincipal`**

Após `const override = await processAction(...)`, verificar se veio `alertaEstoque`:

```js
if (claudeResponse.action) {
    const override = await processAction(claudeResponse.action, user);
    if (override) {
        // Se veio alerta de estoque, anexar à mensagem do Claude
        if (override.alertaEstoque) {
            claudeResponse = {
                ...claudeResponse,
                message: claudeResponse.message + override.alertaEstoque
            };
        } else {
            claudeResponse = { ...claudeResponse, ...override };
        }
    }
}
```

---

### 2.4 — `src/router.js`

**Mudança 1: adicionar imports**

```js
import {
    // ...imports existentes...
    getEstoqueInfoParaAlerta,
    contarConfirmacoesHoje,
    calcularAlertaEstoque
} from './database.js';
```

**Mudança 2: adicionar função de mensagem (idêntica à do principal.js)**

Adicionar a mesma `buildAlertaEstoqueMessage(info)` no arquivo.

**Mudança 3: verificar alerta no fast-path após confirmação**

```js
// FAST-PATH existente
if (referenceMessageId && detectarConfirmacaoDose(message)) {
    const doseLog = await getDoseLogByZapiMessageId(referenceMessageId);
    if (doseLog && doseLog.confirmed === false) {
        await confirmDoseByLogId(doseLog.id);
        const nomeRemedio = doseLog.med_nome || 'seu remédio';
        const firstName = user.name ? user.name.split(' ')[0] : 'você';

        console.log(`✅ [FAST-PATH] Dose confirmada via referenceMessageId — ${user.phone} — ${nomeRemedio}`);
        await logAgentInteraction({ ... });

        // Verificar alerta de estoque pós-confirmação
        let alertaSufixo = '';
        try {
            const estoqueInfo = await getEstoqueInfoParaAlerta(doseLog.medication_id);
            if (estoqueInfo) {
                const confirmacoesDoDia = await contarConfirmacoesHoje(doseLog.medication_id);
                const deveAlertar = calcularAlertaEstoque({
                    diasRestantes: estoqueInfo.diasRestantes,
                    tipo_tratamento: estoqueInfo.tipo_tratamento,
                    tratamento_dias: estoqueInfo.tratamento_dias,
                    confirmacoesDoDia
                });
                if (deveAlertar) alertaSufixo = buildAlertaEstoqueMessage(estoqueInfo);
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar alerta estoque (fast-path):', e.message);
        }

        return `✅ Anotei! Dose do *${nomeRemedio}* confirmada, ${firstName}. Continue assim! 💪💊${alertaSufixo}`;
    }
}
```

---

### 2.5 — `src/agentes/lembrete.js`

**Mudança 1: adicionar imports**

```js
import {
    updateDoseLogTentativa,
    updateDoseLogZapiMessageId,
    markAsNaoInformado,
    getCaregivers,
    markCaregiverNotified,
    getEstoqueInfoParaAlerta,    // NOVO
    calcularAlertaEstoque        // NOVO
} from '../database.js';
```

**Mudança 2: adicionar função de mensagem de alerta para o caso nao_informado**

```js
function buildAlertaEstoqueNaoInformadoMessage(firstName, info) {
    const { medNome, novoEstoque, diasRestantes } = info;

    const prazo = diasRestantes === 0
        ? 'está esgotado'
        : diasRestantes === 1
            ? 'dura mais 1 dia'
            : `dura mais ${diasRestantes} dias`;

    return (
        `⚠️ ${firstName}, não recebi confirmação da sua dose do *${medNome}*.\n\n` +
        `Seu estoque atual é de *${novoEstoque}* unidades — ${prazo}.\n` +
        `Quando puder, me avise se tomou, e não esqueça de providenciar a recompra! 💊`
    );
}
```

**Mudança 3: enviar alerta de estoque após `markAsNaoInformado`**

```js
} else {
    // 3 tentativas esgotadas — marca como não informado e avisa cuidadores
    await markAsNaoInformado(doseLog.id);
    console.log(`⚠️ Dose marcada como nao_informado (${doseLog.id}) — ${reminder.phone} — ${reminder.med_nome}`);
    await notificarCuidadores(doseLog, reminder);

    // NOVO: verificar alerta de estoque (sem verificar 1ª do dia — urgência prevalece)
    try {
        const estoqueInfo = await getEstoqueInfoParaAlerta(doseLog.medication_id);
        if (estoqueInfo) {
            const deveAlertar = calcularAlertaEstoque({
                diasRestantes: estoqueInfo.diasRestantes,
                tipo_tratamento: estoqueInfo.tipo_tratamento,
                tratamento_dias: estoqueInfo.tratamento_dias,
                confirmacoesDoDia: 0  // força envio (sem verificação de 1ª do dia)
            });
            if (deveAlertar) {
                const firstName = reminder.user_name?.split(' ')[0] || 'você';
                const msg = buildAlertaEstoqueNaoInformadoMessage(firstName, estoqueInfo);
                await sendTextMessage(reminder.phone, msg);
                console.log(`📦 Alerta de estoque (nao_informado) enviado para ${reminder.phone} — ${estoqueInfo.medNome}`);
            }
        }
    } catch (e) {
        console.error('⚠️ Erro ao enviar alerta estoque (nao_informado):', e.message);
    }
}
```

---

## 3. Ordem de execução

1. `src/database.js` — adicionar as 3 novas funções
2. `src/scheduler.js` — substituir bloco de estoque zerado + remover `verificarEstoqueBaixo`
3. `src/agentes/principal.js` — imports + `buildAlertaEstoqueMessage` + `processAction` + `handlePrincipal`
4. `src/router.js` — imports + `buildAlertaEstoqueMessage` + fast-path atualizado
5. `src/agentes/lembrete.js` — imports + `buildAlertaEstoqueNaoInformadoMessage` + bloco nao_informado

---

## 4. Validação pós-deploy

### Caso 1 — Estoque zerado
Zerar o estoque de um medicamento de teste no Supabase:
```sql
UPDATE medications SET estoque_atual = 0 WHERE nome = 'Voltaren' AND user_id = '...';
```
No horário do lembrete: deve chegar a mensagem "está na hora do Voltaren, mas seu estoque está zerado" — sem dose_log criado.

### Caso 2 — Alerta 2-5 dias, 1ª confirmação
Setar estoque para `dosesPerDia * 3` (3 dias restantes). Confirmar dose → mensagem de confirmação deve vir com alerta de "3 dias restantes". Confirmar segunda dose do dia → alerta NÃO deve aparecer.

### Caso 3 — Alerta dia final (diasRestantes = 1)
Setar estoque para `dosesPerDia * 1` (1 dia restante). Confirmar dose → alerta aparece. Confirmar segunda dose do dia → alerta aparece de novo (comportamento correto — urgência máxima).

### Caso 4 — 3 follow-ups sem resposta com estoque baixo
Setar estoque para 3 dias. Não responder aos follow-ups. Após terceira tentativa → deve chegar mensagem separada de alerta de estoque (além da notificação de cuidadores).

### Caso 5 — Agudo com tratamento_dias <= 5, estoque = 4 dias
Não deve enviar alerta (tratamento curto, faixa 2-5 ignorada para agudo). Só alertar quando `diasRestantes <= 1`.

---

## 5. Nota sobre `buildAlertaEstoqueMessage` duplicada

A função `buildAlertaEstoqueMessage` aparece tanto em `principal.js` quanto em `router.js`. Se preferir DRY, pode ser extraída para um arquivo `src/utils/estoque.js` e importada em ambos. Fica a critério do Claude Code — funcionalmente correto em qualquer abordagem.