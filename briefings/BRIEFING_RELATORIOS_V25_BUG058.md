# BRIEFING — Redesenho do fluxo de relatórios (v25)

**Sessão:** v25 (29/07/2026)
**Itens de backlog cobertos:** BUG-58 (filtro de estoque), BUG-70 (novo — `getDosesHoje` filtra por
`taken_at`), BUG-71 (novo — `detectarConfirmacaoDose` casa por substring), MH-58 já fechado em
briefing separado nesta mesma sessão.

**Regra de leitura para o Claude Code:** este briefing é auto-contido. Todo texto literal de
mensagem está embutido aqui. Não buscar material externo.

---

## 0. Diagnóstico — o que foi confirmado com evidência

Tudo abaixo foi confirmado cruzando `agent_logs`, `dose_logs` e logs do Railway de 29/07/2026.
Nada aqui é hipótese.

**D-1 — `getDosesHoje` filtra por `taken_at` (momento da confirmação), não por `scheduled_at`
(dia devido).** Às 10:26 BRT de 29/07, o relatório "Registro de hoje" mostrou 6 doses, das quais
**5 eram doses de 28/07** confirmadas retroativamente naquela manhã. Os horários exibidos ("tomado
às 10:19") eram o instante da confirmação, não o horário devido. É a mesma divergência que o
CONTEXT.md já documenta como resolvida para `calcularAdesao` na v15 (*"filtra por `scheduled_at`,
nunca por `taken_at`"*) — `getDosesHoje` nunca recebeu esse tratamento.

**D-2 — o bloco `pendentes` de `getDosesHoje` não consulta `dose_logs`.** É derivado de
`medications` + `schedules`, usa apenas `schedules[0]` e é suprimido inteiro se o medicamento tiver
qualquer dose confirmada no dia. Por isso apareceram **zero pendentes** às 10:26, com Ômega 3
(15h/21h), Dipirona (16h/20h), Vitamina C (20h) e Cataflam (18:30) todos pendentes. Estruturalmente
não consegue representar `nao_tomado`, `nao_informado` nem `sem_estoque`.

**D-3 — lacuna de inventário.** Não existe capacidade "status das doses de um dia específico".
`tomei_hoje` é fixo em hoje; `adesao` é fixo em agregado de 7/15/30. Perguntas equivalentes caíram
em três destinos diferentes (logs do Railway):

| Mensagem | Destino |
|---|---|
| "Ficou alguma dose pendente de ontem?" | `relatorios/tomei_hoje` |
| "Faltou eu tomar algum remédio ontem?" | `relatorios/adesao` (beco do 7/15/30) |
| "Eu tomei todos meus remédios ontem?" | `relatorios/adesao` |
| "Como foi minha adesão ontem?" | `principal` |

Não é instabilidade do classificador — ele arredonda para a categoria existente mais próxima
porque a correta não existe.

**D-4 — não existe canal de parâmetros.** `handleRelatorios` recebe `subtipo` como string nua.
Mesmo quando o classificador entende "dipirona" ou "ontem", a informação morre na fronteira do
roteador. É a generalização do BUG-58.

**D-5 — `detectarConfirmacaoDose` casa por substring.** `termos.some(t => msg.includes(t))` com
`'tá'` na lista faz **qualquer** mensagem contendo "es**tá**" ser lida como confirmação de dose.
Confirmado nos logs: "Tomei dipirona hoje?" e "Como foi minha adesão ontem?" foram interceptadas
pelo branch de confirmação e nunca chegaram a classificador nenhum. Como o `balanco_do_dia` só é
alcançável via classificador, **sem esta correção a capacidade nova nasce inatingível**.

**Medição em produção (histórico completo de `agent_logs`):** os termos `tá`, `foi`, `pode`, `ok`,
`claro` e `feito` têm **zero ocorrências** em confirmações reais. Só produzem falso positivo.

---

## PARTE 1 — `detectarConfirmacaoDose` (pré-requisito de tudo)

Arquivo: `src/router.js`

### 1.1 Substituir a função inteira

Localizar `function detectarConfirmacaoDose(message)` (por volta da linha 125) e substituir por:

```javascript
// Aberturas interrogativas — uma pergunta nunca é confirmação de dose, mesmo sem "?".
// Ex: "como tá meu estoque" (sem interrogação) não pode virar confirmação.
const ABERTURAS_INTERROGATIVAS = [
    'como', 'qual', 'quais', 'quanto', 'quantos', 'quantas',
    'quando', 'quem', 'onde', 'cade', 'cadê', 'sera', 'será',
    'o que', 'oq', 'porque', 'por que'
];

function detectarConfirmacaoDose(message) {
    if (!message) return false;
    const msg = message.toLowerCase().trim();

    // GUARDA DE INTERROGATIVA (v25) — pergunta não é confirmação.
    // Duas formas: pontuação final e abertura interrogativa (usuário nem sempre usa "?").
    if (msg.endsWith('?')) return false;
    if (ABERTURAS_INTERROGATIVAS.some(a => msg.startsWith(a + ' '))) return false;

    // PRIMEIRO: negação explícita invalida qualquer confirmação
    // Prioridade à negação — falso negativo é recuperável via follow-up;
    // falso positivo corrompe dados de adesão
    const negacoes = [
        'não tomei', 'nao tomei',
        'não vou tomar', 'nao vou tomar',
        'não vou mais', 'nao vou mais',
        'ainda não tomei', 'ainda nao tomei',
        'não tomou', 'nao tomou',
        'não consigo tomar', 'nao consigo tomar',
        'não consigo'
    ];
    if (negacoes.some(n => msg.includes(n))) return false;

    // Termos enxutos (v25): 'tá', 'foi', 'pode', 'ok', 'claro' e 'feito' foram REMOVIDOS.
    // Medição em todo o histórico de agent_logs: zero confirmações reais dependiam deles;
    // só geravam falso positivo ('tá' casava dentro de "está"). Se o usuário responder com
    // uma dessas palavras, a mensagem cai no classificador central e chega ao principal,
    // cujo NAMI_SYSTEM_PROMPT já trata todas elas como CONFIRM_DOSE (regra de máxima
    // prioridade) — a dose continua sendo confirmada, com uma chamada de LLM a mais.
    const termos = ['sim', 'tomei', 'já tomei', 'ja tomei', 'tomei sim', 'já tomei sim'];

    // contemPalavraLivre (word boundary) em vez de includes — impede que um termo case
    // dentro de outra palavra. Mesma função já usada por detectarIntencaoConfiguracao.
    return termos.some(t => contemPalavraLivre(msg, t));
}
```

### 1.2 Mover `contemPalavraLivre` para cima

`contemPalavraLivre` está definida hoje **depois** de `detectarConfirmacaoDose` (por volta da linha
166). Em JS, `function` é hoisted, então funcionaria mesmo assim — mas por legibilidade, mover a
definição de `contemPalavraLivre` para **antes** de `detectarConfirmacaoDose`, junto das constantes.
Não alterar o corpo dela.

### 1.3 Comportamentos conhecidos e aceitos (registrar, não corrigir)

- **`"Simsim"`** deixa de ser detectada pelo fast-path (não há fronteira de palavra entre os dois
  "sim"). Cai no classificador central, que a interpreta corretamente. Decisão explícita: aceitar,
  não crescer a lista de termos (antipadrão do BUG-036/056, princípio 14).
- **`"tomei dipirona hoje"` e `"eu tomei todos meus remedios ontem"`**, sem "?" e sem abertura
  interrogativa, continuam sendo lidas como confirmação. São estruturalmente idênticas a uma
  declaração real ("Tomei de hoje e de ontem" é confirmação verdadeira do histórico). Não há
  discriminador determinístico honesto. Aceito e monitorado.

---

## PARTE 2 — Canal de parâmetros + despacho centralizado

### 2.1 Classificador central passa a devolver `params`

Arquivo: `src/router.js`, função `classificarIntencaoComContexto`.

**(a)** No prompt, substituir o bloco de subtipos por este texto literal:

```
Se o agente escolhido for "relatorios", identifique também o subtipo do relatório em
"subtipoRelatorio", escolhendo exatamente um destes valores:
- balanco_do_dia: o que foi tomado / o que faltou / o que ficou pendente em um dia
  (hoje, ontem, ou um dia nomeado). Use este subtipo para perguntas como "tomei meus
  remédios hoje?", "faltou algum remédio ontem?", "esqueci de tomar alguma coisa?",
  "ficou alguma dose pendente?", "pulei algum remédio no domingo?"
- meus_remedios: listar medicamentos cadastrados e seus horários
- estoque: consultar quantidade em estoque
- proximo_remedio: qual remédio tomar agora/a seguir
- adesao: taxa de adesão agregada de um período (7, 15 ou 30 dias). Use SOMENTE quando o
  usuário pedir explicitamente um percentual, uma taxa, ou um resumo de vários dias.
  Pergunta sobre UM dia específico é sempre balanco_do_dia, nunca adesao.
- progresso_tratamento: quantos dias/doses faltam para o tratamento acabar

Preencha também "params" com o que a mensagem disser (ou null quando não disser):
- "medicamento": o nome do medicamento citado, exatamente como o usuário escreveu.
- "expressaoData": a expressão de tempo usada, SEM converter para data. Valores possíveis:
  "hoje", "ontem", "anteontem", um dia da semana ("domingo", "segunda"...), ou um número/data
  como aparece na mensagem ("19", "19/07"). NUNCA calcule a data — apenas copie a expressão.

Para os demais agentes, "subtipoRelatorio" e "params" devem ser null.

Responda APENAS com um JSON válido, sem nenhum texto antes ou depois, no formato exato:
{"agente": "cadastro|relatorios|configuracao|principal|excluir_conta|nao_suportado", "subtipoRelatorio": "balanco_do_dia|meus_remedios|estoque|proximo_remedio|adesao|progresso_tratamento|null", "params": {"medicamento": "texto ou null", "expressaoData": "texto ou null"}, "feedback": "elogio|critica|sugestao|null"}
```

**(b)** Aumentar `max_tokens` de `80` para `160` (o campo `params` acrescenta tokens; 80 pode
truncar o JSON e derrubar o parse).

**(c)** Atualizar `subtiposValidos`:
```javascript
const subtiposValidos = ['balanco_do_dia', 'meus_remedios', 'estoque',
                         'proximo_remedio', 'adesao', 'progresso_tratamento'];
```

**(d)** Extrair `params` do JSON e propagá-lo no retorno. Alterar o bloco final:
```javascript
        const paramsRaw = parsed?.params || {};
        const params = {
            medicamento: typeof paramsRaw.medicamento === 'string' && paramsRaw.medicamento.trim()
                ? paramsRaw.medicamento.trim() : null,
            expressaoData: typeof paramsRaw.expressaoData === 'string' && paramsRaw.expressaoData.trim()
                ? paramsRaw.expressaoData.trim() : null
        };

        if (!agentesValidos.includes(agente)) {
            console.warn(`⚠️ [CLASSIFICADOR] Agente inesperado do LLM: "${agente}" — usando principal`);
            return fallback;
        }

        if (agente === 'relatorios' && !subtiposValidos.includes(subtipoRelatorio)) {
            console.warn(`⚠️ [CLASSIFICADOR] Subtipo de relatório ausente/inválido: "${subtipoRelatorio}" — não reconhecido`);
            return { agente: 'relatorios', subtipoRelatorio: null, params, feedback };
        }

        console.log(`🧠 [CLASSIFICADOR] Intenção classificada como: ${agente}${subtipoRelatorio && agente === 'relatorios' ? ` (${subtipoRelatorio})` : ''} — params: ${JSON.stringify(params)} — mensagem: "${message}"`);
        return { agente, subtipoRelatorio: agente === 'relatorios' ? subtipoRelatorio : null, params, feedback };
```

**(e)** Atualizar o `fallback` no topo da função:
```javascript
    const fallback = { agente: 'principal', subtipoRelatorio: null, params: { medicamento: null, expressaoData: null }, feedback: null };
```

**(f)** Atualizar o inventário de capacidades do prompt (princípio 5/21). Substituir a linha do
agente `relatorios` por:
```
- relatorios: consultar o que foi tomado ou faltou em um dia (hoje, ontem ou dia nomeado),
  doses tomadas, adesão, estoque, próximos remédios, horários cadastrados, progresso do tratamento
```

### 2.2 Camada 1 — remapear, não remover

Arquivo: `src/agentes/relatorios.js`, função `classificarIntencaoRelatorio`.

Renomear a chave `tomei_hoje` para `balanco_do_dia` no objeto `padroes` (mesmas frases, só a chave
muda) e acrescentar estas frases à lista:
```javascript
        balanco_do_dia: [
            'tomei hoje?',
            'já tomei meus remédios',
            'tomei alguma coisa hoje',
            'registrei hoje',
            'esqueci de tomar hoje',
            'tomei tudo hoje',
            'tomei o remédio hoje',
            'ficou alguma dose pendente',
            'faltou algum remédio',
            'pulei algum remédio'
        ],
```
⚠️ **Não remover a Camada 1.** Os logs de 29/07 mostram que ela não disparou nenhuma vez, mas essa
evidência vem de um único usuário. Avaliar remoção depois, com dados de mais usuários.

### 2.3 Despacho centralizado

Arquivo: `src/router.js`. Criar esta função **antes** de `routeMessage`:

```javascript
// ============================================================
// DESPACHO DE RELATÓRIO (v25) — ponto ÚNICO de chamada de handleRelatorios.
// Encapsula os três passos que os 8 call sites anteriores repetiam:
// chamar o handler → devolver a resposta → cair no principal quando não reconhecido.
// NÃO gerencia estado conversacional de propósito: decidir se um fluxo terminou é
// responsabilidade do branch que chama, não do despacho (evita acoplamento).
// ============================================================
async function despacharRelatorio({ user, message, image, historicoConversa,
                                    subtipo, params, state }) {
    const response = await handleRelatorios({ user, message, subtipo, params, state });

    if (response) {
        return { agentName: 'relatorios', response };
    }

    console.log(`🤖 Relatorios não reconheceu (subtipo: ${subtipo}), caindo no principal — ${user.phone}`);
    return {
        agentName: 'principal',
        response: await handlePrincipal({ user, message, image, historicoConversa })
    };
}
```

### 2.4 Substituir os 8 call sites

Todos passam a usar `despacharRelatorio`. **Nenhuma linha de `saveConversationState` deve ser
movida ou removida** — elas ficam exatamente onde estão.

Padrão de substituição, aplicado a cada ponto:

```javascript
// ANTES
response = await handleRelatorios({ user, message, subtipo: X, state: Y });
if (!response) { agentName = 'principal'; response = await handlePrincipal({...}); }

// DEPOIS
const r = await despacharRelatorio({ user, message, image, historicoConversa,
                                     subtipo: X, params, state: Y });
agentName = r.agentName;
response = r.response;
```

Os 8 pontos (localizar pela linha aproximada no arquivo atual):

| # | Linha aprox. | subtipo | state | params |
|---|---|---|---|---|
| 1 | 391 (`despacharEscalada`) | `subtipoRelatorio` | `idleState` | `params` do classificador |
| 2 | 567 (`aguardando_periodo_adesao`, período válido) | `'adesao'` | `state` | `{ medicamento: null, expressaoData: null }` |
| 3 | 578 (mesmo estado, classificador confirmou adesão) | `'adesao'` | `state` | `params` do classificador |
| 4 | 592 (saiu do estado, outro subtipo) | `subtipoRelatorio` | `idleState` | `params` do classificador |
| 5 | 663 (`aguardando_escolha_tratamento`) | `'progresso_tratamento'` | `state` | `params` do classificador |
| 6 | 677 (saiu do estado, outro subtipo) | `subtipoRelatorio` | `idleState` | `params` do classificador |
| 7 | 826 (Camada 1) | `subtipo` | `state` | `{ medicamento: null, expressaoData: null }` |
| 8 | 856 (Camada 2) | `subtipoRelatorio` | `state` | `params` do classificador |

⚠️ Nos pontos 2 e 7 o subtipo vem de fonte determinística (estado ou palavra-chave), não do
classificador — por isso `params` vai vazio. O `balanco_do_dia` resolve isso: quando `params` vem
vazio, a data default é **hoje** e o medicamento é resolvido a partir do texto da mensagem (ver 3.4).

### 2.5 Higiene de comentários

Os comentários numerados dos branches em `routeMessage` estão inconsistentes (há três blocos
comentados como "4."). Renumerar sequencialmente os comentários — **sem alterar nenhuma condição
ou ordem de branch**. Ordem correta atual, para referência:

1. `!user.onboarded` → recepcionista
2. `aguardando_confirmacao_exclusao`
3. portão de exclusão de conta
4. `post_onboarding`
5. `aguardando_periodo_adesao`
6. `aguardando_escolha_tratamento`
7. `configurando`
8. idle + intenção de configuração
9. `adding_med`
10. `cadastrando_medicamento`
11. idle + intenção de cadastro
12. idle + confirmação de dose + dose pendente
13. idle + confirmação de dose + sem dose pendente (resposta tardia, BUG-035)
14. idle + Camada 1 de relatório
15. `else` → Camada 2 (classificador central)

---

## PARTE 3 — `balanco_do_dia`

### 3.1 Resolução determinística de data

Arquivo novo: `src/dataReferencia.js`

⚠️ O Brasil não tem horário de verão desde 2019, então o offset fixo `-03:00` é seguro para
`America/Sao_Paulo`. Se isso mudar, este é o único arquivo a revisar.

```javascript
// ============================================================
// RESOLUÇÃO DETERMINÍSTICA DE DATA (v25)
// O LLM identifica a EXPRESSÃO ("ontem", "domingo", "19/07"); o cálculo da data real
// é sempre feito aqui, em código. Mesmo princípio do BUG-059 (calcularRotuloDia):
// o Claude não infere data relativa sozinho.
// Módulo de funções puras — sem I/O.
// ============================================================

const MAX_DIAS_RETROATIVOS = 30;

const DIAS_SEMANA = {
    domingo: 0,
    segunda: 1, 'segunda-feira': 1,
    terca: 2, 'terça': 2, 'terca-feira': 2, 'terça-feira': 2,
    quarta: 3, 'quarta-feira': 3,
    quinta: 4, 'quinta-feira': 4,
    sexta: 5, 'sexta-feira': 5,
    sabado: 6, 'sábado': 6
};

function normalizar(str) {
    return String(str || '').toLowerCase().trim();
}

// Data de hoje no fuso de Brasília, formato YYYY-MM-DD.
export function hojeBRT() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function somarDias(dataISO, n) {
    const [ano, mes, dia] = dataISO.split('-').map(Number);
    const dt = new Date(Date.UTC(ano, mes - 1, dia));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
}

function diaDaSemana(dataISO) {
    const [ano, mes, dia] = dataISO.split('-').map(Number);
    return new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
}

// Retorna { dataISO, erro } — erro preenchido quando a expressão não é resolvível
// ou está fora da janela suportada.
export function resolverDataReferencia(expressao) {
    const hoje = hojeBRT();
    const exp = normalizar(expressao);

    if (!exp) return { dataISO: hoje, erro: null };
    if (exp === 'hoje') return { dataISO: hoje, erro: null };
    if (exp === 'ontem') return { dataISO: somarDias(hoje, -1), erro: null };
    if (exp === 'anteontem') return { dataISO: somarDias(hoje, -2), erro: null };

    // Dia da semana → ocorrência passada mais recente (hoje conta, se for o mesmo dia)
    if (DIAS_SEMANA[exp] !== undefined) {
        const alvo = DIAS_SEMANA[exp];
        const atual = diaDaSemana(hoje);
        const delta = (atual - alvo + 7) % 7;
        return { dataISO: somarDias(hoje, -delta), erro: null };
    }

    // "19/07", "19/07/2026" ou "19"
    const m = exp.match(/^(\d{1,2})(?:\/(\d{1,2}))?(?:\/(\d{2,4}))?$/);
    if (m) {
        const [anoHoje, mesHoje] = hoje.split('-').map(Number);
        const dia = Number(m[1]);
        const mes = m[2] ? Number(m[2]) : mesHoje;
        let ano = m[3] ? Number(m[3]) : anoHoje;
        if (ano < 100) ano += 2000;

        if (dia < 1 || dia > 31 || mes < 1 || mes > 12) {
            return { dataISO: null, erro: 'invalida' };
        }
        const candidata = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
        if (candidata > hoje) return { dataISO: null, erro: 'futuro' };
        return { dataISO: candidata, erro: null };
    }

    return { dataISO: null, erro: 'nao_reconhecida' };
}

// Valida a janela suportada. Devolve { ok, motivo }.
export function validarJanela(dataISO) {
    const hoje = hojeBRT();
    if (dataISO > hoje) return { ok: false, motivo: 'futuro' };
    const limite = somarDias(hoje, -MAX_DIAS_RETROATIVOS);
    if (dataISO < limite) return { ok: false, motivo: 'antigo' };
    return { ok: true, motivo: null };
}

// Quantos dias atrás está a data (0 = hoje, 1 = ontem...)
export function diasAtras(dataISO) {
    const hoje = hojeBRT();
    const [a1, m1, d1] = hoje.split('-').map(Number);
    const [a2, m2, d2] = dataISO.split('-').map(Number);
    const t1 = Date.UTC(a1, m1 - 1, d1);
    const t2 = Date.UTC(a2, m2 - 1, d2);
    return Math.round((t1 - t2) / (24 * 60 * 60 * 1000));
}

// Rótulo humano da data — "hoje", "ontem", "anteontem" ou "domingo (26/07)"
export function rotularData(dataISO) {
    const d = diasAtras(dataISO);
    if (d === 0) return 'hoje';
    if (d === 1) return 'ontem';
    if (d === 2) return 'anteontem';

    const nomes = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
                   'quinta-feira', 'sexta-feira', 'sábado'];
    const [ano, mes, dia] = dataISO.split('-').map(Number);
    const nome = nomes[diaDaSemana(dataISO)];
    return `${nome} (${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')})`;
}

// Janela UTC correspondente ao dia inteiro em BRT (offset fixo -03:00, sem DST desde 2019)
export function janelaDiaBRT(dataISO) {
    return {
        inicio: new Date(`${dataISO}T00:00:00.000-03:00`).toISOString(),
        fim: new Date(`${dataISO}T23:59:59.999-03:00`).toISOString()
    };
}
```

### 3.2 Query determinística

Arquivo: `src/database.js`. Acrescentar (pode ficar logo depois de `getDosesHoje`):

```javascript
// ============================================================
// BALANÇO DO DIA (v25) — doses de um dia, filtradas por scheduled_at (dia DEVIDO).
// Substitui getDosesHoje no fluxo de relatório. NUNCA filtra por taken_at: uma dose
// de ontem confirmada hoje pertence a ONTEM (mesma regra já aplicada em calcularAdesao
// desde a v15). Sem janela fixa de dias e sem corte de registros.
// ============================================================
export async function getDosesDoDia(userId, dataISO, medicationId = null) {
    const { inicio, fim } = janelaDiaBRT(dataISO);

    const { data: meds } = await supabase
        .from('medications')
        .select('id, nome')
        .eq('user_id', userId)
        .eq('ativo', true);

    if (!meds || meds.length === 0) return [];

    const medNomeMap = Object.fromEntries(meds.map(m => [m.id, m.nome]));
    const medicationIds = medicationId ? [medicationId] : meds.map(m => m.id);

    const { data, error } = await supabase
        .from('dose_logs')
        .select('id, medication_id, scheduled_at, horario_agendado, status, confirmed, taken_at, reminder_sent')
        .in('medication_id', medicationIds)
        .gte('scheduled_at', inicio)
        .lte('scheduled_at', fim)
        .order('scheduled_at', { ascending: true });

    if (error) {
        console.error('Erro ao buscar doses do dia:', error.message);
        return [];
    }

    return (data || []).map(d => ({
        id: d.id,
        medicationId: d.medication_id,
        nome: medNomeMap[d.medication_id] || 'medicamento',
        horario: d.horario_agendado
            ? String(d.horario_agendado).substring(0, 5)
            : new Date(d.scheduled_at).toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            }),
        scheduledAt: d.scheduled_at,
        status: d.status,
        confirmado: d.confirmed === true,
        takenAt: d.taken_at,
        // Confirmação retroativa: confirmada em dia diferente do dia devido
        confirmadaRetroativamente: d.confirmed === true && d.taken_at
            ? new Date(d.taken_at).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) !== dataISO
            : false
    }));
}
```

E acrescentar o import no topo de `database.js`:
```javascript
import { janelaDiaBRT } from './dataReferencia.js';
```

### 3.3 Bloco factual determinístico

Arquivo novo: `src/templates/balancoTemplates.js`

```javascript
// ============================================================
// BLOCO FACTUAL DO BALANÇO DO DIA (v25)
// Este bloco é renderizado 100% em código e inserido LITERALMENTE na mensagem final.
// O LLM escreve apenas a moldura (abertura/fechamento) ao redor dele e está proibido
// de citar horário, nome ou status fora daqui. Preserva o princípio 13 (apresentação
// de dado de saúde é determinística) enquanto permite calor na comunicação.
// Módulo de funções puras — sem I/O.
// ============================================================

