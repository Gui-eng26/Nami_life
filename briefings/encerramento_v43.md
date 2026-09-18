# BRIEFING DE ENCERRAMENTO — v43 (18/09/2026)

**Tema:** fluidez da jornada de chegada — implantação da arquitetura desenhada na v42
**Branch de edição do CONTEXT.md:** `main`
**Estado no fim da sessão:** blocos A, B e C implementados, validados em staging e promovidos
para produção (merge `staging` → `main`, commit anterior de referência `9211882`)

Claude Code: execute as três partes na ordem — CONTEXT.md, commit/push, escritas de backlog.

---

## PARTE 1 — Substituir a seção §11 do CONTEXT.md

A §11 descrevia um plano de 7 fases. Cinco foram implementadas. O texto abaixo substitui a
seção inteira.

```markdown
## 11. Jornada de chegada — arquitetura e estado

### 11.1 Objetivo

Tornar fluido o caminho do "Oi" até o primeiro medicamento cadastrado. Linha de base do
Ciclo 2 (09/09): 19 chegaram → 10 deram nome e aceitaram a LGPD → 9 informaram data de
nascimento → 6 cadastraram um medicamento. Nove dos 19 pararam tendo visto apenas o texto
de acolhida. O público do beta é JOVEM, não idoso — tolera menos fricção do que a persona
originalmente imaginada.

### 11.2 Arquitetura em três camadas (decidida na v42)

Extrator (LLM, saída tipada, SEM autoridade — nunca condicionado à etapa corrente, sempre
procura todos os campos do schema) → máquina de estados (código determinístico: valida,
persiste, calcula o que falta) → renderização (o código decide o que dizer a partir de uma
leitura pós-escrita; a LLM apenas escreve na voz da Nami).

Três valores de campo nunca colapsados: extraído / ausente (`null`) / ambíguo
(`indeterminado`).

### 11.3 A jornada, como ficou (v43)

| # | Nami | Usuário |
|---|---|---|
| 1 | acolhida curta + pede o nome | nome |
| 2 | LGPD | sim |
| 3 | data de nascimento completa, com exemplo | 06/11/1989 |
| 4 | pede o primeiro remédio: nome, quantidade, horários | Losartana 50mg, 1 cp, 8h e 20h |
| 5 | **grava** + pergunta o estoque | 30 comprimidos |
| 6 | resumo lido do banco + "está tudo certo?" | sim |
| 7 | fecha + aviso de que ainda está sendo construída | |

Antes da v43 esse caminho custava cerca de 15 turnos.

### 11.4 As DUAS portas de entrada

A intenção da primeira mensagem decide a porta, e as duas precisam ser mantidas curtas:

- `cadastrar` ou `neutro` → `recep_boas_vindas`
- `descobrir` → `recep_apresentacao` (caminho do curioso, MH-074)

Quem chega por QR code de camiseta, folheto ou cartão cai em `descobrir`. Em evento
presencial essa é a porta PRINCIPAL, não a exceção. Desde a v43 o convite dessa porta pede
o nome na mesma mensagem, e responder com o nome é o aceite — ajuste deliberado da decisão
original do MH-074 de que a apresentação não pediria dado nenhum.

### 11.5 Níveis de campo no cadastro

- **Have-to-have** (sem isso não existe lembrete): `nome`, quantidade por dose, horário.
- **Nice-to-have** (nunca bloqueiam): `dosagem`, `estoque_atual`, `tipo_tratamento`.
- `forma_farmaceutica` é DERIVADA da unidade da dose e nunca perguntada.
- A gravação acontece assim que os have-to-have existem, **antes** da pergunta de estoque.
- O resumo vem DEPOIS do estoque, para que a correção continue dentro do fluxo, e é lido de
  volta do banco: diz "isto está registrado", nunca "isto vou gravar".
- Correção no resumo edita o REGISTRO, não o rascunho — `atualizarMedicamentoCampos` para
  campos simples, `replaceMedication` para horários, `registrarMovimentoEstoque` para estoque.

### 11.6 Estoque tem três estados, não dois

`estoque_atual` NULL significa "nunca informado" e é diferente de zero (P49). Ramos:

| Resposta | Grava |
|---|---|
| "30 comprimidos" | valor + movimento `cadastro_inicial` |
| "acho que uns 20" | valor + `estoque_estimado = true` |
| "não sei" | `NULL`, sem movimento, sem insistir |

Enquanto for NULL, a primeira confirmação de dose de cada dia traz um convite para informar
o estoque. Quando o estoque recebe valor, o convite cessa e o alerta normal de recompra
assume. O convite vive apenas no caminho da confirmação — não entra no lembrete agendado
nem na cobrança de dose não confirmada.

### 11.7 Fila e janela de agregação

`src/filaTurnos.js` serializa turnos por usuário e agrupa mensagens fragmentadas.

- Fila por `phone`, em memória do processo. **Correta apenas com 1 réplica** (ver §6).
- Janela DESLIZANTE: cada mensagem reinicia o timer (`JANELA_AGREGACAO_MS`, default 5000),
  com teto desde a primeira (`JANELA_TETO_MS`, default 15000). Janela fixa foi tentada e
  falhou: medição em staging mostrou fragmentos legítimos a 6s de intervalo.
- Concatenação ordenada pelo timestamp da mensagem, não pela ordem de chegada — a Z-API
  entrega webhooks fora de ordem (confirmado por print em 18/09).
- Lembrete agendado que dispara com a janela aberta ENTRA NA FILA e espera o turno corrente
  fechar. Nunca fura a fila.
- **Pendente de ajuste pós-evento:** 5000ms não cobre o intervalo de 6s observado. Valor
  recomendado 7000ms, adiado por tempo. Medir antes de fixar.

### 11.8 Data de nascimento

Etapa inicial `nasc_data` pede a data completa com exemplo obrigatório. Dia/mês/ano isolados
continuam existindo como fallback quando chega só um pedaço.

Confirmação segue uma regra única: **a Nami só confirma o que ela inferiu ou montou.**

| Entrada | Confirmação |
|---|---|
| data completa, ano de 4 dígitos | não |
| data completa, ano de 2 dígitos (`06/11/89`) | sim, mostrando o ano expandido |
| data montada por partes | sim |

Expansão do ano de 2 dígitos: assume o século atual; se cair no futuro, usa o anterior.
Ponto cego aceito: 00–26 colide com 1900–1926, faixa que a validação de idade já limita.
Medição por log `🎂 [ANO2D]` no Railway — `system_events.tipo` tem CHECK que não aceita tipo
novo sem migração.

### 11.9 Guia de composição visual

`src/templates/composicao.js` é ponto único (mesmo padrão do P55): curto não é cru, itens em
linhas próprias com emoji semântico, negrito do WhatsApp com UM asterisco, pergunta sozinha
na última linha. Aplicado em `recepcionista.js`, `data_nascimento.js` e `cadastro.js`.

**Ainda NÃO aplicado** em `principal.js`, `configuracao.js`, `relatorios.js`, `lembrete.js` e
`exclusaoConta.js` — esses agentes ainda podem emitir `**`. Mensagens renderizadas em código
(`src/templates/*.js`) não passam pelo guia e precisam de edição manual.

### 11.10 O que falta das 7 fases

| Fase | Estado |
|---|---|
| 0 acolhida enxuta | entregue (MH-091 A e B) |
| 1 fila + janela | entregue (MH-040 A e B) |
| 2 verdade no roteamento | entregue (BUG-104, MH-090) |
| 3 níveis de campo | entregue (MH-094) |
| 4 destravar o extrator | entregue (dentro do Bloco C) |
| 5 múltiplos medicamentos numa mensagem | **aberta** |
| 6 call único `{ intencao, campos }` | **aberta** |
| 7 runner do onboarding | **aberta** |

Limitação conhecida e não mascarada: **corrigir e continuar no mesmo turno** ("na verdade é
às 20h" no meio do fluxo) só se resolve na Fase 6. Hoje o extrator roda em qualquer etapa mas
só preenche campo vazio, nunca sobrescreve — é a trava que evita corrupção silenciosa.

### 11.11 Métrica

Turnos em `agent='cadastro'` por medicamento cadastrado. Base v42: 7 a 10. Alvo com níveis de
campo: 3 a 4. Com extrator destravado numa mensagem rica: 1 a 2. **Ainda não medido depois da
v43** — primeira ação da próxima sessão.

Cada fase precisa do próprio briefing de execução, gerado perto da execução: briefing é
contrato, e contrato de 7 fases envelhece antes de ser cumprido.
```

---

## PARTE 2 — Acrescentar ao CONTEXT.md

**Novos princípios** (seção de princípios numerados):

```markdown
- **P58:** Todo estado novo de uma coluna exige varredura dos consumidores existentes antes
  do merge. O Bloco C da v43 introduziu `estoque_atual = NULL` corretamente e cinco leitores
  ficaram para trás, um deles afirmando ao usuário que o remédio tinha acabado. A lição não é
  sobre estoque: é sobre a varredura.
```

**Novos itens na seção §6 (padrões técnicos):**

```markdown
- A fila por usuário de `src/filaTurnos.js` vive na memória do processo. É correta APENAS com
  1 réplica e serverless desligado. Subir para 2+ réplicas, ou ligar serverless, invalida a
  solução SILENCIOSAMENTE — sem erro, sem log, só o bug de concorrência de volta. Verificado
  em 18/09: produção e staging com 1 réplica, serverless off.
- `system_events.tipo` tem CHECK que aceita apenas `erro_tecnico`, `desvio_comportamental` e
  `intencao_nao_suportada`. Tipo novo exige migração.
- A Z-API NÃO garante ordem de entrega dos webhooks. Confirmado em 18/09: cinco mensagens
  digitadas em sequência chegaram embaralhadas. Qualquer agregação precisa ordenar pelo
  timestamp da mensagem.
- Negrito do WhatsApp é UM asterisco de cada lado. A LLM escreve `**texto**` de markdown por
  padrão e os asteriscos externos aparecem literalmente na tela do usuário.
- O projeto de staging NÃO era cópia fiel da produção: 8 chaves estrangeiras estavam sem
  `ON DELETE CASCADE` (users ← medications, conversation_state, agent_logs,
  intencoes_nao_suportadas, care_network ×2; medications ← schedules, dose_logs), o que
  quebrava `delete_user_account` apenas lá. Corrigido por SQL em 18/09. Outras diferenças
  podem existir e nunca foram auditadas.
```

---

## PARTE 3 — Escritas em `backlog_items`

Usar `atualizarStatusBacklogItem` de `src/backlog.js`. Nunca SQL cru.

| Item | Parte | Novo status | Observação |
|---|---|---|---|
| MH-040 | A | `concluido` | janela de agregação deslizante com ordenação por timestamp |
| MH-040 | B | `concluido` | fila por usuário |
| MH-091 | A | `concluido` | acolhida enxuta (`recep_boas_vindas`) |
| MH-091 | B | `concluido` | porta do curioso (`recep_apresentacao`) pede o nome no convite |
| MH-092 | — | `concluido` | data de nascimento em 1 turno + ano de 2 dígitos |
| BUG-104 | — | `resolvido` | roteamento preserva a mensagem rica; nenhum agente promete persistência |
| MH-090 | — | `concluido` | `principal` proibido de afirmar cadastro; resumo lido do banco |
| MH-094 | — | `concluido` | níveis de campo, gravação antecipada, estoque NULL |
| MH-80 | — | nova parte `D`, `concluido` | extrator multi-campo destravado em qualquer etapa |

Atualizar também a descrição de MH-040 A para registrar que a janela fixa foi tentada e
substituída pela deslizante — a tentativa descartada é informação, não ruído.

---

## PARTE 4 — Itens novos, pendentes do "sim, registra" de Guilherme

Não inserir sem autorização explícita (governança da v29).

| Proposta | Tipo | Do que se trata |
|---|---|---|
| MH-89 Parte D | MH | Auditoria de diferenças de schema entre staging e produção. As cascatas foram a diferença que apareceu; defaults, checks e índices nunca foram comparados |
| MH-095 | MH | Guia de composição visual estendido aos 5 agentes restantes e às mensagens renderizadas em código |
| MH-096 | MH | Fechar a janela de agregação por sinal de digitação da Z-API (`composing`/`available`) em vez de timer |
| ACH | ACH | O resumo do cadastro exibe `Forma` e `Tratamento` como se o usuário os tivesse informado — um é derivado, o outro é default do banco. Versão branda do problema do P56 |
| ACH | ACH | Texto da LGPD anuncia os três dados e depois os lista de novo — redundância de copy |
| ACH | ACH | Nome do medicamento sai sem negrito na mensagem de sucesso, com negrito no resto do fluxo |

---

## PARTE 5 — Onde a próxima sessão começa

**Primeira ação: medir.** A v43 inteira foi feita sem número novo. Rodar, em produção:

- turnos em `agent='cadastro'` por medicamento cadastrado, comparando com a base de 7 a 10
- funil de chegada dos usuários que entrarem a partir do CIW (18/09), comparando com
  19 → 10 → 9 → 6
- quantos medicamentos ficaram com `dosagem` NULL e `estoque_atual` NULL — foi a condição que
  Guilherme colocou ao aprovar os níveis de campo

**Depois, as três fases abertas**, nesta ordem de dependência: Fase 5 (múltiplos medicamentos
numa mensagem) → Fase 6 (call único `{ intencao, campos }`, que resolve corrigir-e-continuar)
→ Fase 7 (runner do onboarding, deixada por último por ser a de maior risco de regressão:
consentimento LGPD e porta de entrada de 100% dos usuários).

**Ajustes menores já identificados:** janela para 7000ms (medir antes), guia de composição
nos demais agentes, e os detalhes que Guilherme anotou durante os testes do Bloco C e ainda
não listou.

---

## PARTE 6 — Ações que dependem só de Guilherme

- Rodar a jornada de chegada completa em produção com o número de teste, e depois
  `SELECT delete_user_account('<uuid>')` para não sujar as métricas do evento.
- Commit de referência para rollback: `9211882` (estado da `main` antes do merge da v43).
- Depois do CONTEXT.md atualizado na `main`: merge `main` → `staging`, para o fluxo de branch
  fechar o ciclo.