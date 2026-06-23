# BRIEFING — BUG-047 + BUG-048 + BUG-049 + BUG-050

**Sessão:** v10 — 23/06/2026  
**Arquivo afetado:** `src/agentes/configuracao.js`

---

## Contexto

Quatro bugs identificados durante testes das funcionalidades MH-033/035/036 recém-implementadas. Todos têm causa raiz confirmada em código e logs. Todos estão no mesmo arquivo — implementar separado criaria risco de conflito.

---

## BUG-047 — `classificarIntencao` retorna `ambiguo` para intenções de horário sem horários explícitos + `identif_acao` sem saída de escape

### Causa raiz confirmada

**Evidência direta nos logs do Railway (linha 275):**
```
⚙️ Intenção classificada: {"acao":"ambiguo","medicamentoMencionado":"Dipirona","novoHorario":null}
```
Para a mensagem: `"Quero alterar horário do dipirona"` — inequivocamente `alterar_horario`.

**Causa raiz 1 — prompt com exemplos insuficientes:**

Todos os exemplos das ações de horário no prompt contêm horários numéricos explícitos:
```
alterar_horario: "muda das 8 para 9", "trocar o das 20h para 22h"
remover_horario: "tirar o lembrete das 8h", "apagar o das 20"
adicionar_horario: "quero tomar às 20 também", "adicionar lembrete às 14h"
```

Quando o usuário expressa a intenção sem detalhes ("quero alterar horário", "mudar horário do dipirona"), o LLM não encontra match convincente em nenhuma definição e usa `ambiguo` como fallback — que o prompt define como catch-all implícito para qualquer incerteza.

**Causa raiz 2 — `identif_acao` é um estado sem saída:**

Quando `ambiguo` é retornado, o sistema salva `etapa: identif_acao` e só aceita "pausar" ou "encerrar". Qualquer outra mensagem — incluindo correções legítimas como "quero alterar horário", "mudar horário", "nenhum dos dois" — retorna "Não entendi" em loop eterno. O usuário fica preso sem forma de escapar exceto reiniciando a conversa.

### Solução — duas correções encadeadas

**Correção 1: Eliminar `identif_acao` como etapa persistida**

`identif_acao` tem dois papéis hoje:
- **Papel 1** (linha 320): quando `ambiguo` em `identif_intencao`, aguarda usuário esclarecer pausar vs encerrar
- **Papel 2** (linha 674): quando `remover_horario` num medicamento com 1 único schedule, redireciona para pausar/encerrar

Em ambos os casos, substituir `etapa: 'identif_acao'` por `etapa: 'identif_intencao'` com o contexto do medicamento preservado. Assim a próxima mensagem do usuário — seja ela "pausar", "encerrar", "quero alterar horário" ou qualquer outra intenção — passa pelo `classificarIntencao` e é interpretada corretamente.

**Remover completamente o bloco `if (etapa === 'identif_acao')` (linhas 341–381).** Essa etapa deixa de existir.

**No bloco `ambiguo` em `identif_intencao`:**

```javascript
if (acao === 'ambiguo') {
    const med = medicamentoMencionado
        ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos)
        : null;
    const nomeExibir = med?.nome || 'esse medicamento';

    // Salva identif_intencao com medicamento no contexto — NÃO identif_acao
    await saveConversationState(user.id, {
        state: 'configurando',
        context: {
            etapa: 'identif_intencao',
            medicationId: med?.id || null,
            medicationNome: nomeExibir,
            schedulesAtivos: med ? (med.schedules || []).filter(s => s.ativo) : []
        }
    });
    return `Entendido, ${firstName}! Sobre o *${nomeExibir}*, você quer:\n\n• *Pausar* os lembretes (temporário — pode retomar depois)\n• *Encerrar* o tratamento definitivamente\n\nO que prefere?`;
}
```

**Em `identif_intencao`, usar medicamento do contexto quando disponível:**

```javascript
if (etapa === 'identif_intencao') {
    const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos);

    if (medicationsAtivos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
    }

    if (acao === 'ambiguo') {
        // ... bloco acima
    }

    // Medicamento já identificado no contexto (vem de um ambiguo anterior ou de outro fluxo)
    const medDoContexto = context.medicationId
        ? medicationsAtivos.find(m => m.id === context.medicationId)
        : null;

    const med = medDoContexto
        || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);

    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, novoHorario, message });
}
```

