# BRIEFING — BUG-060
## `identif_medicamento` ignora mudança de intenção quando o remédio é reconhecido na mensagem

**Data:** 10/07/2026
**Origem:** Sessão de validação em produção do BUG-032/033 — descoberto ao testar o fluxo real de alteração de horário
**Escopo:** `src/nlp_helpers.js`, `src/agentes/configuracao.js`
**Complexidade:** Baixa-média — sem migração de banco, reaproveita lógica já existente e validada (BUG-032/033)

---

## 1. Contexto e evidência do bug

Em produção (10/07/2026, ~10:43-10:44), o usuário estava no fluxo de alterar horário do Neosaldina (etapa `identif_medicamento`, `context.acao = 'alterar_horario'`). Ao mudar de ideia e responder **"Quero parar o Neosaldina"**, a Nami tratou a mensagem só como confirmação de qual medicamento, ignorando "parar" por completo:

> "O Neosaldina tem lembretes em dois horários: 10:40, 20:00. Qual desses você quer alterar?"

**Causa raiz confirmada:** `identif_medicamento` (linha 425-440 atual) só executa `encontrarMedicamento(message, medicationsAtivos)`. Se encontra o remédio, segue direto com `context.acao` — a ação que já estava fixada **antes** dessa mensagem — sem nunca reavaliar se a frase atual ainda é sobre aquela ação. A prova de que o classificador de intenção funciona bem quando tem a chance: a mesma frase, mandada isolada a partir do `idle` (fora desse fluxo), foi corretamente interpretada como encerramento.

Isso não é um dead-end (BUG-032/033) — o usuário conseguiu sair mandando "quero parar" de novo, sem o nome do remédio. É uma classificação errada por excesso de confiança na ação já fixada no contexto.

---

## 2. Solução — reaproveitar o classificador de `identif_intencao`, não duplicar

### 2.1 — `src/nlp_helpers.js`: exportar `normalizar()`

Sem nenhuma mudança no corpo da função — só passa a ser reaproveitável fora do arquivo.

```js
// ANTES
function normalizar(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

// DEPOIS
export function normalizar(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}
```

### 2.2 — `src/agentes/configuracao.js`: import atualizado

```js
// ANTES
import { isCancelamento, encontrarMedicamento } from '../nlp_helpers.js';

// DEPOIS
import { isCancelamento, encontrarMedicamento, normalizar } from '../nlp_helpers.js';
```

### 2.3 — Nova função: detecta se sobrou conteúdo além do nome do remédio

`normalizar()` resolve *igualdade/substring* (o que `encontrarMedicamento` precisa) — não resolve *"sobrou algo com significado"* (o que esta correção precisa, já que pontuação sozinha, tipo um "!" residual, não pode contar como intenção nova). Por isso a função nova reaproveita `normalizar()` para a parte que é genuinamente igual (acentuação) e soma, isolado e explícito, só o passo que falta (pontuação):

```js
// NOVO — adicionar próximo às outras funções auxiliares do arquivo
function sobrouConteudoAlemDoNome(message, medNome) {
    const semPontuacao = (s) => s.replace(/[^\w\s]/g, '').trim();
    const restante = semPontuacao(normalizar(message))
        .replace(semPontuacao(normalizar(medNome)), '')
        .replace(/\s+/g, ' ')
        .trim();
    return restante.length > 0;
}
```

### 2.4 — Extrair o corpo de `identif_intencao` para uma função reaproveitável

Esta é a peça central da correção: em vez de escrever uma segunda lógica de classificação dentro de `identif_medicamento` (o que reintroduziria o mesmo tipo de buraco que o BUG-032/033 corrigiu), a etapa `identif_intencao` e a etapa `identif_medicamento` passam a chamar a **mesma função**, que já sabe escalar corretamente pro roteador quando necessário.

