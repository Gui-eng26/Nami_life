# BRIEFING — MH-072 Parte B.0
## BUG-88 — Recusa de consentimento LGPD gravada como aceite

**Sessão:** v31
**Prioridade:** crítica — bloqueia beta
**Status:** aguardando execução no Claude Code
**Arquivo tocado:** `src/agentes/recepcionista.js` (único)
**Relacionado:** MH-072 (entrega antecipada do item 6 da Parte B)

---

## 1. Por que esta parte existe separada

O defeito é isolado, cabe em uma função e tem natureza jurídica: registra consentimento LGPD que o usuário não deu. A Parte B completa são 8 itens em 3 arquivos — segurar esta correção até lá seria errado.

**Isto não é patch.** A solução entregue aqui é exatamente o item 6 do briefing da Parte B, na forma definitiva (classificação semântica). O restante da Parte B segue depois, sem retrabalho sobre este código.

---

## 2. Evidência — reproduzido em produção (13/08/2026)

Usuário de teste `+5519998093582` (`78f916fa-aff2-4cd6-a3cf-bcfb219852bb`).

**Mensagem enviada, na etapa `recep_coleta_nome`:**
> "Prefiro nao passar os dados"

**Resposta que o usuário recebeu** (`agent_logs`, 15:25:21):
> "Entendo e respeito sua decisão! 😊 Pela Lei Geral de Proteção de Dados (LGPD), preciso do seu consentimento... sem isso, infelizmente não consigo personalizar seus lembretes e o serviço não funciona. Se mudar de ideia, é só me chamar."

**O que foi gravado no mesmo segundo:**

| Tabela | Campo | Valor |
|---|---|---|
| `users` | `lgpd_accepted` | `true` |
| `users` | `lgpd_accepted_at` | `2026-08-13 15:25:21` |
| `users` | `onboarded` | `true` |
| `users` | `name` | `Gui teste2` |
| `conversation_state` | `state` | `coletando_nascimento` (etapa `nasc_dia`) |

O usuário foi informado de que está fora e está dentro. A próxima mensagem dele seria interpretada como dia de nascimento.

**Alcance verificado:** varredura de todos os turnos históricos nas etapas de LGPD com sinal de recusa retorna **apenas este teste**. Nenhum usuário real afetado. Os 9 aceites em `users` são genuínos.

---

## 3. Causa raiz — confirmada por leitura de código

```js
// recepcionista.js:11
const LGPD_ACCEPT_KEYWORDS = ['sim', 's', 'pode', 'concordo', 'aceito', 'ok', 'claro', 'com certeza', 'yes'];

function isLgpdAccepted(message) {
    const normalized = message.toLowerCase().trim();
    return LGPD_ACCEPT_KEYWORDS.some(kw => normalized.includes(kw));   // ← 's' casa com qualquer palavra com "s"
}
```

A keyword `'s'` é testada com `includes` sobre a mensagem inteira. Em `"prefiro nao passar os dados"`, casa com **"pa*s*sar"**.

**Agravante — a detecção de recusa existe e está correta, mas é inalcançável:**

```js
// recepcionista.js:262-263
lgpdAccepted = isLgpdAccepted(message);
lgpdRecusado = !lgpdAccepted && contemRecusa(message);   // ← curto-circuitado
```

`contemRecusa()` contém `'nao'` e **teria casado** com esta mensagem. Nunca é avaliado porque `lgpdAccepted` já retornou `true`.

**Por que o texto saiu certo e o banco errado:** `buildSystemPrompt` entrega à LLM as duas ramificações (aceite e recusa) e ela escolhe pelo sentido da mensagem. A LLM acertou; a lista de palavras errou. Quem persiste é o código.

São **dois julgamentos independentes sobre a mesma mensagem**, um semântico e um lexical, sem nenhum ponto de reconciliação. A correção elimina a duplicidade, não ajusta a lista.

**Impacto em observabilidade (Princípio 24, forma nova):** auditar `agent_logs` isoladamente mostra uma recusa respeitada. Só o cruzamento com `users` revela o consentimento falso. Qualquer auditoria de LGPD baseada em log daria resultado errado.

---

## 4. Solução

### 4.1 Princípio

Um único julgamento sobre a mensagem. **O classificador decide; o gerador apenas executa a decisão já tomada.**

