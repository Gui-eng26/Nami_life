# BRIEFING — BUG-084: `pos_alteracao` escala para o classificador geral em vez de reconhecer diretamente um horário já oferecido

**Sessão:** 28 (continuação)
**Arquivo alterado:** `src/agentes/configuracao.js` (único arquivo)
**Prioridade:** média-alta — não corrompe dado sozinho (a etapa seguinte pede confirmação explícita antes de remover), mas o usuário quase confirmou a remoção permanente de um lembrete que só queria alterar
**Relacionado a:** BUG-082 (é o 3º defeito que a correção dele revelou nesta mesma cadeia de escalada); independente de BUG-083 (função diferente, sem conflito)
**Depende de:** nada. BUG-083 já estava implementado e em produção quando este bug foi encontrado (confirmado em código) — o BUG-084 é totalmente independente: a mensagem que dispara este bug nunca chega a executar o trecho corrigido pelo BUG-083, porque a ação escolhida (`remover_horario`) já é diferente antes mesmo de chegar lá.

---

## 1. Contexto e causa raiz (confirmada por evidência)

### O sintoma observado

Durante validação do BUG-082/BUG-083 (31/07/2026, 23:06 BRT):

```
Nami: Lembrete das 20:30 do Ômega 3 atualizado para 21:00 ⏰
      Você ainda tem lembretes cadastrados: • 09:00 • 12:40. Quer alterar algum?
Você: 12:40
Nami: Só confirmar, Guilherme: vou remover o lembrete das 12:40 do Ômega 3
      permanentemente. Confirmar?
```

O usuário queria **alterar** o horário das 12:40, e a Nami ofereceu **remover** permanentemente.

### Causa raiz confirmada em código

"12:40" não bate `isConfirmacao` nem `isCancelamento` na etapa `pos_alteracao` → escala corretamente (comportamento do BUG-082, funcionando como desenhado) → `despacharEscalada` → `identif_intencao` → chama `classificarIntencao` (LLM), que decide a ação a partir da mensagem + `CONVERSA RECENTE`. O prompt dessa função dá exemplos de `alterar_horario` e `remover_horario` sempre **com verbo** ("muda das 8 para 9", "tirar o das 8h") — nenhum exemplo cobre uma mensagem que é só um número, sem verbo, respondendo a uma pergunta de continuação ("quer alterar algum?"). Diante da ambiguidade, o modelo escolheu `remover_horario`.

### Por que a solução não é ajustar o prompt do classificador

A pergunta "quer alterar algum?" (feita em `pos_alteracao` quando restam 2+ horários) **já embute uma lista implícita** — os horários restantes, que a própria etapa conhece com precisão (`context.schedulesAtivos`). Mandar essa resposta para um classificador geral (que não recebe essa lista) é usar uma ferramenta menos precisa do que a que já está disponível ali mesmo. O próprio código do `pos_alteracao` já reconhece esse princípio parcialmente: quando resta **só 1** horário, ele pula direto para `obter_horario` sem perguntar "qual desses", porque não há ambiguidade. A correção estende esse mesmo raciocínio para quando há 2+: se a resposta nomeia um deles sem ambiguidade, trate como seleção direta, sem escalar.

---

## 2. A correção

### Arquivo: `src/agentes/configuracao.js`, etapa `pos_alteracao`

**Localizar o bloco:**

```js
if (!isConfirmacao(message)) {
    if (isCancelamentoGenuino(message, medicationsAtivos)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
```

**Substituir por:**

