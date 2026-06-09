# Briefing — agente_cadastro

Este documento é um briefing de implementação para o Claude Code.
Leia o CONTEXT.md e o BRIEFING_V2.md antes de começar.

---

## Objetivo

Criar o `agente_cadastro` — um subagente dedicado ao fluxo completo de cadastro
de medicamentos, substituindo a lógica de cadastro atualmente embutida no
`agente_principal` (src/agentes/principal.js) e no `prompts.js`.

---

## Contexto da arquitetura atual

O fluxo de cadastro hoje vive no `agente_principal` via states `adding_med` e
`confirming`. Isso funciona mas mistura responsabilidades — o agente principal
precisa ao mesmo tempo conversar sobre doses, histórico E gerenciar cadastro.

Após esta implementação:
- `agente_principal` → conversação geral, confirmação de doses, consultas
- `agente_cadastro` → fluxo completo de cadastro de medicamentos

---

## Arquivos a criar

```
src/agentes/cadastro.js   ← novo
```

## Arquivos a modificar

```
src/router.js             ← adicionar rota para agente_cadastro
src/agentes/principal.js  ← remover lógica de cadastro (states adding_med/confirming)
src/prompts.js            ← remover instruções de cadastro do prompt principal
```

---

## Schema do banco relevante

```sql
-- medications
id, user_id, nome, dosagem, instrucoes, estoque_atual,
estoque_minimo (default 7), ativo, created_at

-- schedules
id, medication_id, horario (time HH:MM), dias_semana (text[]), ativo
```

Não há campo de tipo_tratamento ainda — será necessário adicionar:
```sql
ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS tipo_tratamento text DEFAULT 'continuo',
  ADD COLUMN IF NOT EXISTS tratamento_dias integer,
  ADD COLUMN IF NOT EXISTS tratamento_fim date,
  ADD COLUMN IF NOT EXISTS forma_farmaceutica text DEFAULT 'comprimido';
```

Rodar esse SQL no Supabase antes de implementar o agente.

---

## Fluxo de cadastro — etapas

O agente coleta uma informação por mensagem, nesta ordem:

```
Etapa 1: cad_nome
  → Pergunta o nome do medicamento

Etapa 2: cad_forma
  → Pergunta a forma farmacêutica
  → Opções sugeridas: comprimido, cápsula, colírio, gotas, pomada, injetável, xarope, outro
  → Se o usuário já informou na etapa 1 (ex: "colirio de Voltaren"), pula esta etapa

Etapa 3: cad_dosagem
  → Pergunta a dosagem (ex: 50mg, 100mg, 0,5%)
  → Adaptar a pergunta à forma farmacêutica:
    - comprimido/cápsula → "Qual a dosagem? (ex: 50mg)"
    - colírio/gotas → "Qual a concentração? (ex: 0,5%)"
    - pomada → "Qual a concentração? (ex: 1%)"

Etapa 4: cad_tipo_tratamento
  → Pergunta se é uso contínuo ou tratamento com prazo
  → Mensagem sugerida:
    "Este remédio é de uso contínuo (sem previsão de parada) ou tem prazo
     determinado, como um antibiótico ou anti-inflamatório?"
  → Se temporário: perguntar quantos dias dura o tratamento

Etapa 5: cad_horarios
  → Pergunta os horários de uso
  → Sempre salvar como array de strings ["HH:MM"]
  → Aceitar linguagem natural: "de manhã e à noite" → ["07:00", "21:00"]

Etapa 6: cad_estoque
  → Pergunta a quantidade atual em estoque
  → Adaptar à forma farmacêutica:
    - comprimido/cápsula → "Quantos comprimidos você tem agora?"
    - colírio/gotas → "Quantos frascos você tem agora?"
    - pomada → "Quantos tubos você tem agora?"

Etapa 7: cad_confirmacao
  → Exibe resumo completo UMA ÚNICA VEZ
  → Formato do resumo:
    "Deixa eu confirmar tudo antes de salvar:
     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: {continuo | X dias}
     ⏰ Horários: {horarios}
     📦 Estoque: {quantidade}
     Está tudo certinho?"
  → Aguarda confirmação do usuário

Etapa 8: cad_salvo
  → Usuário confirma → disparar SAVE_MEDICATION
  → Marcar onboarded=true se ainda não estiver
  → Limpar state → idle
  → Passar controle para agente_principal
```

---

## Detecção de intenção de cadastro

O roteador deve detectar intenção de cadastro nas seguintes situações:

1. `state === 'adding_med'` — já estava em fluxo de cadastro
2. `state === 'idle'` + mensagem contém intenção explícita:
   - "quero cadastrar", "adicionar remédio", "novo remédio"
   - "quero registrar", "tenho um remédio novo"
   - Usuário lista um remédio sem contexto claro ("Losartana 50mg")

Para o item 2, o roteador deve fazer uma classificação simples de intenção
antes de despachar — pode usar uma chamada leve ao Claude ou regex.

---

## Arquivo: src/agentes/cadastro.js

```javascript
// Estrutura esperada

import Anthropic from '@anthropic-ai/sdk';
import { saveConversationState, saveMedication, saveSchedule,
         replaceMedication, updateUser } from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function handleCadastro({ user, message, state, context }) {
  const etapaAtual = context?.etapa || 'cad_nome';

  // Chama Claude com system prompt focado em cadastro
  const response = await callClaude({ user, message, etapa: etapaAtual, context });

  // Atualiza estado no banco
  await saveConversationState(user.id, {
    state: response.proximaEtapa === 'idle' ? 'idle' : 'adding_med',
    context: response.novoContext
  });

  // Executa ação se houver
  if (response.action) {
    await processarAcao(response.action, user);
  }

  return response.message;
}
```

