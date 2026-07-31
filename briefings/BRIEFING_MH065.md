# BRIEFING — MH-065: contexto proativo para o classificador central

**Sessão:** v27 (30/07/2026)
**Tipo:** IMPLEMENTAÇÃO
**Item:** MH-065 (`aberto` → `em_validacao` ao fim da execução)

**Invariantes desta rodada:**
- **Não tocar em `src/juizOffline.js`.** Nenhuma linha. Decisão explícita de Guilherme.
- Não tocar em `src/scheduler.js` nem em `src/agentes/lembrete.js`.
- Nenhuma escrita nova em `agent_logs`. Nenhuma migration. Nenhuma alteração de schema.
- Não alterar `formatarHistoricoConversa` (`database.js`) — ela é consumida por 4 agentes.
- Não alterar o limite de `getHistoricoRecente` (segue 3).

---

## 1. O problema, com a medição que o define

O classificador central lê apenas `agent_logs`. Tudo que a Nami envia por iniciativa própria
— lembrete de dose, follow-up, aviso de estoque zerado — é enviado por `scheduler.js` e
`lembrete.js`, que **não escrevem em `agent_logs`**. Confirmado por leitura de código:
`logAgentInteraction` tem 3 call sites, todos no caminho reativo (`router.js:539`,
`router.js:1000`, `agent.js:31`).

Consequência: quando o usuário responde a um lembrete, o classificador enxerga como "turno
anterior" a última conversa reativa dele — que pode ser de outro assunto.

### Medição contra todo o histórico (05/06 → 30/07)

Turnos de usuário que chegaram até 15 min depois de um `reminder_sent_at`:

| Métrica | Valor |
|---|---|
| Turnos na janela | 294 |
| Turnos em que o lembrete era o turno real anterior (invisível ao classificador) | **169** |
| Destes, com histórico visível de outro assunto na última hora | **30** |
| Destes, mensagens curtas (≤4 caracteres) | 127 |

### Por que o dano é raro apesar da frequência

Dos 169 turnos, **158 foram para `principal`** — o destino correto. Duas camadas mascaram a
lacuna: o fast-path `detectarConfirmacaoDose` intercepta a maioria das confirmações curtas
antes do classificador, e `principal` é o fallback natural.

Dos 11 que não foram para `principal`, **10 eram roteamento correto** — mensagens
auto-suficientes (`"Qual meu estoque de dipirona?"`, `"Parar losartana"`). Princípio 17 em
ação: o texto literal resolveu sozinho.

### A formulação precisa da causa raiz

> O histórico incompleto só causa dano quando a mensagem do usuário **não é auto-suficiente** —
> resposta curta ou anafórica cujo significado depende inteiramente do que a Nami acabou de
> dizer. Mensagens auto-suficientes atravessam a lacuna sem consequência.

### O único caso de dano real (`agent_log e9cbd89b`, 27/07 21:01 BRT)

1. Lembrete do Ômega 3 às 20:58, respondido com `"S"` às 21:01.
2. `detectarConfirmacaoDose("S")` → `false`. **Não é defeito** — o caminho previsto é cair no
   classificador e chegar ao `principal`, cujo system prompt trata afirmação curta como
   CONFIRM_DOSE.
3. O classificador vê o histórico — e o lembrete não existe em `agent_logs`. O visível era a
   conversa de configuração de 6 minutos antes. Roteou para `configuracao`.
4. `configuracao` não tem o que fazer com `"S"` → escala.
5. `despacharEscalada` refaz a pergunta ao mesmo classificador. Volta `configuracao`.
6. L473 não intercepta → objeto vaza → 400 → *"Desculpe, tive um probleminha"*.

**Consequência:** a dose não foi confirmada e o usuário recebeu follow-ups às 21:28 e 22:30
cobrando o que já havia respondido.

**Contraprova (`agent_log b3a73e23`, 30/07 15:48):** o mesmo `"S"`, também em `idle`, foi
roteado para `principal` e confirmou a dose. A diferença é que o histórico recente não continha
conversa de outro domínio. O defeito é **condicional ao histórico enviesado**.

> **Nota de correção de registro:** o `CONTEXT.md` da v26 data este incidente como 28/07. A data
> correta é **27/07 21:01 BRT** (= 28/07 00:01 UTC, que bate com o `system_events` de
> `Exceção não tratada: Request failed with status code 400`). Corrigir no encerramento.

