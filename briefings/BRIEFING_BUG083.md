# BRIEFING — BUG-083: Horário único é lido como origem E destino simultaneamente em `continuarComAcao`

**Sessão:** 28 (continuação)
**Arquivo alterado:** `src/agentes/configuracao.js` (único arquivo)
**Prioridade:** média — não corrompe dado (usuário pode responder "Não"), mas gera confirmação sem sentido
**Relacionado a:** BUG-082 (não é regressão dele — foi um defeito pré-existente que a correção do BUG-082 tornou alcançável pela primeira vez, ao permitir que `pos_alteracao` escale corretamente)
**Depende de:** BUG-082 já implementado (é o que torna esse caminho de código exercitável)

---

## 1. Contexto e causa raiz (confirmada por evidência, não hipótese)

### O sintoma observado

Durante a validação do BUG-082 (31/07/2026, 22:20:59 BRT), o teste de "resposta direta com horário, sem confirmação explícita antes" (etapa `pos_alteracao`) produziu uma confirmação sem sentido:

```
Nami: Lembrete das 21:00 do Ômega 3 atualizado para 20:30 ⏰
      Você ainda tem lembretes cadastrados: • 09:00 • 12:40. Quer alterar algum?
Você: 12:40
Nami: Só confirmar: vou mudar o lembrete das 12:40 do Ômega 3 para 12:40. Confirmar?
```

### Causa raiz confirmada em código

A mensagem "12:40" chega em `continuarComAcao` (ramo `alterar_horario`, `schedulesAtivos.length > 1`), via escalada (`despacharEscalada` → `identif_intencao` → `processarIntencaoOuEscalar` → `continuarComAcao`). Duas extrações independentes rodam sobre o **mesmo texto**, com propósitos diferentes:

- `normalizarHorario(message, schedulesAtivos)` pega o **primeiro** número da mensagem, buscando qual horário existente foi **selecionado**. Com "12:40", acha `scheduleEspecifico` = 12:40.
- O campo `novoHorario` (resolvido antes de chegar aqui, via `classificarIntencao`/`interpretarHorarioLivre`) pega o **último** número da mensagem, assumindo que é o **destino**. Comentário do próprio código em `interpretarHorarioLivre`: *"Formato numérico explícito — pega o último (destino)"*.

Quando a mensagem só tem **um único número**, "primeiro" e "último" colapsam no mesmo valor — as duas extrações concordam erroneamente que aquele número serve pros dois papéis (seleção E destino) ao mesmo tempo. Como os dois campos (`scheduleEspecifico` e `novoHorario`) chegam preenchidos, `continuarComAcao` pula direto para montar a confirmação, sem perceber que os dois vieram do mesmo token.

### Por que nunca apareceu antes

O caminho determinístico normal (`identif_schedule` pergunta só "qual desses?" → `obter_horario` pergunta só "para qual horário?") nunca chama `continuarComAcao` — são duas perguntas separadas, uma de cada vez, sem ambiguidade. Só o caminho de escalada (`identif_intencao` → `continuarComAcao`, reprocessamento do zero via classificador) tem as duas extrações rodando ao mesmo tempo sobre a mesma mensagem. Esse caminho só passou a ser alcançável a partir de `pos_alteracao` depois da correção do BUG-082 — por isso nunca tinha aparecido.

---

## 2. A correção

**Não** comparar se os dois valores são iguais (isso só pegaria a coincidência exata de "12:40 = 12:40" e deixaria passar, por exemplo, um caso em que o classificador alucinasse um destino diferente a partir do mesmo número isolado). A correção certa é: **um único número na mensagem nunca deve ser lido como origem E destino ao mesmo tempo** — só confiar em `novoHorario` como destino quando a mensagem trouxer **dois números distintos** (padrão "das X para Y").

### Arquivo: `src/agentes/configuracao.js`, função `continuarComAcao`, ramo `if (acao === 'alterar_horario')`

**Localizar o bloco (dentro do `if (schedulesAtivos.length > 1)`):**

```js
if (!scheduleEspecifico) {
    const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
    const qtd = schedulesAtivos.length;
    const descricaoQtd = qtd === 1 ? 'um horário' :
                         qtd === 2 ? 'dois horários' :
                         `${qtd} horários`;
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'identif_schedule', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario }
    });
    return `O *${med.nome}* tem lembretes em ${descricaoQtd}:\n\n${lista}\n\nQual desses você quer alterar? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
}

if (!novoHorario) {
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario }
    });
    return `Certo! Vou alterar o lembrete das *${scheduleEspecifico.horario.substring(0,5)}* do *${med.nome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
}

const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario, novoHorario };
await saveConversationState(user.id, { state: 'configurando', context: ctx });
return buildConfirmacaoMessage(firstName, ctx);
```

**Substituir por (única mudança: a condição do segundo `if`, que passa a considerar também a contagem de horários na mensagem):**