```js
// ANTES
if (etapa === 'identif_intencao') {
    if (context.medicationId && isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos, historicoConversa);

    if (medicationsAtivos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
    }

    if (acao === 'nao_suportado') {
        return { escalarParaRoteador: true };
    }

    if (acao === 'esclarecer_pausar_encerrar') {
        const med = medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null;
        const nomeExibir = med?.nome || medicamentoMencionado || 'esse medicamento';
        await saveConversationState(user.id, {
            state: 'configurando',
            context: {
                etapa: 'identif_intencao',
                medicationId: med?.id || null,
                medicationNome: nomeExibir,
                schedulesAtivos: med ? (med.schedules || []).filter(s => s.ativo) : []
            }
        });
        return `Entendido, ${firstName}! Sobre o *${nomeExibir}*, você quer:\n\n• *Pausar* os lembretes (temporário — pode retomar depois)\n• *Encerrar* o tratamento definitivamente\n\nO que prefere?`;
    }

    const medDoContexto = context.medicationId
        ? medicationsAtivos.find(m => m.id === context.medicationId)
        : null;
    const med = medDoContexto
        || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);
    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message });
}

// DEPOIS
// ── HELPER: classifica a intenção da mensagem atual (via classificarIntencao)
// e decide o próximo passo — usado pela entrada fresca em identif_intencao E
// por qualquer outra etapa que precise reconfirmar se a intenção mudou.
async function processarIntencaoOuEscalar({ user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa, context }) {
    if (context.medicationId && isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos, historicoConversa);

    if (medicationsAtivos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
    }

    if (acao === 'nao_suportado') {
        return { escalarParaRoteador: true };
    }

    if (acao === 'esclarecer_pausar_encerrar') {
        const med = medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : (context.medicationId ? medicationsAtivos.find(m => m.id === context.medicationId) : null);
        const nomeExibir = med?.nome || medicamentoMencionado || context.medicationNome || 'esse medicamento';
        await saveConversationState(user.id, {
            state: 'configurando',
            context: {
                etapa: 'identif_intencao',
                medicationId: med?.id || null,
                medicationNome: nomeExibir,
                schedulesAtivos: med ? (med.schedules || []).filter(s => s.ativo) : []
            }
        });
        return `Entendido, ${firstName}! Sobre o *${nomeExibir}*, você quer:\n\n• *Pausar* os lembretes (temporário — pode retomar depois)\n• *Encerrar* o tratamento definitivamente\n\nO que prefere?`;
    }

    const medDoContexto = context.medicationId
        ? medicationsAtivos.find(m => m.id === context.medicationId)
        : null;
    const med = medDoContexto
        || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);
    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message });
}

if (etapa === 'identif_intencao') {
    return await processarIntencaoOuEscalar({ user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa, context });
}
```

**Nota:** dentro de `processarIntencaoOuEscalar`, no branch `esclarecer_pausar_encerrar`, adicionei um fallback a mais (`context.medicationId ? medicationsAtivos.find(...) : null`) e `context.medicationNome` como último recurso pro nome a exibir — isso cobre o caso de a função ser chamada a partir de `identif_medicamento`, onde o medicamento já é conhecido de outra forma (por `encontrarMedicamento(message, ...)`, não por `medicamentoMencionado` vindo do classificador). Sem isso, se o classificador não confirmar o nome mencionado na mesma frase, a mensagem "Entendido! Sobre o *esse medicamento*..." perderia o nome à toa, mesmo já sabendo qual é.

### 2.5 — `identif_medicamento`: verifica se sobrou intenção nova antes de seguir com a ação antiga

```js
// ANTES
if (etapa === 'identif_medicamento') {
    const med = encontrarMedicamento(message, medicationsAtivos);
    const listaParaMostrar = context.acao === 'reativar' ? medicamentosPausados : medicamentosComSchedule;

    if (!med) {
        if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        return { escalarParaRoteador: true };
    }

    const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);
    const { acao, novoHorario } = context;
    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, schedulesAtivos });
}

// DEPOIS
if (etapa === 'identif_medicamento') {
    const med = encontrarMedicamento(message, medicationsAtivos);
    const listaParaMostrar = context.acao === 'reativar' ? medicamentosPausados : medicamentosComSchedule;

    if (!med) {
        if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        return { escalarParaRoteador: true };
    }

    const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);

    // A mensagem trouxe mais do que só o nome do remédio? Pode ser mudança de
    // intenção ("quero parar o Neosaldina" em vez de só "Neosaldina") — reaproveita
    // o mesmo classificador/escalada de identif_intencao em vez de seguir cego
    // com a ação que já estava fixada no contexto.
    if (sobrouConteudoAlemDoNome(message, med.nome)) {
        return await processarIntencaoOuEscalar({
            user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa,
            context: { etapa: 'identif_intencao', medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
        });
    }

    const { acao, novoHorario } = context;
    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, schedulesAtivos });
}
```

