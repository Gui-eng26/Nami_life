# BRIEFING — Estrutura Sistêmica de Observabilidade (MH-53)

**Sessão v22 — 27/07/2026**
**Objetivo:** dar à Nami a capacidade de mapear e monitorar, de forma sistêmica, (a) falhas técnicas, (b) desvios comportamentais, (c) feedback explícito do usuário (elogio/crítica/sugestão) e (d) intenções não suportadas — alimentando, no futuro, um dashboard de operação (MH-9) e um alerta proativo (MH-52).

Escopo deste briefing: **backbone de dados + capturas in-line que não podem ser adiadas.** NÃO cobre o juiz offline (MH-54) nem a captura proativa de adesão (MH-55), registrados à parte.

---

## Princípios que regem esta implementação

1. **Invariante de LGPD:** `system_events` **nunca** guarda texto cru do usuário. A mensagem vive só em `agent_logs` (referenciada por `agent_log_id`), que é `CASCADE` na exclusão. Excluiu o usuário → `agent_logs` some → `system_events` fica só com a casca operacional anonimizada (`user_id`/`agent_log_id` → NULL).
2. **`feedbacks` guarda o `texto` de propósito** — é o aprendizado que sobrevive à exclusão, anonimizado (`user_id` → NULL).
3. **Regra de robustez:** `registrarEvento` e `registrarFeedback` são defensivas — try/catch interno, caem para `console.error`, **NUNCA lançam exceção**. Observabilidade jamais pode quebrar o fluxo principal. (Mesmo padrão de `logAgentInteraction`/`updateDoseLogZapiMessageId` hoje.)
4. **Ponto único de escrita** (princípio 16): toda escrita nas tabelas novas passa só por `src/observabilidade.js`.
5. **Cobertura em 2 camadas, sem refatorar cada agente:** turno concluído → linha em `agent_logs` (universal); turno que crasha → capturado no `catch` de `agent.js`. União exaustiva.
6. **`delete_user_account` NÃO é alterado.** As FKs `ON DELETE SET NULL` anonimizam sozinhas quando `DELETE FROM users` roda (ver Parte 4).

---

## PARTE 1 — Migration (aplicar MANUALMENTE no SQL Editor ANTES do deploy)

Arquivo: `supabase/migrations/20260727000000_observabilidade.sql`

```sql
-- MH-53 — Backbone de observabilidade
-- system_events (sinais automáticos) + feedbacks (sinais do usuário)
-- delete_user_account NÃO é tocado: FKs ON DELETE SET NULL anonimizam sozinhas.

CREATE TABLE system_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo            text NOT NULL
                     CHECK (tipo IN ('erro_tecnico','desvio_comportamental','intencao_nao_suportada')),
    severidade      text NOT NULL
                     CHECK (severidade IN ('baixa','media','alta','critica')),
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    agent           text,
    origem          text NOT NULL
                     CHECK (origem IN ('catch_global','classificador_central','juiz_offline','scheduler','outro')),
    agent_log_id    uuid REFERENCES agent_logs(id) ON DELETE SET NULL,
    titulo          text,
    payload         jsonb,
    fingerprint     text,
    status_triagem  text NOT NULL DEFAULT 'novo'
                     CHECK (status_triagem IN ('novo','lido','arquivado','virou_backlog')),
    backlog_ref     text,
    revisado_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_system_events_status   ON system_events (status_triagem);
CREATE INDEX idx_system_events_tipo_sev ON system_events (tipo, severidade);
CREATE INDEX idx_system_events_created  ON system_events (created_at DESC);
CREATE INDEX idx_system_events_fp       ON system_events (fingerprint);

CREATE TABLE feedbacks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    categoria       text NOT NULL
                     CHECK (categoria IN ('elogio','critica','sugestao')),
    origem          text NOT NULL
                     CHECK (origem IN ('espontaneo','proativo_adesao','proativo_outro')),
    texto           text NOT NULL,
    agent_log_id    uuid REFERENCES agent_logs(id) ON DELETE SET NULL,
    status_triagem  text NOT NULL DEFAULT 'novo'
                     CHECK (status_triagem IN ('novo','lido','arquivado','virou_backlog')),
    backlog_ref     text,
    revisado_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_feedbacks_status    ON feedbacks (status_triagem);
CREATE INDEX idx_feedbacks_categoria ON feedbacks (categoria);
CREATE INDEX idx_feedbacks_created   ON feedbacks (created_at DESC);
```

