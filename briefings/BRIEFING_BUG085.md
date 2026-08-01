# BRIEFING — BUG-085: Reconhecimento de horário na seleção de lembrete — dois defeitos relacionados

**Sessão:** 28 (continuação)
**Arquivo alterado:** `src/agentes/configuracao.js` (único arquivo)
**Prioridade:** alta (Problema B: confirmação com destino errado, silenciosa) / média (Problema A: falha de reconhecimento)
**Relacionado a:** BUG-083 (mesma área — seleção de horário em `alterar_horario`), descoberto durante a validação manual do BUG-083

---

## 1. Contexto e causa raiz (confirmada por evidência)

Durante a validação manual do BUG-083, dois problemas apareceram na etapa de seleção de horário (`identif_schedule`), quando o medicamento tem 2+ lembretes ativos.

### Problema A — `normalizarHorario` não reconhece número solto numa frase nem número por extenso

```
"Mudar das 11 para as 10"      → não reconhece "11" como seleção (repete a lista)
"Mudar das onze para as dez"   → não reconhece "onze" de jeito nenhum
```

`normalizarHorario` (usada em `identif_schedule`, `identif_schedule_remocao`, `continuarComAcao`) só reconhece três formatos: `HH:MM`/`HHhMM` explícito, a mensagem sendo *só* o número, ou número + período do dia. Números soltos dentro de uma frase sem esses marcadores, e números por extenso, não batem em nenhuma camada. Isso é inconsistente com `interpretarHorarioLivre` (usada pro destino em `obter_horario`), que tem mais camadas de reconhecimento, mas **também não entende número por extenso** — a razão de "dez"/"onze" parecerem funcionar às vezes é que, quando a mensagem escala pro classificador geral (`classificarIntencao`, que usa IA), o destino é entendido semanticamente ali — só a seleção de horário (`normalizarHorario`) nunca passa por IA.

### Problema B — mais grave: `novoHorario` de uma tentativa fracassada é aplicado silenciosamente na tentativa seguinte

Confirmado em produção (`agent_logs`, 01/08/2026, 17:19-17:20 BRT):

```
17:19:21 — "Mudar das dez para as onze"
         → identif_schedule não reconhece "dez" → escala → classificarIntencao (IA)
           entende novoHorario='11:00' (de "onze"), mas não reconhece o schedule
           de origem → volta pra identif_schedule, carregando novoHorario='11:00'
           no contexto, silenciosamente → repete "Qual desses você quer alterar?"
17:19:47 — "Mudar das 10:00 para as nove"
         → identif_schedule reconhece "10:00" → verifica context.novoHorario →
           JÁ ESTÁ PREENCHIDO com '11:00' (da tentativa anterior) → pula a
           pergunta de destino e confirma direto:
           "Só confirmar: vou mudar o lembrete das 10:00 do Cataflam para 11:00."
```

O destino confirmado (**11:00**, "onze") não corresponde ao que a última mensagem disse (**09:00**, "nove"). Guilherme respondeu "Não" e evitou a gravação errada, mas a mensagem de confirmação já estava incorreta.

**Causa raiz:** `identif_schedule` nunca reextrai `novoHorario` da mensagem atual — só reaproveita o que já estava em `context.novoHorario`, vindo de uma classificação anterior (possivelmente de uma tentativa diferente, com um destino diferente). Isso só é seguro quando origem e destino vêm da MESMA mensagem — o que já é garantido em `continuarComAcao` (que vai direto pra confirmação sem passar por `identif_schedule`). Quando `identif_schedule` é alcançado, é justamente porque a origem NÃO foi resolvida na mensagem que gerou aquele `novoHorario` — ou seja, carregar esse valor adiante nunca é seguro.

---

## 2. As correções

Os dois problemas se resolvem com o mesmo princípio: **`identif_schedule` nunca deve reaproveitar um destino vindo de fora da mensagem atual — mas DEVE tentar extrair um destino da própria mensagem atual antes de perguntar de novo**, reaproveitando a mesma proteção do BUG-083 (só confia no destino se houver dois números distintos na mensagem).

### 2.1 — Em `continuarComAcao`, no ramo `if (!scheduleEspecifico)` (dentro de `alterar_horario`)