---

## 2. Decisões de arquitetura

### 2.1 Enriquecer a partir de `dose_logs`, não escrever em `agent_logs`

**Descartada:** inserir os turnos proativos em `agent_logs`.

Motivo primário — **semântico, não de risco**: `agent_logs` registra a resposta PRETENDIDA
(princípio 24: `logAgentInteraction` roda antes de `sendTextMessage`). Já `dose_logs` é escrito
**depois** do envio, em todos os pontos:

| Ponto | Ordem verificada |
|---|---|
| `scheduler.js:203` (agrupado) | `sendTextMessage` → `createDoseLog` |
| `scheduler.js:259` (follow-up agrupado) | `sendTextMessage` → `updateDoseLogTentativa` |
| `scheduler.js:309` (sem estoque) | `sendTextMessage` → `createDoseLog` |
| `scheduler.js:333` (individual) | `sendTextMessage` → `createDoseLog` |
| `lembrete.js:103` (follow-up) | `sendTextMessage` → `updateDoseLogTentativa` |

`dose_logs` é **registro de entrega**. Inserir esse fato em `agent_logs` seria colocar um fato
de entrega numa tabela de intenção.

Motivo secundário — superfície: nenhum consumidor de `agent_logs` muda. Não muda
`formatarHistoricoConversa`, não muda `precisaSaudacao`, não muda a composição de episódios do
Juiz Offline, não muda o limite de 3.

### 2.2 Redundância intencional com o Juiz Offline — documentada, não unificada

`juizOffline.js:205-232` já faz uma reconstrução de lembrete a partir de `dose_logs`. **Não
vamos extrair função compartilhada nesta sessão.** Os contratos ainda não são iguais:

| | Juiz Offline | Classificador central |
|---|---|---|
| Âncora de tempo | instante passado (1º turno do episódio) | agora |
| Finalidade | julgar retrospectivamente | rotear em tempo real |
| Ciclo | batch diário | por mensagem |

O princípio 30 trata de **mesmo contrato replicado**. Ainda não é o caso.

**Gatilho de revisão:** na próxima reavaliação do Juiz Offline, comparar as duas
implementações. Se o contrato tiver convergido, unificar. Registrar como MH.

Efeito colateral positivo: a função nova segue a **regra padrão do projeto** (duas etapas com
`.in()`), sem herdar o `!inner` que hoje existe só no juiz.

### 2.3 Regra de inclusão: estado + sequência + rede de segurança

O evento proativo entra **se e somente se** as três condições valerem:

```
(1) ESTADO — dose ainda aguardando resposta:
    reminder_sent = true
    confirmed = false
    status ∉ {pausado, nao_tomado, nao_informado, sem_estoque}

(2) SEQUÊNCIA — o evento é mais recente que o último turno registrado:
    instanteEvento > created_at do turno mais recente em historicoConversa

(3) REDE DE SEGURANÇA — dentro do dia da dose (BRT):
    scheduled_at >= início do dia de hoje em BRT
```

**Por que (1) é de estado e não de relógio.** A cadência de follow-up é 30min + 1h + 30min, e
então `markAsNaoInformado`. O próprio ciclo de vida da dose fecha a janela em ~2h — sem
constante de tempo arbitrária. A condição é a mesma de `temDosePendente` (`router.js:48-54`),
o que mantém as duas leituras consistentes.

**Por que (2) sozinha não basta.** Cenário: último `agent_log` na segunda, lembrete na terça sem
resposta, usuário escreve na sexta. O lembrete de terça É mais recente que segunda, passaria em
(2), e seria injetado como "turno imediatamente anterior". Na prática (1) já barra (a dose
viraria `nao_informado` na terça à noite), e (3) barra de novo.

**Por que (3) existe.** Se o scheduler cair, uma dose fica `pendente` indefinidamente e (1) não
a fecha. (3) é rede, não regra principal.

### 2.4 O bloco NÃO é predominante

O classificador precisa ver o proativo **e** o reativo. Deixar o bloco proativo predominante
cegaria o classificador do outro lado — modo de falha simétrico ao que estamos corrigindo.

Três decisões que garantem isso:

1. **Integração cronológica, não seção destacada.** O evento entra no fim da mesma linha do
   tempo do bloco `CONVERSA RECENTE`, porque por (2) ele é mais recente que os 3 turnos.
