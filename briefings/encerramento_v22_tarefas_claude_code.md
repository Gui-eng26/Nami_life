# Tarefas Claude Code — Encerramento v22

Sessão v22 já implementada e commitada (951b7a5 / MH-053). O CONTEXT.md desta sessão é atualizado
manualmente por Guilherme (copiar/colar) — **não precisa ser tocado por você**.

A única pendência é um registro de backlog que surgiu DEPOIS da implementação: **MH-56** (melhoria de
UX dos fallbacks), decidido em conversa após o MH-053 já estar no ar.

## Tarefa única: inserir MH-56 em `backlog_items`

Usar `registrarItemBacklog` (`src/backlog.js`) — nunca SQL direto (princípio 16).

```js
await registrarItemBacklog({
    tipo: 'MH',
    numero: 56,
    titulo: 'Melhorar UX dos fallbacks de erro técnico e de não-entendimento',
    descricao: 'Hoje o fallback de erro técnico ("tive um probleminha, pode repetir?") e o de ' +
        'não-entendimento ("não entendi") fazem o usuário redigitar, perdendo a mensagem original. ' +
        'Com a MH-053 (observabilidade), o catch global já captura a mensagem que causou a falha ' +
        'técnica — uma versão futura do fallback pode reaproveitar esse texto em vez de pedir para ' +
        'redigitar. Prioridade baixa agora, mas reavaliar quando o beta escalar: o atrito de ' +
        'redigitar pesa mais com usuários desconhecidos do que pesa hoje com testadores próximos.',
    causaRaiz: null, // é melhoria de UX, não correção de bug — sem causa raiz de defeito
    status: 'aberto',
    prioridade: 'baixa',
    sessaoCriacao: 'v22',
    dataCriacao: '2026-07-27'
});
```

Confirmar no fim com uma query simples:
```sql
SELECT tipo, numero, titulo, status, prioridade FROM backlog_items WHERE tipo='MH' AND numero=56;
```

Nada além disso nesta tarefa — MH-53/54/55 e as notas em MH-52/48/9 já foram escritas na
implementação anterior (confirmado nesta sessão de planejamento lendo o banco diretamente).