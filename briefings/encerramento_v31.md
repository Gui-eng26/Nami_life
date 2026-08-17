# ENCERRAMENTO — Sessão v31

**Período:** 13 a 17/08/2026
**Entregas:** MH-072 Parte B (com MH-074), MH-072 Parte B.0 (BUG-88), BUG-89
**Executor:** Claude Code

---

## 1. Ações para o Claude Code

### 1.1 CONTEXT.md

Inserir a seção da seção 2 deste arquivo **imediatamente antes** de `## Backlog (BUG/FIX/MH/ACH)`, ou seja, logo após o fim da seção `## Sessão v30`.

Acrescentar os princípios 40 a 43 (seção 3) ao fim da lista em `## Princípios de Engenharia`.

**Verificação obrigatória após editar:** `grep -c "^## Sessão" CONTEXT.md` deve ter aumentado em exatamente 1. Relatar o número antes e depois.

### 1.2 Escritas no backlog

Todas via `src/backlog.js` (`atualizarStatusBacklogItem`), nunca SQL cru.

```
BUG-89   em_validacao -> resolvido
MH-072 B aberto       -> resolvido
MH-074   aberto       -> resolvido
BUG-30   aberto       -> resolvido
```

`BUG-88` já foi atualizado para `resolvido` na execução anterior — conferir e não duplicar.

**Não alterar:** BUG-27 permanece `aberto` (evidência nova registrada, sem causa raiz fechada).

### 1.3 Git

Commit + push do CONTEXT.md atualizado e dos briefings da sessão (`BRIEFING_MH072_PARTE_B.md`, `BRIEFING_MH072_PARTE_B0.md`, `BRIEFING_BUG89_NOME_POS_LGPD.md`) em `briefings/`.

---

## 2. Seção a inserir no CONTEXT.md

```markdown
## Sessão v31 (13-17/08/2026) — MH-072 Parte B + MH-074, BUG-088 e BUG-089 (consentimento LGPD)

### O que foi entregue

| Item | Situação |
|---|---|
| MH-072 Parte B | Executada e validada em produção |
| MH-072 Parte B.0 (BUG-088) | Resolvido — matriz completa aprovada |
| BUG-089 | Resolvido — validado em produção |
| MH-074 | Implementado dentro da Parte B, validado ponta a ponta |
| BUG-030 | Resolvido pela substituição de `pareceNome()` |

Com isso, a primeira das 4 frentes de beta (MH-072) está concluída. Restam MH-040,
MH-073 e MH-009, todas `alta` e não iniciadas.

### MH-072 Parte B — separação entre classificação e geração

**Causa raiz do gap que o MH-074 fecha:** o recepcionista já classificava a intenção
(`CADASTRAR | DESCOBRIR | NEUTRO`), mas dentro do mesmo prompt que gerava a resposta. O
resultado só ajustava o tom e era descartado — todas as categorias terminavam na mesma
instrução de pedir o nome. A classificação existia sem poder de decisão sobre o fluxo,
por isso não havia caminho possível para o curioso.

Quatro instâncias da mesma classe de defeito no mesmo arquivo, todas eliminadas:
`pareceNome()` (BUG-030), `isLgpdAccepted()` (BUG-088), `contemRecusa()` e `querCadastrar`.

**Padrão aplicado em todas as etapas:** mensagem → classificador dedicado (categoria
fechada, `max_tokens` baixo, `degradar()` no catch) → decisão de estado em código
determinístico → gerador de texto, que recebe a decisão já tomada. Nunca classificar
dentro do prompt de geração; nunca decidir fluxo com lista de palavras.

Classificadores novos: `classificarIntencaoInicial`, `classificarRespostaConvite`,
`classificarNome` (devolve tipo semântico + valor normalizado) e
`classificarDestinoPosOnboarding`.

`pareceNome` era chamada **duas vezes** — na captura e de novo na gravação, esta última
comentada como "validar nome antes de salvar". Uma validação que reusa a função que
produziu o erro não valida nada. As duas saíram juntas.

**Router não mudou:** com `onboarded=false`, o bloco 1 intercepta antes da classificação
central, então todos os estados novos são internos ao recepcionista.

### MH-074 — caminho do usuário curioso

Quem chega apenas perguntando o que a Nami faz não entra em nome/LGPD/cadastro. A Nami
responde à pergunta específica, complementa com as demais capacidades e convida. Estados
novos: `recep_apresentacao` e `apresentacao_declinada` (reconhece o retorno).

**Decisão de desenho que evitou complexidade desnecessária:** não existe destino
alternativo. Quem aceita o convite percorre obrigatoriamente nome → LGPD → data de
nascimento → cadastro, exatamente como já era. A antessala é uma etapa a mais, não uma
rota paralela. A proposta inicial de propagar `capacidade_mencionada` para decidir
destino foi descartada por ser desnecessária.

**Privacidade:** `getOrCreateUser` já cria a linha em `users` na primeira mensagem, antes
de qualquer etapa. O curioso que declina já está no banco como qualquer outro — o MH-074
não amplia retenção. Decisão explícita de Guilherme: nada muda no que já é guardado. A
métrica de conversão sai da contagem de `conversation_state`, sem dado novo.

Validado ponta a ponta: `"Pra que vc serve?"` → apresentação → `"Agora não, só entendendo
mesmo"` → despedida → retorno com `"Oi"` → acolhida → `"Quero cadastrar meu losartana"` →
fluxo completo até o medicamento salvo.