---

## System prompt do agente_cadastro

O system prompt deve ser focado EXCLUSIVAMENTE em cadastro.
Tom: acolhedor, paciente, claro. Linguagem simples.

```
Você é a Nami, assistente de saúde. Você está no fluxo de cadastro de um
novo medicamento.

Sua única função agora é coletar as informações necessárias para cadastrar
o medicamento corretamente, uma pergunta por vez.

Etapa atual: {etapa}
Contexto coletado até agora: {contexto}
Nome do usuário: {nome}

REGRAS:
- Colete UMA informação por mensagem
- Seja clara e direta nas perguntas
- Adapte a linguagem à forma farmacêutica quando relevante
- NÃO confirme parcialmente — só mostre o resumo completo na etapa cad_confirmacao
- Se o usuário quiser cancelar ("deixa pra lá", "cancela"), encerre o fluxo com gentileza

FORMATO DE RESPOSTA — JSON válido, sem markdown, sem backticks:
{
  "message": "mensagem para o usuário",
  "proximaEtapa": "cad_nome | cad_forma | cad_dosagem | cad_tipo_tratamento | cad_horarios | cad_estoque | cad_confirmacao | cad_salvo | idle",
  "novoContext": {
    "etapa": "...",
    "nome": "...",
    "forma": "...",
    "dosagem": "...",
    "tipo_tratamento": "continuo | temporario",
    "tratamento_dias": null,
    "horarios": [],
    "estoque": null
  },
  "action": null
}

O campo action só é preenchido em cad_salvo:
{
  "type": "SAVE_MEDICATION",
  "nome": "",
  "forma": "",
  "dosagem": "",
  "tipo_tratamento": "",
  "tratamento_dias": null,
  "horarios": ["HH:MM"],
  "estoque": 0
}
```

---

## Atualização do router.js

Adicionar ao fluxo de roteamento:

```javascript
// Dentro de routeMessage():

// Verifica se está em fluxo de cadastro
if (state?.state === 'adding_med') {
  agentName = 'cadastro';
  response = await handleCadastro({
    user,
    message,
    state,
    context: state?.context || {}
  });
}
// Verifica intenção de cadastro em estado idle
else if (!user.onboarded || detectarIntencaoCadastro(message)) {
  agentName = 'cadastro';
  response = await handleCadastro({
    user,
    message,
    state,
    context: { etapa: 'cad_nome' }
  });
}

// Função auxiliar de detecção de intenção
function detectarIntencaoCadastro(message) {
  const termos = [
    'cadastrar', 'adicionar remédio', 'novo remédio', 'registrar remédio',
    'quero cadastrar', 'tenho um remédio', 'adicionar medicamento'
  ];
  const msg = message.toLowerCase();
  return termos.some(t => msg.includes(t));
}
```

---

## Limpeza do agente_principal e prompts.js

Após criar o agente_cadastro:

1. Em `src/agentes/principal.js`:
   - Remover processamento dos states `adding_med` e `confirming`
   - Remover ações `SAVE_MEDICATION`, `REPLACE_MEDICATION`, `ADD_SCHEDULE`
   - Manter: `CONFIRM_DOSE`, `SET_USER_NAME`, consultas de histórico

2. Em `src/prompts.js`:
   - Remover: FLUXO DE CADASTRO DE MEDICAMENTO
   - Remover: FLUXO DE MEDICAMENTO DUPLICADO
   - Remover: ações SAVE_MEDICATION, REPLACE_MEDICATION, ADD_SCHEDULE
   - Manter: CONFIRM_DOSE, SET_USER_NAME, consultas, personalidade

---

## Funções novas necessárias no database.js

Verificar se já existem antes de criar:

```javascript
// Atualizar saveMedication para aceitar novos campos
export async function saveMedication({
  userId, nome, forma, dosagem, instrucoes,
  tipo_tratamento, tratamento_dias, estoque
}) { ... }
```

---

## SQL a rodar no Supabase ANTES de implementar

```sql
ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS tipo_tratamento text DEFAULT 'continuo',
  ADD COLUMN IF NOT EXISTS tratamento_dias integer,
  ADD COLUMN IF NOT EXISTS tratamento_fim date,
  ADD COLUMN IF NOT EXISTS forma_farmaceutica text DEFAULT 'comprimido';
```

---

## Ordem de implementação

1. Rodar o SQL no Supabase
2. Atualizar `saveMedication` no database.js para aceitar novos campos
3. Criar `src/agentes/cadastro.js`
4. Atualizar `src/router.js` para rotear para agente_cadastro
5. Limpar `src/agentes/principal.js` (remover lógica de cadastro)
6. Limpar `src/prompts.js` (remover fluxo de cadastro)
7. Testar com usuário novo cadastrando um medicamento
8. Testar com usuário existente adicionando novo medicamento

---

## Critérios de sucesso

- Usuário consegue cadastrar medicamento passando por todas as 8 etapas
- Pergunta de tipo de tratamento aparece corretamente (etapa 4)
- Forma farmacêutica é registrada e influencia a linguagem das perguntas
- Resumo de confirmação aparece UMA ÚNICA VEZ ao final
- Usuário existente continua funcionando normalmente (sem regressão)
- State volta para idle após cadastro concluído
- agente_principal não interfere durante o fluxo de cadastro