```
mensagem → classificarConsentimentoLgpd  (categoria fechada)
         → decisão de estado             (código, determinístico)
         → gerador de texto              (recebe a decisão pronta)
```

### 4.2 `classificarConsentimentoLgpd`

Função nova em `recepcionista.js`, mesmo padrão de `classificarIndeterminado` em `data_nascimento.js` (referência de implementação: `max_tokens: 8`, categoria fechada, `degradar()` no catch).

- **Entrada:** `message`, `historicoConversa`
- **Categorias:** `aceite` | `recusa` | `duvida` | `indeterminado`
- **Fallback em erro:** `indeterminado` via `degradar()` — **nunca** `aceite`

Definições para o prompt:

- `aceite` — concorda de forma inequívoca com a guarda dos dados. *"sim"*, *"pode"*, *"concordo"*, *"aceito"*, *"tudo bem"*, *"claro"*, *"ok"*, *"sim, pode guardar"*
- `recusa` — não concorda, ou adia. *"não"*, *"prefiro não passar os dados"*, *"agora não"*, *"deixa pra lá"*, *"não quero compartilhar"*, *"tô com receio disso"*
- `duvida` — pergunta sobre o uso dos dados sem aceitar nem recusar. *"pra que vocês precisam disso?"*, *"vocês vendem meus dados?"*, *"quem vai ver isso?"*, *"posso apagar depois?"*
- `indeterminado` — não se encaixa em nenhuma acima; resposta confusa ou fora de contexto

**Regra inegociável:** `lgpd_accepted: true` só é gravado com `aceite`. Qualquer outra categoria, ou qualquer falha, **não grava**.

### 4.3 Tratamento por categoria

| Categoria | Grava aceite? | Próximo estado | Comportamento |
|---|---|---|---|
| `aceite` | **sim** | `coletando_nascimento` | fluxo atual, sem alteração |
| `recusa` | não | `lgpd_recusado` | fluxo atual, sem alteração |
| `duvida` | **não** | permanece em `recep_lgpd` | responde à pergunta sobre uso de dados e reapresenta o pedido de consentimento |
| `indeterminado` | **não** | permanece em `recep_lgpd` | repergunta de forma mais clara; `tentativas_lgpd` +1 |

**Teto:** `tentativas_lgpd` incrementa **só** em `indeterminado`. Em 3, encerra em `lgpd_recusado` (saída de emergência — padrão da Parte A.1 item 6).

`duvida` **não conta** para o teto: perguntar sobre o uso dos próprios dados é comportamento legítimo e deve ser servido, não penalizado.

`lgpd_recusado` é estado morno e reversível — já reconhece o retorno e reoferece. Chegar nele por teto não fecha porta nenhuma.

### 4.4 Ajuste no gerador

Em `buildSystemPrompt`, a etapa `recep_lgpd` deixa de conter as duas ramificações para a LLM escolher. Passar a categoria já decidida no `context` (`classificacao_lgpd`) e instruir **apenas** o comportamento correspondente.

Acrescentar as instruções de texto para `duvida` (responder à pergunta com transparência — dados usados só para personalizar lembretes, não são vendidos nem compartilhados — e reapresentar o pedido) e para `indeterminado` (reperguntar com clareza, sem constranger).

### 4.5 Pontos de substituição

Trocar `isLgpdAccepted()` pelo classificador nos **dois** locais:
- L260-264 — bloco `recep_coleta_nome | recep_lgpd`
- L277-282 — bloco `recep_lgpd_reapresentacao`

Remover `LGPD_ACCEPT_KEYWORDS`, `isLgpdAccepted()` e `contemRecusa()` do arquivo.

**Não tocar** em `pareceNome()` nesta parte — é escopo da Parte B (BUG-30). O uso em L306 permanece como está.

---

## 5. Matriz de teste

### A — Recusa (o defeito)
| # | Mensagem | Esperado |
|---|---|---|
| A1 | "Prefiro nao passar os dados" | `recusa` → `lgpd_recusado`. `lgpd_accepted` **permanece false** |
| A2 | "não posso" | `recusa` |
| A3 | "isso não" | `recusa` |
| A4 | "sem chance" | `recusa` |
| A5 | "agora não, obrigado" | `recusa` |
| A6 | "deixa pra lá" | `recusa` *(a lista antiga não cobria)* |
| A7 | "tô com receio de passar meus dados" | `recusa` *(a lista antiga não cobria)* |

