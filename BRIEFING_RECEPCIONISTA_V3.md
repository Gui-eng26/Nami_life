# Briefing — Recepcionista v3: Validação de Nome + Refinamentos de Produto

Este documento é um briefing de implementação para o Claude Code.
Leia o CONTEXT.md antes de começar.

---

## Contexto

Os logs do Railway confirmaram as causas raiz dos problemas remanescentes.
Este briefing cobre correções cirúrgicas no `recepcionista.js` baseadas
em evidências concretas, não hipóteses.

---

## Arquivo a modificar

```
src/agentes/recepcionista.js
```

Nenhum outro arquivo precisa ser modificado.

---

## Diagnóstico confirmado pelos logs

```
13:37:06 — usuário manda "Oi"
           → etapa = null → nextEtapa = 'recep_boas_vindas'
           → mensagem_inicial = "Oi" ✓

13:37:46 — usuário manda "Nimesulida 12/12 horas"
           → etapa = 'recep_boas_vindas'
           → código faz: const nome = message.trim()
           → nome_coletado = "Nimesulida 12/12 horas" ✗ (deveria ser um nome)

13:38:36 — usuário manda "Concordo"
           → updateUser com name = "Nimesulida 12/12 horas" ✗ (nome inválido salvo)
```

---

## CORREÇÃO 1 — Validar se a resposta em recep_boas_vindas é realmente um nome

### Problema
O bloco `etapa === 'recep_boas_vindas'` salva qualquer resposta como nome,
sem verificar se é de fato um nome ou se é um medicamento/posologia/contexto.

### Solução
Adicionar função `pareceNome(message)` e bifurcar o fluxo:

```javascript
function pareceNome(message) {
    if (!message) return false;
    const msg = message.toLowerCase().trim();

    // Sinais de que NÃO é um nome
    const sinaisDeRemedio = [
        /\d+\s*(mg|ml|mcg|g|%)/, // dosagem: "500mg", "0,5%"
        /\d+\s*\/\s*\d+\s*(h|hora|horas)/, // posologia: "12/12h", "8/8 horas"
        /de\s+\d+\s+em\s+\d+/, // "de 8 em 8 horas"
        /tomei|tomo|preciso tomar|remédio|remedio|medicamento|comprimido/,
        /nitroglicerina|nimesulida|losartana|metformina|atenolol|omeprazol|dipirona/
    ];

    return !sinaisDeRemedio.some(pattern =>
        typeof pattern === 'string'
            ? msg.includes(pattern)
            : pattern.test(msg)
    );
}
```

### Lógica do bloco corrigido

```javascript
} else if (etapa === 'recep_boas_vindas') {
    if (pareceNome(message)) {
        // Resposta parece um nome — fluxo normal
        nextEtapa = 'recep_coleta_nome';
        updatedContext = {
            etapa: 'recep_coleta_nome',
            nome_coletado: message.trim(),
            mensagem_inicial: context.mensagem_inicial
        };
    } else {
        // Resposta parece um medicamento/contexto — NÃO salvar como nome
        // Atualizar mensagem_inicial com essa info mais rica
        // Manter na etapa boas_vindas para perguntar o nome de verdade
        nextEtapa = 'recep_boas_vindas';
        updatedContext = {
            etapa: 'recep_boas_vindas',
            nome_coletado: null,
            mensagem_inicial: message,  // substitui "Oi" por contexto mais rico
            contexto_medicamento: message  // sinaliza que há contexto de remédio
        };
    }
}
```

---

## CORREÇÃO 2 — Prompt: tratar resposta ambígua em recep_boas_vindas

Quando o usuário responde com algo que parece medicamento em vez de nome,
o Claude deve reconhecer o contexto E pedir o nome de forma natural.

No `buildSystemPrompt`, dentro do bloco `SE etapa = 'recep_boas_vindas'`,
adicionar instrução para o caso em que `context.contexto_medicamento` existe:

```
SE etapa = 'recep_boas_vindas' E context.contexto_medicamento existe:
  O usuário acabou de informar um medicamento ou contexto de saúde
  em vez do nome. Você deve:
  1. Mostrar que entendeu o que ele disse (cite o remédio/contexto)
  2. Perguntar de forma natural se é o remédio que quer cadastrar
     OU se é o nome dele
  3. Se for remédio: confirmar e pedir o nome
  Exemplo: "Parece que você quer cadastrar a nimesulida, certo? 💊
  Antes de registrar tudo, como posso te chamar?"
```

---

## CORREÇÃO 3 — Validar nome antes de salvar no banco

Antes do `updateUser`, verificar se `context.nome_coletado` é um nome válido.
Se não for (contém padrão de medicamento), salvar como null:

```javascript
if (lgpdAccepted) {
    const nomeParaSalvar = pareceNome(context.nome_coletado || '')
        ? context.nome_coletado
        : null;

    await updateUser(user.id, {
        name: nomeParaSalvar,
        onboarded: true,
        lgpd_accepted: true,
        lgpd_accepted_at: new Date().toISOString()
    });
    // ... resto do código
}
```

