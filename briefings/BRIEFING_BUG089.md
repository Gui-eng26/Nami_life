# BRIEFING — BUG-89
## Retorno de LGPD após recusa grava usuário sem nome

**Sessão:** v31
**Prioridade:** alta — bloqueia beta (grava dado obrigatório como nulo, sem via de correção)
**Status:** aguardando execução no Claude Code
**Arquivos tocados:** `src/agentes/recepcionista.js` + uma migração de schema
**Relacionado:** MH-072 Parte B (mesmo arquivo, já executada e validada)

---

## 1. Evidência — reproduzido em produção (17/08/2026)

Usuário de teste `cb4c936a-731d-4b9c-9064-deb54b3a2bf0`, turnos de 20:00:30 a 20:04:48.

| Hora | Estado | Mensagem | `contexto_conversa` recebido |
|---|---|---|---|
| 20:00:55 | `recep_boas_vindas` | "Gui teste" | `nome_coletado: null`, `mensagem_inicial: "Oi"` |
| 20:01:19 | `recep_coleta_nome` | "Nao" | **`nome_coletado: "Gui Teste"`**, `intencao_inicial: "neutro"` |
| 20:02:14 | `lgpd_recusado` | "Ola" | **`{ etapa: "lgpd_recusado" }`** — contexto apagado |
| 20:03:00 | `lgpd_recusado` | "Sim quero cadastrar meu remedio" | `mensagem_inicial: "Ola"` |
| 20:03:37 | `recep_lgpd_reapresentacao` | "Sim" | `mensagem_inicial: "Ola"` |

Resultado em `users`: `name = null`, `onboarded = true`, `lgpd_accepted = true`, `data_nascimento = 1989-11-06`.

A pessoa forneceu o nome ("Gui Teste"), recusou a LGPD, voltou, aceitou — e terminou cadastrada **sem nome**, em silêncio, sem erro nem log.

---

## 2. Causa raiz — confirmada

### O apagamento do contexto NÃO é o defeito

```js
} else if (lgpdRecusado) {
    await saveConversationState(user.id, { state: 'lgpd_recusado', context: { etapa: 'lgpd_recusado' } });
```

Este descarte é **intencional e correto**: sem consentimento não há base legal para reter nome nem histórico da conversa. É a implementação da minimização de dados. **Decisão de Guilherme na v31: não alterar.**

> **Atenção a quem for implementar:** a tentação natural ao ler este bug é "preservar o contexto na recusa". Isso seria regressão de privacidade, não correção. Se este briefing for retomado no futuro, o apagamento permanece.

### O defeito é a ausência de etapa de coleta de nome no retorno

O caminho de retorno vai direto de `recep_lgpd_reapresentacao` para a gravação:

```js
} else if (etapa === 'recep_lgpd_reapresentacao') {
    lgpdAccepted = categoria === 'aceite';
    nextEtapa = lgpdAccepted ? 'recep_lgpd' : 'lgpd_recusado';
```

e a gravação faz:

```js
name: context.nome_coletado || null,
```

Depois do apagamento, `nome_coletado` é sempre `undefined` → `name` vira `null`. E **nenhum ramo do recepcionista aponta de volta para a coleta de nome** — o único ponto que pede nome é `recep_boas_vindas`, inalcançável a partir de qualquer estado de LGPD. Uma vez perdido, o nome não tem como ser recuperado (o MH-075, edição de dados cadastrais, está aberto).

---

## 3. Solução

### 3.1 Etapa nova: `recep_nome_pos_lgpd`

Encaixada entre a reapresentação e a coleta de data de nascimento.

**Hoje:** `recep_lgpd_reapresentacao` + `aceite` → grava `name || null` → `coletando_nascimento`

**Passa a ser:** `recep_lgpd_reapresentacao` + `aceite` → `recep_nome_pos_lgpd` → pede o nome → captura → grava → `coletando_nascimento` → fluxo normal

