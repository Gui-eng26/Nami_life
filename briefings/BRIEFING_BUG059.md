# BRIEFING — BUG-059: Rótulo de dia incorreto ("ontem"/"hoje") em confirmações retroativas

## Contexto

Ao confirmar doses retroativas em conversa livre com o `agente_principal`, a Nami às vezes
chama uma dose de "ontem" quando na verdade ela é de "hoje" (mesmo dia da mensagem) — ou
vice-versa. Não é um problema de fuso horário na gravação da dose (isso já foi tratado
antes, v15) — é um problema de **apresentação**: o Claude está adivinhando o rótulo
relativo do dia sem ter a data atual como referência.

## Causa raiz (confirmada com código + dados reais de produção)

Em `buildUserMessage()` (`src/agentes/principal.js`), o bloco que monta a lista de doses
retroativas para o Claude entrega só a data numérica (`dd/mm`), sem nenhum rótulo relativo
(hoje/ontem/anteontem):

```js
const blocoRetroativo = dosesRetroativas.length === 0 ? null :
    dosesRetroativas.map(d => {
        const nome = d.medications?.nome || 'medicamento';
        const scheduledDate = new Date(d.scheduled_at);
        const dataStr = scheduledDate.toLocaleDateString('pt-BR', {
            day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        const hora = scheduledDate.toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        return `⏰ ${nome} — dose de ${dataStr} às ${hora} [ref-retro: ${d.id}]`;
    }).join('\\n');
```

Além disso, **em nenhum lugar do `prompts.js` ou do contexto montado em `principal.js` a
data/hora atual é declarada explicitamente para o Claude.** O único lugar do sistema que já
resolve esse tipo de cálculo deterministicamente é o campo "próxima dose (hoje|amanhã)"
(calculado em `calcularProximaDose`, comentário em `prompts.js` linha 214 confirma:
*"esse valor foi calculado deterministicamente pelo sistema a partir da hora atual"*) — essa
mesma disciplina nunca foi estendida ao bloco de doses retroativas.

Resultado: o Claude recebe `dose de 08/07 às 07:00` sem saber se hoje é 07/07, 08/07 ou
09/07 — e precisa adivinhar o rótulo relativo na resposta em texto livre. Adivinha errado.

**Evidência de produção (confirmada via Supabase, projeto `nputymewnwmnhrtpizzs`):**

- Guilherme, 06/07 (segunda-feira), 22:29 local: "Tomei tbm os de antes". A Nami respondeu
  listando Cataflam (18:28), Dipirona/Neosaldina/Vitamina C (19:58) e Ômega 3 (14:58) como
  *"dose de ontem"* — mas os `scheduled_at` reais em `dose_logs` mostram todas essas doses
  no mesmo dia 06/07, horas antes da própria mensagem. Não eram de ontem, eram de hoje.
- Julia, 08/07, 10:01 local: "já tomei o elani". A dose real (`scheduled_at`
  2026-07-08 09:58 UTC → 06:58 local, mesmo dia) foi chamada de *"dose de ontem (08/07)"* —
  mesmo padrão, usuária e remédio diferentes. Em cascata, isso também levou o Claude a dizer
  que a "próxima dose de hoje está agendada para amanhã", quando a dose de hoje já tinha
  acontecido morning mesmo.

Mesma causa raiz nos dois casos — confirma que é sistêmico.

## Correção (dois níveis, mesma causa raiz)

**Nível 1 — cálculo determinístico do rótulo relativo**, aplicado só ao bloco retroativo
(onde o problema foi observado e onde a ambiguidade "qual dia é esse" realmente importa):

```js
// ANTES
const blocoRetroativo = dosesRetroativas.length === 0 ? null :
    dosesRetroativas.map(d => {
        const nome = d.medications?.nome || 'medicamento';
        const scheduledDate = new Date(d.scheduled_at);
        const dataStr = scheduledDate.toLocaleDateString('pt-BR', {
            day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        const hora = scheduledDate.toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        return `⏰ ${nome} — dose de ${dataStr} às ${hora} [ref-retro: ${d.id}]`;
    }).join('\\n');
```

