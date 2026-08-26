# ENCERRAMENTO — Sessão v35 (26/08/2026)

**MH-073 Parte B.1 + BUG-101 — modelo canônico de escalada**

Claude Code: executar as três tarefas abaixo, na ordem.

---

## ⚠️ AÇÕES BLOQUEANTES

**Nenhuma.** Sem migration nesta sessão. Sem ação manual de Guilherme.

---

## TAREFA 1 — Atualizar `CONTEXT.md`

### 1.1 Trocar o título (linha 1)

```
# 🌿 NAMI — Contexto do Projeto (v35 — FECHADA: MH-073 Parte B.1 + BUG-101 — modelo canônico de escalada)
```

### 1.2 Inserir a seção abaixo IMEDIATAMENTE ANTES de `## Backlog (BUG/FIX/MH/ACH)`

(ou seja, logo depois do fim da seção `## Sessão v34 (19-25/08/2026)`)

```markdown
## Sessão v35 (26/08/2026) — MH-073 Parte B.1 + BUG-101: modelo canônico de escalada

Fecha a última lacuna estrutural de saída de fluxo do projeto e, no caminho, declara o
padrão que faltava para auditá-la.

### O problema da Parte B.1

O `cadastro.js` era o único agente conversacional **sem escalada ao roteador**. Verificado no
`main` em 26/08: `escalarParaRoteador` aparecia 0 vezes em `cadastro.js`, 12 em
`configuracao.js`, 1 em `data_nascimento.js`. `handleCadastro` nunca devolvia o sinal, e o
`router.js` não o interceptava para esse agente — embora já o fizesse para os outros dois em
seis pontos.

Durante um cadastro em andamento, qualquer intenção fora do fluxo ("quero ver meus remédios",
"qual meu estoque de Atenolol") não tinha para onde ir. A única saída era `TERMOS_CANCELAMENTO`,
lista fixa que cobre "cancela" e "deixa pra lá", mas não outra intenção legítima.

**Por que a Parte B.2 não resolvia:** a B.2 mudou o contrato do LLM e deu ramo determinístico a
todas as etapas — não tocou em escalada, nenhuma linha. A B.2 governa **como a etapa decide**;
a B.1 governa **como o usuário sai da etapa**. O BUG-92 já havia eliminado a causa mais comum
de sequestro de mensagem, restando estritamente o caso de intenção fora do fluxo.

### O achado que motivou o modelo canônico

O projeto tinha **três formas diferentes** de escalar, nenhuma declarada como padrão:

| Forma | Onde | Pergunta que faz antes de escalar |
|---|---|---|
| 1 | `configuracao.js`, ~9 de 12 etapas | Nenhuma — escala assim que o parser falha |
| 2 | `configuracao.js`, `identif_intencao` | "Que ação da configuração é essa?" (`classificarIntencao`) |
| 3 | `data_nascimento.js` | "Por que isso não é uma data?" (`classificarIndeterminado`) |
| — | `cadastro.js` | Não escalava |

A diferença entre a forma 3 e as demais **é justificada** pela natureza do fluxo: a coleta de
data tem um dado só e nenhum domínio de ações a classificar. A diferença entre as formas 1 e 2,
**dentro do mesmo arquivo e do mesmo domínio, é dívida acidental** — a v18 aplicou o modelo a 9
etapas de uma vez e `processarIntencaoOuEscalar` nasceu depois (BUG-060), reaproveitado só onde
o bug apareceu.

⚠️ O problema não era existir mais de uma forma — era **não existir critério declarado de qual
usar quando**. O projeto tinha 51 princípios e nenhum dizia como se faz uma escalada. Por isso
o `cadastro.js` chegou à v34 sem nenhuma, e ninguém notou: não havia padrão contra o qual medir
a ausência. Ver Princípio 52.

### Modelo canônico de escalada (declarado nesta sessão)

```
Camada 1 — parser/classificador determinístico da própria etapa. Reconheceu? resolve ali.
Camada 2 — classificador local de "por que não reconheci", categorias fechadas e uniformes:
           recusa | duvida | nova_intencao | ruido. Só nova_intencao escala.
