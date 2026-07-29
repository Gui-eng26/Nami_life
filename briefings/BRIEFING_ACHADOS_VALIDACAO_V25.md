# BRIEFING — Fechamento dos achados da validação (v25)

**Sessão:** v25 (29/07/2026) — terceiro e último briefing da sessão
**Antecedentes:** `BRIEFING_RELATORIOS_V25` e `BRIEFING_CORRECAO_V25` (ambos implantados e validados)

**Status validado antes deste briefing:** C-1, C-2 e C-3 confirmados corrigidos em produção —
0 falhas de parse em 8 classificações (era 29%), resolução de data funcionando inclusive quando a
Camada 1 intercepta sem `params`, e os três estados (`confirmado` / `aguardando sua confirmação` /
`ainda não chegou o horário`) coexistindo corretamente no `balanco_do_dia`.

Este briefing fecha os quatro achados residuais. Auto-contido — todo texto literal está embutido.

---

## 0. Achados e causas raiz

### N-1 — A data resolvida não chega ao usuário (regressão funcional de decisão desta sessão)

Evidência: "Faltou eu tomar algum remédio no dia 15/07?" respondeu *"todas as suas doses **desta
quarta-feira**"*. O `rotularData` produziu corretamente `"quarta-feira (15/07)"`, mas a moldura do
LLM parafraseou e descartou a data. Como o bloco factual só contém horários, **a data desapareceu
da mensagem inteira** — e 15/07 e 29/07 são ambas quarta-feira.

Causa raiz: o briefing anterior proibiu o LLM de citar datas (regra 1 do `PROMPT_MOLDURA`) **sem
criar um lugar determinístico para a data aparecer**. A decisão desta sessão era responder já
afirmando a data resolvida, para o usuário poder corrigir ("não, o outro domingo, dia 19"). Sem a
data visível, a reorientação fica cega.

Correção: cabeçalho de data renderizado **em código**, acima do bloco factual, para toda data que
não seja hoje. Mantém o princípio 13 (dado factual nasce de template, nunca de geração livre).

### N-2 — `proximo_remedio` anuncia dose já confirmada como "está na hora de tomar"

Evidência da mesma sessão de testes: às 19:55 o Cataflam das 18:30 foi confirmado; às 19:59 o
`balanco_do_dia` mostrou "✅ Cataflam — 18:30 — confirmado"; às 20:05 o `proximo_remedio` disse
"💊 *Cataflam* (18:30) — está na hora de tomar!". **Dois relatórios afirmando coisas contraditórias
sobre o mesmo dado de saúde.**

Três causas raiz distintas, todas confirmadas em código:

1. `relatorioProximoRemedio` — a `linhaAgora` **ignora `m.confirmado` por completo**; só a
   `linhaPassado` usa. Uma dose confirmada dentro da janela "agora" (de -120 a +30 min) é
   anunciada como pendente.
2. `getProximosMedicamentos` — `const confirmado = tomadosIds.includes(med.id)` resolve por
   **medicamento**, não por dose/horário. Se a Dipirona das 16:00 foi confirmada, todos os
   horários da Dipirona ficam marcados como confirmados.
3. `getProximosMedicamentos` consome `getDosesHoje`, que filtra por `taken_at` — o mesmo defeito
   do BUG-70, que corrigimos apenas no `balanco_do_dia`. Uma confirmação retroativa de ontem
   (feita hoje) marca as doses de **hoje** como tomadas.

A correção sistêmica das três é a mesma: `getProximosMedicamentos` passa a usar `getDosesDoDia`
(que já filtra por `scheduled_at` e resolve por dose), casando por `medicationId + horario`.

### N-3 — Escopo semântico de `proximo_remedio`

"Quais minhas **próximas** doses?" devolveu o dia inteiro, incluindo quatro doses já registradas.
Não é erro de dado — é escopo: o subtipo hoje entrega "meus remédios de hoje", não "as próximas".
Tratamento: ajuste conservador de apresentação (ver 3.1), sem mudar a fonte de dados.

