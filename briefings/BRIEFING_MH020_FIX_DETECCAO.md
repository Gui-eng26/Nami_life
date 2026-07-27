# BRIEFING — MH-020 (correção): detecção robusta + trava no principal + re-orientação de confirmação

> **Contexto:** sessão v21 (26/07/2026). O MH-020 (exclusão de conta LGPD) foi implantado e passou
> na maioria dos cenários de validação em produção — MAS um teste real expôs um **falha crítica de
> LGPD**: a Nami afirmou "sua conta foi excluída com sucesso" **sem ter excluído nada**, e no "olá"
> seguinte mostrou as doses do usuário. Falsa confirmação de exclusão é o pior caso possível para
> uma feature de LGPD.
>
> **Status do MH-020:** permanece `em_validacao` (NÃO resolvido). Sem usuários reais ainda (pré-beta),
> mas é **bloqueante para abrir a beta**.

---

## 1. Causa raiz (confirmada com evidência real — `agent_logs` + export do WhatsApp)

Linha do tempo real do usuário de teste "Teste" (`user_id 2cdce41c-...`), 26/07 22:50 UTC:

1. **"Quero me descadrastar"** → `agent: principal`, estado `idle`.
   - Typo: "descad**r**astar" (R trocada). O pré-filtro determinístico `pareceExclusaoConta`
     (estágio 1) é uma **lista fixa** — "descadastrar" está lá, "descadrastar" não bate → estágio 1
     retornou `false` → o portão nem chamou o estágio 2 (LLM) → a mensagem caiu no `else` do
     `routeMessage` → `classificarIntencaoComContexto` → como o inventário do classificador **não
     conhece exclusão de conta**, o melhor destino possível foi `principal`.
   - O `principal`, ensinado pela nova seção LGPD do prompt, **improvisou o diálogo de exclusão**:
     pediu a palavra CONFIRMAR e setou `newState: "confirming"` + `context:
     {"aguardando":"confirmacao_exclusao_conta"}` — um **pseudo-estado inventado**. Nenhum branch do
     router lê essa chave; o gatilho real é a *string* de estado `aguardando_confirmacao_exclusao`,
     que nunca foi setada.

2. **"Sim"** → `agent: principal`, estado `confirming`.
   - Estado não é `aguardando_confirmacao_exclusao` → branch de exclusão não roda. `pareceExclusaoConta("sim")`
     = false → portão não dispara. Cai no `else` → classificador → `principal`, que lê no histórico
     que "tinha pedido CONFIRMAR" e **alucina a mensagem de sucesso**: "Sua conta foi excluída com
     sucesso… dados apagados permanentemente." **`excluirContaUsuario` NUNCA foi chamada** (agente é
     `principal`, não `exclusao_conta`).

3. **"Ola"** → `principal` mostrou as doses de Losartana → **prova de que o usuário nunca foi apagado.**

### Duas falhas que se combinam

- **Falha 1 — detecção frágil (viola o princípio 5).** Ao criar a capacidade `exclusao_conta`, nós
  a adicionamos como portão determinístico (estágio 1) e **não a registramos no inventário do
  `classificarIntencaoComContexto`**. O classificador central — a mesma segunda camada semântica que
  o `configuracao` usa via `despacharEscalada` — **rodou** para a mensagem que falhou, mas era
  incapaz de rotear para a exclusão porque não sabe que ela existe. Resultado: qualquer typo/fraseado
  fora da lista fixa vaza para o `principal`.
- **Falha 2 — o principal encena e afirma exclusão (viola os princípios 11/13).** A seção LGPD deu
  ao principal conhecimento da feature sem uma trava. Ele conduz a confirmação (pede CONFIRMAR),
  **afirma** que apagou (mensagem de resultado nascida de geração livre do LLM, nunca de leitura
  determinística pós-ação) e ainda **inventa um pseudo-estado** no `context` para sustentar a ilusão
  por vários turnos.

---

## 2. Correção (3 partes)

### PARTE A — Trava dura no prompt do `principal` (fecha a catástrofe)

Fecha a Falha 2. Mesmo que a detecção falhe, o principal nunca mais poderá fingir uma exclusão.

**Arquivo:** `src/prompts.js` — adicionar ao `NAMI_SYSTEM_PROMPT`, logo após a seção
`DADOS E PRIVACIDADE (LGPD):` (o texto abaixo é literal, colar como está):