**Verificação pós-migration** (esperado: as duas FKs para `users` com `delete_rule = SET NULL`):
```sql
SELECT tc.table_name, kcu.column_name, rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type='FOREIGN KEY'
  AND tc.table_name IN ('system_events','feedbacks');
```

---

## PARTE 2 — Módulo `src/observabilidade.js` (criar do zero)

Espelha `src/backlog.js` (client próprio via `createClient`). Ponto único de escrita. Nunca lança.

```js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import 'dotenv/config';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ÚNICO ponto de escrita em system_events e feedbacks.
// REGRA CRÍTICA: estas funções NUNCA lançam exceção.

// tipo: 'erro_tecnico' | 'desvio_comportamental' | 'intencao_nao_suportada'
// severidade: 'baixa' | 'media' | 'alta' | 'critica'
// origem: 'catch_global' | 'classificador_central' | 'juiz_offline' | 'scheduler' | 'outro'
// titulo: resumo ESTÁVEL/templatizado (o fingerprint agrupa por ele) — NUNCA a mensagem crua.
// payload: NÃO conter texto cru do usuário (invariante de LGPD). Amarre ao texto via agentLogId.
export async function registrarEvento({
    tipo, severidade, userId = null, agent = null, origem,
    agentLogId = null, titulo = null, payload = null
}) {
    try {
        const fingerprint = crypto.createHash('sha1')
            .update(`${tipo}|${titulo || ''}|${agent || ''}`)
            .digest('hex');

        const { error } = await supabase.from('system_events').insert({
            tipo, severidade, user_id: userId, agent, origem,
            agent_log_id: agentLogId, titulo, payload, fingerprint
        });
        if (error) console.error(`[observabilidade] Falha ao registrar evento: ${error.message}`);
    } catch (e) {
        console.error(`[observabilidade] Exceção ao registrar evento: ${e.message}`);
    }
}

// categoria: 'elogio' | 'critica' | 'sugestao'
// origem: 'espontaneo' | 'proativo_adesao' | 'proativo_outro'
export async function registrarFeedback({
    userId = null, categoria, origem = 'espontaneo', texto, agentLogId = null
}) {
    try {
        const { error } = await supabase.from('feedbacks').insert({
            user_id: userId, categoria, origem, texto, agent_log_id: agentLogId
        });
        if (error) console.error(`[observabilidade] Falha ao registrar feedback: ${error.message}`);
    } catch (e) {
        console.error(`[observabilidade] Exceção ao registrar feedback: ${e.message}`);
    }
}
```

---

## PARTE 3 — Pontos de captura in-line

### 3.1 — `logAgentInteraction` passa a devolver o `id` (`src/database.js`)

Precisamos do `id` da linha para amarrar eventos/feedbacks do turno (`agent_log_id`). Trocar o `.insert(...)` por `.insert(...).select('id').single()` e retornar `data?.id ?? null`. Manter a regra defensiva (só `console.error`, nunca lançar).

```js
export async function logAgentInteraction({ userId, agent, userMessage, agentResponse, estadoConversa = null, contextoConversa = null }) {
    const { data, error } = await supabase
        .from('agent_logs')
        .insert({
            user_id: userId,
            agent,
            user_message: userMessage,
            agent_response: agentResponse,
            estado_conversa: estadoConversa,
            contexto_conversa: contextoConversa
        })
        .select('id')
        .single();

    if (error) {
        console.error(`Erro ao salvar log de agente: ${error.message}`);
        return null;
    }
    return data?.id ?? null;
}
```

### 3.2 — `agent.js`: capturar erro técnico no `catch` único (`src/agent.js`)

A mensagem ao usuário NÃO muda. Adicionar: (1) uma linha de `agent_logs` marcando a falha (onde a mensagem crua fica, protegida pelo CASCADE); (2) o `system_events(erro_tecnico)` referenciando essa linha. Se o crash foi antes de `getOrCreateUser`, registrar sem `userId`/`agentLogId`.

> ⚠️ Para o `user` existir no `catch`, declará-lo com `let user;` ANTES do `try` e atribuir dentro (hoje é `const user = ...` dentro do try).