const ICONE = {
    confirmado: '✅',
    nao_informado: '⏳',
    nao_tomado: '❌',
    sem_estoque: '📦',
    pendente: '🔜'
};

const DESCRICAO = {
    confirmado: 'confirmado',
    nao_informado: 'sem confirmação',
    nao_tomado: 'não tomado',
    sem_estoque: 'sem estoque',
    pendente: 'ainda não chegou o horário'
};

export function montarBlocoFactual(doses) {
    return doses.map(d => {
        const icone = ICONE[d.status] || '•';
        const desc = DESCRICAO[d.status] || d.status;
        const sufixo = d.confirmadaRetroativamente ? ' (confirmado depois)' : '';
        return `${icone} *${d.nome}* — ${d.horario} — ${desc}${sufixo}`;
    }).join('\n');
}

// Resumo estrutural entregue ao LLM para ele escolher o tom (não vai para o usuário).
export function resumirSituacao(doses) {
    const total = doses.length;
    const confirmadas = doses.filter(d => d.status === 'confirmado').length;
    const pendentesFuturas = doses.filter(d => d.status === 'pendente').length;
    const faltantes = doses.filter(d =>
        d.status === 'nao_informado' || d.status === 'nao_tomado' || d.status === 'sem_estoque'
    ).length;

    let cenario;
    if (total === 0) cenario = 'sem_doses';
    else if (faltantes === 0 && pendentesFuturas === 0) cenario = 'tudo_confirmado';
    else if (confirmadas === 0 && pendentesFuturas === total) cenario = 'nada_chegou_ainda';
    else if (confirmadas === 0) cenario = 'nada_confirmado';
    else cenario = 'parcial';

    return { total, confirmadas, faltantes, pendentesFuturas, cenario };
}