### 3.2 Alteração em `recep_lgpd_reapresentacao`

No ramo `aceite`, **não** marcar `lgpdAccepted` — a gravação passa a acontecer só quando o nome chegar:

```js
if (categoria === 'aceite') {
    nextEtapa = 'recep_nome_pos_lgpd';
    updatedContext = {
        ...context,
        etapa: 'recep_nome_pos_lgpd',
        lgpd_aceito_em: new Date().toISOString()   // carimbo verdadeiro — ver 3.5
    };
} else {
    lgpdRecusado = true;
    nextEtapa = 'lgpd_recusado';
    updatedContext = { ...context, etapa: 'lgpd_recusado' };
}
```

O ramo não-aceite fica **exatamente como está**.

### 3.3 Ramo novo `recep_nome_pos_lgpd`

Reusa `classificarNome` — mesma função, mesmas categorias, mesmo contrato `{ tipo, valor }`. Existe **uma só** definição de "como se coleta um nome" no sistema.

| `tipo` | Comportamento |
|---|---|
| `nome` | `lgpdAccepted = true`; `nome_coletado = valor` → grava e segue para `coletando_nascimento` |
| `saudacao` | devolve o cumprimento e repergunta o nome; permanece |
| `pergunta` | responde a dúvida e repergunta o nome; permanece |
| `recusa` | explica com empatia por que o nome é necessário e repergunta; permanece |
| `contexto_saude` | atualiza `mensagem_inicial` e `contexto_medicamento`; permanece (mesmo tratamento de `recep_boas_vindas`) |
| `indeterminado` | repergunta com exemplo; permanece |

**SEM teto de tentativas e SEM contador.** Decisão explícita de Guilherme na v31.

Justificativa, para não ser "corrigido" depois: saída de emergência existe para laço que o sistema faz girar sozinho. Aqui quem avança é o usuário — cada mensagem recebe resposta e o fluxo segue. Um teto aqui devolveria ao estado de recusa alguém que **acabou de consentir duas vezes**, e três respostas benignas seguidas (`"Sim"`, `"Ok"`, `"Oi"`) bastariam para disparar. O resultado seria pior que o bug corrigido.

A pessoa sai do laço quando parar de responder, como em qualquer conversa parada.

### 3.4 CRÍTICO — a gravação precisa ler `updatedContext`, não `context`

Sem isto **a correção não funciona.**

```js
// ATUAL — lê o contexto que ENTROU no turno
name: context.nome_coletado || null,
```

Hoje isso funciona porque o nome foi capturado em um turno **anterior**, então já está no `context` de entrada. Na etapa nova, o nome é capturado **no mesmo turno** em que `lgpdAccepted` vira `true` — ele existe apenas em `updatedContext`. Mantida a linha como está, `name` continuaria `null`.

Trocar, no bloco de persistência, todas as leituras de `context` por `updatedContext`:

```js
name: updatedContext.nome_coletado || null,
// e no saveConversationState seguinte:
mensagem_inicial: updatedContext.mensagem_inicial || '',
```

Como `updatedContext = { ...context, ... }` em todos os ramos, ler dele é sempre correto e nunca perde informação — enquanto ler de `context` perde tudo que foi decidido no turno atual. **Uniformizar mesmo onde hoje funciona por coincidência.**

**O fluxo de chegada não muda de comportamento.** O bloco de persistência é compartilhado pelos dois caminhos, então a linha é tocada — mas no ramo de aceite normal `updatedContext = { ...context, etapa, classificacao_lgpd }` é um spread que não sobrescreve `nome_coletado` nem `mensagem_inicial`. Os dois objetos carregam o mesmo valor, sempre. Cenário C1 da matriz existe para provar isso em produção.

**Manter o `|| null` de `name`.** Decisão de Guilherme na v31 (opção 2). A barreira contra usuário concluído sem nome fica sendo a restrição de banco da seção 3.7, não o código.

