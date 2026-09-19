// ============================================================
// RUNNER DE COLETA (v44 M2, briefing §2)
//
// Uma implementação, quatro responsabilidades, nada além:
//
// 1. O QUE FALTA — proximaPendencia é a função ÚNICA que decide o
//    próximo campo (mata em definitivo a dupla primeiraEtapaFaltante/
//    proximaEtapaFaltante).
// 2. ABSORVER A MENSAGEM — todo turno passa pelo validador do campo
//    corrente e, quando a mensagem sugere campos incidentais, pelo
//    extrator completo (P57) — que só preenche vazio, NUNCA
//    sobrescreve validador especializado.
// 3. QUANDO GRAVAR E O QUE DIZER — gravação por ponto único
//    (gravarTratamento) com guarda anti-duplicata (ACH-3 em
//    saveSchedule); mensagens de persistência 100% template lendo
//    PÓS-ESCRITA (regra 2).
// 4. QUANDO DEVOLVER — contrato universal da porta: finalizou /
//    ruído / dúvida / mudou de fluxo → devolve ao roteador.
//
// O runner é a implementação de referência: M3 (configuração/
// relatórios) e M4 (onboarding) o reutilizam. Ele é genérico sobre o
// SCHEMA recebido; tudo que é texto do cadastro vive no schema.
// ============================================================

import {
    saveConversationState,
    saveMedication,
    saveSchedule,
    verificarMedicamentoExistente,
    getUserMedications,
    registrarMovimentoEstoque,
    getMedicationComSchedulesAtivos,
    encerrarTratamento
} from './database.js';
import { detectarRecorrenciaNaoSuportada, extrairHorariosCitados } from './validadores/recorrencia.js';
import { classificarIndeterminadoCadastro } from './validadores/falha.js';
import { calcularAlertaEstoqueCadastro } from './validadores/estoque.js';
import { extrairCadastroCompleto, mapearExtracaoParaCampos, aplicarExtracaoEmVazios } from './validadores/extratorCompleto.js';
import { derivarFormaFarmaceutica } from './validadores/derivacoes.js';
import {
    ACOES_DE_FALHA,
    renderizarPerguntaNome, renderizarPerguntaPosologia, renderizarPerguntaEstoque,
    renderizarPrefacioDuvida, renderizarDeclarativa, renderizarResumoDoMedicamento,
    renderizarFechamentoEstoque, renderizarFechamentoCadastroJaGravado,
    renderizarCancelamentoSemGravacao, renderizarRecusaSemGravacao,
    renderizarDuplicataAtiva, renderizarDuplicataPausada, renderizarPropostaReencadastro,
    renderizarReencadastroRecusado, renderizarDuplicataNaGravacao, renderizarBloqueioRecorrencia
} from './schemas/cadastro.js';

// Cancelamento determinístico — o LLM não decide transições.
const TERMOS_CANCELAMENTO = [
    'cancela', 'cancelar', 'deixa pra lá', 'deixa pra la', 'deixa quieto', 'esquece isso',
    'esquece', 'desiste', 'não quero mais', 'nao quero mais'
];

function ehCancelamento(message) {
    const msg = String(message).toLowerCase().trim();
    return TERMOS_CANCELAMENTO.some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ','));
}

// ------------------------------------------------------------
// 1. O QUE FALTA — função ÚNICA de pendência (ordem canônica do
// schema, P50). Have-to-have primeiro; gravação no instante em que
// eles completam (P56); campos pós-gravação depois.
// ------------------------------------------------------------

export function proximaPendencia(schema, campos) {
    for (const campo of schema.campos) {
        if (campo.perguntavel === false) continue;
        if (campo.posGravacao && !campos?.medication_id) {
            return { acao: 'gravar' };
        }
        if (campo.faltando(campos)) {
            return { acao: 'perguntar', campo, etapa: campo.etapa(campos) };
        }
    }
    return { acao: 'concluido' };
}

