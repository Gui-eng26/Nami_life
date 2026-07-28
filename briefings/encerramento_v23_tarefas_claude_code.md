# Tarefas Claude Code — Encerramento v23

Sessão v23 foi **exclusivamente de decisão** — nenhuma linha de código, nenhum schema, nenhum
template alterado. O CONTEXT.md desta sessão é atualizado manualmente por Guilherme (copiar/colar)
— **não precisa ser tocado por você**.

A única tarefa é fechar o **MH-055** no backlog como `superseded`.

## Contexto da decisão (para você entender o porquê, não para executar)

O MH-055 propunha uma "captura proativa de feedback" no relatório de adesão — uma flag no scheduler
+ leitura no router para marcar respostas do usuário logo após o resumo de adesão com
`origem = 'proativo_adesao'`.

A sessão v23 concluiu que o item **não sobrevive como trabalho independente**, por três razões
apuradas com evidência no código:

1. **O MH-053 já cobre o essencial.** Se o usuário reage ao relatório com feedback real sobre a
   Nami (elogio/crítica/sugestão), o classificador central já capta isso no estado idle
   (`router.js` ~839-844 → `registrarFeedback(origem='espontaneo')`), independentemente de ter
   vindo após o relatório de adesão.

2. **Os templates de adesão foram escritos para serem calorosos, não para elicitar feedback.**
   Frases como "me conta se deu certo" e "me dá sua sugestão" (`templates/adesaoTemplates.js`) são
   tom de cuidado, não call-to-action. A premissa que justificava uma origem "proativa" não se
   sustenta diante do texto real dos templates.

3. **Não há casos mapeados** de reação a relatório de adesão. Construir o mecanismo agora seria
   resolver um comportamento de usuário ainda não evidenciado — contra os princípios do projeto
   (esperar evidência de produção).

O único delta que o MH-055 traria seria o **rótulo de origem** (`proativo_adesao` vs
`espontaneo`). Esse valor **já existe** no enum de `feedbacks.origem`
(migration `20260727000000_observabilidade.sql`: `CHECK (origem IN ('espontaneo','proativo_adesao','proativo_outro'))`),
então o terreno para reabrir isso no futuro já está pronto, sem retrabalho de schema.

O **resíduo genuíno** do MH-055 (respostas curtas/ambíguas que só fazem sentido dada a pergunta
específica de um template — ex.: usuário responde só "o horário" à pergunta binária do template
`abaixo_50` var. 3) é **a mesma classe de problema do MH-057** (resposta ambígua de 1 palavra a
uma pergunta feita pelo próprio bot, sem estado que a sustente). Portanto o resíduo pertence ao
MH-057, não a um mecanismo próprio.

## Tarefa única: fechar MH-055 como `superseded`

Usar `atualizarStatusBacklogItem` (`src/backlog.js`) — nunca SQL direto (princípio 16).

```js
await atualizarStatusBacklogItem({
    tipo: 'MH',
    numero: 55,
    novoStatus: 'superseded',
    sessaoFechamento: 'v23',
    dataFechamento: '2026-07-27',
    notas: 'Fechado sem implementação. Absorvido pelo MH-053: o classificador central já capta ' +
        'feedback real sobre a Nami após o relatório de adesão no estado idle ' +
        '(router.js ~839-844 → registrarFeedback origem=espontaneo). Os templates de adesão foram ' +
        'escritos para ser calorosos, não para elicitar feedback — a premissa de uma origem ' +
        '"proativa" não se sustenta diante do texto real. Sem casos mapeados de reação a relatório; ' +
        'construir agora violaria o princípio de esperar evidência de produção. O único delta seria ' +
        'o rótulo origem=proativo_adesao, que já existe no enum de feedbacks.origem (migration ' +
        'observabilidade v22) — terreno pronto para reabrir sem retrabalho de schema se o volume ' +
        'de interações tornar a distinção de origem acionável. Resíduo genuíno (resposta curta/ambígua ' +
        'dependente da pergunta específica de um template) pertence ao MH-057, que é o mecanismo real ' +
        'para respostas de 1 palavra a perguntas feitas pelo próprio bot. Gancho de reabertura: ' +
        'evidência de que usuários reagem a relatórios de adesão em volume + distinção de origem virar ' +
        'acionável → reconsiderar, provavelmente fundido ao MH-057.'
});
```

Confirmar no fim com uma query simples:
```sql
SELECT tipo, numero, status, sessao_fechamento, data_fechamento FROM backlog_items WHERE tipo='MH' AND numero=55;
```

Nada além disso nesta tarefa.