Camada 3 — escalada ao roteador, via ponto único de despacho por agente.
```

Escolhida a forma 3 e **não** a 2 por razão estrutural: um classificador de domínio local é uma
**terceira definição** do que o agente sabe fazer (o classificador central já é uma, o
inventário do prompt é outra). O Princípio 5 existe para impedir inventários divergentes, e
isso já custou caro no BUG-084.

**Escopo de aplicação: somente `cadastro.js`.** O `configuracao.js` NÃO foi migrado — foi
reescrito na v18 e recebeu cinco correções validadas (BUG-082/083/084/085); migrar suas 12
etapas reabriria superfície de teste cara sem defeito aberto que justifique. Converge quando
houver motivo para tocá-lo, provavelmente no BUG-86.

### Implementação da Parte B.1

- **`classificarIndeterminadoCadastro`** — função nova, **ponto único** de definição das
  categorias de falha. Roda somente quando a camada 1 já falhou: custo zero de LLM no caminho
  feliz. Fallback é `'ruido'`, nunca `'nova_intencao'` — falha de classificador não pode
  derrubar um cadastro em andamento.
- **Nenhum dos 6 classificadores de campo teve prompt ou contrato alterado.** O desenho
  preliminar previa estender as 6 categorias; foi descartado para não criar seis definições
  divergentes de `nova_intencao` (Princípio 30) nem reabrir prompts validados na v34.
- **`decidirEtapa`** virou o hook central: detecta `ACOES_DE_FALHA` e decide entre escalar
  (`nova_intencao`), encerrar (`recusa`) ou anotar `motivoFalha` para o texto (`duvida`/`ruido`).
- **`despacharCadastro`** — ponto único de chamada de `handleCadastro` no router, no molde do
  `despacharRelatorio` (v25). Os 7 call sites externos passaram a usá-lo. Instrumentar call
  site a call site é a causa raiz do BUG-069.
- **`repetirPerguntaCadastro`** — função nova para a regra de reentrada.

⚠️ **`cad_confirma_forma` NÃO recebeu escalada, por decisão deliberada.** A etapa nunca bloqueia
(seção 6.3 da Parte B) — qualquer resposta avança. Sem beco, não há o que blindar. Não
"corrigir" isso depois achando que é lacuna.

### Duas decisões de escopo (Guilherme)

**Regra de reentrada:** quando o classificador central devolve `cadastro` de novo, ele está
**concordando** que o usuário não saiu do fluxo. Estado e contexto são mantidos como estão e a
pergunta pendente é repetida. Nenhum dado coletado é descartado, e não foi preciso mexer no
`contextoPreservado` de `despacharEscalada`.

**Delimitação estreita de `nova_intencao`:** significa "quer fazer algo FORA do cadastro".
Correções dentro do cadastro — **inclusive trocar de medicamento** — são `ruido`, e a etapa
repete a pergunta, exatamente como antes. Deliberado: o caminho de troca de medicamento não
limpa os dados do remédio anterior (ver MH-84), e tratá-lo como escalada propagaria dado errado.

### BUG-101 — classificação duplicada, nascido da própria correção

Os logs da validação mostraram duas chamadas idênticas ao classificador central por escalada
(09:38:09 e 09:38:11, mesma mensagem). `despacharCadastro` classifica para aplicar a regra de
reentrada e, quando o destino não é cadastro, delega a `despacharEscalada` — cuja primeira
instrução é reclassificar do zero.

⚠️ **A correção óbvia estava errada.** Passar só o `agenteSelecionado` teria trocado a
duplicação por perda de dado: `despacharEscalada` consome **quatro** campos (`agente`,
`subtipoRelatorio`, `params`, `feedback`). Uma escalada `cadastro → relatorios` chegaria com
subtipo e params `undefined`. A correção propaga o **objeto inteiro**, via parâmetro opcional
`classificacaoPreResolvida`; quando ausente, comportamento idêntico ao anterior e os seis call
sites antigos ficam intactos. Ver Princípio 53.

Efeito colateral corrigido: o log do branch de configuração dizia "Ainda é configuração" para
um usuário que estava em `cad_estoque`. Agora distingue origem e informa se há medicamento
preservado.

### Validação em produção

Duas baterias em WhatsApp real, cruzadas com `agent_logs`, `medications`, `schedules`,
`stock_movements` e `system_events`. **Zero degradações.**

| Origem | Mensagem | Destino | Resultado |
|---|---|---|---|
| `cad_estoque` | "Quero pausar os lembretes da dipirona" | configuracao | pausa executada |
| `cad_dosagem` | "Tomei o ômega 3 das 8" | principal | dose registrada |
| `cad_horarios` | "Me mostra meus remédios" | relatorios | **subtipo `meus_remedios` preservado** |
| `cad_estoque` | "Quero encerrar o tratamento do dipirona" | configuracao | tratamento encerrado, 5 schedules off |
| `identif_schedule` | "Quero cadastrar o Sincor" | cadastro | **caminho antigo íntegro** |

A escalada para relatórios prova a correção do BUG-101 (subtipo e params atravessaram o novo
parâmetro). A última linha é o teste de não-regressão do caminho antigo. Cinco chamadas ao
classificador central em toda a bateria — quatro escaladas e um roteamento normal, **nenhuma
duplicata**.

Cadastros completos sem regressão nas duas baterias: sólido, colírio em gotas e xarope. Sincor
50mg contínuo, estoque 30, schedules 00:00 e 12:00 (coerentes com "1 cp de 12/12h começando
meio-dia").

### ⚠️ Pendências de validação (declaradas, não fechadas)

Contagem nos dois arquivos de log: `nova_intencao` 4, `ruido` 3, **`recusa` 0, `duvida` 0**.

- **Ramos `recusa` e `duvida` não foram exercitados em produção.** Existem no código e passaram
  na verificação estática, mas nenhuma mensagem de teste caiu neles.
- **Reentrada `cadastro → cadastro` não reproduzível sob demanda.** O ramo exige que os dois
  classificadores discordem (falha diz `nova_intencao`, central devolve `cadastro`). A
  delimitação estreita aprovada nesta sessão fechou os caminhos naturais — todas as frases que
  o central devolveria ao cadastro estão marcadas como `ruido`. Restam só discordâncias
  probabilísticas. **O ramo permanece como rede de proteção**: sem ele, uma discordância
  descartaria um cadastro em andamento. Revisitar quando o MH-84 for implementado, porque aí a
  delimitação muda e o ramo passa a ser alcançável.
- **BUG-101 cenário 5** (escalada a partir de `coletando_nascimento`) não testado — exige
  número de usuário novo. Guilherme testará depois.

### Observação vista em produção e NÃO registrada (decisão de Guilherme)

Às 18:21, em `cad_horarios`: *"Eu tomo 1 cp de 12/12 hrs, comecei meio dia, tenho 30 Cps e vou
tomar sem parar"* — posologia e tipo de tratamento extraídos corretamente, **estoque ignorado**.
Vinte segundos depois a Nami perguntou quantas unidades ele tinha, e ele repetiu "30cps". O
aproveitamento de estoque em mensagem livre existe só na primeira mensagem (MH-80), não em
`cad_horarios`. Toca o Princípio 1, não é regressão da B.1 nem do BUG-101. Guilherme optou por
não registrar.

### Lição de processo

⚠️ **Quarto ciclo consecutivo em que o defeito veio da especificação, não da implementação.**
Os três da v34 (BUG-97 com `parseInt` prescrito, `?? ''` falsy, pré-condição de
`cad_confirmacao`) e agora o BUG-101 (delegação sem declarar o que o destino faz na entrada).
O Claude Code novamente encontrou e corrigiu defeitos do briefing antes de implementar —
inclusive um crítico: `calcularDecisaoEtapa` embutia `acao` apenas em `contextParaPrompt`, nunca
no campo de topo que `decidirEtapa` checa, o que faria a escalada **nunca disparar em 5 das 8
etapas**. Comportamento correto e a ser mantido.
```

