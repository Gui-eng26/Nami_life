# BRIEFING — v43 Bloco B, Adendo 1: a porta do curioso (`recep_apresentacao`)

**Sessão:** v43 (17/09/2026)
**Branch:** `staging`
**Arquivo:** `src/agentes/recepcionista.js`
**Depende de:** `BRIEFING_V43_BLOCO_B_ACOLHIDA_NASCIMENTO.md`, já implementado e no `staging`

Auto-contido. Todo texto literal está embutido.

---

## 0. Evidência e causa raiz

**Teste real em staging, 18/09 01:28 UTC.** Mensagem de chegada: `"Oi! Quero conhecer a Nami
(camiseta)"`. Resposta da Nami: apresentação longa, quatro capacidades em tópicos, parágrafo
inteiro de "ainda estou em desenvolvimento", e **sem pedir o nome**.

**O Bloco B foi implementado corretamente** — verificado por leitura do `staging`:
`recepcionista.js` tem o novo texto de 3 linhas, `data_nascimento.js` tem a etapa `nasc_data`,
`dataNascimento.js` tem `expandirAno2Digitos`. Nada disso falhou.

**Causa raiz: a jornada de chegada tem DUAS portas, e o Bloco B encurtou só uma.**

| Intenção inicial classificada | Etapa | Estado |
|---|---|---|
| `cadastrar` ou `neutro` | `recep_boas_vindas` | encurtada no Bloco B ✔ |
| `descobrir` | `recep_apresentacao` | **intocada** — o briefing mandou não mexer ✘ |

O verbo "conhecer" classifica como `descobrir`. O bloco `recep_apresentacao` (MH-074) manda
listar todas as capacidades, incluir o aviso de desenvolvimento, e tem `NÃO peça o nome do
usuário` como restrição absoluta. Ele fez exatamente o que está escrito nele.

**Por que isso é prioridade e não borda:** quem escaneia um QR code de camiseta, folheto ou
cartão numa feira chega curioso por definição. Na CIW, `descobrir` é a porta **principal**, não
a exceção. A porta otimizada é a que quase ninguém vai usar amanhã.

**Achado secundário no mesmo log:** a resposta saiu com `**Lembretes nos horários certos**`.
No WhatsApp negrito é **um** asterisco de cada lado; dois aparecem literalmente na tela.

---

## 1. Decisão de Guilherme (v43)

O convite do caminho `descobrir` passa a **pedir o nome na mesma mensagem**. Responder com o
nome é o aceite. Economiza um turno na porta que 100% do público da feira vai usar.

Isso ajusta, de propósito, a decisão original do MH-074 de que a apresentação não pede dado
nenhum. A oferta continua sendo oferta — a pessoa pode ignorar do mesmo jeito. O que muda é
que dizer "sim" e dizer o nome viram o mesmo gesto.

---

## 2. Novo texto do bloco `recep_apresentacao` — primeira resposta