```js
if (!isConfirmacao(message)) {
    // A pergunta "quer alterar algum?" já oferece uma lista implícita (os horários
    // restantes). Se a mensagem nomeia diretamente um deles, é "sim" + seleção na
    // mesma mensagem — mesmo princípio já usado no ramo de 1 horário só (pula
    // pergunta desnecessária quando a resposta já é inequívoca). Reaproveita o
    // mesmo casador determinístico que identif_schedule usa, em vez de escalar
    // para um classificador geral que não tem essa lista em mãos.
    const schedulesRestantesParaCheck = context.schedulesAtivos || [];
    if (schedulesRestantesParaCheck.length > 1) {
        const horarioMencionado = normalizarHorario(message, schedulesRestantesParaCheck);
        const scheduleEspecifico = horarioMencionado
            ? schedulesRestantesParaCheck.find(s => s.horario.startsWith(horarioMencionado))
            : null;
        if (scheduleEspecifico) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { ...context, etapa: 'obter_horario', scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario }
            });
            return `Certo! Vou alterar o lembrete das *${scheduleEspecifico.horario.substring(0, 5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
        }
    }

    if (isCancelamentoGenuino(message, medicationsAtivos)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
```

`normalizarHorario` já está definida no arquivo (função de nível de módulo, usada em `continuarComAcao`) — não precisa de import novo.

**Não alterar mais nada** — o restante da etapa (`schedulesRestantes.length === 1`, e o `identif_schedule` para quando `isConfirmacao` já é verdadeiro) fica intacto.

---

## 3. Verificação antes de considerar concluído

```bash
node --check src/agentes/configuracao.js
```

Commit (`fix: pos_alteracao reconhece horário oferecido diretamente antes de escalar (BUG-084)`), push.

---

## 4. Registro no backlog

- **BUG-084**
  - Título: "pos_alteracao escala para o classificador geral em vez de reconhecer diretamente um horário já oferecido — classificador confundiu alterar com remover"
  - Status inicial: `em_validacao`
  - Prioridade: média-alta
  - Relacionado a: BUG-082
  - `causa_raiz`: resumo da seção 1

Considerar registrar como princípio novo no encerramento desta sessão (CONTEXT.md): *"Quando uma etapa oferece uma lista implícita como parte de uma pergunta de sim/não, uma resposta que nomeia diretamente um item da lista deve ser reconhecida com o mesmo casador determinístico já usado para essa lista, antes de escalar."* — útil caso surjam etapas futuras com a mesma forma.

---

## 5. Casos de teste — rodar direto no WhatsApp

Precisa de um medicamento com **3 horários ativos** (pra sobrar 2 depois de alterar o primeiro).

**1 — O caso original, corrigido**
- Altere um dos 3 horários até chegar em "Você ainda tem lembretes: • X • Y. Quer alterar algum?"
- Responda direto com um dos dois restantes, ex: `12:40`
- **Esperado (novo):** *"Certo! Vou alterar o lembrete das 12:40. Para qual horário?"* — nunca mais "remover... permanentemente".
- Continue normalmente (responda um destino, depois `Sim`)
- **Esperado:** confirma a alteração corretamente.

**2 — Não-regressão: "Sim" sem nomear horário ainda pergunta "qual desses"**
- Mesmo ponto de partida (2+ restantes) → responda só `Sim`
- **Esperado:** *"Qual desses você quer alterar?"* — igual a antes, sem mudança.

**3 — Não-regressão: só 1 horário restante continua pulando direto**
- Repita até restar só 1 horário → responda `Sim`
- **Esperado:** vai direto para "Para qual horário?" sem perguntar "qual desses" — esse ramo não foi tocado.

**4 — Não-regressão: conteúdo genuinamente não relacionado ainda escala**
- Com 2+ horários restantes, na pergunta "quer alterar algum?", responda algo sem relação: `Tomei o cataflam`
- **Esperado:** escala normalmente (não é interpretado como tentativa de horário) — reage ao conteúdo real, igual ao comportamento validado no BUG-082.

**5 — Não-regressão: cancelamento continua funcionando**
- Com 2+ horários restantes → responda `Não, só esse mesmo`
- **Esperado:** *"Tudo certo! Se precisar de algo, é só me chamar"* — sem mudança.

Depois de cada teste, conferir em `agent_logs` que o `agent` e a resposta batem com o esperado.