**Em `continuarComAcao`, bloco `remover_horario` com 1 schedule:**

```javascript
if (acao === 'remover_horario') {
    if (schedulesAtivos.length <= 1) {
        // Salva identif_intencao — NÃO identif_acao
        await saveConversationState(user.id, {
            state: 'configurando',
            context: {
                etapa: 'identif_intencao',
                medicationId: med.id,
                medicationNome: med.nome,
                schedulesAtivos
            }
        });
        return `O *${med.nome}* tem apenas um horário de lembrete cadastrado (${schedulesAtivos[0]?.horario?.substring(0,5) || '?'}). Não é possível remover o único horário.\n\nSe quiser parar os lembretes, posso *pausar* temporariamente ou *encerrar* o tratamento. O que prefere?`;
    }
    // ... resto inalterado
}
```

**Correção 2: Ampliar exemplos do `classificarIntencao` para cobrir intenções sem horários explícitos**

O `ambiguo` deve ser estritamente reservado para ambiguidade real entre pausar e encerrar — não usado como fallback para intenções de horário sem detalhe.

Reescrever as definições das ações de horário com exemplos que cobrem **os dois casos**: com e sem horário explícito. E restringir a definição de `ambiguo`:

```javascript
const systemPrompt = `Você é um classificador de intenções para um assistente de saúde.
O usuário quer fazer algo com seus lembretes ou tratamentos.

Medicamentos cadastrados: ${listaMeds}

Responda APENAS com JSON válido, sem markdown, sem explicações:
{
  "acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "remover_horario" | "adicionar_horario" | "redefinir_horarios" | "ambiguo",
  "medicamentoMencionado": "nome mencionado ou null",
  "novoHorario": "HH:MM ou null"
}

Definições:
- pausar: parar lembretes temporariamente.
  Ex: "cancela o lembrete", "para de me lembrar", "quero pausar", "suspender os avisos"

- reativar: ativar lembretes pausados.
  Ex: "volta os lembretes", "ativa de novo", "reativar", "quero retomar"

- encerrar: terminar tratamento definitivamente.
  Ex: "não vou mais tomar", "remove esse remédio", "encerrar tratamento"

- alterar_horario: mudar UM horário específico para outro — com ou sem horário explícito na mensagem.
  Ex com horário: "muda das 8 para 9", "trocar o das 20h para 22h", "alterar das 8 para 10"
  Ex sem horário: "quero alterar horário", "mudar horário", "trocar horário", "quero alterar o horário do dipirona"

- remover_horario: apagar um horário específico sem substituir — com ou sem horário explícito.
  Ex com horário: "tirar o das 8h", "apagar o das 20", "excluir o lembrete das 15h"
  Ex sem horário: "quero remover um horário", "excluir um lembrete", "tirar um dos horários"

- adicionar_horario: acrescentar horário novo sem mexer nos existentes — com ou sem horário explícito.
  Ex com horário: "quero tomar às 20 também", "adicionar lembrete às 14h"
  Ex sem horário: "quero adicionar um horário", "incluir mais um lembrete"

- redefinir_horarios: substituir TODOS os horários ou mudar a frequência de doses.
  Ex com horário: "agora vou tomar 3x ao dia", "mudar para 6h, 14h e 22h"
  Ex sem horário: "quero mudar todos os horários", "redefinir os lembretes", "alterar todos os horários"

- ambiguo: APENAS quando não dá pra distinguir entre PAUSAR (temporário) e ENCERRAR (definitivo).
  Ex: "quero parar", "cancelar", "não preciso mais" — sem deixar claro se é temporário ou definitivo.
  IMPORTANTE: NÃO usar ambiguo para intenções de horário que não tenham detalhes explícitos.
  "Quero alterar horário" é alterar_horario, não ambiguo.
  "Tirar um horário" é remover_horario, não ambiguo.

Quando há dúvida entre pausar e encerrar → ambiguo.
Quando há intenção clara de horário sem detalhes → classificar pelo tipo de operação (alterar/remover/adicionar/redefinir).`;
```

---

## BUG-048 — Medicamentos pausados aparecem em listas indevidas

### Causa raiz confirmada