Localizar:
```js
if (!scheduleEspecifico) {
    const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
    const qtd = schedulesAtivos.length;
    const descricaoQtd = qtd === 1 ? 'um horário' :
                         qtd === 2 ? 'dois horários' :
                         `${qtd} horários`;
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'identif_schedule', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario }
    });
    return `O *${med.nome}* tem lembretes em ${descricaoQtd}:\n\n${lista}\n\nQual desses você quer alterar? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
}
```

Substituir por (única mudança: remover `novoHorario` do contexto salvo — `identif_schedule` vai extrair o dele próprio, fresco, da seção 2.2):
```js
if (!scheduleEspecifico) {
    const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
    const qtd = schedulesAtivos.length;
    const descricaoQtd = qtd === 1 ? 'um horário' :
                         qtd === 2 ? 'dois horários' :
                         `${qtd} horários`;
    // BUG-085: não carregamos novoHorario adiante — identif_schedule extrai o
    // seu próprio destino, sempre fresco, da mensagem que resolve a seleção.
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'identif_schedule', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
    });
    return `O *${med.nome}* tem lembretes em ${descricaoQtd}:\n\n${lista}\n\nQual desses você quer alterar? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
}
```

### 2.2 — Na etapa `identif_schedule`: extrair o destino sempre fresco da mensagem atual

Localizar:
```js
if (!context.novoHorario) {
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { ...context, etapa: 'obter_horario', scheduleId: schedule.id, horarioAtual: schedule.horario }
    });
    return `Certo! Vou alterar o lembrete das *${schedule.horario.substring(0,5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
}

const newCtx = { ...context, etapa: 'confirm_acao', scheduleId: schedule.id, horarioAtual: schedule.horario };
await saveConversationState(user.id, { state: 'configurando', context: newCtx });
return buildConfirmacaoMessage(firstName, newCtx);
```

Substituir por:
```js
// BUG-085: extrai o destino sempre da MESMA mensagem que resolveu a seleção
// — nunca reaproveita context.novoHorario de uma tentativa anterior (poderia
// não corresponder a esta mensagem). Só confia no destino se houver dois
// números distintos na mensagem, mesma proteção do BUG-083 contra um único
// número servir pros dois papéis (seleção e destino) ao mesmo tempo.
const mensagemConvertida = converterNumerosPorExtenso(message);
const temDoisHorarios = [...mensagemConvertida.matchAll(/\b\d{1,2}\b/g)].length >= 2;
const novoHorarioAtual = temDoisHorarios ? interpretarHorarioLivre(message) : null;

if (!novoHorarioAtual) {
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { ...context, etapa: 'obter_horario', scheduleId: schedule.id, horarioAtual: schedule.horario }
    });
    return `Certo! Vou alterar o lembrete das *${schedule.horario.substring(0,5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
}

const newCtx = { ...context, etapa: 'confirm_acao', scheduleId: schedule.id, horarioAtual: schedule.horario, novoHorario: novoHorarioAtual };
await saveConversationState(user.id, { state: 'configurando', context: newCtx });
return buildConfirmacaoMessage(firstName, newCtx);
```

Isso preserva o atalho de UX (mensagem única com seleção + destino resolve numa tacada só) **e** elimina o risco — porque o destino nunca mais vem de outro lugar que não seja a mensagem que está sendo processada agora.

### 2.3 — Problema A: números por extenso e soltos numa frase (nas duas funções)

**Novo helper, adicionar logo antes de `interpretarHorarioLivre` (linha ~136):**

```js
// Números por extenso mais comuns em pt-BR para horários (0-20). "vinte e X"
// tratado à parte pra não quebrar em "vinte" + "e" + "x" separadamente.
const NUMERO_POR_EXTENSO = {
    'zero': 0, 'uma': 1, 'um': 1, 'duas': 2, 'dois': 2, 'três': 3, 'tres': 3,
    'quatro': 4, 'cinco': 5, 'seis': 6, 'sete': 7, 'oito': 8, 'nove': 9,
    'dez': 10, 'onze': 11, 'doze': 12, 'treze': 13, 'catorze': 14, 'quatorze': 14,
    'quinze': 15, 'dezesseis': 16, 'dezessete': 17, 'dezoito': 18, 'dezenove': 19,
    'vinte': 20
};
const VINTE_E_ALGO = { 'um': 21, 'uma': 21, 'dois': 22, 'duas': 22, 'três': 23, 'tres': 23 };

// Converte números por extenso presentes na mensagem para dígitos, preservando
// o resto do texto — as camadas de regex existentes (dígito, "h", período do
// dia) passam a funcionar sem duplicar lógica nenhuma.
function converterNumerosPorExtenso(mensagem) {
    let resultado = mensagem.replace(/vinte\s+e\s+(um|uma|dois|duas|tr[êe]s)/gi,
        (_, palavra) => String(VINTE_E_ALGO[palavra.toLowerCase()]));
    for (const [palavra, numero] of Object.entries(NUMERO_POR_EXTENSO)) {
        resultado = resultado.replace(new RegExp(`\\b${palavra}\\b`, 'gi'), String(numero));
    }
    return resultado;
}
```

