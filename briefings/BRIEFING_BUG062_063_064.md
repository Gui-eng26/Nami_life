# BRIEFING — BUG-062, BUG-063, BUG-064 + melhoria de instrumentação
## Três bugs de interpretação de intenção no `configuracao.js`, encontrados validando o BUG-060 em produção

**Data:** 10/07/2026
**Origem:** Testes reais em produção (WhatsApp) durante a validação do BUG-060, cruzados com `agent_logs` e logs do Railway
**Escopo:** `src/nlp_helpers.js`, `src/agentes/configuracao.js`, `src/router.js` (instrumentação, opcional)
**Complexidade:** Média — sem migração de banco nos três bugs principais; a instrumentação (seção 5) exige uma coluna nova, opcional e separada

---

## Contexto

Ao validar o BUG-060 em produção, três interações revelaram problemas de interpretação de intenção que o BUG-060 não cobria — todos confirmados com evidência direta de `agent_logs` e, no caso do BUG-064, com os `console.log` do Railway (não só inferência). Nenhum deles é dead-end (o usuário sempre conseguia sair eventualmente) — são classificações erradas que fazem o fluxo se comportar de forma inconsistente com o que o usuário pediu.

---

## BUG-062 — "parar [remédio]" interpretado como cancelamento genérico, não como encerrar tratamento

**Evidência:** mensagens como "na verdade quero parar com a dipirona" (em `identif_schedule`) e "parar dipirona" (em `identif_medicamento`) foram lidas como desistência da operação ("Tudo bem! Nada foi alterado...") em vez de como intenção de encerrar o tratamento daquele remédio.

**Causa raiz:** `isCancelamento()` tem precedência cega sobre qualquer outra interpretação em 8 pontos do arquivo. A palavra "parar" está no vocabulário de cancelamento (adicionada na sessão do BUG-032/033) — mas quando a mensagem também cita um medicamento específico, "parar [remédio]" quase sempre significa "encerrar tratamento", não "desista da operação atual".

**Correção — uma função nova, reaproveitada em todos os pontos:**

```js
// nova função auxiliar, perto de sobrouConteudoAlemDoNome
function isCancelamentoGenuino(message, medicationsAtivos) {
    // "Parar a dipirona" cita um remédio — isso é intenção de encerrar tratamento,
    // não desistência da operação. Só aceita como cancelamento puro quando a
    // mensagem não menciona nenhum medicamento conhecido.
    return isCancelamento(message) && !encontrarMedicamento(message, medicationsAtivos);
}
```

Trocar `isCancelamento(message)` por `isCancelamentoGenuino(message, medicationsAtivos)` nestes 8 pontos (linhas do arquivo atual, pós BUG-060):

| Linha | Etapa |
|---|---|
| 377 | `processarIntencaoOuEscalar` (pre-check com `medicationId`) |
| 498 | `identif_schedule` |
| 527 | `identif_schedule_remocao` |
| 548 | `obter_novos_horarios` |
| 565 | `obter_horario` |
| 627 | `reativ_tipo_tratamento` |
| 663 | `reativ_estoque` |
| 703 | `reativ_horarios` |

**Não alterar** a linha 446 (`identif_medicamento`, dentro do `if (!med)`) — ali o guard não faz sentido, porque se o remédio não foi encontrado não há ambiguidade nenhuma pra proteger.

**Fora de escopo, registrando para investigação futura:** `confirm_acao` (587) e `reativ_confirmar` (600) também usam `isCancelamento()` sem esse guard, e teoricamente têm o mesmo risco (ex: "não, quero parar o Cataflam" nessas etapas). Não foi testado em produção ainda — não estou propondo mudança ali sem evidência.

**Validado contra os logs reais:** "Não precisa mais" e "Não vou mais alterar" (que cancelaram corretamente antes) não citam remédio nenhum → `isCancelamentoGenuino` continua retornando `true` → sem regressão.

---

## BUG-063 — medicamento do contexto preservado vence sobre remédio citado explicitamente na mensagem atual

**Evidência:** em `identif_schedule` com Cataflam ativo no contexto, a mensagem "Quero alterar dipirona" (citando Dipirona explicitamente) foi ignorada — a Nami mostrou de novo os horários do Cataflam. Confirmado de novo com Losartana/Dipirona em teste separado.

**Causa raiz:** dentro de `processarIntencaoOuEscalar`, os dois branches (`esclarecer_pausar_encerrar` e o branch final) dão prioridade ao `medicationId` já salvo no contexto — ou ao palpite do classificador (`medicamentoMencionado`, que pode vir contaminado pelo `historicoConversa`) — mas nunca checam primeiro se a **mensagem atual, como texto literal**, já cita um remédio diferente.

**Correção — checagem determinística primeiro, LLM como último recurso:**

