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
// MH-96 (M2 §3): o schema aceita LISTA de tratamentos — a divisão em
// candidatos (linhas, " e ", vírgulas) é mecanismo do runner+extrator
// (UM mecanismo de preenchimento, nunca dois); a fila sobrevive a
// desvio de fluxo; "medicamento diferente = cadastro novo" (MH-83:
// nada do anterior vaza para o novo).
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
import { derivarFormaFarmaceutica, montarParesPosologia } from './validadores/derivacoes.js';
import { classificarPosologia } from './validadores/posologia.js';
import { dividirCandidatos, dividirNomeComposto, todosComHorario } from './validadores/multiMed.js';
import { medicamentoDiferente } from './nlp_helpers.js';
import {
    ACOES_DE_FALHA,
    renderizarPerguntaNome, renderizarPerguntaPosologia, renderizarPerguntaEstoque,
    renderizarPrefacioDuvida, renderizarDeclarativa, renderizarResumoDoMedicamento,
    renderizarFechamentoEstoque, renderizarFechamentoCadastroJaGravado,
    renderizarCancelamentoSemGravacao, renderizarRecusaSemGravacao,
    renderizarDuplicataAtiva, renderizarDuplicataPausada, renderizarPropostaReencadastro,
    renderizarReencadastroRecusado, renderizarDuplicataNaGravacao, renderizarBloqueioRecorrencia,
    renderizarPropostaLote, renderizarAberturaFila, renderizarPropostaDivisaoNome,
    renderizarTransicaoFila, renderizarFechamentoLote, renderizarRepeticaoPropostaLote,
    renderizarFechamentoAnterior, renderizarConviteEstoqueLote, renderizarDeclarativaCurta,
    renderizarDuplicataCurta
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

function ehAfirmativoSimples(message) {
    const msg = String(message).toLowerCase().trim();
    return ['sim', 's', 'ok', 'pode', 'pode ser', 'claro', 'quero', 'isso', 'beleza', 'bora', 'vamos']
        .some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ','));
}

function ehNegativoSimples(message) {
    const msg = String(message).toLowerCase().trim();
    return ['não', 'nao', 'n'].some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ','));
}

