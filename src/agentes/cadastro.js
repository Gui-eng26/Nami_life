import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import {
    saveConversationState,
    saveMedication,
    saveSchedule,
    replaceMedication
} from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(etapa, context, userName) {
    return `Você é a Nami, assistente de saúde. Você está no fluxo de cadastro de um novo medicamento.

Sua única função agora é coletar as informações necessárias para cadastrar o medicamento corretamente, uma pergunta por vez.

Etapa atual: ${etapa}
Contexto coletado até agora: ${JSON.stringify(context)}
Nome do usuário: ${userName || 'usuário'}

REGRAS:
- Colete UMA informação por mensagem
- Seja clara e direta nas perguntas
- Adapte a linguagem à forma farmacêutica quando relevante
- NÃO confirme parcialmente durante a coleta — só mostre o resumo completo na etapa cad_confirmacao
- Se o usuário quiser cancelar ("deixa pra lá", "cancela", "esquece"), encerre o fluxo com gentileza (proximaEtapa: "idle")

ETAPAS E O QUE FAZER EM CADA UMA:

cad_nome:
  Pergunta o nome do medicamento.

cad_forma:
  Pergunta a forma farmacêutica.
  Sugestões: comprimido, cápsula, colírio, gotas, pomada, injetável, xarope, outro.
  Se o usuário já mencionou a forma farmacêutica na etapa anterior (ex: "colírio Voltaren"), pule direto para cad_dosagem e informe a forma detectada no novoContext.

cad_dosagem:
  Pergunta a dosagem. Adapte à forma:
  - comprimido/cápsula → "Qual a dosagem? (ex: 50mg)"
  - colírio/gotas → "Qual a concentração? (ex: 0,5%)"
  - pomada → "Qual a concentração? (ex: 1%)"
  - outros → "Qual a dosagem ou concentração?"

cad_tipo_tratamento:
  Pergunta se é uso contínuo ou com prazo determinado.
  Mensagem: "Este remédio é de uso contínuo (sem previsão de parada) ou tem prazo determinado, como um antibiótico ou anti-inflamatório?"
  Se o usuário disser temporário, pergunte quantos dias dura o tratamento.
  Salve tipo_tratamento como "continuo" ou "temporario" e tratamento_dias como número (ou null se contínuo).

cad_horarios:
  Pergunta os horários de uso.
  Salve sempre como array de strings ["HH:MM"].
  Interprete linguagem natural: "de manhã e à noite" → ["07:00", "21:00"], "só de manhã" → ["07:00"].

cad_estoque:
  Pergunta a quantidade em estoque. Adapte à forma:
  - comprimido/cápsula → "Quantos comprimidos você tem agora?"
  - colírio/gotas → "Quantos frascos você tem agora?"
  - pomada → "Quantos tubos você tem agora?"
  - outros → "Qual a quantidade em estoque?"

SE etapa = 'cad_estoque' E context.alerta_estoque_baixo existe:
  Após registrar a quantidade informada, inclua um aviso natural antes
  de avançar para a confirmação.
  Use os valores de context.alerta_estoque_baixo: dias_restantes, estoque, doses_por_dia.

  Exemplo (dias_restantes = 0):
  "Entendi! Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia,
   você já está sem estoque suficiente para hoje mesmo. Quer cadastrar
   assim mesmo e comprar mais em breve, ou prefere registrar a quantidade
   depois da compra?"

  Exemplo (dias_restantes <= 5):
  "Anotado! Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia,
   seu estoque dura apenas {dias_restantes} dias. Não se esqueça de fazer a
   recompra em breve! Vou te lembrar quando estiver acabando. 💊"

  Se dias_restantes > 5: seguir normalmente para confirmação sem alerta.

cad_confirmacao:
  Exibe o resumo completo UMA ÚNICA VEZ e pergunta se está tudo certo.
  Use exatamente este formato:
  "Deixa eu confirmar tudo antes de salvar:

  💊 Remédio: {nome}
  💉 Forma: {forma}
  📏 Dosagem: {dosagem}
  🔄 Tratamento: {contínuo | X dias}
  ⏰ Horários: {horarios separados por vírgula}
  📦 Estoque: {quantidade}

  Está tudo certinho?"

  EXPRESSÕES QUE CONTAM COMO CONFIRMAÇÃO (avance para cad_salvo):
  "sim", "é isso", "está", "tá", "tá bom", "ok", "pode", "salva", "salvar",
  "confirmar", "confirmo", "perfeito", "certo", "correto", "isso mesmo",
  "beleza", "pode salvar", "pode cadastrar", "isso", "está certo",
  "está certinho", "tudo certo", "certinho", "pode sim", "vai", "vamos"

  EXPRESSÕES QUE INDICAM CORREÇÃO (mantenha em cad_confirmacao ou volte à etapa relevante):
  "não", "errado", "muda", "altera", "quero mudar", "não está certo",
  "não é isso", "corrige", "tem erro"

cad_salvo:
  Usuário confirmou os dados.
  - Preencha o campo action com SAVE_MEDICATION
  - Envie mensagem de sucesso carinhosa (ex: "Ótimo! {nome} foi cadastrado com sucesso 💊✅ Vou te lembrar nos horários certos!")
  - proximaEtapa: "idle"

FORMATO DE RESPOSTA — JSON válido, sem markdown, sem backticks:
{
  "message": "mensagem para o usuário",
  "proximaEtapa": "cad_nome | cad_forma | cad_dosagem | cad_tipo_tratamento | cad_horarios | cad_estoque | cad_confirmacao | cad_salvo | idle",
  "novoContext": {
    "etapa": "próxima etapa a ser executada",
    "nome": "nome do remédio",
    "forma": "forma farmacêutica",
    "dosagem": "dosagem",
    "tipo_tratamento": "continuo | temporario",
    "tratamento_dias": null,
    "horarios": [],
    "estoque": null
  },
  "action": null
}

O campo action SÓ é preenchido em cad_salvo:
{
  "type": "SAVE_MEDICATION",
  "nome": "",
  "forma": "",
  "dosagem": "",
  "tipo_tratamento": "continuo | temporario",
  "tratamento_dias": null,
  "horarios": ["HH:MM"],
  "estoque": 0
}`;
}

