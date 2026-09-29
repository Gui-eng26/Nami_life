# ENCERRAMENTO — v45 (22 a 29/09/2026): o principal como porta única

**Execução:** "Leia o `briefings/encerramento_v45.md` e execute."
**Onde:** tudo em `main` (o `CONTEXT.md` só é editado em `main`); ao final, merge `main` → `staging`.
**Governança:** as atualizações do §4 têm evidência de produção. As inserções do §5 **só entram se o Guilherme tiver dito "sim, registra"** — se ele não confirmar na conversa com você, pule o §5 inteiro e avise.

---

## 1. Renumeração da sessão do Mescla (v45 → v46)

A sessão de 26/09 (entregáveis da etapa Traction, definições de métrica, cor creme) correu em paralelo a esta e foi registrada como v45. Esta sessão técnica tem nove briefings de execução, dezenas de commits e oito itens de backlog como v45; a do Mescla tem três marcas. Decisão do Guilherme (29/09): a do Mescla passa a **v46**.

1. `git mv briefings/encerramento.v45.md briefings/encerramento_v46.md` (corrige também o nome fora do padrão).
2. No arquivo renomeado: título "Encerramento v46 — 26/09/2026", e logo abaixo a nota:
   > Registrada originalmente como v45 (commit `1eb3e65`) e renumerada em 29/09: correu em paralelo à v45 técnica (22–29/09, principal como porta única). A data desta sessão é anterior ao fim da v45; a numeração segue a sessão, não a data de fechamento.
3. `CONTEXT.md`: título da §13 passa a "## 13. v46 — Definições de métrica de base (26/09/2026)".
4. `backlog_items` MH-98: no título, "definições de métrica da v45" → "definições de métrica da v46".
5. A mensagem do commit `1eb3e65` não se altera (histórico do git não se reescreve).

A próxima sessão é a **v47**.

## 2. `CONTEXT.md` — edições

### 2.1 Cabeçalho

`**Última atualização:** 29/09/2026 (v45 — o principal como porta única EM PRODUÇÃO, ver §14)`

### 2.2 Mapa de arquivos (§2)

- `src/principal.js` (em `agentes/`): passa a ser descrito como **a porta única** — uma chamada de interpretação por turno, contexto completo, decisão por tool-use.
- `src/contratoPrincipal.js` — **NOVO v45**: definição única do contrato de decisão do principal (tipos, regras por tipo), lida pelo prompt e pelo validador.
- `src/dosesDoTurno.js` — **NOVO v45**: bloco único de doses do turno (refs D1…), tabela status × fato, execução e texto da confirmação.
- `src/porta.js`: "legado residual — `interpretarTurno` ainda usado no absorver do onboarding (sai no P5/R2); `limparDosagemDoNome` usado pelo principal". Não é mais a porta.

### 2.3 Princípios (§5) — acrescentar depois do P58

- **P59 — linguagem aberta nunca é interpretada por regex ou lista de palavras.** O LLM interpreta e extrai; o código valida (formato, ancoragem, representabilidade) e decide. Única exceção: o atalho de dose por **igualdade exata** com a lista positiva curta, sob quatro guardas de estado (§14.2). Evidência: "6:30h" → 06:00, "segundas" → todos os dias, "b12" → estoque 12, "Ontem eu tomei" confirmando a dose de hoje.
- **P60 — atuar na motivação, nunca na palavra.** Correções e regras novas partem da intenção por trás da interação. Nenhum texto ou comportamento é acionado por palavra isolada ("Erro", "posso") — isso é regex com outra roupa.
- **P61 — um fato, um autor, também no texto.** Quando o fato é do código, o texto também é. Nunca filtrar o texto do LLM por regex para esconder um fato duplicado.
- **P62 — contrato num lugar só.** Prompt e validador leem a mesma definição, e um teste sem LLM garante que toda combinação instruída pelo prompt é aceita (origem: turno de estoque degradado em 29/09).
- **P63 — a palavra da pessoa prevalece sobre o dado registrado.** Dose confirmada com estoque ≤ 0 é aceita e o estoque passa a nulo (desconhecido).
- **P64 — "ainda não" por padrão.** FAZ e NUNCA são listas fechadas; todo pedido de capacidade fora delas é "ainda não", respondido com honestidade (nunca "não entendi") e registrado como demanda (`system_events`, `intencao_nao_suportada`).

### 2.4 §12.1 — nota no topo (não reescrever a seção)

> **Superado na entrada pela §14 (v45, 29/09):** os fast-paths por lista, a porta como chamada separada do principal e as regras que sobrepunham a porta saíram. O restante desta seção (funil, runner, inventário, autoria de fatos, vocabulário) continua valendo.