### BUG-088 — recusa de LGPD gravada como aceite (Parte B.0)

`LGPD_ACCEPT_KEYWORDS` continha a keyword `'s'`, testada com `includes` sobre a mensagem
inteira. Qualquer resposta contendo a letra **s** virava consentimento. Em
`"prefiro nao passar os dados"`, casou com "pa**s**sar".

**Agravante:** `contemRecusa()` continha `'nao'` e teria classificado corretamente, mas
nunca era avaliada — `lgpdRecusado = !lgpdAccepted && ...` já havia sido curto-circuitado.

**Divergência texto × banco:** o prompt entregava à LLM as duas ramificações e ela
escolhia pelo sentido. A LLM acertou, a lista de palavras errou, e quem persiste é o
código. Dois julgamentos independentes sobre a mesma mensagem, sem reconciliação.

Em produção, o usuário recebeu *"entendo e respeito sua decisão"* e no mesmo segundo teve
`lgpd_accepted = true`, `onboarded = true` e estado avançado para nascimento.

**Alcance verificado:** varredura de todos os turnos históricos nas etapas de LGPD com
sinal de recusa retornou apenas o teste. Nenhum usuário real afetado.

**Princípio 24, forma nova:** auditar `agent_logs` isoladamente mostra a recusa
respeitada. Só o cruzamento com `users` revela o consentimento falso. Auditoria de LGPD
baseada em log daria resultado errado.

**Correção:** `classificarConsentimentoLgpd` (`aceite | recusa | duvida | indeterminado`),
fallback nunca em `aceite`. Categoria `duvida` é nova — perguntar sobre o uso dos próprios
dados não é aceite nem recusa, e não consome tentativa.

Antes/depois da mesma string em produção: às 12:20 `"Sem chance"` foi lido como aceite;
às 15:02, após o deploy, como recusa.

### BUG-089 — retorno de LGPD grava usuário sem nome

⚠️ **A hipótese inicial estava invertida e não deve ser refeita.** A primeira leitura
apontou o apagamento do contexto na recusa (`context: { etapa: 'lgpd_recusado' }`) como o
defeito, e propôs preservá-lo. **Isso seria regressão de privacidade.** Sem consentimento
não há base legal para reter nome nem histórico — o apagamento é a implementação correta
da minimização de dados e **permanece como está**.

**Causa raiz real:** ausência de etapa de coleta de nome no retorno. O caminho ia direto
de `recep_lgpd_reapresentacao` para a gravação, que fazia `name: context.nome_coletado ||
null` — sempre `null` depois do apagamento. E nenhum ramo do recepcionista apontava de
volta para a coleta: o único ponto que pede nome é `recep_boas_vindas`, inalcançável a
partir de qualquer estado de LGPD. Com o MH-075 aberto, o nome nulo era permanente.

**Correção:**
- Etapa `recep_nome_pos_lgpd`, alcançável apenas a partir da reapresentação, reusando
  `classificarNome` — uma só definição de como se coleta um nome.
- **Sem teto de tentativas** (ver princípio 42).
- Bloco de persistência passou a ler `updatedContext` em vez de `context`. Sem isso a
  correção não funcionaria: o nome é capturado no mesmo turno em que o aceite é gravado,
  então existe apenas no objeto do turno atual.
- `lgpd_accepted_at` carimba o instante do consentimento, não o da escrita — os dois
  deixaram de coincidir quando a coleta de nome entrou no meio.
- Restrição condicional no banco (ver abaixo).

**Migração:**
```sql
ALTER TABLE users ADD CONSTRAINT users_nome_obrigatorio_quando_onboarded
  CHECK (NOT onboarded OR (name IS NOT NULL AND btrim(name) <> ''));
```
`NOT NULL` simples não era viável: `getOrCreateUser` insere a linha só com o telefone, na
primeira mensagem. O `btrim(...) <> ''` fecha a porta do lado.

**Decisão sobre a barreira:** manter o `|| null` no código e deixar a restrição de banco
ser a garantia. Ela vale para qualquer caminho de escrita, inclusive os que ainda não
existem, e não altera o comportamento do fluxo de chegada (princípio 41).