```js
// branch esclarecer_pausar_encerrar — ANTES (linha ~391)
const med = medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : (context.medicationId ? medicationsAtivos.find(m => m.id === context.medicationId) : null);

// DEPOIS
const medNaMensagemAtual = encontrarMedicamento(message, medicationsAtivos);
const med = medNaMensagemAtual
    || (context.medicationId ? medicationsAtivos.find(m => m.id === context.medicationId) : null)
    || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);
```

```js
// branch final — ANTES (linha ~410)
const medDoContexto = context.medicationId
    ? medicationsAtivos.find(m => m.id === context.medicationId)
    : null;
const med = medDoContexto
    || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);

// DEPOIS
const medNaMensagemAtual = encontrarMedicamento(message, medicationsAtivos);
const medDoContexto = context.medicationId
    ? medicationsAtivos.find(m => m.id === context.medicationId)
    : null;
const med = medNaMensagemAtual || medDoContexto
    || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);
```

**Por que essa ordem:** `encontrarMedicamento(message, ...)` olha só o texto literal da mensagem atual — nunca o histórico, nunca inferência — é o sinal mais confiável que existe. `medicationId` do contexto vem em segundo (preserva o que já foi resolvido quando o usuário não cita nada novo). `medicamentoMencionado` do classificador interno fica por último, porque esse classificador recebe `historicoConversa` no prompt e pode refletir um remédio que já não é mais o foco da mensagem atual.

**Validado com log real do Railway** (não só inferência): no teste do Losartana/Dipirona, `classificarIntencao` devolveu `medicamentoMencionado: "Dipirona"` mesmo na mensagem "Nenhum" — porque Dipirona era genuinamente o assunto da conversa até ali (você tinha acabado de pedir a troca). Com a ordem de prioridade acima, isso nunca chega a ser usado quando não necessário: se a mensagem atual não cita remédio, cai direto pro `medicationId` do contexto (que, uma vez corrigido pelo BUG-063, já vai estar certo).

---

## BUG-064 — classificador interno não reconhece recusa de uma lista de opções oferecida

**Evidência:** em três etapas diferentes — `identif_schedule` ("Nenhum" em resposta a "qual desses horários"), `identif_intencao`/esclarecer_pausar_encerrar ("Nada" em resposta a "pausar ou encerrar?"), e `identif_medicamento` ("Nenhum" em resposta a uma lista de 5 medicamentos pra encerrar) — a Nami repetiu a pergunta em vez de reconhecer que o usuário rejeitou todas as opções oferecidas.

**Causa raiz confirmada com log do Railway** (`[CLASSIFICADOR]` + `[ESCALADA]` explícitos, não inferência): a mensagem escala corretamente (Camada 1 e Camada 2 falham, como esperado — "nenhum"/"nada" não são horário nem estão no vocabulário de cancelamento). O classificador **central** decide corretamente "ainda é assunto de configuração" — isso não é erro dele, é uma decisão de roteamento acertada. O problema é um nível abaixo: o classificador **interno** (`classificarIntencao`) só sabe classificar entre 9 ações (pausar/reativar/encerrar/horários/etc.) — não existe categoria para "o usuário recusou a lista de opções que acabei de oferecer". Sem essa categoria, ele acaba reafirmando a ação que já estava em andamento.

**Por que não crescer o vocabulário de `isCancelamento()`:** "nenhum"/"nada" só significam recusa **no contexto de uma pergunta de múltipla escolha** — colocar isso numa lista fixa faria a palavra virar cancelamento sempre, em qualquer etapa, sem olhar a pergunta que foi feita. É o mesmo antipadrão do BUG-030/036. O modelo híbrido existe exatamente para casos como esse, onde o julgamento depende do contexto da conversa — por isso a correção é ensinar o classificador, não a lista fixa.

**Correção — nova categoria no prompt de `classificarIntencao()` (linhas 27-81 do arquivo atual):**

```js
// Schema — ANTES
"acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "remover_horario" | "adicionar_horario" | "redefinir_horarios" | "esclarecer_pausar_encerrar" | "nao_suportado"

// DEPOIS
"acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "remover_horario" | "adicionar_horario" | "redefinir_horarios" | "esclarecer_pausar_encerrar" | "recusa_opcoes_oferecidas" | "nao_suportado"
```

```
// Nova definição, junto das outras (após "esclarecer_pausar_encerrar")
- recusa_opcoes_oferecidas: USAR quando a ÚLTIMA mensagem da Nami (ver CONVERSA RECENTE) apresentou
  uma lista de opções para escolher — pode ser medicamentos, horários, ou a escolha entre pausar/
  encerrar/contínuo/temporário — e a resposta do usuário rejeita TODAS essas opções sem mencionar
  nenhum assunto novo.
  Ex: "nenhum", "nenhuma", "nenhum dos dois", "nenhuma das opções", "nenhum desses", "nem um nem outro".
```

