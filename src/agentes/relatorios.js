import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import {
    getDosesHoje,
    getMedicamentosAtivos,
    getEstoque,
    getProximosMedicamentos,
    getAdesaoPeriodo,
    getAdesaoPorMedicamento
} from '../database.js';
import { sendTextMessage } from '../whatsapp.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// CLASSIFICADOR DE INTENÇÃO DE RELATÓRIO
// Exportado para uso no router.js
// ============================================================

export function classificarIntencaoRelatorio(message) {
    if (!message) return null;
    const msg = message.toLowerCase().trim();

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

    for (const [tipo, termos] of Object.entries(padroes)) {
        if (termos.some(t => msg.includes(t))) return tipo;
    }

    return null;
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleRelatorios({ user, message }) {
    const intencao = classificarIntencaoRelatorio(message);

    switch (intencao) {
        case 'tomei_hoje':
            return await relatorioTomeiHoje(user);
        case 'meus_remedios':
            return await relatorioMeusRemedios(user);
        case 'estoque':
            return await relatorioEstoque(user);
        case 'proximo_remedio':
            return await relatorioProximoRemedio(user);
        case 'adesao':
            return await relatorioAdesao(user);
        default:
            return null; // não reconheceu — router cai no agente_principal
    }
}

// ============================================================
// R-001: TOMEI HOJE?
// ============================================================

async function relatorioTomeiHoje(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const { tomadas, pendentes } = await getDosesHoje(user.id);

    if (tomadas.length === 0 && pendentes.length === 0) {
        return `Não encontrei nenhum lembrete registrado para hoje, ${firstName}. Seus próximos remédios vão aparecer aqui conforme os horários chegarem! 💊`;
    }

    let msg = `✅ Registro de hoje, ${firstName}!\n\n`;

    for (const dose of tomadas) {
        const hora = new Date(dose.taken_at).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Sao_Paulo'
        });
        msg += `✅ ${dose.med_nome} — tomado às ${hora}\n`;
    }

    for (const dose of pendentes) {
        msg += `⏳ ${dose.med_nome} — ainda não registrado`;
        if (dose.horario) msg += ` (horário: ${dose.horario.substring(0, 5)})`;
        msg += '\n';
    }

    return msg.trim();
}

// ============================================================
// R-002: QUAIS MEUS REMÉDIOS?
// ============================================================

async function relatorioMeusRemedios(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const medications = await getMedicamentosAtivos(user.id);

    if (medications.length === 0) {
        return `Você ainda não tem remédios cadastrados, ${firstName}. Quer cadastrar agora? 💊`;
    }

    let msg = `💊 Seus remédios cadastrados, ${firstName}:\n\n`;

    medications.forEach((med, i) => {
        const horariosAtivos = (med.schedules || []).filter(s => s.ativo);
        const horarios = horariosAtivos.length > 0
            ? horariosAtivos.map(s => s.horario.substring(0, 5)).join(' e ')
            : 'sem horário cadastrado';
        const forma = med.forma_farmaceutica || 'comprimido';
        msg += `${i + 1}. *${med.nome}* — ${med.dosagem} (${forma})\n`;
        msg += `   ⏰ ${horarios}\n\n`;
    });

    return msg.trim();
}

// ============================================================
// R-003: ESTOQUE
// ============================================================

async function relatorioEstoque(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const estoque = await getEstoque(user.id);

    if (estoque.length === 0) {
        return `Você ainda não tem remédios cadastrados, ${firstName}. 💊`;
    }

    let msg = `📦 Estoque dos seus remédios, ${firstName}:\n\n`;

    for (const med of estoque) {
        if (med.estoque_atual <= 0) {
            msg += `🚨 *${med.nome}* — sem estoque! Compre com urgência\n`;
        } else if (med.estoque_atual <= med.estoque_minimo) {
            msg += `⚠️ *${med.nome}* — ${med.estoque_atual} unidades (hora de comprar mais!)\n`;
        } else {
            msg += `✅ *${med.nome}* — ${med.estoque_atual} unidades\n`;
        }
    }

    return msg.trim();
}

// ============================================================
// R-004: O QUE TENHO QUE TOMAR AGORA?
// ============================================================