### N-4 — `getEstoque` sem ordenação estável

`getEstoque` não tem `ORDER BY`, então a ordem do relatório varia entre chamadas. Observado: duas
consultas na mesma sessão devolveram ordens diferentes.

---

## PARTE 1 — Cabeçalho de data determinístico (N-1)

### 1.1 Novo texto em `src/templates/balancoTemplates.js`

Acrescentar:

```javascript
// Cabeçalho de data (N-1, v25): a data resolvida precisa aparecer na mensagem de forma
// determinística. O LLM está proibido de citar datas na moldura (regra 1 do PROMPT_MOLDURA),
// então sem este cabeçalho a data simplesmente não aparecia — e "quarta-feira" é ambíguo
// entre 15/07 e 29/07. Também é o que permite ao usuário corrigir o dia ("não, o outro domingo").
// Omitido para "hoje": redundante e deixa a mensagem pesada.
export function montarCabecalhoData(dataISO, rotuloData) {
    if (rotuloData === 'hoje') return null;

    const [ano, mes, dia] = dataISO.split('-').map(Number);
    const dataCurta = `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}`;

    // rotularData já devolve "domingo (26/07)" para dias além de anteontem — nesse caso a data
    // já está no rótulo e não deve ser repetida.
    if (rotuloData.includes(dataCurta)) return `📅 ${rotuloData}`;

    // "ontem" / "anteontem" — acrescenta a data para não deixar dúvida
    return `📅 ${rotuloData} (${dataCurta})`;
}
```

### 1.2 Usar no handler

Em `src/agentes/relatorios.js`, `relatorioBalancoDoDia`, substituir a montagem final da mensagem:

```javascript
    const cabecalhoData = montarCabecalhoData(dataISO, rotuloData);

    const partes = [moldura.abertura];
    if (cabecalhoData) partes.push(cabecalhoData);
    if (blocoFactual) partes.push(blocoFactual);
    if (moldura.fechamento) partes.push(moldura.fechamento);

    return comSaudacao(user.id, firstName, partes.join('\n\n'));
```

E acrescentar `montarCabecalhoData` ao import de `../templates/balancoTemplates.js`.

⚠️ Não relaxar a regra 1 do `PROMPT_MOLDURA`. A data passa a existir no cabeçalho determinístico;
o LLM continua proibido de citá-la.

---

## PARTE 2 — `proximo_remedio` coerente com `balanco_do_dia` (N-2)

### 2.1 `getProximosMedicamentos` passa a resolver por dose

Em `src/database.js`, substituir a função inteira:

```javascript
export async function getProximosMedicamentos(userId) {
    const horaAtual = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo'
    }); // "HH:MM"

    const medications = await getUserMedications(userId);

    // N-2 (v25): usa getDosesDoDia em vez de getDosesHoje. Três defeitos corrigidos de uma vez:
    // (a) getDosesHoje filtrava por taken_at, então confirmação retroativa de ontem marcava
    //     doses de hoje como tomadas (mesma raiz do BUG-70);
    // (b) a confirmação era resolvida por medicamento, não por dose/horário;
    // (c) o relatório contradizia o balanco_do_dia sobre o mesmo dado.
    // A chave de casamento é medicationId + horario.
    const dosesHoje = await getDosesDoDia(userId, hojeBRT());
    const confirmadasPorDose = new Set(
        dosesHoje.filter(d => d.status === 'confirmado')
                 .map(d => `${d.medicationId}|${d.horario}`)
    );

    const passados = [];
    const agoraList = [];
    const proximos = [];

    for (const med of medications) {
        for (const schedule of (med.schedules || []).filter(s => s.ativo)) {
            const horario = schedule.horario.substring(0, 5);
            const confirmado = confirmadasPorDose.has(`${med.id}|${horario}`);
            const diff = _minutesDiff(horaAtual, horario);

            if (diff < -120) {
                passados.push({ nome: med.nome, horario, confirmado });
            } else if (diff >= -120 && diff <= 30) {
                agoraList.push({ nome: med.nome, horario, confirmado });
            } else {
                proximos.push({ nome: med.nome, horario, confirmado });
            }
        }
    }

    const byHorario = (a, b) => a.horario.localeCompare(b.horario);
    return {
        passados: passados.sort(byHorario),
        agora: agoraList.sort(byHorario),
        proximos: proximos.sort(byHorario)
    };
}
```