### 1.3 Acrescentar os princípios 52 e 53 ao fim da lista (depois do 51)

```markdown
52. **Toda saída de fluxo tem forma única.** Um fluxo conversacional sem saída prende o usuário;
    um projeto sem forma declarada de saída não consegue auditar quem tem e quem não tem. O
    `cadastro.js` chegou à v34 sem nenhuma escalada e ninguém notou, porque existiam três formas
    divergentes e nenhuma era o padrão. As formas não eram o problema — a ausência de critério
    era. O modelo canônico de três camadas (parser determinístico → classificador de tipo de
    falha com categorias fechadas `recusa | duvida | nova_intencao | ruido` → escalada via ponto
    único de despacho) passa a ser a forma padrão. Agente novo nasce com ela; agente existente
    converge quando houver motivo para tocá-lo, **nunca por refatoração especulativa**.
    Corolário: um classificador de domínio local é uma definição adicional do que o agente sabe
    fazer, e definições adicionais divergem (Princípio 5) — a camada 2 julga **tipo de falha**,
    não domínio.

53. **Delegar a quem recalcula duplica o trabalho.** Quando uma função delega a outra que refaz
    por conta própria um cálculo caro já realizado, o custo dobra em silêncio: nada quebra, e
    por isso ninguém percebe sem olhar o log. `despacharCadastro` classificava a mensagem e
    entregava a `despacharEscalada`, que reclassificava — duas chamadas de LLM por escalada. A
    correção é propagar o resultado, e propagá-lo **inteiro**: passar um campo isolado de um
    objeto que o destino consome por completo troca a duplicação por perda de dado, que é pior.
    Corolário de processo: **um briefing que delega a uma função existente deve declarar o que
    essa função faz na entrada** — a mesma disciplina que o Princípio 47 exige para
    pré-condições de estado.
```

