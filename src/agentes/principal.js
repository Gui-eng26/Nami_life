import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { NAMI_SYSTEM_PROMPT } from '../prompts.js';
import {
    getConversationState,
    updateConversationState,
    confirmDose,
    confirmDoseByLogId,
    updateUserName,
    getRecentDoses,
    getUserMedications,
    registrarMovimentoEstoque,
    getEstoqueStatusSimples,
    getEstoqueInfoParaAlerta,
    contarConfirmacoesHoje,
    calcularAlertaEstoque,
    registrarNaoTomado,
    calcularProximaDose,
    formatarHistoricoConversa,
    getDosesRetroativas,
    getDosesConfirmadasHoje,
    confirmarDoseRetroativa,
    reverterConfirmacao
} from '../database.js';
import { buildAlertaEstoquePosConfirmacao } from '../templates/estoqueTemplates.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Alerta pós-ajuste manual de estoque (MH-042) — reaproveita o mesmo limiar
// crítico/baixo/ok já usado em relatorioEstoque, sem criar um segundo mecanismo.
function buildAlertaEstoqueAjusteMessage(info) {
    const { medNome, estoqueAtual, status } = info;

    if (status === 'critico') {
        return (
            `\n\n🚨 *Atenção:* o estoque do *${medNome}* está zerado. ` +
            `Providencie a recompra assim que possível! 💊`
        );
    }
    if (status === 'baixo') {
        return (
            `\n\n⚠️ *Lembrete de estoque:* o *${medNome}* está com *${estoqueAtual}* ${estoqueAtual === 1 ? 'unidade' : 'unidades'} — ` +
            `hora de planejar a recompra! 💊`
        );
    }
    return '';
}

// Informativo determinístico pós-ajuste manual de estoque (complemento MH-042) — o único
// número de estoque comunicado ao usuário depois de UPDATE_STOCK vem daqui, nunca do texto
// gerado pelo LLM. Responsabilidade única: não decide alerta de limiar (isso continua em
// buildAlertaEstoqueAjusteMessage, chamada separadamente).
function buildEstoqueAtualizadoMessage({ medNome, estoqueAnterior, estoqueNovo, deltaAplicado, quantidadeSolicitada }) {
    let msg = `\n\n📦 Estoque atualizado! Seu novo estoque de *${medNome}* é *${estoqueNovo}* ${estoqueNovo === 1 ? 'unidade' : 'unidades'}.`;

    // Se o que foi de fato aplicado é menor (em módulo) do que o solicitado, o clamp em 0 entrou em ação —
    // só é detectável comparando o delta pedido com o delta realmente aplicado.
    if (quantidadeSolicitada != null && Math.abs(deltaAplicado) < quantidadeSolicitada) {
        msg += ` (Você tinha ${estoqueAnterior} — como o estoque não pode ficar negativo, o ajuste foi ` +
               `limitado a ${estoqueAnterior}, não aos ${quantidadeSolicitada} informados.)`;
    }

    return msg;
}

export async function handlePrincipal({ user, message, image, historicoConversa = [], intencaoNaoSuportada = false }) {
    const state = await getConversationState(user.id);
    console.log(`📊 Estado atual de ${user.phone}: ${state.state}`);

    const medications = await getUserMedications(user.id);
    const recentDoses = await getRecentDoses(user.id, 3);

    const [dosesRetroativas, dosesConfirmadasHoje] = await Promise.all([
        getDosesRetroativas(user.id, 2),
        getDosesConfirmadasHoje(user.id)
    ]);

    const userMessage = buildUserMessage({ text: message, image, user, state, medications, recentDoses, dosesRetroativas, dosesConfirmadasHoje, historicoConversa, intencaoNaoSuportada });

    console.log(`🤖 Chamando Claude para: "${message}"`);
    let claudeResponse = await callClaude({ userMessage, image });
    const acoesTipos = (claudeResponse.actions || []).map(a => a.type).join(', ') || claudeResponse.action?.type || 'nenhuma';
    console.log(`✅ Claude respondeu — newState: ${claudeResponse.newState}, actions: ${acoesTipos}`);

    // Compatibilidade: aceita tanto o formato novo (actions: array)
    // quanto o formato antigo (action: objeto único)
    let listaAcoes = [];
    if (Array.isArray(claudeResponse.actions)) {
        listaAcoes = claudeResponse.actions;
    } else if (claudeResponse.action) {
        listaAcoes = [claudeResponse.action];
    }

    // Processa todas as ações em sequência.
    // Alertas de estoque de cada confirmação são acumulados e anexados à mensagem.
    let alertasEstoque = '';
    for (const acao of listaAcoes) {
        const override = await processAction(acao, user);
        if (override) {
            if (override.alertaEstoque) {
                alertasEstoque += override.alertaEstoque;
            } else {
                claudeResponse = { ...claudeResponse, ...override };
            }
        }
    }
    if (alertasEstoque) {
        claudeResponse = {
            ...claudeResponse,
            message: claudeResponse.message + alertasEstoque
        };
    }

    await updateConversationState(
        user.id,
        claudeResponse.newState || 'idle',
        claudeResponse.context || {}
    );

    return claudeResponse.message;
}

