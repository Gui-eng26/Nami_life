# BRIEFING — BUG-056
## `progresso_tratamento` não filtra por medicamento mencionado + formato ruim para múltiplos tratamentos

**Data:** 07/07/2026
**Origem:** Encontrado durante validação em produção do `BRIEFING_ADESAO_AO_TRATAMENTO.md`. Ao
perguntar "Quanto falta pro Cataflam acabar?", a resposta trouxe **todos** os tratamentos
temporários ativos (Dipirona, Vitamina C, Neosaldina, Cataflam), cada um repetindo "Olá,
Guilherme!" — visualmente ruim, longe do tom da Nami.
**Não confundir com:** BUG-055 (Camada 3 do roteador) e BUG-057 (estado de período bloqueando dose)
— bugs diferentes da mesma leva de validação.
**Prioridade:** Média — não quebra dado nenhum (diferente do BUG-057), é problema de apresentação.

---

## 1. Causa raiz confirmada

`relatorioProgressoTratamento(user)` nunca recebeu a mensagem do usuário — só `user`. Por isso
não há como saber qual medicamento foi mencionado; a função sempre roda `calcularProgressoTratamento`
(retorna todos os elegíveis) e concatena um bloco completo por medicamento
(`blocos.join('\n\n')`), cada bloco com o template inteiro de `TEMPLATES_PROGRESSO`, que começa
com "Olá, [Nome]!" — daí a saudação repetida e o texto longo demais.

## 2. Solução

### 2.1 — `encontrarMedicamento` vira compartilhada

Extrair `encontrarMedicamento(texto, medications)` de `configuracao.js` para `src/nlp_helpers.js`
(mesmo padrão do `isCancelamento`, já feito no `BRIEFING_ADESAO_AO_TRATAMENTO.md`). Reusar nos dois
lugares, comportamento idêntico.

### 2.2 — `relatorioProgressoTratamento` passa a receber `message` e decidir por contagem

```js
async function relatorioProgressoTratamento({ user, message, state }) {
    const progressos = await calcularProgressoTratamento(user.id);

    if (progressos.length === 0) return montarFallbackContinuo(firstName);

    if (progressos.length === 1) {
        return montarBlocoIndividual(progressos[0]); // comportamento atual, sem mudança
    }

    // 2+ tratamentos — tenta casar nome mencionado
    const medicationsElegiveis = progressos.map(p => ({ id: p.medicationId, nome: p.nome }));
    const mencionado = encontrarMedicamento(message, medicationsElegiveis);

    if (mencionado) {
        const p = progressos.find(x => x.medicationId === mencionado.id);
        return montarBlocoIndividual(p); // mesmo template de fase + estoque, já existente
    }

    // Pedido genérico ("todos", "tudo", "meu tratamento" sem nome) — resumo compacto
    await saveConversationState(user.id, {
        state: 'aguardando_escolha_tratamento',
        context: { medicationIds: progressos.map(p => p.medicationId) }
    });
    return montarResumoCompacto(progressos); // novo template, ver seção 3
}
```

`montarBlocoIndividual` é só um nome para o que `relatorioProgressoTratamento` já fazia por item
(fase + bloco de estoque) — extrair para função nomeada, reusar nos dois casos (individual direto
e detalhe pedido depois do resumo compacto).

### 2.3 — Detecção de pedido genérico ("todos")

```js
const PEDIDO_TODOS = /\b(todos?|tudo|geral|completo)\b/i;
```

Não precisa ser exaustivo — qualquer frase que fuja disso cai no fallback semântico do novo estado
(seção 3), igual ao padrão já estabelecido no BUG-057.

## 3. Novo estado `aguardando_escolha_tratamento` — nasce com a proteção do BUG-057 embutida

Mesma estrutura de precedência que aplicamos em `aguardando_periodo_adesao`, para não repetir o
mesmo bug num estado novo:

```js
} else if (currentState === 'aguardando_escolha_tratamento') {

    // 1. Dose pendente — precedência total, zera o estado por completo (igual BUG-057)
    if (detectarConfirmacaoDose(message) && await temDosePendente(user.id)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        // segue o mesmo tratamento de confirmação já usado no branch idle
    }

    // 2. Desistência
    else if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        response = `Sem problemas, ${firstName}! Se quiser ver de novo, é só me chamar 🌿`;
    }

    // 3. "todos"/nome específico mencionado dentre os do context.medicationIds
    else if (PEDIDO_TODOS.test(message)) {
        // resposta já foi dada (resumo compacto) — trata como reforço, ou repete o resumo
        response = ...;
    }
    else if (encontrarMedicamento(message, medicationsDoContexto)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        response = montarBlocoIndividual(progressoCorrespondente); // template de fase, já existente
    }

    // 4. Nada bateu — mesmo fallback do BUG-057, sem mecanismo novo
    else {
        const { agente, subtipoRelatorio } = await classificarIntencaoComContexto({ message, currentState, historicoConversa });
        if (agente === 'relatorios' && subtipoRelatorio === 'progresso_tratamento') {
            // ainda é sobre progresso, sem nome reconhecível — repete o resumo compacto
        } else {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            response = /* roteia pro agente/subtipo certo, mesmo padrão do BUG-057 */;
        }
    }
}
```

O estado permanece aberto depois de mostrar o resumo compacto — se a próxima mensagem for só o
nome de um remédio, cai no passo 3 direto, sem precisar pedir de novo.

## 4. Novo template — resumo compacto (`adesaoTemplates.js`)

**Não substitui `TEMPLATES_PROGRESSO`** (fase início/meio/final + bloco de estoque) — esse continua
exatamente como está, usado sempre que houver só 1 tratamento ou um nome específico for
reconhecido. O resumo compacto é uma peça nova, só para o caso "2+ tratamentos, pedido genérico":

```js
export function montarResumoCompacto(nome, progressos) {
    const linhas = progressos.map(p =>
        `💊 *${p.nome}* — dia ${p.diasDecorridos} de ${p.tratamentoDias}, ${p.diasRestantes} dias restantes`
    ).join('\n');

    return `Olá, ${nome}! Aqui está o progresso dos seus tratamentos:\n\n${linhas}\n\nQuer detalhes de algum específico? É só me dizer o nome!`;
}
```

"Detalhes de algum específico" → mesmo `montarBlocoIndividual` (fase + estoque) já usado nos outros
casos — não é um terceiro formato novo.

## 5. Ordem de execução

1. Extrair `encontrarMedicamento` para `nlp_helpers.js`, exportada; ajustar import em
   `configuracao.js` (mesmo comportamento, sem mudança funcional ali).
2. Adicionar `montarResumoCompacto` em `adesaoTemplates.js`.
3. Reescrever `relatorioProgressoTratamento` conforme seção 2.2, extraindo `montarBlocoIndividual`.
4. Adicionar o branch `aguardando_escolha_tratamento` em `router.js`, seguindo a estrutura da seção 3
   (mesmo padrão de precedência já implementado no BUG-057 — reusar as mesmas checagens, não
   duplicar lógica).
5. Deploy.

## 6. Validação pós-deploy

1. Só 1 tratamento temporário ativo → "como estou no meu tratamento?" continua mostrando direto,
   sem mudança.
2. 2+ tratamentos, nome específico mencionado ("quanto falta pro Cataflam?") → mostra só o
   Cataflam, no template de fase de sempre.
3. 2+ tratamentos, pedido genérico ("como estão meus tratamentos?", "mostra tudo") → resumo
   compacto, sem saudação repetida, sem texto longo.
4. Depois do resumo compacto, responder só com um nome → mostra o detalhe daquele, no template de
   fase.
5. Depois do resumo compacto, uma dose pendente chegar (confirmação real) → dose confirmada
   normalmente, estado zerado, resumo não interfere.
6. Depois do resumo compacto, mandar algo sem relação (ex: pedir adesão) → sai do estado, roteia
   certo, sem ficar preso.