---

## TAREFA 2 — Escritas em `backlog_items`

Usar as funções de `src/backlog.js`, **não** SQL direto (governança v29).

### 2.1 UPDATE — MH-073 Parte B.1

- `status` → `em_validacao`
- Acrescentar às notas: `Implementada e validada em produção em 26/08/2026 (duas baterias). PENDENTE: ramos 'recusa' e 'duvida' do classificarIndeterminadoCadastro não exercitados em produção (contagem nos logs: nova_intencao 4, ruido 3, recusa 0, duvida 0). PENDENTE: reentrada cadastro->cadastro não reproduzível sob demanda — exige discordância entre o classificador de falha e o classificador central, e a delimitação estreita de nova_intencao fechou os caminhos naturais. Ramo mantido como rede de proteção; revisitar quando MH-84 for implementado.`

### 2.2 UPDATE — BUG-101

Já foi inserido pelo Claude Code com `status=em_validacao`. Acrescentar às notas:

`Validado em produção 26/08/2026: 5 chamadas ao classificador central em 4 escaladas + 1 roteamento normal, nenhuma duplicata. Escalada cad_horarios->relatorios preservou subtipoRelatorio='meus_remedios' e params, provando a propagação do objeto inteiro. Não-regressão do caminho antigo confirmada: escalada de configuracao(identif_schedule)->cadastro funcionou normalmente. PENDENTE: cenário 5 (escalada a partir de coletando_nascimento) não testado — exige número de usuário novo.`

### 2.3 INSERT — ACH-6

