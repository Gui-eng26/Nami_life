# BRIEFING — MH-072 Parte B
## Reestruturação do recepcionista: separação classificação/geração + MH-074 (caminho do curioso)

**Sessão:** v31
**Status:** aguardando execução no Claude Code — **executar depois da Parte B.0**
**Depende de:** MH-072 Partes A / A.1 / A.2 (validadas em produção na v30) e **Parte B.0** (BUG-88 — ✅ executada e validada em produção em 13/08/2026)
**Resolve:** BUG-30, MH-074, e o alvo declarado de `estadoPosOnboarding.js`
**Arquivos tocados:** `src/agentes/recepcionista.js`, `src/estadoPosOnboarding.js`, `src/agentes/data_nascimento.js` (item 8 apenas)

> **Ordem de execução:** a Parte B.0 (BUG-88 — consentimento LGPD) toca o mesmo `recepcionista.js` e já entrega o padrão classificador→gerador nele. Executar B.0 primeiro evita conflito e dá base pronta para os classificadores desta parte.

---

## 1. Objetivo

Eliminar da raiz a classe de defeito "lista de palavras decidindo fluxo" no onboarding, aplicando o mesmo padrão que a Parte A validou em `data_nascimento.js`: **classificação semântica dedicada, separada da geração de texto**, com tipo semântico de retorno (nunca booleano de validade — princípio 14).

Sobre essa base, implementar o **MH-074**: quem chega apenas curioso não deve ser empurrado para nome + LGPD + cadastro sem ter demonstrado interesse de uso.

---

## 2. Causa raiz (confirmada por leitura de código)

O `recepcionista.js` **já classifica** a intenção inicial em `CADASTRAR | DESCOBRIR | NEUTRO` — mas dentro do mesmo prompt que gera a resposta (`buildSystemPrompt`, linhas 70-87). O resultado só ajusta o **tom** e é descartado: toda categoria termina na mesma instrução, *"Em todos os casos: termine pedindo o nome do usuário"* (L119).

Consequência: a classificação existe mas **não tem poder de decisão sobre o fluxo**. Não há caminho possível para o curioso, porque não há mecanismo que leia a classificação e ramifique.

As decisões de fluxo que existem são todas tomadas por listas de palavras, fora da LLM:

| Função | Local | Mecanismo | Defeito |
|---|---|---|---|
| `pareceNome()` | `recepcionista.js:28` | lista de exclusão (só sabe reconhecer sinais de remédio) | **BUG-30** — `"Sim, quero continuar"` vira nome |
| `isLgpdAccepted()` | `recepcionista.js:13` | `includes` sobre keywords, incluindo `'s'` | **BUG-88** — recusa vira aceite. *Tratado na Parte B.0* |
| `contemRecusa()` | `recepcionista.js:18` | lista de inclusão | inalcançável quando o anterior dá falso positivo. *Tratado na Parte B.0* |
| `querCadastrar` | `estadoPosOnboarding.js:19` | lista de 8 palavras | `"quero começar"` → `post_onboarding` errado |

São quatro instâncias da mesma classe de problema no mesmo fluxo. A Parte B trata a classe, não os casos.

---

## 3. Escopo

### Entra
1. Classificador semântico de intenção inicial (separado da geração)
2. MH-074 — estado `recep_apresentacao` e caminho do curioso
3. MH-074 — estado terminal `apresentacao_declinada` com reconhecimento no retorno
4. BUG-30 — substituição de `pareceNome()` por extrator semântico com valor
5. `querCadastrar` — substituição por classificador semântico
6. Negrito em **DIA** / **MÊS** / **ANO** nas perguntas de `data_nascimento.js` (requisito da v30)