Motivo: a restrição vale para **qualquer** caminho de escrita, inclusive os que ainda não existem — enquanto uma verificação no código só cobre o caminho onde foi escrita. E não altera nada no comportamento do fluxo de chegada.

Portanto, nesta correção o bloco de persistência muda **apenas** as leituras de `context` para `updatedContext`. O `|| null` permanece.

### 3.5 Carimbo verdadeiro do consentimento

```js
lgpd_accepted_at: updatedContext.lgpd_aceito_em || new Date().toISOString(),
```

Hoje aceite e gravação acontecem no mesmo instante, então `new Date()` está certo por coincidência. A etapa nova separa os dois momentos: no teste acima, o consentimento foi às 20:03:37 e a gravação seria ~20:04:10.

`lgpd_accepted_at` é o campo que responde "quando esta pessoa consentiu?" numa auditoria. Deve marcar o momento do **"Sim"**, não o da captura do nome. O `|| new Date()` cobre o fluxo normal (primeira aceitação), onde `lgpd_aceito_em` não existe e os dois instantes coincidem.

### 3.6 Gerador

Acrescentar em `buildSystemPrompt` o ramo `recep_nome_pos_lgpd`:
- agradecer o consentimento e pedir o nome, em uma mensagem só
- **NÃO** repetir os termos da LGPD nem pedir consentimento de novo — já foi dado
- receber via `extras` o `tipo` devolvido por `classificarNome`, e redigir apenas o comportamento correspondente (mesmo padrão da Parte B: o classificador decide, o gerador executa)

### 3.7 Migração de schema

```sql
ALTER TABLE users ADD CONSTRAINT users_nome_obrigatorio_quando_onboarded
  CHECK (NOT onboarded OR (name IS NOT NULL AND btrim(name) <> ''));
```

`NOT NULL` simples **não é viável**: `getOrCreateUser` insere a linha só com o telefone, na primeira mensagem, antes de nome e antes de LGPD — quebraria a criação de todo usuário novo.

O `btrim(...) <> ''` fecha a porta do lado: sem ele, gravar string vazia passaria e reproduziria o mesmo problema com outro disfarce.

**Verificado em 17/08: zero registros violam** (`total = 8`, `violam = 0`). A migração roda limpa.

A restrição não corrige nada sozinha — ela converte **corrupção silenciosa** em **falha visível**. Qualquer caminho futuro que tente gravar usuário concluído sem nome quebra na hora, em vez de deixar um `null` permanente.

---

## 4. Fora de escopo — não alterar

**O fluxo de chegada permanece exatamente como está.** Reforço explícito de Guilherme na v31: quem chega pela primeira vez segue apresentação → nome → LGPD → aceite → data de nascimento, sem nenhuma alteração. A etapa `recep_nome_pos_lgpd` é alcançável **apenas** a partir de `recep_lgpd_reapresentacao`, que por sua vez só é alcançável a partir de `lgpd_recusado`. Não existe caminho de chegada que passe por ela.

A única sobreposição entre os dois fluxos é o bloco de persistência, que é compartilhado — tratado na seção 3.4, sem mudança de comportamento na chegada.

Demais decisões explícitas de Guilherme na v31:

- **Apagamento do contexto na recusa** — correto, permanece (ver seção 2)
- **Dupla confirmação no retorno** — a pessoa consente ao dizer "mudei de ideia" e de novo após a reapresentação dos termos. Intencional para consentimento informado; permanece
- **`duvida` tratada como não-aceite** em `lgpd_recusado` e `recep_lgpd_reapresentacao` — permanece
- **Retenção do telefone** de quem não consentiu — permanece
- Texto de cuidadores em `recep_apresentacao` (linha 256) e **BUG-27** — itens separados, aguardando decisão

---

## 5. Matriz de teste