**Evidência nos agent_logs (13:51:38 e 13:52:07):** Nimesulida (pausada) aparece na lista de opções para `remover_horario` — uma ação que opera sobre schedules ativos, que a Nimesulida não tem.

**Código confirmado (linha 306):**
```javascript
const medicationsAtivos = medications.filter(m => m.ativo !== false);
```

`m.ativo !== false` inclui medicamentos com `ativo: true` mas todos os schedules inativos (pausados). O filtro não distingue "ativo com lembretes" de "ativo pausado".

**Dois vetores do problema:**
1. A lista passada ao `classificarIntencao` inclui pausados — o LLM pode mencioná-los como opção
2. A lista exibida ao usuário em `identif_medicamento` inclui pausados — o usuário os vê como opções válidas

### Solução

Separar medicamentos em dois grupos e usar cada um no contexto correto:

```javascript
// No início do handleConfiguracao, após buscar medications:
const temScheduleAtivo = m => (m.schedules || []).some(s => s.ativo);

const medicamentosComSchedule = medications.filter(m => m.ativo && temScheduleAtivo(m));
const medicamentosPausados = medications.filter(m => m.ativo && !temScheduleAtivo(m));
const medicamentosEncerrados = medications.filter(m => !m.ativo);
```

**Uso por contexto:**

| Contexto | Lista a usar | Justificativa |
|---|---|---|
| `classificarIntencao` | `medicationsAtivos` (todos com `ativo: true`) | O LLM precisa conhecer todos os medicamentos para identificar o que o usuário mencionou — incluindo pausados |
| Listas exibidas ao usuário — ações de horário, pausar, encerrar | `medicamentosComSchedule` | Só faz sentido operar sobre medicamentos com schedules ativos |
| Listas exibidas ao usuário — ação `reativar` | `medicamentosPausados` | Reativar só faz sentido para medicamentos pausados |

**O filtro acontece APÓS a classificação — não antes:**

```javascript
// 1. classificarIntencao recebe todos os ativos (incluindo pausados)
//    para identificar corretamente o medicamento mencionado
const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos);

// 2. Lista exibida ao usuário filtrada por ação
const listaPraExibir = acao === 'reativar'
    ? medicamentosPausados
    : medicamentosComSchedule;
```

**Substituições no código:**

- `classificarIntencao(message, medicationsAtivos)` → **inalterado** — continua recebendo `medicationsAtivos`
- Em `identif_medicamento` para ações de horário, pausar, encerrar: usar `medicamentosComSchedule` na lista exibida ao usuário
- Em `identif_medicamento` para `reativar`: usar `medicamentosPausados` na lista exibida ao usuário
- Em `continuarComAcao` na montagem da lista de medicamentos: usar `medicamentosComSchedule`
- `encontrarMedicamento` dentro do handler: continuar buscando em `medicationsAtivos` — o usuário pode mencionar um medicamento pausado e o sistema precisa identificá-lo para responder corretamente

---

## BUG-049 — Nome interno de ação exposto ao usuário ("remover_horario")

### Causa raiz confirmada

**Evidência direta no agent_log (13:51:38):**
```
agent_response: "Qual medicamento você quer remover_horario?\n\n• Dipirona\n• Ômega 3\n• Nimesulida"
```

**Código confirmado em `continuarComAcao`:**
```javascript
return `Qual medicamento você quer ${acao === 'alterar_horario' ? 'alterar o horário' : acao}?\n\n${lista}`;
```

O ternário só traduz `alterar_horario`. As novas ações `remover_horario`, `adicionar_horario`, `redefinir_horarios` — e até `pausar`, `reativar`, `encerrar` — caem no fallback `acao` bruto.

### Solução

Substituir o ternário por um mapa completo de ação → texto natural:

```javascript
const acaoTexto = {
    'alterar_horario':    'alterar o horário de',
    'remover_horario':    'remover um horário de',
    'adicionar_horario':  'adicionar um horário para',
    'redefinir_horarios': 'redefinir os horários de',
    'pausar':             'pausar',
    'reativar':           'reativar',
    'encerrar':           'encerrar o tratamento de'
};

return `Qual medicamento você quer ${acaoTexto[acao] || 'configurar'}?\n\n${lista}`;
```

