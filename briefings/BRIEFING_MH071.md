# BRIEFING C — MH-71: Contexto proativo lê de `eventos_proativos`, com rótulos de tempo determinísticos

**Sessão:** 28 (continuação — Parte C, final do plano de 3 partes)
**Arquivos alterados:** `src/database.js`, `src/router.js`
**Prioridade:** média
**Relacionado a:** MH-70 (Parte B — tabela + escrita, já validada em produção), MH-065 (v27 — versão original que esta substitui), MH-67, MH-68
**Depende de:** MH-70 já em produção com dados reais (confirmado: 2 eventos `lembrete` já gravados corretamente em `eventos_proativos` antes deste briefing)

---

## 1. O que muda

Esta é a parte final do plano de 3 desenhado nesta sessão: agora que `eventos_proativos` existe e está sendo alimentada (MH-70), `getContextoProativoRecente` para de reconstruir a partir do estado mutável de `dose_logs` e passa a **ler da tabela nova**. Duas mudanças de comportamento, ambas já decididas e confirmadas com Guilherme ao longo da sessão:

1. **Sem filtro de status de dose.** O erro de modelagem identificado: `temDosePendente` responde "existe ação pendente?" (pergunta operacional); o contexto proativo precisa responder "o que a Nami mostrou na tela?" (pergunta conversacional) — são perguntas diferentes, e reaproveitar o mesmo filtro misturava as duas. Uma dose já confirmada ou já `nao_informado` continua tendo acontecido.
2. **Até 6 eventos, não só o mais recente.** Substitui "o único evento mais recente" por uma janela de até 6 eventos proativos, cada um com seu próprio rótulo de tempo determinístico — para o classificador enxergar a distância real de cada um (ex: "há 2 dias" vs. "há 5 min"), em vez de inferir pela posição no texto.

Os 3 turnos reativos (`historicoConversa`, via `getHistoricoRecente`) continuam fixos e **intocados** em número — a mudança de rótulo de tempo se aplica a eles também, mas o teto de 3 não muda.

---

## 2. `database.js` — reescrever `getContextoProativoRecente`

### 2.1 — Remover a constante não usada

Localizar e remover:
```js
// Tolerância para agrupar doses do mesmo disparo. MH-032 cria uma linha por dose, cada uma
// com seu próprio new Date() — o drift de milissegundos é o mesmo do BUG-066.
const JANELA_AGRUPAMENTO_PROATIVO_MS = 60 * 1000;
```

**Nota de escopo, não é regressão:** a versão anterior agrupava doses do mesmo disparo (2 medicamentos lembrados juntos) numa linha só. A versão nova não reagrupa — cada eventos_proativos vira sua própria linha (cada medicamento de um lembrete agrupado já gera sua própria linha em `eventos_proativos`, pela instrumentação do MH-70). Na prática, um lembrete de 2 remédios vira 2 linhas em vez de 1 — dentro do teto de 6, isso é aceitável; se se mostrar excessivo com dados reais de produção, reagrupar por proximidade de `enviado_at` é um refinamento futuro, não implementado agora por falta de evidência de que seja necessário.

### 2.2 — Substituir a função inteira

Localizar todo o bloco de `getContextoProativoRecente` (do comentário `// ============================================================\n// CONTEXTO PROATIVO — MH-065` até o fechamento da função) e substituir por:

```js
// ============================================================
// CONTEXTO PROATIVO — MH-065 (v27), reescrito no MH-71/Parte C (v28)
// Mensagens que a Nami enviou por iniciativa própria (lembrete, follow-up,
// alerta de estoque, resumo semanal) não existem em agent_logs: scheduler.js,
// lembrete.js e relatorios.js não chamam logAgentInteraction. Esta função lê
// de eventos_proativos (MH-70) — registro de ENTREGA, append-only, escrito no
// instante do envio (princípio 24) — em vez de reconstruir a partir do estado
// MUTÁVEL de dose_logs, como a versão MH-065 original fazia.
//
// Por que a versão anterior foi substituída (decisão de arquitetura da v28):
// (1) dose_logs só guarda o ÚLTIMO follow-up — cada UPDATE sobrescreve o
//     anterior, então os follow-ups intermediários se perdiam antes de
//     qualquer leitura acontecer.
// (2) o filtro por status da dose (idêntico a temDosePendente) misturava duas
//     perguntas diferentes: "esta dose ainda está pendente?" (operacional) com
//     "isso apareceu na tela do usuário?" (conversacional) — uma dose já
//     confirmada ou já nao_informado continua tendo acontecido, e o
//     classificador precisa saber disso mesmo assim.
//
// Consumida SOMENTE pelo classificador central (router.js). O principal já tem
// esse contexto via getRecentDoses + bloco DOSES AGUARDANDO CONFIRMAÇÃO.
// ============================================================

const MAX_EVENTOS_PROATIVOS = 6;

export async function getContextoProativoRecente(userId, ultimoTurnoAt) {
    try {
        const { inicio: inicioDiaBRT } = janelaDiaBRT(hojeBRT());
        // SEQUÊNCIA — só entram eventos mais recentes que o último turno reativo.
        // ultimoTurnoAt null = usuário sem histórico nenhum: usa início do dia
        // como rede de segurança (mesmo papel que tinha na versão anterior).
        const corteMinimo = ultimoTurnoAt || inicioDiaBRT;

        const { data, error } = await supabase
            .from('eventos_proativos')
            .select('tipo, tentativa, horario_agendado, enviado_at, medications(nome)')
            .eq('user_id', userId)
            .gt('enviado_at', corteMinimo)
            .order('enviado_at', { ascending: true })
            .limit(MAX_EVENTOS_PROATIVOS);

        if (error) {
            return await degradar({
                origem: 'contexto_proativo',
                motivo: 'query_falhou',
                agent: 'classificador',
                userId,
                detalhe: { etapa: 'eventos_proativos' },
                fallback: []
            });
        }

        return (data || []).map(e => ({
            tipo: e.tipo,
            medicamento: e.medications?.nome || null,
            tentativa: e.tentativa,
            horarioAgendado: e.horario_agendado ? String(e.horario_agendado).substring(0, 5) : null,
            enviadoAt: e.enviado_at
        }));

    } catch (e) {
        return await degradar({
            origem: 'contexto_proativo',
            motivo: 'query_falhou',
            agent: 'classificador',
            userId,
            detalhe: { excecao: true },
            fallback: []
        });
    }
}
```

**Sem mudança de import necessária** — `janelaDiaBRT`, `hojeBRT` e `degradar` já estão importados no topo do arquivo (usados pela versão anterior desta mesma função). A entrada `contexto_proativo:query_falhou` já existe no catálogo `DEGRADACOES` (v27) — continua válida, a chave não muda.

**Contrato novo:** a função agora sempre devolve um **array** (vazio quando não há eventos), nunca mais `null`. Isso muda o jeito de checar no `router.js` — ver seção 3.

---

## 3. `router.js` — renderização em múltiplas linhas + rótulo de tempo

### 3.1 — Substituir `renderizarContextoProativo` por duas funções novas

Localizar:
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

Substituir por:
```js
// MH-70/Parte C (v28) — rótulo de tempo determinístico, comum ao bloco reativo
// e ao proativo, pra que o classificador enxergue a distância real entre os
// turnos em vez de inferir pela posição no texto (nenhum dos dois blocos tinha
// rótulo de tempo nenhum antes desta sessão).
function formatarTempoRelativo(timestamp) {
    const minutos = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
    if (minutos < 1) return 'agora mesmo';
    if (minutos < 60) return `há ${minutos} min`;
    const horas = Math.round(minutos / 60);
    if (horas < 24) return `há ${horas}h`;
    const dias = Math.round(horas / 24);
    return `há ${dias} dia${dias > 1 ? 's' : ''}`;
}

const ROTULOS_EVENTO_PROATIVO = {
    lembrete: 'lembrete de dose',
    follow_up: 'follow-up de dose',
    alerta_estoque_zerado: 'aviso de estoque zerado',
    alerta_estoque_nao_informado: 'aviso de estoque (dose não confirmada)',
    resumo_semanal: 'resumo semanal de adesão'
};

// MH-065 (v27) / reescrito MH-70/Parte C (v28) — renderiza CADA evento proativo
// como sua própria linha da cronologia, em vez de só o mais recente. O rótulo
// entre colchetes é DESCRITIVO (evita que o LLM leia as linhas como turno de
// usuário), nunca diretivo. Não é seção destacada, não leva instrução de
// precedência — a cronologia e o rótulo de tempo carregam a informação sozinhos.
function renderizarEventosProativos(eventos) {
    if (!eventos || eventos.length === 0) return '';

    const linhas = eventos.map(ev => {
        const rotulo = ROTULOS_EVENTO_PROATIVO[ev.tipo] || 'mensagem automática';
        const tentativaTexto = ev.tipo === 'follow_up' && ev.tentativa ? ` (cobrança ${ev.tentativa})` : '';
        const medTexto = ev.medicamento
            ? ` — ${ev.medicamento}${ev.horarioAgendado ? ` (dose das ${ev.horarioAgendado})` : ''}`
            : '';
        return `Nami: ${rotulo}${tentativaTexto}${medTexto} — enviado ${formatarTempoRelativo(ev.enviadoAt)}`;
    }).join('\n');

    return `[mensagens automáticas da Nami — sem resposta do usuário até aqui]\n${linhas}`;
}
```