// ------------------------------------------------------------
// Renderização da pergunta pendente — compartilhada entre o fluxo
// normal e a reentrada pós-escalada (repetirPergunta).
// ------------------------------------------------------------

function montarPerguntaPendente({ pend, campos, userName, resultado = null, motivoFalha = null, nomeRecemColetado = false, mensagemUsuario = '' }) {
    const nomeCampo = pend.campo?.nome;
    let pergunta;

    if (nomeCampo === 'nome') {
        pergunta = renderizarPerguntaNome({
            userName,
            motivoFalha,
            nomeRecusadoPorDosagem: !!resultado?.nomeRecusadoPorDosagem
        });
    } else if (nomeCampo === 'posologia') {
        pergunta = renderizarPerguntaPosologia({
            campos, userName,
            acao: resultado?.acao ?? null,
            motivoFalha,
            mencionaConcentracao: !!resultado?.mencionaConcentracao,
            nomeRecemColetado,
            mensagemUsuario
        });
    } else if (nomeCampo === 'estoque') {
        const acaoEstoque = resultado && ACOES_DE_FALHA.has(resultado.acao) ? resultado.acao : null;
        pergunta = renderizarPerguntaEstoque(pend.etapa, campos, acaoEstoque);
    } else {
        pergunta = renderizarPerguntaNome({ userName });
    }

    if (motivoFalha === 'duvida') {
        return `${renderizarPrefacioDuvida()}\n\n${pergunta}`;
    }
    return pergunta;
}

// ------------------------------------------------------------
// 3. GRAVAÇÃO — ponto único. Grava medication + schedules como
// unidade (invariante: todo ativo tem ao menos um schedule ativo) e
// devolve a mensagem pós-escrita (declarativa + resumo do banco).
// ------------------------------------------------------------

async function gravarTratamento(campos, user) {
    const forma = derivarFormaFarmaceutica(campos.forma_explicita, campos.forma_confirmada, campos.unidade_dose);
    const estoqueJaConhecido = campos.estoque_resolvido !== null && campos.estoque_resolvido !== undefined;

    const med = await saveMedication({
        userId: user.id,
        nome: campos.nome,
        forma,
        dosagem: campos.dosagem ?? null,
        tipo_tratamento: campos.tipo_tratamento || 'continuo',
        tratamento_dias: campos.tratamento_dias || null,
        // P49: NUNCA `estoque || 0` — "não informado" é diferente de "zero".
        estoque: estoqueJaConhecido ? campos.estoque_resolvido : null,
        unidade_dose: campos.unidade_dose || 'unidade',
        unidade_estoque: campos.unidade_estoque || 'unidade',
        gotas_por_ml: campos.gotas_por_ml ?? null,
        estoqueMotivo: estoqueJaConhecido ? (campos.estoque_motivo || null) : null,
        estoqueEstimado: estoqueJaConhecido ? !!campos.estoque_estimado : false
    });

    if (med.isDuplicate) {
        return { duplicata: med };
    }

    // Invariante (v43 Bloco C, Parte 3.3): medication+schedules como unidade — se
    // o insert de schedules falhar no meio, o medicamento é desativado antes de
    // propagar o erro, nunca fica órfão sem horário.
    try {
        for (const par of campos.pares_posologia || []) {
            await saveSchedule({
                medicationId: med.id,
                horario: String(par.horario).trim().substring(0, 5),
                quantidadePorDose: Number(par.quantidade) || 1
            });
        }
    } catch (e) {
        console.error(`❌ Falha ao salvar horários de ${campos.nome} (id: ${med.id}) — desativando para preservar o invariante:`, e.message);
        await encerrarTratamento(med.id);
        throw e;
    }

    console.log(`✅ Medicamento salvo: ${campos.nome} (id: ${med.id}) para ${user.phone}`);
    return { med };
}