### NÃO entra
- **Classificador de consentimento LGPD** (`isLgpdAccepted` + `contemRecusa`) — **antecipado para a Parte B.0** (BUG-88), por ser defeito crítico bloqueante de beta. Ao iniciar esta parte, essas funções já não existirão no arquivo.
- **Retenção de dados de não-convertidos** — decisão explícita de Guilherme (v31): nada muda no que já é guardado. `getOrCreateUser` continua criando a linha em `users` na primeira mensagem. Nenhum dado novo é coletado e nenhum dado existente é apagado.
- **BUG-27** — investigado na v31 e descartado do escopo. A retomada da mensagem inicial é determinística: `nasc_fechamento` injeta `MENSAGEM ORIGINAL` literalmente no prompt (`data_nascimento.js`), validado nos testes da v30.
- **Propagação de `capacidade_mencionada`** — descartado. Não existe destino alternativo: quem aceita o convite entra obrigatoriamente no fluxo completo.
- BUG-86 / BUG-87 — seguem pausados.

### Observação registrada, sem ação
`definirEstadoPosOnboarding` grava `context: { etapa: 'cad_nome' }` e **descarta** `mensagem_inicial` na transição para `adding_med`. De lá em diante `cadastro.js` depende só de `historicoConversa`. Sem sintoma observado — fragilidade latente, não bug. Não tratar nesta parte.

---

## 4. Arquitetura — máquina de estados

### 4.1 Princípio estruturante

Toda etapa segue a mesma sequência, **nesta ordem**:

```
mensagem → classificador dedicado (max_tokens baixo, categoria fechada)
         → decisão de próximo estado (código, determinístico)
         → gerador de texto (chamada separada, já sabendo o destino)
```

Nunca classificar dentro do prompt de geração. Nunca decidir fluxo com lista de palavras.

### 4.2 Fluxo completo

```
[1ª mensagem]
      │
      ▼
classificarIntencaoInicial → cadastrar | descobrir | neutro
      │
      ├── cadastrar / neutro ──────────────► recep_boas_vindas  (pede nome — comportamento atual)
      │
      └── descobrir ──────────────────────► recep_apresentacao  (NOVO)
                                                   │
                                          classificarRespostaConvite
                                                   │
                        ┌──────────────────────────┼──────────────────────┬──────────────┐
                        ▼                          ▼                      ▼              ▼
                   afirmativo                  negativo              nova_duvida       ruido
                        │                          │                      │              │
                        ▼                          ▼                      ▼              ▼
              recep_boas_vindas          apresentacao_declinada    permanece em    permanece,
               (pede nome)                     (NOVO)              recep_apresentacao  +1 teto
                        │                          │
                        │                    [usuário volta]
                        │                          │
                        │                classificarRespostaConvite
                        │                          │
                        │                  afirmativo → recep_boas_vindas
                        │                  nova_duvida → recep_apresentacao
                        │                  demais → permanece (acolhe, sem pressão)
                        ▼
              recep_coleta_nome → recep_lgpd → coletando_nascimento → definirEstadoPosOnboarding
                                                                              │
                                                              classificarDestinoPosOnboarding
                                                                    │                    │
                                                                adding_med        post_onboarding
```

**Ponto crítico:** a partir de `recep_boas_vindas`, o fluxo é o **atual, sem alteração**. Não existe caminho que pule nome, LGPD ou data de nascimento. O MH-074 adiciona uma antessala, não uma rota alternativa.

---

## 5. Especificação por item

### Item 1 — `classificarIntencaoInicial`

Função nova em `recepcionista.js`. Roda **apenas no turno 1** (quando `!context.etapa`).

- **Entrada:** `message` (= `mensagem_inicial`)
- **Categorias:** `cadastrar` | `descobrir` | `neutro`
- **Fallback em erro:** `neutro` (via `degradar()`, mesmo padrão de `classificarIndeterminado`)
- **Retorno usado para:** escolher entre `recep_boas_vindas` e `recep_apresentacao`

Definições para o prompt:
- `cadastrar` — pedido ativo de uso. *"quero cadastrar meu remédio"*, *"me ajuda com a losartana"*, *"preciso tomar nimesulida de 12 em 12h"*
- `descobrir` — curiosidade sobre o que a Nami é ou faz, **sem pedido de uso**. *"pra que você serve?"*, *"o que você faz?"*, *"você serve pra cadastrar remédio?"*, *"você consegue me ajudar com lembretes?"*, *"me mandaram esse número"*
- `neutro` — saudação ou mensagem sem intenção discernível. *"oi"*, *"bom dia"*, *"tudo bem?"*