function buildUserMessage({ text, image, user, state, medications, recentDoses, dosesRetroativas = [], dosesConfirmadasHoje = [], historicoConversa = [], intencaoNaoSuportada = false }) {
    const dosesPendentes = recentDoses.filter(d =>
        d.reminder_sent === true &&
        d.confirmed === false &&
        d.status !== 'nao_informado' &&
        d.status !== 'pausado' &&
        d.status !== 'nao_tomado' &&
        d.status !== 'sem_estoque'
    );

    const blocoPendentes = dosesPendentes.length === 0
        ? 'Nenhuma dose aguardando confirmação no momento.'
        : dosesPendentes.map(d => {
            const nome = d.medications?.nome || 'medicamento';
            const hora = new Date(d.scheduled_at).toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            return `⚠️ ${nome} — dose das ${hora} [ref: ${d.id}]`;
        }).join('\n');

    // BUG-059: o Claude não recebia nenhuma âncora de "hoje" para julgar se uma dose
    // retroativa era de hoje, ontem ou anteontem — e adivinhava errado no texto livre.
    // calcularRotuloDia() resolve isso deterministicamente (mesmo princípio já aplicado
    // em calcularProximaDose, ver prompts.js), comparando a data local (America/Sao_Paulo)
    // do scheduled_at com a data local de agora.
    function calcularRotuloDia(scheduledDate) {
        const opts = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' };
        const dataStr = scheduledDate.toLocaleDateString('pt-BR', opts);

        const hojeStr = new Date().toLocaleDateString('pt-BR', opts);
        if (dataStr === hojeStr) return 'hoje';

        const ontemStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR', opts);
        if (dataStr === ontemStr) return 'ontem';

        const anteontemStr = new Date(Date.now() - 48 * 60 * 60 * 1000).toLocaleDateString('pt-BR', opts);
        if (dataStr === anteontemStr) return 'anteontem';

        return null; // fora da janela de 2 dias coberta por getDosesRetroativas — não deveria ocorrer
    }

    const blocoRetroativo = dosesRetroativas.length === 0 ? null :
        dosesRetroativas.map(d => {
            const nome = d.medications?.nome || 'medicamento';
            const scheduledDate = new Date(d.scheduled_at);
            const dataStr = scheduledDate.toLocaleDateString('pt-BR', {
                day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            const hora = scheduledDate.toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            const rotulo = calcularRotuloDia(scheduledDate);
            const rotuloStr = rotulo ? `${rotulo} (${dataStr})` : dataStr;
            return `⏰ ${nome} — dose de ${rotuloStr} às ${hora} [ref-retro: ${d.id}]`;
        }).join('\n');

    const blocoConfirmadasHoje = dosesConfirmadasHoje.length === 0 ? null :
        dosesConfirmadasHoje.map(d => {
            const nome = d.medications?.nome || 'medicamento';
            const hora = new Date(d.taken_at).toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            return `✅ ${nome} — confirmada às ${hora} [ref-conf: ${d.id}]`;
        }).join('\n');

    const agora = new Date();
    const dataAtualStr = agora.toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'long', timeZone: 'America/Sao_Paulo'
    });
    const horaAtualStr = agora.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
    });

    const context = `
=== CONTEXTO DO USUÁRIO ===
Nome: ${user.name || 'ainda não informado'}
Agora é ${dataAtualStr}, ${horaAtualStr} (horário de Brasília). Use esta data como
referência para qualquer menção a "hoje", "ontem", "amanhã" ou datas relativas — nunca
calcule isso de outra forma.
Estado da conversa: ${state.state}
Dados parciais em andamento: ${JSON.stringify(state.context)}

Medicamentos cadastrados: ${medications.length === 0
        ? 'nenhum ainda'
        : medications.map(m => {
            const schedulesAtivos = m.schedules ? m.schedules.filter(s => s.ativo) : [];
            const horarios = schedulesAtivos.length > 0
                ? schedulesAtivos.map(s => s.horario).join(', ')
                : 'nenhum horário cadastrado';

            const proximaDose = calcularProximaDose(schedulesAtivos);
            const proximaDoseStr = proximaDose
                ? `próxima dose: ${proximaDose.horario} (${proximaDose.quando})`
                : 'sem próxima dose calculada';

            const tratamentoInfo = `tipo: ${m.tipo_tratamento || 'contínuo'}`;

            return `[id:${m.id}] ${m.nome} (${m.dosagem}, estoque: ${m.estoque_atual}, horários: ${horarios}, ${proximaDoseStr}, ${tratamentoInfo})`;
        }).join(' | ')
    }

=== DOSES AGUARDANDO CONFIRMAÇÃO ===
${blocoPendentes}

Como usar este bloco:
- Se o usuário responder confirmando que tomou (qualquer forma: "sim", "tomei", "já tomei", "isso", "tomei sim", etc.), emita CONFIRM_DOSE para a(s) dose(s) correspondente(s), usando o valor [ref: ...] no campo doseLogId.
- Se houver várias doses pendentes e o usuário confirmar coletivamente ("tomei todos", "tomei os dois"), emita um CONFIRM_DOSE para cada [ref] da lista.
- Se o usuário mencionar um medicamento ou horário específico, confirme apenas a dose correspondente.
- Se o usuário falar de OUTRA coisa (estoque, horário, dúvida, "comprei mais X"), ajude normalmente com o assunto dele. NÃO force confirmação. As doses continuam pendentes e serão cobradas depois.
${blocoRetroativo ? `
=== DOSES SEM CONFIRMAÇÃO — ÚLTIMOS 2 DIAS ===
${blocoRetroativo}