// Moldura padrão — usada quando a chamada ao LLM falha (fallback defensivo).
export function molduraPadrao({ nome, rotuloData, resumo }) {
    const abertura = resumo.total === 0
        ? `${nome}, não encontrei doses agendadas para ${rotuloData}.`
        : `${nome}, aqui está como ficou ${rotuloData}:`;

    let fechamento = '';
    if (resumo.cenario === 'tudo_confirmado') {
        fechamento = 'Tudo certinho! Continue assim! 💪';
    } else if (resumo.faltantes > 0) {
        fechamento = 'Se você tomou alguma dessas e só não me avisou, é só me dizer qual. 💊';
    }
    return { abertura, fechamento };
}

export const TEXTO_FORA_DA_JANELA =
    `Consigo olhar seus registros dos últimos 30 dias. 🌿\nPara um período mais antigo que isso, ainda não tenho como buscar.`;

export const TEXTO_DATA_FUTURA =
    `Essa data ainda não chegou! 😊\nPosso te mostrar como está hoje ou como foi em algum dia anterior — é só me dizer.`;

export const TEXTO_DATA_NAO_RECONHECIDA =
    `Não consegui identificar de qual dia você está falando. 🌿\nPode me dizer assim: "hoje", "ontem", ou a data (ex: 19/07)?`;
