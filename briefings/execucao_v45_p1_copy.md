# BRIEFING DE EXECUÇÃO — v45 · P1-copy: textos do principal como porta

**Pré-requisito:** P1 no `staging` (`22da9a0`). Este briefing fecha a pendência de copy do §12 do P1 e é **condição para a promoção** do P1.
**Branch:** `staging`. A promoção sai junto com o P1: P1 + copy → validação manual do Guilherme no staging → migração do §8 do P1 em produção → merge.
**Governança:** nenhuma escrita em `backlog_items`.
**Diretriz de custo:** casos afetados por commit; suíte completa uma vez, no portão.
**Critério de aceite de todo texto:** Constituição v1 + emendas (CONTEXT §12.2). Os textos abaixo foram revisados e aprovados pelo Guilherme em 26/09 — **não reescrever**; qualquer divergência vira pergunta antes do commit.

---

## 0. Resumo das decisões (26/09)

| # | Texto | Decisão |
|---|---|---|
| 1 | Lembrete de estoque zerado | texto novo (§1) |
| 2 | Confirmação de dose | data só quando não for hoje; abertura variável + fato fixo (§2.1); respostas ao "não" pelo principal com regras + fato por código (§2.2); **regra interna nova** (§3) |
| 3 | Confirmação parcial | texto novo (§4) |
| 4 | Pergunta quando não se sabe a dose | texto livre com regras (§5) |
| 5 | "Erro" sem dizer o quê | texto de referência (§6) |
| 6 | Convite depois do estoque contestado | template novo (§7) |
| 7 | Retomada da coleta depois da dose | **mantém** |
| 8 | Pergunta segura | **mantém** |
| 9 | "Ainda não faço" sem texto do principal | o "isso" vira o item do inventário (§8, estrutural) |
| 10 | Cadastro novo | **convite único** em todo cadastro novo (§9, estrutural) |
| 11 | Desambiguação dose × fluxo | texto livre com regras (§5) |
| 12 | Desistência da escolha no relatório | texto livre com regras (§5) |

## 1. Lembrete de estoque zerado — `scheduler.js`, `buildEstoqueZeradoMessage`

A frase "não foi possível registrar a dose" ficou falsa com o P1. Texto novo:

```
⏰ {nome}, está na hora do seu *{remédio}*!

Pelas minhas contas o estoque acabou — mas se você ainda tem e já tomou, é só responder SIM que eu registro. 💊

Se comprou mais, me conta quantos: *"Comprei 30 comprimidos de {remédio}"*
```

Atualizar o texto semeado no arnês que reproduz esse lembrete (`casos.js` ~l.2297).

## 2. Confirmação de dose — `dosesDoTurno.js`, `descreverDose` e `montarTextoPosEscrita`

**Princípio (decisão de 26/09):** o **fato** é fixo e sai do banco; a **forma** varia, para a Nami não soar robótica. Evidência: a Fran respondeu "Não" três vezes (25/09 20:21 e 21:00, 26/09 12:50) e recebeu três vezes a mesma frase, palavra por palavra — escrita pelo principal, em texto livre. Texto livre sozinho não garante variação; hipótese: o principal vê as próprias respostas no histórico e se copia.

**Regra da data:** dose de hoje leva só a hora; dose de outro dia leva rótulo, data e hora — "de hoje (06:28)", "de ontem (25/09, 06:28)", "de anteontem (24/09, 06:28)".

### 2.1 Abertura variável + linha do fato

Formato: `{abertura} ✅ *{remédio}* de {dia} ({…}) confirmada 💊`

Aberturas (lista fechada, aprovada):

1. `Boa, {nome}!`
2. `Perfeito, {nome}!`
3. `Isso aí, {nome}!`
4. `Que bom, {nome}!`
5. `Tudo certo, {nome}!`
6. `Show, {nome}!`

- O código escolhe uma abertura **diferente da usada na última confirmação daquela pessoa** (lida do último texto de confirmação em `agent_logs`; sem histórico, qualquer uma). Sem `{nome}`, a abertura perde a vírgula e o nome ("Boa!").
- Vale igual para o atalho e para o principal: nos dois caminhos o texto é montado pelo código. Nenhuma chamada nova de LLM.
- Várias doses: `{abertura} ✅ Doses confirmadas:` + uma linha `• *{remédio}* de {dia} (…)` por dose.
- Desfeita: `Desfiz a confirmação: *{remédio}* de {dia} (…). 🌿` (sem abertura variável).