Como usar este bloco:
- O rótulo do dia (hoje/ontem/anteontem) já vem calculado no bloco acima — use-o exatamente como está, nunca calcule ou infira esse rótulo por conta própria.
- Se o usuário mencionar ter tomado uma dose do passado (ex: "tomei o ômega 3 de ontem", "tomei os remédios de anteontem"), apresente a dose específica ao usuário e PEÇA CONFIRMAÇÃO EXPLÍCITA antes de registrar. Aguarde "sim" / "isso" / "tomei".
- Após confirmação explícita → CONFIRM_RETROATIVA com o [ref-retro: ...] correspondente.
- Se o usuário disser que não tomou → REGISTER_NAO_TOMADO com o [ref-retro: ...].
- Se a referência for além de 2 dias → informe o limite e ofereça UPDATE_STOCK.
- NUNCA use [ref-retro: ...] em CONFIRM_DOSE. Contextos completamente separados.
` : ''}${blocoConfirmadasHoje ? `
=== DOSES CONFIRMADAS HOJE ===
${blocoConfirmadasHoje}

Como usar este bloco:
- Se o usuário disser que NÃO tomou um medicamento listado aqui (ex: "na verdade não tomei o X", "errei, não foi esse", "confirmei sem querer"), emita REVERSE_CONFIRMATION com o [ref-conf: ...] correspondente. A declaração já é suficiente, não peça confirmação.
- NUNCA use [ref-conf: ...] em CONFIRM_DOSE ou CONFIRM_RETROATIVA.
` : ''}
Doses recentes (contexto histórico): ${recentDoses.length === 0
        ? 'nenhuma ainda'
        : JSON.stringify(recentDoses.slice(0, 5))
    }

=== CONVERSA RECENTE (apenas para entender referências como "ele", "esse", "ok") ===
${formatarHistoricoConversa(historicoConversa)}

IMPORTANTE: O bloco "DOSES AGUARDANDO CONFIRMAÇÃO" acima tem PRECEDÊNCIA. Se há dose pendente e o usuário responde algo afirmativo ("sim", "tomei", etc.), isso é confirmação de dose — NUNCA trate como fechamento social, mesmo que a conversa recente sugira fim de papo. Use a CONVERSA RECENTE apenas para: (1) resolver pronomes ("dele", "esse") referindo-se ao último medicamento/assunto mencionado; (2) reconhecer fechamentos curtos ("ok", "obrigado", "entendi") como encerramento acolhedor SOMENTE quando NÃO há dose pendente.

=== FIM DO CONTEXTO ===
${intencaoNaoSuportada ? `
=== ATENÇÃO: INTENÇÃO NÃO SUPORTADA ===
O usuário pediu algo que a Nami AINDA NÃO faz. Responda com honestidade e gentileza:
- Explique que essa funcionalidade ainda está em desenvolvimento
- NÃO invente que consegue fazer
- NÃO derive para pausar/encerrar/cadastrar
- Pergunte se pode ajudar com outra coisa (cadastrar, consultar, alterar horários, pausar/reativar)
` : ''}
Mensagem do usuário: ${text || '[usuário enviou uma imagem]'}
    `.trim();
    return context;
}