async function relatorioProximoRemedio(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const { passados, agora, proximos } = await getProximosMedicamentos(user.id);

    if (passados.length === 0 && agora.length === 0 && proximos.length === 0) {
        return `Não encontrei remédios agendados para hoje, ${firstName}. 💊`;
    }

    let msg = `⏰ Seus remédios de hoje, ${firstName}:\n\n`;

    for (const med of passados) {
        const status = med.confirmado ? '✅' : '⚠️';
        msg += `${status} *${med.nome}* (${med.horario}) — ${med.confirmado ? 'já registrado' : 'não registrado'}\n`;
    }

    for (const med of agora) {
        msg += `💊 *${med.nome}* (${med.horario}) — está na hora de tomar!\n`;
    }

    for (const med of proximos) {
        msg += `🔜 *${med.nome}* — próximo às ${med.horario}\n`;
    }

    return msg.trim();
}

// ============================================================
// R-005: ADESÃO (Claude com contexto)
// ============================================================

async function relatorioAdesao(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const dados = await getAdesaoPeriodo(user.id, 7);

    if (dados.totalEsperado === 0) {
        return `Ainda não tenho dados suficientes para calcular sua adesão, ${firstName}. Continue confirmando suas doses e em breve terei um histórico para te mostrar! 💊`;
    }

    const prompt = `Você é a Nami, assistente de saúde calorosa e empática.

Responda sobre a adesão ao tratamento do usuário com base nos dados abaixo.

Nome: ${firstName}
Período: últimos 7 dias
Doses esperadas: ${dados.totalEsperado}
Doses confirmadas: ${dados.totalConfirmado}
Percentual de adesão: ${dados.percentual}%
Medicamento com menor adesão: ${dados.piorMedicamento || 'nenhum identificado'}

Regras:
- Se adesão >= 80%: celebre e encoraje a manter o ritmo
- Se adesão entre 50-79%: seja empática, sem julgamento, dê uma dica simples
- Se adesão < 50%: acolha sem culpa, pergunte se está tudo bem, ofereça ajuda
- Seja breve (máximo 4 linhas)
- Responda APENAS com a mensagem para o usuário. Sem JSON. Texto simples.`;

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }]
    });

    return response.content[0].text.trim();
}

// ============================================================
// RESUMO SEMANAL PROATIVO (chamado pelo scheduler)
// ============================================================

export async function enviarResumoSemanal(user) {
    try {
        const firstName = user.name?.split(' ')[0] || 'você';
        const adesao = await getAdesaoPorMedicamento(user.id, 7);

        // Sem medicamentos ativos com horários — pula
        if (adesao.porMedicamento.length === 0) {
            console.log(`⏭️  Resumo semanal ignorado (sem medicamentos com horário): ${user.phone}`);
            return;
        }

        const dadosFormatados = {
            periodo: 'últimos 7 dias',
            por_medicamento: adesao.porMedicamento.map(m => ({
                nome: m.nome,
                doses_tomadas: m.doses_tomadas,
                doses_nao_registradas: m.doses_nao_registradas,
                doses_esperadas: m.doses_esperadas,
                adesao_percentual: m.percentual,
                estoque_atual: m.estoque_atual,
                estoque_status: m.estoque_status   // 'ok' | 'baixo' | 'critico'
            })),
            total_geral: {
                doses_tomadas: adesao.totalConfirmado,
                doses_nao_registradas: adesao.totalNaoRegistrado,
                doses_esperadas: adesao.totalEsperado,
                adesao_percentual: adesao.percentualGeral
            }
        };

        const prompt = `Você é a Nami, assistente de saúde calorosa.

Monte um resumo semanal para ${firstName} com base nos dados abaixo.

${JSON.stringify(dadosFormatados, null, 2)}

FORMATO OBRIGATÓRIO — siga esta estrutura exata:

1. Saudação curta com o nome do usuário

2. Para CADA medicamento em por_medicamento, uma linha no formato:
   💊 {nome}: {doses_tomadas} tomadas · {doses_nao_registradas} não registradas ({adesao_percentual}%)

3. Total geral (linha de encerramento):
   📊 Total da semana: {doses_tomadas}/{doses_esperadas} doses ({adesao_percentual}%)

4. Se algum medicamento tiver estoque_status = 'baixo' ou 'critico', mencione brevemente.

5. Frase motivadora curta adaptada ao percentual geral:
   - >= 80%: celebre e encoraje
   - 50–79%: empática, sem julgamento, dica simples
   - < 50%: acolha sem culpa, ofereça ajuda

Seja calorosa e clara. Máximo 10 linhas no total.
Responda APENAS com a mensagem. Sem JSON. Texto simples.`;

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 400,
            messages: [{ role: 'user', content: prompt }]
        });

        const mensagem = response.content[0].text.trim();
        await sendTextMessage(user.phone, mensagem);
        console.log(`📊 Resumo semanal enviado para ${user.phone}`);

    } catch (error) {
        console.error(`❌ Erro ao enviar resumo semanal para ${user.phone}:`, error.message);
    }
}
