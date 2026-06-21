# BRIEFING — BUG-042 + BUG-043 + Melhorias de Comunicação no agente_configuracao

**Sessão:** v10 — 21/06/2026  
**Arquivo afetado:** `src/agentes/configuracao.js`  
**Bugs corrigidos:** BUG-042, BUG-043  
**Melhorias incluídas:** Comunicação das etapas de alteração de horário + fluxo `pos_alteracao`

---

## Contexto

O Wellington tentou alterar o horário do Losartana de 05:30 para 08:00 e desistiu sem conseguir. A investigação revelou **três problemas encadeados**, todos com causa raiz confirmada no código, mais uma deficiência de comunicação que cria a condição para os erros acontecerem.

---

## Problema 1 — BUG-042: `extrairHorario` captura o primeiro horário da frase, não o destino

### Causa raiz confirmada no código

```javascript
function extrairHorario(message) {
    const match = message.match(/(\d{1,2})[:h](\d{2})?/);
    // ...
}
```

`String.match()` sem flag `g` retorna o primeiro match. Quando o usuário responde `"05:30 para as 08:00"` na etapa `obter_horario`, a função captura `05:30` como novo horário — ignorando `08:00`, que é o destino real.

Resultado: a Nami gerou a confirmação `"vou mudar das 05:30 para 05:30"` — horário de origem e destino idênticos, porque `horarioAtual` e `novoHorario` eram o mesmo valor.

### Impacto

Qualquer usuário que responda de forma natural ("de X para Y", "X para as Y") na etapa `obter_horario` terá o horário de origem capturado como destino. A confirmação gerada estará errada silenciosamente — o sistema não detecta a inconsistência.

### Solução

A função `extrairHorario` serve dois propósitos distintos em etapas distintas:

- Em `identif_schedule`: extrair o horário de **origem** (qual o usuário quer alterar). Se houver dois horários, o primeiro é a origem.
- Em `obter_horario`: extrair o horário de **destino** (para onde quer mudar). Se houver dois horários, o último é o destino.

**Substituir a função única por duas funções distintas:**

```javascript
// Substitui extrairHorario() em identif_schedule
// Captura o PRIMEIRO horário da mensagem (horário de origem)
function extrairHorarioOrigem(message) {
    const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (!matches.length) return null;
    const m = matches[0];
    return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

// Substitui extrairHorario() em obter_horario
// Captura o ÚLTIMO horário da mensagem (horário de destino)
// Ex: "05:30 para as 08:00" → "08:00"
// Ex: "8h" → "08:00" (apenas um → retorna ele)
function extrairHorarioDestino(message) {
    const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (!matches.length) return null;
    const m = matches[matches.length - 1];
    return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}
```

**Pontos de uso:**
- Substituir todas as chamadas a `extrairHorario(message)` em `identif_schedule` por `extrairHorarioOrigem(message)`
- Substituir a chamada a `extrairHorario(message)` em `obter_horario` por `extrairHorarioDestino(message)`
- Substituir a chamada em `continuarComAcao` (linha `const horarioMencionado = extrairHorario(message)`) por `extrairHorarioOrigem(message)` — aqui estamos identificando qual schedule o usuário quer alterar, então queremos a origem
- A função original `extrairHorario` pode ser removida após substituição completa

---

## Problema 2 — BUG-043: `isCancelamento` ejeta usuário que tenta corrigir

### Causa raiz confirmada no código

```javascript
function isCancelamento(message) {
    return /\b(não|nao|cancela|cancelar|desiste|desistir|para|esquece|esquece isso)\b/
        .test(message.toLowerCase());
}
```

E em `confirm_acao`, `isCancelamento` é verificado **antes de qualquer outra lógica**:

```javascript
if (isCancelamento(message)) {
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `Tudo bem, ${firstName}! Nada foi alterado...`;
}
```

Quando Wellington disse `"Não 05:30 para as 08"` tentando corrigir a confirmação errada, o `\b(não)\b` foi detectado imediatamente → fluxo encerrado → `"Nada foi alterado"`.

O sistema não distingue entre:
1. Cancelamento genuíno: `"Não, esquece"` / `"Cancela"`
2. Correção: `"Não, o horário certo é 08:00"` / `"Não 05:30 para as 08"`

### Nota importante

BUG-043 foi agravado pelo BUG-042: a confirmação estava errada (05:30→05:30), o que forçou o Wellington a tentar corrigir com negação. Com o BUG-042 corrigido, a confirmação estará certa — reduzindo a incidência do BUG-043. Mas o bug existe independentemente e precisa ser corrigido.

### Solução