### 2.5 Nova §14 — acrescentar depois da §13

```markdown
## 14. v45 — O principal como porta única: EM PRODUÇÃO (29/09/2026)

Origem: os usuários do beta que ficaram para trás (Aline, Priscila, Manô, Thaielly, Fran).
Para oferecer a eles a correção do que a Nami errou, a Nami precisava de fato acertar esses
casos — e o diagnóstico da Fran (22/09) mostrou que a entrada do M1 não era a arquitetura
aprovada na v44: atalhos por lista de palavras decidiam antes de tudo, a "porta" era um
classificador separado do principal, quatro regras de código sobrepunham a interpretação, e
o principal era chamado sem o lembrete, sem a citação e sem o que a porta extraiu.
Nos turnos com log do Railway, a interpretação por LLM acertou todos e o código derrubou todos.

### 14.1 Entregas

| Entrega | Commit em `main` | O que fez |
|---|---|---|
| Microentrega | — | 12 estados legados `recep_*` migrados para a etapa equivalente do onboarding (pergunta pendente preservada); A36 |
| P0 | — | corpus `arnes/corpus/` (71 itens reais), baseline sem API |
| Hotfix | `a391b6c` | encerrar tratamento fecha a dose pendente (`pausado`); follow-up só de remédio ativo (BUG-108) |
| P1 + copy + ajustes 1–3 | `d9a634a` | o principal como porta única (abaixo) |

### 14.2 Arquitetura entregue

- **Ordem do turno (onboarded):** fila/janela/dedupe → resolução da citação (contexto, sem
  decisão) → onboarding de não-onboarded (até o P5) → estado de confirmação de exclusão →
  **atalho exato de dose** → **principal** (única interpretação) → execução pelo código.
- **Atalho exato de dose:** confirma sem LLM só se as quatro guardas valem: mensagem
  **idêntica** a uma entrada da lista positiva (sim, s, tomei, tomei sim, já tomei, ok tomei;
  normalizada, letras repetidas reduzidas); há dose candidata; um único grupo; estado `idle`.
  Toda negativa vai ao principal.
- **O principal recebe:** histórico, lembrete/eventos proativos, mensagem citada, bloco único
  de doses (hoje/ontem/anteontem, refs curtas D1…, status em linguagem de negócio, incluindo
  sem estoque), pendência aberta (obrigatória/opcional), medicamentos, inventário.
- **O principal devolve** (contrato em `contratoPrincipal.js`): `responder`, `dose`
  (`{ref, fato: tomou|nao_tomou|ainda_nao|desfazer}`), `acao` (ação do domínio executada e
  escrita pelo código), `delegar` (especialista + relação com a pendência:
  responde|novo|sem_pendencia), `perguntar`.
- **O código:** valida ref no mapa do turno; escolhe a função pela tabela status × fato;
  grava; escreve a confirmação lendo o banco.
- **Dose com estoque ≤ 0 confirmada:** estoque → nulo, movimento `estoque_contestado`.
- **"Não tomei" com a dose aguardando resposta:** nada é gravado, as cobranças seguem; fecha
  como não tomada só com "não vou tomar"/"pulei" ou dose fora da janela.
- **"Ainda não" por padrão (P64):** texto sempre do código (rótulo do inventário ou o pedido
  nas palavras da pessoa); evento `intencao_nao_suportada` com `pedido` no payload. O principal
  identifica a motivação principal: capacidade → "ainda não"; orientação → postura do NUNCA.
- **Correção por intenção (P60):** a pessoa mostra que algo não ficou como queria → se disse o
  quê, vai a quem é dono do dado; se não disse, a Nami pergunta o que mudar.
- **Estoque, um autor (P61):** quando o principal atualiza o estoque, a resposta é do código;
  quando a pessoa responde a um convite de estoque, quem grava e escreve é o especialista.

### 14.3 Decisões de produto (Guilherme, 26–29/09)

- Confirmação de dose correta e confiável, inclusive retroativa: **inegociável**.
- Dose retroativa registra direto; o texto diz qual dose (dia e hora).
- Confirmação de hoje leva só a hora; de outro dia, rótulo + data + hora.
- Abertura variável na confirmação e no estoque (Boa / Perfeito / Isso aí / Que bom /
  Tudo certo / Show), diferente da última usada com a pessoa; a linha do fato é fixa.
- Respostas ao "não" pelo principal, sem repetir formulação recente (a Fran recebeu a mesma
  frase três vezes); dose fechada ganha a linha fixa do fato.
- Convite de cadastro único em todo cadastro novo: tudo de uma vez, obrigatórios em linhas
  (nome, quanto toma por vez, horários); fim do onboarding com a ponte para o cadastro.
- A Nami nunca usa frase no imperativo ("Pode me mandar… se quiser").
- Alertas proativos de estoque nunca são pergunta: "sim" depois de lembrete é dose.
- Recompra: o principal atualiza o estoque (`UPDATE_STOCK`).

### 14.4 Medição (corpus, `claude-sonnet-4-6`)

Dose 21/25 (produção antes: 9/25) · delegação 15/15 (antes: 7/15) · extração 26/31
(porta antiga: 24/31). Comparação com `claude-sonnet-5` adiada por decisão do Guilherme.

### 14.5 Política de testes

Casos de arnês com chamada de LLM estão bloqueados por custo (29/09): o portão roda só
verificações sem LLM, incluindo o teste de contrato do P62; comportamento dependente do LLM
é validado manualmente pelo Guilherme no staging.

### 14.6 O que continua aberto

- Recorrência no plural ("às segundas") grava todos os dias, em silêncio — cadastro unitário
  e lote (Fran 24/09, Alendronato 28/09). Produção tem o defeito desde antes do P1.
- Cadastro em lote descarta a recorrência (Fran B12 22/09, Alend D 26/09).
- Correção de uma proposta ainda não gravada é ignorada (Alend D 26/09).
- Mudar a frequência de um remédio já cadastrado não existe (MH-99; hoje responde "ainda não").
- Tom desigual: templates fora do guia de composição ("Me conta:", "unidades" para
  comprimido, formatos diferentes para o mesmo evento).
- A configuração é uma ilha: classificador, etapas e parsers próprios, fora do runner.

### 14.7 Próximos passos (acordados em 29/09)

Base antes de produto. Objetivos de produto que dependem dela: outras formas farmacêuticas
(líquido, pó, pomada/gel, adesivo, inalador), áudio e foto, cuidador.
1. Sessão de desenho do **ponto único de saída**: execução devolve fatos tipados; um
   compositor escreve a mensagem com o tom da Nami, ancorado nos fatos (fallback
   determinístico); o "sim" exato e os lembretes seguem sem LLM.
2. Entrada estruturada (principal extrai tudo, com trecho literal e ancoragem) + cadastro
   consumindo-a — fecha recorrência no plural, lote, correção de proposta.
3. Configuração migrada para o modelo de runner e schema, com mudança de frequência.
4. Catálogo de formas farmacêuticas como dado (pó e líquido primeiro).
5. Produto: foto, áudio, cuidador.
Regras de desenho desde o passo 1: "quem fala, sobre quem" nos contratos (prepara o
cuidador) e verificação do LLM que caiba no custo (contrato sem LLM a cada commit; corpus
só no fechamento de marco).
```

