# BRIEFING: BUG-041 — Cálculo de horários por frequência (loop de cadastro / horários perdidos)

**Data:** 19/06/2026  
**Sessão:** v9  
**Prioridade:** CRÍTICA — usuário fica preso em loop e não consegue cadastrar medicamento com frequência regular  
**Arquivos afetados:** `src/agentes/cadastro.js`  
**Sem alteração de banco de dados**

---

## Contexto e causa raiz — confirmada por código E dados (LOGS-001)

### Sintoma
Usuário tentou cadastrar Dipirona "5 dias, de 8 em 8 horas" (3x ao dia). Ficou preso **mais de 8 minutos** em loop entre `cad_horarios → cad_estoque → cad_confirmacao`, sem nunca conseguir salvar. O cadastro nunca completou.

### Evidência (rastreamento do campo `horarios` no `contexto_conversa`)
| Momento | Usuário disse | Nami entendeu | `horarios` salvo |
|---|---|---|---|
| 21:40 | "5 dias de 8 em 8hrs" | "3x ao dia! Qual horário da primeira?" | `[]` |
| 21:40 | "Agora as 7hrs" | "registrar 07:00" | `[]` |
| 21:41 | (resumo) | "Horários: 07:00" | `["07:00"]` (só 1!) |
| 21:42 | "As 19" | "Dipirona às 19:00" | `[]` (apagou) |
| 21:46 | "são 3x ao dia" (4ª vez) | "1x ao dia, registrei 19:00" | `["19:00"]` |

### As 4 falhas encadeadas

**Falha 1 — Nunca calcula múltiplos horários a partir da frequência.** Mesmo entendendo "3x ao dia / 8 em 8h" e recebendo o horário de início, o agente sempre salva apenas 1 horário. Nunca calcula `19:00 → 03:00 → 11:00`.

**Falha 2 — A frequência não existe no contexto.** O `contexto_conversa` tem `horarios[]` mas não tem nenhum campo de frequência (`doses_por_dia` / `intervalo_horas`). Quando o usuário fala "8 em 8h", o agente não tem onde persistir essa regra. Ela se perde.

**Falha 3 — `horarios` zera a cada transição de etapa.** Toda vez que sai de `cad_horarios`, o array volta a `[]`. O horário some no passo seguinte.

**Falha 4 — `dosesPerDia` é inferido de `horarios.length`.** No código de `cad_estoque`: `const dosesPerDia = horarios.length || 1`. Como só há 1 horário salvo, o sistema deduz "1x ao dia" — mesmo que a frequência real seja 3x. Isso alimenta a regressão da Falha 2.

### Conclusão da causa raiz
O cálculo de horário está sendo delegado ao LLM, que erra aritmética de horário de forma consistente. E não há um campo de frequência persistente no contexto. **A solução é tornar o cálculo determinístico (no código) e adicionar a frequência como dado de primeira classe.**

---

## Solução: Opção A híbrida (cálculo determinístico no código)

- **Intervalo regular** (8 em 8h, 12 em 12h, 3x ao dia): o LLM extrai os parâmetros, o **código calcula** os horários.
- **Horários explícitos** (de manhã e à noite, às 8 e às 20): salva direto como hoje.

---

## Mudança 1 — `src/agentes/cadastro.js`: função de cálculo determinístico

Adicionar esta função auxiliar no topo do arquivo (após os imports):

```javascript
// ============================================================
// CÁLCULO DETERMINÍSTICO DE HORÁRIOS A PARTIR DE FREQUÊNCIA
// ============================================================

/**
 * Calcula os horários de doses a partir de um horário de início e um intervalo.
 * Ex: inicio="19:00", intervaloHoras=8 → ["19:00", "03:00", "11:00"]
 *
 * @param {string} horarioInicio - "HH:MM"
 * @param {number} intervaloHoras - intervalo entre doses em horas (ex: 8 para 8/8h)
 * @returns {string[]} array de horários "HH:MM" ordenados a partir do início
 */
function calcularHorariosPorIntervalo(horarioInicio, intervaloHoras) {
    if (!horarioInicio || !intervaloHoras || intervaloHoras <= 0) return [];

    const dosesPerDia = Math.round(24 / intervaloHoras);
    if (dosesPerDia < 1) return [];

    const [h, m] = horarioInicio.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return [];

    const horarios = [];
    let minutoAtual = h * 60 + m;

    for (let i = 0; i < dosesPerDia; i++) {
        const minutoNormalizado = ((minutoAtual % 1440) + 1440) % 1440;
        const hh = String(Math.floor(minutoNormalizado / 60)).padStart(2, '0');
        const mm = String(minutoNormalizado % 60).padStart(2, '0');
        horarios.push(`${hh}:${mm}`);
        minutoAtual += intervaloHoras * 60;
    }

    return horarios;
}

/**
 * Converte número de doses por dia em intervalo de horas.
 * Ex: 3 doses → 8h; 2 doses → 12h; 4 doses → 6h
 */
function dosesPerDiaParaIntervalo(dosesPerDia) {
    if (!dosesPerDia || dosesPerDia < 1) return null;
    return 24 / dosesPerDia;
}
```