```
REGRA ABSOLUTA — EXCLUSÃO DE CONTA (você NÃO conduz, NÃO confirma, NÃO executa):
A exclusão de conta / apagamento de dados do usuário é feita SOMENTE por um fluxo separado do
sistema — NUNCA por você. Você está TERMINANTEMENTE PROIBIDA de:
- Pedir para o usuário digitar "CONFIRMAR" (ou qualquer palavra de confirmação de exclusão);
- Afirmar, em qualquer hipótese, que a conta foi excluída ou que os dados foram apagados
  (ex: "sua conta foi excluída", "seus dados foram apagados", "excluí tudo");
- Encenar ou simular o passo a passo de uma exclusão;
- Usar o campo context para fingir que está aguardando uma confirmação de exclusão
  (ex: {"aguardando":"confirmacao_exclusao_conta"}). Isso é proibido.
Você PODE apenas INFORMAR que esse direito existe: se perguntarem, diga que o usuário pode excluir
tudo a qualquer momento e que basta pedir (ex: "é só dizer: quero excluir minha conta"). Mas você
NÃO conduz o processo — quem cuida disso é o sistema. Se o usuário demonstrar que quer excluir,
apenas reconheça de forma breve e natural, sem inventar confirmação nem resultado.
```

### PARTE B — Registrar `excluir_conta` no inventário do classificador central (cumpre o princípio 5)

Fecha a Falha 1. Torna a detecção robusta a typo/fraseado no caminho `idle`/geral e nas escaladas
mid-flow. O portão early (estágios 1+2) **continua existindo** — seu papel passa a ser só a
precedência dentro de fluxos que não passam pelo classificador (ex: `adding_med`). Os dois caminhos
apontam para o mesmo `handleExclusaoConta` (redundância proposital de defesa numa feature crítica).

**Arquivo:** `src/router.js`

**B.1 — Prompt do `classificarIntencaoComContexto`:** adicionar `excluir_conta` à lista de agentes
(logo após a linha do agente `principal`, antes de `FUNCIONALIDADES QUE A NAMI AINDA NÃO TEM`):

```
- excluir_conta: o usuário quer EXCLUIR A CONTA dele / apagar TODOS os dados dele da Nami / se
  descadastrar por completo da Nami. Ex: "quero excluir minha conta", "apaga todos os meus dados",
  "quero me descadastrar da Nami", "cancelar meu cadastro na Nami", "não quero mais usar a Nami,
  pode apagar tudo". NÃO confundir com: excluir/remover UM remédio, lembrete ou horário (isso é
  configuracao); nem com cancelar um cadastro de medicamento em andamento (isso NÃO é exclusão de
  conta — geralmente é abortar o fluxo de cadastro).
```

E atualizar a linha do formato JSON no fim do prompt para incluir `excluir_conta` no enum de `agente`:

```
{"agente": "cadastro|relatorios|configuracao|principal|excluir_conta|nao_suportado", "subtipoRelatorio": "tomei_hoje|meus_remedios|estoque|proximo_remedio|adesao|progresso_tratamento|null"}
```

**B.2 — Array de validação:** na função, atualizar `agentesValidos`:

```javascript
const agentesValidos = ['cadastro', 'relatorios', 'configuracao', 'principal', 'excluir_conta', 'nao_suportado'];
```

**B.3 — Tratar o retorno `excluir_conta` nos 4 pontos que consomem o classificador.** Em cada um,
adicionar um ramo que chama o handler de exclusão (etapa `solicitar_confirmacao`). O handler já faz
`saveConversationState` para `aguardando_confirmacao_exclusao` internamente, então basta chamá-lo.

Bloco a inserir (ajustar indentação ao local):
```javascript
} else if (agenteSelecionado === 'excluir_conta') {
    agentName = 'exclusao_conta';
    console.log(`🗑️ [CLASSIFICADOR] Pedido de exclusão de conta — ${user.phone}`);
    const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
    response = r.response;
```

Os **4 pontos** onde esse ramo deve ser adicionado (todos já têm a cadeia
`if cadastro / else if relatorios / else if configuracao / else if nao_suportado / else principal`):

1. **`despacharEscalada`** (a escalada vinda de agentes mid-flow como `configuracao`). Adicionar o
   ramo `excluir_conta` junto dos demais. Como o handler seta o estado próprio, não precisa do
   `saveConversationState(idle)` antes; se o ramo cair depois do `saveConversationState(idle)` já
   existente, tudo bem — o handler sobrescreve para `aguardando_confirmacao_exclusao`.
2. **Branch `aguardando_periodo_adesao`** → dentro do `else { ... }` que trata o resultado do
   classificador.
3. **Branch `aguardando_escolha_tratamento`** → idem.
4. **`else` final do `routeMessage`** (item 6 — "Demais casos → classificador LLM"). **Este é o
   ponto onde a falha real ocorreu.**

