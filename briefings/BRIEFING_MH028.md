# BRIEFING — MH-028
## tratamento_dias e tipo_tratamento acessíveis via conversa

**Data:** 17/06/2026  
**Origem:** Guilherme perguntou "Quantos dias eu tenho que tomar o Voltaren?" → Nami disse que não tinha essa informação, mas o dado existe no banco  
**Escopo:** `src/agentes/principal.js`  
**Complexidade:** Baixíssima — uma função, sem alteração de banco

---

## 1. Causa Raiz

A função `buildUserMessage` em `principal.js` injeta os medicamentos no contexto do Claude assim:

```js
`[id:${m.id}] ${m.nome} (${m.dosagem}, estoque: ${m.estoque_atual}, horários: ${horarios})`
```

Os campos `tipo_tratamento`, `tratamento_dias` e `created_at` existem na tabela `medications` e são retornados por `getUserMedications` (que usa `select('*')`), mas **nunca são passados para o Claude**. Resultado: Claude não tem como responder perguntas como:

- "Quantos dias de tratamento do Voltaren?" → `tratamento_dias`
- "Quantos dias ainda faltam?" → `tratamento_dias - diasDecorridos`
- "Quantos dias já tomei?" → `diasDecorridos` (calculado a partir de `created_at`)

---

## 2. Solução

Incluir `tipo_tratamento`, `tratamento_dias` e os valores calculados diretamente na string de contexto injetada no Claude. Calcular os valores no `buildUserMessage` — assim o Claude só precisa ler, não calcular.

---

## 3. Mudança em `src/agentes/principal.js`

Localizar a função `buildUserMessage` e substituir o trecho do map de medicamentos:

```js
// ANTES
medications.map(m => {
    const horarios = m.schedules && m.schedules.length > 0
        ? m.schedules.filter(s => s.ativo).map(s => s.horario).join(', ')
        : 'nenhum horário cadastrado';
    return `[id:${m.id}] ${m.nome} (${m.dosagem}, estoque: ${m.estoque_atual}, horários: ${horarios})`;
}).join(' | ')

// DEPOIS
medications.map(m => {
    const horarios = m.schedules && m.schedules.length > 0
        ? m.schedules.filter(s => s.ativo).map(s => s.horario).join(', ')
        : 'nenhum horário cadastrado';

    // Cálculo de progresso do tratamento
    let tratamentoInfo = `tipo: ${m.tipo_tratamento || 'contínuo'}`;
    if (m.tratamento_dias) {
        const inicio = new Date(m.created_at);
        const agora = new Date();
        const diasDecorridos = Math.floor((agora - inicio) / (1000 * 60 * 60 * 24));
        const diasRestantes = Math.max(0, m.tratamento_dias - diasDecorridos);
        tratamentoInfo += `, duração total: ${m.tratamento_dias} dias, dias decorridos desde o início: ${diasDecorridos}, dias restantes: ${diasRestantes}`;
    }

    return `[id:${m.id}] ${m.nome} (${m.dosagem}, estoque: ${m.estoque_atual}, horários: ${horarios}, ${tratamentoInfo})`;
}).join(' | ')
```

---

## 4. Ordem de Execução

1. Implementar mudança em `src/agentes/principal.js`
2. Deploy

---

## 5. Validação Pós-Deploy

Enviar as três perguntas sobre o Voltaren (ou qualquer medicamento com `tratamento_dias` preenchido):

| Pergunta | Resposta esperada |
|---|---|
| "Quantos dias de tratamento do Voltaren?" | "Seu tratamento com Voltaren é de 7 dias" |
| "Quantos dias ainda faltam?" | "Faltam X dias para concluir o tratamento" |
| "Quantos dias já tomei?" | "Você está no Xº dia de tratamento" |

Para medicamento de uso contínuo (sem `tratamento_dias`), a Nami deve responder que é de uso contínuo, sem previsão de encerramento.