```
// Nova regra de decisão, junto das outras 6
7. Se a última pergunta da Nami ofereceu uma lista de opções (medicamentos, horários, ou
   pausar/encerrar/contínuo/temporário) e a resposta rejeita todas sem introduzir assunto novo
   → recusa_opcoes_oferecidas. NUNCA confunda com reafirmar a ação anterior.
```

**Tratamento em `processarIntencaoOuEscalar` (perto do branch `nao_suportado`, linha ~385):**
```js
if (acao === 'nao_suportado') {
    return { escalarParaRoteador: true };
}

if (acao === 'recusa_opcoes_oferecidas') {
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
}
```

**Onde essa correção se aplica e onde não se aplica** (mapeado pra não superestimar o alcance):

| Etapa | Apresenta lista de opções fechada? | Correção se aplica? |
|---|---|---|
| `identif_medicamento` | Sim — lista de remédios | ✅ |
| `identif_schedule` / `identif_schedule_remocao` | Sim — lista de horários | ✅ |
| `identif_intencao` (esclarecer_pausar_encerrar) | Sim — pausar/encerrar | ✅ |
| `reativ_tipo_tratamento` | Sim — contínuo/temporário | ✅ |
| `obter_horario` / `obter_novos_horarios` | Não — pede valor livre, não lista | ⚠️ Não se aplica; "nenhum" aqui não tem significado óbvio de recusa, correto continuar caindo em escalada normal |
| `reativ_estoque` | Não — pede número livre | ⚠️ Mesma observação |

---

## Ordem de execução

1. `nlp_helpers.js` — nenhuma mudança nesta correção (o `isCancelamento()` já está com o vocabulário certo desde o BUG-032/033).
2. `configuracao.js` — adicionar `isCancelamentoGenuino()`, aplicar nos 8 pontos do BUG-062.
3. `configuracao.js` — aplicar a correção de prioridade de medicamento (BUG-063) nos dois branches de `processarIntencaoOuEscalar`.
4. `configuracao.js` — adicionar a categoria `recusa_opcoes_oferecidas` no prompt de `classificarIntencao()` e o tratamento correspondente (BUG-064).
5. Deploy.
6. Validar (seção abaixo).

---

## Validação pós-deploy

**BUG-062:**
- "Parar dipirona" em `identif_medicamento` (Dipirona só, sem ambiguidade de pausar/encerrar) → deve pedir esclarecimento pausar/encerrar ou encerrar diretamente, nunca "Tudo bem, nada foi alterado".
- "Na verdade quero parar com a dipirona" em `identif_schedule` (mid-alteração de horário) → mesmo resultado.
- Confirmar que "Não precisa mais" e "Não vou mais alterar" (sem citar remédio) continuam cancelando normalmente.

**BUG-063:**
- Repetir o cenário Cataflam→"quero alterar dipirona" em `identif_schedule` → deve trocar pra Dipirona, mostrando os horários certos.
- Repetir com Losartana→"na vdd quero alterar o dipirona" → mesmo resultado.

**BUG-064:**
- "Nenhum" em resposta à lista de horários (`identif_schedule`) → sai educadamente, não repete a pergunta.
- "Nada"/"Nenhum" em resposta a "pausar ou encerrar?" → mesmo resultado.
- "Nenhum" em resposta à lista de 5 medicamentos pra encerrar (`identif_medicamento`) → mesmo resultado.
- Confirmar que um horário genuíno (ex: "09:00") continua funcionando normalmente nessas mesmas etapas — a nova categoria não deve interferir no caminho de sucesso.

---

## Melhoria de instrumentação (opcional, separada — sem ela as validações acima exigem inspecionar logs do Railway)

Hoje, quando uma mensagem escala (Camada 3), isso só aparece nos `console.log` do servidor (`⚙️ [CLASSIFICADOR]`, `⚙️ [ESCALADA]`) — não fica gravado em `agent_logs`, que é a fonte consultável e permanente do projeto. Confirmar uma escalada hoje exige baixar logs do Railway e cruzar timestamps manualmente (como fizemos nesta sessão).

**Sugestão:** gravar um marcador na própria `contexto_conversa` já salva em `agent_logs`, sem precisar de coluna nova:

```js
// router.js — dentro de despacharEscalada, adicionar um campo de rastreio
// no contexto salvo (não no contexto operacional da etapa, só pra fins de log)
```

Essa parte exige desenho mais cuidadoso de onde exatamente gravar (não quero misturar dado de debug com o `context` operacional que as etapas leem) — não estou propondo o código pronto aqui, só registrando a necessidade. Se topar, trago o desenho numa sessão própria, sem misturar com os três bugs acima.