**Fronteira que precisa estar explícita no prompt:** *"você serve pra X?"* é `descobrir` (especulação). *"quero X"* é `cadastrar` (pedido). A diferença é pergunta sobre capacidade vs. solicitação de uso.

Remover do `buildSystemPrompt` o bloco `CLASSIFICAÇÃO DE INTENÇÃO` (L70-87). A intenção passa a chegar pronta, no `context`, como `intencao_inicial`.

### Item 2 — Estado `recep_apresentacao` (MH-074)

**Texto gerado (etapa `recep_apresentacao`), em uma única mensagem:**

1. Responder **especificamente** à pergunta feita, citando-a. Se a pergunta foi *"você serve pra cadastrar remédio?"*, começar por *"sim, eu ajudo você a cadastrar os horários dos seus remédios"*.
2. Complementar com as demais capacidades (lembretes nos horários, confirmação de dose, controle de estoque, acompanhamento de adesão, visibilidade para quem cuida de familiar).
3. Fechar com **convite explícito** para começar a usar.

Tom: caloroso, sem jargão, sem pressão. O convite é oferta, não funil.

**Restrições absolutas nesta etapa:**
- NÃO pedir o nome
- NÃO mencionar LGPD, dados ou consentimento
- NÃO iniciar cadastro de medicamento

`context` do estado:
```js
{
  etapa: 'recep_apresentacao',
  mensagem_inicial: <preservada>,
  intencao_inicial: 'descobrir',
  tentativas_ruido: 0
}
```

### Item 3 — `classificarRespostaConvite`

Roda nas etapas `recep_apresentacao` e `apresentacao_declinada`.

- **Categorias:** `afirmativo` | `negativo` | `nova_duvida` | `ruido`
- **Contexto no prompt:** conversa recente (`formatarHistoricoConversa`) — a resposta é sempre relativa ao convite do turno anterior
- **Fallback:** `ruido`

Definições:
- `afirmativo` — aceita começar. *"sim"*, *"quero"*, *"bora"*, *"vamos lá"*, *"pode ser"*, *"como faço?"*, *"quero cadastrar meu remédio"*
- `negativo` — recusa ou adia. *"não"*, *"agora não"*, *"só estava olhando"*, *"depois eu vejo"*
- `nova_duvida` — outra pergunta sobre a Nami, sem aceitar nem recusar. *"e é de graça?"*, *"funciona pra meu pai?"*, *"precisa instalar app?"*
- `ruido` — incompreensível ou fora de contexto

**Tratamento de `nova_duvida`:** responde a dúvida e **reoferece** o convite, de forma mais leve a cada rodada. **Não conta para o teto** — servir a curiosidade é o propósito da etapa; limitar perguntas contradiz o MH-074.

**Teto:** `tentativas_ruido` incrementa **só** em `ruido`. Em 3, encerra em `apresentacao_declinada` com despedida gentil (saída de emergência obrigatória — mesmo padrão da Parte A.1 item 6).

### Item 4 — Estado `apresentacao_declinada` (MH-074)

Estado terminal do curioso que declinou. Espelha `lgpd_recusado`, que já é padrão validado em produção.

**Ao entrar:** despedida gentil, sem insistência, deixando a porta aberta.

**Ao retornar** (usuário volta em conversa futura): reconhecer o retorno com calor, sem recapitular a recusa como cobrança. Reclassificar com `classificarRespostaConvite`:
- `afirmativo` → `recep_boas_vindas` (pede nome, fluxo normal)
- `nova_duvida` → volta a `recep_apresentacao`
- `negativo` / `ruido` → permanece, acolhe sem pressionar

**Detalhe obrigatório:** quando o retorno for `afirmativo` ou trouxer pedido novo, **substituir `mensagem_inicial` pela mensagem atual**. A retomada no fechamento da data de nascimento deve ancorar no que a pessoa quer agora, não na curiosidade antiga.

`onboarded` permanece `false` em todo este caminho — o roteamento continua caindo no bloco 1 do `router.js`, sem alteração no roteador.

