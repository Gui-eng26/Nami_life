import {
    getDosesHoje,
    getMedicamentosAtivos,
    getEstoque,
    getProximosMedicamentos,
    calcularAdesao,
    calcularProgressoTratamento,
    getAdesaoEstado,
    upsertAdesaoEstado,
    saveConversationState,
    registrarIntencaoNaoSuportada
} from '../database.js';
import { sendTextMessage } from '../whatsapp.js';
import { isCancelamento } from '../nlp_helpers.js';
import {
    escolherFaixa,
    montarMensagemSemanal,
    montarMensagemMensal,
    montarBlocoMotivo,
    montarBlocoTurno,
    montarBlocoTendencia,
    montarBlocoMarco,
    montarBlocoEstoque,
    escolherFaseProgresso,
    montarMensagemProgresso,
    montarFallbackContinuo,
    montarPerguntaPeriodo,
    montarRecusaPeriodo
} from '../templates/adesaoTemplates.js';

// Considera fechamento mensal quando o último fechamento tem 28+ dias (ou nunca fechou).
const DIAS_FECHAMENTO_MENSAL = 28;
const PERIODOS_VALIDOS = [7, 15, 30];
// '100' > '80_99' > '50_79' > 'abaixo_50' — usado para marco (melhor faixa já atingida)
const RANKING_FAIXA = { abaixo_50: 0, '50_79': 1, '80_99': 2, '100': 3 };

// ============================================================
// CLASSIFICADOR DE INTENÇÃO DE RELATÓRIO
// Exportado para uso no router.js (Camada 1 — fast-path por palavra-chave)
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
        ],
        progresso_tratamento: [
            'como estou no meu tratamento',
            'como está meu tratamento',
            'quanto falta pro tratamento acabar',
            'quantos dias faltam de tratamento',
            'em que dia do tratamento eu estou',
            'já estou terminando o tratamento',
            'quanto tempo ainda vou tomar esse remédio',
            'meu tratamento já acabou?'
        ]
    };

    for (const [tipo, termos] of Object.entries(padroes)) {
        if (termos.some(t => msg.includes(t))) return tipo;
    }

    return null;
}

// ============================================================
// HANDLER PRINCIPAL
// subtipo é sempre fornecido por quem chama (Camada 1 ou Camada 2 do router.js) —
// nunca mais recalculado aqui dentro (Camada 3 eliminada, causa raiz do BUG-037).
// ============================================================