**Verificação obrigatória em A1-A7:** conferir em `users` que `lgpd_accepted = false`, `onboarded = false`, `lgpd_accepted_at IS NULL`; e em `conversation_state` que o estado é `lgpd_recusado`, **não** `coletando_nascimento`.

### B — Aceite (não-regressão)
| # | Mensagem | Esperado |
|---|---|---|
| B1 | "sim" | `aceite` → `coletando_nascimento`, pergunta o DIA |
| B2 | "pode" / "concordo" / "aceito" / "claro" / "ok" | `aceite` |
| B3 | "sim, pode guardar" | `aceite` |
| B4 | "tudo bem" | `aceite` |

### C — Dúvida (novo)
| # | Mensagem | Esperado |
|---|---|---|
| C1 | "pra que vocês precisam disso?" | responde e reapresenta. `lgpd_accepted` **false**, permanece em `recep_lgpd` |
| C2 | "vocês vendem meus dados?" | idem |
| C3 | C1 → depois "ah tá, então pode" | `aceite` → `coletando_nascimento` |
| C4 | C1 → depois "não, prefiro não" | `recusa` → `lgpd_recusado` |

### D — Indeterminado e teto
| # | Cenário | Esperado |
|---|---|---|
| D1 | "asdfgh" | repergunta, `tentativas_lgpd` = 1, não grava aceite |
| D2 | 3 mensagens indeterminadas seguidas | encerra em `lgpd_recusado` |
| D3 | 2 dúvidas + 1 indeterminado | `tentativas_lgpd` = 1 (dúvida não conta) |

### E — Reapresentação (não-regressão)
| # | Cenário | Esperado |
|---|---|---|
| E1 | `lgpd_recusado` → "mudei de ideia" | `recep_lgpd_reapresentacao` |
| E2 | E1 → "sim" | `aceite`, grava, segue para nascimento |
| E3 | E1 → "não, deixa" | `recusa` → `lgpd_recusado` |

### F — Degradação
| # | Cenário | Esperado |
|---|---|---|
| F1 | Falha na chamada do classificador | `indeterminado` via `degradar()`. **Nunca** grava aceite |

---

## 6. Verificação pós-deploy

Após os testes, confirmar que nenhum aceite falso foi criado:

```sql
SELECT l.created_at, u.phone, u.lgpd_accepted, u.onboarded, l.user_message
FROM agent_logs l JOIN users u ON u.id = l.user_id
WHERE l.estado_conversa IN ('recep_coleta_nome','recep_lgpd','recep_lgpd_reapresentacao')
  AND (l.user_message ILIKE '%nao%' OR l.user_message ILIKE '%não%'
       OR l.user_message ILIKE '%prefiro%' OR l.user_message ILIKE '%recus%')
ORDER BY l.created_at DESC;
```

Todo registro retornado deve ter `lgpd_accepted = false`.

---

## 7. Registro no backlog

Autorizado por Guilherme na v31.

```
tipo: BUG
numero: 88
parte: ''
titulo: Recusa de consentimento LGPD gravada como aceite (keyword 's' em includes)
status: aberto
prioridade: alta
relacionado: MH-072
```

Atualizar para `em_validacao` ao concluir a execução, e para `resolvido` após validação em produção por Guilherme.

---

## 8. Princípios aplicados

- **14** — classificação semântica com categoria fechada, nunca lista de palavras
- **24** — o defeito só é visível cruzando `agent_logs` com `users`; a verificação pós-deploy cruza as duas
- **Saída de emergência** — teto de 3 com destino terminal morno
- **Degradação explícita** — `degradar()` com fallback nomeado, jamais `aceite`
- **Sistêmico sobre patch** — remove a duplicidade de julgamento, não corrige a keyword

---

## 9. Dado remanescente

O registro `78f916fa-aff2-4cd6-a3cf-bcfb219852bb` (`Gui teste2`) está com `lgpd_accepted = true` indevido e parado em `coletando_nascimento`. É registro de teste; limpeza a critério de Guilherme. Enquanto existir, é falso positivo em qualquer contagem de aceites.