> **Princípio 5 restaurado:** de agora em diante, qualquer alteração de capacidade do roteador deve
> atualizar o inventário do `classificarIntencaoComContexto` na MESMA mudança. Esta correção é
> justamente o conserto da omissão cometida ao criar a feature.

### PARTE C — Re-orientação na confirmação (o polimento de UX pedido)

Endurece o handler real para o caso "sim" (afirmativo que não é a palavra). Hoje, um "sim" no estado
`aguardando_confirmacao_exclusao` cai em "não confirmou → cancela". O comportamento desejado é
**re-orientar** o usuário a escrever CONFIRMAR, sem cancelar nem apagar.

**Arquivo:** `src/agentes/exclusaoConta.js`

**C.1** — Adicionar helper (logo após `confirmouExclusao`):

```javascript
// Afirmativo curto/ambíguo que NÃO é a palavra de confirmação — merece re-orientação,
// não cancelamento silencioso (ex: "sim", "ok", "pode", "quero").
function pareceAfirmativoAmbiguo(message) {
    if (!message) return false;
    const m = normalizar(message).trim();
    const termos = ['sim', 's', 'ok', 'okay', 'pode', 'pode sim', 'quero', 'quero sim',
        'isso', 'isso mesmo', 'claro', 'com certeza', 'aceito', 'positivo', 'uhum', 'aham',
        'blz', 'beleza', 'yes', 'sim quero', 'sim pode'];
    return termos.some(t => m === t || m.startsWith(t + ' '));
}
```

**C.2** — Substituir o bloco da etapa `'confirmar'` (o trecho que hoje começa em
`// etapa === 'confirmar'` e vai até logo antes de `// Confirmou explicitamente -> executa a exclusão atômica.`)
pela lógica de 3 buckets. Substituir ESTE trecho:

```javascript
    // etapa === 'confirmar'
    if (!confirmouExclusao(message)) {
        // Não confirmou -> cancela com segurança, volta pra idle (saída de emergência).
        await saveConversationState(user.id, { state: 'idle', context: {} });
        console.log(`🗑️ [EXCLUSAO-CONTA] Exclusão NÃO confirmada — cancelada — ${user.phone}`);

        const response =
`Que bom, ${firstName}! 😊 Não apaguei nada — seus dados e seus lembretes continuam todos aqui comigo.

Se precisar de qualquer coisa, é só falar. 🌿`;
        return { response, contaExcluida: false };
    }
```

POR este:

```javascript
    // etapa === 'confirmar' — 3 buckets:
    // (1) palavra explícita CONFIRMAR -> executa | (2) afirmativo ambíguo -> re-orienta (mantém estado)
    // (3) qualquer outra coisa (negação/desistência/outro assunto) -> cancela com segurança.

    // Bucket 2: afirmativo ambíguo que NÃO é a palavra -> re-orienta, NÃO altera o estado.
    if (!confirmouExclusao(message) && pareceAfirmativoAmbiguo(message)) {
        console.log(`🗑️ [EXCLUSAO-CONTA] Afirmativo ambíguo ("${message}") — re-orientando para CONFIRMAR — ${user.phone}`);
        const response =
`${firstName}, como essa ação apaga *tudo* e não tem como voltar atrás, preciso que você escreva exatamente a palavra *CONFIRMAR* para eu seguir. 🌿

Se mudou de ideia, é só me dizer qualquer outra coisa que eu deixo tudo como está. 💛`;
        return { response, contaExcluida: false };
    }

    // Bucket 3: não é a palavra e não é afirmativo ambíguo -> cancela com segurança (saída de emergência).
    if (!confirmouExclusao(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        console.log(`🗑️ [EXCLUSAO-CONTA] Exclusão NÃO confirmada — cancelada — ${user.phone}`);
        const response =
`Que bom, ${firstName}! 😊 Não apaguei nada — seus dados e seus lembretes continuam todos aqui comigo.

Se precisava de outra coisa, é só me dizer. 🌿`;
        return { response, contaExcluida: false };
    }
```

O bloco seguinte (`// Confirmou explicitamente -> executa a exclusão atômica.` com o `try/catch`)
permanece **inalterado**.

> Observação: o `pareceAfirmativoAmbiguo` roda só no estado de confirmação (dentro do handler), então
> não interfere em nenhum outro fluxo. "não"/"deixa"/"mudei de ideia" continuam caindo no bucket 3
> (cancelamento), porque `confirmouExclusao` já retorna false para eles e eles não são afirmativos
> ambíguos.

---

## 3. Checklist de reteste em produção (focado no que escapou)

Ordem: aplicar código (deploy) e retestar. Não há mudança de schema nesta correção.