**Validação:** no caminho do bug, `lgpd_accepted_at` registrou 21:18:47 e a gravação
ocorreu às 21:19:04 — 17 segundos de diferença, prova do carimbo verdadeiro. No fluxo de
chegada, a etapa nova não foi acionada e o fechamento retomou o medicamento normalmente.

### Estado do fluxo LGPD (referência)

Três pontos de avaliação, todos pelo mesmo `classificarConsentimentoLgpd`:

| Estado | Tratamento |
|---|---|
| `recep_coleta_nome` / `recep_lgpd` | 4 categorias com tratamento próprio; `duvida` não consome tentativa; `indeterminado` ×3 → recusado |
| `lgpd_recusado` | só `aceite` importa → reapresentação; as outras 3 permanecem |
| `recep_lgpd_reapresentacao` | `aceite` → `recep_nome_pos_lgpd`; as outras 3 → recusado |

Decisões preservadas por escolha explícita: a dupla confirmação no retorno (consentimento
informado exige rever os termos) e o tratamento de `duvida` como não-aceite nos ramos 2 e 3.

### Pendências abertas ao fim da v31

- **Texto de cuidadores** (`recepcionista.js`, prompt de `recep_apresentacao`): a
  apresentação promete "visibilidade para quem cuida de um familiar", função que ainda não
  existe. Requer `grep -ri "cuidador\|quem cuida\|familiar" src/` antes de corrigir.
- **BUG-027** com evidência fresca: o classificador central extraiu `medicamento: null` da
  mensagem `"Losartana"`, e o `cadastro.js` repergunta o nome. Sem causa raiz fechada.
- **MH-075** ganhou relevância: sem edição de dados cadastrais, qualquer dado gravado
  errado no onboarding é permanente.

### Método — lições da sessão

Três diagnósticos foram apresentados com confiança maior do que a evidência sustentava:
(1) BUG-027 apontado como afetando a retomada da mensagem inicial, a partir de leitura
parcial — a retomada é determinística e estava correta; (2) comportamento da LLM ao
sobrepor a máquina de estados afirmado como fato quando era inferência; (3) correção do
BUG-089 proposta ao contrário.

Além disso, achados foram trazidos um a um, reativamente às perguntas, em vez de numa
leitura estruturada única — o efeito foi decidir várias vezes com quadros parciais. A
correção adotada: mapear o fluxo inteiro antes de propor qualquer ajuste.
```

---

## 3. Princípios a acrescentar

```markdown
40. **Escrita que persiste uma decisão tomada no mesmo turno lê o objeto que a decisão
    produziu, nunca o que entrou no turno (v31, BUG-089).** Quando decisão e persistência
    aconteciam em turnos diferentes, ler o contexto de entrada funcionava por
    coincidência. Ao aproximar os dois, a leitura antiga passa a devolver o estado
    anterior — silenciosamente, porque o campo existe e está apenas desatualizado.
    Uniformizar a leitura para o objeto do turno atual mesmo onde a versão antiga
    funciona: o custo é zero e remove a armadilha antes que alguém a encontre.

41. **Barreira contra dado obrigatório ausente pertence ao schema, não ao código (v31,
    BUG-089).** Uma verificação no código só cobre o caminho onde foi escrita; a restrição
    de banco vale para todos, inclusive os que ainda não existem. Fallback silencioso
    (`|| null`) em campo obrigatório é corrupção adiada — a restrição converte isso em
    falha visível, que é o que se quer.

42. **Teto de tentativas só existe onde o laço pode girar sem o usuário (v31, BUG-089 e
    MH-072 B).** Saída de emergência protege contra o sistema travar sozinho. Num laço em
    que cada mensagem do usuário recebe resposta e o fluxo avança, quem decide parar é o
    usuário, e o teto só antecipa um encerramento que ele não pediu. Antes de acrescentar
    um contador, perguntar o que dispararia o esgotamento: se a resposta for
    "comportamento normal do usuário" (cumprimentar, confirmar, perguntar), o teto é
    nocivo. Complementa o princípio 37, que trata do que o contador conta quando ele deve
    existir.

43. **Ausência de base legal apaga o dado; o fluxo se desenha para recoletar, não para
    preservar (v31, BUG-089).** Quando o usuário recusa consentimento, apagar o que foi
    coletado é requisito, não defeito. A consequência — o dado não estar disponível
    depois — se resolve com uma etapa de recoleta no caminho de retorno, nunca
    enfraquecendo o apagamento. Ao diagnosticar perda de dado, verificar primeiro se a
    perda é intencional antes de propor preservá-lo.
```

---

## 4. Arquivos gerados nesta sessão

- `briefings/BRIEFING_MH072_PARTE_B.md`
- `briefings/BRIEFING_MH072_PARTE_B0.md`
- `briefings/BRIEFING_BUG89_NOME_POS_LGPD.md`
- `Nami_Relatorio_v31.docx` (upload manual para o Drive por Guilherme)