export async function handleRelatorios({ user, message, subtipo, state }) {
    switch (subtipo) {
        case 'tomei_hoje':
            return await relatorioTomeiHoje(user);
        case 'meus_remedios':
            return await relatorioMeusRemedios(user);
        case 'estoque':
            return await relatorioEstoque(user);
        case 'proximo_remedio':
            return await relatorioProximoRemedio(user);
        case 'adesao':
            return await relatorioAdesao({ user, message, state });
        case 'progresso_tratamento':
            return await relatorioProgressoTratamento(user);
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
// R-005: ADESÃO SOB DEMANDA — seleção de período em duas etapas
// ============================================================

function extrairPeriodo(message) {
    for (const periodo of PERIODOS_VALIDOS) {
        if (new RegExp(`\\b${periodo}\\b`).test(message)) return periodo;
    }
    return null;
}

// Mensagem menciona algum número (fora dos 3 períodos válidos) — pedido de período fora de escopo
function mencionaPeriodoInvalido(message) {
    return /\b\d{1,3}\b/.test(message);
}

async function relatorioAdesao({ user, message, state }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const aguardandoPeriodo = state?.state === 'aguardando_periodo_adesao';

    if (aguardandoPeriodo && isCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Sem problemas, ${firstName}! Se quiser ver sua adesão depois, é só me chamar 🌿`;
    }

    const periodo = extrairPeriodo(message);

    if (!periodo) {
        await saveConversationState(user.id, { state: 'aguardando_periodo_adesao', context: {} });

        if (mencionaPeriodoInvalido(message)) {
            await registrarIntencaoNaoSuportada(user.id, message);
            return montarRecusaPeriodo(firstName);
        }
        return montarPerguntaPeriodo(firstName);
    }

    await saveConversationState(user.id, { state: 'idle', context: {} });

    const dados = await calcularAdesao(user.id, periodo);
    if (dados.esperado === 0) {
        return `Ainda não tenho dados suficientes para calcular sua adesão, ${firstName}. Continue confirmando suas doses e em breve terei um histórico para te mostrar! 💊`;
    }

    return await montarRespostaAdesaoDireta(user, dados, periodo);
}

// "Sob demanda: versão direta" (4.7) — números atuais + tendência desde o último
// envio automático, sem avançar nem repetir o texto da jornada semanal/mensal.
// Não atualiza adesao_estado — só os envios automáticos fazem isso.
async function montarRespostaAdesaoDireta(user, dados, periodo) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const adesaoEstado = await getAdesaoEstado(user.id);

    let msg = `📊 Sua adesão nos últimos ${periodo} dias, ${firstName}:\n\n`;
    msg += `${dados.percentual}% (${dados.confirmado}/${dados.esperado} doses)\n\n`;
    msg += `✅ Confirmadas: ${dados.porStatus.confirmado}\n`;
    msg += `⏳ Sem resposta: ${dados.porStatus.nao_informado}\n`;
    msg += `❌ Não tomadas: ${dados.porStatus.nao_tomado}\n`;
    msg += `📦 Sem estoque: ${dados.porStatus.sem_estoque}`;

    if (adesaoEstado.percentual_ultimo_envio !== null && adesaoEstado.percentual_ultimo_envio !== undefined) {
        const diff = dados.percentual - adesaoEstado.percentual_ultimo_envio;
        const tipoTendencia = diff > 5 ? 'subiu' : diff < -5 ? 'caiu' : 'estavel';
        msg += `\n\n${montarBlocoTendencia(tipoTendencia, {
            taxaAnterior: adesaoEstado.percentual_ultimo_envio,
            taxaAtual: dados.percentual
        })}`;
    }

    return msg;
}

// ============================================================
// R-006: PROGRESSO DO TRATAMENTO
// ============================================================

async function relatorioProgressoTratamento(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const progressos = await calcularProgressoTratamento(user.id);

    if (progressos.length === 0) {
        return montarFallbackContinuo(firstName);
    }

    const blocos = progressos.map(p => {
        const fase = escolherFaseProgresso(p.percentualDecorrido);
        const diasCobertosPeloEstoque = Math.floor(p.estoqueAtual / p.dosesPorDia);
        const suficiente = diasCobertosPeloEstoque >= p.diasRestantes;
        const blocoEstoque = montarBlocoEstoque({
            suficiente,
            estoque: p.estoqueAtual,
            diasRestantes: p.diasRestantes
        });

        return montarMensagemProgresso({
            nome: firstName,
            medicamento: p.nome,
            diasDecorridos: p.diasDecorridos,
            tratamentoDias: p.tratamentoDias,
            diasRestantes: p.diasRestantes,
            dosesRestantes: p.dosesRestantes,
            blocoEstoque,
            fase
        });
    });

    return blocos.join('\n\n');
}

// ============================================================
// RESUMO AUTOMÁTICO — SEMANAL OU FECHAMENTO MENSAL (chamado pelo scheduler)
// ============================================================

export async function enviarResumoSemanal(user) {
    try {
        const firstName = user.name?.split(' ')[0] || 'você';
        const adesaoEstado = await getAdesaoEstado(user.id);

        const isMensal = !adesaoEstado.ultimo_fechamento_mensal_at ||
            (Date.now() - new Date(adesaoEstado.ultimo_fechamento_mensal_at).getTime()) >= DIAS_FECHAMENTO_MENSAL * 24 * 60 * 60 * 1000;
        const dias = isMensal ? 30 : 7;

        const dados = await calcularAdesao(user.id, dias);
        if (dados.esperado === 0) {
            console.log(`⏭️  Resumo ${isMensal ? 'mensal' : 'semanal'} ignorado (sem doses no período): ${user.phone}`);
            return;
        }

        const faixaNova = escolherFaixa(dados.percentual);
        const mudouDeFaixa = adesaoEstado.faixa_atual !== null && adesaoEstado.faixa_atual !== faixaNova;
        const semanaNova = (adesaoEstado.faixa_atual === null || mudouDeFaixa)
            ? 1
            : (adesaoEstado.semana_atual_na_faixa || 1) + 1;

        let texto = isMensal
            ? montarMensagemMensal({ nome: firstName, taxa: dados.percentual, faixa: faixaNova })
            : montarMensagemSemanal({ nome: firstName, taxa: dados.percentual, faixa: faixaNova, semana: semanaNova });

        // Bloco motivo dominante — só o de maior contagem entre os 3; empate/zerado, omite
        const motivos = ['nao_tomado', 'nao_informado', 'sem_estoque'];
        const motivoDominante = motivos.reduce((maior, atual) =>
            dados.porStatus[atual] > (dados.porStatus[maior] || 0) ? atual : maior, null);

        if (motivoDominante) {
            texto += `\n\n${montarBlocoMotivo(motivoDominante)}`;

            // Turno — só no fechamento mensal, só para nao_tomado/nao_informado
            if (isMensal && motivoDominante !== 'sem_estoque' && dados.diagnosticoPorTurno) {
                const turno = dados.diagnosticoPorTurno[motivoDominante];
                if (turno) texto += `\n\n${montarBlocoTurno(turno)}`;
            }
        }

        // Bloco tendência — compara com o envio automático anterior
        if (adesaoEstado.percentual_ultimo_envio !== null && adesaoEstado.percentual_ultimo_envio !== undefined) {
            const diff = dados.percentual - adesaoEstado.percentual_ultimo_envio;
            const tipoTendencia = diff > 5 ? 'subiu' : diff < -5 ? 'caiu' : 'estavel';
            texto += `\n\n${montarBlocoTendencia(tipoTendencia, {
                taxaAnterior: adesaoEstado.percentual_ultimo_envio,
                taxaAtual: dados.percentual
            })}`;
        }

        // Bloco marco — primeira vez alcançando 100%
        const melhorAnterior = adesaoEstado.melhor_faixa_atingida;
        if (faixaNova === '100' && melhorAnterior !== '100') {
            texto += `\n\n${montarBlocoMarco()}`;
        }

        await sendTextMessage(user.phone, texto);

        const melhorFaixaNova = (!melhorAnterior || RANKING_FAIXA[faixaNova] > RANKING_FAIXA[melhorAnterior])
            ? faixaNova
            : melhorAnterior;

        await upsertAdesaoEstado(user.id, {
            faixa_atual: faixaNova,
            percentual_ultimo_envio: dados.percentual,
            semana_atual_na_faixa: semanaNova,
            melhor_faixa_atingida: melhorFaixaNova,
            ultimo_fechamento_mensal_at: isMensal ? new Date().toISOString() : adesaoEstado.ultimo_fechamento_mensal_at
        });

        console.log(`📊 Resumo ${isMensal ? 'mensal' : 'semanal'} enviado para ${user.phone} (faixa: ${faixaNova}, ${dados.percentual}%)`);

    } catch (error) {
        console.error(`❌ Erro ao enviar resumo semanal para ${user.phone}:`, error.message);
    }
}