```js
// DEPOIS
// BUG-059: o Claude não recebia nenhuma âncora de "hoje" para julgar se uma dose
// retroativa era de hoje, ontem ou anteontem — e adivinhava errado no texto livre.
// calcularRotuloDia() resolve isso deterministicamente (mesmo princípio já aplicado
// em calcularProximaDose, ver prompts.js), comparando a data local (America/Sao_Paulo)
// do scheduled_at com a data local de agora.
function calcularRotuloDia(scheduledDate) {
    const opts = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' };
    const dataStr = scheduledDate.toLocaleDateString('pt-BR', opts);

    const hojeStr = new Date().toLocaleDateString('pt-BR', opts);
    if (dataStr === hojeStr) return 'hoje';

    const ontemStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR', opts);
    if (dataStr === ontemStr) return 'ontem';

    const anteontemStr = new Date(Date.now() - 48 * 60 * 60 * 1000).toLocaleDateString('pt-BR', opts);
    if (dataStr === anteontemStr) return 'anteontem';

    return null; // fora da janela de 2 dias coberta por getDosesRetroativas — não deveria ocorrer
}

const blocoRetroativo = dosesRetroativas.length === 0 ? null :
    dosesRetroativas.map(d => {
        const nome = d.medications?.nome || 'medicamento';
        const scheduledDate = new Date(d.scheduled_at);
        const dataStr = scheduledDate.toLocaleDateString('pt-BR', {
            day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        const hora = scheduledDate.toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        const rotulo = calcularRotuloDia(scheduledDate);
        const rotuloStr = rotulo ? `${rotulo} (${dataStr})` : dataStr;
        return `⏰ ${nome} — dose de ${rotuloStr} às ${hora} [ref-retro: ${d.id}]`;
    }).join('\\n');
```

Também atualizar a instrução de uso desse bloco (mesma função, logo abaixo, dentro do
template `context`) para deixar explícito que o rótulo já vem calculado — trocar:

```
- Se o usuário mencionar ter tomado uma dose do passado (ex: "tomei o ômega 3 de ontem",
```
por:
```
- O rótulo do dia (hoje/ontem/anteontem) já vem calculado no bloco acima — use-o
  exatamente como está, nunca calcule ou infira esse rótulo por conta própria.
- Se o usuário mencionar ter tomado uma dose do passado (ex: "tomei o ômega 3 de ontem",
```

**Nível 2 — âncora de data no contexto geral** (rede de segurança sistêmica, cobre
qualquer outra menção livre a datas, inclusive ao ler o JSON bruto de `recentDoses`):

No início do template `context`, logo após a linha `Estado da conversa`, adicionar:

```js
// ANTES
const context = `
=== CONTEXTO DO USUÁRIO ===
Nome: ${user.name || 'ainda não informado'}
Estado da conversa: ${state.state}
Dados parciais em andamento: ${JSON.stringify(state.context)}
```

```js
// DEPOIS
const agora = new Date();
const dataAtualStr = agora.toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'long', timeZone: 'America/Sao_Paulo'
});
const horaAtualStr = agora.toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
});

const context = `
=== CONTEXTO DO USUÁRIO ===
Nome: ${user.name || 'ainda não informado'}
Agora é ${dataAtualStr}, ${horaAtualStr} (horário de Brasília). Use esta data como
referência para qualquer menção a "hoje", "ontem", "amanhã" ou datas relativas — nunca
calcule isso de outra forma.
Estado da conversa: ${state.state}
Dados parciais em andamento: ${JSON.stringify(state.context)}
```

Nenhuma migration de schema é necessária. Nenhuma outra função precisa mudar.

## Registro no backlog (via `src/backlog.js`, único ponto de escrita)

```js
await registrarItemBacklog({
    tipo: 'BUG',
    numero: 59,
    titulo: 'Rótulo de dia incorreto ("ontem"/"hoje") em confirmações retroativas de dose',
    descricao: 'Em conversa livre com o agente_principal, a Nami às vezes chama uma dose ' +
        'de "ontem" quando ela é do mesmo dia da mensagem (ou vice-versa). Não é erro de ' +
        'gravação/fuso na dose em si (isso já foi endereçado na v15) — é a apresentação ' +
        'em texto livre do Claude, que nunca recebe a data atual como referência.',
    causaRaiz: 'buildUserMessage() (principal.js) monta o blocoRetroativo só com a data ' +
        'numérica (dd/mm) da dose, sem rótulo relativo (hoje/ontem/anteontem). Em nenhum ' +
        'lugar do prompts.js ou do contexto o Claude recebe a data/hora atual explicitamente ' +
        '— só o campo "próxima dose (hoje|amanhã)" é calculado deterministicamente hoje. ' +
        'O Claude precisa adivinhar o rótulo relativo em texto livre e erra. Confirmado com ' +
        'dados reais de produção: Guilherme (06/07, doses do mesmo dia rotuladas "ontem") ' +
        'e Julia (08/07, dose do mesmo dia rotulada "ontem", causando em cascata a frase ' +
        '"a dose de hoje está agendada para amanhã").',
    status: 'em_validacao',
    prioridade: null,
    sessaoCriacao: 'v17',
    dataCriacao: '2026-07-08'
});
```

## Validação após deploy

1. Confirmar no GitHub que as duas alterações (blocoRetroativo + âncora de data no
   context) foram commitadas.
2. Deixar pelo menos uma dose ficar sem confirmação por 1-2 dias (cenário retroativo
   real) e confirmá-la em conversa livre mencionando explicitamente "ontem" ou "anteontem"
   — conferir que a resposta da Nami usa o rótulo correto.
3. Testar também no mesmo dia (dose de horas atrás, ainda hoje) — confirmar que a Nami
   não chama de "ontem" uma dose de hoje.
4. Só então mover BUG-059 para `status: 'resolvido'`.