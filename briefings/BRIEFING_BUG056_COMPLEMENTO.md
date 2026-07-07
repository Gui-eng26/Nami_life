# BRIEFING — BUG-056 (COMPLEMENTO)
## `aguardando_escolha_tratamento` decide por nome antes de confirmar o assunto — corrige com o classificador central

**Data:** 07/07/2026
**Origem:** Validação em produção do `BRIEFING_BUG056.md` já implementado. Dois casos reais
confirmados via `agent_logs`:
1. "Qual estoque do Neosaldina?" (esperado: relatório de estoque) → devolveu detalhe de progresso
   do Neosaldina.
2. "Vou encerrar o cataflam" (esperado: ação de configuração, encerrar tratamento) → devolveu
   detalhe de progresso do Cataflam.
**Prioridade:** Alta — o segundo caso é uma ação real do usuário sendo ignorada (mesma gravidade
do BUG-057 com confirmação de dose), não só um relatório errado.

---

## 1. Causa raiz confirmada

`reconheceEscolhaTratamento(userId, message)` (ver `BRIEFING_BUG056.md`, seção 3) decide "é escolha
de tratamento" só checando se **algum nome de medicamento elegível aparece na mensagem** — nunca
confirma se o assunto da mensagem é realmente progresso. Qualquer mensagem que mencione o nome de
um dos tratamentos pendentes (mesmo pedindo estoque, ou uma ação de configuração) bate como
"escolha reconhecida" e nunca chega a consultar o classificador central.

Isso é a mesma classe de fragilidade já corrigida no BUG-036/055/057: checagem determinística
demais, sem confirmação semântica.

## 2. Correção — mesmo padrão já validado no BUG-057, sem lista de exclusão

Descartada a alternativa de lista de palavras-chave de exclusão ("estoque", "encerrar", etc.) —
não escala, sempre um passo atrás da próxima frase que escapa. A correção: o classificador central
(`classificarIntencaoComContexto`) passa a ser consultado **antes** de qualquer tentativa de casar
nome — o nome só é usado depois de confirmar que o assunto é mesmo `progresso_tratamento`.

### Antes (implementado no BUG-056, com o bug)

```js
} else if (await reconheceEscolhaTratamento(user.id, message)) {
    // nome bateu → assume progresso_tratamento, sem checar o assunto
    response = await handleRelatorios({ user, message, subtipo: 'progresso_tratamento', state });
} else {
    // só cai aqui se NENHUM nome bateu
    const { agente, subtipoRelatorio } = await classificarIntencaoComContexto({ ... });
    ...
}
```

### Depois (corrigido)

```js
} else if (currentState === 'aguardando_escolha_tratamento') {

    if (detectarConfirmacaoDose(message) && await temDosePendente(user.id)) {
        // sem mudança — precedência de dose, já correto
    }
    else if (isCancelamento(message)) {
        // sem mudança — desistência, já correto
    }
    else {
        // SEMPRE consulta o classificador central primeiro — nome só é usado
        // depois de confirmar que o assunto é progresso_tratamento
        const { agente, subtipoRelatorio } = await classificarIntencaoComContexto({
            message, currentState, historicoConversa
        });

        if (agente === 'relatorios' && subtipoRelatorio === 'progresso_tratamento') {
            // Ainda é sobre progresso — agora sim tenta casar nome dentro da mensagem
            response = await handleRelatorios({ user, message, subtipo: 'progresso_tratamento', state });
        } else {
            // É outra coisa (configuracao, estoque, etc.) — sai do estado e roteia certo
            await saveConversationState(user.id, { state: 'idle', context: {} });
            response = /* roteia pro agente/subtipo certo, mesmo padrão do BUG-057 */;
        }
    }
}
```

`reconheceEscolhaTratamento` deixa de ser usada no `router.js` como decisão de entrada — a lógica
de casar nome continua existindo (dentro de `relatorioProgressoTratamento`, que já faz isso), só
não decide mais sozinha se deve ou não entrar nesse caminho.

**Trade-off aceito:** toda mensagem em `aguardando_escolha_tratamento` (exceto dose/cancelamento)
agora sempre consulta o classificador central, uma chamada de LLM a mais nesse fluxo específico —
troca aceitável por eliminar a classe inteira de falso-positivo por nome, sem lista de exclusão
para manter.

## 3. Ordem de execução

1. Ajustar o branch `aguardando_escolha_tratamento` em `router.js` conforme seção 2.
2. `reconheceEscolhaTratamento` pode ser removida ou mantida como helper interno não usado pelo
   router (avaliar no momento da implementação se ainda faz sentido em outro lugar).
3. Deploy.

## 4. Validação pós-deploy

Reproduzir os dois casos reais do log:
1. "Como estou no meu tratamento?" (genérico, 2+ tratamentos) → resumo compacto,
   `aguardando_escolha_tratamento`.
2. "Qual estoque do Neosaldina?" → **esperado agora:** relatório de estoque de verdade, sai do
   estado.
3. Repetir o resumo compacto, depois "Vou encerrar o [medicamento]" → **esperado agora:** roteia
   pra `configuracao`, inicia o fluxo de encerramento, sai do estado.
4. Repetir o resumo compacto, depois responder só com um nome (ex: "Cataflam") → continua
   mostrando o detalhe de progresso daquele, sem regressão.
5. Repetir o resumo compacto, depois confirmar uma dose pendente real → dose confirmada
   normalmente, sem mudança (já validado antes, só confirmar que não quebrou).