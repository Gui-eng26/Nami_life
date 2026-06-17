# BRIEFING — AGENTE_CONFIGURACAO (v2)
## MH-014 + MH-015 + Encerrar Tratamento + Reativar Medicamento
## Arquitetura híbrida: detecção ampla no router + Claude para classificação

**Data:** 17/06/2026  
**Substitui:** BRIEFING_CONFIGURACAO.md (versão anterior — não implementar)  
**Escopo:** `src/database.js`, `src/router.js`, `src/agentes/configuracao.js` (NOVO), `src/prompts.js`  
**Complexidade:** Alta — novo agente com state machine + 1 chamada Claude para classificação inicial  
**Nenhuma alteração de banco necessária**

---

## 1. Arquitetura híbrida — por que e como

O usuário pode expressar intenções de configuração de infinitas formas:
- "não precisa me lembrar mais desse remédio"
- "tira o lembrete do Voltaren"
- "cancela os avisos do Cimegrip"
- "muda meu horário da Losartana pra 9h"

Uma lista fechada de termos nunca cobrirá todas as variações. A solução é dividir o trabalho:

**Router — detecção AMPLA (combinatória):**
Captura qualquer mensagem que contenha palavras de ação + palavras de objeto relacionadas a medicamentos/lembretes. Net cast largo — é melhor rotear um falso positivo para o agente (que vai pedir esclarecimento) do que perder um pedido legítimo.

**Agente — classificação PRECISA (Claude, 1 chamada):**
Na primeira etapa do fluxo, Claude recebe a mensagem e a lista de medicamentos do usuário e retorna JSON com: `acao`, `medicamentoMencionado`, `novoHorario`. O resto do fluxo é 100% determinístico — Claude só entra aqui.

**Por que não usar Claude para o fluxo inteiro:**
Ações de configuração alteram dados permanentemente. State machine determinístico garante que nenhuma alteração ocorra sem confirmação explícita do usuário.

---

## 2. O que este briefing implementa

| Feature | Exemplo de trigger | Ação no banco |
|---|---|---|
| Pausar lembretes | "não precisa me lembrar mais", "cancela o lembrete" | `schedules.ativo = false` |
| Reativar lembretes | "reativa o Voltaren", "volta os lembretes" | `schedules.ativo = true` |
| Encerrar tratamento | "não vou mais tomar o Cimegrip", "remove esse remédio" | `medications.ativo = false` + schedules desativados |
| Alterar horário | "muda meu horário da Losartana pra 9h" | `schedules.horario = '09:00:00'` |

**Fluxo universal — confirmação em 2 passos antes de qualquer alteração:**
```
Usuário: "não precisa me lembrar mais do Voltaren"
Nami:    "Só confirmar: vou pausar os lembretes do Voltaren (09:00 e 21:00). Confirmar?"
Usuário: "sim"
Nami:    "✅ Pronto! Lembretes do Voltaren pausados."
```

---

## 3. State machine completa

```
idle → detectarIntencaoConfiguracao() → [configurando]

etapas:
  identif_intencao    → chama Claude para classificar acao + medicamento + horário
  identif_acao        → usuário esclarece se quer pausar ou encerrar (quando ambíguo)
  identif_medicamento → usuário especifica qual medicamento (quando não ficou claro)
  identif_schedule    → usuário especifica qual horário alterar (múltiplos schedules)
  obter_horario       → usuário informa o novo horário
  confirm_acao        → usuário confirma ou cancela → executa + volta para idle
```

---

## 4. Mudanças por arquivo

### 4.1 — `src/database.js` — 4 novas funções

Adicionar após as funções de confirmação de dose:

```js
// ============================================================
// CONFIGURAÇÃO DE MEDICAMENTOS
// ============================================================

export async function pausarMedicamento(medicationId) {
    const { error } = await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
    if (error) throw new Error(`Erro ao pausar: ${error.message}`);
    console.log(`⏸️ Schedules pausados — medication: ${medicationId}`);
}

export async function reativarMedicamento(medicationId) {
    const { error } = await supabase
        .from('schedules')
        .update({ ativo: true })
        .eq('medication_id', medicationId);
    if (error) throw new Error(`Erro ao reativar: ${error.message}`);
    console.log(`▶️ Schedules reativados — medication: ${medicationId}`);
}

export async function encerrarTratamento(medicationId) {
    const { error: errMed } = await supabase
        .from('medications')
        .update({ ativo: false })
        .eq('id', medicationId);
    if (errMed) throw new Error(`Erro ao encerrar: ${errMed.message}`);

    const { error: errSched } = await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
    if (errSched) throw new Error(`Erro ao desativar schedules: ${errSched.message}`);

    console.log(`🔴 Tratamento encerrado — medication: ${medicationId}`);
}

export async function alterarHorarioSchedule(scheduleId, novoHorario) {
    const horarioFormatado = novoHorario.length === 5
        ? `${novoHorario}:00`
        : novoHorario;
    const { error } = await supabase
        .from('schedules')
        .update({ horario: horarioFormatado })
        .eq('id', scheduleId);
    if (error) throw new Error(`Erro ao alterar horário: ${error.message}`);
    console.log(`🕐 Horário alterado — schedule: ${scheduleId} → ${horarioFormatado}`);
}
```

---

### 4.2 — `src/router.js`

**Mudança 1: import do novo agente**

```js
import { handleConfiguracao } from './agentes/configuracao.js';
```

**Mudança 2: nova função `detectarIntencaoConfiguracao()`**

Adicionar após `detectarIntencaoCadastro`. Usa lógica combinatória — palavra de AÇÃO + palavra de OBJETO:

```js
function detectarIntencaoConfiguracao(message) {
    if (!message) return false;
    const msg = message.toLowerCase();

    // Casos diretos — detectados sem precisar de combinação
    const casosDiretos = [
        'pausar', 'reativar', 'encerrar tratamento',
        'alterar horário', 'alterar horario',
        'mudar horário', 'mudar horario',
        'trocar horário', 'trocar horario',
        'não vou mais tomar', 'nao vou mais tomar'
    ];
    if (casosDiretos.some(t => msg.includes(t))) return true;

    // Combinatório: palavra de ação + palavra de objeto
    const palavrasAcao = [
        'parar', 'cancela', 'cancelar', 'desativar', 'suspender',
        'tirar', 'remover', 'apagar', 'excluir', 'deletar',
        'encerrar', 'finalizar', 'acabar',
        'mudar', 'alterar', 'trocar', 'modificar',
        'ativar', 'retomar', 'voltar',
        'não preciso', 'nao preciso',
        'não precisa', 'nao precisa',
        'não quero mais', 'nao quero mais',
        'não me lembra', 'nao me lembra',
        'não me lembre', 'nao me lembre'
    ];
    const palavrasObjeto = [
        'lembrete', 'aviso', 'alarme', 'alerta', 'notificação', 'notificacao',
        'remédio', 'remedio', 'medicamento', 'tratamento',
        'horário', 'horario', 'hora'
    ];

    const temAcao = palavrasAcao.some(p => msg.includes(p));
    const temObjeto = palavrasObjeto.some(p => msg.includes(p));
    return temAcao && temObjeto;
}
```

**Mudança 3: dois novos cases em `routeMessage()`**

Inserir ANTES do case `adding_med`, logo após o handler `post_onboarding`:

```js
// CASE: usuário no meio de um fluxo de configuração
} else if (currentState === 'configurando') {
    agentName = 'configuracao';
    console.log(`⚙️ Roteando para configuração (estado configurando) — ${user.phone}`);
    response = await handleConfiguracao({
        user, message, state,
        context: state?.context || {}
    });

// CASE: usuário em idle com intenção de configuração detectada
} else if (currentState === 'idle' && detectarIntencaoConfiguracao(message)) {
    agentName = 'configuracao';
    console.log(`⚙️ Roteando para configuração (intenção detectada) — ${user.phone}`);
    response = await handleConfiguracao({
        user, message, state,
        context: { etapa: 'identif_intencao' }
    });
```

---

### 4.3 — `src/agentes/configuracao.js` — ARQUIVO NOVO

Criar o arquivo completo:

```js
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import {
    saveConversationState,
    getUserMedications,
    pausarMedicamento,
    reativarMedicamento,
    encerrarTratamento,
    alterarHorarioSchedule
} from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// CLASSIFICAÇÃO VIA CLAUDE — única chamada LLM do agente
// ============================================================

async function classificarIntencao(message, medicamentosDisponiveis) {
    const listaMeds = medicamentosDisponiveis.map(m => m.nome).join(', ') || 'nenhum';

    const systemPrompt = `Você é um classificador de intenções para um assistente de saúde.
O usuário quer fazer algo com seus lembretes ou tratamentos.

Medicamentos cadastrados: ${listaMeds}

Responda APENAS com JSON válido, sem markdown, sem explicações:
{
  "acao": "pausar" | "reativar" | "encerrar" | "alterar_horario" | "ambiguo",
  "medicamentoMencionado": "nome mencionado ou null",
  "novoHorario": "HH:MM ou null"
}

Definições:
- pausar: parar lembretes temporariamente (pode retomar depois). Ex: "cancela o lembrete", "para de me lembrar", "não preciso mais do aviso"
- reativar: ativar lembretes que estavam pausados. Ex: "volta os lembretes", "ativa de novo"
- encerrar: terminar tratamento definitivamente ou remover medicamento. Ex: "não vou mais tomar", "remove esse remédio", "acabei o tratamento"
- alterar_horario: mudar o horário de um lembrete. Ex: "muda pra 9h", "trocar horário para 22:00"
- ambiguo: não dá pra distinguir entre pausar e encerrar com certeza

