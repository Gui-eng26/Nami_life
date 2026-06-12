# Briefing — MH-017 + MH-018: Lógica de Estoque em Dias

Este documento é um briefing de implementação para o Claude Code.
Leia o CONTEXT.md antes de começar.
Antes de qualquer alteração, leia os arquivos relevantes mencionados em cada melhoria.

---

## Contexto

O sistema atual usa `estoque_minimo` (fixo em 7 unidades) para alertar sobre
estoque baixo. Essa lógica é inadequada porque ignora a frequência de uso.
Exemplo: 7 comprimidos para quem toma 3x ao dia = apenas 2 dias de estoque.

A nova lógica usa **dias restantes** calculados em tempo real:

```
dias_restantes = floor(estoque_atual ÷ doses_por_dia)
doses_por_dia  = número de schedules ativos do medicamento
threshold      = 5 dias
```

---

## MH-017 — Alerta de estoque baixo junto com o primeiro lembrete do dia

### Arquivos a modificar
```
src/scheduler.js
src/database.js
src/agentes/principal.js   (para tratar resposta de novo estoque)
src/prompts.js             (para instruir Claude sobre atualização de estoque)
```

### Lógica do alerta

O alerta deve disparar **uma vez por dia**, junto com o **primeiro lembrete
do dia** do medicamento com estoque baixo.

"Primeiro lembrete do dia" = o scheduler está enviando um lembrete para
aquele medicamento E ainda não enviou alerta de estoque hoje para ele.

Para controlar isso sem mudar o schema do banco, usar uma verificação simples:
checar se já existe um `dose_log` com `reminder_sent = true` para aquele
medicamento com `reminder_sent_at` anterior ao lembrete atual no mesmo dia.
Se não existe, é o primeiro lembrete do dia → verificar estoque.

### Cálculo de dias restantes em scheduler.js

Dentro de `sendReminder`, após enviar o lembrete, adicionar verificação:

```javascript
async function verificarEstoqueBaixo(reminder) {
    // doses_por_dia = quantidade de schedules ativos do medicamento
    // Buscar do banco via nova função getMedicamentoDosesPerDia
    const dosesPerDia = await getMedicamentoDosesPerDia(reminder.medication_id);
    if (dosesPerDia === 0) return;

    const diasRestantes = Math.floor(reminder.estoque_atual / dosesPerDia);

    if (diasRestantes <= 5) {
        await sendEstoqueBaixoAlert(reminder, diasRestantes, dosesPerDia);
    }
}
```

Chamar `verificarEstoqueBaixo` em vez de `sendLowStockAlert` atual.
Remover a lógica atual `if (reminder.estoque_atual <= reminder.estoque_minimo)`.

### Mensagem de alerta de estoque baixo

```javascript
function buildEstoqueBaixoMessage(firstName, reminder, diasRestantes, dosesPerDia) {
    const urgencia = diasRestantes === 0
        ? 'seu estoque acabou'
        : diasRestantes === 1
            ? 'seu estoque acaba *amanhã*'
            : `seu estoque acaba em *${diasRestantes} dias*`;

    return (
        `⚠️ Atenção, ${firstName}!\n\n` +
        `Você tem *${reminder.estoque_atual}* ${reminder.estoque_atual === 1 ? 'unidade' : 'unidades'} ` +
        `de *${reminder.med_nome}* — ${urgencia}.\n\n` +
        `Quando fizer a recompra, me avise a nova quantidade! ` +
        `É só responder algo como: *"Comprei 30 comprimidos de ${reminder.med_nome}"* 💊`
    );
}
```

### Nova função no database.js

```javascript
// Busca o número de schedules ativos de um medicamento (= doses por dia)
export async function getMedicamentoDosesPerDia(medicationId) {
    const { data } = await supabase
        .from('schedules')
        .select('id')
        .eq('medication_id', medicationId)
        .eq('ativo', true);
    return (data || []).length;
}
```

### Tratar resposta do usuário sobre novo estoque

Quando o usuário responder ao alerta com a nova quantidade, o agente_principal
deve reconhecer e atualizar o estoque.

Em `prompts.js`, adicionar instrução no NAMI_SYSTEM_PROMPT:

```
ATUALIZAÇÃO DE ESTOQUE:
Se o usuário informar que comprou mais unidades de um medicamento
(ex: "comprei 30 comprimidos de Losartana", "renovei o estoque",
"tenho 60 comprimidos agora"), identifique o medicamento e a quantidade
e dispare a ação UPDATE_STOCK.

{ "type": "UPDATE_STOCK", "medicationId": "", "quantidade": 0 }
```

