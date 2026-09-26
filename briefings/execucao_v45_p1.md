# BRIEFING DE EXECUÇÃO — v45 · P1: o principal vira a porta única

**Pré-requisito:** P0 com o `BASELINE.md` commitado (o adaptador `principal_p1` do corpus é ligado neste marco).
**Branch:** `staging`; promoção isolada. **Migração de banco** (§8) aplicada em staging no início e em produção **antes** do merge.
**Governança:** nenhuma escrita em `backlog_items` a partir deste briefing (§12 depende do "sim, registra").
**Diretriz de custo:** casos afetados por commit; suíte completa UMA vez, no portão; corpus sob demanda, no fim. Validação de comportamento é manual, pelo Guilherme.
**Feature inegociável (Guilherme, 26/09):** confirmação de dose correta e confiável, inclusive retroativa. Nenhuma mudança deste marco pode degradá-la; cada commit que toca dose roda A4, A5, A30 e os casos novos de dose.

---

## 0. Por que este marco existe

O desenho aprovado na v44 diz: **o principal é a porta única** — o LLM capta a conversa, interpreta, extrai com base no inventário e age no próprio domínio ou delega ao especialista, que age e devolve. O que foi implementado no M1 é diferente. Na frente de tudo, atalhos por lista de palavras decidem; depois um classificador separado (`interpretarTurno`) propõe uma intenção; um despacho com quatro regras (S1–S4) sobrepõe essa intenção; e o principal é um dos agentes, chamado **sem** o lembrete, sem a mensagem citada e sem os campos extraídos.

Evidência de produção, confirmada em código, banco e logs do Railway:

| Caso | O que aconteceu | Causa |
|---|---|---|
| João 24/09 08:43 — "Yes" | "não há dose pendente"; a dose de hoje ficou sem registro | "Yes" fora da lista; porta → principal (log 11:43:39); principal sem o lembrete no contexto e com dois blocos de dose de sentido sobreposto |
| João 26/09 12:01 — "Ontem eu tomei" | confirmou a dose de **hoje** | atalho de resposta tardia testa "contém 'tomei'" e confirma a dose mais recente sem ler "ontem" |
| Guilherme 26/09 13:21 — "Yes" | repetiu a pergunta de estoque; dose pendente ficou aberta | porta propôs `principal` (certo); S1 jogou para `cad_estoque`; classificador → `ruido` |
| Guilherme 26/09 13:25 — "Yes" **citando o lembrete** | idem | citação resolvida no funil e porta extraiu "Ômega 3" (certo); o atalho de citação exige a lista; S1 derrubou de novo |
| Fran 24/09 07:03 e 19:56 — "Quero cadastrar mais um!" | repetiu a pergunta de estoque | classificador → `nova_intencao` (certo); a escalada trata "cadastro sem medicamento diferente nomeado" como continuação |
| Fran 22/09 — "Erro" | repetiu o convite de estoque | S1 + classificador sem lugar para "você errou" |
| Fran 22/09 — "a B12 é uma vez por semana…" | virou estoque 12 | porta propôs `configuracao` (certo); S4 (`/\d/`) sobrepôs |
| Eloísa 22–26/09 — "Sim" ×5 | "estarei aqui quando o remédio chegar"; 5 doses como `sem_estoque` | lembrete diz que não pode registrar; o principal não trata a confirmação |
| Flávia 24/09 — "Comprei 60 comprimidos / Sim" | dose confirmada, compra perdida | atalho testa "contém 'sim'" |

Nos cinco turnos com log do Railway, a interpretação por LLM acertou todos, e o código derrubou todos. Nas 140 respostas que passaram pelos atalhos, os 137 casos em que a mensagem **era** a palavra deram certo; os 3 em que a mensagem **continha** a palavra e mais alguma coisa deram errado.

## 1. A ordem nova do `routeMessage` (usuário onboarded)

1. Fila, janela de agregação e dedupe — **sem mudança**.
2. Resolução da citação no funil — **sem decisão**: só anexa ao contexto qual envio foi citado e, se for lembrete, qual grupo de doses.
3. Onboarding de quem não é onboarded — **sem mudança** (vai para o P5).
4. Estado `aguardando_confirmacao_exclusao` — **sem mudança** (resposta ao passo de segurança).
5. **Atalho exato de dose** (§2) — confirma sem LLM ou passa adiante.
6. **Principal** — a única chamada de interpretação (§3 a §5).
7. Execução pelo código: ações de dose (§6) e delegação ao especialista (§7).

**Saem** do caminho, com grep-guard no A0 garantindo que não voltam:

- `detectarConfirmacaoDose` como decisor, e com ele `confirmarDosePendenteDeterministico`, `tentarConfirmarRespostaTardia` e o atalho de citação + confirmação;
- o ramo de aceite pós-onboarding por `isAffirmativeSimple` (a `mensagem_rica` passa a ser contexto do principal);
- o pré-filtro `pareceExclusaoConta` (o principal delega `excluir_conta`; `confirmarIntencaoExclusaoConta` e o passo de confirmação continuam);
- o ramo de `isCancelamento` do estado `aguardando_escolha_tratamento` (vira pendência no contexto do principal);
- `interpretarTurno` como chamada separada, e com ela a reinterpretação `excluirPrincipal` do contrato de devolução;
- as regras S1–S4 de `despacharPorProposta` e a regra "cadastro sem medicamento diferente = mantém o fluxo" da escalada do cadastro.

O que não interpreta linguagem permanece. O que interpretava linguagem antes do principal sai.

## 2. Atalho exato de dose

Confirma sem chamada de LLM **somente** quando as quatro guardas valem. Qualquer uma que falhe leva o turno ao principal.

1. **Mensagem idêntica** a uma entrada da lista, depois de normalizar: minúsculas, sem acento, sem pontuação e emoji nas bordas, espaços colapsados e **letras repetidas reduzidas** ("Simmm" → "sim"; a Eloísa escreve assim).
   Lista, **só positiva** (decisão de 26/09): `sim`, `s`, `tomei`, `tomei sim`, `ja tomei`, `ja tomei sim`, `ok tomei`. Toda negativa vai ao principal ("Não" da Fran em 26/09 queria dizer "ainda não").
2. **Existe dose candidata**: grupo com lembrete enviado e sem resposta; ou grupo esgotado (`nao_informado`) ou `sem_estoque` cujo lembrete é posterior ao último turno do usuário e está dentro de 24h; ou o grupo do lembrete citado.
3. **Um único grupo candidato** (mesmo horário, mesmo dia — MH-032). Dois grupos candidatos (ex.: 08h esgotada e 12h pendente) → principal.
4. **Nenhuma outra pergunta aberta**: estado `idle`. Coleta, configuração ou pergunta de relatório em aberto → principal, que vê as duas pendências.

Execução: a mesma tabela de status do §6 e a mesma confirmação por template do §6.3. O atalho registra em `agent_logs` com `agent = 'atalho_dose_exato'`.

## 3. O que o principal recebe

Montado por código, em blocos, nesta ordem:

**3.1 Agora.** Data, dia da semana e hora de Brasília (já existe).

**3.2 Doses — um bloco único.** Substitui os três blocos atuais (pendentes, retroativas, confirmadas hoje).

- **Seleção:** doses de hoje, ontem e anteontem cujo lembrete já saiu, incluindo `sem_estoque`. Ficam de fora as pausadas e as futuras de hoje.
- **Agrupamento:** por dia e, dentro do dia, por horário (o grupo do lembrete).
- **Rótulos calculados pelo código:** "hoje · sáb 26/09" (usar `calcularRotuloDia`).
- **Referências curtas por turno:** D1, D2, D3…; o código guarda o mapa ref → `dose_logs.id` só para este turno. Nenhum UUID vai ao LLM.
- **Status em linguagem de negócio:** aguardando resposta (tentativa n de 3), sem resposta (esgotada), confirmada (hora), não tomada, sem estoque registrado.
- **Cabeçalho:** o último lembrete enviado (quando, tentativa, grupo) e a mensagem citada (qual grupo), quando houver.

```
DOSES — agora: sábado 26/09, 13:25
Mensagem citada: lembrete de hoje 12:58 → grupo 12:58
Último lembrete: hoje 12:58 (1ª tentativa) → grupo 12:58

HOJE · sáb 26/09
  06:58  [D1] Creatina · 1 unidade · confirmada 12:27
         [D2] Aerolin spray · 1 unidade · confirmada 12:27
  12:58  [D3] Ômega 3 · 1 cápsula · aguardando resposta (1 de 3)
```

**3.3 Pendência aberta.** Quando o estado não é `idle`: fluxo, etapa, a pergunta que ficou aberta (o último texto da Nami) e se ela é obrigatória ou opcional, lido do schema (nível do campo). Para `post_onboarding`, entra a `mensagem_rica` preservada.

**3.4 Eventos proativos desde o último turno** (`getContextoProativoRecente`, hoje entregue só à porta).

**3.5** Medicamentos cadastrados, inventário (três listas) e histórico — como hoje.

## 4. O que o principal devolve (tool-use)

Evolução da ferramenta `responder_usuario`, absorvendo o contrato da porta:

