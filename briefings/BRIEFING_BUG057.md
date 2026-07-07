# BRIEFING — BUG-057
## Estado `aguardando_periodo_adesao` bloqueia confirmação de dose e qualquer outra intenção

**Data:** 07/07/2026
**Origem:** Encontrado durante validação em produção do `BRIEFING_ADESAO_AO_TRATAMENTO.md` (sessão
de hoje). Guilherme confirmou uma dose de Dipirona duas vezes ("Sim" e "Tomei o dipirona") enquanto
o estado estava travado em `aguardando_periodo_adesao` — nenhuma das duas foi registrada como
confirmação. Evidência real em `agent_logs` (prints + JSON da tabela, ver conversa).
**Não confundir com:** BUG-055 (Camada 3 do roteador de relatórios) e BUG-056 (progresso_tratamento
não filtra por medicamento mencionado) — bugs diferentes, mesma leva de validação.
**Prioridade:** Alta — quebra a função central do produto (confirmação de dose), não só o relatório
de adesão.
**Dado afetado:** a dose de Dipirona de 07/07 já foi corrigida manualmente por Guilherme — **não
precisa de correção de dado nesta implementação.**

---

## 1. Causa raiz confirmada (código real)

Em `router.js`, o branch `currentState === 'aguardando_periodo_adesao'` (linha ~444) é avaliado
**antes** da detecção de confirmação de dose (`detectarConfirmacaoDose` + `temDosePendente`, linhas
505-516), que só roda quando `currentState === 'idle'`. Resultado: uma vez que o estado é setado
(ex: usuário pediu adesão sem especificar período), **toda mensagem seguinte** — inclusive uma
confirmação de dose real, inclusive um pedido completamente diferente — é interpretada como
resposta de período, porque o roteador nunca chega a checar mais nada.

Confirmado via `agent_logs` real: em 48 minutos, o mesmo estado travado sequestrou 3 mensagens
diferentes ("Qual progresso do omega 3?", "Sim" — confirmação de dose, "Tomei o dipirona" —
confirmação de dose) — todas devolvendo a mesma pergunta/recusa de período, porque nada além do
período era considerado.

## 2. Solução (decidida em conversa, reaproveitando peças já existentes)

Nenhum mecanismo novo — só reordenar/combinar o que já existe: `detectarConfirmacaoDose`,
`temDosePendente`, `isCancelamento`, `extrairPeriodo` e `classificarIntencaoComContexto` (o
classificador central já usado pela correção do BUG-055).

```js
} else if (currentState === 'aguardando_periodo_adesao') {

    // 1. Dose pendente tem precedência TOTAL — o estado deixa de existir por completo,
    //    sem deixar a pergunta de período pendente. Se o usuário quiser o relatório
    //    depois, ele pede de novo (o fluxo serve o usuário, não o contrário).
    if (detectarConfirmacaoDose(message) && await temDosePendente(user.id)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        // segue o MESMO tratamento de confirmação de dose já usado no branch
        // idle + detectarConfirmacaoDose + temDosePendente (linhas 505-513) —
        // não duplicar lógica, reusar a função/branch existente
    }

    // 2. Desistência explícita — já existe, sem mudança
    else if (isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        response = `Sem problemas, ${firstName}! Se quiser ver sua adesão depois, é só me chamar 🌿`;
    }

    // 3. Resposta de período válida — já existe, sem mudança
    else if (extrairPeriodo(message)) {
        response = await handleRelatorios({ user, message, subtipo: 'adesao', state });
    }

    // 4. Nada bateu — usa o classificador central (já existe) pra decidir a intenção real,
    //    em vez de assumir cegamente que é sobre período
    else {
        const { agente, subtipoRelatorio } = await classificarIntencaoComContexto({
            message, currentState, historicoConversa
        });

        if (agente === 'relatorios' && subtipoRelatorio === 'adesao') {
            // Ainda é sobre adesão, só sem período reconhecível — mantém o
            // comportamento atual (recusa gentil + registrarIntencaoNaoSuportada
            // dentro de handleRelatorios/relatorioAdesao, sem mudança ali)
            response = await handleRelatorios({ user, message, subtipo: 'adesao', state });
        } else {
            // É outra coisa de verdade — sai do estado e roteia pro lugar certo
            await saveConversationState(user.id, { state: 'idle', context: {} });
            response = agente === 'relatorios'
                ? await handleRelatorios({ user, message, subtipo: subtipoRelatorio, state: { state: 'idle', context: {} } })
                : await handlePrincipal({ user, message, image, historicoConversa }); // ou cadastro/configuracao, conforme agente
        }
    }
}
```

**Importante:** o passo 1 (dose) deve rodar **antes** de qualquer chamada ao classificador LLM —
é a checagem mais barata e mais crítica, não precisa esperar uma resposta de modelo pra saber que
uma dose foi confirmada.

## 3. Ordem de execução

1. Implementar o branch acima em `router.js`, reaproveitando a lógica de confirmação de dose já
   existente no branch `idle` (não duplicar — extrair para função compartilhada se necessário).
2. Deploy.

## 4. Validação pós-deploy

Reproduzir exatamente a sequência do log real:
1. Pedir adesão sem período → estado vai para `aguardando_periodo_adesao`.
2. Sem responder o período, confirmar uma dose pendente real (ex: "Sim" ou "tomei o [remédio]").
3. **Esperado:** dose confirmada normalmente, estado zerado, sem nenhuma menção a período na
   resposta.
4. Em outro teste, no mesmo estado, mandar uma mensagem sobre outro assunto (ex: "qual progresso
   do meu tratamento?") → **esperado:** roteia pro relatório correto (`progresso_tratamento`), sai
   do estado, sem recusa de período.
5. Confirmar que pedir adesão sem período, e depois responder "15" (ou "7"/"30"), continua
   funcionando como antes (não regrediu).
6. Confirmar que "não precisa"/"deixa pra lá" continua saindo do estado normalmente (já validado
   por Guilherme em produção nesta sessão — ver print, funcionou corretamente).