```js
import { logAgentInteraction, getOrCreateUser } from './database.js';
import { registrarEvento } from './observabilidade.js';
// ...
    } catch (error) {
        console.error('❌ Erro no agente:', error.message);
        console.error('Stack:', error.stack);

        try {
            let agentLogId = null;
            if (typeof user !== 'undefined' && user?.id) {
                agentLogId = await logAgentInteraction({
                    userId: user.id,
                    agent: 'erro',
                    userMessage: text,
                    agentResponse: null,
                    estadoConversa: 'erro'
                });
            }
            await registrarEvento({
                tipo: 'erro_tecnico',
                severidade: 'alta',
                userId: (typeof user !== 'undefined' && user?.id) ? user.id : null,
                agent: 'agent',
                origem: 'catch_global',
                agentLogId,
                titulo: `Exceção não tratada: ${error.message?.split('\n')[0] ?? 'desconhecida'}`.slice(0, 200),
                payload: { message: error.message, stack: error.stack, estado: 'erro' }
            });
        } catch (obsError) {
            console.error('[observabilidade] Falha ao capturar erro técnico:', obsError.message);
        }

        try {
            await sendTextMessage(phone, 'Desculpe, tive um probleminha aqui. Pode repetir o que você disse? 🌿');
        } catch (sendError) {
            console.error('❌ Erro ao enviar mensagem de erro:', sendError.message);
        }
    }
```

### 3.3 — `router.js`: `agent_log_id` + migrar não-suportado + detectar feedback (ortogonal)

**(a) Capturar o id do log final** (o `logAgentInteraction` de ~linha 863):
```js
    const agentLogId = await logAgentInteraction({
        userId: user.id,
        agent: agentName,
        userMessage: message,
        agentResponse: response,
        estadoConversa: currentState || null,
        contextoConversa: state?.context || null
    });
```
Emitir os registros de observabilidade do turno **depois** desse log (o id já existe).

**(b) Migrar o não-suportado.** Nos 5 pontos que hoje chamam `registrarIntencaoNaoSuportada(user.id, message)` (4 em `router.js`, 1 em `relatorios.js`): em vez de escrever direto, marcar uma flag local `intencaoNaoSuportadaDetectada = true` e, APÓS o log final:
```js
import { registrarEvento, registrarFeedback } from './observabilidade.js';
// ...
if (intencaoNaoSuportadaDetectada) {
    await registrarEvento({
        tipo: 'intencao_nao_suportada',
        severidade: 'baixa',
        userId: user.id,
        agent: agentName,
        origem: 'classificador_central',
        agentLogId,
        titulo: 'Intenção não suportada (classificador central)'
        // payload SEM a mensagem crua — o texto vive em agent_logs via agentLogId
    });
}
```
> `relatorios.js` (chamada de `registrarIntencaoNaoSuportada`): idem. Preferir sinalizar de volta ao router para ter o `agentLogId`. Se emitir direto, `agentLogId: null` (o texto ainda está no `agent_logs` do turno).

**(c) Detectar feedback como DIMENSÃO ORTOGONAL — NÃO como novo valor de `agente`.**

Motivo (princípio 5): feedback não é destino de roteamento. Uma mensagem pode pedir um relatório E conter um elogio; um pedido de feature inexistente pode ser `nao_suportado` E `sugestao`. Colocar feedback como valor de `agente` forçaria um falso ou/ou e perderia sinal. O roteamento (`agente`) fica **intacto**; adicionamos um campo `feedback` que o router lê em paralelo.

**c.1 — Prompt do classificador** (`classificarIntencaoComContexto`): inserir este bloco LOGO APÓS a seção "FUNCIONALIDADES QUE A NAMI AINDA NÃO TEM":
```
FEEDBACK SOBRE A NAMI (dimensão independente do agente — coexiste com qualquer roteamento):
Avalie se a mensagem contém feedback do usuário SOBRE A NAMI (o assistente/a experiência), NÃO
sobre o tratamento ou o remédio em si. Preencha "feedback" com um destes valores, ou null:
- elogio: satisfação, gratidão afetuosa ou carinho com a Nami/o serviço
  (ex: "adorei", "você me ajuda muito", "que assistente boa"). Um "ok"/"obrigado" isolado é
  reação, NÃO elogio — só marque quando houver satisfação clara com a Nami.
- critica: insatisfação, reclamação ou frustração com a Nami/a experiência
  (ex: "isso é confuso", "cansei de confirmar toda hora", "você não me entende").
- sugestao: proposta EXPLÍCITA de melhoria ou de algo novo para a Nami
  (ex: "seria bom lembrete por voz", "vocês deviam mandar menos mensagens").
- null: nenhum feedback explícito (a maioria das mensagens).
NÃO marque feedback para comentário sobre o remédio/sintoma, nem para o simples uso de uma
funcionalidade que não temos (isso já é "nao_suportado").
```