```
{
  tipo: "responder" | "dose" | "delegar" | "perguntar",
  message: string,                    // responder/perguntar; vazia em dose/delegar puros
  doses: [{ ref: "D2", fato: "tomou" | "nao_tomou" | "desfazer" }],
  delegar: {
    especialista: "cadastro" | "configuracao" | "relatorios" | "excluir_conta" | "nao_suportado",
    relacao_pendencia: "responde" | "novo" | "sem_pendencia",
    campos: { medicamentos, horarios, medicamento, expressaoData, subtipo }  // os campos atuais da porta
  },
  actions: [...],                     // as demais ações do domínio do principal (UPDATE_STOCK, SET_USER_NAME) — sem mudança
  feedback, mensagem_citada_relevante
}
```

- Um turno pode ter `doses` **e** `delegar` ou `actions` (ex.: "Comprei 60 comprimidos / Sim" → dose + UPDATE_STOCK). Execução: doses primeiro, depois ações, depois delegação; a resposta concatena na mesma ordem.
- `perguntar` quando não dá para saber a qual dose a pessoa se refere: a mensagem cita as candidatas.
- `CONFIRM_DOSE`, `CONFIRM_RETROATIVA`, `REGISTER_NAO_TOMADO` e `REVERSE_CONFIRMATION` saem do vocabulário do LLM. Ele relata o fato; o código escolhe a função (§6).

Regras novas do prompt:

- "Erro", "tá errado" e similares **sem** dizer o quê → `perguntar` o que ficou errado. Se o erro vier apontado, na mesma mensagem ou na seguinte → `delegar configuracao` (decisão de 22/09).
- Pedido de cadastrar outro medicamento durante uma coleta → `delegar cadastro, relacao_pendencia: novo`, mesmo sem nome.
- Confirmação de dose vence a pendência de coleta (regra 5). Com as duas abertas e a mensagem ambígua → `perguntar` em uma linha (P6.1).

## 5. Modelo

Continua `claude-sonnet-4-6`. Ao fim do marco, o corpus roda com o adaptador `principal_p1` nos dois modelos (`claude-sonnet-4-6` e `claude-sonnet-5`), e o resultado vai para o Guilherme decidir. Nenhuma troca de modelo sem essa medição (decisão da v42).

## 6. Execução das doses pelo código

**6.1 Validação.** Toda `ref` precisa estar no mapa do turno. Referência fora do mapa, ou combinação fora da tabela abaixo, não é executada: o turno vira pergunta segura e gera `degradar()` com motivo `ref_dose_invalida`. As funções de dose passam a checar também dono e status (hoje `confirmDoseByLogId` não checa nenhum dos dois).

**6.2 Tabela status × fato.**

| Status | tomou | não tomou | desfazer |
|---|---|---|---|
| aguardando resposta | `confirmDoseByLogId` | `registrarNaoTomado` | — |
| sem resposta (`nao_informado`) | `confirmarDoseRetroativa` | `registrarNaoTomado` | — |
| sem estoque | confirma **e estoque → nulo** (§6.4) | mantém `sem_estoque` | — |
| confirmada | — | — | `reverterConfirmacao` |
| não tomada | confirma (correção) | — | — |

**6.3 Confirmação por template.** O texto de confirmação é montado a partir de uma leitura do banco **depois** da gravação (P56) e diz qual dose e de qual dia: "{medicamento} de {rótulo do dia} ({data}, {hora}) confirmada". O texto final é provisório até a sessão de copy.

**6.4 Estoque contestado (decisão de 26/09).** Quando a pessoa confirma uma dose de um medicamento com `estoque_atual <= 0`, a palavra dela prevalece: o estoque passa a **nulo** (desconhecido), e o comportamento de estoque nulo que já existe assume — convite sem insistência, e o scheduler para de criar `sem_estoque`. Movimento registrado com o tipo novo `estoque_contestado` (§8).

## 7. Delegação ao especialista

Usa as mesmas entradas de hoje (`entrarNoCadastro`, configuração, relatórios, exclusão), **sem** as regras S1–S4:

- `relacao_pendencia: responde` → o runner continua a coleta aberta;
- `relacao_pendencia: novo` durante uma coleta → cadastro novo, fechando o anterior pela verdade do banco (mecanismo do MH-83 que já existe);
- quando o runner devolve (`escalarParaRoteador`), o turno volta **uma vez** ao principal, com a informação de que o especialista devolveu; na segunda devolução → pergunta segura. Sem pingue-pongue.

Os especialistas continuam relendo o texto por dentro até o P3 e o P4. Isso é esperado neste marco.

## 8. Migração de banco (staging no início; produção antes do merge)

