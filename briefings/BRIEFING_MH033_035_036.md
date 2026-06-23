# BRIEFING — MH-033 + MH-035 + MH-036: Gestão completa de horários de lembrete

**Sessão:** v10 — 23/06/2026  
**Arquivos afetados:** `src/database.js`, `src/agentes/configuracao.js`

---

## Contexto

O `agente_configuracao` hoje suporta apenas a alteração de um horário específico (de X para Y). Três lacunas foram identificadas a partir de uso real:

- **MH-033:** usuário quer alterar todos os horários de uma vez ("quero mudar os dois")
- **MH-035:** usuário quer remover um horário específico sem substituir ("tirar o das 20h")
- **MH-036:** usuário quer adicionar um horário novo ("vou começar a tomar às 20 também") ou redefinir todos os horários do zero ("agora vou tomar 3x ao dia")

Os três tocam no mesmo `classificarIntencao`, no mesmo `continuarComAcao` e no mesmo `executarAcao` — implementar separado criaria risco de conflito. Este briefing cobre os três em uma única implementação coesa.

---

## Mapa de operações sobre horários — antes e depois

| Operação | Trigger natural | Existe hoje | Após este briefing |
|---|---|---|---|
| Alterar horário específico | "mudar das 8 para 6" | ✅ | ✅ mantido |
| Alterar todos os horários em sequência | "mudar os dois", "alterar todos" | ❌ | ✅ MH-033 |
| Remover horário específico | "tirar o das 20", "apagar o lembrete das 8" | ❌ | ✅ MH-035 |
| Adicionar horário novo | "quero tomar às 20 também" | ❌ | ✅ MH-036 |
| Redefinir todos os horários do zero | "agora são 3x ao dia", "mudar todos os horários" | ❌ | ✅ MH-036 |

---

## Alteração 1 — `database.js`: duas novas funções

### `removerSchedule(scheduleId, medicationId, horario)`

Deleção permanente do schedule. Antes de deletar, cancela dose_logs pendentes daquele horário específico — evitando follow-ups órfãos (mesmo padrão do BUG-044).

**Nota importante:** `dose_logs` não possui coluna `schedule_id` (confirmado no schema). O cancelamento dos dose_logs é feito por `medication_id` + filtragem da hora do `scheduled_at` correspondente ao horário do schedule removido.

```javascript
export async function removerSchedule(scheduleId, medicationId, horario) {
    // Extrai HH:MM do horário do schedule (ex: "20:00:00" → "20:00")
    const horaStr = String(horario).substring(0, 5);

    // Busca dose_logs pendentes do medicamento e filtra pelo horário
    const { data: logsPendentes } = await supabase
        .from('dose_logs')
        .select('id, scheduled_at')
        .eq('medication_id', medicationId)
        .eq('status', 'pendente');

    const idsParaCancelar = (logsPendentes || [])
        .filter(log => {
            const horaLog = new Date(log.scheduled_at)
                .toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'America/Sao_Paulo'
                });
            return horaLog === horaStr;
        })
        .map(log => log.id);

    if (idsParaCancelar.length > 0) {
        const { error: errLogs } = await supabase
            .from('dose_logs')
            .update({ status: 'pausado' })
            .in('id', idsParaCancelar);
        if (errLogs) throw new Error(`Erro ao cancelar dose_logs: ${errLogs.message}`);
    }

    // Deleta o schedule permanentemente
    const { error } = await supabase
        .from('schedules')
        .delete()
        .eq('id', scheduleId);
    if (error) throw new Error(`Erro ao remover schedule: ${error.message}`);

    console.log(`🗑️ Schedule removido — id: ${scheduleId}, horario: ${horaStr}, dose_logs cancelados: ${idsParaCancelar.length}`);
}
```

**Nota:** usar `delete` (não `update({ ativo: false })`). `ativo: false` é estado de pausa — reversível. Remoção é permanente e semanticamente distinta.

### `adicionarSchedule(medicationId, horario)`

Wrapper sobre `saveSchedule` com verificação de duplicata:

```javascript
export async function adicionarSchedule(medicationId, horario) {
    // Verifica se já existe schedule ativo com esse horário
    const horarioFormatado = horario.length === 5 ? `${horario}:00` : horario;
    const { data: existente } = await supabase
        .from('schedules')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('horario', horarioFormatado)
        .eq('ativo', true)
        .maybeSingle();

    if (existente) {
        throw new Error(`HORARIO_DUPLICADO: já existe lembrete ativo às ${horario}`);
    }

    const { error } = await supabase
        .from('schedules')
        .insert({ medication_id: medicationId, horario: horarioFormatado, ativo: true });
    if (error) throw new Error(`Erro ao adicionar schedule: ${error.message}`);

    console.log(`➕ Schedule adicionado — medication: ${medicationId}, horario: ${horarioFormatado}`);
}
```

Importar ambas em `configuracao.js`.

---

## Alteração 2 — `classificarIntencao`: quatro novas ações

Expandir o prompt do `classificarIntencao` para distinguir as quatro operações sobre horários:

```javascript
const systemPrompt = `Você é um classificador de intenções para um assistente de saúde.
O usuário quer fazer algo com seus lembretes ou tratamentos.

Medicamentos cadastrados: ${listaMeds}

Responda APENAS com JSON válido, sem markdown, sem explicações:
{
  "acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "remover_horario" | "adicionar_horario" | "redefinir_horarios" | "ambiguo",
  "medicamentoMencionado": "nome mencionado ou null",
  "novoHorario": "HH:MM ou null"
}

Definições:
- pausar: parar lembretes temporariamente. Ex: "cancela o lembrete", "para de me lembrar"
- reativar: ativar lembretes pausados. Ex: "volta os lembretes", "ativa de novo"
- encerrar: terminar tratamento definitivamente. Ex: "não vou mais tomar", "remove esse remédio"
- alterar_horario: mudar UM horário específico para outro. Ex: "muda das 8 para 9", "trocar o das 20h para 22h"
- remover_horario: apagar um horário específico sem substituir. Ex: "tirar o lembrete das 8h", "apagar o das 20", "não preciso mais do aviso das 8", "remover esse horário"
- adicionar_horario: acrescentar um horário novo sem mexer nos existentes. Ex: "quero tomar às 20 também", "adicionar lembrete às 14h", "incluir um às 20h"
- redefinir_horarios: substituir TODOS os horários existentes por horários novos, ou aumentar/diminuir a frequência de doses. Ex: "mudar todos os horários", "agora vou tomar 3x ao dia", "mudar os dois horários", "alterar todos"
- ambiguo: não dá pra distinguir entre pausar e encerrar com certeza

ATENÇÃO: 
- "remover horário" é diferente de "encerrar tratamento" — remover é sobre um horário específico, encerrar é sobre o medicamento inteiro
- "adicionar horário" mantém os horários existentes — "redefinir" substitui todos
- quando há dúvida entre pausar e encerrar, use "ambiguo"`;
```

---

## Alteração 3 — `normalizarHorario`: reconhecimento flexível de horário

Substituir `extrairHorarioOrigem` em `identif_schedule` por uma função que reconhece variações naturais de linguagem, comparando contra os schedules disponíveis:

```javascript
function normalizarHorario(message, schedulesDisponiveis) {
    const msg = message.toLowerCase().trim();

    // 1. Tenta regex numérico primeiro (formato HH:MM ou HHhMM)
    const matchesNumericos = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (matchesNumericos.length > 0) {
        const m = matchesNumericos[0];
        const horarioExtraido = `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
        // Verifica se bate com algum schedule disponível
        const scheduleExato = schedulesDisponiveis.find(s => s.horario.startsWith(horarioExtraido));
        if (scheduleExato) return horarioExtraido;
        // Tenta match parcial por hora (ex: "8" → "08:00")
        const horaSo = m[1].padStart(2, '0');
        const schedulePorHora = schedulesDisponiveis.find(s => s.horario.startsWith(horaSo + ':'));
        if (schedulePorHora) return schedulePorHora.horario.substring(0, 5);
    }

    // 2. Número isolado (ex: "8", "20") → busca schedule com essa hora
    const matchNumeroIsolado = msg.match(/^(\d{1,2})$/);
    if (matchNumeroIsolado) {
        const hora = matchNumeroIsolado[1].padStart(2, '0');
        const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(hora + ':'));
        if (schedule) return schedule.horario.substring(0, 5);
    }

    // 3. Expressões de período do dia com número (ex: "8 da manhã", "8 da noite", "20 da tarde")
    const periodos = [
        { pattern: /(\d{1,2})\s*(da\s*manhã|de\s*manhã|am)/i, periodo: 'manha' },
        { pattern: /(\d{1,2})\s*(da\s*tarde|da\s*noite|pm|de\s*noite)/i, periodo: 'tarde_noite' },
        { pattern: /(\d{1,2})\s*h/i, periodo: null }
    ];

    for (const { pattern, periodo } of periodos) {
        const match = msg.match(pattern);
        if (match) {
            let hora = parseInt(match[1]);
            if (periodo === 'tarde_noite' && hora < 12) hora += 12;
            const horaStr = String(hora).padStart(2, '0');
            const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(horaStr + ':'));
            if (schedule) return schedule.horario.substring(0, 5);
        }
    }

    // 4. Expressões sem número (ex: "meio-dia", "meia-noite")
    const expressoes = {
        'meio.?dia': '12',
        'meia.?noite': '00',
        'meio da manhã': '06'
    };
    for (const [expr, hora] of Object.entries(expressoes)) {
        if (new RegExp(expr, 'i').test(msg)) {
            const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(hora + ':'));
            if (schedule) return schedule.horario.substring(0, 5);
        }
    }

    return null; // não reconhecido
}
```

**Usar `normalizarHorario` em:**
- `identif_schedule` (identificar qual horário alterar ou remover)
- `identif_schedule_remocao` (nova etapa — identificar qual horário remover)

`extrairHorarioOrigem` permanece para outros usos onde não há lista de schedules de referência.

---

## Alteração 4 — `continuarComAcao`: novas ações de horário

Adicionar tratamento para as quatro novas ações após identificar o medicamento:

```javascript
// ── REMOVER_HORARIO ──────────────────────────────────────────────────────────
if (acao === 'remover_horario') {
    // Se só tem 1 schedule ativo → não pode remover, redirecionar
    if (schedulesAtivos.length <= 1) {
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { etapa: 'identif_acao', medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
        });
        return `O *${med.nome}* tem apenas um horário de lembrete cadastrado (${schedulesAtivos[0]?.horario?.substring(0,5) || '?'}). Não é possível remover o único horário.\n\nSe quiser parar os lembretes, posso *pausar* temporariamente ou *encerrar* o tratamento. O que prefere?`;
    }

    // Verifica se o horário foi mencionado na mensagem original
    const horarioMencionado = normalizarHorario(message, schedulesAtivos);
    const scheduleAlvo = horarioMencionado
        ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
        : null;

    if (!scheduleAlvo) {
        const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { etapa: 'identif_schedule_remocao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
        });
        return `O *${med.nome}* tem lembretes nos seguintes horários:\n\n${lista}\n\nQual você quer remover? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
    }

    // Horário identificado → ir para confirmação
    const ctx = {
        etapa: 'confirm_acao',
        acao: 'remover_horario',
        medicationId: med.id,
        medicationNome: med.nome,
        schedulesAtivos,
        scheduleId: scheduleAlvo.id,
        horarioAtual: scheduleAlvo.horario
    };
    await saveConversationState(user.id, { state: 'configurando', context: ctx });
    return buildConfirmacaoMessage(firstName, ctx);
}

// ── ADICIONAR_HORARIO ────────────────────────────────────────────────────────
if (acao === 'adicionar_horario') {
    // Se já veio com horário na mensagem
    if (novoHorario) {
        const ctx = {
            etapa: 'confirm_acao',
            acao: 'adicionar_horario',
            medicationId: med.id,
            medicationNome: med.nome,
            schedulesAtivos,
            novoHorario
        };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // Sem horário → perguntar
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
    });
    const horariosAtuais = schedulesAtivos.map(s => s.horario.substring(0,5)).join(' e ');
    return `Você tem lembretes do *${med.nome}* às ${horariosAtuais}.\n\nQual horário quer adicionar? Me diga só o horário — por exemplo: *14:00*`;
}

// ── REDEFINIR_HORARIOS ───────────────────────────────────────────────────────
if (acao === 'redefinir_horarios') {
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'obter_novos_horarios', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
    });
    const horariosAtuais = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
    return `Vou substituir todos os horários do *${med.nome}*.\n\nHorários atuais:\n${horariosAtuais}\n\nMe diga os novos horários — por exemplo: *06:00, 14:00 e 22:00*`;
}
```

