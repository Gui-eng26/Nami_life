# BRIEFING — BUG-035: Fast-path determinístico de resposta tardia ao esgotamento

## Contexto

O fast-path para resposta tardia ao esgotamento (`tentarConfirmarRespostaTardia`, em
`src/router.js`) já está implementado e em produção, mas **nunca é alcançado** — um "Sim"
enviado pelo usuário depois que a dose já transitou para `nao_informado` é roteado
incorretamente para o `agente_principal`, que responde de forma genérica (não reconhece a
dose porque `dosesPendentes` em `principal.js` corretamente exclui `nao_informado`).

## Causa raiz (confirmada com código + logs de produção)

Existem duas definições divergentes de "dose pendente" no código:

**`temDosePendente()` em `src/router.js` (usada para decidir o roteamento):**
```js
async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return doses.some(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado'
    );
}
```
Não exclui `nao_informado` — então retorna `true` mesmo quando a dose já esgotou.

**Filtro `dosesPendentes` em `buildUserMessage()`, `src/agentes/principal.js`:**
```js
const dosesPendentes = recentDoses.filter(d =>
    d.reminder_sent === true &&
    d.confirmed === false &&
    d.status !== 'nao_informado' &&
    d.status !== 'pausado' &&
    d.status !== 'nao_tomado' &&
    ...
```
Este SIM exclui `nao_informado` corretamente.

Como `temDosePendente()` responde `true` incorretamente para doses `nao_informado`, o
roteador segue o bloco 4 (`agentName = 'principal'`) em vez do bloco 4b (o fast-path do
BUG-035). Dentro do `handlePrincipal`, o Claude recebe uma lista de `dosesPendentes` vazia
e não tem como saber a que o "Sim" se refere — daí a resposta genérica.

**Evidência de produção (confirmada via Supabase, projeto `nputymewnwmnhrtpizzs`):**

- Usuário Guilherme (`e3e838c3-9443-46be-b03e-655f46fdf24a`), dose Cataflam
  (`ef1de5f0-788d-4cd3-b282-1d99996ab8e3`), `status: nao_informado`, `confirmed: false`.
  Mensagem "Sim" às `2026-07-08 11:17:19 UTC` — `agent_logs` registra `agent: "principal"`
  (deveria ter sido `fast_path_resposta_tardia`).
- Usuário Ivete (`d61642c2-9bca-4c92-9719-09c3cffa1834`), dose Betaistina
  (`676cebf6-7394-4ad0-a763-ed37f26e6dea`), mesmo padrão — `status: nao_informado`,
  "Sim" às `2026-07-07 09:23:02 UTC`, `agent_logs` registra `agent: "principal"`.

Mesmo bug, dois usuários e medicamentos diferentes — confirma que é sistêmico, não um caso
isolado.

## Correção

Alterar `temDosePendente()` em `src/router.js` para excluir também `nao_informado`,
alinhando sua definição de "dose pendente" à já usada em `buildUserMessage()`:

```js
// ANTES
async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return doses.some(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado'
    );
}
```

```js
// DEPOIS
// Dose 'nao_informado' já esgotou o ciclo de tentativas — não é mais "pendente" no
// sentido de confirmação em andamento, é candidata a resposta tardia (BUG-035),
// tratada por tentarConfirmarRespostaTardia(). Excluí-la aqui garante que o roteador
// não intercepte a mensagem no bloco 4 (confirmação direta) e deixe o bloco 4b
// (fast-path de resposta tardia) ser alcançado. Alinha esta função à mesma definição
// de "dose pendente" já usada em buildUserMessage() (principal.js), que já excluía
// nao_informado corretamente — a divergência entre as duas era a causa raiz do BUG-035
// nunca disparar (confirmado com dados reais de produção, sessão de 08/07/2026).
async function temDosePendente(userId) {
    const doses = await getRecentDoses(userId, 1);
    return doses.some(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado' &&
        d.status !== 'nao_informado'
    );
}
```

Esta é a única alteração de código necessária. `temDosePendente()` é usada em 3 lugares no
`router.js` (bloco idle, `aguardando_periodo_adesao`, `aguardando_escolha_tratamento`) — a
correção na própria função cobre os três automaticamente, o que é o comportamento
desejado (ver seção "Escopo — não implementar agora" abaixo sobre o que isso NÃO resolve).

**Nenhuma migration de schema é necessária.**