Em `agentes/principal.js`, adicionar case em `processAction`:

```javascript
case 'UPDATE_STOCK':
    await updateMedicationStock(action.medicationId, action.quantidade);
    return null;
```

Importar `updateMedicationStock` do database.js se ainda não estiver importado.

---

## MH-018 — Alerta de estoque insuficiente no momento do cadastro

### Arquivo a modificar
```
src/agentes/cadastro.js
```

### Lógica

Após o usuário informar a quantidade em estoque (etapa `cad_estoque`),
antes de avançar para a confirmação (`cad_confirmacao`), o agente deve
calcular os dias restantes com base nas informações coletadas até aqui:

```
dias_restantes = floor(estoque_informado ÷ quantidade_horarios)
quantidade_horarios = context.horarios.length
```

Se `dias_restantes <= 5`, adicionar aviso no contexto para que o prompt
de confirmação mencione o estoque insuficiente.

### Implementação

No system prompt do agente_cadastro, adicionar instrução no bloco
`cad_estoque`:

```
SE etapa = 'cad_estoque' E context.alerta_estoque_baixo existe:
  Após registrar a quantidade informada, inclua um aviso natural antes
  de avançar para a confirmação.

  Exemplo (0 dias):
  "Entendi! Só um aviso: com {estoque} comprimido(s) e {doses}x ao dia,
   você já está sem estoque suficiente para hoje mesmo. Quer cadastrar
   assim mesmo e comprar mais em breve, ou prefere registrar a quantidade
   depois da compra?"

  Exemplo (2 dias):
  "Anotado! Só um aviso: com {estoque} comprimido(s) e {doses}x ao dia,
   seu estoque dura apenas {dias} dias. Não se esqueça de fazer a recompra
   em breve! Vou te lembrar quando estiver acabando. 💊"

  Se dias_restantes > 5: seguir normalmente para confirmação sem alerta.
```

No código do `cadastro.js`, na transição da etapa `cad_estoque` para
`cad_confirmacao`, calcular e adicionar ao contexto:

```javascript
// Quando etapa = 'cad_estoque' e o usuário informa a quantidade
const estoque = parseInt(message) || 0;
const horarios = context.horarios || [];
const dosesPerDia = horarios.length || 1;
const diasRestantes = Math.floor(estoque / dosesPerDia);

updatedContext = {
    ...context,
    etapa: 'cad_confirmacao',
    estoque,
    alerta_estoque_baixo: diasRestantes <= 5 ? {
        dias_restantes: diasRestantes,
        estoque,
        doses_por_dia: dosesPerDia
    } : null
};
```

---

## Remoção do campo estoque_minimo da lógica de alerta

O campo `estoque_minimo` no banco NÃO deve ser removido (pode ser útil no
futuro para casos especiais), mas deve ser ignorado na lógica de alerta.
A lógica de dias restantes substitui completamente a verificação de
`estoque_atual <= estoque_minimo` no scheduler.

---

## Ordem de implementação

1. Ler `src/database.js` → adicionar `getMedicamentoDosesPerDia`
2. Ler `src/scheduler.js` → substituir `sendLowStockAlert` por `verificarEstoqueBaixo`
3. Ler `src/prompts.js` → adicionar instrução UPDATE_STOCK
4. Ler `src/agentes/principal.js` → adicionar case UPDATE_STOCK em processAction
5. Ler `src/agentes/cadastro.js` → adicionar cálculo e alerta na etapa cad_estoque
6. Mostrar diff de cada arquivo antes de salvar

---

## Critérios de sucesso

- Medicamento com 1 comprimido e 3x ao dia → alerta no primeiro lembrete do dia
- Medicamento com 30 comprimidos e 1x ao dia → sem alerta (30 dias restantes)
- Medicamento com 10 comprimidos e 2x ao dia → alerta (5 dias restantes, no threshold)
- Usuário responde "comprei 30 comprimidos" → estoque atualizado no banco
- Cadastro de 1 comprimido para 3x ao dia → aviso antes da confirmação
- Cadastro de 30 comprimidos para 1x ao dia → fluxo normal sem aviso
- Alerta não se repete mais de uma vez por dia por medicamento
- Nenhuma regressão no fluxo existente de lembretes