2. **Zero linguagem instrucional.** Nenhuma frase de precedência, nenhum "considere que". A
   cronologia carrega a informação sozinha. O rótulo entre colchetes é descritivo, existe só
   para o LLM não ler a linha como turno de usuário.
3. **Renderização condicional.** Sem evento proativo, o prompt fica **byte a byte idêntico** ao
   de hoje. Isso limita o raio de qualquer regressão aos casos-alvo.

**Divisão de trabalho preservada:** o classificador responde apenas *qual agente*. Quem decide
confirmação de dose é o `principal`, que já tem o bloco `DOSES AGUARDANDO CONFIRMAÇÃO` com
`[ref:]` e a instrução de precedência. Não duplicar essa regra no classificador — seriam dois
donos da mesma decisão.

### 2.5 Escopo de propagação: só o classificador

`principal.js:72` já chama `getRecentDoses(user.id, 3)` e monta o bloco
`DOSES AGUARDANDO CONFIRMAÇÃO`. Ele **já tem** esse contexto, em formato mais forte (com
`doseLogId` para agir). A cegueira é exclusiva do roteador.

**Não propagar** para `principal`, `cadastro`, `configuracao`, `exclusaoConta`.

### 2.6 Fora de cobertura, declarado

| Envio proativo | Registro | Coberto? |
|---|---|---|
| `lembrete.js:133` — alerta de estoque pós-`nao_informado` | nenhum | ❌ |
| `relatorios.js:665` — resumo semanal | só `adesao_estado.updated_at` | ❌ |
| `lembrete.js:76` — cuidador | `caregiver_notified` | ❌ (outro telefone, não é contexto do paciente) |

Exposição medida do resumo semanal: **1 turno de usuário** em todo o histórico dentro de 1h30
depois de um domingo 16:00 (28/06, `"Tomei"`, roteado corretamente). Lacuna conhecida, não
oculta.

---

## 3. Implementação

### 3.1 `src/database.js` — nova função

Adicionar ao import do topo (linha 4):

```js
import { registrarEvento, degradar } from './observabilidade.js';
```

Acrescentar a função ao final da seção `HISTÓRICO RECENTE` (depois de
`formatarHistoricoConversa`):