Em `confirm_acao`, antes de verificar cancelamento, checar se a mensagem contém negação **junto com um horário válido** — que é sinal de correção, não cancelamento. Nesse caso, extrair o novo horário e atualizar o contexto:

```javascript
if (etapa === 'confirm_acao') {
    const negacaoPresente = /\b(não|nao)\b/i.test(message.toLowerCase());
    const horarioCorrecao = extrairHorarioDestino(message);

    // "Não, são 08:00" ou "Não 05:30 para as 08" → usuário corrigindo, não cancelando
    if (negacaoPresente && horarioCorrecao) {
        const newCtx = { ...context, etapa: 'confirm_acao', novoHorario: horarioCorrecao };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // Cancelamento genuíno (sem horário na mensagem)
    if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }

    if (!isConfirmacao(message)) {
        return buildConfirmacaoMessage(firstName, context)
            + '\n\n_(Responda *SIM* para confirmar ou *NÃO* para cancelar)_';
    }

    return await executarAcao(user, firstName, context);
}
```

---

## Problema 3 — Comunicação das etapas não conduz o usuário

### Causa raiz confirmada nas mensagens do código

O fluxo de alteração de horário tem duas etapas sequenciais com responsabilidades distintas. As mensagens atuais apenas perguntam — não instruem sobre o formato esperado nem confirmam o que já foi entendido. Isso cria condição para o usuário combinar as duas etapas em uma resposta (como fez o Wellington), ou não saber o que a Nami quer.

**Princípio:** é obrigação da Nami conduzir o usuário, não do usuário deduzir o que o fluxo espera.

### Mensagens a reescrever

**`identif_schedule` — quando medicamento tem múltiplos horários (em `continuarComAcao`):**

Atual:
```
O *Losartana* tem lembretes em:
• 05:30
• 22:00

Qual horário você quer alterar?
```

Novo:
```
O *Losartana* tem lembretes em dois horários:
• 05:30
• 22:00

Qual desses você quer alterar? Me responda com o horário — por exemplo: *05:30*
```

**`identif_schedule` — mensagem de retry (horário não reconhecido, em `identif_schedule`):**

Atual:
```
Não encontrei esse horário. Horários disponíveis:
• 05:30
• 22:00

Qual você quer alterar?
```

Novo:
```
Não reconheci esse horário. Os lembretes cadastrados são:
• 05:30
• 22:00

Me responda com um desses exatamente — por exemplo: *05:30*
```

**`obter_horario` — quando pergunta o novo horário (em `identif_schedule` e `continuarComAcao`):**

Atual:
```
Para qual horário você quer mudar o lembrete das *05:30*? (ex: *14:30*)
```

Novo:
```
Certo! Vou alterar o lembrete das *05:30* do *${medicationNome}*.

Para qual horário? Me responda só com o novo horário — por exemplo: *08:00*
```

A mensagem confirma explicitamente o que já foi entendido ("Vou alterar o das 05:30") e instrui o formato esperado ("Me responda só com o novo horário"). Isso elimina a ambiguidade que leva o usuário a repetir a origem na resposta.

**`obter_horario` — mensagem de erro (horário não reconhecido):**

Atual:
```
Não entendi o horário, ${firstName}. Informe no formato *HH:MM* (ex: *14:30*)
```

Novo:
```
Não reconheci esse horário, ${firstName}. Me diga só o novo horário no formato *HH:MM* — por exemplo: *08:00*
```

---

## Melhoria — Fluxo `pos_alteracao`: oferecer continuação quando há múltiplos horários

### Contexto

Quando um medicamento tem N horários e o usuário altera apenas um, o fluxo atual encerra com `idle`. O usuário que quiser alterar outro horário precisa iniciar o fluxo do zero. O `pos_alteracao` resolve isso de forma elegante: após cada alteração bem-sucedida com horários restantes, a Nami pergunta se o usuário quer continuar.

### Implementação em `executarAcao` — case `alterar_horario`

```javascript
case 'alterar_horario':
    await alterarHorarioSchedule(scheduleId, novoHorario);

    // Horários restantes = todos os schedules ativos MENOS o que acabou de ser alterado
    // IMPORTANTE: usar scheduleId para excluir — não o horário, que mudou
    const remainingSchedules = (schedulesAtivos || []).filter(s => s.id !== scheduleId);

    if (remainingSchedules.length > 0) {
        const lista = remainingSchedules
            .map(s => `• ${s.horario.substring(0, 5)}`)
            .join('\n');
        const plural = remainingSchedules.length > 1 ? 's' : '';

        await saveConversationState(user.id, {
            state: 'configurando',
            context: {
                etapa: 'pos_alteracao',
                acao: 'alterar_horario',
                medicationId,
                medicationNome,
                schedulesAtivos: remainingSchedules
            }
        });

        return `✅ Pronto! Lembrete das *${horarioAtual ? horarioAtual.substring(0, 5) : '?'}* do *${medicationNome}* atualizado para *${novoHorario}* ⏰\n\nVocê ainda tem lembrete${plural} cadastrado${plural} para esse medicamento:\n${lista}\n\nQuer alterar algum?`;
    }

    // Horário único ou todos alterados → encerra normalmente
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `✅ Pronto! Seu lembrete do *${medicationNome}* foi atualizado para *${novoHorario}* ⏰`;
```