---

## Mudança 2 — `src/agentes/cadastro.js`: novos campos no contexto e novo SAVE

O contexto precisa carregar a frequência de forma persistente. Atualizar o **FORMATO DE RESPOSTA** no prompt (`buildSystemPrompt`).

**Localizar:**
```
  "novoContext": {
    "etapa": "próxima etapa a ser executada",
    "nome": "nome do remédio",
    "forma": "forma farmacêutica",
    "dosagem": "dosagem",
    "tipo_tratamento": "continuo | temporario",
    "tratamento_dias": null,
    "horarios": [],
    "estoque": null
  },
```

**Substituir por:**
```
  "novoContext": {
    "etapa": "próxima etapa a ser executada",
    "nome": "nome do remédio",
    "forma": "forma farmacêutica",
    "dosagem": "dosagem",
    "tipo_tratamento": "continuo | temporario",
    "tratamento_dias": null,
    "doses_por_dia": null,
    "intervalo_horas": null,
    "horario_inicio": null,
    "horarios": [],
    "estoque": null
  },
```

**Importante:** instruir o prompt a SEMPRE propagar os campos já coletados no `novoContext` — nunca retornar campos preenchidos como `null` se já foram coletados. Adicionar ao bloco de REGRAS do prompt:

```
REGRA DE PERSISTÊNCIA DE CONTEXTO (CRÍTICA):
Ao retornar novoContext, SEMPRE inclua TODOS os campos já coletados nas etapas
anteriores com seus valores atuais. NUNCA retorne um campo já preenchido como null.
O contexto recebido ("Contexto coletado até agora") contém o estado atual —
preserve todos os valores e apenas ADICIONE ou ATUALIZE o que mudou nesta etapa.
Exemplo: se horarios já tem ["19:00","03:00","11:00"], mantenha esse valor
em novoContext a menos que o usuário peça explicitamente para mudá-lo.
```

---

## Mudança 3 — `src/agentes/cadastro.js`: reescrever a etapa `cad_horarios` no prompt

**Localizar a seção `cad_horarios` atual** (a que foi alterada no BUG-038) e **substituir por:**

```
cad_horarios:
  Seu objetivo é obter os horários das doses. Há DOIS caminhos:

  CAMINHO 1 — Horários específicos informados → salve diretamente em "horarios":
     "de manhã e à noite" → horarios: ["07:00", "21:00"]
     "às 8 e às 20" → horarios: ["08:00", "20:00"]
     "só de manhã" → horarios: ["07:00"]
     Neste caso, defina doses_por_dia = quantidade de horários, intervalo_horas = null.

  CAMINHO 2 — Frequência regular (intervalo) → você precisa de DOIS dados:
     a) o intervalo ou número de doses por dia
     b) o horário de início

     Quando o usuário informar a frequência ("de 8 em 8 horas", "3 vezes ao dia",
     "12/12h"), extraia e salve no contexto:
       - "de 8 em 8 horas" → intervalo_horas: 8, doses_por_dia: 3
       - "de 12 em 12 horas" → intervalo_horas: 12, doses_por_dia: 2
       - "de 6 em 6 horas" → intervalo_horas: 6, doses_por_dia: 4
       - "3 vezes ao dia" → doses_por_dia: 3, intervalo_horas: 8
       - "2 vezes ao dia" → doses_por_dia: 2, intervalo_horas: 12

     Se você ainda NÃO tem o horário de início, pergunte:
       "Qual o horário da primeira dose do dia?"

     Quando o usuário informar o horário de início, salve em horario_inicio
     (ex: "às 19h" → horario_inicio: "19:00") e mantenha intervalo_horas/doses_por_dia.

  IMPORTANTE: NÃO calcule os horários você mesmo. O sistema fará o cálculo
  automaticamente a partir de intervalo_horas + horario_inicio. Você apenas
  precisa garantir que esses dois campos estejam preenchidos no novoContext
  quando ambos forem conhecidos.

  Quando tiver (horarios preenchido) OU (intervalo_horas + horario_inicio
  preenchidos), avance para cad_estoque.
```

---

