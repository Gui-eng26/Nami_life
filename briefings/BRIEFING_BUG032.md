# BRIEFING — BUG-032
## Julia cadastro: intenção não detectada + estado fantasma `cadastrando_medicamento`

**Data:** 15/06/2026  
**Origem:** Análise de logs Railway (12:33–12:37 UTC)  
**Escopo:** `src/router.js`, `src/prompts.js`  
**Complexidade:** Baixa — sem alteração de banco, sem novos agentes

---

## 1. Contexto

Julia enviou "Bom dia Nami, podemos adicionar mais um medicamento?" (12:33 UTC).  
O router não detectou intenção de cadastro → caiu no `agente_principal`.  
O principal criou o estado `cadastrando_medicamento` (estado não documentado, fora do schema) e tentou conduzir um cadastro conversacional sem estrutura, pedindo confirmação 4 vezes sem nunca salvar o medicamento no banco.

---

## 2. Causa Raiz

### Causa A — `detectarIntencaoCadastro` exige frase exata

```js
// ATUAL — lista de frases exatas
const termos = [
    'cadastrar', 'adicionar remédio', 'novo remédio', 'registrar remédio',
    'quero cadastrar', 'tenho um remédio', 'adicionar medicamento',
    'novo medicamento', 'registrar medicamento', 'quero adicionar'
];
```

"adicionar mais um medicamento" não bate em nenhum termo porque "mais um" fica entre "adicionar" e "medicamento". A função retorna `false` → cai no `agente_principal`.

### Causa B — `agente_principal` cria estado fantasma

O NAMI_SYSTEM_PROMPT define apenas `"idle | confirming"` como valores válidos de `newState`. Porém, o Claude ignorou essa restrição e retornou `newState: "cadastrando_medicamento"` — um estado inventado que o router não conhece.

Resultado: todas as mensagens seguintes da Julia cairam no case 6 do router ("Demais casos → agente_principal"), que continuou tentando cadastrar sem estrutura e sem action `SAVE_MEDICATION`. **O medicamento provavelmente não foi salvo.**

---

## 3. Solução

### 3.1 — `src/router.js`

**Mudança 1: expandir `detectarIntencaoCadastro` com termos flexíveis**

```js
// ANTES
function detectarIntencaoCadastro(message) {
    if (!message) return false;
    const termos = [
        'cadastrar', 'adicionar remédio', 'novo remédio', 'registrar remédio',
        'quero cadastrar', 'tenho um remédio', 'adicionar medicamento',
        'novo medicamento', 'registrar medicamento', 'quero adicionar'
    ];
    const msg = message.toLowerCase();
    return termos.some(t => msg.includes(t));
}

// DEPOIS
function detectarIntencaoCadastro(message) {
    if (!message) return false;
    const termos = [
        'cadastrar', 'adicionar remédio', 'novo remédio', 'registrar remédio',
        'quero cadastrar', 'tenho um remédio', 'adicionar medicamento',
        'novo medicamento', 'registrar medicamento', 'quero adicionar',
        // Variações com "mais um" e "outro"
        'adicionar mais', 'mais um remédio', 'mais um medicamento',
        'outro remédio', 'outro medicamento', 'incluir remédio',
        'incluir medicamento', 'colocar remédio', 'colocar medicamento',
        'inserir remédio', 'inserir medicamento'
    ];
    const msg = message.toLowerCase();
    return termos.some(t => msg.includes(t));
}
```

**Mudança 2: adicionar handler para estado `cadastrando_medicamento`**

Inserir como novo case logo após o handler de `adding_med` (case 3), antes do case de intenção idle:

```js
// Handler para estado fantasma criado pelo agente_principal
// Redireciona para o fluxo estruturado do agente_cadastro
} else if (currentState === 'cadastrando_medicamento') {
    agentName = 'cadastro';
    console.log(`💊 Roteando para cadastro (estado cadastrando_medicamento corrigido) — ${user.phone}`);
    response = await handleCadastro({
        user,
        message,
        state,
        context: { etapa: 'cad_nome' }  // reinicia do zero de forma estruturada
    });
```

---

### 3.2 — `src/prompts.js`

Reforçar o schema de `newState` e proibir o principal de tentar conduzir cadastros.

Localizar a linha:
```
"newState": "idle | confirming",
```

E substituir por:

```
"newState": "idle | confirming",
```
*(o valor não muda — mas adicionar imediatamente abaixo das AÇÕES DISPONÍVEIS o seguinte bloco)*

Localizar a seção `AÇÕES DISPONÍVEIS` e adicionar logo após ela:

```
REGRA ABSOLUTA — ESTADOS PERMITIDOS:
O campo newState SOMENTE pode receber os valores "idle" ou "confirming".
NUNCA use outros valores como "cadastrando_medicamento", "cadastro", "registrando" ou qualquer variação.

REGRA ABSOLUTA — CADASTRO DE MEDICAMENTOS:
Você NÃO conduz cadastros de medicamentos. Essa função pertence a outro agente.
Se o usuário quiser cadastrar um medicamento e você receber essa mensagem,
responda apenas: "Ótimo! Vamos cadastrar. Qual é o nome do medicamento?" e retorne
newState: "idle". O sistema vai rotear automaticamente para o agente correto.
NUNCA tente coletar etapas de cadastro (forma, dosagem, horário, estoque) — isso não é sua função.
```

---

## 4. Ordem de Execução

1. Implementar mudanças em `src/router.js` (expandir lista + novo handler)
2. Implementar mudança em `src/prompts.js` (reforço de regras)
3. Deploy
4. Validar

---

## 5. Validação Pós-Deploy

**Teste 1 — nova intenção detectada:**
Enviar "podemos adicionar mais um medicamento?" com estado `idle`.  
Log esperado: `💊 Roteando para cadastro (intenção detectada)`  
Em vez de: `🤖 Roteando para principal`

**Teste 2 — estado fantasma tratado:**
Forçar estado `cadastrando_medicamento` diretamente no Supabase para um usuário de teste:
```sql
UPDATE conversation_states 
SET state = 'cadastrando_medicamento' 
WHERE user_id = (SELECT id FROM users WHERE phone = '+5511941065858');
```
Depois enviar qualquer mensagem.  
Log esperado: `💊 Roteando para cadastro (estado cadastrando_medicamento corrigido)`

**Teste 3 — principal não conduz cadastro:**
Enviar "quero cadastrar" numa mensagem que caia no principal por algum motivo.  
O principal deve responder "Ótimo! Qual o nome do medicamento?" e retornar `newState: idle` — sem tentar coletar forma, dosagem, horário etc.

---

## 6. Observação — Medicamento da Julia

O cadastro da Julia feito às 12:33–12:37 UTC provavelmente **não foi salvo no banco** (nenhuma action `SAVE_MEDICATION` nos logs). Verificar na tabela `medications` se o Elani 28 existe para o user_id da Julia. Se não existir, Julia precisará cadastrar novamente após o fix.