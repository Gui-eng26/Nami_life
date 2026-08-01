# BRIEFING — BUG-082: Escalada ausente em 3 etapas do state machine de `configuracao.js`

**Sessão:** 28 (continuação)
**Arquivo alterado:** `src/agentes/configuracao.js` (único arquivo)
**Prioridade:** alta — causa perda silenciosa de conteúdo real do usuário, incluindo confirmações de dose
**Depende de:** nada. Isolado, sem relação com MH-065/v27.

---

## 1. Contexto e causa raiz (confirmada por evidência, não hipótese)

### O sintoma observado

Em 31/07/2026, às 15:08 BRT (`agent_log b0d7f2aa`), o usuário estava com um fluxo de "Pausar Dipirona" pendente de confirmação desde 12:37 BRT (etapa `confirm_acao`). Entre esse momento e 15:08, quatro mensagens proativas da própria Nami foram enviadas sobre um medicamento diferente (Ômega 3): lembrete, dois follow-ups e um alerta de estoque pós-`nao_informado`. Quando o usuário finalmente escreveu **"Tomei o ômega 3"** — uma mensagem autossuficiente, sem ambiguidade — a Nami **ignorou completamente o conteúdo** e repetiu, palavra por palavra, a pergunta de confirmação de pausar Dipirona que já estava pendente havia 2h30.

Isso viola o princípio 1 do projeto ("a Nami nunca ignora o que o usuário disse") e tem risco real de saúde: uma dose real deixou de ser processada.

### Causa raiz confirmada em código

O state machine de `configuracao.js` tem 12 etapas. Na sessão v18 (09/07/2026, commit `479dcb11`), um modelo de 3 camadas (parser determinístico → `isCancelamentoGenuino` → `escalarParaRoteador`) foi aplicado a 9 delas. **3 etapas ficaram de fora**, por já terem uma checagem de `isCancelamento()` própria e terem sido consideradas, na época, "já resolvidas":

- **`confirm_acao`** (linha 609) — não reconhece nem confirmação nem cancelamento → repete a pergunta indefinidamente, nunca escala.
- **`reativ_confirmar`** (linha 631) — não checa confirmação nenhuma. Qualquer coisa que não seja cancelamento é tratada como "sim" implícito, e o fluxo avança sozinho.
- **`pos_alteracao`** (linha 763) — mesmo padrão: qualquer conteúdo não-cancelamento é interpretado como "quer alterar mais um horário", ignorando o que o usuário realmente escreveu.

**Confirmado que não é regressão do MH-065:** o commit do MH-065 (`e7134c88`, 31/07) não tocou `configuracao.js`. Comparado ao estado do arquivo logo após o commit `479dcb11` (v18, 09/07), essas 3 etapas são byte a byte idênticas — o gap existe desde então. Há inclusive precedente de antes da v18 (23/06/2026, `agent_logs`): mensagens como `"Sim, tomei"` e `"Tomei"` chegando em `confirm_acao` produziram exatamente o mesmo sintoma (repetição/erro genérico), confirmando que o defeito nunca foi corrigido, só nunca mais tinha sido exercitado nesse padrão específico em produção.

### Responsabilidade de destino (confirmado)

Quando qualquer uma dessas 3 etapas escalar corretamente, o caminho já existente (`router.js` → `despacharEscalada` → `classificarIntencaoComContexto`) decide o destino. Para conteúdo de dose (como "Tomei o ômega 3"), o dono legítimo da confirmação retroativa já é o `principal.js` (via `getDosesRetroativas`, janela de 2 dias) — esse mecanismo já existe e não precisa de nada novo. O que falta é só o encanamento até ele.

---

## 2. Escopo da correção

Aplicar o mesmo padrão das outras 9 etapas às 3 que ficaram de fora. `isCancelamentoGenuino` e `medicationsAtivos` já estão no escopo da função (usados nas outras etapas) — não é necessário importar nada novo.

### 2.1 — Etapa `confirm_acao` (linha 609)

**Substituir o bloco:**

