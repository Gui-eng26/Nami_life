# BRIEFING 1 — BUG-052 + BUG-053

**Sessão:** v10 — 23/06/2026  
**Arquivos afetados:** `src/agentes/configuracao.js`, `src/database.js` (BUG-052 pode tocar `principal.js` + nova função utilitária)

---

## Contexto

Dois bugs cirúrgicos e independentes, identificados em testes reais. Ambos com causa raiz confirmada em código. Não tocam o roteador nem a arquitetura de roteamento — são as correções mais seguras do conjunto de melhorias mapeadas, por isso vão primeiro.

---

## BUG-052 — "Próxima dose" é delegada ao LLM em vez de calculada deterministicamente

### Causa raiz confirmada

Quando o usuário pergunta "Quais próximos remédios tenho que tomar?", o `principal` monta o contexto com a lista de horários de cada medicamento e as doses recentes (`recentDoses`), e **delega ao LLM decidir o que é a próxima dose**. Não há cálculo determinístico.

**Código confirmado (`principal.js`, `buildUserMessage`):**
```javascript
const horarios = m.schedules && m.schedules.length > 0
    ? m.schedules.filter(s => s.ativo).map(s => s.horario).join(', ')
    : 'nenhum horário cadastrado';
// ...
Doses recentes: ${JSON.stringify(recentDoses.slice(0, 5))}
```

O LLM recebe todos os horários + doses recentes e decide sozinho qual destacar. Resultado observado nos testes:
- **Dipirona** (com dose pendente das 06:00): o LLM destacou 06:00 — horário passado, porque havia uma dose não confirmada em `recentDoses`
- **Ômega 3** (sem pendência): o LLM destacou 21:00 — próximo horário futuro

O LLM está **misturando dois conceitos distintos**: "dose pendente de confirmação" (passada, não respondida) e "próxima dose a tomar" (futura). Para o Dipirona pegou a pendente; para o Ômega 3 pegou a futura. Comportamento inconsistente porque não há regra determinística — cada caso depende do que o LLM infere.

### Por que isso viola um princípio do projeto

Princípio não-negociável do projeto: **cálculos relacionados a saúde (aritmética de horários, próxima dose) não devem depender de inferência do LLM — devem usar código determinístico.** "Qual a próxima dose a partir de agora" é uma pergunta com resposta exata, calculável a partir da hora atual e dos schedules ativos. Não pode variar conforme a interpretação do modelo.

### Solução

Criar função determinística `calcularProximaDose` em `database.js` (ou módulo utilitário) que, dado um medicamento e a hora atual, retorna o próximo horário de dose:

```javascript
// Retorna o próximo horário de dose a partir de agora (timezone São Paulo)
// Considera todos os schedules ativos; se todos já passaram hoje, retorna o primeiro de amanhã
function calcularProximaDose(schedulesAtivos, agora = new Date()) {
    if (!schedulesAtivos || schedulesAtivos.length === 0) return null;

    // Hora atual em minutos desde meia-noite (timezone São Paulo)
    const horaAtualStr = agora.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo', hour12: false
    });
    const [hAtual, mAtual] = horaAtualStr.split(':').map(Number);
    const minutosAgora = hAtual * 60 + mAtual;

    // Converte cada schedule em minutos e ordena
    const horariosMinutos = schedulesAtivos
        .map(s => {
            const [h, m] = s.horario.substring(0, 5).split(':').map(Number);
            return { horario: s.horario.substring(0, 5), minutos: h * 60 + m };
        })
        .sort((a, b) => a.minutos - b.minutos);

    // Próximo horário futuro hoje
    const proximoHoje = horariosMinutos.find(h => h.minutos > minutosAgora);
    if (proximoHoje) {
        return { horario: proximoHoje.horario, quando: 'hoje' };
    }

    // Todos já passaram → primeiro de amanhã
    return { horario: horariosMinutos[0].horario, quando: 'amanhã' };
}
```

**Integração no `principal.js`:**

Calcular a próxima dose de cada medicamento deterministicamente e passar o resultado pronto ao LLM — em vez de deixar o LLM inferir. O contexto passado ao LLM deve incluir, para cada medicamento:

```javascript
const proximaDose = calcularProximaDose(m.schedules.filter(s => s.ativo));
// Adicionar ao contexto do medicamento:
// "próxima dose: ${proximaDose.horario} (${proximaDose.quando})"
```

E o prompt do `principal` deve instruir: quando o usuário perguntar pela próxima dose, usar o campo "próxima dose" já calculado — nunca inferir a partir da lista de horários.

**Importante — distinção que o prompt deve deixar clara:**

- "próxima dose" = o horário calculado deterministicamente (futuro)
- "dose pendente de confirmação" = dose passada em `recentDoses` com status pendente — deve ser mencionada separadamente como alerta, não confundida com a próxima dose

Exemplo de resposta correta:
```
💊 Dipirona — próxima dose às 20:00
⚠️ Atenção: a dose das 06:00 ainda está pendente de confirmação
```

### Validação esperada

1. São 13:34. Dipirona tem horários 06:00, 12:00, 20:00. Dose das 06:00 pendente.
   → "próxima dose: 20:00 (hoje)" + alerta separado sobre a dose das 06:00 pendente
2. Ômega 3 tem horários 09:00, 21:00. Sem pendência. São 13:34.
   → "próxima dose: 21:00 (hoje)"
3. Medicamento com todos os horários já passados hoje → "próxima dose: [primeiro horário] (amanhã)"

---

## BUG-053 — `obter_horario` não reconhece linguagem natural de horário

### Causa raiz confirmada

**Evidência nos logs (19:34:34):** usuário disse "3 da tarde" na etapa `obter_horario` (adicionar horário ao Ômega 3) → "Não reconheci esse horário. Me diga só o novo horário no formato HH:MM". Depois "15:00" funcionou.

**Código confirmado (`configuracao.js` linha 472):**
```javascript
if (etapa === 'obter_horario') {
    const novoHorario = extrairHorarioDestino(message);  // só formato numérico
    // ...
}
```

`extrairHorarioDestino` usa apenas regex numérico `(\d{1,2})[:h](\d{2})?` — não reconhece "3 da tarde", "8 da noite", "meio-dia".

**Nuance crítica confirmada no código:**

A função `normalizarHorario` (que reconhece linguagem natural) **só retorna um horário se ele já existir em `schedulesDisponiveis`**:
```javascript
const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(horaStr + ':'));
if (schedule) return schedule.horario.substring(0, 5);
```

Ela foi projetada para **identificar um horário existente** (alterar/remover). Mas em `obter_horario` para **adicionar** ou definir um **novo** horário, o horário não existe na lista — então `normalizarHorario` retornaria `null` mesmo para "3 da tarde", porque 15:00 não está nos schedules atuais.

Por isso a correção não é simplesmente trocar `extrairHorarioDestino` por `normalizarHorario` — precisamos de uma função que **converta linguagem natural em horário sem depender de lista de referência**.

### Solução

Criar `interpretarHorarioLivre(message)` — converte linguagem natural em horário HH:MM sem precisar de lista de schedules:

```javascript
function interpretarHorarioLivre(message) {
    const msg = message.toLowerCase().trim();

    // 1. Formato numérico explícito (HH:MM ou HHhMM) — pega o último (destino)
    const matchesNumericos = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (matchesNumericos.length > 0) {
        const m = matchesNumericos[matchesNumericos.length - 1];
        let hora = parseInt(m[1]);
        const min = m[2] || '00';
        // Período do dia mencionado junto (ex: "8h da noite")
        if (/(da\s*tarde|da\s*noite|de\s*noite|pm)/i.test(msg) && hora < 12) hora += 12;
        if (hora >= 0 && hora <= 23) {
            return `${String(hora).padStart(2, '0')}:${min.padStart(2, '0')}`;
        }
    }

    // 2. Número isolado com período (ex: "3 da tarde", "8 da noite", "9 da manhã")
    const matchPeriodo = msg.match(/(\d{1,2})\s*(da\s*manhã|de\s*manhã|da\s*tarde|da\s*noite|de\s*noite|am|pm)/i);
    if (matchPeriodo) {
        let hora = parseInt(matchPeriodo[1]);
        const periodo = matchPeriodo[2].toLowerCase();
        const ehTardeNoite = /tarde|noite|pm/.test(periodo);
        if (ehTardeNoite && hora < 12) hora += 12;
        if (/manhã|manha|am/.test(periodo) && hora === 12) hora = 0;
        if (hora >= 0 && hora <= 23) {
            return `${String(hora).padStart(2, '0')}:00`;
        }
    }

    // 3. Número isolado com "h" (ex: "14h", "8h")
    const matchHora = msg.match(/(\d{1,2})\s*h(?:oras?)?$/i);
    if (matchHora) {
        const hora = parseInt(matchHora[1]);
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    // 4. Número isolado puro (ex: "15", "8") — assume formato 24h
    const matchIsolado = msg.match(/^(\d{1,2})$/);
    if (matchIsolado) {
        const hora = parseInt(matchIsolado[1]);
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    // 5. Expressões nomeadas
    if (/meio.?dia/i.test(msg)) return '12:00';
    if (/meia.?noite/i.test(msg)) return '00:00';

    return null; // não reconhecido
}
```