```js
if (!scheduleEspecifico) {
    const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
    const qtd = schedulesAtivos.length;
    const descricaoQtd = qtd === 1 ? 'um horário' :
                         qtd === 2 ? 'dois horários' :
                         `${qtd} horários`;
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'identif_schedule', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario }
    });
    return `O *${med.nome}* tem lembretes em ${descricaoQtd}:\n\n${lista}\n\nQual desses você quer alterar? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
}

// BUG-083: um único número na mensagem não pode ser origem E destino ao mesmo tempo.
// scheduleEspecifico (seleção) e novoHorario (destino) só podem ter vindo de tokens
// DIFERENTES quando a mensagem realmente contém dois números distintos (padrão
// "das X para Y"). Com um número só, novoHorario nunca é confiável aqui — mesmo que
// esteja preenchido, tratamos como ausente e pedimos o destino separadamente.
const temDoisHorariosNaMensagem = [...message.matchAll(/\d{1,2}[:h]\d{2}/g)].length >= 2;

if (!novoHorario || !temDoisHorariosNaMensagem) {
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario }
    });
    return `Certo! Vou alterar o lembrete das *${scheduleEspecifico.horario.substring(0,5)}* do *${med.nome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
}

const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario, novoHorario };
await saveConversationState(user.id, { state: 'configurando', context: ctx });
return buildConfirmacaoMessage(firstName, ctx);
```

**Não alterar mais nada** — o resto de `continuarComAcao` (outros `acao`) e o resto do arquivo ficam intactos. A regex `\d{1,2}[:h]\d{2}` propositalmente exige minuto explícito (`h30`, `:30`), consistente com o padrão já usado em `matchesNumericos` nas duas funções de origem (`normalizarHorario`/`interpretarHorarioLivre`) — números soltos como "das 20 para 19" (sem minuto) continuam contando como ambíguos por segurança; refinar isso depois só se houver evidência real de que atrapalha.

---

## 3. Verificação antes de considerar concluído

```bash
node --check src/agentes/configuracao.js
```

Commit (`fix: horário único não é mais lido como origem e destino simultaneamente (BUG-083)`), push.

---

## 4. Registro no backlog

Via `registrarItemBacklog` (`src/backlog.js`):

- **BUG-083**
  - Título: "Horário único é lido como origem E destino simultaneamente em continuarComAcao — gera confirmação sem sentido (ex: 'mudar de 12:40 para 12:40')"
  - Status inicial: `em_validacao`
  - Prioridade: média
  - Relacionado a: BUG-082 (surgiu ao validá-lo, não é regressão dele)
  - `causa_raiz`: resumo da seção 1

---

## 5. Casos de teste — rodar direto no WhatsApp

Medicamento precisa ter **2 ou mais horários ativos** para reproduzir (ex: Ômega 3 com 09:00 e 12:40 restantes, como no cenário original).

**1 — O caso original, corrigido**
- Altere um horário até chegar em "Você ainda tem lembretes: • 09:00 • 12:40. Quer alterar algum?"
- Responda direto com um dos horários restantes, ex: `12:40` (sem "sim" antes)
- **Esperado (novo):** *"Certo! Vou alterar o lembrete das 12:40 do Ômega 3. Para qual horário?"* — nunca mais "de 12:40 para 12:40".
- Responda com um destino real, ex: `13:00`
- **Esperado:** *"Só confirmar: vou mudar o lembrete das 12:40 para 13:00. Confirmar?"*
- Responda `Sim`
- **Esperado:** confirma a troca corretamente (12:40 → 13:00).

**2 — Não-regressão: mensagem com dois horários continua funcionando direto**
- Mesmo ponto de partida (2+ horários) → responda numa frase só, com origem e destino: `Mudar o das 12:40 para 13:00`
- **Esperado:** vai direto para a confirmação (*"vou mudar o lembrete das 12:40 para 13:00. Confirmar?"*), sem passo extra — igual ao comportamento já validado antes (ex: "Mudar horário das 20 para 19:30" no teste anterior).

**3 — Não-regressão: fluxo normal de 2 etapas (identif_schedule → obter_horario) continua igual**
- `Alterar horário do [remédio com 2+ horários]` → escolha um horário (ex: `21`) → responda o destino (ex: `20:30`) → `Isso`
- **Esperado:** sem mudança nenhuma em relação a antes — essa etapa não foi tocada.

**4 — Caso extra: schedule único (não deveria ativar a checagem nova)**
- Altere horário de um remédio com **só 1 horário ativo**, chegando na pergunta "Para qual horário?"
- Responda com um horário: ex: `08:00`
- **Esperado:** confirma direto — esse ramo (`schedulesAtivos.length === 1`, mais abaixo no código) não foi alterado por este briefing, deve continuar como está.

Depois de cada teste, conferir em `agent_logs` que a mensagem final de confirmação nunca mostra o mesmo horário como origem e destino.