## Mudança 4 — `src/agentes/cadastro.js`: aplicar cálculo determinístico no handler

No `handleCadastro`, **após** receber a resposta do Claude e **antes** de salvar o estado, aplicar o cálculo determinístico quando há intervalo + início mas `horarios` ainda não foi calculado.

**Localizar** (no `handleCadastro`, logo após `const novoContext = claudeResponse.novoContext || {};`):

```javascript
    const proximaEtapa = claudeResponse.proximaEtapa || 'cad_nome';
    const novoContext = claudeResponse.novoContext || {};
```

**Adicionar logo depois:**

```javascript
    // BUG-041: cálculo determinístico de horários a partir de frequência + início.
    // Se temos intervalo_horas e horario_inicio mas horarios ainda não foi calculado
    // (ou tem menos itens que doses_por_dia), o código calcula — nunca o LLM.
    if (novoContext.intervalo_horas && novoContext.horario_inicio) {
        const calculados = calcularHorariosPorIntervalo(
            novoContext.horario_inicio,
            novoContext.intervalo_horas
        );
        if (calculados.length > 0) {
            novoContext.horarios = calculados;
            console.log(`🕐 [BUG-041] Horários calculados: ${calculados.join(', ')} (início ${novoContext.horario_inicio}, intervalo ${novoContext.intervalo_horas}h)`);
        }
    }
```

---

## Mudança 5 — `src/agentes/cadastro.js`: corrigir `dosesPerDia` no cálculo de estoque

A inferência `dosesPerDia = horarios.length` agora é correta, **desde que** `horarios` tenha sido calculado corretamente (o que as mudanças acima garantem). Para robustez, usar `doses_por_dia` do contexto se disponível.

**Localizar:**
```javascript
        const horarios = context?.horarios || [];
        const dosesPerDia = horarios.length || 1;
```

**Substituir por:**
```javascript
        const horarios = context?.horarios || [];
        const dosesPerDia = context?.doses_por_dia || horarios.length || 1;
```

---

## Mudança 6 — Saída de emergência do loop de cadastro

Para evitar que o usuário fique preso, adicionar ao prompt (na seção de REGRAS gerais) uma rota de escape:

```
REGRA ANTI-LOOP (CRÍTICA):
Se o usuário demonstrar frustração, confusão repetida, ou se a mesma etapa
se repetir várias vezes sem progresso, ofereça uma saída clara:
"Desculpe a confusão! 😊 Vamos com calma. Me diga em uma frase: o nome do
remédio, quantas vezes por dia e a partir de que horário você toma. Ex:
'Dipirona, 3 vezes ao dia, começando às 7h'. Que eu organizo tudo pra você!"
Isso permite recomeçar a coleta de horários de forma limpa.
```

---

## Verificação pós-implementação

**Teste 1 — frequência regular (o caso que quebrou):**
1. Cadastrar: "Dipirona", "comprimido", "1g", "5 dias de 8 em 8h"
2. Nami pergunta horário de início
3. Responder: "às 19h"
4. **Esperado:** sistema calcula e salva `["19:00", "03:00", "11:00"]`
5. **Log esperado:** `🕐 [BUG-041] Horários calculados: 19:00, 03:00, 11:00`
6. Resumo deve mostrar os 3 horários

**Teste 2 — horários explícitos (não deve quebrar):**
1. Cadastrar medicamento com "de manhã e à noite"
2. **Esperado:** salva `["07:00", "21:00"]` direto, sem cálculo de intervalo

**Teste 3 — correção de frequência:**
1. Durante cadastro, informar "1x ao dia" e depois corrigir "não, são 3x ao dia, de 8 em 8h, começando 7h"
2. **Esperado:** sistema recalcula para `["07:00", "15:00", "23:00"]` e persiste

**Teste 4 — persistência de contexto:**
1. Percorrer o fluxo e verificar no `agent_logs` (`contexto_conversa`) que `doses_por_dia`, `intervalo_horas` e `horarios` não se perdem entre etapas

---

## Notas

- O cálculo de horário sai do LLM e passa para código determinístico — cálculo de horário é dado de saúde e não deve depender de inferência do modelo.
- A REGRA DE PERSISTÊNCIA DE CONTEXTO (Mudança 2) corrige a Falha 3 (perda de estado entre etapas) de forma transversal — beneficia todo o fluxo de cadastro, não só horários.
- Esta correção supera e completa o BUG-038, que tratou apenas parte do problema (frequência sem horário) sem resolver a estrutura de dados.
- Relacionado à fragilidade já documentada no CONTEXT.md: "Uncontracted free-form JSONB conversation state". Esta correção dá contrato aos campos de frequência.