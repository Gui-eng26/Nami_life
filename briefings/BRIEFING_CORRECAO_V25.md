# BRIEFING — Correção das regressões do redesenho de relatórios (v25)

**Sessão:** v25 (29/07/2026) — briefing de correção, posterior a `BRIEFING_RELATORIOS_V25`
**Commit corrigido:** `9ef679b`

**Contexto:** a validação em produção revelou três defeitos. **Dois foram introduzidos pelo
briefing anterior** (C-1 e C-3) e um é lacuna estrutural exposta pela nova capacidade (C-2).
Este briefing é auto-contido — todo texto literal está embutido.

---

## 0. Causas raiz confirmadas (evidência, não hipótese)

### C-3 — `JSON.parse` do classificador não remove cercas markdown (MAIS GRAVE)

```js
parsed = JSON.parse(textoResposta);   // quebra quando o LLM devolve ```json ... ```
```
Ao acrescentar `params` ao formato de saída, o JSON ficou mais longo e aninhado, e o modelo passou
a formatá-lo como bloco de código. O parse falha → `return fallback` → **`principal`**.

Medição nos logs do Railway:

| Janela | Chamadas ao classificador | Falhas de parse |
|---|---|---|
| 12:48–13:50 (antes do deploy) | 19 | 0 |
| 17:15–22:02 (depois) | 17 | **5 (29%)** |

Casos observados, todos com `⚠️ Resposta não-JSON do LLM: "```json` imediatamente antes:
"Tomei todos meus remédios ontem?" (17:19), "Qual próximo horário da dipirona?" (17:21),
"Progresso de tratamento" (18:50), "Faltou eu tomar algum remédio no dia 15/07?" (21:41),
"Eu tomei dipirona hoje?" (21:45).

Consequência: o `principal` responde com sua janela limitada (`getRecentDoses(3)` + `slice(0,5)`) e
produz **afirmação factual errada sobre saúde** — em 17:19 afirmou que "Vitamina C e Cataflam não
tinham doses agendadas para ontem", o que é falso. Em 21:41 alucinou um contato telefônico.

⚠️ Isso degrada o roteamento de **todos** os agentes, não só relatórios.
⚠️ O projeto já tinha essa proteção em `juizOffline.js` (`parseJulgamento`) e ela foi replicada em
`gerarMoldura` no briefing anterior — mas não no classificador, que era o ponto alterado.

### C-1 — Camada 1 captura frases com data e descarta `params`

O briefing anterior acrescentou à Camada 1 as frases `'faltou algum remédio'`,
`'ficou alguma dose pendente'` e `'pulei algum remédio'` (seção 2.2) — e a Camada 1 passa
`params` vazio (seção 2.4, ponto 7). Resultado: `expressaoData: null` → default hoje.

Assinatura nos logs (linhas **sem** o prefixo `[CLASSIFICADOR]` = interceptação da Camada 1):
```
17:18:36 | 📊 Roteando para relatorios (balanco_do_dia)   ← "Faltou algum remédio ontem?"
18:53:44 | 📊 Roteando para relatorios (balanco_do_dia)   ← "Faltou algum remédio no dia 01/06"
```
Contraprova: "Faltou **eu tomar** algum remédio ontem?" não casa com a frase literal, foi ao
classificador e resolveu `expressaoData: "ontem"` corretamente.

### C-2 — `dose_logs` só existe depois do lembrete

Query em `dose_logs` de 29/07: 5 linhas, **todas** com `reminder_sent = true`, e `scheduled_at`
gravado ~2 min antes do horário (15:58 para a dose das 16:00). As doses de 20:00 e 21:00 não
existiam no banco às 18:46.

Consequências:
- "Tomei dipirona hoje?" às 14:20 → a linha das 16:00 só nasceu às 15:58 → `total = 0` →
  *"Não encontrei nenhuma dose registrada"*. Tecnicamente verdade, praticamente enganoso.
- O texto que escrevi para o status `pendente` (*"ainda não chegou o horário"*) está **errado**:
  `pendente` significa lembrete já enviado e aguardando resposta. Hoje, se o usuário perguntasse
  "tomei tudo hoje?", o Cataflam das 18:30 apareceria como "ainda não chegou o horário" — falso.

---

## PARTE A — Corrigir o parse do classificador (C-3)

Arquivo: `src/router.js`, função `classificarIntencaoComContexto`.

### A.1 Extrair JSON de forma tolerante

Adicionar esta função auxiliar **antes** de `classificarIntencaoComContexto`:

```javascript
// Extrai JSON de resposta de LLM tolerando cercas markdown e texto ao redor.
// Mesma proteção que juizOffline.js já usa — replicada aqui após o C-3 (v25):
// o classificador falhava em 29% das chamadas porque o modelo devolvia ```json ... ```
// e o fallback silencioso mandava tudo para o principal.
function extrairJSON(texto) {
    if (!texto) return null;
    let limpo = String(texto).trim();

    // Remove cercas markdown (```json ... ``` ou ``` ... ```)
    limpo = limpo.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();

    // Se ainda houver texto ao redor, isola o primeiro objeto JSON
    if (!limpo.startsWith('{')) {
        const inicio = limpo.indexOf('{');
        const fim = limpo.lastIndexOf('}');
        if (inicio === -1 || fim === -1 || fim <= inicio) return null;
        limpo = limpo.slice(inicio, fim + 1);
    }

    try {
        return JSON.parse(limpo);
    } catch {
        return null;
    }
}
```

### A.2 Usar a função e registrar a falha

Substituir o bloco de parse:

```javascript
        let parsed = extrairJSON(textoResposta);

        if (!parsed) {
            console.warn(`⚠️ [CLASSIFICADOR] Resposta não-JSON do LLM: "${textoResposta}" — usando principal`);
            // Falha de parse degradava o roteamento silenciosamente (C-3, v25).
            // Registrar em system_events dá visibilidade sem depender de leitura de log.
            await registrarEvento({
                tipo: 'erro_tecnico',
                severidade: 'media',
                origem: 'router',
                agent: 'classificador',
                titulo: 'Falha de parse na resposta do classificador central',
                payload: {
                    funcao: 'classificarIntencaoComContexto',
                    resposta_bruta: String(textoResposta).slice(0, 500),
                    mensagem_usuario: String(message).slice(0, 200)
                }
            });
            return fallback;
        }
