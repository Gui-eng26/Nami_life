# BRIEFING — Correção de tom: "o sistema" não existe para o usuário (v22, follow-up)

## Escopo revisado (após revisão de risco com Guilherme)

A primeira versão deste briefing propunha reescrever 4 ocorrências de "o sistema" no prompt. Revisão:
uso interno de "o sistema" nas instruções do prompt (documento lido pelo Claude, não pelo usuário) é
legítimo e não é, em si, o problema — é o mesmo tipo de linguagem de arquitetura que um comentário de
código usaria. O problema é só quando essa linguagem vaza para o texto que o usuário lê.

Das 4 ocorrências, **apenas uma tem causa raiz confirmada** por evidência real (o print de produção):
a justificativa da regra nova (item (c) abaixo), escrita nesta mesma sessão, cujo texto ficou a poucas
linhas do exemplo de resposta ao usuário — e o Claude ecoou essa frase vizinha na saída real. As
outras três (exclusão de conta, handoff de cadastro, handoff de configuração) são instruções antigas,
já em produção há sessões, sem nenhum vazamento jamais observado — mexer nelas seria adicionar rigor a
um risco hipotético, não confirmado, com risco real de regressão em fluxos já validados. Mesmo padrão
de decisão já usado no projeto (v17, MH-046: não implementar sem evidência de produção).

**Escopo final: regra absoluta nova (permanente) + correção pontual do item (c). Os itens (a), (b) e
(d) NÃO são alterados.**

## Correção 1 — nova regra absoluta (adicionar, não substitui nenhuma existente)

**Arquivo:** `src/prompts.js` — inserir logo no início, junto às primeiras regras de tom (antes de
"REGRA DE MÁXIMA PRIORIDADE — CONFIRMAÇÃO DE DOSE"), para governar todo o resto do prompt:

```
REGRA ABSOLUTA — VOCÊ É A ÚNICA ENTIDADE QUE O USUÁRIO CONHECE:
Para o usuário, não existe "um sistema" por trás de você — existe só você, a Nami. NUNCA diga
frases como "o sistema vai rotear", "o sistema não guarda esse contexto", "quem cuida disso é o
sistema" ou qualquer variação que trate um mecanismo interno como uma entidade separada de você.
Se precisar comunicar que algo vai continuar sem sua ação direta, fale na sua própria voz e sem
citar mecanismo nenhum (ex: "pode deixar!" em vez de "o sistema cuida disso").
Esta regra não proíbe você de ENTENDER como o sistema funciona por trás — só proíbe MENCIONAR
isso ao usuário.
```

## Correção 2 — reescrever APENAS o ponto com causa raiz confirmada

**Arquivo:** `src/prompts.js` — trocar:
```
curta ("quero", "sim", "pode", "faz isso") a uma pergunta sobre elas, porque o sistema não guarda
esse contexto entre uma mensagem e outra.
```
por:
```
curta ("quero", "sim", "pode", "faz isso") a uma pergunta sobre elas, porque você não vai se
lembrar, na próxima mensagem, a que pergunta sua o usuário está respondendo.
```

## NÃO alterar (mantido de propósito, sem evidência de vazamento)

- Linha ~100 (exclusão de conta): "quem cuida disso é o sistema."
- Linha ~164 (handoff de cadastro): "O sistema vai rotear automaticamente para o agente correto."
- Linha ~277 (handoff de configuração): "O sistema vai rotear automaticamente para o fluxo correto."

Protegidas pela regra absoluta nova. Se um vazamento real for observado em qualquer uma delas no
futuro (manual ou via MH-54, o juiz offline, que varre `agent_logs` e serve exatamente para pegar
esse tipo de desvio de tom em escala), corrigir aquele ponto específico então, com evidência.

## Validação sugerida

Repetir o cenário exato que expôs o problema: crítica sobre confirmar toda hora → oferta de pausar
lembretes/ajustar horário. Conferir que a Nami não menciona "sistema" em nenhuma variação.

## Backlog

- **BUG-68** — "Nami quebra personagem mencionando 'o sistema' ao usuário" | causa_raiz: justificativa
  da regra de handoff (adicionada nesta sessão) usava linguagem de bastidor a poucas linhas do exemplo
  de resposta ao usuário, e o modelo ecoou essa frase na saída real | status: `resolvido` após deploy
  | prioridade: `media` | sessao_criacao: v22 | data_criacao: 2026-07-27