**Substituir em `obter_horario` (linha 472):**
```javascript
if (etapa === 'obter_horario') {
    const novoHorario = interpretarHorarioLivre(message);  // ← era extrairHorarioDestino
    if (!novoHorario) {
        return `Não reconheci esse horário, ${firstName}. Me diga o horário — pode ser assim: *15:00*, *3 da tarde* ou *15h* 😊`;
    }
    // ... resto do fluxo
}
```

**Atenção — a correção de horário no BUG-043 (linha 484):**

A linha 484 usa `extrairHorarioDestino` para detectar correção de horário em `confirm_acao`. Substituir também por `interpretarHorarioLivre` para consistência — assim "Não, 3 da tarde" também é reconhecido como correção.

**Mensagem de erro mais acolhedora:**

A mensagem antiga ("formato HH:MM") força o usuário a se adaptar ao sistema. A nova mensagem mostra que vários formatos são aceitos — alinhado ao princípio de que o fluxo serve o usuário, não o contrário.

### Ambiguidade 12h — decisão de design

"3" sozinho é interpretado como 03:00 (formato 24h). Se o usuário quis dizer 15:00, deve dizer "3 da tarde" ou "15". Isso é aceitável: a mensagem de erro e os exemplos orientam o formato. Para horários da tarde/noite sem período explícito, o número em formato 24h é a interpretação mais segura — assumir PM poderia agendar uma dose no horário errado, o que é pior em contexto de saúde.

### Validação esperada

1. "3 da tarde" em `obter_horario` → 15:00 ✅
2. "8 da noite" → 20:00 ✅
3. "15:00" → 15:00 ✅
4. "15" → 15:00 ✅
5. "14h" → 14:00 ✅
6. "meio-dia" → 12:00 ✅
7. "9 da manhã" → 09:00 ✅
8. "Não, 3 da tarde" (correção em confirm_acao) → reconhece correção para 15:00 ✅

---

## Resumo das alterações

| O que muda | Onde | Bug |
|---|---|---|
| Nova função `calcularProximaDose` | `database.js` ou utilitário | BUG-052 |
| `principal` passa próxima dose calculada ao LLM | `principal.js` `buildUserMessage` | BUG-052 |
| Prompt do `principal` distingue "próxima dose" de "dose pendente" | `prompts.js` ou inline | BUG-052 |
| Nova função `interpretarHorarioLivre` | `configuracao.js` | BUG-053 |
| `obter_horario` usa `interpretarHorarioLivre` | `configuracao.js` linha 472 | BUG-053 |
| Correção de horário em `confirm_acao` usa `interpretarHorarioLivre` | `configuracao.js` linha 484 | BUG-053 |
| Mensagem de erro de horário mais acolhedora | `configuracao.js` | BUG-053 |

---

## Impacto em outros sistemas — verificado

| Sistema | Impacto | Justificativa |
|---|---|---|
| `normalizarHorario` (identif_schedule) | Nenhum | Continua existindo para identificar horários existentes — não é alterada |
| Cron de lembretes | Nenhum | Não usa as funções alteradas |
| Relatórios | Nenhum | `calcularProximaDose` é nova, não substitui lógica de relatório |
| Fluxos de alterar/remover horário | Nenhum | `identif_schedule` continua usando `normalizarHorario` |

---

**Comando para Claude Code:**  
`Leia o briefings/BRIEFING_BUG052_053.md e implemente.`