---

## CORREÇÃO 4 — Fluxo quando usuário recusa a LGPD

Hoje não há tratamento definido quando `isLgpdAccepted` retorna false
na etapa `recep_lgpd`. O código salva o state como `recep_lgpd` e a
conversa fica presa.

Adicionar tratamento explícito:

```javascript
} else if (etapa === 'recep_coleta_nome' || etapa === 'recep_lgpd') {
    nextEtapa = 'recep_lgpd';
    lgpdAccepted = isLgpdAccepted(message);
    lgpdRecusado = !lgpdAccepted && contemRecusa(message);
    updatedContext = { ...context, etapa: 'recep_lgpd' };
}
```

Adicionar função `contemRecusa`:

```javascript
function contemRecusa(message) {
    const msg = message.toLowerCase().trim();
    return ['não', 'nao', 'nope', 'recuso', 'não aceito', 'não concordo',
            'prefiro não', 'não quero'].some(t => msg.includes(t));
}
```

Quando `lgpdRecusado`:

```javascript
if (lgpdRecusado) {
    // Salvar estado como 'lgpd_recusado' — não onboarded, não bloqueia
    await saveConversationState(user.id, {
        state: 'lgpd_recusado',
        context: {}
    });
    console.log(`ℹ️ Recepcionista: LGPD recusada por ${user.phone}`);
    // O prompt do recep_lgpd já trata essa mensagem com empatia
}
```

No prompt, dentro de `SE etapa = 'recep_lgpd'`, já existe instrução para
recusa. Garantir que está assim:

```
Se o usuário recusar:
  Agradeça pela honestidade com calor e sem pressão.
  Diga que entende completamente e que ele pode voltar quando quiser.
  Não insista, não explique mais sobre LGPD.
  Exemplo: "Tudo bem, entendo! Seus dados, sua escolha 😊
  Se mudar de ideia, é só me chamar. Estarei aqui!"
```

---

## CORREÇÃO 5 — Prompt recep_lgpd: retomar contexto rico após aceite

Quando intenção é CADASTRAR e o usuário tem `mensagem_inicial` com
informações ricas (remédio + posologia + horário), o Claude deve
retomar esse contexto ao finalizar o onboarding — não apenas perguntar
"qual o nome do remédio?" como se não soubesse nada.

No prompt, bloco `SE etapa = 'recep_lgpd'` → `Se CADASTRAR`:

```
Se CADASTRAR e mensagem_inicial contém informações de medicamento:
  Após agradecer pelo aceite, demonstre que lembrou do contexto.
  Use as informações que o usuário já forneceu.
  NÃO pergunte o que você já sabe.

  Exemplo (quando usuário já informou remédio e posologia):
  "Perfeito, {nome}! Agora posso te ajudar de verdade 💊
  Vi que você precisa tomar {remédio} de {posologia} — vamos
  organizar isso certinho. Só preciso de mais alguns detalhes
  para configurar seus lembretes. Qual a dosagem?"

  Se o usuário informou o horário da última dose:
  Calcule o próximo horário esperado e pergunte se já tomou.
  Exemplo: "Vi que sua última dose foi às 21:30 de ontem.
  Se você toma de 12 em 12 horas, o próximo seria às 09:30 —
  já tomou hoje?"
```

---

## Ordem de implementação

1. Adicionar funções `pareceNome` e `contemRecusa` no arquivo
2. Corrigir bloco `etapa === 'recep_boas_vindas'` (Correção 1)
3. Atualizar `buildSystemPrompt` com instruções das Correções 2 e 5
4. Adicionar validação de nome antes do `updateUser` (Correção 3)
5. Adicionar tratamento de recusa LGPD (Correção 4)

---

## Critérios de sucesso

- Usuário manda "Nimesulida 12/12 horas" como primeira mensagem →
  Nami reconhece o remédio e pede o nome (não salva remédio como nome)
- Usuário manda nome válido → fluxo normal sem alteração
- Usuário recusa LGPD → Nami responde com empatia e conversa encerra dignamente
- Após aceite LGPD com contexto rico → Nami retoma o que o usuário já disse
  sem perguntar o que já sabe
- Nome salvo no banco é sempre um nome real, nunca um medicamento
- Nenhuma regressão no fluxo de usuários já cadastrados (onboarded = true)

---

## Roteiro de validação

Simular 3 cenários após implementar:

**Cenário A — Usuário com contexto rico:**
1. "Preciso tomar nimesulida de 12 em 12 horas, tomei às 21:30 ontem"
2. [nome real]
3. "Sim"
→ Esperado: Nami reconhece remédio, pede nome, retoma contexto após LGPD

**Cenário B — Usuário neutro:**
1. "Oi"
2. [nome real]
3. "Sim"
→ Esperado: fluxo padrão sem alteração

**Cenário C — Recusa LGPD:**
1. "Oi"
2. [nome real]
3. "Não quero"
→ Esperado: Nami responde com empatia, conversa encerra dignamente