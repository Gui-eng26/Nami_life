# BRIEFING — Correções pós-validação MH-053 (BUG-67 + ajuste de prompt)

**Sessão v22 (continuação) — 27/07/2026**

Dois achados durante os testes de validação do MH-053 no WhatsApp. Este briefing cobre a correção
de ambos e o registro de um item de melhoria para sessão futura.

---

## BUG-67 (URGENTE) — JSON malformado vaza cru para o usuário no fluxo de estoque

### Causa raiz confirmada (evidência: print de produção + código lido no GitHub)

Em `src/agentes/principal.js`, `callClaude()` tenta `JSON.parse(rawText)` e, se falhar, um regex
de fallback. Quando os dois falham, uma terceira rede de segurança decide se expõe o `rawText` cru
com base **só no tamanho**:

```js
return {
    message: rawText.length > 10 && rawText.length < 500
        ? rawText
        : 'Desculpe, não entendi bem. Pode repetir? 🌿',
    ...
};
```

No cenário observado (fluxo `UPDATE_STOCK` sem quantidade informada), o Claude gerou um JSON cujo
campo `message` continha exemplos entre aspas retas não escapadas (`"Comprei mais 30"`, `"Tenho 20
no total"`, `"Perdi 5"`), quebrando a sintaxe JSON. `JSON.parse` e o regex de fallback falharam pelo
mesmo motivo. O texto resultante tinha 417 caracteres — dentro da faixa 10–500 — então a rede de
segurança expôs o JSON inteiro (chaves, `newState`, `context`, `actions`) como mensagem do WhatsApp.

Confirmado que o problema é **isolado em `principal.js`**: `cadastro.js` tem o mesmo padrão de
`JSON.parse` + regex, mas seu fallback final NUNCA expõe `rawText` — sempre retorna um
"Desculpe, tive um probleminha" genérico. `principal.js` é o único agente com essa exposição
condicional por tamanho.

### Correção — critério de FORMA, não de tamanho

Um texto que começa com `{` é uma tentativa de JSON (bem ou mal formada) e nunca deve ser exposto
cru ao usuário, independente do tamanho. Só um texto que genuinamente não parece JSON (resposta
solta real do Claude) deve manter o comportamento atual de ser mostrado.

**Arquivo:** `src/agentes/principal.js` — dentro de `callClaude()`, no catch final:

```js
console.error('❌ Claude não retornou JSON válido:', rawText);

const pareceJson = rawText.trim().startsWith('{');
return {
    message: (!pareceJson && rawText.length > 10 && rawText.length < 500)
        ? rawText
        : 'Desculpe, não entendi bem. Pode repetir? 🌿',
    newState: 'idle',
    context: {},
    action: null
};
```

Mudança mínima e cirúrgica — apenas a linha do `message` ganha a checagem `pareceJson`. Nenhuma
outra lógica do arquivo é tocada.

### Validação sugerida

Reproduzir o cenário original: `UPDATE_STOCK` sem quantidade informada, pedindo o estoque de um
medicamento com um nome que induza o Claude a listar exemplos entre aspas (ex.: repetir a mesma
mensagem "Quero alterar o estoque do omega 3" algumas vezes até reproduzir — não é 100%
determinístico, pois depende de o Claude gerar aspas não escapadas). Se não reproduzir
naturalmente, validar ao menos que o comportamento não regrediu nos fluxos normais de estoque
(consulta, recompra, correção) — que devem continuar funcionando exatamente como antes.

---

## Ajuste de prompt (Opção A) — principal não deve fazer pergunta sim/não sobre ação de outro agente

### Causa raiz confirmada

A resposta ao "Quero" (teste do usuário) foi idêntica ao template de cancelamento de
`configuracao.js` (`"Tudo bem, ${firstName}! Nada foi alterado..."`), disparado quando o
classificador **local** de `configuracao.js` (`classificarIntencao`, distinto do classificador
central) recebeu a mensagem isolada "Quero" — sem objeto explícito e sem nenhum estado
estruturado indicando a que oferta o usuário estava respondendo — e a classificou como
`recusa_opcoes_oferecidas`.

O roteamento até `configuracao.js` estava correto. O problema de fundo: quando o `principal`
responde a uma crítica/feedback oferecendo "pausar lembretes" ou "ajustar horários" como pergunta
sim/não, `newState` continua `idle` e `context` continua `{}` (correto — o principal só pode
retornar `idle`/`confirming`). A única pista que sobra pro próximo turno é o texto solto no
histórico, insuficiente para uma resposta ambígua de uma palavra só.