Exemplos:
- "Isso aí, João! ✅ *Roacutan* de hoje (06:28) confirmada 💊"
- "Tudo certo, João! ✅ *Roacutan* de ontem (25/09, 06:28) confirmada 💊"

### 2.2 Respostas ao "não" — principal com regras + fato por código

Toda negativa passa pelo principal (o atalho só aceita confirmação positiva exata), então não há custo novo.

**Dose continua aberta** ("ainda não", ou "não tomei" dentro da janela — §3): o principal escreve a resposta inteira, com estas regras no prompt:
- acolher, sem pressão; deixar a porta aberta para avisar depois;
- uma ou duas frases; nunca tom de obrigação (regra 1);
- **nunca repetir a formulação das respostas recentes da Nami que estão no histórico**;
- referência de tom (não é texto fixo, e o cuidado final não precisa aparecer toda vez): "Tudo bem, {nome}. Se tomar mais tarde, é só me avisar 🌿 Tô aqui pra te ajudar a manter seu tratamento em dia ❣️"

**Dose fechada como não tomada** ("esqueci de tomar ontem", "pulei", "não vou tomar hoje"): o principal escreve o acolhimento com as mesmas regras, **sem** "se tomar mais tarde"; o código acrescenta a linha fixa, de leitura pós-escrita:

```
O *{remédio}* de {dia} ({…}) ficou registrado como não tomado.
```

Várias doses fechadas: uma linha por dose. Sem "Anotei" (regra 2: a dose já está gravada).

## 3. Regra interna do "não tomei" (lógica, não copy)

Hoje "não tomei" fecha a dose como `nao_tomado`, e os follow-ups param (o scheduler só cobra doses `pendente` — `getPendingFollowUps`). A regra nova, aprovada em 26/09:

- **Dose aguardando resposta** (dentro da janela de cobranças): "não", "ainda não", "daqui a pouco" **e "não tomei"** → nada é gravado; a dose continua pendente; as cobranças seguem.
- **Fecha como não tomada** só quando a pessoa diz que **não vai tomar** ("pulei", "não vou tomar hoje") ou fala de uma dose que já saiu da janela ("esqueci de tomar ontem").

Implementação: o principal ganha o fato `ainda_nao` em `doses[].fato` (sem escrita no banco), e a regra 6 do prompt passa a dizer o que está acima. Tabela status × fato: `ainda_nao` só é válido em "aguardando resposta"; em qualquer outro status vira `nao_tomou` pela regra antiga. As respostas seguem o §2.2: `ainda_nao` → texto do principal; `nao_tomou` → acolhimento do principal + linha fixa do fato.

Continua valendo: um "tomei" posterior, com ou sem lembrete, registra em qualquer situação dentro de hoje/ontem/anteontem (aberta → confirma; esgotada → retroativa; não tomada → correção).

## 4. Confirmação parcial — `montarTextoPosEscrita`

Quando parte do conjunto já estava registrada (hoje ignorada em silêncio pelo `JA_REGISTRADA`):

```
{abertura} ✅ Confirmei agora:
• {remédio} de {dia} ({hora})
• ...

Já estavam registradas: {remédio} ({hora}), {remédio} ({hora}).
```

Mesma regra da data e mesma rotação de abertura do §2.1. Quando **tudo** já estava registrado, mantém "Tudo certo — isso já estava registrado aqui ✅".

## 5. Textos livres com regras (prompt do principal)

Sem template; o principal escreve seguindo estas regras (todas também obedecem à Constituição):

- **Item 4 — não dá para saber a qual dose:** uma pergunta, no fim; cita as candidatas com nome, dia e horário (sem data se for hoje); nunca registra antes da resposta. Referência de tom: "Ontem você tinha duas doses de Dipirona, às 15:58 e às 19:58. Foram as duas ou só uma?"
- **Item 11 — lembrete e pergunta do fluxo chegaram juntos e veio um "sim" curto:** uma linha, nomeando as duas coisas (a dose e o assunto do fluxo), perguntando a qual o "sim" se refere.
- **Item 12 — desistência da escolha no relatório:** fechamento curto e caloroso, com aceno de porta aberta, sem reexplicar (emenda da regra 6 do guia).

## 6. "Erro" sem dizer o quê — texto de referência no prompt

```
Poxa, me desculpa! O que ficou errado — o nome, o horário, a quantidade ou outra coisa?
```

Se o erro vier apontado (na mesma mensagem ou na seguinte), continua valendo a delegação à configuração.

## 7. Convite depois do estoque contestado — `estoqueTemplates.js`