Trocar a linha final do formato JSON de:
```
{"agente": "cadastro|relatorios|configuracao|principal|excluir_conta|nao_suportado", "subtipoRelatorio": "tomei_hoje|meus_remedios|estoque|proximo_remedio|adesao|progresso_tratamento|null"}
```
para:
```
{"agente": "cadastro|relatorios|configuracao|principal|excluir_conta|nao_suportado", "subtipoRelatorio": "tomei_hoje|meus_remedios|estoque|proximo_remedio|adesao|progresso_tratamento|null", "feedback": "elogio|critica|sugestao|null"}
```

**c.2 — `max_tokens`:** subir de `60` para `80` na chamada `anthropic.messages.create` do classificador (o JSON tem um campo a mais).

**c.3 — Parse do novo campo** (junto ao parse de `subtipoRelatorio`):
```js
const feedbacksValidos = ['elogio', 'critica', 'sugestao'];
const feedbackRaw = String(parsed?.feedback || '').trim().toLowerCase();
const feedback = feedbacksValidos.includes(feedbackRaw) ? feedbackRaw : null;
```
Incluir `feedback` em TODOS os `return` da função. O `fallback` passa a ser `{ agente: 'principal', subtipoRelatorio: null, feedback: null }`, e o retorno de sucesso inclui `feedback`.

**c.4 — Propagação e captura no `routeMessage`:**
- Declarar `let feedbackDetectado = null;` perto do topo de `routeMessage`.
- Em cada ponto que chama `classificarIntencaoComContexto` no `router.js`, capturar: `feedbackDetectado = resultado.feedback ?? feedbackDetectado;`
- `despacharEscalada` também chama o classificador: adicionar `feedback` ao seu retorno (`return { agentName, response, feedback }`) e, em quem consome, `feedbackDetectado = escalada.feedback ?? feedbackDetectado;`.
- APÓS o log final (já com `agentLogId`):
```js
if (feedbackDetectado) {
    await registrarFeedback({
        userId: user.id,
        categoria: feedbackDetectado,
        origem: 'espontaneo',
        texto: message,
        agentLogId
    });
}
```

> **Fronteira `nao_suportado` × `sugestao`:** uso/tentativa de uma capacidade que não temos → só `nao_suportado`. Proposta explícita de melhoria → `sugestao`. Se a mensagem for as duas ("seria ótimo se registrasse minha pressão"), ambos disparam — ficam ligados pelo mesmo `agent_log_id`. Aceitável e desejado.

> ⚠️ **Cobertura parcial por desenho:** o classificador só roda nos caminhos idle/geral e nas saídas de estado (`despacharEscalada`, `aguardando_periodo_adesao`, `aguardando_escolha_tratamento`). Feedback dado NO MEIO de um state machine (cadastro/configuracao/recepcionista) NÃO é pego aqui — o juiz offline (MH-54) cobre isso depois. Classificador = camada em tempo real; juiz = camada universal.

### 3.4 — `scheduler.js`: hookup próprio (entrypoint paralelo, fora do funil)

O scheduler NÃO passa pelo `catch` de `agent.js`. Cada função dele já tem try/catch em `console.error` (linhas ~33, ~78, ~132, ~189, ~231, ~300). Em cada um, adicionar (sem `agentLogId` — não há turno de usuário):
```js
import { registrarEvento } from './observabilidade.js';
// ...
    } catch (error) {
        console.error('❌ Erro no scheduler:', error.message);
        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            origem: 'scheduler',
            agent: 'scheduler',
            titulo: `Erro no scheduler: ${error.message?.split('\n')[0] ?? ''}`.slice(0, 200),
            payload: { message: error.message, stack: error.stack, funcao: 'checkAndSendReminders' }
        });
    }
```
> Ajustar `titulo`/`funcao` por função. Torna visível, entre outras, a classe de erro do BUG-066.

### 3.5 — `console.error` que "engolem" falha silenciosa → também emitir evento

Pontos onde o código captura erro e segue em frente (degradação silenciosa). Envolver com `registrarEvento` (`severidade: 'media'`, `origem: 'outro'`):
- `database.js` — handler de erro do próprio `logAgentInteraction`; `updateDoseLogZapiMessageId`.
- `whatsapp.js` — falha de envio Z-API (`sendTextMessage`).
> Os mais perigosos: o sistema degradou e ninguém viu. Não muda comportamento; só passa a registrar.

---

## PARTE 4 — `delete_user_account` NÃO é alterado (não-regressão)

