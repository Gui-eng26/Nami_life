# BRIEFING 2 — BUG-054: Eliminação do `ambiguo` e criação do `esclarecer_pausar_encerrar`

**Sessão:** v10 — 23/06/2026  
**Arquivo afetado:** `src/agentes/configuracao.js`

---

## Contexto

O `classificarIntencao` do `agente_configuracao` usa a categoria `ambiguo` como saída para incerteza. Na prática, o `ambiguo` virou um catch-all: capturou "encerrar" (BUG-047) e "alterar horário" indevidamente, travando o usuário em fluxos de esclarecimento.

O BUG-047 já corrigiu parte disso — ampliou exemplos e fez o `ambiguo` salvar `identif_intencao` (não mais `identif_acao`), então o usuário não fica mais preso em loop. Mas o conceito de `ambiguo` continua amplo demais e ainda captura intenções claras. Os testes recentes confirmaram: "Encerrar" sozinho ainda retornou `ambiguo` (log 16:40:29) — só "Encerrar tratamento" foi classificado corretamente.

Este briefing elimina o `ambiguo` como categoria genérica e o substitui por `esclarecer_pausar_encerrar` — estritamente reservado para o único caso genuinamente ambíguo: "parar" vago sem qualificador temporal.

**Escopo:** este briefing trata APENAS o `classificarIntencao` do `agente_configuracao`. A funcionalidade `nao_suportado` (intenções fora de escopo) e a arquitetura de histórico conversacional são do Briefing 3 — não fazem parte deste.

---

## Causa raiz confirmada

**Evidência nos logs (16:40:20–16:40:50):**
```
"Encerrar" → {"acao":"ambiguo",...}      ← deveria ser "encerrar"
"Encerrar tratamento" → {"acao":"encerrar",...}   ← só funcionou com a palavra completa
```

**Análise da causa raiz no contexto do projeto:**

O `ambiguo` foi criado para um medo que, na prática, raramente se confirma: o de que "parar" pudesse ser pausar ou encerrar. Mas o prompt o definiu de forma que o LLM o usa sempre que tem qualquer incerteza — transformando palavras claras em ambíguas.

A realidade das mensagens que chegam ao `classificarIntencao`:

- **Tipo 1 — Intenção explícita (maioria):** "encerrar", "pausar", "alterar horário", "remover o das 8h". Sem ambiguidade. O verbo carrega a intenção.
- **Tipo 2 — "Parar" vago com pista temporal:** "não quero mais, já terminei" (→ encerrar), "para essa semana" (→ pausar). A pista resolve.
- **Tipo 3 — "Parar" vago SEM pista:** "quero parar com o losartana", "cancela o dipirona". Genuinamente ambíguo entre pausar e encerrar.

O `ambiguo` deveria existir apenas para o Tipo 3 — mas hoje captura também Tipos 1 e 2.

---

## Solução

### 1. Eliminar `ambiguo`, criar `esclarecer_pausar_encerrar`

Reescrever o prompt do `classificarIntencao` para:
- Classificar Tipo 1 diretamente (verbo claro → ação direta)
- Classificar Tipo 2 pela pista temporal (interpretação mais provável)
- Reservar `esclarecer_pausar_encerrar` apenas para Tipo 3

```javascript
async function classificarIntencao(message, medicamentosDisponiveis) {
    const listaMeds = medicamentosDisponiveis.map(m => m.nome).join(', ') || 'nenhum';

    const systemPrompt = `Você é um classificador de intenções para um assistente de saúde.
O usuário quer fazer algo com seus lembretes ou tratamentos.

Medicamentos cadastrados: ${listaMeds}

Responda APENAS com JSON válido, sem markdown, sem explicações:
{
  "acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "remover_horario" | "adicionar_horario" | "redefinir_horarios" | "esclarecer_pausar_encerrar",
  "medicamentoMencionado": "nome mencionado ou null",
  "novoHorario": "HH:MM ou null"
}

Definições:
- pausar: parar lembretes temporariamente, com intenção de retomar.
  Ex: "cancela o lembrete", "para de me lembrar", "quero pausar", "suspender os avisos", "para essa semana", "não quero ser lembrado por uns dias"

- reativar: ativar lembretes pausados.
  Ex: "volta os lembretes", "ativa de novo", "reativar", "quero retomar"

- encerrar: terminar o tratamento definitivamente.
  Ex: "não vou mais tomar", "encerrar", "encerrar tratamento", "terminei o tratamento", "já acabei de tomar esse", "não preciso mais desse remédio porque terminei"

- alterar_horario: mudar UM horário específico para outro — com ou sem horário explícito.
  Ex com horário: "muda das 8 para 9", "trocar o das 20h para 22h"
  Ex sem horário: "quero alterar horário", "mudar horário", "trocar horário"

- remover_horario: apagar um horário específico sem substituir — com ou sem horário explícito.
  Ex com horário: "tirar o das 8h", "apagar o das 20"
  Ex sem horário: "quero remover um horário", "excluir um lembrete"

- adicionar_horario: acrescentar horário novo sem mexer nos existentes — com ou sem horário explícito.
  Ex com horário: "quero tomar às 20 também", "adicionar lembrete às 14h"
  Ex sem horário: "quero adicionar um horário", "incluir mais um lembrete"

- redefinir_horarios: substituir TODOS os horários ou mudar a frequência de doses.
  Ex: "agora vou tomar 3x ao dia", "mudar para 6h, 14h e 22h", "mudar todos os horários"

- esclarecer_pausar_encerrar: USAR APENAS quando o usuário quer parar de tomar/ser lembrado, mas NÃO dá nenhuma pista se é TEMPORÁRIO (pausar) ou DEFINITIVO (encerrar).
  Ex: "quero parar com o losartana", "cancela o dipirona", "não quero mais esse remédio" (sem dizer se terminou ou se é pausa)