```

⚠️ Conferir se `registrarEvento` já está importado em `router.js`. Se não estiver, adicionar ao
import de `./observabilidade.js`.

### A.3 Reforço no prompt e folga de tokens

**(a)** Na última linha do prompt, substituir:
```
Responda APENAS com um JSON válido, sem nenhum texto antes ou depois, no formato exato:
```
por:
```
Responda APENAS com um JSON válido — sem bloco de código markdown, sem ``` e sem nenhum texto
antes ou depois. Comece a resposta diretamente com "{". Formato exato:
```

**(b)** Aumentar `max_tokens` de `160` para `250`. O campo `params` deixou a saída mais longa e
160 pode truncar o JSON — que produz exatamente o mesmo sintoma de falha de parse.

---

## PARTE B — Extração determinística da data (C-1)

A correção **não** é remover as frases da Camada 1. É deixar de depender exclusivamente do
`params` do classificador: a data passa a ser extraída do texto da mensagem por código, com o
`params` como fallback. Mesmo desenho de `resolverMedicamento` — **princípio 17** (texto literal
vence palpite do classificador). Com isso a Camada 1 volta a ser um caminho rápido inofensivo.

### B.1 Novo extrator em `src/dataReferencia.js`

Acrescentar ao final do arquivo:

```javascript
// Extrai a expressão de data do texto da mensagem, deterministicamente.
// Princípio 17: o texto literal resolve primeiro; o params do classificador é fallback.
// Ordem de precedência: data explícita > "dia N" > dia da semana > palavra relativa.
// Números soltos NÃO são aceitos (evita confundir com horário ou quantidade de comprimidos) —
// só contam quando precedidos de "dia".
export function extrairExpressaoData(message) {
    const msg = String(message || '').toLowerCase();

    // 1. Data explícita: dd/mm ou dd/mm/aaaa
    const mData = msg.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
    if (mData) return mData[1];

    // 2. "dia 19", "no dia 19"
    const mDia = msg.match(/\bdia\s+(\d{1,2})\b/);
    if (mDia) return mDia[1];

    // 3. Dia da semana (chaves de DIAS_SEMANA, com fronteira de palavra)
    for (const nome of Object.keys(DIAS_SEMANA)) {
        if (new RegExp(`(^|\\s)${nome}(\\s|$|[.,!?])`, 'i').test(msg)) return nome;
    }

    // 4. Palavras relativas — anteontem antes de ontem (contém "ontem" como substring)
    if (/(^|\s)anteontem(\s|$|[.,!?])/i.test(msg)) return 'anteontem';
    if (/(^|\s)ontem(\s|$|[.,!?])/i.test(msg)) return 'ontem';
    if (/(^|\s)hoje(\s|$|[.,!?])/i.test(msg)) return 'hoje';

    return null;
}
```