**Detecção robusta (Parte B):**
1. "Quero me descadrastar" (com o typo) → deve cair em `agent: exclusao_conta` e usar o template
   REAL de confirmação ("…me responda com a palavra *CONFIRMAR*"). Conferir no `agent_logs` que o
   agente é `exclusao_conta` e o estado resultante é `aguardando_confirmacao_exclusao`.
2. Variações fora da lista fixa: "quero sumir da Nami", "não quero mais conta aqui", "encerra meu
   cadastro" → devem chegar ao fluxo de exclusão real.

**Re-orientação (Parte C):**
3. Pedir exclusão → responder "sim" → deve **re-orientar** ("escreva a palavra CONFIRMAR"), manter o
   estado, NÃO apagar, NÃO afirmar sucesso. Depois responder "CONFIRMAR" → exclusão real + mensagem
   de sucesso SEM nome + próxima mensagem cai no onboarding.
4. Pedir exclusão → "ok" / "pode" → mesma re-orientação.
5. Pedir exclusão → "não" / "deixa" / "mudei de ideia" → cancela com carinho (bucket 3), estado idle.

**Trava no principal (Parte A):**
6. Forçar uma frase de exclusão que possa escapar para o principal (se conseguir reproduzir) → o
   principal NÃO pode pedir CONFIRMAR nem afirmar que apagou. No pior caso ele apenas reconhece.
   Conferir que nunca aparece "sua conta foi excluída" vindo de `agent: principal`.

**Não-regressão (garantir que a Parte B não roubou intenções de config):**
7. "excluir a dipirona" / "apagar o lembrete das 8h" → devem continuar indo para `configuracao`
   (NÃO para exclusão de conta).
8. No meio de um cadastro de remédio: "cancelar cadastro" → continua abortando o cadastro do
   remédio, NÃO a conta.

**Confirmação de exclusão real completa (repetir o cenário-chave do briefing original):**
9. Pedir exclusão → "CONFIRMAR" → conferir no Supabase que sumiram TODAS as tabelas do usuário
   (`users`, `medications`, `dose_logs`, `schedules`, `stock_movements`, `agent_logs`,
   `conversation_state`, `adesao_estado`, `intencoes_nao_suportadas`, `care_network`).

**Achados secundários a reconfirmar (mesma raiz — devem melhorar com a Parte B):**
- "Descadastrar" sozinho (que antes foi para `cadastro`) → reavaliar destino.
- "Quais dados vcs guardam?" (que numa das vezes recebeu "não entendi") → reavaliar.
  Se algum persistir após a Parte B, registrar como item de backlog próprio.

---

## 4. Atualização de `backlog_items` (escrita exclusiva do Claude Code)

**MH-020** (mantém `em_validacao` — a correção ainda precisa passar no reteste acima):
- `notas` → (append) "Validação v21 expôs falha crítica: mensagem de exclusão com typo/fraseado fora
  da lista fixa escapava o portão determinístico e caía no principal, que ENCENAVA a exclusão e
  AFIRMAVA falso sucesso (sem apagar nada) — falsa confirmação de exclusão (pior caso LGPD). Causa
  raiz: (1) capacidade exclusao_conta não estava no inventário do classificarIntencaoComContexto
  (violação do princípio 5); (2) principal sem trava para não conduzir/afirmar exclusão (violação
  dos princípios 11/13). Correção (BRIEFING_MH020_FIX_DETECCAO): Parte A trava no NAMI_SYSTEM_PROMPT,
  Parte B registra excluir_conta no classificador central + 4 call sites, Parte C re-orientação a
  CONFIRMAR para afirmativo ambíguo. Aguardando reteste em produção."

Sem novos itens de backlog nesta correção (os achados secundários são da mesma raiz e devem ser
resolvidos pela Parte B — só registrar se persistirem).

---

## 5. Resumo dos arquivos tocados

| Arquivo | Mudança |
|---|---|
| `src/prompts.js` | **Parte A** — regra absoluta proibindo o principal de conduzir/afirmar/encenar exclusão |
| `src/router.js` | **Parte B** — `excluir_conta` no inventário + `agentesValidos` + 4 call sites do classificador |
| `src/agentes/exclusaoConta.js` | **Parte C** — helper `pareceAfirmativoAmbiguo` + 3 buckets na etapa `confirmar` |

**Princípios aplicados/restaurados:** 5 (inventário do roteador atualizado junto com a capacidade —
o conserto central), 11/13 (mensagem de resultado de ação crítica nunca de geração livre do LLM —
Parte A), 14 (classificação semântica no lugar de lista fixa frágil — Parte B), 1 (resolve a classe:
qualquer fraseado/typo de exclusão, não só o caso do teste).