---

## Alteração 5 — novas etapas no handler principal

### `identif_schedule_remocao` — usuário escolhe qual horário remover

```javascript
if (etapa === 'identif_schedule_remocao') {
    const schedulesAtivos = context.schedulesAtivos || [];
    const horarioMencionado = normalizarHorario(message, schedulesAtivos);
    const schedule = horarioMencionado
        ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
        : null;

    if (!schedule) {
        const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
        return `Não reconheci esse horário. Os lembretes cadastrados são:\n\n${lista}\n\nMe responda com um desses — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
    }

    const ctx = {
        ...context,
        etapa: 'confirm_acao',
        scheduleId: schedule.id,
        horarioAtual: schedule.horario
    };
    await saveConversationState(user.id, { state: 'configurando', context: ctx });
    return buildConfirmacaoMessage(firstName, ctx);
}
```

### `obter_novos_horarios` — coleta horários para redefinição

```javascript
if (etapa === 'obter_novos_horarios') {
    const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)].map(m => {
        const h = m[1].padStart(2, '0');
        const min = (m[2] || '00').padStart(2, '0');
        return `${h}:${min}`;
    });

    if (matches.length === 0) {
        return `Não reconheci os horários, ${firstName}. Me diga os novos horários das doses — por exemplo: *06:00, 14:00 e 22:00*`;
    }

    // Remover duplicatas
    const horariosUnicos = [...new Set(matches)];

    const ctx = {
        ...context,
        etapa: 'confirm_acao',
        novosHorarios: horariosUnicos
    };
    await saveConversationState(user.id, { state: 'configurando', context: ctx });
    return buildConfirmacaoMessage(firstName, ctx);
}
```

### MH-033 — reconhecer "todos" / "os dois" / "ambos" em `identif_schedule`

Em `identif_schedule`, antes de tentar extrair horário específico, verificar se o usuário quer alterar todos:

```javascript
if (etapa === 'identif_schedule') {
    const msg = message.toLowerCase();
    const querTodos = /\b(todos|os dois|ambos|os três|tudo|todas)\b/.test(msg);

    if (querTodos) {
        // Ordena cronologicamente e inicia pelo primeiro
        const schedulesOrdenados = [...(context.schedulesAtivos || [])]
            .sort((a, b) => a.horario.localeCompare(b.horario));
        const primeiro = schedulesOrdenados[0];

        await saveConversationState(user.id, {
            state: 'configurando',
            context: {
                ...context,
                etapa: 'obter_horario',
                scheduleId: primeiro.id,
                horarioAtual: primeiro.horario,
                schedulesAtivos: schedulesOrdenados // já ordenados para pos_alteracao
            }
        });
        return `Certo! Vou alterar todos os horários do *${context.medicationNome}* um a um.\n\nComeçando pelo primeiro: lembrete das *${primeiro.horario.substring(0,5)}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
    }

    // Lógica existente de identificar horário específico...
    const horarioMencionado = normalizarHorario(message, context.schedulesAtivos || []);
    // ... resto do código existente inalterado
}
```

---

## Alteração 6 — `buildConfirmacaoMessage`: novas ações

```javascript
case 'remover_horario':
    return `Só confirmar, ${firstName}: vou *remover* o lembrete das *${horarioAtual ? horarioAtual.substring(0,5) : '?'}* do *${medicationNome}* permanentemente.\n\nConfirmar?`;

case 'adicionar_horario':
    return `Só confirmar, ${firstName}: vou *adicionar* um lembrete às *${novoHorario}* para o *${medicationNome}*.\n\nConfirmar?`;

case 'redefinir_horarios':
    const listaHorarios = (ctx.novosHorarios || []).join(', ');
    return `Só confirmar, ${firstName}: vou *substituir todos os horários* do *${medicationNome}*.\n\nNovos horários: *${listaHorarios}*\n\nConfirmar?`;
```

---

## Alteração 7 — `executarAcao`: novas ações

```javascript
case 'remover_horario': {
    await removerSchedule(scheduleId, medicationId, horarioAtual);

    const remainingSchedules = (schedulesAtivos || []).filter(s => s.id !== scheduleId);

    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `✅ Pronto, ${firstName}! Lembrete das *${horarioAtual ? horarioAtual.substring(0,5) : '?'}* do *${medicationNome}* removido.\n\n${remainingSchedules.length > 0
        ? `Você ainda tem lembrete${remainingSchedules.length > 1 ? 's' : ''} às ${remainingSchedules.map(s => s.horario.substring(0,5)).join(' e ')} para esse medicamento.`
        : ''}`;
}

case 'adicionar_horario': {
    try {
        await adicionarSchedule(medicationId, novoHorario);
        await saveConversationState(user.id, { state: 'idle', context: {} });
        const todosHorarios = [...(schedulesAtivos || []).map(s => s.horario.substring(0,5)), novoHorario]
            .sort()
            .join(', ');
        return `✅ Pronto, ${firstName}! Adicionei um lembrete às *${novoHorario}* para o *${medicationNome}* 💊\n\nAgora você tem lembretes às: ${todosHorarios}`;
    } catch (e) {
        if (e.message.startsWith('HORARIO_DUPLICADO')) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `O *${medicationNome}* já tem um lembrete às *${novoHorario}*. Nada foi alterado 🌿`;
        }
        throw e;
    }
}

case 'redefinir_horarios': {
    // Usa reativarComAtualizacao que já desativa schedules antigos e cria novos
    await reativarComAtualizacao({
        medicationId,
        estoque: null, // não altera estoque
        tipo_tratamento: null, // não altera tipo
        tratamento_dias: null,
        horarios: ctx.novosHorarios,
        apenasHorarios: true // flag para não atualizar campos do medication
    });

    const horariosLabel = (ctx.novosHorarios || []).sort().join(', ');
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `✅ Pronto, ${firstName}! Horários do *${medicationNome}* atualizados 💊\n\nNovos lembretes: ${horariosLabel}`;
}
```

**Nota para `redefinir_horarios`:** precisa ajustar `reativarComAtualizacao` em `database.js` para aceitar o flag `apenasHorarios: true` — quando verdadeiro, não atualiza os campos `estoque_atual`, `tipo_tratamento` e `tratamento_dias` do medication, apenas recria os schedules.

---

## Alteração 8 — `reativarComAtualizacao` em `database.js`: flag `apenasHorarios`

```javascript
export async function reativarComAtualizacao({ medicationId, estoque, tipo_tratamento, tratamento_dias, horarios, apenasHorarios = false }) {
    if (!apenasHorarios) {
        // Atualiza dados do medicamento (só quando não é redefinição pura de horários)
        const { error: errMed } = await supabase
            .from('medications')
            .update({ estoque_atual: estoque, tipo_tratamento, tratamento_dias: tratamento_dias || null, ativo: true })
            .eq('id', medicationId);
        if (errMed) throw new Error(`Erro ao atualizar medicamento: ${errMed.message}`);
    }

    // Desativa schedules existentes
    const { error: errDel } = await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
    if (errDel) throw new Error(`Erro ao desativar schedules: ${errDel.message}`);

    // Cria novos schedules
    for (const horario of horarios) {
        const horarioStr = String(horario).trim().substring(0, 5);
        const { error: errSched } = await supabase
            .from('schedules')
            .insert({ medication_id: medicationId, horario: `${horarioStr}:00`, ativo: true });
        if (errSched) throw new Error(`Erro ao criar schedule: ${errSched.message}`);
    }

    console.log(`▶️ Schedules redefinidos — medication: ${medicationId}, horarios: ${horarios.join(', ')}`);
}
```

---

## Correção incluída: texto "dois horários" fixo → dinâmico

Em `continuarComAcao`, substituir o texto fixo pela versão dinâmica:

```javascript
// ANTES (fixo):
return `O *${med.nome}* tem lembretes em dois horários:\n\n${lista}...`

// DEPOIS (dinâmico):
const qtd = schedulesAtivos.length;
const descricaoQtd = qtd === 1 ? 'um horário' :
                     qtd === 2 ? 'dois horários' :
                     `${qtd} horários`;
return `O *${med.nome}* tem lembretes em ${descricaoQtd}:\n\n${lista}...`
```

---

## Impacto no cálculo de adesão — MH-037 registrado para sessão futura

`getAdesaoPeriodo` e `getAdesaoPorMedicamento` calculam `doses_esperadas` como:
```
schedulesAtivos.length × diasEfetivos
```

`schedulesAtivos` é lido no momento do cálculo — reflete o estado atual, não o histórico. Isso significa:

- **Remoção de horário:** subestima doses esperadas retroativamente → percentual de adesão inflado artificialmente
- **Adição de horário:** superestima doses esperadas retroativamente → percentual de adesão deflacionado artificialmente
- **Redefinição de horários:** mesmo problema amplificado

**Este problema já existe hoje** nos casos de pausa/reativação — não é introduzido por este briefing. As melhorias de horário apenas tornam o cenário mais frequente.

**Solução correta (MH-037):** calcular `doses_esperadas` a partir dos `dose_logs` gerados no período:
```javascript
// Correto: conta dose_logs reais gerados no período
COUNT(dose_logs WHERE medication_id = X AND scheduled_at >= janela)
// Em vez de: schedulesAtivos.length × diasEfetivos
```

`dose_logs` não possui `schedule_id` (confirmado no schema) — mas `medication_id` + `scheduled_at` são suficientes para o cálculo correto. Registrado como **MH-037** para implementação em sessão futura com briefing próprio.

---

## Impacto em outros sistemas — verificado

| Sistema | Impacto | Justificativa |
|---|---|---|
| Cron de lembretes | ✅ Nenhum | Filtra `schedules.ativo = true` — schedules removidos ou novos já respeitam isso |
| `getDosesHoje` (relatórios) | ✅ Nenhum | Filtra schedules ativos — não lê status diretamente |
| `temDosePendente` (router) | ✅ Nenhum | Schedule removido cancela dose_logs pendentes antes do delete |
| `getPendingFollowUps` | ✅ Nenhum | Filtra `status = 'pendente'` — dose_logs cancelados com `pausado` não aparecem |
| Trabalho 2 / reativação | ✅ Compatível | `reativarComAtualizacao` recebe novo flag `apenasHorarios` — backward compatible |
| Cadastro | ✅ Nenhum | `saveSchedule` existente não é alterado |

---

## Validação esperada após implementação

**MH-033 — Alterar todos os horários:**
1. Losartana com 05:30 e 22:00 → usuário diz "quero alterar os dois" → Nami inicia pelo 05:30
2. Usuário diz "08:00" → Nami confirma, altera, entra em `pos_alteracao` com 22:00 restante
3. Usuário diz "sim" → Nami pergunta novo horário para 22:00 → fluxo completa

**MH-035 — Remover horário:**
1. Medicamento com 08:00 e 20:00 → usuário diz "tirar o das 20" → Nami confirma remoção
2. Usuário confirma → schedule 20:00 deletado, dose_logs pendentes cancelados
3. Medicamento com 1 horário → usuário diz "remover" → Nami redireciona para pausar/encerrar

**MH-036 — Adicionar horário:**
1. Medicamento com 08:00 → usuário diz "quero tomar às 20 também" → Nami confirma adição
2. Usuário confirma → schedule 20:00 criado → cron inclui nas próximas execuções
3. Horário já existe → Nami informa e não duplica

**MH-036 — Redefinir todos:**
1. Medicamento com 08:00 e 20:00 → usuário diz "agora vou tomar 3x ao dia" → Nami pede novos horários
2. Usuário diz "06:00, 14:00 e 22:00" → Nami confirma substituição
3. Usuário confirma → schedules antigos desativados, três novos criados

**Reconhecimento flexível de horário:**
1. Schedules: 08:00 e 20:00 → usuário diz "8" → Nami identifica 08:00 ✅
2. Usuário diz "8 da noite" → Nami identifica 20:00 ✅
3. Usuário diz "20" → Nami identifica 20:00 ✅
4. Usuário diz "15:00" → Nami informa que não existe e lista os disponíveis ✅

---

**Comando para Claude Code:**  
`Leia o briefings/BRIEFING_MH033_035_036.md e implemente.`