```js
if (isCancelamento(message)) {
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
}
if (!isConfirmacao(message)) {
    return buildConfirmacaoMessage(firstName, context)
        + '\n\n_(Responda *SIM* para confirmar ou *NÃO* para cancelar)_';
}
return await executarAcao(user, firstName, context);
```

**Por:**

```js
if (isCancelamento(message)) {
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
}
if (!isConfirmacao(message)) {
    if (isCancelamentoGenuino(message, medicationsAtivos)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    return { escalarParaRoteador: true };
}
return await executarAcao(user, firstName, context);
```

(O bloco de `negacaoPresente && horarioCorrecao` logo acima, no início da etapa, não muda.)

### 2.2 — Etapa `reativ_confirmar` (linha 631)

**Substituir o bloco inteiro da etapa:**

```js
if (etapa === 'reativ_confirmar') {
    if (isCancelamento(message) || /\b(não|nao|n)\b/i.test(message.toLowerCase())) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
    }

    await saveConversationState(user.id, {
        state: 'configurando',
        context: { ...context, etapa: 'reativ_tipo_tratamento' }
    });
    return `Ótimo! Vamos atualizar as informações antes de reativar.\n\nO *${context.medicationNome}* é de uso contínuo (sem previsão de parada) ou tem prazo determinado, como um antibiótico ou anti-inflamatório?`;
}
```

**Por:**

```js
if (etapa === 'reativ_confirmar') {
    if (isCancelamento(message) || /\b(não|nao|n)\b/i.test(message.toLowerCase())) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
    }

    if (!isConfirmacao(message)) {
        if (isCancelamentoGenuino(message, medicationsAtivos)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
        }
        return { escalarParaRoteador: true };
    }

    await saveConversationState(user.id, {
        state: 'configurando',
        context: { ...context, etapa: 'reativ_tipo_tratamento' }
    });
    return `Ótimo! Vamos atualizar as informações antes de reativar.\n\nO *${context.medicationNome}* é de uso contínuo (sem previsão de parada) ou tem prazo determinado, como um antibiótico ou anti-inflamatório?`;
}
```

### 2.3 — Etapa `pos_alteracao` (linha 763)

**Substituir:**

```js
if (etapa === 'pos_alteracao') {
    if (isCancelamento(message) || /\b(não|nao|n|chega|pronto|ok|tudo bem)\b/i.test(message.toLowerCase())) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
    }

    const schedulesRestantes = context.schedulesAtivos || [];
    ...
```

**Por:**

```js
if (etapa === 'pos_alteracao') {
    if (isCancelamento(message) || /\b(não|nao|n|chega|pronto|ok|tudo bem)\b/i.test(message.toLowerCase())) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
    }

    if (!isConfirmacao(message)) {
        if (isCancelamentoGenuino(message, medicationsAtivos)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
        }
        return { escalarParaRoteador: true };
    }

    const schedulesRestantes = context.schedulesAtivos || [];
    ...
```

**⚠️ Nota de comportamento a observar na validação:** antes, qualquer mensagem não reconhecida como cancelamento avançava direto para "qual horário quer alterar?" — mesmo uma resposta direta como "20:00" (sem "sim" antes) já funcionava, porque a etapa seguinte (`identif_schedule`) trata o valor. Com a correção, uma resposta direta com o horário (sem "sim"/"isso"/"ok" antes) agora escala ao roteador em vez de avançar direto. Isso é seguro — o classificador central deve reconhecer a intenção de configuração e devolver para `configuracao` com o contexto preservado — mas é uma mudança de comportamento a confirmar no teste 9 abaixo. Se o roundtrip extra pelo classificador se mostrar ruim na prática, é possível reintroduzir um reconhecimento direto de horário aqui — mas não fazer isso preventivamente sem dado real.

**Não alterar nada mais no arquivo** — as outras 9 etapas já seguem o padrão correto e não precisam de mudança.

---

## 3. Verificação antes de considerar concluído

```bash
node --check src/agentes/configuracao.js
```

Depois, `git add`, commit (`fix: escalada ausente em confirm_acao, reativ_confirmar e pos_alteracao (BUG-082)`), push.

---

## 4. Registro no backlog