**Métrica de conversão:** o estado é contável direto em `conversation_state`. Nenhum dado adicional coletado.

### Item 5 — BUG-30: extrator de nome

Substituir `pareceNome()` por extrator que devolve **tipo semântico + valor** (princípio 14).

- **Tipos:** `nome` | `saudacao` | `contexto_saude` | `pergunta` | `recusa` | `indeterminado`
- **Quando `nome`:** devolver também o **nome normalizado**, não a frase inteira. *"pode me chamar de Gui"* → `"Gui"`; *"meu nome é Guilherme"* → `"Guilherme"`. Hoje `nome_coletado: message.trim()` grava a frase completa.

Tratamento por tipo:
- `nome` → `recep_coleta_nome` (fluxo atual)
- `saudacao` → **não** é nome. Devolve o cumprimento e repergunta com calor: *"Oi! 😊 E como posso te chamar?"*. Permanece em `recep_boas_vindas`, conta para o teto. Evidência: em 13/08 um `"Oi"` nessa etapa foi gravado como `users.name = "Oi"`, e a Parte A.2 já tratou saudação como categoria própria no fluxo de nascimento — mesma lição
- `contexto_saude` → comportamento atual: substitui `mensagem_inicial`, marca `contexto_medicamento`, permanece em `recep_boas_vindas`
- `pergunta` → responde a dúvida e repede o nome, permanece em `recep_boas_vindas` *(hoje isso é gravado como nome)*
- `recusa` → explica com empatia por que o nome é necessário e repede; após 3, encerra em `apresentacao_declinada`
- `indeterminado` → repede com exemplo, conta para o teto

**`pareceNome` é chamada duas vezes, e as duas precisam sair.** Na captura (`recepcionista.js:297`) e de novo na gravação (`recepcionista.js:398`), esta última comentada como *"validar nome antes de salvar"*:

```js
const nomeParaSalvar = pareceNome(context.nome_coletado || '') ? context.nome_coletado : null;
```

Uma validação que reusa a mesma função que produziu o erro não valida nada — `"Oi"` passa nas duas. Com extrator tipado, a segunda chamada some: se o tipo é `nome`, o valor já está normalizado e validado.

### Item 6 — `querCadastrar` → classificador de destino

Em `estadoPosOnboarding.js`, substituir a lista de 8 palavras por classificador semântico sobre `mensagem_inicial`.

- **Pergunta:** a mensagem inicial indica intenção de cadastrar medicamento?
- **Categorias:** `cadastro` | `outro`
- `cadastro` → `adding_med` / `cad_nome`; `outro` → `post_onboarding`
- **Fallback:** `outro` (destino mais seguro — `post_onboarding` acolhe qualquer intenção)

Cobre o caso do curioso: quem perguntou *"você serve pra cadastrar remédio?"* e aceitou o convite deve terminar em `adding_med`.

Atualizar o comentário-cabeçalho do arquivo (hoje descreve a lista como alvo pendente da Parte B).

### Item 7 — Negrito nas perguntas de data de nascimento

Em `data_nascimento.js`, aplicar `*DIA*`, `*MÊS*`, `*ANO*` (negrito WhatsApp) nas perguntas de cada componente. Requisito levantado no fechamento da v30. Sem item de backlog próprio.

---

## 6. Matriz de teste

### A — Classificação inicial
| # | Mensagem | Esperado |
|---|---|---|
| A1 | "quero cadastrar losartana" | `cadastrar` → `recep_boas_vindas`, pede nome |
| A2 | "oi" | `neutro` → `recep_boas_vindas`, pede nome |
| A3 | "pra que você serve?" | `descobrir` → `recep_apresentacao` |
| A4 | "você serve pra cadastrar remédio?" | `descobrir` → apresentação **citando cadastro de remédio** |
| A5 | "você consegue me ajudar com lembretes?" | `descobrir` → apresentação **citando lembretes** |
| A6 | "me mandaram esse número" | `descobrir` |