REGRAS DE DECISÃO:
1. Se o verbo é claro (encerrar, pausar, alterar, remover, adicionar, redefinir, reativar) → retorne a ação diretamente. NUNCA use esclarecer nesses casos.
2. "Encerrar" sozinho = encerrar. "Pausar" sozinho = pausar. Não exija a palavra "tratamento".
3. Se o usuário quer parar MAS dá pista temporal:
   - pista de definitivo ("já terminei", "acabou", "não preciso mais porque terminei") → encerrar
   - pista de temporário ("essa semana", "por uns dias", "por enquanto") → pausar
4. Só use esclarecer_pausar_encerrar quando quer parar e NÃO há nenhuma pista temporal.
5. Intenção de horário sem detalhes → classifique pelo tipo de operação, nunca esclarecer.`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 150,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }]
        });
        const raw = response.content[0].text.trim();
        const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        return parsed;
    } catch (e) {
        console.error(`❌ Erro ao classificar intenção: ${e.message}`);
        // Fallback seguro: tratar como esclarecimento em vez de assumir uma ação
        return { acao: 'esclarecer_pausar_encerrar', medicamentoMencionado: null, novoHorario: null };
    }
}
```

### 2. Atualizar o handler — renomear o bloco `ambiguo` para `esclarecer_pausar_encerrar`

No `identif_intencao`, o bloco que hoje trata `acao === 'ambiguo'` passa a tratar `acao === 'esclarecer_pausar_encerrar'`. O comportamento de salvar `identif_intencao` com o medicamento no contexto permanece — já está correto desde o BUG-047:

```javascript
// Intenção de parar sem pista temporal → perguntar se quer pausar ou encerrar
if (acao === 'esclarecer_pausar_encerrar') {
    const med = medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null;
    const nomeExibir = med?.nome || medicamentoMencionado || 'esse medicamento';
    await saveConversationState(user.id, {
        state: 'configurando',
        context: {
            etapa: 'identif_intencao',
            medicationId: med?.id || null,
            medicationNome: nomeExibir,
            schedulesAtivos: med ? (med.schedules || []).filter(s => s.ativo) : []
        }
    });
    return `Entendido, ${firstName}! Sobre o *${nomeExibir}*, você quer:\n\n• *Pausar* os lembretes (temporário — você pode retomar quando quiser)\n• *Encerrar* o tratamento definitivamente\n\nO que prefere?`;
}
```

### 3. Garantir que a resposta ao esclarecimento volta ao classificador

Quando o usuário responde "pausar" ou "encerrar" após o esclarecimento, a mensagem volta a `identif_intencao` (porque foi o estado salvo) e passa pelo `classificarIntencao` novamente. Com o prompt corrigido, "pausar" → `pausar` e "encerrar" → `encerrar` — direto, sem voltar a esclarecer.

O medicamento já está no contexto (`context.medicationId`), então `continuarComAcao` o utiliza sem precisar perguntar de novo. Isso já funciona pela lógica do `medDoContexto` implementada no BUG-047 — verificar que permanece intacta.

---

## Casos de teste — fluxo completo

| Mensagem | Classificação esperada | Comportamento |
|---|---|---|
| "Encerrar" | `encerrar` | Vai direto para identificar medicamento (não esclarece) |
| "Encerrar tratamento" | `encerrar` | Idem |
| "Pausar" | `pausar` | Direto |
| "Quero alterar horário" | `alterar_horario` | Direto |
| "Já terminei de tomar o dipirona" | `encerrar` | Pista "já terminei" → definitivo |
| "Para os lembretes essa semana" | `pausar` | Pista "essa semana" → temporário |
| "Quero parar com o losartana" | `esclarecer_pausar_encerrar` | Pergunta pausar vs encerrar |
| Após esclarecer, usuário diz "pausar" | `pausar` | Reclassificado, medicamento do contexto |
| Após esclarecer, usuário diz "na verdade quero mudar o horário" | `alterar_horario` | Reclassificado corretamente — não trava |

---

## Impacto em outros sistemas — verificado

| Sistema | Impacto | Justificativa |
|---|---|---|
| Handler `identif_intencao` | Renomeação do bloco `ambiguo` → `esclarecer_pausar_encerrar` | Comportamento idêntico, só o nome e o critério de disparo mudam |
| `continuarComAcao` | Nenhum | Não recebe mais `ambiguo`; recebe ações concretas |
| `medDoContexto` (BUG-047) | Nenhum | Lógica de recuperar medicamento do contexto permanece |
| Outros agentes | Nenhum | `classificarIntencao` é interno ao `configuracao` |
| Fallback de erro | Melhorado | Em caso de erro de parse, cai em `esclarecer_pausar_encerrar` (pergunta) em vez de assumir ação errada |

---

## O que este briefing NÃO cobre

- **`nao_suportado`** (intenções fora de escopo como "alterar tempo de tratamento") → Briefing 3
- **Histórico conversacional / redefinição do `idle`** → Briefing 3
- **Inventário de capacidades no roteador** → Briefing 3

---

## Validação esperada após implementação

1. "Encerrar" → `encerrar` diretamente, sem passar por esclarecimento ✅
2. "Pausar" → `pausar` diretamente ✅
3. "Quero parar com o dipirona" (vago) → pergunta pausar vs encerrar ✅
4. Após a pergunta, "encerrar" → encerra o medicamento do contexto ✅
5. Após a pergunta, "quero alterar horário" → reclassifica para alterar_horario, não trava ✅
6. "Já acabei o tratamento do dipirona" → `encerrar` (pista de definitivo) ✅

---

**Comando para Claude Code:**  
`Leia o briefings/BRIEFING_BUG054.md e implemente.`