// Leitura pós-escrita para o resumo (P56) — nunca o rascunho.
async function lerMedicamentoGravado(medicationId) {
    const med = await getMedicationComSchedulesAtivos(medicationId);
    const pares = med.schedulesAtivos
        .map(s => ({ horario: String(s.horario).substring(0, 5), quantidade: Number(s.quantidade_por_dose) }))
        .sort((a, b) => a.horario.localeCompare(b.horario));
    return { med, pares };
}

// ------------------------------------------------------------
// Fechamentos pela verdade do banco (P56)
// ------------------------------------------------------------

async function fecharComCadastroJaGravado(user, campos) {
    await saveConversationState(user.id, { state: 'idle', context: {} });
    let nome = campos?.nome || 'seu remédio';
    let horarios = [];
    try {
        const med = await getMedicationComSchedulesAtivos(campos.medication_id);
        if (med) {
            nome = med.nome;
            horarios = (med.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5));
        }
    } catch (e) {
        console.error('⚠️ Erro ao ler medicamento gravado no fechamento:', e.message);
    }
    const firstName = user.name ? user.name.split(' ')[0] : null;
    return renderizarFechamentoCadastroJaGravado({ nome, horarios, firstName });
}

// ------------------------------------------------------------
// HANDLER DO RUNNER — chamado pelo roteador no lugar do antigo
// handleCadastro. `context` é o estado plano do tratamento corrente
// (campos coletados + etapa informacional).
// ------------------------------------------------------------