### 3.2 — Atualizar `classificarIntencaoComContexto`: rótulo de tempo no bloco reativo + novo bloco proativo

Localizar:
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

Substituir por:
```js
        // Monta o histórico como texto legível para o LLM. MH-70/Parte C: cada turno
        // ganha um rótulo de tempo determinístico — antes desta sessão, nenhum dos
        // dois blocos (reativo ou proativo) tinha noção de distância temporal alguma.
        const historicoReativo = historicoConversa.length > 0
            ? historicoConversa.map(h => {
                const contextoResumo = h.contexto_conversa?.medicationNome
                    ? ` [em andamento: configuração sobre ${h.contexto_conversa.medicationNome}, etapa ${h.contexto_conversa.etapa}]`
                    : '';
                const tempo = h.created_at ? ` (${formatarTempoRelativo(h.created_at)})` : '';
                return `Usuário: ${h.user_message}\nNami: ${h.agent_response}${contextoResumo}${tempo}`;
              }).join('\n\n')
            : 'Sem histórico recente.';

        // MH-065/MH-70/Parte C: até 6 eventos proativos entram na MESMA linha do tempo,
        // no fim (por construção da regra de sequência, são mais recentes que os 3
        // turnos reativos). NÃO é seção destacada e NÃO leva instrução de precedência —
        // a cronologia e o rótulo de tempo carregam a informação sozinhos. Campos
        // rotulados, sem genitivo solto: "lembrete de X" é ambíguo quando o nome do
        // medicamento soa como nome próprio (ex. "Elani").
        // Quando não há evento proativo, historicoTexto fica idêntico ao de antes.
        const eventosProativosTexto = renderizarEventosProativos(contextoProativo);
        const historicoTexto = eventosProativosTexto
            ? `${historicoReativo}\n\n${eventosProativosTexto}`
            : historicoReativo;
```

**Nenhuma outra mudança** em `classificarIntencaoComContexto` — o restante do prompt, a chamada ao LLM e o parsing da resposta ficam intactos. Nenhuma mudança em `despacharEscalada` nem nos 4 pontos de chamada de `classificarIntencaoComContexto` — todos já passam `contextoProativo` adiante sem tocar no conteúdo.

---

## 4. Verificação antes de considerar concluído

```bash
node --check src/database.js
node --check src/router.js
```

Commit (`feat: contexto proativo lê de eventos_proativos, com rótulos de tempo determinísticos (MH-71)`), push.

---

## 5. Registro no backlog

- **MH-71**
  - Título: "Contexto proativo do classificador central lê de eventos_proativos (não mais dose_logs), com rótulos de tempo determinísticos e janela de até 6 eventos"
  - Status inicial: `em_validacao`
  - Prioridade: média
  - Relacionado a: MH-70, MH-065, MH-67, MH-68
  - `causa_raiz`/contexto: resumo da seção 1

---

## 6. Validação — cenário de teste

Este é o teste que motivou a sessão inteira: o cenário do "S" isolado (v27) e do "Tomei o ômega 3" ignorado durante um fluxo de configuração (BUG-082, início desta sessão).

**Reprodução mínima:**
1. Deixe um lembrete de dose disparar normalmente (ou espere os que você já adiantou hoje).
2. Sem responder, inicie um fluxo qualquer de configuração (ex: `Pausar [outro remédio]`) e deixe a pergunta de confirmação pendente.
3. Responda com uma confirmação de dose referente ao lembrete do passo 1 (ex: `Tomei o [remédio do lembrete]`) — deve escalar (BUG-082 já garante isso) e chegar ao classificador central com o contexto proativo agora enriquecido.
4. **Esperado — o que precisa ser conferido em `agent_logs`:** o campo `agent` do turno mostra **`principal`**, não `configuracao`. É a decisão de roteamento em si que está sendo validada — o classificador central reconhecendo, a partir do contexto proativo enriquecido, que a mensagem é sobre a dose lembrada e não sobre o fluxo de configuração ainda pendente. Isso é literalmente o caso que originou o MH-065 (o "S" isolado que ia parar em `configuracao` na v27) — a melhoria só está validada se o roteador acertar o destino, não só se o `principal`, uma vez alcançado, souber confirmar a dose corretamente (isso o `principal` já sabia fazer antes desta sessão inteira).

Não há como inspecionar diretamente o texto exato do prompt enviado à IA (não é logado — mesma limitação já registrada na v27), mas o `agent` do turno em `agent_logs` é o sinal observável direto da decisão do roteador. Se quiser confirmar o conteúdo do prompt de perto, um teste isolado rodando `getContextoProativoRecente` diretamente (fora do fluxo do WhatsApp) contra os dados reais de hoje mostraria o array exato retornado.