Template novo (ex.: `buildConviteEstoqueContestado`), usado no lugar do `buildConviteEstoqueNaoCadastrado` **só** quando a confirmação do turno contestou um estoque ≤ 0 (a execução já devolve `contestado`):

```
📦 Pelo que eu tinha anotado, o *{remédio}* tinha acabado — então deixei o estoque em aberto. Se souber quantos você tem em casa, me conta que eu volto a te avisar quando estiver acabando.
```

Nos dias seguintes, com o estoque já nulo, volta o convite comum.

## 8. "Ainda não faço" — o "isso" vira o pedido (estrutural)

`respostaHonestaAindaNao(chave)` já sabe escrever o rótulo do inventário ("Ainda não consigo *ouvir áudios*…"), mas o router a chama sem a chave. Mudança:

- o principal, ao delegar `nao_suportado`, devolve `chave_ainda_nao`, escolhida num enum montado pelo código a partir de `AINDA_NAO` (e da lista do que a Nami nunca faz);
- a reserva usa `respostaHonestaAindaNao(chave)`; sem chave válida, o principal continua obrigado a escrever a mensagem (regra atual).

## 9. Convite único de cadastro (estrutural)

**Decisão de 26/09:** toda vez que um cadastro novo começa, a Nami oferece mandar tudo de uma vez, com os obrigatórios em linhas separadas — nunca coleta campo a campo começando por "qual o nome". O runner já aceita a mensagem completa (extrator completo) e só pede o que falta; os obrigatórios do schema são nome e posologia (horários + quanto toma por vez).

Um **único template** de convite, num ponto só (ex.: `renderizarConviteCadastro({ abertura })` em `schemas/cadastro.js`), com o corpo:

```
Pode me mandar tudo de uma vez, se quiser:
• o nome do remédio
• quanto você toma por vez
• os horários

Por exemplo: Losartana 50mg, 1 comprimido, 8h e 20h
```

Aberturas por ponto de uso:

| Onde | Abertura |
|---|---|
| Cadastro novo (`renderizarPerguntaNome`, caso padrão) | `Vamos cadastrar, {nome}! 💊` |
| Fim do onboarding (`renderizarConviteAoPrimeiroCadastro`) | `Prontinho, {nome}, tudo guardado! 📝` · sem data: `Tudo bem, {nome}! 🌿` |
| Cadastro novo durante o convite de estoque (item 10) | o texto atual "Só fechando o anterior: …" e, em seguida, `Vamos cadastrar, {nome}! 💊` + corpo |
| Falha de identificação (`motivoFalha`) | `Desculpa, não consegui identificar o remédio 😊` + corpo |

Única exceção: `nomeRecusadoPorDosagem` ("Esse valor parece a concentração…") continua pedindo **só o nome**, porque ali só falta o nome.

"Pode me mandar… se quiser" — a Nami nunca usa frase no imperativo (regra 1). Sem `{nome}`, a abertura cai para "Vamos cadastrar! 💊".

## 10. Arnês

- Atualizar asserções e textos semeados que citam os textos antigos (estoque zerado, "Anotei que você não tomou", "Qual o *nome* dele?", "Pode mandar tudo de uma vez — o nome…").
- Asserções novas:
  - lembrete de estoque zerado **não** contém "não foi possível registrar";
  - confirmação de dose de hoje **sem** data; de ontem **com** data;
  - duas confirmações seguidas da mesma pessoa saem com **aberturas diferentes**, e a linha do fato é idêntica ao formato do §2.1;
  - "não tomei" fechando dose → a resposta contém a linha fixa "ficou registrado como não tomado" e **não** contém "se tomar mais tarde";
  - duas respostas seguidas a "Não" com a dose aberta **não** são idênticas (asserção de comportamento sobre o texto do principal — sem texto esperado exato);
  - "não tomei" com dose aguardando resposta → dose segue `pendente`; "pulei" → `nao_tomado` (A43 ganha os dois);
  - confirmação parcial lista "Já estavam registradas";
  - cadastro novo abre com o convite de três linhas, sem "Qual o *nome*";
  - `nao_suportado` com chave → texto com o rótulo do inventário, sem "isso".

## 11. Critérios de aceite

- Textos exatamente como acima; nenhum texto novo fora deste briefing.
- Casos afetados verdes a cada commit; suíte completa verde no portão.
- Validação manual do Guilherme no staging antes da promoção.

## 12. Fora de escopo

Retomada da coleta (item 7) e pergunta segura (item 8) ficam como estão. P2 em diante.