```js
// ============================================================
// CONTEXTO PROATIVO — MH-065
// Mensagens que a Nami enviou por iniciativa própria (lembrete/follow-up) não existem em
// agent_logs: scheduler.js e lembrete.js não chamam logAgentInteraction. Esta função
// reconstrói o ÚLTIMO evento proativo a partir de dose_logs, que é registro de ENTREGA
// (escrito DEPOIS de sendTextMessage), ao contrário de agent_logs que é registro de
// INTENÇÃO (princípio 24).
//
// Consumida SOMENTE pelo classificador central (router.js). O principal já tem esse
// contexto via getRecentDoses + bloco DOSES AGUARDANDO CONFIRMAÇÃO.
//
// Redundância intencional com juizOffline.js:205-232 (v27): os contratos diferem — o juiz
// ancora num instante passado para julgar, esta ancora no agora para rotear. Reavaliar
// unificação na próxima revisão do Juiz Offline.
// ============================================================

// Tolerância para agrupar doses do mesmo disparo. MH-032 cria uma linha por dose, cada uma
// com seu próprio new Date() — o drift de milissegundos é o mesmo do BUG-066.
const JANELA_AGRUPAMENTO_PROATIVO_MS = 60 * 1000;

export async function getContextoProativoRecente(userId, ultimoTurnoAt) {
    try {
        // Duas etapas com .in() — regra do projeto (BUG-017/BUG-023). Filtro via join
        // não é usado aqui de propósito.
        const { data: meds, error: erroMeds } = await supabase
            .from('medications')
            .select('id, nome')
            .eq('user_id', userId)
            .eq('ativo', true);

        if (erroMeds) {
            return await degradar({
                origem: 'contexto_proativo',
                motivo: 'query_falhou',
                agent: 'classificador',
                userId,
                detalhe: { etapa: 'medications' },
                fallback: null
            });
        }

        if (!meds || meds.length === 0) return null;

        const medNomeMap = Object.fromEntries(meds.map(m => [m.id, m.nome]));
        const medicationIds = meds.map(m => m.id);

        // (3) rede de segurança: dose do dia de hoje em BRT
        const { inicio: inicioDiaBRT } = janelaDiaBRT(hojeBRT());

        const { data, error } = await supabase
            .from('dose_logs')
            .select('id, medication_id, horario_agendado, scheduled_at, status, confirmed, ' +
                    'reminder_sent, reminder_sent_at, tentativas, ultima_tentativa_at')
            .in('medication_id', medicationIds)
            .eq('reminder_sent', true)
            .eq('confirmed', false)
            .gte('scheduled_at', inicioDiaBRT);

        if (error) {
            return await degradar({
                origem: 'contexto_proativo',
                motivo: 'query_falhou',
                agent: 'classificador',
                userId,
                detalhe: { etapa: 'dose_logs' },
                fallback: null
            });
        }

        // (1) ESTADO — mesma condição de temDosePendente (router.js:48-54). Filtrado em JS
        // de propósito: mantém a definição idêntica num lugar só, legível lado a lado.
        const aguardando = (data || []).filter(d =>
            d.status !== 'pausado' &&
            d.status !== 'nao_tomado' &&
            d.status !== 'nao_informado' &&
            d.status !== 'sem_estoque'
        );

        if (aguardando.length === 0) return null;

        // instante do evento = a última coisa que a Nami efetivamente enviou sobre esta dose
        const instanteDe = (d) => {
            const t = [d.reminder_sent_at, d.ultima_tentativa_at]
                .filter(Boolean)
                .map(x => new Date(x).getTime());
            return t.length ? Math.max(...t) : null;
        };

        const comInstante = aguardando
            .map(d => ({ dose: d, instante: instanteDe(d) }))
            .filter(x => x.instante !== null);

        if (comInstante.length === 0) return null;

        const maisRecente = Math.max(...comInstante.map(x => x.instante));

        // (2) SEQUÊNCIA — só entra se for mais recente que o último turno registrado.
        // ultimoTurnoAt null = usuário sem histórico nenhum: o evento é o único contexto.
        if (ultimoTurnoAt && maisRecente <= new Date(ultimoTurnoAt).getTime()) return null;

        // Agrupa as doses do MESMO disparo (MH-032)
        const doGrupo = comInstante.filter(x =>
            maisRecente - x.instante <= JANELA_AGRUPAMENTO_PROATIVO_MS
        );

        const ehFollowUp = doGrupo.some(x =>
            x.dose.ultima_tentativa_at &&
            new Date(x.dose.ultima_tentativa_at).getTime() === x.instante &&
            (x.dose.tentativas || 1) > 1
        );

        const tentativa = Math.max(...doGrupo.map(x => x.dose.tentativas || 1));

        return {
            tipo: ehFollowUp ? 'follow_up' : 'lembrete',
            tentativa,
            agrupado: doGrupo.length > 1,
            minutosAtras: Math.max(0, Math.round((Date.now() - maisRecente) / 60000)),
            doses: doGrupo.map(x => ({
                nome: medNomeMap[x.dose.medication_id] || 'medicamento',
                horario: x.dose.horario_agendado
                    ? String(x.dose.horario_agendado).substring(0, 5)
                    : null
            }))
        };

    } catch (e) {
        return await degradar({
            origem: 'contexto_proativo',
            motivo: 'query_falhou',
            agent: 'classificador',
            userId,
            detalhe: { excecao: true },
            fallback: null
        });
    }
}
```

### 3.2 `src/observabilidade.js` — catálogo de degradação

No objeto `DEGRADACOES` (linha 62), acrescentar entrada:

```js
    'contexto_proativo:query_falhou': {
        severidade: 'media',
        titulo: 'Contexto proativo não pôde ser lido — classificador seguiu sem ele'
    },
```

Severidade `media`: o roteamento continua funcionando como hoje (é a ausência que estamos
corrigindo, então a degradação devolve ao estado anterior — ruim, não catastrófico).

### 3.3 `src/router.js` — busca no ponto único

Localizar (linha ~573):

```js
    // Histórico conversacional — buscado UMA vez, propagado a todos os agentes LLM
    const historicoConversa = await getHistoricoRecente(user.id, 3);
```

Substituir por:

```js
    // Histórico conversacional — buscado UMA vez, propagado a todos os agentes LLM
    const historicoConversa = await getHistoricoRecente(user.id, 3);

    // Contexto proativo (MH-065) — buscado UMA vez aqui, propagado SÓ ao classificador
    // central e ao despacharEscalada. Os agentes não recebem: o principal já tem o bloco
    // DOSES AGUARDANDO CONFIRMAÇÃO, que é mais forte (traz o doseLogId).
    // historicoConversa vem em ordem cronológica (mais antigo primeiro) — o último item é
    // o turno mais recente. O turno ATUAL ainda não foi logado (logAgentInteraction roda no
    // fim de routeMessage, L1000), então não há off-by-one.
    const ultimoTurnoAt = historicoConversa.at(-1)?.created_at ?? null;
    const contextoProativo = await getContextoProativoRecente(user.id, ultimoTurnoAt);
```

Adicionar `getContextoProativoRecente` ao import de `./database.js` no topo do arquivo.

### 3.4 `src/router.js` — renderização no classificador

Localizar (linha 280):

```js
async function classificarIntencaoComContexto({ message, currentState, historicoConversa }) {
```

Substituir por:

```js
async function classificarIntencaoComContexto({ message, currentState, historicoConversa, contextoProativo = null }) {
```

Localizar o bloco de montagem do histórico (linhas 284-292):

```js
        // Monta o histórico como texto legível para o LLM
        const historicoTexto = historicoConversa.length > 0
            ? historicoConversa.map(h => {
                const contextoResumo = h.contexto_conversa?.medicationNome
                    ? ` [em andamento: configuração sobre ${h.contexto_conversa.medicationNome}, etapa ${h.contexto_conversa.etapa}]`
                    : '';
                return `Usuário: ${h.user_message}\nNami: ${h.agent_response}${contextoResumo}`;
              }).join('\n\n')
            : 'Sem histórico recente.';
```

Substituir por:

```js
        // Monta o histórico como texto legível para o LLM
        const historicoReativo = historicoConversa.length > 0
            ? historicoConversa.map(h => {
                const contextoResumo = h.contexto_conversa?.medicationNome
                    ? ` [em andamento: configuração sobre ${h.contexto_conversa.medicationNome}, etapa ${h.contexto_conversa.etapa}]`
                    : '';
                return `Usuário: ${h.user_message}\nNami: ${h.agent_response}${contextoResumo}`;
              }).join('\n\n')
            : 'Sem histórico recente.';

        // MH-065: mensagem proativa entra na MESMA linha do tempo, no fim (por construção da
        // regra de sequência ela é mais recente que os 3 turnos). NÃO é seção destacada e
        // NÃO leva instrução de precedência — a cronologia carrega a informação sozinha.
        // Campos rotulados, sem genitivo solto: "lembrete de X" é ambíguo quando o nome do
        // medicamento soa como nome próprio (ex. "Elani").
        // Quando não há evento proativo, historicoTexto fica idêntico ao de antes.
        const historicoTexto = contextoProativo
            ? `${historicoReativo}\n\n${renderizarContextoProativo(contextoProativo)}`
            : historicoReativo;
```

Acrescentar a função de renderização **imediatamente antes** de
`classificarIntencaoComContexto`:

```js
// MH-065 — renderiza o evento proativo como uma linha da cronologia da conversa.
// O rótulo entre colchetes é DESCRITIVO (evita que o LLM leia a linha como turno de
// usuário), nunca diretivo. Sem ele, a alternativa seria "Usuário: null".
function renderizarContextoProativo(ctx) {
    const rotuloTipo = ctx.tipo === 'follow_up'
        ? `follow-up de dose (cobrança ${ctx.tentativa})`
        : (ctx.agrupado ? 'lembrete de dose (agrupado)' : 'lembrete de dose');

    const listaMeds = ctx.doses
        .map(d => (d.horario ? `${d.nome} (dose das ${d.horario})` : d.nome))
        .join(', ');

    const rotuloMeds = ctx.doses.length > 1 ? 'medicamentos' : 'medicamento';

    return `[mensagem automática da Nami — sem resposta do usuário até aqui]\n` +
           `Nami: ${rotuloTipo} — ${rotuloMeds}: ${listaMeds} — enviado ${ctx.minutosAtras} min atrás`;
}
```

**Forma resultante do bloco no prompt (3 turnos reativos + 1 proativo):**

```
=== CONVERSA RECENTE ===
Usuário: [...]
Nami: [...]

Usuário: [...]
Nami: [...] [em andamento: configuração sobre Ômega 3, etapa identif_intencao]

Usuário: [...]
Nami: [...]

[mensagem automática da Nami — sem resposta do usuário até aqui]
Nami: lembrete de dose — medicamento: Ômega 3 (dose das 20:00) — enviado 3 min atrás
```

