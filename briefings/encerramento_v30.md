# ENCERRAMENTO — Sessão v30 (12/08/2026)

**Executor:** Claude Code
**Tema da sessão:** Priorização para o beta + MH-072 (coleta de data de nascimento),
entregue em três partes com validação em produção a cada ciclo.

---

## 1. Correção do cabeçalho do CONTEXT.md

O cabeçalho está defasado desde a v29 — ainda diz **v28**. Substituir as 4 primeiras
linhas do arquivo por:

```
# 🌿 NAMI — Contexto do Projeto (v30 — FECHADA: MH-072 coleta de data de nascimento
no onboarding, entregue em Partes A/A.1/A.2 com validação em produção a cada ciclo;
priorização de 4 frentes para o beta — MH-072, MH-040, MH-073, MH-009 — 12/08/2026)
```

---

## 2. Seção nova no CONTEXT.md

Inserir após a seção `## Sessão v29`, antes do bloco de princípios.

````markdown
## Sessão v30 (12/08/2026) — MH-072: coleta de data de nascimento (Partes A, A.1, A.2)

### Priorização para o beta

Guilherme definiu 4 frentes como condição de lançamento do teste beta. Todo o restante
do backlog fica para depois do lançamento, sob a premissa explícita de que **dados reais
de uso vão reordenar as prioridades** — o que faz ou não sentido para o usuário final
ainda é hipótese.

| Frente | Item | Situação ao fim da v30 |
|---|---|---|
| Data de nascimento | MH-072 | Partes A, A.1 e A.2 entregues e validadas |
| Mensagens fracionadas | MH-040 | Repriorizado para `alta`, não iniciado |
| Medicamento em gotas | MH-073 | Registrado, prioridade `alta`, não iniciado |
| Dashboard de gestão | MH-009 | Repriorizado para `alta`, não iniciado |

Motivação do MH-072: conhecer a idade média do público. Uso **exclusivamente estatístico
agregado** — sem personalização por faixa etária neste escopo.

### Desenho da coleta

Três perguntas separadas (dia → mês → ano), decisão tomada em função do público-alvo
idoso. Efeito colateral positivo: quando o campo esperado é estreito, a validação
determinística fica trivial — uma data livre exigiria parsing ambíguo, três campos
separados não.

Estado próprio `coletando_nascimento`, fora do recepcionista. Módulo determinístico
`src/dataNascimento.js` (funções puras, sem I/O) + agente `src/agentes/data_nascimento.js`.

**Decisão estrutural:** `onboarded: true` e `lgpd_accepted: true` continuam sendo
gravados no momento do aceite da LGPD, e a coleta da data é um estado posterior. Se o
usuário abandonar no meio das três perguntas, volta já onboarded e a LGPD **não** é
pedida de novo. Consentimento é persistido no instante em que acontece.

**Extrator devolve tipo semântico, não sim/não.** `extrairComponenteData(mensagem,
campoEsperado)` retorna `dia | mes | ano | data_completa | ambiguo | indeterminado`. A
pergunta que o código faz é *"o que é isso?"*, nunca *"isso serve para o campo que eu
esperava?"* — evitando a falácia formato-≠-pertencimento (a mesma do BUG-030 e BUG-086).

**Correção implícita sem lista de palavras:** se o extrator devolve um tipo cujo campo já
está preenchido, isso *é* uma correção. Sobrescreve e confirma. Não existe lista de
gatilhos tipo "na verdade", "errei", "corrige".

### Parte A (commit `037c061`)

Coluna `users.data_nascimento` (date, nullable), migration aplicada. Estado novo, extrator,
ponte a partir do aceite da LGPD, texto da LGPD atualizado para incluir a data,
`definirEstadoPosOnboarding` extraída para `src/estadoPosOnboarding.js`.

Validação: **12 de 15 cenários aprovados**, 1 reprovado, 2 com ressalva.

### Parte A.1 (commit `04f9b73`) — correções pós-validação

**Defeito crítico encontrado (corrupção silenciosa de dado):** a tolerância de Levenshtein
≤1 estava sendo aplicada também contra as abreviações de mês, de 3 caracteres. Resultado:
`"Nossa que chato nao quero mais"` → `mais` → **maio** → gravou `10/05/1989`. O
classificador nunca chegou a rodar, porque o extrator "reconheceu" um componente.

Falsos positivos confirmados por teste isolado: `mais`→maio, `mas`→março, `sei`→setembro,
`ser`→setembro. Frases de recusa e hesitação — exatamente os momentos em que o usuário
mais precisa ser entendido.

Correção: Levenshtein **só** contra nomes completos, com piso de 5 caracteres no token
(`maio` tem 4; distância 1 sobre ele ainda alcançava `mais`). Abreviações passam a exigir
igualdade exata.

Outras correções da A.1:
- `buildSystemPrompt` passa a receber o estado determinístico (`valorAceito`,
  `valorRejeitado`, `campoPendente`). Antes a LLM não sabia o que tinha sido aceito e
  tratava resposta correta como tentativa falha (*"Boa tentativa com o número!"*), ou
  propunha valor que o sistema não tinha (`89` → *"você quis dizer 1989? Confirma?"* →
  laço, porque o "Isso" seguinte não correspondia a nada no estado).