function juntarPartes(...partes) {
    return partes.flat().filter(Boolean).join('\n\n');
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
// devolve o registro para leitura pós-escrita.
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

// Gravação em LOTE (MH-96): N tratamentos da mesma mensagem, cada um pelo
// MESMO ponto único de gravação. Fechamento 100% pós-escrita.
async function gravarLote({ itens, user, sujeito }) {
    const medicamentosAtivosAntes = await getUserMedications(user.id);
    const primeiroMedicamento = medicamentosAtivosAntes.length === 0;

    const gravados = [];
    const duplicatas = [];
    for (const item of itens) {
        const resultado = await gravarTratamento({
            sujeito,
            nome: item.nome,
            dosagem: item.dosagem ?? null,
            forma_explicita: item.formaExplicita ?? null,
            pares_posologia: item.pares,
            unidade_dose: 'unidade',
            unidade_estoque: 'unidade',
            gotas_por_ml: null
        }, user);
        if (resultado.duplicata) duplicatas.push(resultado.duplicata);
        else gravados.push(await lerMedicamentoGravado(resultado.med.id));
    }
    console.log(`✅ [RUNNER] Lote gravado: ${gravados.length} tratamento(s), ${duplicatas.length} duplicata(s) — ${user.phone}`);
    return { gravados, duplicatas, primeiroMedicamento };
}

// Campos de um candidato da fila quando NÃO há mensagem nova a validar
// (transição de fila, lote recusado) — dados determinísticos da divisão.
const FORMA_EXPLICITA_LOTE = { comprimido: 'comprimido', capsula: 'capsula', gota: 'gotas' };

function montarCamposDoCandidato({ sujeito, candidato, fila }) {
    const campos = { sujeito, fila };
    campos.nome = candidato.nome;
    if (candidato.dosagem) campos.dosagem = candidato.dosagem;
    if (candidato.grupo !== null && candidato.grupo !== undefined) campos.grupo = candidato.grupo;

    const horarios = candidato.horarios || [];
    if (horarios.length > 0 && candidato.quantidade) {
        campos.horarios = horarios;
        campos.pares_posologia = montarParesPosologia(horarios, candidato.quantidade);
        campos.unidade_dose = 'unidade';
        campos.unidade_estoque = 'unidade';
        campos.gotas_por_ml = null;
        campos.forma_explicita = FORMA_EXPLICITA_LOTE[candidato.formaRotulo] ?? null;
    } else if (horarios.length > 0) {
        campos.horarios = horarios;
    } else if (candidato.quantidade) {
        campos.quantidade_pendente = candidato.quantidade;
        campos.unidade_dose_pendente = 'unidade';
        campos.forma_explicita_pendente = FORMA_EXPLICITA_LOTE[candidato.formaRotulo] ?? null;
    }
    return campos;
}

// Avança a fila após uma gravação: grava em cadeia os candidatos já completos
// e para no primeiro incompleto (transição com a pergunta dele). Fila vazia →
// convite de estoque agregado e fechamento.
async function avancarFila({ schema, user, sujeito, fila, partesIniciais }) {
    let resto = [...fila];
    const partes = [...partesIniciais];

    while (resto.length > 0) {
        const candidato = resto[0];
        const camposC = montarCamposDoCandidato({ sujeito, candidato, fila: resto.slice(1) });
        const pendC = proximaPendencia(schema, camposC);

        if (pendC.acao === 'gravar') {
            const r = await gravarTratamento(camposC, user);
            if (r.duplicata) {
                partes.push(renderizarDuplicataCurta(r.duplicata.nome));
            } else {
                const { med, pares } = await lerMedicamentoGravado(r.med.id);
                partes.push(renderizarDeclarativaCurta(med, pares));
            }
            resto = resto.slice(1);
            continue;
        }

        await saveConversationState(user.id, {
            state: schema.estadoConversa,
            context: { ...camposC, etapa: pendC.etapa }
        });
        partes.push(renderizarTransicaoFila({ proximo: candidato }));
        return partes.join('\n\n');
    }

    await saveConversationState(user.id, { state: 'idle', context: {} });
    partes.push(renderizarConviteEstoqueLote());
    return partes.join('\n\n');
}

// Confirmação do LOTE proposto (MH-96): "sim" grava todos; quantidade dita
// aqui vale para os itens sem quantidade própria; "não" vira fila um-a-um;
// desvio segue o contrato universal (a fila/lote SOBREVIVE ao desvio).
async function tratarConfirmacaoLote({ schema, user, message, campos, historicoConversa }) {
    const lote = campos.lote;

    const gravarComQuantidade = async (quantidadePadrao) => {
        const itens = lote.map(c => ({
            nome: c.nome,
            dosagem: c.dosagem,
            formaExplicita: FORMA_EXPLICITA_LOTE[c.formaRotulo] ?? null,
            pares: montarParesPosologia(c.horarios, c.quantidade ?? quantidadePadrao ?? 1)
        }));
        const resultado = await gravarLote({ itens, user, sujeito: campos.sujeito });
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return renderizarFechamentoLote(resultado);
    };

    if (ehAfirmativoSimples(message)) return gravarComQuantidade(1);

    if (ehNegativoSimples(message) || ehCancelamento(message)) {
        const [primeiro, ...resto] = lote;
        const camposFila = montarCamposDoCandidato({ sujeito: campos.sujeito, candidato: primeiro, fila: resto });
        const pend = proximaPendencia(schema, camposFila);
        if (pend.acao === 'perguntar') {
            await saveConversationState(user.id, {
                state: schema.estadoConversa,
                context: { ...camposFila, etapa: pend.etapa }
            });
            return `Sem problemas — vamos um de cada vez então. 🌿\n\n${renderizarTransicaoFila({ proximo: primeiro })}`;
        }
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return renderizarRecusaSemGravacao();
    }

    // A resposta pode ser a quantidade que faltava ("1 de cada", "2 comprimidos").
    const classificacao = await classificarPosologia({
        message,
        campoEsperado: 'quantidade',
        nomeMedicamento: lote.map(c => c.nome).join(', '),
        horariosJaColetados: [],
        historicoConversa
    });
    if (classificacao.categoria === 'quantidade_apenas' && classificacao.quantidadeUnica) {
        return gravarComQuantidade(classificacao.quantidadeUnica);
    }

    const motivo = await classificarIndeterminadoCadastro({
        message, etapa: 'cad_lote_confirmar', nomeMedicamento: lote[0]?.nome, historicoConversa
    });
    if (motivo === 'nova_intencao') return { escalarParaRoteador: true };
    if (motivo === 'recusa') {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return renderizarRecusaSemGravacao();
    }
    const prefixo = motivo === 'duvida' ? `${renderizarPrefacioDuvida()}\n\n` : '';
    return `${prefixo}${renderizarRepeticaoPropostaLote(lote)}`;
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
// (campos coletados + fila + etapa informacional). `camposPorta` são
// os campos que a porta extraiu desta mensagem (proposta, nunca
// decisão — tudo passa pelos validadores).
// ------------------------------------------------------------

export async function executarRunner({ schema, user, message, state, context, historicoConversa = [], camposPorta = null }) {
    let campos = { ...(context || {}) };
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

    // Confirmação de lote pendente (MH-96).
    if (etapaEntrada === 'cad_lote_confirmar' && Array.isArray(campos?.lote) && campos.lote.length > 0) {
        return await tratarConfirmacaoLote({ schema, user, message, campos, historicoConversa });
    }

    const prefixos = [];
    let mensagem = message;

    // MH-83 (M2 §2.4): medicamento DIFERENTE citado no meio de um cadastro é um
    // cadastro NOVO — o anterior (se gravado) fecha pela verdade do banco e
    // NADA dele vaza para o novo.
    const propostos = camposPorta?.medicamentos || [];
    if (campos?.nome && propostos.length > 0 && medicamentoDiferente(propostos, campos.nome)) {
        console.log(`💊 [RUNNER] Novo medicamento sobre cadastro em andamento (${campos.nome} → ${propostos.join(', ')}) — ${user.phone}`);
        if (campos.medication_id) prefixos.push(renderizarFechamentoAnterior(campos.nome));
        campos = { sujeito: campos.sujeito };
    }

    // MH-96 (M2 §3): N candidatos na mesma mensagem — divisão determinística
    // (linhas, " e ", vírgulas) a partir dos nomes propostos pela porta.
    if (!campos?.nome && !(campos?.fila?.length) && propostos.length > 1) {
        const { candidatos } = dividirCandidatos({
            message: mensagem,
            medicamentosPropostos: propostos,
            horariosPorta: camposPorta?.horarios || []
        });

        if (todosComHorario(candidatos)) {
            // LOTE: todos já têm horário — proposta agregada, UMA confirmação.
            console.log(`💊 [RUNNER] Lote proposto: ${candidatos.length} candidatos com horário — ${user.phone}`);
            await saveConversationState(user.id, {
                state: schema.estadoConversa,
                context: { sujeito: campos.sujeito, lote: candidatos, etapa: 'cad_lote_confirmar' }
            });
            return juntarPartes(prefixos, renderizarPropostaLote(candidatos));
        }

        const [primeiro, ...resto] = candidatos;
        const mesmaLinha = resto.length > 0 && resto.every(c => c.grupo !== null && c.grupo === primeiro.grupo);

        if (mesmaLinha) {
            // Nome composto que a porta já dividiu (A19): proposta de divisão +
            // posologia compartilhada do grupo, numa pergunta só.
            console.log(`💊 [RUNNER] Nome composto dividido: ${candidatos.map(c => c.nome).join(' | ')} — ${user.phone}`);
            const camposGrupo = montarCamposDoCandidato({ sujeito: campos.sujeito, candidato: primeiro, fila: resto });
            await saveConversationState(user.id, {
                state: schema.estadoConversa,
                context: { ...camposGrupo, etapa: 'cad_horarios' }
            });
            return juntarPartes(prefixos, renderizarPropostaDivisaoNome(candidatos.map(c => c.nome)));
        }

        // FILA: começa pelo primeiro sem perder os demais (P57). A mensagem se
        // reduz à LINHA do primeiro (o mecanismo do M1, agora do runner) e o
        // fluxo normal segue a partir dela.
        console.log(`💊 [RUNNER] Fila multi-medicamento: começando por ${primeiro.nome}, ${resto.length} na fila — ${user.phone}`);
        prefixos.push(renderizarAberturaFila(candidatos));
        campos = {
            sujeito: campos.sujeito,
            fila: resto,
            ...(primeiro.horariosCompartilhados && primeiro.horarios.length > 0 ? { horarios: primeiro.horarios } : {})
        };
        mensagem = primeiro.linha || primeiro.nome;
    }

    const resposta = await processarTurno({
        schema, user, mensagem, campos, historicoConversa, firstName
    });
    if (typeof resposta === 'string') return juntarPartes(prefixos, resposta);
    return resposta;
}

// Corpo do turno: pendência → validador → camada 2 → absorção → recorrência →
// duplicata → gravação/fechamento → pergunta seguinte.
async function processarTurno({ schema, user, mensagem, campos, historicoConversa, firstName }) {
    // 1. O QUE FALTA — pendência corrente.
    const pend = proximaPendencia(schema, campos);

    // 2. ABSORVER — validador do campo corrente (camada 1).
    let resultado = { acao: 'estado_pronto', updates: {} };
    let motivoFalha = null;
    if (pend.acao === 'perguntar') {
        resultado = await pend.campo.validador({ message: mensagem, campos, historicoConversa });

        // 4. QUANDO DEVOLVER — contrato universal (camada 2 só na falha da camada 1).
        if (ACOES_DE_FALHA.has(resultado.acao)) {
            const motivo = await classificarIndeterminadoCadastro({
                message: mensagem,
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
        const sugereEstoque = /\btenho\b|\bem casa\b|\bestoque\b|\bcaixa\b|\bfrascos?\b|\bsobra\w*\b|\brestam?\b/i.test(mensagem)
            && !campos?.estoque_perguntado
            && (campos?.estoque_resolvido === undefined || campos?.estoque_resolvido === null);
        const sugereTratamento = /\b(por|durante)\s+(\d+|uma?|duas?)\s+(dias?|semanas?)\b|\buso\s+cont[íi]nuo\b/i.test(mensagem)
            && !campos?.tipo_tratamento;
        if (sugereEstoque || sugereTratamento) {
            try {
                const completo = await extrairCadastroCompleto({ message: mensagem, historicoConversa });
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
    const recorrencia = detectarRecorrenciaNaoSuportada(mensagem);
    const horariosNaMensagem = extrairHorariosCitados(mensagem);

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

    // Nome composto por " e " coletado como um só (A19, caminho sem divisão da
    // porta): propõe a divisão em dois — nunca grava composto em silêncio.
    const nomeRecemColetado = !campos?.nome && !!camposNovos.nome;
    if (nomeRecemColetado && !(camposNovos.fila?.length)) {
        const partesNome = dividirNomeComposto(camposNovos.nome);
        if (partesNome) {
            console.log(`💊 [RUNNER] Nome composto dividido na coleta: ${partesNome.join(' | ')} — ${user.phone}`);
            const candidatos = partesNome.map(n => ({ nome: n, linha: null, grupo: 'composto', horarios: [], dosagem: null, quantidade: null }));
            const camposGrupo = {
                ...camposNovos,
                nome: candidatos[0].nome,
                grupo: 'composto',
                fila: [candidatos[1]]
            };
            await saveConversationState(user.id, {
                state: schema.estadoConversa,
                context: { ...camposGrupo, etapa: 'cad_horarios' }
            });
            return renderizarPropostaDivisaoNome(partesNome);
        }
    }

    // Verificação antecipada de medicamento existente — o gatilho é o FATO "o
    // nome acabou de ser coletado", não a posição na máquina.
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
        // Grupo de posologia compartilhada (nome composto, A19): o corrente e os
        // membros do grupo gravam JUNTOS, com a mesma posologia.
        const membrosDoGrupo = (camposNovos.grupo !== undefined && camposNovos.grupo !== null)
            ? (camposNovos.fila || []).filter(f => f.grupo === camposNovos.grupo)
            : [];
        if (membrosDoGrupo.length > 0) {
            const itens = [
                { nome: camposNovos.nome, dosagem: camposNovos.dosagem ?? null, formaExplicita: camposNovos.forma_explicita ?? null, pares: camposNovos.pares_posologia },
                ...membrosDoGrupo.map(f => ({ nome: f.nome, dosagem: f.dosagem ?? null, formaExplicita: null, pares: camposNovos.pares_posologia }))
            ];
            const resultadoLote = await gravarLote({ itens, user, sujeito: camposNovos.sujeito });
            const filaRestante = (camposNovos.fila || []).filter(f => !membrosDoGrupo.includes(f));
            if (filaRestante.length > 0) {
                return await avancarFila({
                    schema, user, sujeito: camposNovos.sujeito, fila: filaRestante,
                    partesIniciais: [renderizarFechamentoLote({ ...resultadoLote, primeiroMedicamento: false })]
                });
            }
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return renderizarFechamentoLote(resultadoLote);
        }

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

        // Fila pendente (MH-96): o próximo da fila assume — o convite de estoque
        // fica para o fim da fila (agregado).
        if ((camposNovos.fila || []).length > 0) {
            return await avancarFila({
                schema, user, sujeito: camposNovos.sujeito, fila: camposNovos.fila,
                partesIniciais: [`${declarativa}\n\n${resumo}`]
            });
        }

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
        mensagemUsuario: mensagem
    });
}

// ------------------------------------------------------------
// Reentrada pós-escalada: a porta, reclassificando, devolveu o mesmo
// fluxo — está CONCORDANDO que o usuário não saiu dele. Repete a
// pergunta pendente sem reclassificar nada (render determinístico).
// ------------------------------------------------------------

export async function repetirPergunta({ schema, context, userName }) {
    const campos = { ...(context || {}) };
    if (Array.isArray(campos.lote) && campos.lote.length > 0) {
        return renderizarRepeticaoPropostaLote(campos.lote);
    }
    const pend = proximaPendencia(schema, campos);
    if (pend.acao !== 'perguntar') {
        return renderizarPerguntaNome({ userName });
    }
    return montarPerguntaPendente({ pend, campos, userName });
}