### 3.5 `src/router.js` — os 4 call sites do classificador

**(a) linha ~676:**

```js
            const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
                message, currentState, historicoConversa, contextoProativo
            });
```

**(b) linha ~763:** mesma alteração.

**(c) linha ~943:**

```js
        const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
            message,
            currentState,
            historicoConversa,
            contextoProativo
        });
```

**(d) dentro de `despacharEscalada` (linha ~463)** — ver 3.6.

### 3.6 `src/router.js` — `despacharEscalada`

**Obrigatório, não opcional:** é o passo 5 da cadeia do `"S"`. Sem isso, a reclassificação
repete a decisão cega e a cadeia continua inteira.

Localizar (linha 462):

```js
async function despacharEscalada({ user, message, image, contextoPreservado, historicoConversa }) {
    const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
        message, currentState: 'configurando', historicoConversa
    });
```

Substituir por:

```js
async function despacharEscalada({ user, message, image, contextoPreservado, historicoConversa, contextoProativo = null }) {
    // MH-065: recebe o contextoProativo JÁ BUSCADO pelo roteador — nenhuma query nova
    // (princípio 6: buscar uma vez, propagar).
    const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
        message, currentState: 'configurando', historicoConversa, contextoProativo
    });
```

Nos **5 call sites** de `despacharEscalada` (linhas ~712, ~799, ~837, ~858, ~971), acrescentar
`contextoProativo` ao objeto passado. Exemplo (linha 712):

```js
                        const escalada = await despacharEscalada({
                            user, message, image, historicoConversa, contextoProativo,
                            contextoPreservado: null
                        });
```

---

## 4. O que NÃO muda — verificar que continua intacto

- `formatarHistoricoConversa` em `database.js`
- `getHistoricoRecente` (assinatura e limite 3)
- `precisaSaudacao` / `getUltimaInteracao`
- `src/juizOffline.js` — **nenhuma linha**
- `src/scheduler.js`, `src/agentes/lembrete.js`
- `principal.js`, `cadastro.js`, `configuracao.js`, `exclusaoConta.js`
- O prompt do classificador quando não há evento proativo — **idêntico ao atual**

---

## 5. Critério de conclusão

O critério é um comando que varre o projeto, nunca a lista que o autor conseguiu enumerar
(princípio 31, corolário).

```bash
# 1. Todos os call sites do classificador recebem contextoProativo.
#    Esperado: 4 ocorrências de classificarIntencaoComContexto({ e 4 de contextoProativo
#    dentro do bloco de cada chamada.
grep -n "classificarIntencaoComContexto({" -A 5 src/router.js | grep -c "contextoProativo"
# → deve retornar 4

# 2. Todos os call sites de despacharEscalada propagam.
grep -n "despacharEscalada({" -A 4 src/router.js | grep -c "contextoProativo"
# → deve retornar 5 (a linha 462 é a definição, não conta)

# 3. Nenhum arquivo proibido foi tocado.
git diff --name-only
# → deve listar SOMENTE: src/router.js, src/database.js, src/observabilidade.js

# 4. Nenhuma escrita nova em agent_logs.
grep -rn "logAgentInteraction" src/ | wc -l
# → deve continuar 4 (1 definição + 3 call sites)

# 5. A função nova não usa filtro via join.
grep -n "!inner\|\.eq('medications\." src/database.js
# → não deve retornar nada
```

---

## 6. Validação em produção

### 6.1 Cenário-alvo (o que deve passar a funcionar)

Reproduzir a condição do `e9cbd89b`:
1. Estar em conversa de configuração sobre um medicamento.
2. Aguardar (ou disparar) lembrete de dose de **outro** medicamento.
3. Responder com `"S"` (ou outra afirmação curta que `detectarConfirmacaoDose` não pegue).

**Esperado:** roteamento para `principal`, dose confirmada, sem follow-up posterior.
**Evidência a coletar:** `agent_logs.agent = 'principal'` no turno, `dose_logs.confirmed = true`.

### 6.2 Não-regressão — os 10 casos nominais

Todos tinham lembrete recente e nenhum deveria ir para `principal`. É aqui que uma
predominância indevida do bloco proativo apareceria.

