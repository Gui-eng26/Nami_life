# Briefing de execução — v47 Ajuste: regra do referente, fala da direcionada e fim da cobrança pós-"último aviso" (BUG-117)

Branch: `staging`, em cima do estado atual (Ondas 0–3 aplicadas). Fluxo padrão. `CONTEXT.md` não é tocado nesta execução.

**Restrição rígida de custo: o Claude Code não executa NENHUMA validação que dependa de chamada de LLM.** Nem arnês, nem turnos simulados, nem webhook de teste que chegue ao principal. Tudo que envolve comportamento do LLM é validado manualmente pelo Guilherme no staging.

**Decisões do Guilherme (05/10) que este briefing implementa:** (1) pacote do caso Quero aprovado na forma reformulada — SEM pares semânticos; (2) remoção da cobrança encerrada; (3) contenção da re-cobrança espontânea do principal; (4) BUG-117 registrado (ver backlog para o caso completo e as 3 camadas de causa).

**Veto explícito (norte item 4), válido para cada linha deste briefing:** nenhuma solução pode virar lista de palavras, par semântico ("Quero"↔convite) ou condição por frase ("resposta curta"). O código afirma fatos e ordem; o LLM interpreta linguagem, livre, dentro das capacidades.

## §0 — O caso, em uma linha

"Quero" respondendo (com e sem citação) à oferta de cadastro enviada pela mensagem direcionada foi consumido como confirmação da dose pendente — inclusive re-confirmando uma dose desfeita 3 minutos antes. Reprodução completa e causas no BUG-117.

## §1 — C1: a mensagem direcionada vira FALA na conversa

Quando existir evento `mensagem_direcionada` posterior ao último turno da pessoa, o contexto do principal a apresenta **como fala da Nami na CONVERSA RECENTE**, com **texto integral** (de `funil_envios.texto`), e com a ordem afirmada por código, estendendo o mecanismo `maisRecente` de `montarPendencia`: *"a fala mais recente da Nami é esta mensagem individual (HH:MM) — a pessoa está respondendo a uma conversa em que esta foi a última coisa dita"*. Escopo: a direcionada mais recente, janela desde o último turno (controle de peso de contexto). O código diz a ordem dos fatos; o modelo não estima tempo.

## §2 — Regra única do referente (contrato do principal)

Regra nova, **acima** do quadro "QUAL DOSE", escrita pela motivação:

> Responder a uma fala da Nami — citando-a, ou logo após ela — é responder ÀQUELA fala. Interprete a mensagem da pessoa à luz do que foi dito a ela e aja dentro das capacidades: responda, delegue (ex.: cadastro), registre dose quando for disso, contorne com honestidade o que estiver fora. Se a fala referida não é sobre dose, a resposta não é confirmação de dose.

A regra existente de QUAL DOSE continua valendo quando o referente **é** dose (a precedência da Onda 0 não muda para esse caso). Proibido materializar a regra como pares, listas ou condições de tamanho de mensagem (veto acima). A redação final do trecho de prompt vai na íntegra no relatório para revisão do Guilherme.

## §3 — Assunto da citação afirmado por código

O bloco da citação passa a afirmar o assunto como dado lido da tabela de assuntos (Onda 0) — nunca inferido do texto:

- Envio com dose: como hoje — `Mensagem citada: … → grupo Dn`.
- Envio **sem** dose: `Mensagem citada: mensagem individual/oferta (HH:MM) — SEM dose associada — texto integral: "…"`.

## §4 — Honestidade sobre conteúdo além da mensagem (redimensionada)

Uma linha no contrato: *se a pessoa perguntar além do que a mensagem da Nami disse, reafirme o que foi dito e seja honesta sobre o resto ("te conto mais em breve"), sem nunca contradizer a própria mensagem.* Nada além disso — decisão de 05/10: o caso "modo coruja" foi deliberadamente artificial; as direcionadas reais são autocontidas (regra de produto, fora do código).

## §5 — C3 (higiene)

Corte do `resumo` do evento proativo: 120 → 200 caracteres. Sem expectativa de que isso corrija nada sozinho (com §1, a direcionada chega integral como fala; o resumo serve a logs e listas).

## §6 — Observabilidade do contexto

`contexto_conversa` do turno passa a registrar: ids/tipos dos eventos proativos incluídos no prompt e se havia fala-direcionada do §1. Mesmo espírito do campo `composicao` da Onda 1 — perguntas de causalidade se respondem por consulta, não por experimento.

## §7 — Remoção da cobrança encerrada

No ramo pós-esgotamento do follow-up (`agentes/lembrete.js`): **remover o envio** da cobrança encerrada, **mantendo intactos** `markAsNaoInformado` e `notificarCuidadores` (vêm antes e independem). Racional decidido: "último aviso" é último — nenhuma 4ª mensagem depois dele; o silêncio é tratado pelo MH-104; a perda teórica (estoque baixo não-zerado de quem nunca confirma) foi aceita e está documentada no BUG-117.

Limpeza completa junto: fato `cobranca_encerrada` sai do catálogo; tipo de evento e rótulo de origem deixam de ser produzidos; `textoEventosProativos` para de renderizar o tipo; casos de arnês de equivalência/vínculo dela saem; entra **grep-guard "cobranca_encerrada morta por construção"** (padrão BUG-102). Dados históricos (envios/eventos já gravados) não são tocados.

## §8 — Contenção da re-cobrança do principal

Regra de contrato: **cobrar dose é papel do funil proativo (lembrete + follow-ups) — um fato, um autor.** O principal não abre cobrança de dose por iniciativa própria no meio de uma conversa; ele responde sobre doses quando a pessoa traz o assunto e registra retroativas normalmente. (Foi a re-cobrança espontânea das 20:57 que criou a pergunta concorrente do caso Quero.)

## §9 — Arnês (tudo sem LLM)

1. Guard de construção §1: existindo evento direcionada posterior ao último turno, o contexto montado contém a fala com texto integral.
2. Guard §7: `cobranca_encerrada` morta por construção (nenhum produtor vivo em src/).
3. Guard §3: citação resolvida sem dose gera a linha "SEM dose associada" com texto integral (função de montagem é pura — testável com fixtures).
4. Portão acumulado das Ondas 0–3 continua verde (menos os casos removidos no §7).
5. O comportamento das regras §2/§4/§8 é LLM → fora do portão, validação manual do Guilherme.

## §10 — O que esta execução NÃO faz

- Não roda nenhuma validação com custo de LLM.
- Não altera a precedência de citação para envios COM dose (QUAL DOSE permanece).
- Não toca compositor, proativas restantes, catálogo além do §7, nem jornada.
- Não dispara nenhuma mensagem do resgate.

## §11 — Relatório final

(1) Checks do portão; (2) **diffs de prompt na íntegra** (§2, §4, §8) para revisão do Guilherme; (3) arquivos tocados; (4) lista de validação manual do Guilherme no staging: reproduzir a sequência do caso Quero — oferta pelo script, responder "Quero" sem citar e citando (as duas devem engajar o cadastro, nunca dose); perguntar algo além do conteúdo da direcionada (honestidade sem contradição); deixar uma dose esgotar as 3 tentativas e confirmar que NADA chega depois do "último aviso"; e os 3 cenários da Onda 1 ainda pendentes (retroativa, turno misto, estoque+pergunta).