### A — O bug (caminho de retorno)
| # | Cenário | Esperado |
|---|---|---|
| A1 | "Oi" → nome → recusa LGPD → volta → "mudei de ideia" → "Sim" | Nami **pergunta o nome**; não vai direto para data de nascimento |
| A2 | A1 → responde "Gui" | `users.name = "Gui"`, `onboarded = true`, segue para `nasc_dia` |
| A3 | A2 | `lgpd_accepted_at` = instante do **"Sim"**, não o da captura do nome |
| A4 | A1 → responde "Oi" | repergunta o nome com calor; **não** encerra; `name` não gravado |
| A5 | A1 → "Sim", "Ok", "Oi", "Tudo bem?" em sequência | continua reperguntando; **nenhum teto dispara** |
| A6 | A5 → depois responde "Ana" | `users.name = "Ana"`, segue normal |
| A7 | A1 → "por que você precisa do meu nome?" | responde e repergunta; permanece |
| A8 | Em `recep_nome_pos_lgpd`, conferir o texto | **não** repete termos de LGPD nem pede consentimento de novo |

### B — Privacidade (não-regressão do apagamento)
| # | Cenário | Esperado |
|---|---|---|
| B1 | Fornece nome → recusa LGPD | `conversation_state.context` = `{ etapa: "lgpd_recusado" }`; `nome_coletado` **ausente** |
| B2 | B1 | `users`: `name = null`, `onboarded = false`, `lgpd_accepted = false` |
| B3 | B1 → abandona e volta muito depois com "Oi" | reengajamento morno; nada gravado |

### C — Fluxo normal (não-regressão)
| # | Cenário | Esperado |
|---|---|---|
| C1 | "Oi" → "Gui" → "Sim" (aceite direto, sem recusa) | grava e vai para `nasc_dia` **sem** passar por `recep_nome_pos_lgpd` |
| C2 | C1 | `lgpd_accepted_at` = instante da gravação (os dois coincidem) |
| C3 | "Quero cadastrar losartana" → fluxo completo direto | fechamento retoma a losartana; destino `adding_med` |
| C4 | Recusa por teto de `indeterminado` (3×) na 1ª apresentação | `lgpd_recusado`, comportamento atual inalterado |
| C5 | `duvida` na 1ª apresentação | responde com transparência, não consome tentativa, não grava aceite |

### D — Restrição de banco
| # | Cenário | Esperado |
|---|---|---|
| D1 | Aplicar a migração | sucesso, sem violação |
| D2 | `INSERT INTO users (phone)` — usuário novo | sucesso; `onboarded = false`, `name` nulo é permitido |
| D3 | `UPDATE users SET onboarded = true` sem nome | **falha** com violação de CHECK |
| D4 | `UPDATE users SET name = '', onboarded = true` | **falha** — `btrim` bloqueia string vazia |

---

## 6. Registro no backlog

Autorizado por Guilherme na v31.

```
tipo: BUG
numero: 89
parte: ''
titulo: Retorno de LGPD após recusa grava usuário sem nome — não existe etapa de coleta de nome após novo aceite
status: aberto
prioridade: alta
relacionado: MH-072
```

Atualizar para `em_validacao` ao concluir a execução; `resolvido` só após validação em produção por Guilherme.

Registrar também **BUG-88** como `resolvido` — validado em produção em 13/08 (matriz completa aprovada nos logs do Railway).

---

## 7. Princípios aplicados

- **14** — reuso de `classificarNome`, com tipo semântico e valor; nenhuma lista de palavras nova
- **Minimização de dados** — o apagamento na recusa é preservado como está; a correção não amplia retenção
- Fallback silencioso (`|| null`) em dado obrigatório é a origem do defeito. A barreira escolhida é a **restrição de banco**, não uma verificação no código: ela vale para qualquer caminho de escrita, inclusive os que ainda não existem
- Saída de emergência só onde o sistema pode girar sozinho — não neste laço
- Consentimento é dado de auditoria: o carimbo marca o momento do consentimento, não o da escrita