Regra: quando há dúvida entre pausar (temporário) e encerrar (definitivo), use "ambiguo".`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 150,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }]
        });
        const text = response.content[0]?.text || '{}';
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        console.log(`⚙️ Intenção classificada: ${JSON.stringify(parsed)}`);
        return parsed;
    } catch (e) {
        console.error('⚠️ Erro ao classificar intenção:', e.message);
        return { acao: 'ambiguo', medicamentoMencionado: null, novoHorario: null };
    }
}

// ============================================================
// HELPERS DETERMINÍSTICOS
// ============================================================

function encontrarMedicamento(texto, medications) {
    if (!texto) return null;
    const t = texto.toLowerCase();
    // Match exato primeiro, depois parcial
    return medications.find(m => m.nome.toLowerCase() === t)
        || medications.find(m =>
            t.includes(m.nome.toLowerCase()) ||
            m.nome.toLowerCase().includes(t)
        )
        || null;
}

function extrairHorario(message) {
    const match = message.match(/(\d{1,2})[:h](\d{2})?/);
    if (!match) return null;
    const h = match[1].padStart(2, '0');
    const m = (match[2] || '00').padStart(2, '0');
    return `${h}:${m}`;
}

function isConfirmacao(message) {
    const msg = message.toLowerCase().trim();
    const termos = ['sim', 's', 'ok', 'pode', 'claro', 'confirmar', 'confirmo', 'vai', 'vamos', 'isso'];
    return termos.some(t => msg === t || msg.startsWith(t + ' '));
}

function isCancelamento(message) {
    return /\b(não|nao|cancela|cancelar|desiste|desistir|para|esquece|esquece isso)\b/.test(message.toLowerCase());
}

function formatarHorarios(schedules) {
    return (schedules || [])
        .filter(s => s.ativo)
        .map(s => s.horario.substring(0, 5))
        .join(' e ');
}

// ============================================================
// MENSAGENS DE CONFIRMAÇÃO
// ============================================================

function buildConfirmacaoMessage(firstName, ctx) {
    const { acao, medicationNome, schedulesAtivos, novoHorario, horarioAtual } = ctx;
    const horarios = formatarHorarios(schedulesAtivos);

    switch (acao) {
        case 'pausar':
            return `Só confirmar, ${firstName}: vou *pausar* todos os lembretes do *${medicationNome}*${horarios ? ` (${horarios})` : ''}.\n\nVocê pode reativar quando quiser. Confirmar?`;
        case 'reativar':
            return `Só confirmar: vou *reativar* os lembretes do *${medicationNome}*.\n\nEles voltarão a ser enviados nos horários cadastrados. Confirmar?`;
        case 'encerrar':
            return `Só confirmar: vou *encerrar o tratamento* com *${medicationNome}* e desativar todos os lembretes permanentemente.\n\nConfirmar?`;
        case 'alterar_horario':
            return `Só confirmar: vou mudar o lembrete${horarioAtual ? ` das *${horarioAtual.substring(0,5)}*` : ''} do *${medicationNome}* para *${novoHorario}*.\n\nConfirmar?`;
        default:
            return 'Confirmar a alteração?';
    }
}

// ============================================================
// EXECUÇÃO DA AÇÃO
// ============================================================

async function executarAcao(user, firstName, ctx) {
    const { acao, medicationId, medicationNome, scheduleId, novoHorario, schedulesAtivos } = ctx;
    const horarios = formatarHorarios(schedulesAtivos);

    await saveConversationState(user.id, { state: 'idle', context: {} });

    switch (acao) {
        case 'pausar':
            await pausarMedicamento(medicationId);
            return `✅ Pronto, ${firstName}! Lembretes do *${medicationNome}*${horarios ? ` (${horarios})` : ''} pausados.\n\nQuando quiser retomar, é só me dizer *"reativar ${medicationNome}"* 🌿`;

        case 'reativar':
            await reativarMedicamento(medicationId);
            return `✅ Pronto! Lembretes do *${medicationNome}* reativados. Vou voltar a te lembrar nos horários cadastrados 💊`;

        case 'encerrar':
            await encerrarTratamento(medicationId);
            return `✅ Tratamento com *${medicationNome}* encerrado. Os lembretes foram desativados 🌿\n\nSe precisar cadastrar novamente no futuro, é só me chamar!`;

        case 'alterar_horario':
            await alterarHorarioSchedule(scheduleId, novoHorario);
            return `✅ Pronto! Seu lembrete do *${medicationNome}* foi atualizado para *${novoHorario}* ⏰`;

        default:
            return `Não consegui executar a ação. Pode tentar novamente?`;
    }
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleConfiguracao({ user, message, state, context }) {
    const etapa = context?.etapa || 'identif_intencao';
    const firstName = user.name?.split(' ')[0] || 'você';
    const medications = await getUserMedications(user.id);
    const medicationsAtivos = medications.filter(m => m.ativo !== false);

    console.log(`⚙️ Configuração — etapa: ${etapa} — ${user.phone}`);

    // ── ETAPA 1: Classificar intenção via Claude ─────────────────────────────
    if (etapa === 'identif_intencao') {
        const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos);

        if (medicationsAtivos.length === 0) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
        }

        // Intenção ambígua → perguntar se quer pausar ou encerrar
        if (acao === 'ambiguo') {
            const med = medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null;
            const nomeExibir = med?.nome || medicamentoMencionado || 'esse medicamento';
            await saveConversationState(user.id, {
                state: 'configurando',
                context: {
                    etapa: 'identif_acao',
                    medicationId: med?.id || null,
                    medicationNome: nomeExibir,
                    schedulesAtivos: med ? (med.schedules || []).filter(s => s.ativo) : []
                }
            });
            return `Entendido, ${firstName}! Sobre o *${nomeExibir}*, você quer:\n\n• *Pausar* os lembretes (temporário — pode retomar depois)\n• *Encerrar* o tratamento definitivamente\n\nO que prefere?`;
        }

        // Intenção clara → identificar medicamento
        const med = medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null;
        return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, novoHorario, message });
    }

    // ── ETAPA 2: Usuário esclarece pausar vs encerrar ────────────────────────
    if (etapa === 'identif_acao') {
        const msg = message.toLowerCase();
        let acao = null;
        if (/pausar|pausa|temporár|temporar|depois|retomar/.test(msg)) acao = 'pausar';
        else if (/encerrar|definitiv|remover|apagar|excluir|não vou mais|nao vou mais/.test(msg)) acao = 'encerrar';
        else if (isConfirmacao(msg) && msg.includes('paus')) acao = 'pausar';
        else if (isConfirmacao(msg) && msg.includes('encerr')) acao = 'encerrar';

        if (!acao) {
            return `Não entendi, ${firstName}. Você quer *pausar* (temporário) ou *encerrar* definitivamente?`;
        }

        // Se já tem medicamento no contexto, ir para confirmação
        if (context.medicationId) {
            const schedulesAtivos = context.schedulesAtivos || [];
            const newCtx = { etapa: 'confirm_acao', acao, medicationId: context.medicationId, medicationNome: context.medicationNome, schedulesAtivos };
            await saveConversationState(user.id, { state: 'configurando', context: newCtx });
            return buildConfirmacaoMessage(firstName, newCtx);
        }

        // Sem medicamento identificado → perguntar qual
        const lista = medicationsAtivos.map(m => `• ${m.nome}`).join('\n');
        await saveConversationState(user.id, { state: 'configurando', context: { etapa: 'identif_medicamento', acao } });
        return `Qual medicamento você quer ${acao === 'pausar' ? 'pausar' : 'encerrar'}?\n\n${lista}`;
    }

    // ── ETAPA 3: Usuário especifica qual medicamento ──────────────────────────
    if (etapa === 'identif_medicamento') {
        const med = encontrarMedicamento(message, medicationsAtivos);

        if (!med) {
            const lista = medicationsAtivos.map(m => `• ${m.nome}`).join('\n');
            return `Não encontrei esse medicamento, ${firstName}. Seus medicamentos:\n\n${lista}\n\nQual deles?`;
        }

        const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);
        const { acao, novoHorario } = context;
        return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, novoHorario, message, schedulesAtivos });
    }

    // ── ETAPA 4: Usuário especifica qual horário alterar ─────────────────────
    if (etapa === 'identif_schedule') {
        const horarioMencionado = extrairHorario(message);
        const schedulesAtivos = context.schedulesAtivos || [];
        const schedule = schedulesAtivos.find(s =>
            horarioMencionado && s.horario.startsWith(horarioMencionado)
        );

        if (!schedule) {
            const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
            return `Não encontrei esse horário. Horários disponíveis:\n\n${lista}\n\nQual você quer alterar?`;
        }

        if (!context.novoHorario) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { ...context, etapa: 'obter_horario', scheduleId: schedule.id, horarioAtual: schedule.horario }
            });
            return `Para qual horário você quer mudar o lembrete das *${schedule.horario.substring(0,5)}*? (ex: *14:30*)`;
        }

        const newCtx = { ...context, etapa: 'confirm_acao', scheduleId: schedule.id, horarioAtual: schedule.horario };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 5: Obter o novo horário ────────────────────────────────────────
    if (etapa === 'obter_horario') {
        const novoHorario = extrairHorario(message);
        if (!novoHorario) {
            return `Não entendi o horário, ${firstName}. Informe no formato *HH:MM* (ex: *14:30*)`;
        }
        const newCtx = { ...context, etapa: 'confirm_acao', novoHorario };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 6: Confirmar e executar ────────────────────────────────────────
    if (etapa === 'confirm_acao') {
        if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        if (!isConfirmacao(message)) {
            return buildConfirmacaoMessage(firstName, context)
                + '\n\n_(Responda *SIM* para confirmar ou *NÃO* para cancelar)_';
        }
        return await executarAcao(user, firstName, context);
    }

    // Fallback
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `Algo deu errado no fluxo de configuração, ${firstName}. Pode tentar novamente?`;
}

// ── HELPER: continua após intenção clara + medicamento opcional ──────────────
async function continuarComAcao({ user, firstName, acao, med, medicationsAtivos, novoHorario, message, schedulesAtivos }) {
    // Sem medicamento identificado
    if (!med) {
        if (medicationsAtivos.length === 1) {
            // Assume o único
            med = medicationsAtivos[0];
        } else {
            const lista = medicationsAtivos.map(m => `• ${m.nome}`).join('\n');
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_medicamento', acao, novoHorario }
            });
            return `Qual medicamento você quer ${acao === 'alterar_horario' ? 'alterar o horário' : acao}?\n\n${lista}`;
        }
    }

    schedulesAtivos = schedulesAtivos || (med.schedules || []).filter(s => s.ativo);

    // alterar_horario: verificar se precisamos do schedule específico e/ou novo horário
    if (acao === 'alterar_horario') {
        // Múltiplos schedules sem horário específico mencionado
        if (schedulesAtivos.length > 1) {
            const horarioMencionado = extrairHorario(message);
            const scheduleEspecifico = horarioMencionado
                ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
                : null;

            if (!scheduleEspecifico) {
                const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: { etapa: 'identif_schedule', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario }
                });
                return `O *${med.nome}* tem lembretes em:\n\n${lista}\n\nQual horário você quer alterar?`;
            }

            if (!novoHorario) {
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario }
                });
                return `Para qual horário você quer mudar o lembrete das *${scheduleEspecifico.horario.substring(0,5)}*? (ex: *14:30*)`;
            }

            // Tem tudo
            const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario, novoHorario };
            await saveConversationState(user.id, { state: 'configurando', context: ctx });
            return buildConfirmacaoMessage(firstName, ctx);
        }

        // Schedule único
        if (!novoHorario) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: schedulesAtivos[0]?.id, horarioAtual: schedulesAtivos[0]?.horario }
            });
            return `Para qual horário você quer mudar o lembrete das *${schedulesAtivos[0]?.horario?.substring(0,5)}* do *${med.nome}*? (ex: *14:30*)`;
        }

        const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: schedulesAtivos[0]?.id, horarioAtual: schedulesAtivos[0]?.horario, novoHorario };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // Outros casos (pausar, reativar, encerrar) → confirmação direta
    const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario };
    await saveConversationState(user.id, { state: 'configurando', context: ctx });
    return buildConfirmacaoMessage(firstName, ctx);
}
```