O fallback `'configurar'` garante que, mesmo se uma ação inesperada aparecer, o texto exibido seja neutro e legível.

---

## BUG-050 — `encontrarMedicamento` não normaliza acentos

### Causa raiz confirmada

**Evidência nos logs (linhas 110–149):**
- "Omega" → não encontrou "Ômega 3" ❌
- "Omega 3" → não encontrou "Ômega 3" ❌
- "Ômega 3" (com acento) → encontrou ✅

**Código confirmado:**
```javascript
function encontrarMedicamento(texto, medications) {
    const t = texto.toLowerCase();
    return medications.find(m => m.nome.toLowerCase() === t)
        || medications.find(m =>
            t.includes(m.nome.toLowerCase()) ||
            m.nome.toLowerCase().includes(t)
        )
        || null;
}
```

`toLowerCase()` não remove diacríticos. "omega" !== "ômega" após `toLowerCase()`. O `includes` falha porque os caracteres são diferentes mesmo com letras minúsculas.

### Solução

Adicionar normalização NFD antes das comparações:

```javascript
function normalizar(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ''); // remove diacríticos
}

function encontrarMedicamento(texto, medications) {
    const t = normalizar(texto);
    return medications.find(m => normalizar(m.nome) === t)
        || medications.find(m =>
            t.includes(normalizar(m.nome)) ||
            normalizar(m.nome).includes(t)
        )
        || null;
}
```

Com isso:
- `normalizar("Ômega 3")` → `"omega 3"`
- `normalizar("Omega 3")` → `"omega 3"` → match ✅
- `normalizar("Omega")` → `"omega"` → `"omega 3".includes("omega")` → match ✅
- `normalizar("dipirona")` === `normalizar("Dipirona")` → match ✅

**Verificar se `normalizarHorario` usa `encontrarMedicamento` internamente** — se sim, o benefício se propaga automaticamente. Se não, não há impacto em outras funções.

---

## Resumo das alterações em `configuracao.js`

| O que muda | Onde | Tipo |
|---|---|---|
| Remover bloco `if (etapa === 'identif_acao')` inteiro | handler principal | remoção |
| Bloco `ambiguo` salva `identif_intencao` em vez de `identif_acao` | `identif_intencao` | substituição |
| `identif_intencao` usa medicamento do contexto quando disponível | `identif_intencao` | adição |
| `remover_horario` com 1 schedule salva `identif_intencao` em vez de `identif_acao` | `continuarComAcao` | substituição |
| Reescrever prompt do `classificarIntencao` | topo do arquivo | substituição |
| Adicionar função `normalizar()` | topo do arquivo | adição |
| Substituir `encontrarMedicamento` com normalização NFD | topo do arquivo | substituição |
| Separar `medicamentosComSchedule` e `medicamentosPausados` | `handleConfiguracao` | adição |
| Usar `medicamentosComSchedule` em `classificarIntencao` e listas de ação | múltiplos pontos | substituição |
| Substituir ternário por mapa `acaoTexto` | `continuarComAcao` | substituição |

---

## Validação esperada após implementação

**BUG-047:**
1. "Quero alterar horário do Dipirona" → `classificarIntencao` retorna `alterar_horario` ✅
2. "Mudar horário" → `alterar_horario` ✅
3. "Quero excluir um horário" → `remover_horario` ✅
4. "Quero parar" (sem clareza) → `ambiguo` → menu pausar/encerrar → usuário diz "quero alterar horário" → reclassificado como `alterar_horario` ✅ (não fica preso)
5. Medicamento com 1 schedule, usuário quer remover → menu pausar/encerrar → usuário diz outra coisa → reclassificado ✅

**BUG-048:**
1. Nimesulida pausada não aparece na lista de opções para `remover_horario` ✅
2. Nimesulida pausada aparece corretamente quando ação é `reativar` ✅

**BUG-049:**
1. "Quero excluir um horário" → "Qual medicamento você quer **remover um horário de**?" ✅

**BUG-050:**
1. "Omega" → encontra "Ômega 3" ✅
2. "Omega 3" → encontra "Ômega 3" ✅
3. "dipirona" → encontra "Dipirona" ✅

---

**Comando para Claude Code:**  
`Leia o briefings/BRIEFING_BUG047_050.md e implemente.`