⚠️ `proximos` agora também carrega `confirmado` (antes não carregava). Necessário porque a janela
"agora" vai até +30 min: uma dose confirmada antecipadamente pode cair em `proximos`.

⚠️ **Não remover `getDosesHoje`.** Depois desta mudança ela pode ficar sem uso — verificar com
`grep -rn "getDosesHoje" src/`. Se não houver mais nenhum consumidor, **não apagar nesta sessão**:
registrar como item de limpeza (MH-61, seção 5) para remoção deliberada, com verificação própria.

### 2.2 `relatorioProximoRemedio` respeita `confirmado`

Em `src/agentes/relatorios.js`, substituir as três funções de linha:

```javascript
    const linhaPassado = m => `${m.confirmado ? '✅' : '⚠️'} *${m.nome}* (${m.horario}) — ${m.confirmado ? 'já registrado' : 'não registrado'}`;
    // N-2 (v25): a linha "agora" ignorava m.confirmado e anunciava dose já confirmada como
    // pendente, contradizendo o balanco_do_dia.
    const linhaAgora = m => m.confirmado
        ? `✅ *${m.nome}* (${m.horario}) — já registrado`
        : `💊 *${m.nome}* (${m.horario}) — está na hora de tomar!`;
    const linhaProximo = m => m.confirmado
        ? `✅ *${m.nome}* (${m.horario}) — já registrado`
        : `🔜 *${m.nome}* — próximo às ${m.horario}`;
```

---

## PARTE 3 — Escopo de `proximo_remedio` (N-3)

### 3.1 Não listar o passado já resolvido

Ajuste conservador: doses passadas **já confirmadas** deixam de aparecer quando não há medicamento
nomeado; as passadas **não confirmadas** continuam (são pendência real e útil de mostrar).

Em `relatorioProximoRemedio`, no ramo sem medicamento nomeado, substituir por:

```javascript
    // Sem medicamento nomeado: mostra o que ainda importa.
    // N-3 (v25): "quais minhas próximas doses?" devolvia o dia inteiro, incluindo doses já
    // registradas. Passado já confirmado é ruído aqui; passado NÃO confirmado permanece,
    // porque é pendência real.
    if (!med) {
        const passadosPendentes = passados.filter(m => !m.confirmado);
        const agoraRelevantes = agora.filter(m => !m.confirmado);
        const proximosRelevantes = proximos.filter(m => !m.confirmado);

        if (passadosPendentes.length === 0 && agoraRelevantes.length === 0 && proximosRelevantes.length === 0) {
            return `Tudo em ordem por hoje, ${firstName}! Você já registrou todas as doses do dia. ✅`;
        }

        let msg = `⏰ Seus próximos remédios, ${firstName}:\n\n`;
        for (const m of agoraRelevantes) msg += linhaAgora(m) + '\n';
        for (const m of proximosRelevantes) msg += linhaProximo(m) + '\n';

        if (passadosPendentes.length > 0) {
            msg += `\nAinda sem confirmação de hoje:\n\n`;
            for (const m of passadosPendentes) msg += linhaPassado(m) + '\n';
        }
        return msg.trim();
    }
```

⚠️ O ramo **com** medicamento nomeado (destaque + "Ah, e só pra lembrar") permanece **sem
alteração** — lá o usuário pediu um medicamento específico e a lista completa do resto é o
complemento que já validamos como bom comportamento.

---

## PARTE 4 — Ordenação estável do estoque (N-4)

Em `src/database.js`, `getEstoque`:

```javascript
export async function getEstoque(userId) {
    const { data } = await supabase
        .from('medications')
        .select('id, nome, estoque_atual, estoque_minimo, forma_farmaceutica')
        .eq('user_id', userId)
        .eq('ativo', true)
        .order('nome', { ascending: true });   // N-4 (v25): ordem era instável entre chamadas
    return data || [];
}
```