### B — Caminho do curioso (MH-074)
| # | Cenário | Esperado |
|---|---|---|
| B1 | A4 → "sim, quero" | `recep_boas_vindas`, pede nome. **Não** grava "sim, quero" como nome |
| B2 | A3 → "não, só olhando" | `apresentacao_declinada`, despedida gentil |
| B3 | A4 → "precisa instalar app?" | permanece, responde + reoferece. `tentativas_ruido` = 0 |
| B4 | B3 → "e é de graça?" → "ok, vamos" | 2 dúvidas servidas, depois `recep_boas_vindas` |
| B5 | A3 → 3 mensagens sem sentido | encerra em `apresentacao_declinada` |
| B6 | Em `recep_apresentacao`, verificar texto | **não** pede nome, **não** cita LGPD |

### C — Retorno do declinado
| # | Cenário | Esperado |
|---|---|---|
| C1 | B2 → volta com "oi" | reconhece retorno, sem pressão |
| C2 | B2 → volta com "mudei de ideia" | `recep_boas_vindas`, pede nome |
| C3 | B2 → volta com "quero cadastrar minha metformina" | `recep_boas_vindas` **e** `mensagem_inicial` substituída |
| C4 | C3 → completa nome/LGPD/nascimento | fechamento cita **metformina** e destino `adding_med` |

### D — BUG-30
| # | Resposta ao pedido de nome | Esperado |
|---|---|---|
| D1 | "Sim, quero continuar" | **não** grava como nome; repede |
| D2 | "Oi" | **não** grava como nome; repede |
| D3 | "Guilherme" | grava `Guilherme` |
| D4 | "pode me chamar de Gui" | grava `Gui`, não a frase |
| D5 | "por que você precisa do meu nome?" | responde a dúvida e repede |
| D6 | "tomo losartana 50mg" | `contexto_saude` — comportamento atual preservado |
| D7 | "Oi" | `saudacao` — **não** grava como nome; cumprimenta e repergunta |
| D8 | "bom dia" | `saudacao` |
| D9 | "quanto custa?" | `pergunta` — responde e repede o nome |

### E — Não-regressão
| # | Cenário | Esperado |
|---|---|---|
| E1 | "quero cadastrar losartana" → fluxo completo | fechamento cita losartana, destino `adding_med` (idêntico à v30) |
| E2 | Recusa de LGPD → retorno → "mudei de ideia" | `recep_lgpd_reapresentacao` inalterado |
| E3 | Pedido de exclusão durante `recep_apresentacao` | tratado pelo bloco 3 do router |
| E4 | Coleta de data de nascimento completa | Partes A/A.1/A.2 sem regressão |

---

## 7. Riscos

| Risco | Mitigação |
|---|---|
| Fronteira `descobrir` vs. `cadastrar` mal calibrada — pedido real vira antessala | Cenários A1/A4 são o teste dessa fronteira. Se `cadastrar` virar `descobrir`, há atrito real: revisar exemplos do prompt |
| Convite repetido a cada `nova_duvida` soa insistente | Instrução explícita de suavizar a cada rodada |
| Curioso preso sem saída | `tentativas_ruido` com teto 3 |
| Aumento de chamadas de LLM por turno | Classificadores usam `max_tokens: 8`, categoria fechada. Custo marginal |
| Escopo grande num arquivo só | Validar em blocos (A→B→C→D→E) antes de fechar a parte |

---

## 8. Princípios aplicados

- **14** — extrator devolve tipo semântico, nunca booleano de validade
- **5** — nenhuma alteração no inventário central do `router.js`: com `onboarded=false`, o bloco 1 intercepta antes da classificação central. Todos os estados novos são internos ao recepcionista
- **Saída de emergência** — todo laço tem teto e destino terminal (Parte A.1 item 6)
- **Degradação explícita** — todo classificador usa `degradar()` com fallback nomeado

---

## 9. Decisões fechadas na v31

1. **LGPD** — antecipado para a Parte B.0 (BUG-88), autorizado e registrado
2. **Nome do estado terminal do curioso** — `apresentacao_declinada`, confirmado
3. **Split** — Parte B.0 executada e validada antes desta parte