| Mensagem | Destino que deve ser mantido |
|---|---|
| `"Qual meu estoque de dipirona?"` | `relatorios` |
| `"Quero saber o estoque do losartana"` | `relatorios` |
| `"Tomei remédio anteontem?"` | `relatorios` |
| `"Tomei remédio no domingo?"` | `relatorios` |
| `"Quero só saber se pulei algum remédio ontem"` | `relatorios` |
| `"Ficou alguma dose pendente?"` | `relatorios` |
| `"Como tô com meu tratamento?"` | `relatorios` |
| `"Parar losartana"` | `configuracao` |
| `"Não preciso mais tomar o losartana"` | `configuracao` |
| `"Quero cadastrar dipirona"` | `cadastro` |

### 6.3 Query de acompanhamento

```sql
-- Roteamentos suspeitos: mensagem curta logo após evento proativo indo para
-- configuracao/cadastro. Linha de base histórica: 1 ocorrência em 2 meses.
WITH lembretes AS (
  SELECT m.user_id, dl.reminder_sent_at
  FROM dose_logs dl JOIN medications m ON m.id = dl.medication_id
  WHERE dl.reminder_sent_at IS NOT NULL
)
SELECT al.id, al.agent, al.estado_conversa, left(al.user_message, 60) AS msg,
       al.created_at AT TIME ZONE 'America/Sao_Paulo' AS turno_brt
FROM agent_logs al
WHERE al.user_message IS NOT NULL
  AND length(trim(al.user_message)) <= 8
  AND al.agent IN ('configuracao', 'cadastro')
  AND EXISTS (
    SELECT 1 FROM lembretes l
    WHERE l.user_id = al.user_id
      AND l.reminder_sent_at <= al.created_at
      AND l.reminder_sent_at > al.created_at - interval '15 minutes'
  )
ORDER BY al.created_at DESC;
```

---

## 7. Riscos assumidos explicitamente

1. **Mexer no classificador central afeta todo o roteamento.** Mitigado pela renderização
   condicional: sem evento proativo, o prompt é idêntico ao atual.
2. **O ganho é probabilístico.** Melhoramos a entrada de um componente LLM; não garantimos a
   saída. O sinal determinístico (passar `temDosePendente` ao classificador) fica **fora**
   desta rodada de propósito, para conseguirmos isolar o efeito deste. Empilhar as duas
   camadas de uma vez tornaria impossível saber qual funcionou.
3. **Segunda implementação da mesma ideia** (juiz + classificador), deliberada, documentada e
   com gatilho de revisão.
4. **Duas idas ao banco a mais por mensagem recebida** (`medications` + `dose_logs`).
   `getRecentDoses` já é chamada pelo `principal` e, condicionalmente, por `temDosePendente` —
   há redundância de leitura no fluxo. Consolidação **deliberadamente adiada**: tocaria no
   `principal`, que está fora do escopo. Registrar como MH.

---

## 8. Registro no backlog (`backlog_items`)

Via `atualizarStatusBacklogItem` / `registrarItemBacklog` — nunca SQL direto (princípio 16).

- **MH-065** → `em_validacao`
- **MH novo** — "Unificar reconstrução de contexto proativo entre juizOffline e classificador
  central quando os contratos convergirem" — prioridade `baixa`
- **MH novo** — "Consolidar leituras redundantes de dose_logs no fluxo de uma mensagem
  (getRecentDoses × temDosePendente × getContextoProativoRecente)" — prioridade `baixa`
- **MH novo** — "Registrar resultado de diagnóstico como arquivo em briefings/, não só em
  conversa (H1/H2/H3 do juiz ficou fora do repositório)" — prioridade `baixa`

---

## 9. Correções de documentação para o encerramento

1. `agent_log e9cbd89b` é de **27/07 21:01 BRT**, não 28/07 (a v26 registrou a data UTC).
2. A linha do `scheduler.js` em "Estrutura de Arquivos" diz que o cron do resumo semanal está
   **sem** timezone. Ele **tem** (`scheduler.js:45`), e o dado de produção confirma:
   `adesao_estado.updated_at` em 26/07 19:00 UTC = 16:00 BRT. A pendência aberta na v24 está
   fechada por evidência.
3. Registrar a conclusão do diagnóstico do falso positivo do juiz (H1 descartada — a query com
   `!inner` funciona; H3 nova — ambiguidade da `notaLembrete` quando o nome do medicamento soa
   como nome próprio). **Nenhuma correção aplicada nesta sessão**, por decisão de escopo.