---

## 5. Escritas em `backlog_items` (via `src/backlog.js`)

**Inserir:**

| tipo | numero | titulo | status | prioridade | data_criacao |
|---|---|---|---|---|---|
| BUG | 76 | proximo_remedio anuncia dose já confirmada como "está na hora de tomar", contradizendo o balanco_do_dia | em_validacao | alta | 2026-07-29 |
| BUG | 77 | balanco_do_dia não exibe a data resolvida — moldura do LLM descarta o rótulo e "quarta-feira" fica ambíguo | em_validacao | media | 2026-07-29 |
| MH | 61 | Avaliar remoção de getDosesHoje após substituição por getDosesDoDia em getProximosMedicamentos | aberto | baixa | 2026-07-29 |
| MH | 62 | proximo_remedio: revisar escopo ("próximas doses" vs "remédios de hoje") com dados de uso | aberto | baixa | 2026-07-29 |

Descrição do MH-61: *"getDosesHoje filtra por taken_at (BUG-70) e resolve confirmação por
medicamento, não por dose. Após a v25 seu único consumidor conhecido era getProximosMedicamentos,
agora migrado para getDosesDoDia. Verificar se restou algum consumidor antes de remover — remoção
deliberada, não oportunista."*

**Atualizar:** BUG-58 → `resolvido` (sessão v25). Nota: *"Validado em produção 29/07: 'Qual estoque
do Cataflam?' retorna apenas o Cataflam."*

---

## 6. Checklist para o Claude Code

1. `src/templates/balancoTemplates.js` — adicionar `montarCabecalhoData` (1.1).
2. `src/agentes/relatorios.js`:
   - import de `montarCabecalhoData`;
   - montagem da mensagem em `relatorioBalancoDoDia` (1.2);
   - três funções de linha em `relatorioProximoRemedio` (2.2);
   - ramo sem medicamento nomeado em `relatorioProximoRemedio` (3.1).
3. `src/database.js`:
   - substituir `getProximosMedicamentos` (2.1);
   - `ORDER BY nome` em `getEstoque` (4).
   - conferir que `getDosesDoDia` e `hojeBRT` estão acessíveis no escopo (mesmo arquivo / import).
4. `node --check` em todos os arquivos tocados.
5. `grep -rn "getDosesHoje" src/` — **apenas relatar** o resultado, não remover nada.
6. Commit + push.
7. Escritas em `backlog_items` (seção 5).

---

## 7. Roteiro de validação em produção

**N-1 — data visível**
1. "Faltou eu tomar algum remédio no dia 15/07?" → deve exibir `📅 quarta-feira (15/07)`
2. "Tomei tudo ontem?" → deve exibir `📅 ontem (28/07)`
3. "Tomei tudo hoje?" → **não** deve exibir cabeçalho de data
4. "Tomei remédio no domingo?" → deve exibir a data sem duplicar (`📅 domingo (26/07)`)
5. Em seguida: "não, o outro domingo, dia 19" → deve reorientar para 19/07 com o cabeçalho certo

**N-2 — coerência entre relatórios (crítico)**
6. Confirmar uma dose e, em menos de 2 horas, perguntar "quais minhas próximas doses?" → a dose
   confirmada deve aparecer como "já registrado", **nunca** como "está na hora de tomar"
7. Na mesma janela, perguntar "tomei tudo hoje?" e comparar: os dois relatórios devem concordar
8. Com um medicamento de 2 horários, confirmar só o primeiro → o segundo deve continuar pendente
   (teste da resolução por dose, não por medicamento)

**N-3 / N-4**
9. "Quais minhas próximas doses?" com todas as doses do dia já confirmadas → deve responder
   "Tudo em ordem por hoje"
10. "Qual próximo horário da dipirona?" → destaque + complemento (comportamento **inalterado**)
11. "Como tá meu estoque?" duas vezes → mesma ordem alfabética nas duas