```

### 3.4 Handler

Arquivo: `src/agentes/relatorios.js`.

**(a)** Novos imports:
```javascript
import { getDosesDoDia } from '../database.js';
import { resolverDataReferencia, validarJanela, rotularData, diasAtras, hojeBRT } from '../dataReferencia.js';
import {
    montarBlocoFactual, resumirSituacao, molduraPadrao,
    TEXTO_FORA_DA_JANELA, TEXTO_DATA_FUTURA, TEXTO_DATA_NAO_RECONHECIDA
} from '../templates/balancoTemplates.js';
import Anthropic from '@anthropic-ai/sdk';
```
E, junto das constantes do topo:
```javascript
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JANELA_CONFIRMACAO_RETROATIVA_DIAS = 2;
```
⚠️ `relatorios.js` já tem `import 'dotenv/config'`? Se não tiver, acrescentar.

**(b)** Trocar o `case` no `handleRelatorios` e passar `params`:
```javascript
export async function handleRelatorios({ user, message, subtipo, params, state }) {
    const p = params || { medicamento: null, expressaoData: null };

    switch (subtipo) {
        case 'balanco_do_dia':
            return await relatorioBalancoDoDia({ user, message, params: p });
        case 'meus_remedios':
            return await relatorioMeusRemedios(user);
        case 'estoque':
            return await relatorioEstoque({ user, message, params: p });
        case 'proximo_remedio':
            return await relatorioProximoRemedio({ user, message, params: p });
        case 'adesao':
            return await relatorioAdesao({ user, message, state });
        case 'progresso_tratamento':
            return await relatorioProgressoTratamento({ user, message, state });
        default:
            return null; // não reconheceu — router cai no agente_principal
    }
}
```
**Remover** a função `relatorioTomeiHoje` inteira.

**(c)** Função auxiliar de resolução de medicamento — **princípio 17** (texto literal da mensagem
vence o palpite do classificador):

```javascript
// Princípio 17: o texto da mensagem atual resolve primeiro; o palpite do classificador
// é só fallback. Retorna { id, nome } ou null.
async function resolverMedicamento({ userId, message, medicamentoParam }) {
    const medications = await getMedicamentosAtivos(userId);
    if (medications.length === 0) return null;

    const porTexto = encontrarMedicamento(message, medications);
    if (porTexto) return { id: porTexto.id, nome: porTexto.nome };

    if (medicamentoParam) {
        const porParam = encontrarMedicamento(medicamentoParam, medications);
        if (porParam) return { id: porParam.id, nome: porParam.nome };
    }
    return null;
}
```

**(d)** O handler do balanço:

```javascript
// ============================================================
// R-001 (v25): BALANÇO DO DIA — substitui tomei_hoje
// Núcleo factual determinístico + moldura escrita pelo LLM.
// ============================================================