## Escopo — não implementar agora (decisão explícita desta sessão)

Corrigir `temDosePendente()` impede que um "Sim" tardio seja mal-interpretado como dose
real pendente dentro de `aguardando_periodo_adesao`/`aguardando_escolha_tratamento` — mas
**não** estende o fast-path (`tentarConfirmarRespostaTardia`) para dentro desses dois
blocos. Isso foi decidido deliberadamente por falta de evidência real em produção desse
cenário específico, e para evitar uma nova ambiguidade (mensagem do usuário disputada
entre "confirma dose antiga" e "responde à pergunta de período/tratamento em aberto")
sem dados reais para calibrar a regra de precedência. Ver item MH-046 abaixo — registrado
para monitoramento, não para implementação nesta rodada.

## Registro no backlog (via `src/backlog.js`, único ponto de escrita)

**Atualizar BUG-035** (permanece em validação — código corrigido, aguardando validação
real em produção):
```js
await atualizarStatusBacklogItem({
    tipo: 'BUG',
    numero: 35,
    novoStatus: 'em_validacao',
    sessaoFechamento: 'v17',
    dataFechamento: '2026-07-08',
    notas: 'Causa raiz confirmada 08/07: temDosePendente() (router.js) não excluía ' +
        'status nao_informado, fazendo o roteador cair no bloco 4 (principal) em vez ' +
        'do bloco 4b (fast-path tentarConfirmarRespostaTardia). Confirmado com dados ' +
        'reais de produção (Guilherme/Cataflam e Ivete/Betaistina, agent_logs mostrando ' +
        'agent=principal no momento exato do "Sim" tardio). Corrigido adicionando ' +
        'd.status !== "nao_informado" ao filtro de temDosePendente(). Aguardando novo ' +
        'ciclo de esgotamento real em produção para validar o fast-path disparando ' +
        'corretamente (agent=fast_path_resposta_tardia nos logs).'
});
```

**Registrar novo item MH-046** (monitoramento, não implementação):
```js
await registrarItemBacklog({
    tipo: 'MH',
    numero: 46,
    titulo: 'Estender fast-path de resposta tardia ao esgotamento para estados ' +
        'aguardando_periodo_adesao/aguardando_escolha_tratamento',
    descricao: 'Hoje, tentarConfirmarRespostaTardia() (BUG-035) só é chamada no bloco ' +
        'idle do router. Dentro de aguardando_periodo_adesao e ' +
        'aguardando_escolha_tratamento, um "Sim" tardio ao esgotamento (após a ' +
        'correção do BUG-035 em temDosePendente) deixa de ser mal-roteado como dose ' +
        'pendente, mas também não aciona o fast-path — cai no classificador central, ' +
        'que hoje repete a pergunta de período/tratamento (sem prejuízo de dado de ' +
        'saúde, apenas UX subótima). Risco identificado: usuarioRespondeuDesde() só ' +
        'verifica SE o usuário respondeu algo desde a última tentativa, não SE o bot ' +
        'fez uma pergunta nova nesse meio-tempo — então, se o usuário entrar em ' +
        'aguardando_periodo_adesao/aguardando_escolha_tratamento ANTES de uma dose (de ' +
        'outro remédio) esgotar, e a primeira resposta dele depois disso for algo que ' +
        'bate em detectarConfirmacaoDose (ex: "sim", "ok", "pode"), o fast-path ' +
        'confirmaria a dose antiga silenciosamente e ignoraria a pergunta de ' +
        'período/tratamento em aberto. Não implementar sem evidência real desse ' +
        'cenário ocorrendo em produção — monitorar via agent_logs.',
    causaRaiz: null,
    status: 'aberto',
    prioridade: null,
    sessaoCriacao: 'v17',
    dataCriacao: '2026-07-08'
});
```

## Validação após deploy

1. Confirmar no GitHub que a alteração em `temDosePendente()` foi commitada.
2. Aguardar um ciclo real de esgotamento (dose vira `nao_informado`) em produção.
3. Enviar um "Sim" tardio (depois da janela de esgotamento) e conferir em `agent_logs`
   que `agent = 'fast_path_resposta_tardia'` (não `principal`).
4. Conferir que a dose foi confirmada em `dose_logs` (`status = 'confirmado'`,
   `confirmed = true`) e que o estoque foi decrementado corretamente.
5. Só então mover BUG-035 para `status: 'resolvido'` (não fazer isso agora — ainda não
   validado em produção).