async function callClaude({ userMessage, image }) {
    const content = image
        ? [
            { type: 'image', source: { type: 'url', url: image } },
            { type: 'text', text: userMessage }
        ]
        : [{ type: 'text', text: userMessage }];

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: NAMI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }]
    });

    const rawText = response.content[0].text;

    try {
        return JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch {
                console.error('❌ Falha ao extrair JSON:', rawText);
            }
        }
        console.error('❌ Claude não retornou JSON válido:', rawText);
        return {
            message: rawText.length > 10 && rawText.length < 500
                ? rawText
                : 'Desculpe, não entendi bem. Pode repetir? 🌿',
            newState: 'idle',
            context: {},
            action: null
        };
    }
}

async function processAction(action, user) {
    switch (action.type) {

        case 'SET_USER_NAME':
            await updateUserName(user.id, action.name);
            return null;

        case 'CONFIRM_DOSE': {
            let medId;
            if (action.doseLogId) {
                medId = await confirmDoseByLogId(action.doseLogId);
            } else if (action.medicationId) {
                await confirmDose(action.medicationId);
                medId = action.medicationId;
            } else {
                console.warn('⚠️ CONFIRM_DOSE sem doseLogId nem medicationId');
                return null;
            }

            // Verificar se deve emitir alerta de estoque pós-confirmação
            try {
                const estoqueInfo = await getEstoqueInfoParaAlerta(medId);
                if (estoqueInfo) {
                    const confirmacoesDoDia = await contarConfirmacoesHoje(medId);
                    const deveAlertar = calcularAlertaEstoque({
                        diasRestantes: estoqueInfo.diasRestantes,
                        tipo_tratamento: estoqueInfo.tipo_tratamento,
                        tratamento_dias: estoqueInfo.tratamento_dias,
                        confirmacoesDoDia
                    });
                    if (deveAlertar) {
                        return { alertaEstoque: buildAlertaEstoquePosConfirmacao(estoqueInfo) };
                    }
                }
            } catch (e) {
                console.error('⚠️ Erro ao verificar alerta de estoque pós-confirmação:', e.message);
            }
            return null;
        }

        case 'CONFIRM_RETROATIVA': {
            if (!action.doseLogId) {
                console.warn('⚠️ CONFIRM_RETROATIVA sem doseLogId — ignorando');
                return null;
            }
            let medIdRetro;
            try {
                medIdRetro = await confirmarDoseRetroativa(
                    action.doseLogId,
                    'usuário confirmou retroativamente via chat'
                );
            } catch (e) {
                console.error('⚠️ Erro em CONFIRM_RETROATIVA:', e.message);
                return null;
            }
            try {
                const estoqueInfo = await getEstoqueInfoParaAlerta(medIdRetro);
                if (estoqueInfo) {
                    const confirmacoesDoDia = await contarConfirmacoesHoje(medIdRetro);
                    const deveAlertar = calcularAlertaEstoque({
                        diasRestantes: estoqueInfo.diasRestantes,
                        tipo_tratamento: estoqueInfo.tipo_tratamento,
                        tratamento_dias: estoqueInfo.tratamento_dias,
                        confirmacoesDoDia
                    });
                    if (deveAlertar) {
                        return { alertaEstoque: buildAlertaEstoquePosConfirmacao(estoqueInfo) };
                    }
                }
            } catch (e) {
                console.error('⚠️ Erro ao verificar alerta pós-CONFIRM_RETROATIVA:', e.message);
            }
            return null;
        }

        case 'REVERSE_CONFIRMATION': {
            if (!action.doseLogId) {
                console.warn('⚠️ REVERSE_CONFIRMATION sem doseLogId — ignorando');
                return null;
            }
            try {
                const { novoStatus } = await reverterConfirmacao(
                    action.doseLogId,
                    'usuário informou que confirmação foi por engano'
                );
                console.log(`↩️ Confirmação revertida via chat — novo status: ${novoStatus}`);
            } catch (e) {
                console.error('⚠️ Erro em REVERSE_CONFIRMATION:', e.message);
            }
            return null;
        }

        case 'REGISTER_NAO_TOMADO':
            if (action.doseLogId) {
                await registrarNaoTomado(null, action.doseLogId);
                console.log(`🚫 Dose retroativa registrada como não tomada — doseLogId: ${action.doseLogId}`);
            } else if (action.medicationId) {
                await registrarNaoTomado(action.medicationId);
                console.log(`🚫 Dose registrada como não tomada — medicationId: ${action.medicationId}`);
            } else {
                console.warn('⚠️ REGISTER_NAO_TOMADO sem doseLogId nem medicationId — ignorando');
            }
            return null;

        case 'UPDATE_STOCK': {
            if (!action.medicationId) {
                console.warn('⚠️ UPDATE_STOCK sem medicationId — ignorando');
                return null;
            }

            let params;
            switch (action.modo) {
                case 'soma':
                    params = {
                        tipo: action.motivo === 'recompra' ? 'recompra' : 'correcao_soma',
                        delta: action.quantidade
                    };
                    break;
                case 'subtracao':
                    params = { tipo: 'correcao_subtracao', delta: -action.quantidade };
                    break;
                case 'set':
                    params = { tipo: 'correcao_set', valorAbsoluto: action.quantidade };
                    break;
                default:
                    console.warn(`⚠️ UPDATE_STOCK com modo desconhecido: ${action.modo}`);
                    return null;
            }

            const { estoqueAnterior, estoqueNovo, deltaAplicado } = await registrarMovimentoEstoque({
                medicationId: action.medicationId,
                origem: 'manual',
                motivo: action.motivo || null,
                ...params
            });

            let textoFinal = '';
            try {
                const statusInfo = await getEstoqueStatusSimples(action.medicationId);
                if (statusInfo) {
                    // Passo 1 — informativo determinístico (nunca o número que o LLM escreveu)
                    textoFinal += buildEstoqueAtualizadoMessage({
                        medNome: statusInfo.medNome,
                        estoqueAnterior,
                        estoqueNovo,
                        deltaAplicado,
                        // "quantidade" só representa um delta pedido em soma/subtracao; em "set" é o
                        // total desejado, não comparável a deltaAplicado — não faz sentido de clamp aqui.
                        quantidadeSolicitada: action.modo === 'set' ? null : action.quantidade
                    });
                    // Passo 2 — alerta de limiar, função existente e intocada
                    textoFinal += buildAlertaEstoqueAjusteMessage(statusInfo);
                }
            } catch (e) {
                console.error('⚠️ Erro ao montar mensagem de estoque atualizado:', e.message);
            }
            return textoFinal ? { alertaEstoque: textoFinal } : null;
        }

        default:
            console.warn(`⚠️ Ação desconhecida no agente principal: ${action.type}`);
            return null;
    }
}