async function relatorioBalancoDoDia({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';

    const { dataISO, erro } = resolverDataReferencia(params.expressaoData);
    if (erro === 'futuro') return comSaudacao(user.id, firstName, TEXTO_DATA_FUTURA);
    if (erro) return comSaudacao(user.id, firstName, TEXTO_DATA_NAO_RECONHECIDA);

    const janela = validarJanela(dataISO);
    if (!janela.ok) {
        return comSaudacao(user.id, firstName,
            janela.motivo === 'futuro' ? TEXTO_DATA_FUTURA : TEXTO_FORA_DA_JANELA);
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const doses = await getDosesDoDia(user.id, dataISO, med?.id || null);
    const resumo = resumirSituacao(doses);
    const rotuloData = rotularData(dataISO);
    const blocoFactual = montarBlocoFactual(doses);

    // Janela de confirmação retroativa: só até 2 dias (mesma janela de getDosesRetroativas).
    // Além dela, é leitura pura — estoque só se ajusta por pedido direto do usuário.
    const podeConfirmarRetroativo = diasAtras(dataISO) <= JANELA_CONFIRMACAO_RETROATIVA_DIAS;

    const moldura = await gerarMoldura({
        nome: firstName, rotuloData, resumo, med, podeConfirmarRetroativo
    });

    const partes = [moldura.abertura];
    if (blocoFactual) partes.push(blocoFactual);
    if (moldura.fechamento) partes.push(moldura.fechamento);

    return comSaudacao(user.id, firstName, partes.join('\n\n'));
}
```

**(e)** A moldura via LLM, com fallback defensivo:

```javascript
const PROMPT_MOLDURA = `Você é a Nami, assistente de saúde via WhatsApp. Linguagem simples, clara e
carinhosa, com emojis usados com moderação.

Você vai escrever a ABERTURA e o FECHAMENTO de uma mensagem. Entre as duas, o usuário verá uma
lista de doses que JÁ ESTÁ PRONTA e que você NÃO escreve.

REGRAS ABSOLUTAS:
1. NUNCA cite nome de medicamento, horário, quantidade, data ou status na abertura ou no
   fechamento. Esses dados já aparecem na lista. Fale de forma geral ("suas doses", "alguns
   remédios", "o dia").
2. NUNCA invente informação. Você recebe apenas um resumo numérico — use só ele.
3. NUNCA mencione mecanismo interno (sistema, aplicativo, banco de dados, registro técnico).
   Para o usuário existe só você.
4. Abertura: no máximo 2 frases. Fechamento: no máximo 2 frases, ou vazio.
5. Não repita a saudação com o nome mais de uma vez.

Sobre o CENÁRIO recebido:
- tudo_confirmado: celebre com leveza.
- nada_chegou_ainda: informe que o dia ainda está começando, sem cobrança.
- nada_confirmado: acolha, sem culpa, e convide a atualizar.
- parcial: reconheça o que foi feito e aponte com gentileza o que ficou em aberto.
- sem_doses: informe que não há registro para esse dia, sem alarme.

Se "podeConfirmarRetroativo" for true E houver doses faltantes, o FECHAMENTO deve convidar o
usuário a avisar caso tenha tomado e esquecido de confirmar — dizendo que você registra e ajusta
o estoque para ele.
Se for false E houver doses faltantes, o fechamento NÃO deve oferecer registro: explique com
delicadeza que para dias mais antigos você só consegue mostrar o histórico, e que ajustes de
estoque precisam ser pedidos diretamente.

Responda APENAS com JSON válido, sem markdown e sem texto antes ou depois:
{"abertura": "...", "fechamento": "..."}`;

async function gerarMoldura({ nome, rotuloData, resumo, med, podeConfirmarRetroativo }) {
    const entrada = JSON.stringify({
        nome,
        dia: rotuloData,
        medicamentoEspecifico: med ? true : false,
        cenario: resumo.cenario,
        totalDoses: resumo.total,
        confirmadas: resumo.confirmadas,
        faltantes: resumo.faltantes,
        aindaNaoChegaram: resumo.pendentesFuturas,
        podeConfirmarRetroativo
    });

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 300,
            system: PROMPT_MOLDURA,
            messages: [{ role: 'user', content: entrada }]
        });

        const raw = resposta.content[0]?.text?.trim() || '';
        // Critério de FORMA, não de tamanho (lição do BUG-067): texto que começa com "{"
        // nunca é exposto cru ao usuário.
        const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
        const abertura = typeof parsed.abertura === 'string' ? parsed.abertura.trim() : '';
        const fechamento = typeof parsed.fechamento === 'string' ? parsed.fechamento.trim() : '';

        if (!abertura || abertura.startsWith('{')) throw new Error('abertura inválida');
        return { abertura, fechamento: fechamento.startsWith('{') ? '' : fechamento };

    } catch (e) {
        console.warn(`[relatorios] Moldura via LLM falhou, usando padrão: ${e.message}`);
        return molduraPadrao({ nome, rotuloData, resumo });
    }
}
```

---

## PARTE 4 — `estoque` e `proximo_remedio`

### 4.1 `relatorioEstoque` — fecha o BUG-58

Substituir a função inteira:

```javascript
async function relatorioEstoque({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const estoque = await getEstoque(user.id);

    if (estoque.length === 0) {
        return `Você ainda não tem remédios cadastrados, ${firstName}. 💊`;
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const lista = med ? estoque.filter(e => e.id === med.id) : estoque;
    if (lista.length === 0) return null; // não encontrou — cai no principal

    const cabecalho = med
        ? `📦 Estoque do *${med.nome}*, ${firstName}:\n\n`
        : `📦 Estoque dos seus remédios, ${firstName}:\n\n`;

    let msg = cabecalho;
    for (const m of lista) {
        if (m.estoque_atual <= 0) {
            msg += `🚨 *${m.nome}* — sem estoque! Compre com urgência\n`;
        } else if (m.estoque_atual <= m.estoque_minimo) {
            msg += `⚠️ *${m.nome}* — ${m.estoque_atual} unidades (hora de comprar mais!)\n`;
        } else {
            msg += `✅ *${m.nome}* — ${m.estoque_atual} unidades\n`;
        }
    }
    return msg.trim();
}
```

### 4.2 `relatorioProximoRemedio` — medicamento pedido em destaque

Substituir a função inteira:

```javascript
async function relatorioProximoRemedio({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const { passados, agora, proximos } = await getProximosMedicamentos(user.id);

    if (passados.length === 0 && agora.length === 0 && proximos.length === 0) {
        return `Não encontrei remédios agendados para hoje, ${firstName}. 💊`;
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const linhaPassado = m => `${m.confirmado ? '✅' : '⚠️'} *${m.nome}* (${m.horario}) — ${m.confirmado ? 'já registrado' : 'não registrado'}`;
    const linhaAgora = m => `💊 *${m.nome}* (${m.horario}) — está na hora de tomar!`;
    const linhaProximo = m => `🔜 *${m.nome}* — próximo às ${m.horario}`;

    // Sem medicamento nomeado: comportamento atual, lista completa.
    if (!med) {
        let msg = `⏰ Seus remédios de hoje, ${firstName}:\n\n`;
        for (const m of passados) msg += linhaPassado(m) + '\n';
        for (const m of agora) msg += linhaAgora(m) + '\n';
        for (const m of proximos) msg += linhaProximo(m) + '\n';
        return msg.trim();
    }

    // Com medicamento nomeado: destaque primeiro, resto como lembrete complementar.
    const ehDoMed = m => m.nome === med.nome;
    const destaqueAgora = agora.filter(ehDoMed);
    const destaqueProximos = proximos.filter(ehDoMed);
    const destaquePassados = passados.filter(ehDoMed);

    let msg = '';
    if (destaqueAgora.length > 0) {
        msg += `⏰ *${med.nome}*, ${firstName}:\n\n`;
        for (const m of destaqueAgora) msg += linhaAgora(m) + '\n';
        for (const m of destaqueProximos) msg += linhaProximo(m) + '\n';
    } else if (destaqueProximos.length > 0) {
        msg += `⏰ Seu próximo *${med.nome}*, ${firstName}:\n\n`;
        msg += linhaProximo(destaqueProximos[0]) + '\n';
        for (const m of destaqueProximos.slice(1)) msg += linhaProximo(m) + '\n';
    } else if (destaquePassados.length > 0) {
        msg += `⏰ *${med.nome}*, ${firstName}:\n\n`;
        for (const m of destaquePassados) msg += linhaPassado(m) + '\n';
        msg += `\nNão há mais doses do ${med.nome} programadas para hoje.\n`;
    } else {
        msg += `Não encontrei doses do *${med.nome}* programadas para hoje, ${firstName}.\n`;
    }

    const outros = [
        ...agora.filter(m => !ehDoMed(m)).map(linhaAgora),
        ...proximos.filter(m => !ehDoMed(m)).map(linhaProximo)
    ];

    if (outros.length > 0) {
        msg += `\nAh, e só pra lembrar — hoje você também tem:\n\n${outros.join('\n')}`;
    }

    return msg.trim();
}
```

---

## 5. Riscos conhecidos e o que fazer com eles

| Risco | Tratamento |
|---|---|
| `"Simsim"` deixa de ser detectada pelo fast-path | Aceito. Cai no classificador, que resolve. Documentado. |
| `"tomei X hoje"` sem "?" ainda lido como confirmação | Aceito. Não há discriminador determinístico honesto. Monitorar. |
| Custo: +1 chamada de LLM quando o usuário responde "ok"/"tá" ao lembrete | Aceito. Zero ocorrências em produção até hoje. |
| Custo: +1 chamada de LLM por `balanco_do_dia` (a moldura) | Esperado. Monitorar no próximo ciclo de billing, junto com o Juiz Offline. |
| Moldura do LLM citar dado factual (violaria o princípio 13) | Prompt proíbe explicitamente; o bloco factual é inserido em código, fora do alcance do LLM. Validar nos testes. |
| Call site esquecido em `handleRelatorios` | Mitigado pelo despacho centralizado (ponto único). |
| Subtipo renomeado em um lugar e não no outro | Checklist da seção 6 cobre os 3 pontos obrigatórios. |

---

## 6. Checklist para o Claude Code

1. `src/dataReferencia.js` — criar (seção 3.1).
2. `src/templates/balancoTemplates.js` — criar (seção 3.3).
3. `src/database.js` — adicionar `getDosesDoDia` + import de `janelaDiaBRT` (seção 3.2).
   **Não remover `getDosesHoje`** — ainda é usada por `getProximosMedicamentos`.
4. `src/router.js`:
   - substituir `detectarConfirmacaoDose` e adicionar `ABERTURAS_INTERROGATIVAS` (1.1);
   - mover `contemPalavraLivre` para antes dela (1.2);
   - atualizar prompt, `max_tokens`, `subtiposValidos`, extração de `params`, `fallback` e
     inventário do classificador (2.1 a–f);
   - criar `despacharRelatorio` (2.3);
   - substituir os **8** call sites (2.4);
   - renumerar comentários de branch (2.5).
5. `src/agentes/relatorios.js`:
   - imports novos e constantes (3.4a);
   - `handleRelatorios` com `params` e `case 'balanco_do_dia'` (3.4b);
   - **remover** `relatorioTomeiHoje`;
   - adicionar `resolverMedicamento` (3.4c), `relatorioBalancoDoDia` (3.4d), `gerarMoldura` (3.4e);
   - substituir `relatorioEstoque` (4.1) e `relatorioProximoRemedio` (4.2);
   - remapear `tomei_hoje` → `balanco_do_dia` na Camada 1 (2.2).
6. `node --check` em todos os arquivos tocados.
7. Commit + push.
8. Escritas em `backlog_items` (seção 7) via `src/backlog.js`.

**Verificação obrigatória de consistência** (princípio 5/21) — `balanco_do_dia` deve aparecer em
exatamente três lugares e `tomei_hoje` em nenhum:
```
grep -rn "balanco_do_dia" src/    # esperado: prompt do classificador, subtiposValidos, switch, Camada 1
grep -rn "tomei_hoje" src/        # esperado: nenhum resultado
```

---

## 7. Escritas em `backlog_items` (via `src/backlog.js`, nunca SQL direto)

**Inserir:**

| tipo | numero | titulo | status | prioridade | data_criacao |
|---|---|---|---|---|---|
| BUG | 70 | `getDosesHoje` filtra por `taken_at` em vez de `scheduled_at`, misturando doses de outros dias no relatório do dia | em_validacao | alta | 2026-07-29 |
| BUG | 71 | `detectarConfirmacaoDose` casa por substring e lê perguntas como confirmação de dose ('tá' dentro de 'está') | em_validacao | alta | 2026-07-29 |
| MH | 59 | Avaliar remoção da Camada 1 (`classificarIntencaoRelatorio`) — sem disparo observado em produção | aberto | baixa | 2026-07-29 |

**Atualizar:**
- BUG-58 → `em_validacao`. Nota: *"Causa raiz confirmada na v25: `relatorioEstoque` nunca recebeu
  `message` desde o commit d7fc32d (11/06). Não é regressão — o filtro nunca existiu. Funcionava
  antes da v15 porque a pergunta vazava para o `principal` (corrigido pelo BUG-055). Corrigido via
  canal de parâmetros."*

---

## 8. Roteiro de validação em produção (para o Guilherme)

Executar no WhatsApp e conferir em `agent_logs` que `agent = 'relatorios'`:

**Balanço do dia**
1. "tomei meus remédios hoje?" → deve listar as doses de HOJE por horário devido, sem misturar ontem
2. "faltou algum remédio ontem?" → deve mostrar o dia 28, com status corretos
3. "e no domingo?" → deve resolver para 26/07 e afirmar a data na resposta
4. "não, o outro domingo, dia 19" → deve reorientar para 19/07 sem travar
5. "tomei a dipirona hoje?" → deve filtrar só Dipirona
6. "faltou algo em 01/06?" (>30 dias) → deve responder o texto de fora da janela, sem erro

**Estoque e próximo remédio**
7. "qual estoque do meu omega3?" → só Ômega 3
8. "quais os remédios que eu preciso comprar?" → lista completa (comportamento atual mantido)
9. "qual próximo horário da dipirona?" → Dipirona em destaque + demais como complemento

**Não-regressão (crítico)**
10. Responder "Sim" a um lembrete real → deve confirmar normalmente
11. Responder "Tomei" a um lembrete real → deve confirmar normalmente
12. "como tá meu estoque" (sem "?") → deve ir para `relatorios/estoque`, **não** para o principal
13. "Como está minha adesão?" → deve ir para `relatorios/adesao`, não ser lida como confirmação
14. Pedir adesão de 7 dias → fluxo de período deve continuar funcionando
15. Pedir progresso de tratamento com 2+ tratamentos → fluxo de escolha deve continuar funcionando