# BRIEFING — BUG-033
## Cálculo de adesão usa total de dias do período, ignorando quando o medicamento foi cadastrado

**Data:** 15/06/2026  
**Origem:** Análise do resumo semanal disparado em 15/06  
**Escopo:** `src/database.js` — funções `getAdesaoPeriodo` e `getAdesaoPorMedicamento`  
**Complexidade:** Baixa — sem alteração de banco, sem novos arquivos

---

## 1. Problema

O resumo semanal do Guilherme mostrou:
```
Voltaren: 4 tomadas · 10 não registradas (29%)
Total: 4/14 doses (29%)
```

O Voltaren foi cadastrado há ~3 dias. O sistema calculou `esperado = 2 doses/dia × 7 dias = 14`, mas deveria ter calculado `2 × 3 = 6`. Adesão real: ~67%, não 29%.

---

## 2. Causa Raiz

Em ambas as funções (`getAdesaoPeriodo` e `getAdesaoPorMedicamento`):

```js
const esperado = schedulesAtivos * dias;  // dias = 7, fixo
```

O código ignora quando o medicamento foi criado. Para um medicamento cadastrado há 3 dias num período de 7 dias, ele conta 4 dias "fantasma" como doses não tomadas.

A tabela `medications` tem o campo `created_at` disponível (selecionado via `select('*')`). É só usá-lo.

---

## 3. Solução

Calcular `diasEfetivos` como a diferença entre hoje e `MAX(desde, med.created_at)`.  
Se o medicamento foi criado DEPOIS do início do período → usa a data de criação.  
Se foi criado ANTES → usa o início do período normalmente.

### 3.1 — Função `getAdesaoPeriodo`

```js
// ANTES
export async function getAdesaoPeriodo(userId, dias = 7) {
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);

    // ...dentro do loop:
    const esperado = schedulesAtivos * dias;
    totalEsperado += esperado;
    // ...
}

// DEPOIS
export async function getAdesaoPeriodo(userId, dias = 7) {
    const agora = new Date();
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);

    // ...dentro do loop, substituir o cálculo de esperado:
    const medCriadoEm = new Date(med.created_at);
    const inicioEfetivo = medCriadoEm > desde ? medCriadoEm : desde;
    const diasEfetivos = Math.max(1, Math.ceil((agora - inicioEfetivo) / (1000 * 60 * 60 * 24)));
    const esperado = schedulesAtivos * diasEfetivos;
    totalEsperado += esperado;
    // ...
}
```

### 3.2 — Função `getAdesaoPorMedicamento`

Mesma lógica, dentro do loop:

```js
// ANTES
const esperado = schedulesAtivos * dias;

// DEPOIS
const medCriadoEm = new Date(med.created_at);
const inicioEfetivo = medCriadoEm > desde ? medCriadoEm : desde;
const diasEfetivos = Math.max(1, Math.ceil((agora - inicioEfetivo) / (1000 * 60 * 60 * 24)));
const esperado = schedulesAtivos * diasEfetivos;
```

Atenção: a variável `agora` já existe na função como `new Date()` implícito no `desde.setDate`. Declarar explicitamente no topo da função:
```js
const agora = new Date();
const desde = new Date();
desde.setDate(desde.getDate() - dias);
```

---

## 4. Ordem de Execução

1. Implementar mudança em `getAdesaoPeriodo` (database.js)
2. Implementar mudança em `getAdesaoPorMedicamento` (database.js)
3. Deploy
4. Validar

---

## 5. Validação Pós-Deploy

O próximo resumo semanal (segunda-feira 08:00 BRT) deve mostrar percentual coerente com o tempo real de uso. Para validar antes disso, chamar manualmente a função de relatório de adesão via conversa:

Enviar "Como tá minha adesão essa semana?" e verificar se o percentual reflete apenas os dias desde o cadastro do medicamento.