## 3. Commit

`docs(v45): encerramento — principal como porta única, princípios P59–P64, renumeração do Mescla para v46`
Depois: merge `main` → `staging`.

## 4. Backlog — atualizações (evidência de produção)

| Item | De | Para | Nota em `observacoes` |
|---|---|---|---|
| BUG-105 | aberto | resolvido | P1, atalho exato + principal (em produção 29/09, `d9a634a`) |
| BUG-106 | aberto | resolvido | P1, principal recebe lembrete, citação e bloco de doses |
| BUG-107 | aberto | resolvido | P1, relação "novo" com a pendência |
| BUG-109 | aberto | resolvido | P1-ajustes 1–3, um fato um autor + tipo `acao` |
| BUG-110 | aberto | resolvido | P1-ajustes 1–2, "ainda não" por padrão com texto do código |
| MH-98 | (título) | — | renumeração do §1 |

Ficam abertos: ACH-13 (regra nova impede casos novos; dados passados seguem distorcidos) e MH-99.

## 5. Backlog — inserções (SÓ com "sim, registra" do Guilherme)

| Tipo | Título | Prioridade | Evidência |
|---|---|---|---|
| BUG | Recorrência no plural ("às segundas") é gravada como todos os dias, sem aviso | alta | Fran 24/09 (Vitamina D), Alendronato 28/09 (staging) |
| BUG | Cadastro em lote descarta a recorrência | alta | Fran 22/09 (B12), Alend D 26/09 |
| BUG | Correção de uma proposta de cadastro antes de gravar é ignorada | alta | Alend D 26/09 (staging) |
| MH | Ponto único de saída: fatos tipados + compositor com o tom da Nami | alta | §14.6–14.7 |
| MH | Configuração no modelo de runner e schema | alta | §14.6 |
| MH | Catálogo de formas farmacêuticas como dado | alta | MH-93 (pó) passa a depender dele |
| MH | "Quem fala, sobre quem" nos contratos (base do cuidador) | media | §14.7 |
| ACH | Verificação do LLM no portão sob restrição de custo | media | A57 não pegou o turno de estoque degradado (29/09) |