**Decisão registrada com Guilherme:** aplicar agora a correção de menor impacto (Opção A — ajuste
de prompt, sem tocar em roteamento/estado). A correção estrutural (Opção B — dar ao sistema um jeito
de rastrear a pergunta pendente do principal como estado) fica registrada como melhoria futura
(MH-57, ver abaixo) — maior complexidade, decisão de arquitetura para sessão dedicada.

### Correção — nova regra no prompt do principal

**Arquivo:** `src/prompts.js` — inserir logo APÓS o bloco "REGRA ABSOLUTA — CADASTRO DE
MEDICAMENTOS" (mesmo padrão de regra já usado ali: informar o que fazer, nunca conduzir a ação de
outro agente):

```
REGRA ABSOLUTA — NUNCA OFEREÇA AÇÃO DE OUTRO AGENTE COMO PERGUNTA SIM/NÃO:
Pausar lembretes, ajustar horários, encerrar tratamento, cadastrar medicamento e excluir conta são
ações que pertencem a OUTROS agentes — você NÃO as executa e NÃO tem como interpretar uma resposta
curta ("quero", "sim", "pode", "faz isso") a uma pergunta sobre elas, porque o sistema não guarda
esse contexto entre uma mensagem e outra.
Se for relevante mencionar essas opções (ex: respondendo a uma crítica sobre a frequência de
confirmações), NUNCA pergunte "quer que eu faça isso?". Em vez disso, diga explicitamente a frase
que o usuário pode enviar para acionar aquilo, por exemplo:
"Se quiser, você pode me pedir para 'pausar os lembretes do [medicamento]' ou 'mudar os horários' —
é só me dizer assim que eu já entendo!"
Isso vale para qualquer sugestão de ação fora do que você mesma executa diretamente (UPDATE_STOCK,
CONFIRM_DOSE, CONFIRM_RETROATIVA, REVERSE_CONFIRMATION, REGISTER_NAO_TOMADO, SET_USER_NAME).
```

### Validação sugerida

Repetir o cenário 1 do teste anterior (crítica: *"Cansei de ter que confirmar toda hora, é
cansativo!"*) e conferir que a resposta passa a sugerir a frase exata a enviar, em vez de perguntar
"quer que eu ajuste?". Em seguida, enviar exatamente a frase sugerida (ex.: "pausar os lembretes do
Ômega 3") e confirmar que o roteamento normal de configuracao.js funciona (sem depender de nenhuma
pergunta pendente do principal).

---

## Registro de backlog (responsabilidade do Claude Code — este chat é READ-ONLY)

**Atualização:**
- **BUG-67** — "JSON malformado vaza cru ao usuário no fallback de parse do principal.js
  (UPDATE_STOCK)" | causa_raiz: rede de segurança do parse expõe rawText por critério de tamanho,
  não de forma; JSON malformado do tamanho certo escapa como texto pro usuário | status: `resolvido`
  após deploy e revisão de código (não depende de reprodução determinística no WhatsApp — a
  correção fecha a classe do problema) | prioridade: `alta` | sessao_criacao: v22 |
  data_criacao: 2026-07-27

**Inserts:**
- **MH-57** — "Rastrear ofertas espontâneas do principal como estado (Opção B), para permitir
  resposta ambígua de 1 palavra a uma pergunta feita pelo próprio bot" | descricao: hoje uma
  pergunta sim/não do principal (ex. "quer que eu pause os lembretes?") não gera nenhum estado
  estruturado — newState continua idle, context continua {} — então uma resposta curta e ambígua
  do usuário ("quero", "sim") não tem como ser interpretada corretamente por nenhum classificador
  downstream. Desenho provável: novo tipo de context (ex. `{ ofertaPendente: '...', medicationId }`)
  populado pelo principal quando oferece uma ação de outro agente, e uma checagem de precedência no
  router (mesmo padrão já usado para dose pendente / cancelamento) que interpreta o próximo turno à
  luz dessa oferta antes de cair no classificador central. Toca principal.js, router.js e
  possivelmente prompts.js. Maior complexidade — decisão de arquitetura para sessão dedicada. |
  status: `aberto` | prioridade: `media` | sessao_criacao: v22 | data_criacao: 2026-07-27

---

## Nota de validação (para o registro do MH-53, já fechado nesta sessão)

Os 6 cenários de teste do MH-53 foram executados no WhatsApp e conferidos direto no banco pelo
chat de planejamento: os 3 tipos de feedback, a intenção não suportada, e a coocorrência
(mensagem que gerou `system_events(intencao_nao_suportada)` **e** `feedbacks(sugestao)` no mesmo
turno, mesmo `agent_log_id`) — todos corretos. MH-53 pode ser considerado validado de ponta a
ponta; os dois achados deste briefing (BUG-67 e a causa raiz do "Quero") são efeitos colaterais
descobertos durante o teste, não falhas do próprio MH-53.