⚠️ A ordem do item 4 importa: "anteontem" contém "ontem". Testar os dois.

### B.2 Usar no handler

Em `src/agentes/relatorios.js`, dentro de `relatorioBalancoDoDia`, substituir a linha de
resolução de data por:

```javascript
    // Princípio 17: texto da mensagem primeiro; params do classificador como fallback.
    // Necessário porque a Camada 1 não produz params (C-1, v25).
    const expressao = extrairExpressaoData(message) || params.expressaoData;
    const { dataISO, erro } = resolverDataReferencia(expressao);
```

E acrescentar `extrairExpressaoData` ao import de `../dataReferencia.js`.

---

## PARTE C — Doses do dia ainda sem linha em `dose_logs` (C-2)

### C.1 Complementar o dia corrente

Em `src/database.js`, `getDosesDoDia`: **somente quando `dataISO` for hoje**, acrescentar as doses
agendadas que ainda não têm linha em `dose_logs`.

⚠️ **Só para hoje.** Para dias passados não é possível reconstruir com segurança quais horários
estavam vigentes naquela data (os `schedules` podem ter mudado desde então). Limitação consciente.

Substituir o `return` final da função por:

```javascript
    const doses = (data || []).map(d => ({
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
        confirmadaRetroativamente: d.confirmed === true && d.taken_at
            ? new Date(d.taken_at).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) !== dataISO
            : false,
        horarioJaPassou: true
    }));

    // A linha em dose_logs só nasce quando o scheduler envia o lembrete (~2 min antes do
    // horário). Doses futuras do dia de hoje, portanto, ainda não existem no banco (C-2, v25).
    // Complementamos com os horários cadastrados que ainda não têm linha.
    // Apenas para HOJE: em dias passados não há como saber quais horários estavam vigentes.
    if (dataISO !== hojeBRT()) return doses;

    const { data: schedules } = await supabase
        .from('schedules')
        .select('medication_id, horario')
        .in('medication_id', medicationIds)
        .eq('ativo', true);

    const agoraHHMM = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
    });

    const jaTemLinha = new Set(doses.map(d => `${d.medicationId}|${d.horario}`));

    for (const s of (schedules || [])) {
        const horario = String(s.horario).substring(0, 5);
        const chave = `${s.medication_id}|${horario}`;
        if (jaTemLinha.has(chave)) continue;

        doses.push({
            id: null,
            medicationId: s.medication_id,
            nome: medNomeMap[s.medication_id] || 'medicamento',
            horario,
            scheduledAt: null,
            status: 'agendado',           // status sintético — não existe em dose_logs
            confirmado: false,
            takenAt: null,
            confirmadaRetroativamente: false,
            horarioJaPassou: horario <= agoraHHMM
        });
    }

    return doses.sort((a, b) => a.horario.localeCompare(b.horario));
}
```

E acrescentar `hojeBRT` ao import de `./dataReferencia.js` em `database.js`.

⚠️ Verificar o nome real da coluna de horário em `schedules` (`horario`) e se existe a coluna
`ativo`. Se `ativo` não existir, remover o `.eq('ativo', true)`.

### C.2 Corrigir os textos do template

Em `src/templates/balancoTemplates.js`, substituir os dois mapas e a função `montarBlocoFactual`:

```javascript
const ICONE = {
    confirmado: '✅',
    nao_informado: '⏳',
    nao_tomado: '❌',
    sem_estoque: '📦',
    pendente: '❓',
    agendado: '🔜'
};

// 'pendente' = lembrete JÁ enviado, aguardando resposta do usuário (não é dose futura).
// 'agendado' = status sintético para dose do dia que ainda não tem linha em dose_logs.
function descrever(d) {
    switch (d.status) {
        case 'confirmado': return 'confirmado';
        case 'nao_informado': return 'sem confirmação';
        case 'nao_tomado': return 'não tomado';
        case 'sem_estoque': return 'sem estoque';
        case 'pendente': return 'aguardando sua confirmação';
        case 'agendado': return d.horarioJaPassou ? 'sem registro ainda' : 'ainda não chegou o horário';
        default: return d.status;
    }
}

export function montarBlocoFactual(doses) {
    return doses.map(d => {
        const icone = ICONE[d.status] || '•';
        const sufixo = d.confirmadaRetroativamente ? ' (confirmado depois)' : '';
        return `${icone} *${d.nome}* — ${d.horario} — ${descrever(d)}${sufixo}`;
    }).join('\n');
}
```

### C.3 Corrigir `resumirSituacao`

O status `pendente` estava sendo contado como dose futura, o que inverte o sentido do resumo.
Substituir a função inteira:

```javascript
export function resumirSituacao(doses) {
    const total = doses.length;
    const confirmadas = doses.filter(d => d.status === 'confirmado').length;
    const aguardandoConfirmacao = doses.filter(d => d.status === 'pendente').length;
    const aindaNaoChegaram = doses.filter(d => d.status === 'agendado' && !d.horarioJaPassou).length;
    const faltantes = doses.filter(d =>
        d.status === 'nao_informado' || d.status === 'nao_tomado' || d.status === 'sem_estoque'
    ).length;
    const semRegistro = doses.filter(d => d.status === 'agendado' && d.horarioJaPassou).length;

    let cenario;
    if (total === 0) cenario = 'sem_doses';
    else if (confirmadas === total) cenario = 'tudo_confirmado';
    else if (confirmadas === 0 && aindaNaoChegaram === total) cenario = 'nada_chegou_ainda';
    else if (confirmadas === 0) cenario = 'nada_confirmado';
    else cenario = 'parcial';

    return { total, confirmadas, faltantes, aguardandoConfirmacao,
             aindaNaoChegaram, semRegistro, cenario };
}
```

⚠️ `molduraPadrao` referencia `resumo.total` e `resumo.cenario` — ambos continuam existindo, não
precisa alterar. Mas conferir se ela usa `pendentesFuturas` (nome antigo); se usar, trocar por
`aindaNaoChegaram`.

### C.4 Ajustar a entrada da moldura

Em `gerarMoldura` (`src/agentes/relatorios.js`), o objeto `entrada` referencia
`resumo.pendentesFuturas`, que não existe mais. Substituir por:

```javascript
    const entrada = JSON.stringify({
        nome,
        dia: rotuloData,
        medicamentoEspecifico: med ? true : false,
        cenario: resumo.cenario,
        totalDoses: resumo.total,
        confirmadas: resumo.confirmadas,
        faltantes: resumo.faltantes,
        aguardandoConfirmacao: resumo.aguardandoConfirmacao,
        aindaNaoChegaram: resumo.aindaNaoChegaram,
        semRegistro: resumo.semRegistro,
        podeConfirmarRetroativo
    });
```

E acrescentar ao `PROMPT_MOLDURA`, logo após a lista de cenários:

```
Sobre os números recebidos:
- "aguardandoConfirmacao": doses cujo horário já passou e que ainda esperam a resposta do usuário.
- "aindaNaoChegaram": doses do dia cujo horário ainda não chegou — não são atraso, não cobre.
- "semRegistro": doses cujo horário passou sem registro. Não afirme que o usuário não tomou;
  trate como pendência de confirmação.
```

---

## PARTE D — Risco de borda registrado (sem correção agora)

`scheduled_at` é gravado ~2 minutos antes do horário devido. Uma dose de 00:00 receberia
`scheduled_at` às 23:58 do **dia anterior**, caindo na janela BRT errada em `getDosesDoDia`.
Não observado em produção (nenhum usuário tem dose entre 00:00 e 00:02). Registrar como BUG de
prioridade baixa — a correção correta seria filtrar por `horario_agendado` + data, não por
`scheduled_at`, e isso merece análise própria.

---

## 1. Checklist para o Claude Code

1. `src/router.js`:
   - adicionar `extrairJSON` (A.1);
   - substituir o bloco de parse por A.2, com `registrarEvento`;
   - conferir/adicionar import de `registrarEvento`;
   - ajustar última linha do prompt (A.3a) e `max_tokens` → 250 (A.3b).