---

### 4.4 — `src/prompts.js`

Localizar o bloco de FUNCIONALIDADES NÃO DISPONÍVEIS (adicionado no BUG-032) e substituir por:

```
FUNCIONALIDADES DE CONFIGURAÇÃO (disponíveis via conversa):
O usuário pode pedir diretamente:
- Pausar lembretes de um medicamento
- Reativar lembretes pausados
- Encerrar um tratamento
- Alterar o horário de um lembrete

Se o agente_principal receber uma dessas solicitações por engano, responder:
"Claro! Me conta o que você quer fazer com qual medicamento."
O sistema vai rotear automaticamente para o fluxo correto.

REGRA ANTI-ALUCINAÇÃO (permanente):
NUNCA mencione "aplicativo", "app", "sistema externo" ou qualquer ferramenta que não existe.
Se algo não estiver disponível, diga que ainda não temos essa função e direcione para:
Guilherme Silveira, (11) 94106-5858.
```

---

## 5. Ordem de execução

1. `src/database.js` — 4 novas funções
2. `src/agentes/configuracao.js` — criar arquivo novo com o código completo acima
3. `src/router.js` — import + `detectarIntencaoConfiguracao` + 2 novos cases
4. `src/prompts.js` — atualizar bloco de funcionalidades
5. Deploy