---

## 3. Verificação de impacto sistêmico (já checada nesta sessão, registrando a evidência)

- **`identif_intencao` com `medicationId` já preenchido é hoje alcançada por 2 caminhos existentes** (o próprio branch `esclarecer_pausar_encerrar`, e `continuarComAcao` no caso `remover_horario` com um único horário, linha ~772) — a extração para `processarIntencaoOuEscalar` não altera nenhum dos dois, porque ambos continuam apenas salvando o estado e retornando, esperando a próxima mensagem re-entrar na etapa normalmente.
- **A nova chamada a partir de `identif_medicamento` é síncrona, na mesma passada da mensagem** — diferente dos dois caminhos acima. Verificado que isso é seguro: todas as variáveis que `processarIntencaoOuEscalar` usa (`medicationsAtivos`, `medicamentosComSchedule`, `medicamentosPausados`, `historicoConversa`, `firstName`, `user`) já estão no escopo do `handleConfiguracao` no ponto de `identif_medicamento` — nenhuma precisa ser recalculada. Sem risco de recursão (a função sempre termina em resposta ou escalada, nunca chama a si mesma).
- **`medicationsAtivos.length === 0` dentro de `processarIntencaoOuEscalar` nunca dispara quando chamada por `identif_medicamento`** — se `med` foi encontrado ali, a lista não está vazia por definição. Código inofensivo nesse caminho, não um risco.
- **Efeito colateral bom, verificado:** se a mensagem que "sobra conteúdo" também bater na lista fixa de `isCancelamento()` (ex: "Neosaldina, deixa quieto"), `processarIntencaoOuEscalar` cancela direto pro `idle` — cobertura que `identif_medicamento` não tinha antes quando o remédio *era* encontrado (só tinha isso quando o remédio *não* era encontrado).

---

## 4. Ordem de execução

1. `nlp_helpers.js` — exportar `normalizar()`.
2. `configuracao.js` — atualizar import, adicionar `sobrouConteudoAlemDoNome()`.
3. `configuracao.js` — extrair `processarIntencaoOuEscalar()`, atualizar `identif_intencao` para chamá-la.
4. `configuracao.js` — atualizar `identif_medicamento` para checar `sobrouConteudoAlemDoNome()` e chamar `processarIntencaoOuEscalar()` quando verdadeiro.
5. Deploy.
6. Validar (seção 5).

---

## 5. Validação pós-deploy

**Cenário 1 — reprodução exata do bug original:**
Estado `configurando`, `identif_medicamento`, `context.acao = 'alterar_horario'`, lista mostrando Neosaldina entre outros. Enviar "Quero parar o Neosaldina". Esperado: reconhece o remédio, detecta que sobrou "quero parar", reclassifica via `processarIntencaoOuEscalar`, resolve `acao: 'encerrar'` (ou pede pausar/encerrar se ambíguo), pergunta de confirmação de encerramento — **não** deve perguntar qual horário alterar.

**Cenário 2 — caso comum, sem regressão:**
Mesmo estado. Enviar só "Neosaldina" (sem texto extra). Esperado: `sobrouConteudoAlemDoNome` retorna `false`, segue direto com `continuarComAcao` usando `context.acao` original — comportamento idêntico ao de antes da correção, sem chamada de IA extra.

**Cenário 3 — pontuação não deve disparar reclassificação à toa:**
Mesmo estado. Enviar "Neosaldina!" ou "neosaldina." Esperado: `sobrouConteudoAlemDoNome` retorna `false` (pontuação removida antes da comparação) — mesmo comportamento do cenário 2.

**Cenário 4 — cancelamento reconhecido quando o remédio também é mencionado:**
Mesmo estado. Enviar "Neosaldina, deixa quieto". Esperado: reconhece o remédio, detecta sobra, `processarIntencaoOuEscalar` identifica `isCancelamento` primeiro e sai direto pro `idle` — sem chamar `classificarIntencao`.

**Cenário 5 — escalada continua funcionando quando chamada a partir de `identif_medicamento`:**
Mesmo estado. Enviar "Neosaldina, quero saber o estoque". Esperado: reconhece o remédio, detecta sobra, `processarIntencaoOuEscalar` classifica como `nao_suportado` (internamente), retorna `{ escalarParaRoteador: true }`, o roteador escala e chega em `relatorios` com o estoque do Neosaldina.