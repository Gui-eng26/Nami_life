# BRIEFING — Ajustes finais de relatórios (v25)

**Sessão:** v25 (29/07/2026) — quarto e último briefing da sessão
**Antecedentes:** `BRIEFING_RELATORIOS_V25`, `BRIEFING_CORRECAO_V25`, `BRIEFING_FECHAMENTO_V25`
(todos implantados e validados em produção)

**Status validado:** N-1, N-2 e N-3 confirmados corrigidos. Teste crítico do N-2 passou —
`proximo_remedio` (20:30:02) e `balanco_do_dia` (20:30:35) concordaram integralmente sobre o status
de cada dose, e a resolução por dose funcionou (Dipirona 16:00 confirmada não contaminou a das
20:00). Cabeçalho de data correto nos quatro formatos. 0 falhas de parse em 11 classificações.

Este briefing fecha quatro ajustes pequenos. Auto-contido.

---

## 0. Achados

### A-1 — Ordenação do estoque: por unidades, não alfabética

O `BRIEFING_FECHAMENTO_V25` introduziu `ORDER BY nome` no `getEstoque` para resolver a ordem
instável (N-4). A ordem estabilizou, mas alfabética não é a ordem útil: o que importa é o que está
acabando. Decisão do Guilherme: **ordenar por unidades, do menor para o maior**.

Isso é precursor consciente do desenho definitivo por **dias de cobertura** (MH-60, já registrado):
unidades ainda enganam — 8 unidades a 1/dia duram 8 dias, 10 unidades a 3/dia duram 3. Ordenar por
unidade crescente é uma aproximação melhor que a alfabética enquanto o MH-60 não é feito.

⚠️ `getEstoque` tem **um único consumidor** (`relatorioEstoque`), verificado por grep. Alterar a
query na origem é seguro.

### A-2 — Ordenação alfabética em `meus_remedios`

O relatório de remédios cadastrados saiu em ordem não determinística (Vitamina C, Ômega 3,
Dipirona, Cataflam). Decisão: ordem alfabética.

⚠️ Aqui a correção **não** pode ser na origem. `getUserMedications` tem **sete consumidores**
(`getDosesHoje`, `getMedicamentosAtivos`, `getProximosMedicamentos`, `calcularAdesao`,
`calcularProgressoTratamento`, `configuracao.js`, `principal.js`). Reordenar lá mudaria o
comportamento de quem não pediu. A ordenação é feita **localmente** em `relatorioMeusRemedios`.

### A-3 — Precedência invertida na extração de data (`"o outro domingo, 19"`)

Evidência: "Não, o outro domingo, 19" (20:33:34). O classificador extraiu corretamente
`expressaoData: "19"`, mas `extrairExpressaoData` roda primeiro (precedência de texto, princípio 17),
encontrou a palavra "domingo" e devolveu `"domingo"` → resolveu para 26/07, ignorando o 19.

Causa raiz: o padrão de número solto exige o prefixo "dia" (`\bdia\s+(\d{1,2})\b`) — proteção
deliberada contra confundir com horário ou quantidade de comprimidos. Sem esse prefixo, o número
não é capturado e o dia da semana vence, apesar de ser a informação **menos** específica.

Correção: capturar número **adjacente ao dia da semana**. Preserva a proteção original (um número
solto em qualquer lugar da frase continua ignorado) e faz a informação mais específica ganhar.

Confirmado que a segunda tentativa funcionou porque "19/07" casa com o padrão de data explícita.

### A-4 — `dosagem` nula exibida como "null"

Evidência: *"Ômega 3 — **null** (comprimido)"*. `forma_farmaceutica` tem fallback
(`|| 'comprimido'`), `dosagem` não tem.

---

## PARTE 1 — Ordenação do estoque (A-1)

Em `src/database.js`, `getEstoque` — substituir o `.order()` introduzido no briefing anterior:

```javascript
export async function getEstoque(userId) {
    const { data } = await supabase
        .from('medications')
        .select('id, nome, estoque_atual, estoque_minimo, forma_farmaceutica')
        .eq('user_id', userId)
        .eq('ativo', true)
        // A-1 (v25): ordem por unidades crescente — o que está acabando aparece primeiro.
        // Substitui a ordem alfabética do briefing anterior. Aproximação consciente:
        // a ordem correta é por DIAS DE COBERTURA (estoque ÷ doses por dia), tratada no MH-60.
        // Desempate por nome para manter a ordem estável entre chamadas (motivo do N-4).
        .order('estoque_atual', { ascending: true })
        .order('nome', { ascending: true });
    return data || [];
}
```

---

## PARTE 2 — Ordenação alfabética em `meus_remedios` (A-2)

Em `src/agentes/relatorios.js`, `relatorioMeusRemedios` — inserir a ordenação logo após a guarda
de lista vazia:

```javascript
async function relatorioMeusRemedios(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const medications = await getMedicamentosAtivos(user.id);

    if (medications.length === 0) {
        return `Você ainda não tem remédios cadastrados, ${firstName}. Quer cadastrar agora? 💊`;
    }

    // A-2 (v25): ordem alfabética. Feita AQUI e não em getUserMedications de propósito —
    // aquela função tem sete consumidores e reordenar na origem mudaria o comportamento
    // de quem não pediu. localeCompare com 'pt-BR' para acentuação correta (Ômega).
    const ordenados = [...medications].sort((a, b) =>
        String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR')
    );

    let msg = `💊 Seus remédios cadastrados, ${firstName}:\n\n`;

    ordenados.forEach((med, i) => {
        const horariosAtivos = (med.schedules || []).filter(s => s.ativo);
        // A-2 (v25): horários também ordenados — antes saíam na ordem do banco ("21:00 e 09:00").
        const horarios = horariosAtivos.length > 0
            ? horariosAtivos
                .map(s => s.horario.substring(0, 5))
                .sort((x, y) => x.localeCompare(y))
                .join(' e ')
            : 'sem horário cadastrado';
        const forma = med.forma_farmaceutica || 'comprimido';
        // A-4 (v25): dosagem nula era exibida literalmente como "null".
        const dosagem = med.dosagem || 'dosagem não informada';
        msg += `${i + 1}. *${med.nome}* — ${dosagem} (${forma})\n`;
        msg += `   ⏰ ${horarios}\n\n`;
    });

    return msg.trim();
}
```

⚠️ A ordenação dos horários também entra aqui: o relatório exibia "21:00 e 09:00 e 12:40" (ordem do
banco). Não é defeito relatado, mas é a mesma classe do A-2 e o custo é uma linha.

---

## PARTE 3 — Número adjacente ao dia da semana (A-3)

Em `src/dataReferencia.js`, `extrairExpressaoData` — substituir o bloco 3 (dia da semana):

```javascript
    // 3. Dia da semana — com número adjacente, o número ganha (é mais específico).
    //    A-3 (v25): "Não, o outro domingo, 19" resolvia para o domingo mais recente porque
    //    "domingo" era capturado e o "19" solto era ignorado (número solto só conta com
    //    prefixo "dia", proteção contra horário/quantidade de comprimidos). Aceitamos o
    //    número apenas quando ele está adjacente ao nome do dia — a proteção original
    //    continua valendo para número solto em qualquer outra posição da frase.
    for (const nome of Object.keys(DIAS_SEMANA)) {
        if (!new RegExp(`(^|\\s)${nome}(\\s|$|[.,!?])`, 'i').test(msg)) continue;

        const mAdjacente = msg.match(new RegExp(`${nome}[,\\s]+(?:dia\\s+)?(\\d{1,2})\\b`, 'i'));
        if (mAdjacente) return mAdjacente[1];

        return nome;
    }
```