2. `src/dataReferencia.js` — adicionar `extrairExpressaoData` (B.1).
3. `src/agentes/relatorios.js`:
   - import de `extrairExpressaoData`;
   - usar texto-primeiro em `relatorioBalancoDoDia` (B.2);
   - ajustar `entrada` e `PROMPT_MOLDURA` em `gerarMoldura` (C.4).
4. `src/database.js` — complementar `getDosesDoDia` (C.1) + import de `hojeBRT`.
5. `src/templates/balancoTemplates.js` — `ICONE`, `descrever`, `montarBlocoFactual` (C.2),
   `resumirSituacao` (C.3), conferir `molduraPadrao`.
6. `node --check` em todos os arquivos tocados.
7. Verificação: `grep -rn "pendentesFuturas" src/` deve retornar **zero** resultados.
8. Commit + push.
9. Escritas em `backlog_items` (seção 2) via `src/backlog.js`.

**Não** alterar as frases da Camada 1 — com B.1 elas voltam a ser inofensivas.

---

## 2. Escritas em `backlog_items` (via `src/backlog.js`)

**Inserir:**

| tipo | numero | titulo | status | prioridade | data_criacao |
|---|---|---|---|---|---|
| BUG | 72 | Classificador central falha ao parsear JSON com cercas markdown e cai silenciosamente no principal (29% das chamadas) | em_validacao | alta | 2026-07-29 |
| BUG | 73 | Camada 1 de relatórios captura frases com data mas não produz params, perdendo a data pedida | em_validacao | alta | 2026-07-29 |
| BUG | 74 | balanco_do_dia não mostra doses do dia ainda sem linha em dose_logs (linha só nasce no envio do lembrete) | em_validacao | alta | 2026-07-29 |
| BUG | 75 | scheduled_at gravado ~2min antes do horário pode jogar dose de 00:00 na janela do dia anterior | aberto | baixa | 2026-07-29 |
| MH | 60 | Subtipo `reposicao`: priorizar recompra por dias de cobertura (estoque ÷ doses por dia), não por unidades | aberto | media | 2026-07-29 |

Descrição do MH-60 (para o campo `descricao`): *"Unidades enganam — 8 unidades a 1/dia duram 8
dias, 10 unidades a 3/dia duram 3. A pergunta 'quais remédios preciso comprar' hoje cai em
`estoque` e devolve a lista completa por unidades. Criar subtipo próprio que ordena por dias de
cobertura e destaca o que acaba primeiro. O cálculo já existe no projeto
(`Math.floor(estoque / dosesPorDia)`, usado no bloco de estoque do progresso de tratamento)."*

---

## 3. Roteiro de validação em produção

**Parte A — parse do classificador (crítico)**
1. Fazer ~10 perguntas variadas e conferir nos logs do Railway que **não aparece** nenhuma linha
   `⚠️ Resposta não-JSON`.
2. Conferir também via banco:
   `SELECT COUNT(*) FROM system_events WHERE agent='classificador' AND tipo='erro_tecnico' AND created_at > now() - interval '1 hour';`
   → esperado **0**.
3. "Eu tomei dipirona hoje?" e "Qual próximo horário da dipirona?" repetidas 3× cada → devem ir
   para `relatorios` **todas** as vezes.

**Parte B — data**
4. "Faltou algum remédio ontem?" → deve mostrar **ontem** (era o caso que falhava).
5. "Faltou algum remédio no dia 01/06" → deve responder o texto de fora da janela (30 dias).
6. "Faltou eu tomar algum remédio no dia 15/07?" → deve mostrar 15/07 pelo `relatorios`.
7. "Tomei remédio anteontem?" → deve mostrar 27/07, não 28/07.

**Parte C — doses futuras do dia**
8. Perguntar "tomei dipirona hoje?" em um horário **antes** da primeira dose do dia → deve listar
   os horários com "ainda não chegou o horário", não "não encontrei nenhuma dose".
9. Com uma dose lembrada e não confirmada, perguntar "tomei tudo hoje?" → deve aparecer
   "aguardando sua confirmação", **não** "ainda não chegou o horário".

**Parte D — não-regressão**
10. Responder "Sim" e "Tomei" a lembretes reais → devem confirmar normalmente.
11. "Como tá meu estoque" → `relatorios/estoque`.
12. Adesão de 7 dias e progresso de tratamento com 2+ tratamentos → fluxos devem continuar.