Em `buildSystemPrompt`, o ramo padrão de `apresentacaoTexto` (o último, que começa com "Esta é
a primeira resposta da Nami a alguém que só quer entender o que ela faz") passa a ser
exatamente:

```
  Esta é a primeira resposta da Nami a alguém que chegou querendo entender o que ela faz.
  A pergunta está em "Mensagem original do usuário" acima.

  Esta mensagem tem NO MÁXIMO 4 linhas curtas. É a porta de entrada de quem chega por QR
  code, cartaz ou indicação de alguém — cada linha a mais custa usuário.

  Estrutura obrigatória, nesta ordem:
  1. Responda ESPECIFICAMENTE o que a pessoa perguntou, citando-a. Se ela apenas disse que
     quer conhecer a Nami, apresente-se em uma frase.
  2. Diga o que você faz em UMA frase: lembra dos remédios na hora certa, aqui no WhatsApp,
     sem instalar nada. NÃO liste capacidades em tópicos. NÃO cite controle de estoque,
     adesão nem relatórios aqui — isso a pessoa descobre usando.
  3. Convide a começar JÁ PEDINDO O NOME, em uma frase, sem pressão. Responder com o nome é
     o aceite.
     Exemplo: "Quer começar agora? Me diz como posso te chamar que a gente organiza seus
     remédios juntos 😊"

  NÃO mencione LGPD, dados ou consentimento neste momento.
  NÃO mencione que está em desenvolvimento, em construção, aprendendo, em teste ou em
  evolução — esse aviso foi movido para o fim do primeiro cadastro.
  NUNCA use a expressão "teste beta".
  NÃO inicie o cadastro de medicamento.
```

### 2.1 Os outros dois ramos do mesmo bloco

Os ramos `ruido` e `nova_duvida` hoje terminam com `NÃO peça o nome`. Essa linha sai dos dois,
e a reoferta também passa a pedir o nome:

Ramo `ruido`:

```
  A última mensagem do usuário não deu pra entender como resposta ao convite que você acabou
  de fazer. Repita o convite de forma gentil e mais curta, sem soar repetitiva ou impaciente,
  pedindo o nome junto.
  NÃO mencione LGPD, NÃO inicie cadastro, NÃO mencione que está em desenvolvimento.
```

Ramo `nova_duvida`:

```
  O usuário fez uma NOVA pergunta sobre a Nami, em vez de aceitar ou recusar o convite
  anterior. Responda a essa dúvida em uma ou duas frases objetivas e depois REOFEREÇA o
  convite, pedindo o nome junto — mais leve e mais curto do que da vez anterior (esta é a
  rodada ${extras.rodadasDuvida || 1} de reoferta: quanto mais rodadas, mais leve e menos
  insistente deve soar).
  NÃO mencione LGPD, NÃO inicie cadastro, NÃO mencione que está em desenvolvimento.
```

O bloco `apresentacao_declinada` **não muda** — é despedida, não oferta.

---

## 3. Reconhecer o nome como aceite

Com o convite pedindo o nome, a resposta mais provável deixa de ser "sim" e passa a ser
"Guilherme". O classificador `classificarRespostaConvite` tem as categorias `afirmativo`,
`negativo`, `nova_duvida` e `ruido` — um nome solto não cai bem em nenhuma.

**Solução: reaproveitar o extrator de nome que já existe**, antes do classificador de convite.

No handler, no ramo `etapa === 'recep_apresentacao'`, antes de chamar
`classificarRespostaConvite`, rodar o extrator de nome já usado em `recep_boas_vindas`. O
mapeamento das categorias que ele devolve:

| Categoria do extrator de nome | O que fazer |
|---|---|
| `nome` | **aceite + nome coletado** — pula direto para a etapa de LGPD, exatamente como `recep_boas_vindas` faz hoje quando coleta o nome |
| `contexto_saude` | aceite: a pessoa trouxe um remédio, quer usar. Segue para `recep_boas_vindas` com `modoBoasVindas: 'pos_convite'` e `contexto_medicamento` preenchido, que já sabe reconhecer o remédio e pedir o nome |
| `recusa` | trata como `negativo` — vai para `apresentacao_declinada` |
| `pergunta` | trata como `nova_duvida` — responde e reoferece |
| `saudacao` ou `indeterminado` | **cai no fluxo atual**: chama `classificarRespostaConvite` e segue como hoje |

**Reaproveitar a transição que já existe.** Quando a categoria for `nome`, não inventar
caminho novo: replicar exatamente o que o ramo `recep_boas_vindas` faz hoje ao coletar o nome
com sucesso — mesma etapa de destino, mesmas chaves de contexto, mesmo `extras`. O ganho é
pular um turno, não criar um segundo caminho para o mesmo lugar.

**Custo:** no pior caso, duas chamadas de classificador no mesmo turno (nome, depois convite).
Aceito: são dois classificadores curtos de `max_tokens: 8` que já existem, e a fusão dos dois
é escopo da Fase 6, não de hoje.

---

## 4. Regra de negrito, válida em todo o recepcionista

Acrescentar ao bloco `base` de `buildSystemPrompt` — o texto comum a todas as etapas, junto das
instruções de tom — a linha:

```
Formatação do WhatsApp: negrito é UM asterisco de cada lado (*assim*). NUNCA use dois
asteriscos: eles aparecem literalmente na tela do usuário.
```

Vale para todas as etapas do recepcionista, não só para esta.

---

## 5. O que este adendo NÃO faz

- Não muda `recep_boas_vindas`, que já está correto no `staging`.
- Não muda nada do fluxo de data de nascimento.
- Não funde os dois classificadores num só (Fase 6).
- Não muda `apresentacao_declinada`.
- Não cria tabela, coluna nem migração.

---

## 6. Validação em staging

Apagar o usuário de teste entre as rodadas com
`SELECT delete_user_account('<uuid>');` — as cascatas do staging já foram alinhadas com as da
produção na v43.

| # | Mensagem de chegada | Esperado |
|---|---|---|
| 1 | "Oi! Quero conhecer a Nami (camiseta)" | ≤4 linhas, sem lista de tópicos, **sem** aviso de desenvolvimento, terminando com convite + pedido de nome |
| 2 | responder "Guilherme" | vai direto para a LGPD, **sem** repetir o pedido de nome |
| 3 | responder "sim" | segue para o pedido de nome, como hoje |
| 4 | responder "tomo losartana às 8h" | reconhece o remédio e pede o nome |
| 5 | responder "e é de graça?" | responde em 1 ou 2 frases e reoferece **pedindo o nome** |
| 6 | responder "agora não" | despedida gentil, sem insistir |
| 7 | "Oi" puro | continua caindo em `recep_boas_vindas`, curto, como já está |
| 8 | qualquer resposta | nenhum `**` aparece na tela |

Jornada completa a rodar de ponta a ponta antes do CIW: QR → apresentação → nome → LGPD →
data de nascimento em 1 turno → primeiro medicamento.

---

## 7. Backlog

Entra como **MH-091 Parte B** (a Parte A é a acolhida do Bloco B, já implementada). Mesmo
número, parte nova — o item foi maior que uma entrega, não é item novo.