⚠️ Manter o bloco 2 (`\bdia\s+(\d{1,2})\b`) **antes** deste, e os blocos 4
(`anteontem` → `ontem` → `hoje`) **depois**, na ordem atual.

⚠️ Casos que devem continuar retornando o dia da semana (sem número): "tomei tudo no domingo?",
"pulei algum remédio na terça?". Casos que passam a retornar o número: "o outro domingo, 19",
"domingo 19", "domingo dia 19".

---

## 4. Escritas em `backlog_items` (via `src/backlog.js`)

**Inserir:**

| tipo | numero | titulo | status | prioridade | data_criacao |
|---|---|---|---|---|---|
| BUG | 78 | extrairExpressaoData prioriza dia da semana sobre número adjacente, ignorando "o outro domingo, 19" | em_validacao | media | 2026-07-29 |
| BUG | 79 | dosagem nula exibida literalmente como "null" no relatório de remédios cadastrados | em_validacao | baixa | 2026-07-29 |
| MH | 63 | Janela "agora" de getProximosMedicamentos anuncia "está na hora de tomar" com até 30 min de antecedência, divergindo do enquadramento do balanco_do_dia | aberto | baixa | 2026-07-29 |

**Atualizar:**
- BUG-76 → `resolvido`. Nota: *"Validado em produção 29/07 20:30 — proximo_remedio e
  balanco_do_dia consultados com 33s de diferença concordaram sobre o status de todas as doses;
  resolução por dose confirmada (Dipirona 16:00 não contaminou a das 20:00)."*
- BUG-77 → `resolvido`. Nota: *"Validado em produção 29/07 — cabeçalho determinístico exibido nos
  quatro formatos: quarta-feira (15/07), ontem (28/07), domingo (26/07), domingo (19/07)."*
- BUG-72 → `resolvido`. Nota: *"Validado: 0 falhas de parse em 11 classificações (era 29%)."*
- BUG-73 → `resolvido`. Nota: *"Validado: mensagens interceptadas pela Camada 1 (sem params)
  resolveram a data corretamente via extração determinística do texto."*
- BUG-74 → `resolvido`. Nota: *"Validado: os três estados coexistem corretamente — confirmado,
  aguardando sua confirmação, ainda não chegou o horário."*
- MH-58 → `resolvido` **somente se** a query da telemetria do Juiz Offline já tiver sido conferida
  com a execução do cron. Caso contrário, manter `em_validacao`.

---

## 5. Checklist para o Claude Code

1. `src/database.js` — `getEstoque` com ordem por `estoque_atual` + desempate por `nome` (Parte 1).
2. `src/agentes/relatorios.js` — `relatorioMeusRemedios` com ordenação alfabética, horários
   ordenados e fallback de `dosagem` (Parte 2).
3. `src/dataReferencia.js` — bloco 3 de `extrairExpressaoData` (Parte 3).
4. `node --check` nos três arquivos.
5. Commit + push.
6. Escritas em `backlog_items` (seção 4).

**Não alterar** `getUserMedications` — a ordenação é local, por decisão explícita.

---

## 6. Roteiro de validação

1. "Como tá meu estoque?" → ordem por unidades crescente (Dipirona 7, Cataflam 9, Vitamina C 10,
   Ômega 3 19), e a mesma ordem em duas chamadas consecutivas
2. "Quais são os meus remédios?" → ordem alfabética (Cataflam, Dipirona, Ômega 3, Vitamina C),
   horários em ordem crescente, e nenhum "null" na dosagem
3. "Tomei tudo no domingo?" → 26/07
4. Em seguida: "Não, o outro domingo, 19" → deve resolver para **19/07** com o cabeçalho
   `📅 domingo (19/07)`
5. "Pulei algum remédio na terça?" → deve resolver para a terça mais recente (28/07), **sem**
   número interferindo
6. Não-regressão: "Tomei tudo hoje?" e "Quais minhas próximas doses?" em sequência → devem
   continuar concordando sobre o status de cada dose