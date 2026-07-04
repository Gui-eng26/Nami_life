# BRIEFING_BUG035 — Fast-path de "Resposta Tardia ao Esgotamento"

**Data:** 03/07/2026
**Tipo:** BUG (viola princípio não-negociável — ver seção Causa Raiz)
**Prioridade:** Alta (afeta adesão registrada incorretamente para usuários reais — Julia, Ivete)
**Não confundir com:** BUG-029 (fast-path por `referenceMessageId` quebrado). Este briefing cria um
mecanismo **novo e independente**, que não usa `referenceMessageId` em nenhum momento e não é
afetado pela causa do BUG-029.

---

## 1. Sintoma (evidência real, prints em anexo na conversa)

Julia e Ivete receberam lembrete + 2 follow-ups do Escitalopram/Betaistina. Nenhuma resposta foi
dada durante a janela de follow-up (30min / 1h / 30min), então a dose virou `nao_informado` e os
cuidadores foram notificados — comportamento correto até aqui.

Minutos/horas depois, ambas responderam **"Sim"** em texto puro (sem citar/responder a mensagem
específica no WhatsApp). A Nami respondeu:

> "Parece que você respondeu 'sim', mas não há nenhuma dose aguardando confirmação agora."

A dose ficou registrada como `nao_informado` mesmo com o usuário confirmando que tomou. Isso é uma
falha de adesão registrada incorretamente — dado clínico errado.

---

## 2. Causa raiz confirmada (código real, não hipótese)

O problema não está em um único ponto — é uma lacuna entre dois mecanismos que já existem e que,
individualmente, estão corretos:

### 2.1 — `router.js` deixa a mensagem passar para o `principal` (correto)
```js
// temDosePendente() — router.js linha 59-66
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
Não exclui `nao_informado`, então roteia certo para `principal`.

### 2.2 — `principal.js` esconde a dose `nao_informado` do bloco de "pendentes" (correto, por design)
```js
// buildUserMessage() — principal.js linha 106-114
const dosesPendentes = recentDoses.filter(d =>
    d.reminder_sent === true &&
    d.confirmed === false &&
    d.status !== 'nao_informado' &&   // ← exclusão intencional
    d.status !== 'pausado' &&
    d.status !== 'nao_tomado' &&
    d.status !== 'sem_estoque'
);
```
Correto porque `nao_informado` já tem tratamento dedicado — o bloco retroativo.

### 2.3 — O bloco retroativo (v11) **pega** a dose, mas exige apresentação prévia (correto, por design, para o caso genuinamente retroativo)
`getDosesRetroativas(userId, 2)` inclui a dose. O prompt exige:
```
1. Apresente a dose ao usuário (nome + data + horário) e peça confirmação explícita.
2. Somente após "sim"/"isso"/"tomei"/"confirmo" → emita CONFIRM_RETROATIVA
NUNCA emita CONFIRM_RETROATIVA sem confirmação explícita.
```
Como o "Sim" da Julia foi a **primeira mensagem** desde o esgotamento — sem a Nami ter
"apresentado" nada nesse turno — o modelo não tem base para amarrar o "Sim" a uma dose
específica e responde de forma segura (nega). **Esse comportamento está correto para o caso
genuinamente retroativo** (usuário trazendo à tona uma dose antiga do nada), mas não cobre o caso
de resposta tardia direta ao próprio lembrete.

### 2.4 — Princípio violado
`CONTEXT.md`, seção "Filosofia de produto": *"Status terminais (confirmado, nao_informado) devem
permitir correção retroativa quando o usuário traz nova informação."* A correção retroativa existe
— mas não é acionada nesse caminho específico porque nenhuma das duas peças (pendentes / bloco
retroativo com apresentação) foi desenhada para o caso de resposta imediata e inequívoca.

---

## 3. Distinção conceitual (por que não é um único fluxo)

| | Caso A — Resposta tardia ao lembrete | Caso B — Retroativo genuíno |
|---|---|---|
| Quando ocorre | "Sim" é a 1ª msg do usuário desde o esgotamento, dentro de 24h | Usuário traz à tona espontaneamente, fora de sequência de lembrete recente |
| Ambiguidade | Nenhuma — só pode se referir à última dose/grupo esgotado | Pode haver mais de uma dose candidata, ou erro do usuário |
| Tratamento correto | Confirmar direto (determinístico, sem LLM decidir) | Apresentar (nome+data+hora) e exigir confirmação explícita — fluxo já existente, mantido como está |

Esta correção resolve **apenas o Caso A**. O Caso B continua exatamente como está hoje (validado
na v12) — nenhuma mudança no prompt, em `getDosesRetroativas`, ou no fluxo de apresentação.

---

## 4. Desenho da solução

### Decisões de produto já validadas com Guilherme
- **Determinístico, sem o LLM decidindo** (alinhado ao princípio "Cálculos de saúde
  determinísticos" do CONTEXT.md).
- **Janela: 24h.** Dentro de 24h desde o esgotamento (`scheduled_at` da dose) + sendo a 1ª
  mensagem do usuário desde então → confirma direto. Fora de 24h → cai no fluxo retroativo
  existente com apresentação (Caso B), sem mudança alguma.
- **Mensagem de confirmação: reaproveitar a mensagem padrão já existente**, sem diferenciar texto
  para esse cenário (mesma mensagem do fast-path por `referenceMessageId` / `CONFIRM_DOSE` normal:
  `"✅ Anotei! Dose do {nomeRemedio} confirmada, {firstName}. Continue assim! 💪💊"` + alerta de
  estoque se aplicável).
- **Agrupamento (MH-032):** se a dose mais recente `nao_informado` faz parte de um grupo (mesmo
  `horario_agendado`), confirma todas as doses do grupo, não só uma.

### Condições para o fast-path disparar (todas obrigatórias)

1. `currentState === 'idle'`
2. `detectarConfirmacaoDose(message) === true` (reaproveita função existente do router.js)
3. `temDosePendente(user.id) === false` (não há dose realmente `pendente` — se houver, o fluxo
   atual de confirmação normal já resolve, sem tocar neste código novo)
4. Existe pelo menos 1 dose com `status = 'nao_informado'` para o usuário (via
   `getDosesRetroativas`, que já ordena por `scheduled_at desc` — pegar a mais recente)
5. **Janela de 24h:** `agora - dose_mais_recente.scheduled_at <= 24h`
6. **"1ª mensagem desde o esgotamento":** nenhuma entrada em `agent_logs` do usuário com
   `created_at > dose_mais_recente.ultima_tentativa_at` até o momento do processamento desta
   mensagem (ver nova função no item 5.1)
7. **Grupo sem ambiguidade:** todas as doses `nao_informado` que entram na confirmação devem
   compartilhar o mesmo `horario_agendado` (ou, se `horario_agendado` for `NULL` — registro
   legado pré-MH-032 — considerar apenas a própria dose, sem agrupar)

Se **qualquer** condição falhar → não intercepta. A mensagem segue o roteamento que já existe hoje
(cai no `principal` normalmente, no bloco retroativo com apresentação, ou no classificador). Não
há caminho onde a mensagem fica sem resposta — ou confirma direto, ou apresenta, ou aplica a
resposta de limite de 2 dias já existente.

### 5.1 — Nova função em `database.js`

```js
// Verifica se o usuário já respondeu qualquer coisa desde um timestamp de referência.
// Usada para confirmar que a mensagem atual é a 1ª interação do usuário desde o esgotamento.
export async function usuarioRespondeuDesde(userId, timestampReferencia) {
    const { data, error } = await supabase
        .from('agent_logs')
        .select('id')
        .eq('user_id', userId)
        .not('user_message', 'is', null)
        .gt('created_at', timestampReferencia)
        .limit(1);

    if (error) {
        console.error('Erro ao verificar resposta prévia do usuário:', error.message);
        return true; // fail-safe: assume que já respondeu → não dispara o fast-path automático
    }
    return (data || []).length > 0;
}
```
**Nota de segurança:** em caso de erro na query, o fail-safe é `true` (assume que já houve
resposta prévia), o que **impede** o fast-path de disparar e empurra o fluxo para o caminho já
validado (apresentação). Nunca falhar "para o lado" de confirmar uma dose sem certeza.

### 5.2 — Novo bloco em `router.js`

Inserir como um novo item na cadeia de roteamento (`routeMessage`), logo após o item 4 atual
(confirmação de dose pendente, linha ~408-414), como um `else if` adicional — **antes** do
classificador LLM (item 6):

```js
// 4b. Resposta tardia ao esgotamento (BUG-035) — fast-path determinístico,
// distinto do fast-path por referenceMessageId (BUG-029, ainda quebrado)
} else if (currentState === 'idle'
    && detectarConfirmacaoDose(message)
    && !(await temDosePendente(user.id))) {

    const resultado = await tentarConfirmarRespostaTardia(user, message);
    if (resultado) {
        agentName = 'fast_path_resposta_tardia';
        response = resultado;
    } else {
        // Nenhuma condição bateu — segue fluxo normal (cai no principal/retroativo/classificador)
        agentName = 'principal';
        response = await handlePrincipal({ user, message, image, historicoConversa });
    }
```

Função nova `tentarConfirmarRespostaTardia(user, message)` (sugestão: em `router.js` mesmo, perto
de `temDosePendente`/`detectarConfirmacaoDose`, ou em novo módulo se preferir isolar):

```js
async function tentarConfirmarRespostaTardia(user, message) {
    const dosesRetroativas = await getDosesRetroativas(user.id, 2); // já ordena scheduled_at desc
    if (dosesRetroativas.length === 0) return null;
    // Reaproveita detectarConfirmacaoDose puro (mesma função usada em todo o resto do sistema
    // para este tipo de detecção) — sem gate adicional de ambiguidade. Ver seção 9 (Observação
    // para revisão futura) sobre por que não adicionamos um limiar de rigor neste momento.

    const maisRecente = dosesRetroativas[0];
    const dentroDe24h = (Date.now() - new Date(maisRecente.scheduled_at).getTime()) <= 24 * 60 * 60 * 1000;
    if (!dentroDe24h) return null;

    const referencia = maisRecente.ultima_tentativa_at || maisRecente.scheduled_at;
    const jaRespondeu = await usuarioRespondeuDesde(user.id, referencia);
    if (jaRespondeu) return null;

    // Monta o grupo: doses nao_informado com o mesmo horario_agendado da mais recente
    const grupo = maisRecente.horario_agendado
        ? dosesRetroativas.filter(d => d.horario_agendado === maisRecente.horario_agendado
            && new Date(d.scheduled_at).toDateString() === new Date(maisRecente.scheduled_at).toDateString())
        : [maisRecente];

    // Confirma todas as doses do grupo, reaproveitando a função já existente e auditada
    for (const dose of grupo) {
        await confirmarDoseRetroativa(dose.id, 'resposta tardia ao esgotamento (BUG-035)');
    }

    // Mensagem padrão — mesma do fast-path por referenceMessageId, sem diferenciação de texto
    const nomes = grupo.map(d => d.medications?.nome || 'seu remédio').join(' e ');
    const firstName = user.name ? user.name.split(' ')[0] : 'você';

    await logAgentInteraction({
        userId: user.id,
        agent: 'fast_path_resposta_tardia',
        userMessage: message,
        agentResponse: `Dose(s) confirmada(s) retroativamente: ${nomes}`,
        estadoConversa: null,
        contextoConversa: null
    });

    // Alerta de estoque: reaproveitar getEstoqueInfoParaAlerta/calcularAlertaEstoque
    // por medicamento do grupo, mesmo padrão do fast-path por referenceMessageId (linhas 279-295
    // do router.js atual) — não reproduzido aqui por brevidade, mas OBRIGATÓRIO manter paridade.

    return `✅ Anotei! Dose do *${nomes}* confirmada, ${firstName}. Continue assim! 💪💊`;
}
```

**Import necessário em `router.js`:** `getDosesRetroativas`, `confirmarDoseRetroativa` de
`database.js` (ambos já existem, só não são importados no router hoje — hoje só são usados em
`principal.js`).

---

## 5. Casos de teste (cenários para validar em ambiente limpo)

1. **Caso feliz — dose única:** usuário esgota follow-ups, responde "Sim" 1h depois → confirma
   direto, estoque -1, mensagem padrão, `revertido_de = 'nao_informado'` no banco.
2. **Caso feliz — grupo (MH-032):** 2 medicamentos no mesmo horário esgotam juntos, usuário
   responde "Sim" → ambos confirmados, estoque -1 em cada um.
3. **Fora da janela de 24h:** dose esgotou há 30h, usuário responde "Sim" → NÃO confirma direto,
   cai no fluxo retroativo com apresentação (comportamento atual, inalterado).
4. **Usuário já respondeu algo entre o esgotamento e o "Sim":** ex. usuário mandou "oi" 10min
   depois do esgotamento, depois "Sim" 20min depois disso → `usuarioRespondeuDesde` retorna `true`
   → NÃO confirma direto (não é mais a "1ª resposta"), cai no fluxo com apresentação.
5. **Duas doses `nao_informado` de horários diferentes no mesmo dia:** ex. Escitalopram das 9h e
   Losartana das 21h, ambas esgotadas, usuário responde "Sim" → pega só a mais recente
   (Losartana), Escitalopram permanece no funil retroativo normal (evita confirmar o remédio
   errado por ambiguidade).
6. **Negação:** "Não" ou "Ainda não tomei" logo após o esgotamento → `detectarConfirmacaoDose`
   já retorna `false` para negações, então nem entra nesse fluxo — cai no roteamento padrão
   (deve seguir para o fluxo de `nao_tomado` retroativo, já existente, sem mudança).
7. **Fail-safe de erro:** simular erro na query de `usuarioRespondeuDesde` → deve cair no fluxo
   com apresentação (nunca confirmar sem certeza).

---

## 6. Fora de escopo desta correção

- **BUG-029** (fast-path por `referenceMessageId`) — continua quebrado, tratamento separado.
- Qualquer alteração no prompt (`prompts.js`) ou no fluxo de apresentação do Caso B — permanecem
  exatamente como validados na v12.
- Diferenciação de mensagem de confirmação para esse cenário — decisão de produto foi reaproveitar
  a mensagem padrão, sem texto especial para "atrasada".

---

## 7. Arquivos tocados

- `src/router.js` — novo bloco de roteamento + função `tentarConfirmarRespostaTardia` + imports de
  `getDosesRetroativas` e `confirmarDoseRetroativa`
- `src/database.js` — nova função `usuarioRespondeuDesde`
- Nenhuma migration de schema necessária (reaproveita colunas existentes: `status`,
  `ultima_tentativa_at`, `horario_agendado`, `scheduled_at`)

---

## 8. Registro de backlog

- **ID:** BUG-035 (próximo livre confirmado no CONTEXT.md)
- Próximo BUG livre após esta correção: **BUG-036**

---

## 9. Observação para revisão futura (NÃO implementar agora — sem evidência empírica)

Durante o desenho, surgiu a dúvida: `detectarConfirmacaoDose` usa `.includes()` sobre termos
curtos e genéricos (`ok`, `tá`, `pode`, `foi`) — uma mensagem longa e ambígua contendo um desses
termos embutido (ex: "tá, mas antes preciso saber se pode com álcool") também dispararia o
fast-path. Como este fast-path age **sem** a camada de bom senso do LLM (diferente do fluxo atual,
onde o Claude decide a ação final), um falso positivo aqui teria efeito mais direto.

**Decisão:** não implementar nenhum gate de ambiguidade agora — não há evidência empírica de que
esse caso ocorra na prática, e adicionar rigor para um problema hipotético contraria o princípio
de decisão empírica já estabelecido (validar em produção, não pré-validar teoricamente).

**Se, após observação em produção, esse padrão aparecer de fato** (confirmações incorretas por
mensagens ambíguas contendo termos soltos), a correção considerada foi: função adicional que exige
mensagem curta (limiar a definir com dados reais, ponto de partida sugerido: ~4 palavras) e ausência
de marcadores de ressalva/condicional (`mas`, `só se`, `antes de`, `?`, etc.) antes de confirmar
sem LLM; caso contrário, cai no fluxo já existente (`handlePrincipal` com bloco `[ref-retro:]`).
Esse desenho fica registrado aqui apenas como referência — **não faz parte desta implementação**.
Sem ID de backlog próprio até que haja evidência justificando abrir um item.