- `tipo`: `ACH` · `numero`: `6` · `parte`: `''`
- `titulo`: `despacharEscalada passa currentState: 'configurando' fixo, independente do agente de origem`
- `status`: `aberto` · `prioridade`: `baixa` · `relacionado`: `BUG-86`
- `descricao`:

```
router.js — despacharEscalada chama classificarIntencaoComContexto com currentState hardcoded
como 'configurando'. A string entra no prompt do classificador central (linha "ESTADO ATUAL:
${currentState}") e não é lida por nenhum if em código — não altera nenhuma decisão
determinística. Quando a escalada vem de data_nascimento (desde a v30) o valor é falso. Efeito:
pode enviesar o classificador a favor de configuracao em mensagens AMBÍGUAS; mensagens
auto-suficientes são resolvidas pelo texto e não sofrem. ORIGEM: a função nasceu na v18
servindo só ao configuracao.js, onde o valor era sempre verdadeiro; ganhou um segundo chamador
na v30 e a linha nunca foi revisitada. HIPÓTESE NÃO MEDIDA — nenhuma ocorrência de dano
registrada, e não mensurável hoje porque escalada não deixa rastro em agent_logs (ver MH-48).
Menção original em MH-65 (superseded) e como complicação declarada no BUG-86. A MH-073 Parte
B.1 NÃO alterou esta linha: despacharCadastro passa o currentState real por conta própria. O
BUG-101 REDUZIU a exposição — escaladas vindas do cadastro deixaram de reclassificar, portanto
deixaram de passar pelo estado falso.
```

### 2.4 INSERT — MH-84

- `tipo`: `MH` · `numero`: `84` · `parte`: `''`
- `titulo`: `Trocar de medicamento no meio do cadastro mantém dosagem, horários e estoque do anterior`
- `status`: `aberto` · `prioridade`: `media` · `relacionado`: `MH-073`
- `descricao`:

```
Em cad_confirmacao, o case 'nome' de calcularDecisaoEtapa devolve { proximaEtapa: 'cad_nome',
contextUpdates: {} } — volta a perguntar o nome mas NÃO limpa dosagem, horarios,
pares_posologia, unidade_dose, unidade_estoque, gotas_por_ml, tipo_tratamento nem
estoque_resolvido do medicamento anterior. Se o usuário trocar de remédio ali, o cadastro segue
com os dados do remédio errado. Fora de cad_confirmacao (cad_dosagem, cad_horarios etc.) não
existe nem o caminho de correção de nome — a frase cai em indeterminado e a etapa repete a
pergunta. CAUSA RAIZ CONFIRMADA por leitura de código (v35). MANIFESTAÇÃO OBSERVADA em produção
26/08 18:16: em cad_dosagem, "Não é esse remédio, é outro" e em seguida "Toragesic" caíram
ambos em ruido e a etapa repetiu a pergunta. DECISÃO DE GUILHERME NA v35: NÃO corrigir agora —
o cadastro funciona bem e um reset mal delimitado arriscaria desfazer a captação de dados
construída nas Partes B/B.2/B.3. Por isso a Parte B.1 classifica deliberadamente "não é esse
remédio, é outro" como ruido, nunca como nova_intencao (seção 3.4 de BRIEFING_MH073_B1.md). Ao
implementar este MH, revisar essa classificação junto e revisitar o cenário de reentrada
cadastro->cadastro, que passa a ser alcançável.
```

---

## TAREFA 3 — Commit e push

```
git add CONTEXT.md
git commit -m "docs: encerramento v35 — MH-073 B.1 + BUG-101, modelo canônico de escalada (princípios 52-53)"
git push origin main
```

---

## Estado do projeto ao fim da v35

Quatro requisitos para o beta: **MH-072** concluído (v31); **MH-073** avançou com a Parte B.1,
restam Partes C, D e E; **MH-040** (mensagens fragmentadas) e **MH-009** (dashboard admin)
seguem abertos.

Backlog: consultar `backlog_items` no início da próxima sessão. Não replicar aqui.