# Briefing — BUG-022, BUG-023, BUG-024

Este documento é um briefing de implementação para o Claude Code.
Leia o CONTEXT.md antes de começar.
Antes de qualquer alteração, leia os arquivos relevantes mencionados em cada bug.

---

## BUG-022 — detectarConfirmacaoDose interceptando mensagens sem dose real pendente

### Arquivo: src/router.js

### Diagnóstico confirmado
A função `detectarConfirmacaoDose` intercepta qualquer mensagem que contenha
"sim", "tomei", "ok" etc. e manda para o agente_principal — mesmo quando não
há nenhuma dose pendente no banco para aquele usuário.

Caso real: Wellington disse "Sim por favor" respondendo à pergunta "Quer
cadastrar agora?" — sem nenhum medicamento cadastrado, portanto sem dose
pendente. A Nami respondeu como se ele estivesse confirmando uma dose
inexistente.

### Causa raiz
O bloco de roteamento para confirmação de dose não verifica se há dose
pendente real — usa apenas pattern matching de texto:

```javascript
} else if (currentState === 'idle' && detectarConfirmacaoDose(message)) {
    agentName = 'principal';
    response = await handlePrincipal({ user, message, image });
}
```

A função `temDosePendente` existe no código mas não está sendo usada neste bloco.

### Correção
Unir `detectarConfirmacaoDose` com `temDosePendente` — só interceptar se
AMBAS as condições forem verdadeiras:

```javascript
} else if (currentState === 'idle'
    && detectarConfirmacaoDose(message)
    && await temDosePendente(user.id)) {
    agentName = 'principal';
    console.log(`💊 Confirmação de dose detectada, roteando para principal — ${user.phone}`);
    response = await handlePrincipal({ user, message, image });
}
```

Sem dose pendente, a mensagem cai no fluxo normal (agente_relatorios ou
agente_principal), que vai interpretar o "Sim" no contexto correto da conversa.

---

## BUG-023 — getRecentDoses com filtro via join quebrado

### Arquivo: src/database.js

### Diagnóstico confirmado
A função `getRecentDoses` usa `.eq('medications.user_id', userId)` — filtro
via join que não funciona no Supabase JS SDK. O resultado é que a função
retorna dose_logs de TODOS os usuários, não apenas do usuário solicitado.

Isso afeta o contexto passado ao agente_principal: `recentDoses` pode conter
doses de outros usuários, causando comportamento incorreto (ex: Nami
"ver" dose pendente de outro usuário e tratar como se fosse do usuário atual).

### Causa raiz
Mesmo padrão do BUG-017 já corrigido em `getDosesHoje`:

```javascript
// ERRADO — filtro via join não funciona no Supabase JS SDK
.eq('medications.user_id', userId)
```

### Correção
Mesma abordagem usada na correção do BUG-017 — buscar IDs dos medicamentos
do usuário primeiro, depois filtrar por `medication_id`:

```javascript
export async function getRecentDoses(userId, days = 3) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Busca IDs dos medicamentos do usuário
    const { data: meds } = await supabase
        .from('medications')
        .select('id, nome')
        .eq('user_id', userId)
        .eq('ativo', true);

    if (!meds || meds.length === 0) return [];

    const medicationIds = meds.map(m => m.id);
    const medNomeMap = Object.fromEntries(meds.map(m => [m.id, m.nome]));

    const { data, error } = await supabase
        .from('dose_logs')
        .select('*')
        .in('medication_id', medicationIds)
        .gte('scheduled_at', since.toISOString())
        .order('scheduled_at', { ascending: false });

    if (error) return [];

    // Adiciona nome do medicamento em cada log
    return (data || []).map(d => ({
        ...d,
        medications: { nome: medNomeMap[d.medication_id], user_id: userId }
    }));
}
```

---

## BUG-024 — agente_relatorios capturando frases que não são consultas

### Arquivo: src/agentes/relatorios.js

### Diagnóstico confirmado
O classificador `classificarIntencaoRelatorio` usa termos muito genéricos que
capturam frases ditas pela Nami ou comentários do usuário que não são consultas.

Caso real: Wellington repetiu "Horário dos meus remédios" como reação à
apresentação da Nami — era uma afirmação, não uma pergunta. O classificador
capturou pelo padrão `meus_remedios` e respondeu como se fosse consulta.

### Causa raiz
Termos como "meus remédios", "horário", "estoque" são genéricos demais
e aparecem em conversas normais, não só em consultas explícitas.

### Correção
Tornar os termos mais específicos — exigir que a intenção seja inequivocamente
uma consulta. Adicionar palavras de interrogação ou ação explícita:

```javascript
const padroes = {
    tomei_hoje: [
        'tomei hoje?',
        'já tomei meus remédios',
        'tomei alguma coisa hoje',
        'registrei hoje',
        'esqueci de tomar hoje',
        'tomei tudo hoje',
        'tomei o remédio hoje'
    ],
    meus_remedios: [
        'quais meus remédios',
        'que remédios tenho',
        'o que tenho cadastrado',
        'quais remédios eu tomo',
        'me mostra meus remédios',
        'lista meus remédios',
        'remédios cadastrados',
        'quais são meus remédios',
        'ver meus remédios'
    ],
    estoque: [
        'quanto tenho de cada',
        'tô ficando sem remédio',
        'quando preciso comprar',
        'quanto sobrou',
        'como está meu estoque',
        'preciso comprar remédio',
        'quanto tenho ainda de',
        'tô sem remédio'
    ],
    proximo_remedio: [
        'o que tenho que tomar',
        'que horas é o próximo',
        'tenho remédio pra tomar agora',
        'esqueci de tomar alguma coisa',
        'qual o próximo remédio',
        'o que devo tomar agora',
        'que remédio tomo agora'
    ],
    adesao: [
        'quantas vezes esqueci',
        'tenho esquecido muito',
        'como está minha adesão',
        'tô tomando direitinho',
        'quantas doses perdi',
        'faltei alguma dose',
        'como tá meu histórico',
        'tô me cuidando bem'
    ]
};
```

Remover da lista qualquer termo que seja uma frase incompleta ou que possa
aparecer em contexto de afirmação (ex: "meus remédios" sozinho, "horário",
"estoque" sem contexto de pergunta).

---

## Ordem de implementação

1. Ler src/router.js → aplicar BUG-022
2. Ler src/database.js → aplicar BUG-023
3. Ler src/agentes/relatorios.js → aplicar BUG-024
4. Mostrar diff de cada arquivo antes de salvar

---

## Critérios de sucesso

- BUG-022: usuário diz "Sim" sem dose pendente → Nami responde no contexto
  da conversa, não como confirmação de dose inexistente
- BUG-022: usuário diz "Sim" com dose pendente → CONFIRM_DOSE disparado
  normalmente (sem regressão)
- BUG-023: `getRecentDoses` retorna apenas doses do usuário correto
- BUG-024: "Horário dos meus remédios" dito como afirmação não ativa
  o agente_relatorios
- BUG-024: "Quais meus remédios?" explícito continua ativando o relatório