---

## 6. Validação pós-deploy

**Teste A — Variação natural de linguagem (pausar)**
Enviar: *"não precisa me lembrar mais do Voltaren"*  
Esperado: agente classifica como `pausar`, pede confirmação → confirmar → schedules.ativo = false.

**Teste B — Ambiguidade (pausar vs encerrar)**
Enviar: *"não quero mais esse remédio"*  
Esperado: agente pergunta se quer pausar ou encerrar → usuário escolhe → confirmação → execução.

**Teste C — Alterar horário com novo horário na mensagem**
Enviar: *"muda meu horário da Losartana para 22h"*  
Esperado: se 1 schedule → confirmação direta → alterar.  
Se múltiplos schedules → pergunta qual → obtém novo horário → confirma.

**Teste D — Encerrar e verificar que lembretes param**
Enviar: *"encerrar tratamento do Cimegrip"*  
Confirmar → medications.ativo = false + schedules.ativo = false → próximo ciclo do scheduler ignora o medicamento.

**Teste E — Cancelar no fluxo**
Chegar na confirmação → responder "não" → nada alterado no banco.

---

## 7. Notas

**Dose_logs pendentes não são afetados** ao pausar/encerrar — comportamento correto, tratado separadamente (MH-024).

**`getUserMedications` deve filtrar `medications.ativo = true`** — verificar se já faz isso. Se não, medicamentos encerrados podem continuar aparecendo. Caso não filtre, adicionar `.eq('ativo', true)` na query dessa função.

**Custo Claude:** 1 chamada `claude-sonnet-4-6` com ~200 tokens por fluxo de configuração. Baixo impacto.