**Não tocar na função.** `system_events.user_id` e `feedbacks.user_id` são `ON DELETE SET NULL`: o `DELETE FROM users` final da função os seta para NULL automaticamente. `agent_logs` é `CASCADE` (já era) → some junto, levando o texto cru. Dados pessoais apagados, aprendizado (feedback) mantido anonimizado, zero linha nova na função.

**Teste de não-regressão obrigatório** (método da v21): usuário de teste com ao menos 1 `feedbacks` e 1 `system_events`; contar antes; após a exclusão confirmar que (1) a exclusão NÃO falha, (2) as linhas de `feedbacks`/`system_events` PERMANECEM com `user_id = NULL`, (3) `agent_logs` do usuário zerou.

---

## PARTE 5 — Tabela `intencoes_nao_suportadas` (NÃO migrar as 11 linhas)

Não copiar as linhas antigas para `system_events`. Motivo: `intencoes_nao_suportadas.mensagem` é texto cru e a tabela é `CASCADE` (some na exclusão); copiá-las para uma tabela `SET NULL` faria o texto sobreviver à exclusão — regressão de LGPD. Manter a tabela velha como histórico, **parar de escrever nela** (todos os call sites migram para `registrarEvento`). Dropar fica para sessão futura, se desejado.

---

## FORA DE ESCOPO (registrado como backlog à parte)

- **MH-54 — Juiz offline (LLM-as-judge):** extração semântica pós-fato sobre `agent_logs` que detecta desvios comportamentais e não-suportados invisíveis às capturas in-line (ex: parser rejeitando resposta válida 3×, perda de contexto — vide cadastro de teste do omeprazol). Emite `system_events(..., origem='juiz_offline')`. Dá cobertura universal (inclusive cadastro/recepcionista) sem instrumentar cada agente. **Design em sessão dedicada.**
- **MH-55 — Captura proativa de feedback no relatório de adesão:** templates de adesão já pedem sugestão (adesaoTemplates ~linhas 33/34) e a resposta é descartada. Exige flag de "pergunta proativa aberta" (scheduler grava, router lê) → `registrarFeedback(origem='proativo_adesao')`. Tem implicação de produto — **amadurecer antes.**

---

## ESCRITAS EM `backlog_items` (responsabilidade do Claude Code — este chat é READ-ONLY)

**Inserts:**
- MH-53 — "Estrutura sistêmica de observabilidade (system_events + feedbacks + módulo observabilidade.js + capturas in-line)" | status: `em_validacao` (após deploy) | prioridade: `alta` | sessao_criacao: v22 | data_criacao: 2026-07-27
- MH-54 — "Juiz offline (LLM-as-judge): extração semântica de desvios comportamentais e não-suportados sobre agent_logs" | status: `aberto` | prioridade: `media` | sessao_criacao: v22 | data_criacao: 2026-07-27
- MH-55 — "Captura proativa de feedback no relatório de adesão (flag de pergunta proativa no scheduler + router)" | status: `aberto` | prioridade: `baixa` | sessao_criacao: v22 | data_criacao: 2026-07-27

**Updates (nota de relação — não fechar):**
- MH-52 — vira consumidor do backbone (leitor de `system_events` por severidade + agrupamento por `fingerprint`). Depende de MH-53.
- MH-48 — sinal de escalada pode ser modelado como `system_events`; relacionado ao backbone.
- MH-9 — dashboard = consumidor de `system_events` + `feedbacks` + `backlog_items`, com o envelope de triagem como cola.

---

## VALIDAÇÃO (após deploy)

1. Migration aplicada; query de verificação de FK retornando `SET NULL` nas duas tabelas.
2. Forçar erro técnico controlado → 1 `system_events(erro_tecnico, origem=catch_global)` + 1 linha de falha em `agent_logs`, ligadas por `agent_log_id`. Mensagem ao usuário permanece o fallback padrão.
3. Enviar elogio, crítica e sugestão → 3 `feedbacks` com `categoria`/`origem=espontaneo` corretas e `texto` preservado. Confirmar que roteamento (`agente`) não regrediu.
4. Enviar intenção claramente não suportada → 1 `system_events(intencao_nao_suportada)`; confirmar que NÃO há nova escrita em `intencoes_nao_suportadas`.
5. Forçar/observar erro no scheduler → `system_events(origem=scheduler)`.
6. Teste de não-regressão de exclusão de conta (Parte 4).
7. Ler o código real no GitHub após o push — não aceitar o resumo do Claude Code.