```sql
ALTER TABLE stock_movements ALTER COLUMN estoque_novo DROP NOT NULL;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_tipo_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_tipo_check CHECK (tipo = ANY (ARRAY[
  'cadastro_inicial','cadastro_substituicao','reativacao_com_estoque','recompra',
  'correcao_soma','correcao_subtracao','correcao_set',
  'dose_confirmada','dose_retroativa','dose_revertida','estoque_contestado']));
```

Idempotência documentada no arquivo de migração (padrão das migrações exclusivas).

## 9. Arnês

**Casos novos** (conversas reais; asserções sobre o banco e o texto, nunca sobre o nome do agente):

| Caso | Entrada | Asserção central |
|---|---|---|
| A37 | João 24/09: "Yes" com a dose de hoje esgotada | dose de hoje confirmada |
| A38 | João 26/09: "Ontem eu tomei" com três esgotadas | **só** a de ontem confirmada; a de hoje segue aberta; texto cita o dia |
| A39 | Guilherme 26/09: "Yes" com dose pendente durante `cad_estoque` | dose confirmada; retoma o convite de estoque |
| A40 | Guilherme 26/09: "Yes" citando o lembrete | a dose do grupo citado confirmada |
| A41 | Eloísa: "Simmm" com dose `sem_estoque` | dose confirmada; estoque nulo; movimento `estoque_contestado`; **nenhuma chamada de LLM** (atalho) |
| A42 | Flávia: "Comprei 60 comprimidos / Sim" | dose confirmada **e** estoque atualizado |
| A43 | Fran: "Não" após lembrete | nenhuma dose marcada como não tomada |
| A44 | Fran: "Quero cadastrar mais um!" em `cad_estoque` | cadastro novo aberto; convite anterior encerrado |
| A45 | Fran: "Erro" após cadastro | pergunta o que ficou errado; não repete o convite |
| A46 | Fran: "A vitamina b12 é uma vez por semana…" em `cad_estoque_lote` | vai à configuração; estoque da B12 intocado |
| A47 | "sim" simples, um grupo pendente, estado `idle` | dose confirmada **sem chamada de LLM** |

**Casos existentes que precisam continuar verdes:** A4 (regra 5), A5 (estoque baixo, autor único do número) e A30 (dupla pendência) — rodar a cada commit que toca dose. A suíte inteira, uma vez, no portão.

## 10. Medição

- Todo turno registra quantas chamadas de LLM fez (novo campo em `observabilidade`, ou linha de log padronizada).
- Ao fim, o corpus roda com `principal_p1` e compara com o `BASELINE.md` do P0, por categoria.

## 11. Critérios de aceite

- Casos A37–A47 verdes; A4, A5, A30 verdes; suíte completa verde no portão, sem expected-fail novo.
- Grep-guard no A0: nenhuma chamada a `interpretarTurno`, `confirmarDosePendenteDeterministico`, `tentarConfirmarRespostaTardia`, `pareceExclusaoConta` ou `isAffirmativeSimple` no caminho do `routeMessage`; `detectarConfirmacaoDose` não existe mais como decisor.
- Nenhum UUID de dose no prompt do principal.
- Corpus: `principal_p1` ≥ baseline em todas as categorias de `dose` e `delegacao`; resultado dos dois modelos entregue ao Guilherme.
- Migração do §8 aplicada em produção antes do merge.

## 12. Pendências que dependem do Guilherme

**Copy, antes da promoção** (sessão dedicada):
- o lembrete de estoque zerado — a frase "não foi possível registrar a dose" fica **falsa** depois deste marco;
- o texto de confirmação com dose e dia (§6.3);
- a pergunta quando não se sabe a qual dose a pessoa se refere;
- a resposta a "Erro" sem indicação;
- o convite de estoque depois do estoque contestado.

**Registros de backlog propostos** (só com "sim, registra"):
- BUG — confirmação de dose por lista de palavras engole mensagens com conteúdo adicional (João 26/09, Flávia 24/09, Julia 11/07);
- BUG — "Yes" com dose aberta não é confirmado; o principal não recebe o lembrete nem a citação (João 24/09, Guilherme 26/09);
- BUG — pedido de novo cadastro durante o convite de estoque vira continuação (Fran 24/09, Sid);
- ACH — doses `sem_estoque` com confirmação do usuário distorcem a métrica de doses perdidas por falta de estoque (§13.5 do CONTEXT.md: Eloísa 4 de 4).

## 13. Fora de escopo

Extração estruturada no principal (P2); cadastro e correção consumindo essa extração (P3, P4); onboarding dentro do principal, datas de relatório e resto da configuração (P5); e a copy (§12).