**No início de `interpretarHorarioLivre`, adicionar a conversão, e uma camada nova no final (linha ~136-181):**

Localizar:
```js
function interpretarHorarioLivre(message) {
    const msg = message.toLowerCase().trim();
```
Substituir por:
```js
function interpretarHorarioLivre(message) {
    message = converterNumerosPorExtenso(message);
    const msg = message.toLowerCase().trim();
```

Localizar o fim da função:
```js
    // 5. Expressões nomeadas
    if (/meio.?dia/i.test(msg)) return '12:00';
    if (/meia.?noite/i.test(msg)) return '00:00';

    return null;
}
```

Substituir por (nova camada 6 antes do `return null` — pega o **último** número solto, mesma convenção de destino das camadas 1 e 2 acima; essencial para a seção 2.2 conseguir extrair o destino de mensagens como "mudar das onze para as dez"):
```js
    // 5. Expressões nomeadas
    if (/meio.?dia/i.test(msg)) return '12:00';
    if (/meia.?noite/i.test(msg)) return '00:00';

    // 6. BUG-085: número solto embutido numa frase, sem ":"/"h"/período do dia
    // — pega o último (mesma convenção de destino das camadas anteriores).
    const numerosSoltos = [...msg.matchAll(/\b(\d{1,2})\b/g)];
    if (numerosSoltos.length > 0) {
        const hora = parseInt(numerosSoltos[numerosSoltos.length - 1][1]);
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    return null;
}
```

**No início de `normalizarHorario`, mesma conversão, e uma camada nova no final (antes do `return null` implícito):**

Localizar:
```js
function normalizarHorario(message, schedulesDisponiveis) {
    const msg = message.toLowerCase().trim();
```
Substituir por:
```js
function normalizarHorario(message, schedulesDisponiveis) {
    message = converterNumerosPorExtenso(message);
    const msg = message.toLowerCase().trim();
```

Localizar o fim da função (depois do loop de períodos, camada 3):
```js
    for (const { pattern, periodo } of periodos) {
        const match = msg.match(pattern);
        if (match) {
            let hora = parseInt(match[1]);
            if (periodo === 'tarde_noite' && hora < 12) hora += 12;
            const horaStr = String(hora).padStart(2, '0');
            const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(horaStr + ':'));
            if (schedule) return schedule.horario.substring(0, 5);
        }
    }

    return null;
}
```

Substituir por (nova camada 4 antes do `return null`):
```js
    for (const { pattern, periodo } of periodos) {
        const match = msg.match(pattern);
        if (match) {
            let hora = parseInt(match[1]);
            if (periodo === 'tarde_noite' && hora < 12) hora += 12;
            const horaStr = String(hora).padStart(2, '0');
            const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(horaStr + ':'));
            if (schedule) return schedule.horario.substring(0, 5);
        }
    }

    // 4. BUG-085: número solto embutido numa frase (ex: "mudar das 11 para as
    // 10"), sem ":"/"h" nem período do dia. Pega o primeiro número (mesma
    // convenção de origem da camada 1), só como último recurso.
    const numerosSoltos = [...msg.matchAll(/\b(\d{1,2})\b/g)];
    if (numerosSoltos.length > 0) {
        const horaSolta = numerosSoltos[0][1].padStart(2, '0');
        const scheduleSolto = schedulesDisponiveis.find(s => s.horario.startsWith(horaSolta + ':'));
        if (scheduleSolto) return scheduleSolto.horario.substring(0, 5);
    }

    return null;
}
```

---

## ⚠️ 3. Trade-off a registrar conscientemente (não é hipotético, é uma troca real)

As camadas novas de número solto (em `normalizarHorario` E em `interpretarHorarioLivre`) são a parte menos precisa desta correção. Elas rodam logo depois de perguntar "qual desses você quer alterar?" — se uma mensagem **não relacionada** que por coincidência contém um número igual a um dos horários chegar nesse momento (ex: "Tomei o remédio das 11" — 11 coincide com um horário ativo), ela pode ser lida como seleção em vez de escalar para o conteúdo real. A proteção de "dois números distintos" (seção 2.2) reduz esse risco para o campo de destino especificamente, mas não elimina o risco na seleção em si.