- Proibição global de insistir, minimizar ou negociar, movida para o prompt base. Existia
  só no template de recusa, e a LLM adotava tom conciliatório por conta própria em outros
  templates (*"Essa é a última perguntinha, prometo"*).
- `nasc_ruido` ganhou ramo para `nasc_confirmacao`; o fallback silencioso para `'dia'`
  fazia um typo (`"Issi"`) jogar o usuário de volta ao início.
- Vocabulário do classificador estendido com `confirmacao`/`negacao` **apenas** na etapa
  de confirmação. Descartada a ideia de aplicar Levenshtein a `respostaAfirmativaSimples`
  — recriaria a mesma armadilha (`sem`→`sim`, distância 1).
- Após 3 tentativas de ruído, pula automaticamente em vez de oferecer.

Validação: **9 de 11 cenários aprovados**.

### Parte A.2 (commit `2e22a0a`) — negação e saudação

- `nasc_negacao` extraía apenas *qual campo* estava errado e descartava o valor. `"O
  correto e dia 10"` zerava o dia e reperguntava; a LLM então **confirmava uma data que
  não existia no estado**. Agora extrai campo + valor e corrige em um turno.
- Quando o campo é de fato zerado, o prompt recebe `campoZerado` com instrução explícita
  de não confirmar valor que a pessoa mencionou mas o sistema descartou.
- Categoria `saudacao` no classificador, em todas as etapas. Saudação caía em `ruido` e
  consumia tentativa — quem voltasse duas vezes dizendo "oi" queimava 2 das 3 antes de
  tentar responder uma única vez.

Validação: **9 de 9 cenários aprovados**, confirmados por log do Railway.

### Método que funcionou nesta sessão

Três ciclos de entrega → validação em produção → correção, em vez de um bloco único. Cada
ciclo revelou defeitos que a leitura de código não pegaria.

**Os logs do Railway foram decisivos duas vezes.** No caso do "maio", eu havia levantado
três hipóteses (webhook duplicado, log não confiável, bug não localizado) — **todas
erradas**. A ausência de uma linha de classificador no log foi a prova de que o extrator
tinha reconhecido um componente. Sem os logs, teríamos perseguido a hipótese errada.

Transcripts do WhatsApp com testes pré e pós-correção no mesmo arquivo dão comparação
direta e são melhores que `agent_logs` para avaliar qualidade de conversa.
````

---

## 3. Requisito pendente para o briefing da Parte B

Guilherme pediu (12/08, fim da sessão): **destacar `**DIA**`, `**MÊS**` e `**ANO**` em
maiúsculas e negrito** nas perguntas de cada etapa da coleta.

Motivo: no WhatsApp o negrito é o único recurso tipográfico disponível, e para o
público-alvo idoso ele separa "o que estão me pedindo agora" do resto da frase. Hoje a
Nami usa negrito de forma inconsistente entre turnos — às vezes no exemplo, às vezes no
campo, às vezes em nada.

**Deve ser regra fixa no prompt, não sugestão** — deixar a cargo da geração livre repetiria
o padrão que causou três defeitos nesta sessão (a LLM cumpre na maioria dos turnos e
improvisa numa minoria, que é onde o usuário se perde).

**Não registrado no backlog.** Precisa de decisão de Guilherme: item próprio ou escopo do
briefing da Parte B. Governança da v29 exige autorização explícita para novo item.

---

## 4. Escritas no backlog

Executar via `src/backlog.js` (`atualizarStatusBacklogItem`), nunca SQL direto.

**Atualizar:**
- `MH-072` Parte A.2 → `resolvido` (9/9 cenários validados em produção em 12/08)

**Já corretos, não mexer** (verificados via Supabase ao fim da sessão):
- MH-072 Parte A → `resolvido` · Parte A.1 → `resolvido` · Parte B → `aberto`/`alta`
- MH-073, MH-074 → `aberto`/`alta` · MH-075 → `aberto`/`media`
- MH-009, MH-040 → `aberto`/`alta` · BUG-030 → `aberto`/`alta`, relacionado a MH-072 Parte B

**Nenhum item novo a registrar nesta sessão.**

---

## 5. Princípios

Os princípios 36, 37, 38 e 39 **já foram registrados** no CONTEXT.md durante a sessão.
Não duplicar. Conferir apenas que a numeração está contínua a partir do 35.

---

## 6. Estado ao fim da v30

**Concluído:** MH-072 completo (Partes A, A.1, A.2). A coleta de data de nascimento está
em produção e validada.

**Próximo:** MH-072 Parte B — reestruturação do recepcionista, separando classificação de
geração. Resolve BUG-030 (o `pareceNome()` é uma lista de exclusão de palavras, o
antipadrão do princípio 14) e MH-074 (pergunta funcional não exige nome nem LGPD). O
`querCadastrar` em `src/estadoPosOnboarding.js` é alvo declarado da mesma parte — é outra
lista de palavras.

**Evidência de que o BUG-030 é real e não hipotético:** durante os testes desta sessão um
usuário foi cadastrado com `name = "Oi"` — a saudação virou nome.

**Restante para o beta:** MH-040 (mensagens fracionadas), MH-073 (gotas), MH-009
(dashboard).