export async function executarRunner({ schema, user, message, state, context, historicoConversa = [] }) {
    const campos = { ...(context || {}) };
    if (!campos.sujeito) campos.sujeito = schema.sujeito?.padrao || 'usuario';
    const etapaEntrada = context?.etapa || 'cad_nome';
    console.log(`💊 Runner (${schema.nome}) — etapa de entrada: ${etapaEntrada} — ${user.phone}`);

    const firstName = user.name ? user.name.split(' ')[0] : null;

    // Reencadastro pendente (medicamento encerrado → novo tratamento?).
    if (etapaEntrada === 'cad_reencadastro_confirmar') {
        const msg = String(message).toLowerCase().trim();
        const confirmou = ['sim', 's', 'ok', 'pode', 'claro', 'quero', 'sim quero', 'vai', 'vamos'].some(t => msg === t || msg.startsWith(t + ' '));

        if (!confirmou) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return renderizarReencadastroRecusado();
        }

        // Novo tratamento, novo registro — entra na primeira pendência de verdade.
        const camposReinicio = { sujeito: campos.sujeito, nome: campos.nome };
        const pendReinicio = proximaPendencia(schema, camposReinicio);
        await saveConversationState(user.id, {
            state: schema.estadoConversa,
            context: { ...camposReinicio, etapa: pendReinicio.etapa }
        });
        return montarPerguntaPendente({
            pend: pendReinicio, campos: camposReinicio, userName: user.name, nomeRecemColetado: true
        });
    }

    // Cancelamento determinístico. Com o medicamento JÁ gravado (gravação
    // antecipada), recusar o que resta NÃO é cancelar (evidência A6).
    if (ehCancelamento(message)) {
        if (campos?.medication_id) return await fecharComCadastroJaGravado(user, campos);
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return renderizarCancelamentoSemGravacao();
    }

    // 1. O QUE FALTA — pendência corrente.
    const pend = proximaPendencia(schema, campos);

    // 2. ABSORVER — validador do campo corrente (camada 1).
    let resultado = { acao: 'estado_pronto', updates: {} };
    let motivoFalha = null;
    if (pend.acao === 'perguntar') {
        resultado = await pend.campo.validador({ message, campos, historicoConversa });

        // 4. QUANDO DEVOLVER — contrato universal (camada 2 só na falha da camada 1).
        if (ACOES_DE_FALHA.has(resultado.acao)) {
            const motivo = await classificarIndeterminadoCadastro({
                message,
                etapa: pend.etapa,
                nomeMedicamento: campos?.nome,
                historicoConversa
            });

            if (motivo === 'nova_intencao') {
                console.log(`💊 [RUNNER] Nova intenção fora do ${schema.nome} — devolvendo ao roteador — ${user.phone}`);
                return { escalarParaRoteador: true };
            }
            if (motivo === 'recusa') {
                if (campos?.medication_id) {
                    console.log(`💊 [RUNNER] Recusa do opcional com medicamento já gravado — fechando pela verdade do banco — ${user.phone}`);
                    return await fecharComCadastroJaGravado(user, campos);
                }
                console.log(`💊 [RUNNER] Recusa explícita — encerrando ${schema.nome} — ${user.phone}`);
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return renderizarRecusaSemGravacao();
            }
            motivoFalha = motivo; // duvida | ruido — repete a pergunta pendente
        }
    }

    let camposNovos = { ...campos, ...resultado.updates };

    // 2b. Campos incidentais pelo extrator completo (P57): estoque ("tenho 40cps")
    // e tratamento ("por 5 dias") ditos junto da posologia nunca se perdem. O
    // extrator só preenche vazio e NUNCA roda por cima de uma falha do
    // especialista (a recusa dele também é decisão).
    if (!motivoFalha && pend.acao === 'perguntar' && pend.campo.nome === 'posologia') {
        const sugereEstoque = /\btenho\b|\bem casa\b|\bestoque\b|\bcaixa\b|\bfrascos?\b|\bsobra\w*\b|\brestam?\b/i.test(message)
            && !campos?.estoque_perguntado
            && (campos?.estoque_resolvido === undefined || campos?.estoque_resolvido === null);
        const sugereTratamento = /\b(por|durante)\s+(\d+|uma?|duas?)\s+(dias?|semanas?)\b|\buso\s+cont[íi]nuo\b/i.test(message)
            && !campos?.tipo_tratamento;
        if (sugereEstoque || sugereTratamento) {
            try {
                const completo = await extrairCadastroCompleto({ message, historicoConversa });
                const mapeados = mapearExtracaoParaCampos({ ...completo, nome: campos?.nome || completo.nome });
                const CAMPOS_RESGATAVEIS = [
                    'quantidade_pendente', 'unidade_dose_pendente', 'forma_explicita_pendente',
                    ...(sugereEstoque ? ['estoque_resolvido', 'estoque_motivo', 'estoque_estimado',
                        'status_frasco', 'volume_frasco', 'frascos', 'estoque_fracao_pendente'] : []),
                    ...(sugereTratamento ? ['tipo_tratamento', 'tratamento_dias', 'tipo_tratamento_pendente'] : [])
                ];
                const resgatados = aplicarExtracaoEmVazios(camposNovos, mapeados, CAMPOS_RESGATAVEIS);
                camposNovos = { ...camposNovos, ...resgatados };
                if (resgatados.estoque_resolvido !== undefined && resgatados.estoque_resolvido !== null) {
                    console.log(`📦 [RUNNER] Estoque resgatado da mensagem de posologia: ${resgatados.estoque_resolvido}`);
                }
                if (resgatados.tratamento_dias !== undefined && resgatados.tratamento_dias !== null) {
                    console.log(`🔄 [RUNNER] Tratamento resgatado da mensagem de posologia: ${resgatados.tratamento_dias} dias`);
                }
            } catch (e) {
                console.error('⚠️ Resgate de campos incidentais na posologia falhou (fluxo segue sem eles):', e.message);
            }
        }
    }

    // Validador de recorrência (v44 §5.7, evidência A3): padrão de dia-da-semana/
    // frequência não representável NUNCA vira gravação silenciosa de horários
    // diários (regra 7). Horários desta mensagem bloqueados; o resto preservado.
    const mensagemTrouxeHorarios =
        (Array.isArray(resultado.updates?.horarios) && resultado.updates.horarios.length > 0) ||
        (Array.isArray(resultado.updates?.pares_posologia) && resultado.updates.pares_posologia.length > 0);
    const recorrencia = detectarRecorrenciaNaoSuportada(message);
    const horariosNaMensagem = extrairHorariosCitados(message);

    if (recorrencia.detectado && (mensagemTrouxeHorarios || horariosNaMensagem.length > 0)) {
        const { horarios, pares_posologia, intervalo_horas, horario_inicio, ...camposPreservados } = camposNovos;

        // Quantidade embutida nos pares bloqueados sobrevive como pendente.
        const quantidades = [...new Set((pares_posologia || []).map(p => Number(p.quantidade)).filter(Boolean))];
        if (quantidades.length === 1 && camposPreservados.quantidade_pendente == null) {
            camposPreservados.quantidade_pendente = quantidades[0];
            camposPreservados.unidade_dose_pendente = camposPreservados.unidade_dose || null;
            camposPreservados.forma_explicita_pendente = camposPreservados.forma_explicita || null;
        }

        await saveConversationState(user.id, {
            state: schema.estadoConversa,
            context: { ...camposPreservados, etapa: 'cad_horarios' }
        });

        console.log(`🧱 [VALIDADOR] Recorrência não suportada (${recorrencia.padroes.join(', ')}) — horários bloqueados — ${user.phone}`);
        return renderizarBloqueioRecorrencia(horariosNaMensagem);
    }

    // Verificação antecipada de medicamento existente — o gatilho é o FATO "o
    // nome acabou de ser coletado", não a posição na máquina.
    const nomeRecemColetado = !campos?.nome && !!camposNovos.nome;
    if (nomeRecemColetado) {
        const existente = await verificarMedicamentoExistente(user.id, camposNovos.nome);

        if (existente) {
            const schedules = existente.schedules || [];
            const schedulesAtivos = schedules.filter(s => s.ativo);
            const todosInativos = schedules.length > 0 && schedulesAtivos.length === 0;

            if (!existente.ativo) {
                await saveConversationState(user.id, {
                    state: schema.estadoConversa,
                    context: {
                        etapa: 'cad_reencadastro_confirmar',
                        sujeito: campos.sujeito,
                        nome: existente.nome,
                        medicationId: existente.id
                    }
                });
                return renderizarPropostaReencadastro(existente.nome);
            }

            if (todosInativos) {
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: {
                        etapa: 'reativ_confirmar',
                        medicationId: existente.id,
                        medicationNome: existente.nome,
                        estoqueAtual: existente.estoque_atual,
                        tipo_tratamento: existente.tipo_tratamento,
                        tratamento_dias: existente.tratamento_dias,
                        schedulesExistentes: schedules,
                        schedulesAtivos: schedulesAtivos
                    }
                });
                return renderizarDuplicataPausada(existente, schedules.map(s => s.horario.substring(0, 5)));
            }

            await saveConversationState(user.id, { state: 'idle', context: {} });
            return renderizarDuplicataAtiva(existente, schedulesAtivos.map(s => s.horario.substring(0, 5)));
        }
    }

    // Estoque respondido — com valor ou "não sei" — FECHA o cadastro (v44,
    // decisão de produto 19/09; sem etapa de confirmação).
    if (resultado.resolvido !== undefined && resultado.resolvido !== null) {
        const { valor } = resultado.resolvido;
        let alerta = null;
        if (valor !== null) {
            await registrarMovimentoEstoque({
                medicationId: campos.medication_id,
                tipo: 'cadastro_inicial',
                origem: 'manual',
                motivo: resultado.resolvido.motivo,
                estimado: resultado.resolvido.estimado,
                valorAbsoluto: valor
            });
            alerta = calcularAlertaEstoqueCadastro(camposNovos, valor);
        }
        const { med } = await lerMedicamentoGravado(campos.medication_id);
        const fechamento = renderizarFechamentoEstoque({
            med,
            alerta,
            primeiroMedicamento: !!campos?.primeiroMedicamento,
            firstName
        });
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return fechamento;
    }

    // 3. QUANDO GRAVAR — have-to-have completo → gravação no mesmo turno (P56).
    const pendNova = proximaPendencia(schema, camposNovos);

    if (pendNova.acao === 'gravar') {
        const medicamentosAtivosAntes = await getUserMedications(user.id);
        const primeiroMedicamento = medicamentosAtivosAntes.length === 0;

        const resultadoGravacao = await gravarTratamento(camposNovos, user);

        if (resultadoGravacao.duplicata) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return renderizarDuplicataNaGravacao(resultadoGravacao.duplicata);
        }

        console.log(`✅ [RUNNER] Gravação no have-to-have completo: ${resultadoGravacao.med.nome} (id: ${resultadoGravacao.med.id}) — ${user.phone}`);

        const estoqueJaConhecido = camposNovos.estoque_resolvido !== null && camposNovos.estoque_resolvido !== undefined;
        const camposComMedId = {
            ...camposNovos,
            medication_id: resultadoGravacao.med.id,
            primeiroMedicamento,
            ...(estoqueJaConhecido ? {
                estoque_perguntado: true,
                alerta_estoque_baixo: calcularAlertaEstoqueCadastro(camposNovos, camposNovos.estoque_resolvido)
            } : {})
        };

        // Mensagem pós-gravação 100% determinística: declarativa (regra 2) +
        // resumo lido do banco (P56) + pergunta/fechamento de estoque.
        const { med: medGravado, pares } = await lerMedicamentoGravado(resultadoGravacao.med.id);
        const declarativa = renderizarDeclarativa(medGravado, user.name);
        const resumo = renderizarResumoDoMedicamento(medGravado, pares);

        const pendPosGravacao = proximaPendencia(schema, camposComMedId);
        if (pendPosGravacao.acao === 'perguntar' && pendPosGravacao.campo.nome === 'estoque') {
            const pergunta = renderizarPerguntaEstoque(pendPosGravacao.etapa, camposComMedId);
            await saveConversationState(user.id, {
                state: schema.estadoConversa,
                context: { ...camposComMedId, etapa: pendPosGravacao.etapa }
            });
            return `${declarativa}\n\n${resumo}\n\n${pergunta}`;
        }

        // Estoque já veio na mesma mensagem — nada mais a coletar: fechamento
        // curto; o resumo acima já traz a linha de estoque.
        const fechamento = renderizarFechamentoEstoque({
            med: medGravado,
            alerta: camposComMedId.alerta_estoque_baixo || null,
            primeiroMedicamento,
            firstName,
            resumoJaMostraEstoque: true
        });
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `${declarativa}\n\n${resumo}\n\n${fechamento}`;
    }

    if (pendNova.acao === 'concluido') {
        // Estado inconsistente raro (tudo coletado e estado ainda aberto) —
        // fecha pela verdade do banco.
        if (camposNovos.medication_id) return await fecharComCadastroJaGravado(user, camposNovos);
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return renderizarCancelamentoSemGravacao();
    }

    // Pergunta seguinte (ou repetição da pendente, na falha da camada 1).
    await saveConversationState(user.id, {
        state: schema.estadoConversa,
        context: { ...camposNovos, etapa: pendNova.etapa }
    });
    return montarPerguntaPendente({
        pend: pendNova,
        campos: camposNovos,
        userName: user.name,
        resultado,
        motivoFalha,
        nomeRecemColetado,
        mensagemUsuario: message
    });
}

// ------------------------------------------------------------
// Reentrada pós-escalada: a porta, reclassificando, devolveu o mesmo
// fluxo — está CONCORDANDO que o usuário não saiu dele. Repete a
// pergunta pendente sem reclassificar nada (render determinístico).
// ------------------------------------------------------------

export async function repetirPergunta({ schema, context, userName }) {
    const campos = { ...(context || {}) };
    const pend = proximaPendencia(schema, campos);
    if (pend.acao !== 'perguntar') {
        return renderizarPerguntaNome({ userName });
    }
    return montarPerguntaPendente({ pend, campos, userName });
}