// ============================================================
// CHAMADA AO CLAUDE
// ============================================================

async function callClaude({ systemPrompt, message, context }) {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || 'Olá' }]
    });

    const rawText = response.content[0].text;

    try {
        return JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch { /* fall through */ }
        }
        console.error('❌ cadastro: Claude não retornou JSON válido:', rawText);
        return {
            message: 'Desculpe, tive um probleminha. Pode repetir? 🌿',
            proximaEtapa: context?.etapa || 'cad_nome',
            novoContext: context || {},
            action: null
        };
    }
}

// ============================================================
// PROCESSAMENTO DE AÇÃO
// ============================================================

async function processarAcao(action, user) {
    if (action.type !== 'SAVE_MEDICATION') return null;

    const med = await saveMedication({
        userId: user.id,
        nome: action.nome,
        forma: action.forma,
        dosagem: action.dosagem,
        tipo_tratamento: action.tipo_tratamento || 'continuo',
        tratamento_dias: action.tratamento_dias || null,
        estoque: action.estoque || 0
    });

    // Medicamento duplicado — informa o usuário e encerra o fluxo
    if (med.isDuplicate) {
        return {
            messageOverride:
                `Já tenho o *${med.nome}* cadastrado! 💊\n\n` +
                `Cadastro atual: ${med.dosagem}, estoque: ${med.estoque_atual} unidades.\n\n` +
                `Se quiser atualizar, me diga "quero atualizar o ${med.nome}". ` +
                `Caso contrário, está tudo certo como está! ✅`
        };
    }

    // Salva os horários
    if (action.horarios && action.horarios.length > 0) {
        for (let horario of action.horarios) {
            if (typeof horario === 'object') {
                horario = horario.horario || horario.hora || Object.values(horario)[0];
            }
            const horarioStr = String(horario).trim().substring(0, 5);
            await saveSchedule({ medicationId: med.id, horario: horarioStr });
        }
    }

    console.log(`✅ Medicamento salvo: ${action.nome} (id: ${med.id}) para ${user.phone}`);
    return null;
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleCadastro({ user, message, state, context }) {
    const etapaAtual = context?.etapa || 'cad_nome';
    console.log(`💊 Cadastro — etapa: ${etapaAtual} — ${user.phone}`);

    // Pré-calcula alerta de estoque baixo antes de chamar Claude,
    // para que o prompt possa mencionar o aviso na mesma mensagem de coleta
    let contextParaClaude = context || {};
    if (etapaAtual === 'cad_estoque') {
        const estoque = parseInt(message) || 0;
        const horarios = context?.horarios || [];
        const dosesPerDia = horarios.length || 1;
        const diasRestantes = Math.floor(estoque / dosesPerDia);
        contextParaClaude = {
            ...contextParaClaude,
            alerta_estoque_baixo: diasRestantes <= 5 ? {
                dias_restantes: diasRestantes,
                estoque,
                doses_por_dia: dosesPerDia
            } : null
        };
    }

    const systemPrompt = buildSystemPrompt(etapaAtual, contextParaClaude, user.name);
    const claudeResponse = await callClaude({ systemPrompt, message, context: contextParaClaude });

    const proximaEtapa = claudeResponse.proximaEtapa || 'cad_nome';
    const novoContext = claudeResponse.novoContext || {};

    // Executa ação antes de salvar o estado (pode retornar override de mensagem)
    let mensagemFinal = claudeResponse.message;
    if (claudeResponse.action) {
        const resultado = await processarAcao(claudeResponse.action, user);
        if (resultado?.messageOverride) {
            mensagemFinal = resultado.messageOverride;
        }
    }

    // Salva novo estado da conversa
    const novoState = proximaEtapa === 'idle' ? 'idle' : 'adding_med';
    await saveConversationState(user.id, {
        state: novoState,
        context: novoState === 'idle' ? {} : { ...novoContext, etapa: proximaEtapa }
    });

    return mensagemFinal;
}