Usar `registrarItemBacklog` (`src/backlog.js`), nunca SQL direto:

- **BUG-082** (novo — número confirmado como próximo livre em `backlog_items`)
  - Título: "Escalada ausente em confirm_acao, reativ_confirmar e pos_alteracao — conteúdo real do usuário é ignorado/mal-interpretado"
  - Status inicial: `em_validacao` (aguardando os testes da seção 5, em produção)
  - Prioridade: alta
  - `causa_raiz`: preencher com o resumo da seção 1 deste briefing

---

## 5. Casos de teste — rodar direto no WhatsApp

Para cada caso, o que **falha hoje** (antes da correção) e o que **deve acontecer depois**. Depois de cada teste, conferir em `agent_logs` que o campo `agent` mostra o destino correto (não `configuracao` repetindo a mesma resposta).

### `confirm_acao`

**1 — Escalada com conteúdo real (o caso crítico original)**
- Envie: `Pausar [qualquer remédio]`
- Nami pergunta confirmação → **não responda ainda**
- Envie algo completamente não relacionado e autossuficiente: `Tomei o [outro remédio]`
- **Esperado:** a Nami reage ao conteúdo real (idealmente confirma a dose via `principal`), não repete a pergunta de pausar.

**2 — Não-regressão: cancelamento genuíno continua funcionando**
- Envie: `Encerrar [remédio]` → Nami pergunta confirmação → responda `Não`
- **Esperado:** "Tudo bem! Nada foi alterado" — igual a hoje.

**3 — Não-regressão: confirmação normal continua funcionando**
- Envie: `Pausar [remédio]` → confirmação pendente → responda `Sim`
- **Esperado:** ação executada normalmente — igual a hoje.

### `reativ_confirmar`

**4 — Escalada com conteúdo real**
- Cadastre um remédio que já existe e está **pausado** (todos os horários inativos) — a Nami deve perguntar se quer reativar em vez de cadastrar do zero
- Nessa pergunta, envie algo não relacionado: `Tomei o [outro remédio]`
- **Esperado:** reage ao conteúdo, não repete a pergunta de reativação.

**5 — Não-regressão: "Não" cancela**
- Mesmo cenário acima → responda `Não`
- **Esperado:** "Tudo bem! Se precisar de algo, é só me chamar" — igual a hoje.

**6 — Não-regressão: "Sim" avança**
- Mesmo cenário → responda `Sim`
- **Esperado:** pergunta sobre tipo de tratamento (contínuo/temporário) — igual a hoje.

### `pos_alteracao`

**7 — Escalada com conteúdo real**
- Altere o horário de um remédio que tenha **2 ou mais lembretes ativos** (ex: "Alterar horário do Dipirona" → escolher um horário → confirmar)
- Nami pergunta "Quer alterar algum [dos horários restantes]?"
- Envie algo não relacionado: `Tomei o [outro remédio]`
- **Esperado:** reage ao conteúdo, não repete/insiste na pergunta de horário.

**8 — Não-regressão: recusa encerra o fluxo**
- Mesmo cenário → responda `Não, era só esse mesmo`
- **Esperado:** "Tudo certo!" — igual a hoje.

**9 — Comportamento a observar: resposta direta com horário, sem "sim" antes**
- Mesmo cenário do teste 7 → em vez de "sim", responda direto com um dos horários restantes (ex: `20:00`)
- **Esperado (novo, verificar se aceitável):** pode escalar ao roteador em vez de avançar direto — o roteador deve reconhecer a intenção de configuração e devolver corretamente com o horário já reconhecido. Se o resultado final for correto mas com uma resposta intermediária estranha, registrar como achado para ajuste fino, não como falha bloqueante.

---

## 6. Fora de escopo (não mexer nesta correção)

- `despacharEscalada` continua com `currentState: 'configurando'` fixo (bug conhecido, registrado desde a v26, BUG-069 documenta parte disso). Como esta correção vai fazer esse caminho ser exercitado com mais frequência, **monitorar** se esse problema aparece mais — não corrigir preventivamente aqui.
- Nenhuma mudança em `router.js`, `database.js` ou qualquer outro arquivo.