### Nova etapa `pos_alteracao` no handler principal

Adicionar antes do fallback final:

```javascript
// ── ETAPA pos_alteracao: usuário quer alterar outro horário? ─────────────────
if (etapa === 'pos_alteracao') {
    if (isCancelamento(message) || /\b(não|nao|nao|n|não|chega|pronto|ok|tudo bem)\b/i.test(message.toLowerCase())) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
    }

    // Qualquer coisa afirmativa ou menção de horário → volta para identif_schedule
    // com o medicamento já no contexto e apenas os horários restantes
    const schedulesRestantes = context.schedulesAtivos || [];

    if (schedulesRestantes.length === 1) {
        // Só um restante → pula direto para obter_horario
        const schedule = schedulesRestantes[0];
        await saveConversationState(user.id, {
            state: 'configurando',
            context: {
                ...context,
                etapa: 'obter_horario',
                scheduleId: schedule.id,
                horarioAtual: schedule.horario
            }
        });
        return `Certo! Vou alterar o lembrete das *${schedule.horario.substring(0, 5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
    }

    // Múltiplos restantes → volta para identif_schedule para o usuário escolher
    const lista = schedulesRestantes.map(s => `• ${s.horario.substring(0, 5)}`).join('\n');
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { ...context, etapa: 'identif_schedule' }
    });
    return `Qual desses você quer alterar?\n\n${lista}\n\nMe responda com o horário — por exemplo: *${schedulesRestantes[0].horario.substring(0, 5)}*`;
}
```

### Por que `schedulesAtivos.filter(s => s.id !== scheduleId)` e não o horário

O `scheduleId` é o identificador único do registro na tabela `schedules`. Após a alteração, o horário desse schedule no banco mudou (de 05:30 para 08:00), mas o ID permanece o mesmo. Filtrar por ID garante que o schedule alterado seja corretamente excluído dos restantes — mesmo que o novo horário coincida com outro schedule existente (caso improvável mas possível).

---

## Resumo das alterações em `configuracao.js`

| O que muda | Onde | Tipo |
|---|---|---|
| Adicionar `extrairHorarioOrigem()` e `extrairHorarioDestino()` | topo do arquivo | substituição de `extrairHorario()` |
| Substituir chamadas de `extrairHorario()` | `identif_schedule`, `continuarComAcao` | por `extrairHorarioOrigem()` |
| Substituir chamada de `extrairHorario()` | `obter_horario` | por `extrairHorarioDestino()` |
| Remover função `extrairHorario()` | topo do arquivo | remoção |
| Lógica de correção antes de cancelamento | `confirm_acao` | adição (BUG-043) |
| Reescrever mensagens de `identif_schedule` e `obter_horario` | `continuarComAcao` e `identif_schedule` | substituição |
| Case `alterar_horario` em `executarAcao` | `executarAcao` | substituição com `pos_alteracao` |
| Nova etapa `pos_alteracao` | handler principal | adição antes do fallback |

---

## O que este briefing NÃO cobre

- **MH-033** — Alteração de múltiplos horários em uma única mensagem ("quero mudar os dois"). Registrado no backlog para design futuro.
- Outros tipos de ação do `agente_configuracao` (pausar, reativar, encerrar) — não afetados.

---

## Validação esperada após implementação

1. Wellington diz `"alterar horário do Losartana"` → Nami mostra os horários e instrui explicitamente o formato
2. Wellington diz `"05:30"` → Nami confirma "Vou alterar o das 05:30" e pede só o novo horário
3. Wellington diz `"05:30 para as 08:00"` → Nami extrai `08:00` (não 05:30) como destino
4. Confirmação exibe `"das 05:30 para 08:00"` → correto
5. Wellington diz `"Não, são 09:00"` → Nami atualiza confirmação para 09:00, não encerra
6. Wellington confirma → lembrete alterado → Nami pergunta se quer alterar o das 22:00 também
7. Wellington diz `"sim"` → Nami oferece o horário restante (22:00) para alteração
8. Wellington diz `"não"` → `idle`, fluxo encerrado corretamente

---

**Comando para Claude Code:**  
`Leia o briefings/BRIEFING_BUG042_043.md e implemente.`