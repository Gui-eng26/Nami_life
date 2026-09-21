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
    encerrarTratamento,
    atualizarMedicamentoCampos,
    atualizarQuantidadePorDose,
    reativarComAtualizacao,
    updateUser
} from './database.js';
import { extrairCampoSimples, ehDosagemPura, ehDosagemReconhecivel, classificarTipoTratamento } from './validadores/camposSimples.js';
import { validarEstoque, calcularAlertaEstoqueCadastro } from './validadores/estoque.js';
import { SCHEMA_PERFIL, renderizarPerfilAtualizado, renderizarPerguntaQualDadoPessoal, renderizarDataInvalida } from './schemas/perfil.js';
import { detectarRecorrenciaNaoSuportada, interpretarRecorrencia, extrairHorariosCitados, rotuloDias } from './validadores/recorrencia.js';
import { hojeBRT } from './dataReferencia.js';
import { derivarUnidades } from './validadores/derivacoes.js';
import { classificarIndeterminadoCadastro } from './validadores/falha.js';
import { extrairCadastroCompleto, mapearExtracaoParaCampos, aplicarExtracaoEmVazios } from './validadores/extratorCompleto.js';
import { derivarFormaFarmaceutica, montarParesPosologia } from './validadores/derivacoes.js';
import { classificarPosologia } from './validadores/posologia.js';
import { dividirCandidatos, dividirNomeComposto, todosComHorario, contemComFronteira } from './validadores/multiMed.js';
import { medicamentoDiferente, nomeCorrigidoParecido, normalizar } from './nlp_helpers.js';
import {
    SCHEMA_ONBOARDING, montarPersistenciaOnboarding,
    classificarIntencaoInicial, classificarNomeOnboarding,
    classificarConsentimentoLgpd, classificarRespostaData,
    gerarApresentacao, ehParaOutraPessoa, ehAfirmativoOnboarding, ehRecusaDeDado,
    detectarConsentimentoDeterministico, absorverDataNascimento, reconheceTelefone,
    sugereCadastroDeMedicamento, renderizarReconhecimentoDump,
    renderizarBoasVindas, renderizarPedidoNome, renderizarPedidoConsentimento,
    renderizarDuvidaLgpd, renderizarReperguntaLgpd, renderizarLgpdRecusada,
    renderizarLgpdRetorno, renderizarPedidoNascimento, renderizarDataInvalidaOnboarding,
    renderizarDuvidaNascimento, renderizarConviteAoPrimeiroCadastro,
    renderizarOutraPessoa, renderizarFechamentoOutraPessoa, renderizarDespedida, renderizarPortaAberta
} from './schemas/onboarding.js';
import { extrairComponenteData, montarDataNascimento } from './dataNascimento.js';
import {
    ACOES_DE_FALHA,
    renderizarPerguntaNome, renderizarPerguntaPosologia, renderizarPerguntaEstoque,
    renderizarPrefacioDuvida, renderizarDeclarativa, renderizarResumoDoMedicamento,
    renderizarFechamentoEstoque, renderizarFechamentoCadastroJaGravado,
    renderizarCancelamentoSemGravacao, renderizarRecusaSemGravacao,
    renderizarDuplicataAtiva, renderizarDuplicataNaGravacao, renderizarBloqueioRecorrencia,
    renderizarAvisoJaExiste, paresCongelados,
    renderizarPropostaLote, renderizarAberturaFila, renderizarPropostaDivisaoNome,
    renderizarTransicaoFila, renderizarFechamentoLote, renderizarRepeticaoPropostaLote,
    renderizarFechamentoAnterior, renderizarConviteEstoqueLote, renderizarDeclarativaCurta,
    renderizarDuplicataCurta, renderizarNotaConvencaoPo,
    renderizarNomeCorrigido, renderizarFechamentoEstoqueLote,
    renderizarPerguntaQualEstoque, renderizarEstoqueLoteFicaPraDepois,
    renderizarPerguntaCorrecao, renderizarCorrecaoAplicada, renderizarOfertaNovaApresentacao,
    SCHEMA_CADASTRO
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

function montarPerguntaPendente({ pend, campos, userName, resultado = null, motivoFalha = null, nomeRecemColetado = false, aberturaFila = false, mensagemUsuario = '' }) {
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
            aberturaFila,
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
            const horarioStr = String(par.horario).trim().substring(0, 5);
            // MH-77: dias por horário (estrutura da recorrência) > dias pendentes
            // da mensagem > default do banco (todos os dias).
            const diasSemana = campos.dias_por_horario?.[horarioStr]
                ?? campos.dias_semana_pendente
                ?? null;
            await saveSchedule({
                medicationId: med.id,
                horario: horarioStr,
                quantidadePorDose: Number(par.quantidade) || 1,
                diasSemana,
                intervaloDias: campos.intervalo_dias_recorrencia ?? null,
                dataInicio: campos.data_inicio_recorrencia ?? null
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
        .map(s => ({
            horario: String(s.horario).substring(0, 5),
            quantidade: Number(s.quantidade_por_dose),
            dias_semana: s.dias_semana ?? null,
            intervalo_dias: s.intervalo_dias ?? null
        }))
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

// ------------------------------------------------------------
// ESTOQUE AGREGADO (Commit 0 do M3 — caso Evandro): o convite "de
// cada um" no fim do lote/fila deixa um estado leve com os pendentes,
// para a resposta ("Marevan 30, Kepra 29" ou número seco) ter destino.
// ------------------------------------------------------------

function pendenciasDeEstoque(gravados) {
    return (gravados || [])
        .filter(g => g.med.estoque_atual === null || g.med.estoque_atual === undefined)
        .map(g => ({ medicationId: g.med.id, nome: g.med.nome }));
}

// Fecha o lote/fila: com pendentes de estoque, o estado guarda a lista para o
// convite agregado; sem pendentes, idle.
async function salvarEstadoPosLote({ schema, user, sujeito, pendentes }) {
    if ((pendentes || []).length > 0) {
        await saveConversationState(user.id, {
            state: schema.estadoConversa,
            context: { sujeito, etapa: 'cad_estoque_lote', estoque_lote: pendentes }
        });
        return;
    }
    await saveConversationState(user.id, { state: 'idle', context: {} });
}

// Registro do estoque de um pendente pelo ponto único + leitura pós-escrita.
async function registrarEstoqueDePendente(pendente, valor) {
    await registrarMovimentoEstoque({
        medicationId: pendente.medicationId,
        tipo: 'cadastro_inicial',
        origem: 'manual',
        valorAbsoluto: valor
    });
    const { med, pares } = await lerMedicamentoGravado(pendente.medicationId);
    const alerta = calcularAlertaEstoqueCadastro({
        pares_posologia: pares,
        unidade_dose: med.unidade_dose,
        unidade_estoque: med.unidade_estoque,
        gotas_por_ml: med.gotas_por_ml,
        tratamento_dias: med.tratamento_dias
    }, med.estoque_atual);
    return { med, alerta };
}

const RE_NAO_SEI_ESTOQUE = /\bn[ãa]o sei\b|\bn[ãa]o fa[çc]o ideia\b|\bdepois (eu )?(vejo|falo|mando|conto)\b/i;

// Resposta ao convite de estoque agregado. Devolve null quando a mensagem
// claramente NÃO é sobre o estoque pendente (o chamador segue o fluxo normal).
async function tratarEstoqueLote({ schema, user, message, campos, historicoConversa, firstName }) {
    const pendentes = campos.estoque_lote;
    const sujeito = campos.sujeito;

    const fecharSemEstoque = async () => {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return renderizarEstoqueLoteFicaPraDepois(firstName);
    };

    if (ehCancelamento(message) || ehNegativoSimples(message) || RE_NAO_SEI_ESTOQUE.test(message)) {
        return await fecharSemEstoque();
    }

    // Correção de grafia de um pendente ("Keppra" sobre "Kepra") — BUG-103 "nome".
    const mensagemSemNumero = !/\d/.test(message);
    if (mensagemSemNumero && campos.estoque_lote_numero_pendente == null) {
        const alvo = pendentes.find(p => nomeCorrigidoParecido(p.nome, message.trim()));
        if (alvo) {
            await atualizarMedicamentoCampos({ medicationId: alvo.medicationId, campos: { nome: message.trim() } });
            const novosPendentes = pendentes.map(p => p === alvo ? { ...p, nome: message.trim() } : p);
            await saveConversationState(user.id, {
                state: schema.estadoConversa,
                context: { ...campos, estoque_lote: novosPendentes }
            });
            console.log(`✏️ [RUNNER] Nome corrigido no convite agregado: ${alvo.nome} → ${message.trim()} — ${user.phone}`);
            return `${renderizarNomeCorrigido(message.trim())}\n\n${renderizarConviteEstoqueLote()}`;
        }
    }

    // Resposta à pergunta "esse N é de qual?": nome seco fecha com o número guardado.
    if (campos.estoque_lote_numero_pendente != null && mensagemSemNumero) {
        const alvo = pendentes.find(p =>
            contemComFronteira(normalizar(message), normalizar(p.nome)) || nomeCorrigidoParecido(p.nome, message.trim()));
        if (alvo) {
            const item = await registrarEstoqueDePendente(alvo, campos.estoque_lote_numero_pendente);
            const restantes = pendentes.filter(p => p !== alvo);
            await salvarEstadoPosLote({ schema, user, sujeito, pendentes: restantes });
            return renderizarFechamentoEstoqueLote({ itens: [item], restantes });
        }
    }

    // Forma nomeada ("Marevan 30, Kepra 29"): atribuição por nome com a MESMA
    // fronteira de palavra da divisão multi-med; grafia corrigida também casa.
    const segmentos = String(message).split(/[,;\n]|\s+e\s+/i).map(s => s.trim()).filter(Boolean);
    const atribuicoes = [];
    for (const pendente of pendentes) {
        const alvoNorm = normalizar(pendente.nome);
        const segmento = segmentos.find(seg => {
            const segNorm = normalizar(seg);
            if (contemComFronteira(segNorm, alvoNorm)) return true;
            const nomeCandidato = seg.replace(/\d+(?:[.,]\d+)?/g, '').replace(/\b(cps?|comprimidos?|c[áa]psulas?|gotas?|unidades?|ml|caixas?)\b/gi, '').trim();
            return nomeCandidato && nomeCorrigidoParecido(pendente.nome, nomeCandidato);
        });
        if (!segmento) continue;
        const mNum = segmento.match(/\d+(?:[.,]\d+)?/);
        if (!mNum) continue;
        atribuicoes.push({ pendente, valor: parseFloat(mNum[0].replace(',', '.')) });
    }

    if (atribuicoes.length > 0) {
        const itens = [];
        for (const { pendente, valor } of atribuicoes) {
            itens.push(await registrarEstoqueDePendente(pendente, valor));
        }
        const atribuidos = new Set(atribuicoes.map(a => a.pendente));
        const restantes = pendentes.filter(p => !atribuidos.has(p));
        await salvarEstadoPosLote({ schema, user, sujeito, pendentes: restantes });
        console.log(`📦 [RUNNER] Estoque agregado: ${atribuicoes.length} atribuição(ões) por nome, ${restantes.length} restante(s) — ${user.phone}`);
        return renderizarFechamentoEstoqueLote({ itens, restantes });
    }

    // Número seco: só resolve sozinho com UM pendente; com mais, pergunta de qual é.
    const numeros = [...String(message).matchAll(/\d+(?:[.,]\d+)?/g)].map(m => parseFloat(m[0].replace(',', '.')));
    if (numeros.length === 1) {
        if (pendentes.length === 1) {
            const item = await registrarEstoqueDePendente(pendentes[0], numeros[0]);
            await salvarEstadoPosLote({ schema, user, sujeito, pendentes: [] });
            return renderizarFechamentoEstoqueLote({ itens: [item], restantes: [] });
        }
        await saveConversationState(user.id, {
            state: schema.estadoConversa,
            context: { ...campos, estoque_lote_numero_pendente: numeros[0] }
        });
        return renderizarPerguntaQualEstoque(pendentes, numeros[0]);
    }

    // Camada 2 — contrato universal.
    const motivo = await classificarIndeterminadoCadastro({
        message, etapa: 'cad_estoque_lote', nomeMedicamento: pendentes.map(p => p.nome).join(', '), historicoConversa
    });
    if (motivo === 'nova_intencao') return { escalarParaRoteador: true };
    if (motivo === 'recusa') return await fecharSemEstoque();
    const prefixo = motivo === 'duvida' ? `${renderizarPrefacioDuvida()}\n\n` : '';
    return `${prefixo}${renderizarConviteEstoqueLote()}`;
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
async function avancarFila({ schema, user, sujeito, fila, partesIniciais, pendentesEstoque = [] }) {
    let resto = [...fila];
    const partes = [...partesIniciais];
    const pendentes = [...pendentesEstoque];

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
                pendentes.push(...pendenciasDeEstoque([{ med }]));
            }
            resto = resto.slice(1);
            continue;
        }

        await saveConversationState(user.id, {
            state: schema.estadoConversa,
            context: { ...camposC, etapa: pendC.etapa, estoque_pendentes: pendentes }
        });
        partes.push(renderizarTransicaoFila({ proximo: candidato }));
        return partes.join('\n\n');
    }

    await salvarEstadoPosLote({ schema, user, sujeito, pendentes });
    if (pendentes.length > 0) partes.push(renderizarConviteEstoqueLote());
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
        await salvarEstadoPosLote({
            schema, user, sujeito: campos.sujeito,
            pendentes: pendenciasDeEstoque(resultado.gravados)
        });
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

    // Resposta ao convite de estoque agregado (Commit 0 do M3). Mensagem que
    // propõe medicamento NOVO (não correção/menção de um pendente) segue o fluxo
    // normal de cadastro — o estoque dos anteriores fica pra depois.
    if (etapaEntrada === 'cad_estoque_lote' && Array.isArray(campos?.estoque_lote) && campos.estoque_lote.length > 0) {
        const pendentesLote = campos.estoque_lote;
        const propostoEhPendente = (m) => pendentesLote.some(p => {
            const a = normalizar(p.nome), b = normalizar(m);
            return a === b || a.includes(b) || b.includes(a) || nomeCorrigidoParecido(p.nome, m);
        });
        const trazMedicamentoNovo = (camposPorta?.medicamentos || []).some(m => !propostoEhPendente(m));

        if (!trazMedicamentoNovo) {
            return await tratarEstoqueLote({ schema, user, message, campos, historicoConversa, firstName });
        }
        console.log(`💊 [RUNNER] Cadastro novo sobre o convite de estoque agregado — pendentes ficam pra depois — ${user.phone}`);
        campos = { sujeito: campos.sujeito };
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
    let emFilaNova = false;

    // Commit 0 do M3 (BUG-103, célula "nome"): nome QUASE igual ao em andamento
    // é correção de grafia ("Keppra" sobre "Kepra"), nunca medicamento novo —
    // renomeia (no banco, se já gravado) e repete a pendência com o nome certo.
    const propostos0 = camposPorta?.medicamentos || [];
    if (campos?.nome && propostos0.length === 1 && nomeCorrigidoParecido(campos.nome, propostos0[0])) {
        const nomeCorrigido = propostos0[0];
        console.log(`✏️ [RUNNER] Correção de grafia na coleta: ${campos.nome} → ${nomeCorrigido} — ${user.phone}`);
        if (campos.medication_id) {
            await atualizarMedicamentoCampos({ medicationId: campos.medication_id, campos: { nome: nomeCorrigido } });
        }
        campos = { ...campos, nome: nomeCorrigido };
        const pendCorrecao = proximaPendencia(schema, campos);
        if (pendCorrecao.acao === 'perguntar') {
            await saveConversationState(user.id, {
                state: schema.estadoConversa,
                context: { ...campos, etapa: pendCorrecao.etapa }
            });
            return juntarPartes(
                renderizarNomeCorrigido(nomeCorrigido),
                montarPerguntaPendente({ pend: pendCorrecao, campos, userName: user.name })
            );
        }
        // Nada mais pendente de pergunta: segue o turno com o nome corrigido.
    }

    // MH-83 (M2 §2.4): medicamento DIFERENTE citado no meio de um cadastro é um
    // cadastro NOVO — o anterior (se gravado) fecha pela verdade do banco e
    // NADA dele vaza para o novo.
    const propostos = camposPorta?.medicamentos || [];
    if (campos?.nome && propostos.length > 0 && medicamentoDiferente(propostos, campos.nome)) {
        console.log(`💊 [RUNNER] Novo medicamento sobre cadastro em andamento (${campos.nome} → ${propostos.join(', ')}) — ${user.phone}`);
        if (campos.medication_id) prefixos.push(renderizarFechamentoAnterior(campos.nome));
        // MH-83: nada do tratamento anterior vaza — mas a FILA de outros
        // tratamentos pendentes não é "do anterior": ela sobrevive ao pivô.
        campos = {
            sujeito: campos.sujeito,
            ...(campos.fila?.length ? { fila: campos.fila } : {})
        };
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
        emFilaNova = true;
    }

    const resposta = await processarTurno({
        schema, user, mensagem, campos, historicoConversa, firstName, emFilaNova
    });
    if (typeof resposta === 'string') return juntarPartes(prefixos, resposta);
    return resposta;
}

// Corpo do turno: pendência → validador → camada 2 → absorção → recorrência →
// duplicata → gravação/fechamento → pergunta seguinte.
async function processarTurno({ schema, user, mensagem, campos, historicoConversa, firstName, emFilaNova = false }) {
    // 1. O QUE FALTA — pendência corrente.
    const pend = proximaPendencia(schema, campos);

    // 2. ABSORVER — validador do campo corrente (camada 1).
    let resultado = { acao: 'estado_pronto', updates: {} };
    let motivoFalha = null;
    if (pend.acao === 'perguntar') {
        resultado = await pend.campo.validador({ message: mensagem, campos, historicoConversa });

        // 4. QUANDO DEVOLVER — contrato universal (camada 2 só na falha da camada 1).
        if (ACOES_DE_FALHA.has(resultado.acao)) {
            // Commit 0 do M3 (caso Evandro/BUG-103): mensagem não-numérica na
            // pergunta de estoque passa pela interpretação ANTES do repergunta —
            // correção de NOME ("Keppra") e de TIPO ("na verdade é por 7 dias")
            // são aplicadas e o fluxo segue, nunca engolidas.
            if (pend.campo.nome === 'estoque' && campos?.medication_id) {
                const candidatoNome = String(mensagem).trim();
                if (!/\d/.test(candidatoNome) && nomeCorrigidoParecido(campos?.nome, candidatoNome)) {
                    console.log(`✏️ [RUNNER] Correção de grafia na etapa de estoque: ${campos.nome} → ${candidatoNome} — ${user.phone}`);
                    await atualizarMedicamentoCampos({ medicationId: campos.medication_id, campos: { nome: candidatoNome } });
                    const camposCorrigidos = { ...campos, nome: candidatoNome };
                    await saveConversationState(user.id, {
                        state: schema.estadoConversa,
                        context: { ...camposCorrigidos, etapa: pend.etapa }
                    });
                    return juntarPartes(
                        renderizarNomeCorrigido(candidatoNome),
                        renderizarPerguntaEstoque(pend.etapa, camposCorrigidos)
                    );
                }
                const mTipo = mensagem.match(/\b(?:por|durante)\s+(\d+)\s+dias?\b/i);
                if (mTipo && !campos?.tipo_tratamento) {
                    const dias = Number(mTipo[1]);
                    console.log(`🔄 [RUNNER] Tratamento corrigido na etapa de estoque: temporário de ${dias} dias — ${user.phone}`);
                    await atualizarMedicamentoCampos({
                        medicationId: campos.medication_id,
                        campos: { tipo_tratamento: 'temporario', tratamento_dias: dias }
                    });
                    const camposComTipo = { ...campos, tipo_tratamento: 'temporario', tratamento_dias: dias };
                    await saveConversationState(user.id, {
                        state: schema.estadoConversa,
                        context: { ...camposComTipo, etapa: pend.etapa }
                    });
                    return juntarPartes(
                        `Anotei: tratamento por ${dias} dias. 🌿`,
                        renderizarPerguntaEstoque(pend.etapa, camposComTipo)
                    );
                }
            }

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

    // Validador de recorrência (v44 §5.7 → M2 MH-77): padrão de dia-da-semana/
    // frequência agora PREENCHE quando representável (dias da semana, dia sim/
    // dia não, 1x por semana com dia); fora disso, continua BLOQUEANDO —
    // gravação errada em silêncio é proibida (regra 7).
    const mensagemTrouxeHorarios =
        (Array.isArray(resultado.updates?.horarios) && resultado.updates.horarios.length > 0) ||
        (Array.isArray(resultado.updates?.pares_posologia) && resultado.updates.pares_posologia.length > 0);
    const recorrencia = detectarRecorrenciaNaoSuportada(mensagem);
    const horariosNaMensagem = extrairHorariosCitados(mensagem);

    if (recorrencia.detectado) {
        const estrutura = interpretarRecorrencia(mensagem);

        if (estrutura?.suportada) {
            // PREENCHER (MH-77): estrutura por horário vira dado do tratamento.
            if (estrutura.diasPorHorario) {
                camposNovos.dias_por_horario = { ...(camposNovos.dias_por_horario || {}), ...estrutura.diasPorHorario };
                // Horários que só a estrutura viu entram como coletados — nunca se perdem.
                if (!(camposNovos.pares_posologia?.length)) {
                    camposNovos.horarios = [...new Set([...(camposNovos.horarios || []), ...Object.keys(estrutura.diasPorHorario)])];
                }
            }
            if (estrutura.diasSemHorario) {
                camposNovos.dias_semana_pendente = estrutura.diasSemHorario;
            }
            if (estrutura.intervaloDias) {
                camposNovos.intervalo_dias_recorrencia = estrutura.intervaloDias;
                camposNovos.data_inicio_recorrencia = hojeBRT();
            }
            // Consolida: quantidade adiantada + horários agora conhecidos = pares.
            if (!(camposNovos.pares_posologia?.length) && (camposNovos.horarios || []).length > 0
                && camposNovos.quantidade_pendente != null) {
                const unidades = derivarUnidades(camposNovos.unidade_dose_pendente || 'unidade');
                camposNovos.pares_posologia = montarParesPosologia(camposNovos.horarios, camposNovos.quantidade_pendente);
                camposNovos.unidade_dose = unidades.unidade_dose;
                camposNovos.unidade_estoque = unidades.unidade_estoque;
                camposNovos.gotas_por_ml = unidades.gotas_por_ml;
                camposNovos.forma_explicita = camposNovos.forma_explicita || camposNovos.forma_explicita_pendente || null;
                camposNovos.quantidade_pendente = null;
                camposNovos.unidade_dose_pendente = null;
                camposNovos.forma_explicita_pendente = null;
            }
            // A recorrência reconhecida não é falha da camada 1.
            motivoFalha = null;
            console.log(`🗓️ [VALIDADOR] Recorrência PREENCHIDA (${estrutura.padroes.join(', ')}) — dias por horário: ${JSON.stringify(estrutura.diasPorHorario)} intervalo: ${estrutura.intervaloDias ?? '—'} — ${user.phone}`);
        } else if (mensagemTrouxeHorarios || horariosNaMensagem.length > 0 || (estrutura && !estrutura.suportada)) {
            // BLOQUEIO honesto: padrão fora do representável (ciclos por semanas,
            // semanal sem dia). Horários desta mensagem bloqueados; resto preservado.
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
            return renderizarBloqueioRecorrencia(horariosNaMensagem, recorrencia.padroes);
        }
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

            // P3 porta 2 (M3): cadastrar medicamento PAUSADO ou ENCERRADO → a
            // Nami avisa, mostra a foto congelada e oferece reativar/recadastrar
            // (mata o BUG-61 — nunca registro duplicado silencioso).
            const statusExistente = existente.status
                || (!existente.ativo ? 'encerrado' : (todosInativos ? 'pausado' : 'ativo'));
            if (statusExistente === 'pausado' || statusExistente === 'encerrado') {
                const medCompleto = await getMedicationComSchedulesAtivos(existente.id);
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: {
                        etapa: 'reativ_oferta',
                        medicationId: existente.id,
                        medicationNome: medCompleto.nome,
                        statusAnterior: statusExistente
                    }
                });
                console.log(`💊 [RUNNER→P3] Porta 2: cadastro de medicamento ${statusExistente} (${medCompleto.nome}) — oferta reativar/recadastrar — ${user.phone}`);
                return renderizarAvisoJaExiste({
                    med: medCompleto,
                    pares: paresCongelados(medCompleto),
                    statusAnterior: statusExistente
                });
            }

            // Achado do replay 19/09 (Priscila/Vitamina D): mensagem sobre um
            // medicamento JÁ ATIVO que traz horário/quantidade é pedido de
            // ALTERAÇÃO — vai para a configuração com o contexto do registro,
            // nunca para o beco "se quiser atualizar, é só me dizer" (regra 3).
            const trazAjuste = extrairHorariosCitados(mensagem).length > 0
                || /\b\d+\s*(cps?|comprimidos?|c[áa]psulas?|gotas?|ml|unidades?)\b/i.test(mensagem);
            if (trazAjuste) {
                console.log(`⚙️ [RUNNER] Medicamento ativo + ajuste na mensagem — despachando para configuração (${existente.nome}) — ${user.phone}`);
                return {
                    configurarExistente: {
                        medicationId: existente.id,
                        medicationNome: existente.nome,
                        schedulesAtivos
                    }
                };
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
            const pendentesGrupo = [
                ...(camposNovos.estoque_pendentes || []),
                ...pendenciasDeEstoque(resultadoLote.gravados)
            ];
            const filaRestante = (camposNovos.fila || []).filter(f => !membrosDoGrupo.includes(f));
            if (filaRestante.length > 0) {
                return await avancarFila({
                    schema, user, sujeito: camposNovos.sujeito, fila: filaRestante,
                    partesIniciais: [renderizarFechamentoLote({ ...resultadoLote, primeiroMedicamento: false })],
                    pendentesEstoque: pendentesGrupo
                });
            }
            await salvarEstadoPosLote({ schema, user, sujeito: camposNovos.sujeito, pendentes: pendentesGrupo });
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
        // Convenção de pó (regra 7): gramas viraram "1 unidade" — a resposta
        // declara a conversão, nunca em silêncio.
        const notaPo = camposNovos.convencao_po_gramas
            ? renderizarNotaConvencaoPo(camposNovos.convencao_po_gramas)
            : null;
        const resumo = juntarPartes(renderizarResumoDoMedicamento(medGravado, pares), notaPo);

        // Fila pendente (MH-96): o próximo da fila assume — o convite de estoque
        // fica para o fim da fila (agregado), acumulando os pendentes desta e das
        // gravações anteriores da mesma fila.
        if ((camposNovos.fila || []).length > 0) {
            return await avancarFila({
                schema, user, sujeito: camposNovos.sujeito, fila: camposNovos.fila,
                partesIniciais: [`${declarativa}\n\n${resumo}`],
                pendentesEstoque: [
                    ...(camposNovos.estoque_pendentes || []),
                    ...pendenciasDeEstoque([{ med: medGravado }])
                ]
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
        aberturaFila: emFilaNova,
        mensagemUsuario: mensagem
    });
}

// ============================================================
// MODO CORREÇÃO (v44 M3 P2): edição de um tratamento JÁ GRAVADO é o
// schema do cadastro em modo corrigir(campo) — cada campo usa o
// validador que já existe; a escrita é por ponto único; a confirmação
// é template pós-escrita declarando ANTES → DEPOIS (regra 2).
// Campos: nome, dosagem, quantidade por dose, horários (com
// recorrência do M2), duração (recalcula tratamento_fim — MH-43
// parcial) e estoque.
// ============================================================

const FORMAS_LIQUIDAS = new Set(['gotas', 'colirio', 'xarope', 'ml']);
const FORMAS_SOLIDAS = new Set(['comprimido', 'capsula']);

function detectarFormaMencionada(message) {
    const t = normalizar(message);
    if (/\bgotas?\b|\bcolirio\b/.test(t)) return 'gotas';
    if (/\bxarope\b|\bml\b|\bliquido\b/.test(t)) return 'xarope';
    if (/\bcomprimidos?\b|\bcps?\b/.test(t)) return 'comprimido';
    if (/\bcapsulas?\b/.test(t)) return 'capsula';
    return null;
}

// MH-79: a edição indica PRODUTO DISTINTO quando a forma mencionada muda de
// família (sólido ↔ líquido) em relação ao registro.
function apresentacaoDistinta(formaMencionada, formaAtual) {
    if (!formaMencionada || !formaAtual) return false;
    const mencionadaLiquida = FORMAS_LIQUIDAS.has(formaMencionada);
    const atualLiquida = FORMAS_LIQUIDAS.has(formaAtual);
    const mencionadaSolida = FORMAS_SOLIDAS.has(formaMencionada);
    const atualSolida = FORMAS_SOLIDAS.has(formaAtual);
    return (mencionadaLiquida && atualSolida) || (mencionadaSolida && atualLiquida);
}

function formatarDataBRDeISO(iso) {
    if (!iso) return null;
    const [ano, mes, dia] = String(iso).split('-');
    return `${dia}/${mes}/${ano}`;
}

async function aplicarCorrecao({ user, medicationId, campoAlvo, medicationNome, antes, depois }) {
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return renderizarCorrecaoAplicada({ campoAlvo, medicationNome, antes, depois });
}

async function perguntarValorDaCorrecao({ user, campoAlvo, med }) {
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'corrigir_campo', campoAlvo, medicationId: med.id, medicationNome: med.nome }
    });
    return renderizarPerguntaCorrecao({ campoAlvo, medicationNome: med.nome });
}

// Modo corrigir(campo): valida a mensagem com o validador do campo; resolvida,
// escreve por ponto único e declara ANTES → DEPOIS pós-escrita; sem o valor,
// pergunta (uma vez) com o template do schema; na segunda falha, devolve ao
// roteador (contrato universal).
export async function executarCorrecao({ user, message, campoAlvo, medicationId, historicoConversa = [], jaPerguntou = false }) {
    const med = await getMedicationComSchedulesAtivos(medicationId);
    if (!med) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return { escalarParaRoteador: true };
    }
    const naoResolveu = async () => {
        if (jaPerguntou) return { escalarParaRoteador: true };
        return await perguntarValorDaCorrecao({ user, campoAlvo, med });
    };

    if (campoAlvo === 'nome') {
        const aplicarNome = async (novoNome) => {
            await atualizarMedicamentoCampos({ medicationId, campos: { nome: novoNome } });
            const { med: depois } = await lerMedicamentoGravado(medicationId);
            console.log(`✏️ [CORRECAO] Nome: ${med.nome} → ${depois.nome} — ${user.phone}`);
            return await aplicarCorrecao({ user, medicationId, campoAlvo, medicationNome: med.nome, antes: med.nome, depois: depois.nome });
        };

        // Replay 20/09: "corrige o nome da Vitamina b12 pra Vitamina B32" — o
        // "pra Y" é determinístico e resolve na hora, nunca é reperguntado.
        const mPara = String(message).match(/\b(?:para|pra)\s+["'*]?([a-zà-ú0-9][^,.!?"'*]*)/i);
        const candidatoPara = mPara ? mPara[1].trim() : null;
        if (candidatoPara && /[a-zà-ú]/i.test(candidatoPara)
            && !ehDosagemPura(candidatoPara)
            && normalizar(candidatoPara) !== normalizar(med.nome)) {
            return await aplicarNome(candidatoPara);
        }

        const c = await extrairCampoSimples({ campo: 'nome', message, historicoConversa });
        if (c.categoria === 'valor' && !ehDosagemPura(c.valor) && normalizar(c.valor) !== normalizar(med.nome)) {
            return await aplicarNome(c.valor);
        }
        return await naoResolveu();
    }

    if (campoAlvo === 'dosagem') {
        // MH-79: forma de outra família = apresentação nova → oferta de cadastro
        // próprio com nome qualificado, nunca sobrescrita silenciosa.
        const formaMencionada = detectarFormaMencionada(message);
        if (apresentacaoDistinta(formaMencionada, med.forma_farmaceutica)) {
            const nomeQualificado = `${med.nome} (${formaMencionada})`;
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'corrigir_mh79_confirmar', medicationId, medicationNome: med.nome, nomeQualificado }
            });
            console.log(`🔀 [CORRECAO] MH-79: apresentação distinta (${med.forma_farmaceutica} → ${formaMencionada}) — oferta de novo tratamento — ${user.phone}`);
            return renderizarOfertaNovaApresentacao({ medicationNome: med.nome, nomeQualificado });
        }

        const c = await extrairCampoSimples({ campo: 'dosagem', message, historicoConversa });
        if (c.categoria === 'valor' && ehDosagemReconhecivel(c.valor)) {
            await atualizarMedicamentoCampos({ medicationId, campos: { dosagem: c.valor } });
            const { med: depois } = await lerMedicamentoGravado(medicationId);
            return await aplicarCorrecao({ user, medicationId, campoAlvo, medicationNome: med.nome, antes: med.dosagem || 'não informada', depois: depois.dosagem });
        }
        return await naoResolveu();
    }

    if (campoAlvo === 'quantidade') {
        const horariosAtivos = med.schedulesAtivos.map(s => String(s.horario).slice(0, 5));
        const cls = await classificarPosologia({
            message, campoEsperado: 'quantidade', nomeMedicamento: med.nome,
            horariosJaColetados: horariosAtivos, historicoConversa, emCorrecao: true,
            unidadeDoseContexto: med.unidade_dose
        });
        const paresNovos = (cls.pares || []).length > 0 ? cls.pares : null;
        const quantidadeUnica = cls.quantidadeUnica ?? null;
        if (paresNovos || quantidadeUnica) {
            const alterados = await atualizarQuantidadePorDose(medicationId, { pares: paresNovos, quantidadeUnica });
            if (alterados.length === 0) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `A quantidade do *${med.nome}* já estava assim — nada precisou mudar. 🌿`;
            }
            const { med: medDepois, pares } = await lerMedicamentoGravado(medicationId);
            const rotuloUnidade = medDepois.unidade_dose === 'unidade' ? '' : ` ${medDepois.unidade_dose}`;
            const depoisTexto = pares.map(p => `${p.horario} — ${p.quantidade}${rotuloUnidade}`).join(', ');
            const antesTexto = alterados.map(a => `${a.de}`).join('/');
            return await aplicarCorrecao({ user, medicationId, campoAlvo, medicationNome: med.nome, antes: antesTexto, depois: depoisTexto });
        }
        return await naoResolveu();
    }

    if (campoAlvo === 'horarios') {
        const estrutura = interpretarRecorrencia(message);
        if (estrutura && !estrutura.suportada) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return renderizarBloqueioRecorrencia(extrairHorariosCitados(message), estrutura.padroes);
        }
        const horariosNovos = estrutura?.diasPorHorario
            ? Object.keys(estrutura.diasPorHorario)
            : extrairHorariosCitados(message);
        if (horariosNovos.length > 0) {
            const antesTexto = med.schedulesAtivos
                .map(s => `${String(s.horario).slice(0, 5)}${rotuloDias(s.dias_semana) ? ` (${rotuloDias(s.dias_semana)})` : ''}`)
                .sort().join(', ');
            // MH-41 dentro do ponto único: pendentes dos horários que saem morrem juntos.
            await reativarComAtualizacao({
                medicationId, horarios: horariosNovos, apenasHorarios: true,
                diasPorHorario: estrutura?.diasPorHorario ?? null
            });
            const { med: medDepois, pares } = await lerMedicamentoGravado(medicationId);
            const depoisTexto = pares
                .map(p => `${p.horario}${rotuloDias(p.dias_semana) ? ` (${rotuloDias(p.dias_semana)})` : ''}`)
                .join(', ');
            return await aplicarCorrecao({ user, medicationId, campoAlvo, medicationNome: medDepois.nome, antes: antesTexto, depois: depoisTexto });
        }
        return await naoResolveu();
    }

    if (campoAlvo === 'duracao') {
        const t = await classificarTipoTratamento({ message, nomeMedicamento: med.nome, aguardandoDias: false, historicoConversa });
        const antesTexto = med.tipo_tratamento === 'temporario' ? `${med.tratamento_dias} dias` : 'contínuo';
        if (t.categoria === 'continuo') {
            await atualizarMedicamentoCampos({ medicationId, campos: { tipo_tratamento: 'continuo', tratamento_dias: null } });
            return await aplicarCorrecao({ user, medicationId, campoAlvo, medicationNome: med.nome, antes: antesTexto, depois: 'uso contínuo' });
        }
        if (t.categoria === 'dias' && t.dias) {
            // Encurtar/prolongar recalcula tratamento_fim (MH-43 parcial: prorrogação).
            await atualizarMedicamentoCampos({ medicationId, campos: { tipo_tratamento: 'temporario', tratamento_dias: t.dias } });
            const { med: medDepois } = await lerMedicamentoGravado(medicationId);
            const fimBR = formatarDataBRDeISO(medDepois.tratamento_fim);
            return await aplicarCorrecao({
                user, medicationId, campoAlvo, medicationNome: med.nome,
                antes: antesTexto, depois: `${t.dias} dias${fimBR ? ` (até ${fimBR})` : ''}`
            });
        }
        return await naoResolveu();
    }

    if (campoAlvo === 'estoque') {
        const v = await validarEstoque({
            message,
            campos: { nome: med.nome, unidade_estoque: med.unidade_estoque, medication_id: medicationId },
            historicoConversa
        });
        if (v.resolvido !== undefined && v.resolvido !== null) {
            if (v.resolvido.valor === null) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem! O estoque do *${med.nome}* fica como está — quando souber, é só me mandar a quantidade. 🌿`;
            }
            await registrarMovimentoEstoque({
                medicationId, tipo: 'correcao_set', origem: 'manual',
                motivo: v.resolvido.motivo, estimado: v.resolvido.estimado,
                valorAbsoluto: v.resolvido.valor
            });
            const { med: medDepois } = await lerMedicamentoGravado(medicationId);
            const unidadeLabel = medDepois.unidade_estoque === 'ml' ? 'ml' : 'unidades';
            return await aplicarCorrecao({
                user, medicationId, campoAlvo, medicationNome: med.nome,
                antes: med.estoque_atual !== null ? `${med.estoque_atual} ${unidadeLabel}` : 'não informado',
                depois: `${medDepois.estoque_atual} ${unidadeLabel}`
            });
        }
        return await naoResolveu();
    }

    return { escalarParaRoteador: true };
}

// Cadastro novo a partir da oferta MH-79 (nome qualificado já decidido):
// entra direto na pendência de posologia, pelo caminho normal do runner.
export async function iniciarCadastroComNome({ user, nome }) {
    const campos = { sujeito: 'usuario', nome };
    const pend = proximaPendencia(SCHEMA_CADASTRO, campos);
    await saveConversationState(user.id, {
        state: SCHEMA_CADASTRO.estadoConversa,
        context: { ...campos, etapa: pend.etapa }
    });
    return montarPerguntaPendente({ pend, campos, userName: user.name, nomeRecemColetado: true });
}

// ============================================================
// CORREÇÃO DE DADOS PESSOAIS (MH-75) — SCHEMA_PERFIL no mesmo runner.
// ============================================================

export async function executarCorrecaoPerfil({ user, message, campoAlvo = null, historicoConversa = [], jaPerguntou = false }) {
    const campos = SCHEMA_PERFIL.campos;

    // Sem alvo declarado: a própria mensagem decide — data reconhecível vence;
    // menção a nome com valor plausível também resolve; senão, pergunta qual.
    let campo = campoAlvo ? campos.find(c => c.nome === campoAlvo) : null;
    if (!campo) {
        const campoData = campos.find(c => c.nome === 'data_nascimento');
        const rData = campoData.validador({ message });
        if (rData.acao === 'valor' || rData.acao === 'data_invalida') {
            campo = campoData;
        } else if (/\bnome\b|\bme chamo\b|\bchamar\b/i.test(message)) {
            campo = campos.find(c => c.nome === 'nome_usuario');
        } else if (/\bnascimento\b|\bdata\b|\bidade\b/i.test(message)) {
            campo = campoData;
        }
    }
    if (!campo) {
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { etapa: 'corrigir_perfil', campoAlvo: null }
        });
        return renderizarPerguntaQualDadoPessoal();
    }

    // valorLivre só quando a Nami ACABOU de perguntar este campo (campoAlvo
    // veio do contexto) — replay 20/09: sem isso, "Corrigir meu nome" virava o
    // próprio nome.
    const resultado = campo.validador({ message, valorLivre: !!campoAlvo });

    if (resultado.acao === 'valor') {
        if (campo.nome === 'nome_usuario') {
            const novoNome = resultado.updates.nome_usuario;
            // O valor extraído não pode ser só o pedido — exige diferença real
            // do nome atual.
            if (normalizar(novoNome) === normalizar(user.name || '')) {
                return await perguntarValorPerfil({ user, campo, jaPerguntou });
            }
            await updateUser(user.id, { name: novoNome });
            await saveConversationState(user.id, { state: 'idle', context: {} });
            console.log(`✏️ [CORRECAO-PERFIL] Nome: ${user.name} → ${novoNome} — ${user.phone}`);
            return renderizarPerfilAtualizado({ campo: 'nome_usuario', antes: user.name, depois: novoNome });
        }
        const novaData = resultado.updates.data_nascimento;
        await updateUser(user.id, { data_nascimento: novaData });
        await saveConversationState(user.id, { state: 'idle', context: {} });
        console.log(`✏️ [CORRECAO-PERFIL] Data de nascimento atualizada — ${user.phone}`);
        return renderizarPerfilAtualizado({
            campo: 'data_nascimento',
            antes: formatarDataBRDeISO(user.data_nascimento),
            depois: formatarDataBRDeISO(novaData)
        });
    }

    if (resultado.acao === 'data_invalida') {
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { etapa: 'corrigir_perfil', campoAlvo: campo.nome }
        });
        return renderizarDataInvalida();
    }

    return await perguntarValorPerfil({ user, campo, jaPerguntou });
}

async function perguntarValorPerfil({ user, campo, jaPerguntou }) {
    if (jaPerguntou) return { escalarParaRoteador: true };
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'corrigir_perfil', campoAlvo: campo.nome }
    });
    return campo.pergunta();
}

// ============================================================
// ONBOARDING NO RUNNER (v44 M4): nome → LGPD (portão) → nascimento
// (opcional). A pendência vem da MESMA função única
// (proximaPendencia) sobre SCHEMA_ONBOARDING; as decisões são
// determinísticas (listas + classificadores tool-use); o texto de
// coleta é renderizado em código (schemas/onboarding.js).
//
// PORTÃO LGPD (§2): nenhum dado pessoal declarado é persistido antes
// do aceite identificado — tudo vive no rascunho (estado de
// conversa). O ponto único de escrita é montarPersistenciaOnboarding,
// que LANÇA sem consentimento (guarda determinística no A0).
// ============================================================

const MAX_TENTATIVAS_NOME_ONB = 3;
const MAX_TENTATIVAS_LGPD_ONB = 3;
const MAX_TENTATIVAS_NASCIMENTO_ONB = 2;
const MAX_TENTATIVAS_APRESENTACAO_ONB = 3;

// §3: pedido de cadastro chegando ANTES do onboarding (ou no meio) — o
// extrator completo roda sobre a mensagem e os campos vão ao RASCUNHO
// (nunca ao banco — §2.1). Um tratamento por vez no rascunho; a mensagem
// rica preservada cobre o restante no despacho final. Devolve o nome do
// medicamento quando ele acabou de entrar no rascunho (para reconhecimento
// na resposta — regra 3), senão null.
async function absorverPedidoDeCadastro({ campos, message, historicoConversa }) {
    if (!sugereCadastroDeMedicamento(message)) return null;
    try {
        const completo = await extrairCadastroCompleto({ message, historicoConversa });
        if (!completo?.nome) return null;
        if (campos.nome_coletado && normalizar(completo.nome) === normalizar(campos.nome_coletado)) return null;
        const rascunho = campos.rascunho_cadastro || {};
        if (rascunho.nome && normalizar(rascunho.nome) !== normalizar(completo.nome)) return null;
        const eraNovo = !rascunho.nome;
        const mapeados = mapearExtracaoParaCampos(completo);
        campos.rascunho_cadastro = { ...rascunho, ...aplicarExtracaoEmVazios(rascunho, mapeados) };
        if (!campos.mensagem_rica_cadastro) campos.mensagem_rica_cadastro = message;
        console.log(`💊 [ONBOARDING] Pedido de cadastro absorvido no rascunho (${completo.nome}) — nada no banco antes do aceite`);
        return eraNovo ? campos.rascunho_cadastro.nome : null;
    } catch (e) {
        console.error('⚠️ [ONBOARDING] Absorção do pedido de cadastro falhou (fluxo segue sem ela):', e.message);
        return null;
    }
}

export async function executarOnboarding({ user, message, state, historicoConversa = [] }) {
    let campos = { ...(state?.context || {}) };

    // Estados legados (pré-M4): a recusa de LGPD é preservada; qualquer outro
    // estado antigo de onboarding reinicia o fluxo do zero.
    if (!campos.etapa && state?.state === 'lgpd_recusado') campos.etapa = 'onb_lgpd_recusado';
    if (campos.etapa && !String(campos.etapa).startsWith('onb_')) {
        campos = { mensagem_inicial: campos.mensagem_inicial || null };
    }
    if (!campos.mensagem_inicial) campos.mensagem_inicial = message;

    const etapa = campos.etapa || null;
    const salvar = async (proximaEtapa) => {
        campos.etapa = proximaEtapa;
        await saveConversationState(user.id, { state: SCHEMA_ONBOARDING.estadoConversa, context: campos });
    };
    const encerrarComoRecusaLgpd = async () => {
        // Comportamento atual preservado (§2.4): nada persistido; o rascunho de
        // dados pessoais morre com a recusa (decisão do BUG-89 mantida).
        campos = { etapa: 'onb_lgpd_recusado', mensagem_inicial: campos.mensagem_inicial };
        await saveConversationState(user.id, { state: SCHEMA_ONBOARDING.estadoConversa, context: campos });
        console.log(`🔒 [ONBOARDING] LGPD recusada — ${user.phone}`);
        return renderizarLgpdRecusada();
    };

    console.log(`👋 Runner (onboarding) — etapa de entrada: ${etapa || 'primeira mensagem'} — ${user.phone}`);

    // ---- ABSORÇÃO EM TODA MENSAGEM (§2.1/§2.2/§3): tudo que a pessoa disser
    // antes do aceite vive no RASCUNHO (estado de conversa) — data de
    // nascimento e pedido de cadastro nunca se perdem, nada vai ao banco.
    const dataAbsorvida = absorverDataNascimento(campos, message);
    const telefoneReconhecido = reconheceTelefone(message);
    const medAbsorvido = await absorverPedidoDeCadastro({ campos, message, historicoConversa });

    // ---- PRIMEIRA MENSAGEM: duas portas da v43 (folheto/descobrir — §5) ----
    if (!etapa) {
        const intencao = await classificarIntencaoInicial({ message });
        campos.intencao_inicial = intencao;
        if (intencao === 'descobrir') {
            campos.rodadas_duvida = 0;
            campos.tentativas_ruido = 0;
            await salvar('onb_apresentacao');
            return await gerarApresentacao({ message, historicoConversa, mensagemInicial: campos.mensagem_inicial, motivo: 'primeira' });
        }
        campos.tentativas_nome = 0;
        await salvar('onb_nome');
        return renderizarBoasVindas({ intencao, medReconhecido: campos.rascunho_cadastro?.nome || null });
    }

    // ---- APRESENTAÇÃO ("descobrir") e retorno pós-declínio ----
    if (etapa === 'onb_apresentacao' || etapa === 'onb_declinado') {
        if (ehParaOutraPessoa(message)) {
            campos.outra_pessoa_explicado = true;
            campos.tentativas_nome = 0;
            await salvar('onb_nome');
            return renderizarOutraPessoa();
        }
        if (ehAfirmativoOnboarding(message)) {
            campos.tentativas_nome = 0;
            await salvar('onb_nome');
            return renderizarPedidoNome({ motivo: 'pos_convite' });
        }
        const cls = await classificarNomeOnboarding({ message, historicoConversa });
        if (cls.tipo === 'nome') {
            campos.nome_coletado = cls.valor; // segue para a pendência (LGPD) abaixo
        } else if (cls.tipo === 'contexto_saude') {
            campos.tentativas_nome = 0;
            await salvar('onb_nome');
            return renderizarPedidoNome({ motivo: 'contexto_saude', medNoRascunho: campos.rascunho_cadastro?.nome || null });
        } else if (cls.tipo === 'pergunta') {
            // Servir a curiosidade é o propósito da etapa — não consome tentativa.
            campos.rodadas_duvida = (campos.rodadas_duvida || 0) + 1;
            await salvar('onb_apresentacao');
            return await gerarApresentacao({ message, historicoConversa, mensagemInicial: campos.mensagem_inicial, motivo: 'nova_duvida', rodadasDuvida: campos.rodadas_duvida });
        } else if (cls.tipo === 'recusa') {
            const despedida = etapa === 'onb_declinado' ? renderizarPortaAberta() : renderizarDespedida({ motivo: 'declinado' });
            await salvar('onb_declinado');
            return despedida;
        } else if (etapa === 'onb_declinado') {
            // saudação/indeterminado no retorno: acolhe sem cobrar.
            await salvar('onb_declinado');
            return renderizarPortaAberta();
        } else if (cls.tipo === 'saudacao') {
            await salvar('onb_apresentacao');
            return renderizarPedidoNome({ motivo: 'saudacao' });
        } else {
            // ruído — único ramo que consome tentativa.
            const tentativas = (campos.tentativas_ruido || 0) + 1;
            if (tentativas >= MAX_TENTATIVAS_APRESENTACAO_ONB) {
                await salvar('onb_declinado');
                return renderizarDespedida({ motivo: 'limite_tentativas' });
            }
            campos.tentativas_ruido = tentativas;
            await salvar('onb_apresentacao');
            return renderizarPedidoNome({ motivo: 'indeterminado' });
        }
    }

    // ---- NOME ----
    if (etapa === 'onb_nome' && !campos.nome_coletado) {
        if (ehParaOutraPessoa(message)) {
            campos.outra_pessoa_explicado = true;
            await salvar('onb_nome');
            return renderizarOutraPessoa();
        }
        const cls = await classificarNomeOnboarding({ message, historicoConversa });
        if (cls.tipo === 'nome') {
            campos.nome_coletado = cls.valor; // segue para a pendência abaixo
        } else if (campos.outra_pessoa_explicado
            && (cls.tipo === 'recusa' || (cls.tipo !== 'pergunta' && /\bn[ãa]o (vou|uso|preciso|quero)\b|\bobrigad[oa]\b/i.test(message)))) {
            // Veio cuidar de alguém e está encerrando: fechamento curto e caloroso,
            // sem reexplicar o turno anterior (regra 6 do guia — validação do A18).
            await salvar('onb_declinado');
            return renderizarFechamentoOutraPessoa();
        } else if (cls.tipo === 'contexto_saude') {
            await salvar('onb_nome');
            return renderizarPedidoNome({ motivo: 'contexto_saude', medNoRascunho: campos.rascunho_cadastro?.nome || null });
        } else if (cls.tipo === 'pergunta') {
            await salvar('onb_nome');
            return await gerarApresentacao({ message, historicoConversa, mensagemInicial: campos.mensagem_inicial, motivo: 'pergunta_no_nome' });
        } else {
            // saudacao | recusa | indeterminado — contam para o teto (MH-072 B).
            const tentativas = (campos.tentativas_nome || 0) + 1;
            if (tentativas >= MAX_TENTATIVAS_NOME_ONB) {
                await salvar('onb_declinado');
                return renderizarDespedida({ motivo: 'limite_tentativas' });
            }
            campos.tentativas_nome = tentativas;
            await salvar('onb_nome');
            return renderizarPedidoNome({ motivo: cls.tipo });
        }
    }

    // ---- LGPD (portão §2): decisão determinística, conversa fluida ----
    if ((etapa === 'onb_lgpd' || etapa === 'onb_lgpd_reapresentacao') && campos.consentimento_lgpd !== true) {
        // Lista determinística primeiro (§2.3); o aceite vale também no MEIO de
        // um dump ("nome + telefone + data + sim").
        let categoria = detectarConsentimentoDeterministico(message);

        // Dump SEM aceite (§2.2): mostra que entendeu (listagem curta) e repede
        // SÓ o consentimento — na dúvida, repede, nunca assume.
        if (!categoria && (dataAbsorvida?.dataBR || telefoneReconhecido || medAbsorvido)) {
            await salvar(etapa);
            return renderizarReconhecimentoDump({
                nomeColetado: campos.nome_coletado,
                dataBR: dataAbsorvida?.dataBR || null,
                telefone: telefoneReconhecido,
                medNome: medAbsorvido
            });
        }

        // Classificador tool-use só para as formas livres (§2.3).
        if (!categoria) categoria = await classificarConsentimentoLgpd({ message, historicoConversa });

        if (categoria === 'aceite') {
            campos.consentimento_lgpd = true;
            campos.lgpd_aceito_em = new Date().toISOString();
            campos.tentativas_lgpd = 0; // segue para persistência/pendência abaixo
        } else if (categoria === 'recusa') {
            return await encerrarComoRecusaLgpd();
        } else if (categoria === 'duvida') {
            // Dúvida legítima não consome tentativa (só indeterminado consome).
            await salvar(etapa);
            return renderizarDuvidaLgpd();
        } else {
            const tentativas = (campos.tentativas_lgpd || 0) + 1;
            if (tentativas >= MAX_TENTATIVAS_LGPD_ONB) {
                console.log(`🔒 [ONBOARDING] ${tentativas}ª tentativa indeterminada de LGPD — encerrando como recusa (saída de emergência) — ${user.phone}`);
                return await encerrarComoRecusaLgpd();
            }
            campos.tentativas_lgpd = tentativas;
            await salvar(etapa);
            return renderizarReperguntaLgpd();
        }
    }

    // ---- LGPD RECUSADO: retorno (comportamento atual preservado — §2.4) ----
    if (etapa === 'onb_lgpd_recusado') {
        const categoria = detectarConsentimentoDeterministico(message)
            || await classificarConsentimentoLgpd({ message, historicoConversa });
        if (categoria === 'aceite') {
            await salvar('onb_lgpd_reapresentacao');
            return renderizarPedidoConsentimento({ nomeColetado: campos.nome_coletado || null, reapresentacao: true });
        }
        await salvar('onb_lgpd_recusado');
        return renderizarLgpdRetorno();
    }

    // ---- NASCIMENTO (OPCIONAL — decisão 21/09: nunca trava o usuário) ----
    if (etapa === 'onb_nascimento' && !campos.data_nascimento && !campos.nascimento_encerrado) {
        const componente = /\d/.test(String(message)) ? extrairComponenteData(message, 'dia') : { tipo: 'indeterminado' };
        if (componente.tipo === 'data_completa') {
            const montagem = montarDataNascimento(componente.valor);
            if (montagem.valida) {
                campos.data_nascimento = montagem.iso; // segue para gravação/pendência
            } else {
                const tentativas = (campos.tentativas_nascimento || 0) + 1;
                if (tentativas >= MAX_TENTATIVAS_NASCIMENTO_ONB) {
                    campos.nascimento_encerrado = true;
                } else {
                    campos.tentativas_nascimento = tentativas;
                    await salvar('onb_nascimento');
                    return renderizarDataInvalidaOnboarding();
                }
            }
        } else if (medAbsorvido || (campos.rascunho_cadastro?.nome && sugereCadastroDeMedicamento(message))) {
            // Pedido de cadastro na pergunta OPCIONAL: nunca atrasa a chegada ao
            // cadastro (§1/§3) — fecha sem o dado e segue.
            campos.nascimento_encerrado = true;
        } else if (ehRecusaDeDado(message)) {
            // Recusa/pulo determinístico: a porta de saída da própria pergunta.
            campos.nascimento_encerrado = true;
        } else if (campos.oferta_pular_ativa && ehAfirmativoOnboarding(message)) {
            campos.nascimento_encerrado = true;
        } else {
            const cls = await classificarRespostaData({ message, historicoConversa });
            if (cls === 'recusa') {
                campos.nascimento_encerrado = true;
            } else if (cls === 'duvida') {
                campos.oferta_pular_ativa = true;
                await salvar('onb_nascimento');
                return renderizarDuvidaNascimento();
            } else if (cls === 'saudacao') {
                await salvar('onb_nascimento');
                return renderizarPedidoNascimento({ nomeColetado: campos.nome_coletado, repeticao: true });
            } else if (cls === 'nova_intencao') {
                // Campo opcional nunca segura a pessoa: fecha sem o dado e devolve
                // o turno ao roteador (o usuário já está onboarded neste ponto).
                await saveConversationState(user.id, { state: 'idle', context: {} });
                console.log(`🎂 [ONBOARDING] Nova intenção na pergunta opcional de nascimento — devolvendo ao roteador — ${user.phone}`);
                return { escalarParaRoteador: true };
            } else {
                const tentativas = (campos.tentativas_nascimento || 0) + 1;
                if (tentativas >= MAX_TENTATIVAS_NASCIMENTO_ONB) {
                    campos.nascimento_encerrado = true;
                } else {
                    campos.tentativas_nascimento = tentativas;
                    await salvar('onb_nascimento');
                    return renderizarPedidoNascimento({ nomeColetado: campos.nome_coletado, repeticao: true });
                }
            }
        }
    }

    // ---- PERSISTÊNCIA (ponto único, guarda A0) ----
    // Só no instante em que o aceite identificado E o nome existem — tudo que
    // veio antes viveu no rascunho (estado de conversa), nunca em `users`.
    if (campos.consentimento_lgpd === true && campos.nome_coletado && !campos.persistido) {
        await updateUser(user.id, montarPersistenciaOnboarding(campos));
        campos.persistido = true;
        campos.data_gravada = !!campos.data_nascimento;
        console.log(`🔒 [ONBOARDING] Consentimento identificado — dados do rascunho persistidos — ${user.phone}`);
    }
    // Data coletada DEPOIS da persistência (campo opcional pós-aceite).
    if (campos.persistido && campos.data_nascimento && !campos.data_gravada) {
        await updateUser(user.id, { data_nascimento: campos.data_nascimento });
        campos.data_gravada = true;
        console.log(`🎂 [ONBOARDING] Data de nascimento gravada — ${user.phone}`);
    }

    // ---- PENDÊNCIA (função única) → pergunta seguinte ou fechamento ----
    const pend = proximaPendencia(SCHEMA_ONBOARDING, campos);

    if (pend.acao === 'concluido') {
        return await fecharOnboarding({ user, campos, historicoConversa });
    }

    await salvar(pend.etapa);
    if (pend.campo.nome === 'nome') {
        return renderizarPedidoNome({ motivo: 'pos_lgpd' });
    }
    if (pend.campo.nome === 'consentimento_lgpd') {
        return renderizarPedidoConsentimento({
            nomeColetado: campos.nome_coletado,
            dataJaInformada: !!campos.data_nascimento,
            medNoRascunho: campos.rascunho_cadastro?.nome || null
        });
    }
    return renderizarPedidoNascimento({ nomeColetado: campos.nome_coletado });
}

// Fechamento do onboarding: convite ao primeiro cadastro, com a mensagem
// inicial preservada como mensagem_rica (P57 — a porta interpreta o turno
// seguinte com tudo que a pessoa já disse).
async function fecharOnboarding({ user, campos, historicoConversa }) {
    // mensagem_rica só quando realmente carrega conteúdo de cadastro (P57) —
    // preservar um "oi" fazia o fast-path de aceite sequestrar o turno seguinte.
    await saveConversationState(user.id, {
        state: 'post_onboarding',
        context: { mensagem_rica: campos.mensagem_rica_cadastro || null }
    });
    console.log(`✅ [ONBOARDING] Concluído — ${user.phone}${campos.data_nascimento ? '' : ' (sem data de nascimento)'}`);
    return renderizarConviteAoPrimeiroCadastro({
        nomeColetado: campos.nome_coletado,
        semData: campos.nascimento_encerrado === true
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
    if (Array.isArray(campos.estoque_lote) && campos.estoque_lote.length > 0) {
        return renderizarConviteEstoqueLote();
    }
    const pend = proximaPendencia(schema, campos);
    if (pend.acao !== 'perguntar') {
        return renderizarPerguntaNome({ userName });
    }
    return montarPerguntaPendente({ pend, campos, userName });
}