**Por que aceito esse risco:** o resultado de um falso positivo aqui é só uma **pergunta de confirmação estranha** ("Vou alterar o lembrete das 11h... Para qual horário?") — nunca uma gravação sem confirmação explícita depois. É diferente do Problema B (que confirmava um destino errado): aqui, na pior hipótese, o usuário só precisa dizer "Não" ou reformular. Se isso se mostrar incômodo na prática (muitos falsos positivos reais), o ajuste futuro seria condicionar a camada 4 à ausência de verbos de dose (ex: "tomei", "tomo") na mensagem — mas não vou adicionar essa exclusão agora sem evidência de que é necessária (principio de não fazer regra de exclusão sem dado real).

---

## 4. Verificação antes de considerar concluído

```bash
node --check src/agentes/configuracao.js
```

Commit (`fix: reconhecimento de horário por extenso/embutido + remove novoHorario obsoleto (BUG-085)`), push.

---

## 5. Registro no backlog

- **BUG-085**
  - Título: "Seleção de horário não reconhece número por extenso/embutido em frase, e podia confirmar destino obsoleto de tentativa anterior"
  - Status inicial: `em_validacao`
  - Prioridade: alta
  - Relacionado a: BUG-083
  - `causa_raiz`: resumo das seções 1

---

## 6. Casos de teste — rodar direto no WhatsApp

Precisa de um medicamento com **2 horários ativos** conhecidos (ex: 11:00 e 19:00 — ajuste os exemplos abaixo para os horários reais do medicamento de teste).

**1 — Mensagem única com dois números por extenso resolve direto (Problema A completo)**
- `Alterar horário do [remédio]` → lista os 2 horários
- `Mudar das onze para as nove` (assumindo 11:00 real entre os horários; "nove" é só destino, não precisa existir como horário)
- **Esperado (novo):** resolve na mesma mensagem, sem perguntar de novo: *"Só confirmar: vou mudar o lembrete das 11:00 do [remédio] para 09:00. Confirmar?"*

**2 — Mensagem única com números soltos, sem extenso**
- `Alterar horário do [remédio]` → `Mudar das 11 para as 9` (sem `:00`, sem "h")
- **Esperado:** mesmo resultado do teste 1 — resolve direto.

**3 — Só a seleção, sem destino na mesma mensagem — ainda pergunta separadamente**
- `Alterar horário do [remédio]` → responda só `onze` (sem "para X")
- **Esperado:** *"Certo! Vou alterar o lembrete das 11:00... Para qual horário?"* — não confia em nenhum destino de fora desta mensagem.
- Responda a pergunta separadamente (ex: `10`) → confirma corretamente.

**4 — Anti-obsolescência (o caso crítico original): tentativa que falha genuinamente não deixa destino vazar pra próxima**
- `Alterar horário do [remédio]` → `Mudar das oito para as dez` (assumindo que **08:00 não é** um dos horários reais do remédio — deve falhar a seleção genuinamente, não por causa de reconhecimento)
- **Esperado:** não reconhece nenhum horário existente, escala ou repete a lista — mas sem travar nenhum destino.
- Depois: `Mudar das onze para as nove` (11:00 real, destino diferente do da tentativa anterior)
- **Esperado (crítico):** o destino confirmado deve ser **09:00** (nove) — nunca 10:00 (dez), que foi a tentativa anterior. Esse é o teste que reproduz exatamente o cenário observado em produção em 01/08 (17:19-17:20 BRT).

**5 — Não-regressão: formato explícito continua funcionando**
- `Alterar horário do [remédio]` → `Mudar das 11:00 para as 10:00`
- **Esperado:** sem mudança — confirma direto, corretamente.

**6 — Observação de risco (não é falha, é para registrar o comportamento)**
- Durante a pergunta "qual desses você quer alterar?", envie algo genuinamente não relacionado mas que contenha um número batendo com um horário ativo, ex: `Tomei às 11` (se houver horário 11:00 ativo)
- **Anotar o que acontece:** se for tratado como seleção em vez de escalar, é o trade-off da seção 3 se manifestando — registrar como observação, não bloquear o fechamento por causa disso, a menos que aconteça com frequência incômoda.

Depois de cada teste, conferir em `agent_logs` que o destino confirmado bate exatamente com a última mensagem enviada, nunca com uma tentativa anterior.