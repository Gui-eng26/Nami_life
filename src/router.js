import { getConversationState, logAgentInteraction, saveConversationState,
    getHistoricoRecente, getContextoProativoRecente, getFalaDirecionadaRecente, getUserMedications,
    getEnvioFunilPorProviderId, getDosesDoEnvio, getAssuntoDoEnvio,
    getDosesJanelaPrincipal, getUltimoTurnoUsuario } from './database.js';
import { registrarEvento, registrarFeedback, executarComContagemLLM } from './observabilidade.js';
import { montarContextoPrincipal, interpretarComPrincipal, executarAcoesDoPrincipal } from './agentes/principal.js';
import { montarDosesDoTurno, renderizarBlocoDoses, avaliarAtalhoExato, executarAtalho, executarFatosDeDose,
         escolherAbertura, ultimaAberturaDoUsuario } from './dosesDoTurno.js';
import { comporComAncora } from './compositor.js';
import { registrarRenderizadorTardio } from './templates/catalogo.js';
import { executarRunner, executarOnboarding, repetirPergunta } from './runner.js';
import { SCHEMA_CADASTRO, renderizarFechamentoAnterior } from './schemas/cadastro.js';
import { handleRelatorios } from './agentes/relatorios.js';
import { handleConfiguracao } from './agentes/configuracao.js';
import { handleExclusaoConta, confirmarIntencaoExclusaoConta } from './agentes/exclusaoConta.js';
import { respostaHonestaAindaNao, respostaAindaNaoPadrao } from './inventario.js';
import { nomeEscritoNaMensagem } from './nlp_helpers.js';

// ============================================================
// ROTEADOR — v45 P1: o principal é a PORTA ÚNICA.
//
// Ordem do turno de usuário onboarded (briefing P1 §1):
//   1. fila, janela de agregação e dedupe (sem mudança);
//   2. citação resolvida no funil — SEM decisão, só contexto;
//   3. onboarding de quem não é onboarded (sem mudança — P5);
//   4. confirmação pendente de exclusão de conta (sem mudança);
//   5. atalho EXATO de dose (quatro guardas, sem LLM);
//   6. principal — a única chamada de interpretação;
//   7. execução pelo código: doses → ações → delegação.
//
// Nada que interpretava linguagem antes do principal sobrevive aqui
// (grep-guard no A0).
// ============================================================

// ============================================================
// IDEMPOTÊNCIA — descarta eventos duplicados da Z-API
// ============================================================

const processedMessages = new Map();
const MESSAGE_TTL_MS = 30_000;

function isDuplicateMessage(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    for (const [id, ts] of processedMessages.entries()) {
        if (now - ts > MESSAGE_TTL_MS) processedMessages.delete(id);
    }
    if (processedMessages.has(messageId)) return true;
    processedMessages.set(messageId, now);
    return false;
}

// ============================================================
// PERGUNTA SEGURA — destino de toda degradação (P31: o fallback
// existe como retorno de quem registrou a degradação).
// ============================================================

function primeiroNome(user) {
    return user?.name ? user.name.split(' ')[0] : null;
}

function reperguntaSegura(user) {
    const nome = primeiroNome(user);
    return `${nome ? `${nome}, d` : 'D'}esculpa, não consegui te entender direito. 🌿\n\nPode me dizer de outro jeito o que você precisa?`;
}

// v47 Onda 3 §1.3: a repergunta fica AQUI (aponta, não move); o catálogo a
// enxerga como entrada 'degradado' via registro tardio (sem ciclo de import).
registrarRenderizadorTardio('degradado', reperguntaSegura);

// ------------------------------------------------------------
// v47 Onda 3 §2 — ASSUNTO DA JORNADA: derivado do agente do turno e do estado
// PÓS-turno (a pergunta que ficou aberta), nunca do texto. Configuração fica
// fora de propósito (§1.4 — Etapa 3). Pura, exportada para o arnês (A69).
// ------------------------------------------------------------
export function derivarAssuntoDaJornada({ agente, estadoPos, naoSuportado = null }) {
    if (naoSuportado) return { fato: 'nao_suportado', detalhe: naoSuportado.chave || null };
    const estado = estadoPos?.state || 'idle';
    const etapa = estadoPos?.context?.etapa || null;
    if (agente === 'onboarding') {
        if (estado !== 'onboarding') return { fato: 'boas_vindas' };
        return etapa === 'onb_nascimento'
            ? { fato: 'pergunta_nascimento' }
            : { fato: 'pergunta_onboarding', detalhe: etapa };
    }
    if (agente === 'exclusao_conta') return { fato: 'dialogo_exclusao' };
    if (agente === 'principal_degradado') return { fato: 'degradado' };
    if (agente === 'cadastro' && ['adding_med', 'cadastrando_medicamento'].includes(estado)) {
        return { fato: 'pergunta_coleta', detalhe: etapa, medicationId: estadoPos?.context?.medication_id ?? null };
    }
    return null;
}

// Convite de estoque aberto (P1-ajustes §1/§4): a etapa da coleta e os
// medicamentos a que o convite se refere.
function conviteDeEstoqueAberto(state) {
    const etapa = state?.context?.etapa || '';
    if (etapa.startsWith('cad_estoque')) {
        const ids = etapa === 'cad_estoque_lote'
            ? (state.context.estoque_lote || []).map(p => p.medicationId)
            : [state.context.medication_id];
        return { medicationIds: ids.filter(Boolean) };
    }
    if (etapa === 'reativ_estoque_convite') return { medicationIds: [state.context.medicationId].filter(Boolean) };
    return null;
}

// Regra 5: a dose é registrada primeiro; a coleta aberta é retomada depois,
// na mesma mensagem — o estado da coleta NÃO é tocado.
// P1-ajustes §4: se o alerta pós-confirmação já trouxe o convite de estoque de
// todos os medicamentos do convite aberto, a retomada é omitida.
function montarRetomadaColeta(state, convitesEstoque = new Set()) {
    const s = state?.state;
    if (s === 'adding_med' || s === 'cadastrando_medicamento') {
        const etapa = state?.context?.etapa || '';
        if (etapa.startsWith('cad_estoque')) {
            const ids = conviteDeEstoqueAberto(state)?.medicationIds || [];
            if (ids.length && ids.every(id => convitesEstoque.has(id))) return null;
            return 'E quando quiser me falar do estoque, tô aqui 🌿';
        }
        return 'E quando quiser, seguimos com o cadastro de onde paramos 🌿';
    }
    if (s === 'configurando') return 'E quando quiser, seguimos com o ajuste de onde paramos 🌿';
    if (s === 'aguardando_escolha_tratamento') return 'E quando quiser, seguimos com o relatório de onde paramos 🌿';
    return null;
}

function juntar(...partes) {
    return partes.flat().filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()).join('\n\n');
}

// v47 §1: os fatos de dose EXECUTADOS no turno viram o assunto do envio da
// resposta (registrado pelo funil no ato do envio, em agent.js).
const FATO_ASSUNTO_DO_TURNO = { tomou: 'dose_confirmada', nao_tomou: 'dose_nao_tomada', desfazer: 'dose_desfeita' };

function assuntosDosFatos(executados = []) {
    return executados
        .map(p => ({ fato: FATO_ASSUNTO_DO_TURNO[p.fato], doseLogId: p.id, medicationId: p.medicationId }))
        .filter(a => a.fato);
}

// ============================================================
// PENDÊNCIA ABERTA (§3.3) — fluxo, etapa, a pergunta que ficou aberta
// (o último texto da Nami) e se ela é obrigatória, lido do schema.
// ============================================================

const FLUXO_DO_ESTADO = {
    adding_med: 'cadastro',
    cadastrando_medicamento: 'cadastro',
    configurando: 'configuracao',
    aguardando_escolha_tratamento: 'relatorios',
    confirming: 'principal',
    post_onboarding: 'pos_cadastro_inicial'
};

function obrigatoriedadeNoCadastro(etapa, contexto) {
    if (!etapa) return null;
    for (const campo of SCHEMA_CADASTRO.campos) {
        if (typeof campo.etapa !== 'function') continue;
        let etapaDoCampo = null;
        try { etapaDoCampo = campo.etapa(contexto || {}); } catch { etapaDoCampo = null; }
        if (etapaDoCampo === etapa || (campo.nome === 'estoque' && etapa.startsWith('cad_estoque'))) {
            return campo.nivel === 'have_to_have';
        }
    }
    // Etapas de confirmação (lote, correção) não são campo: a resposta decide o fluxo.
    return true;
}

function relativo(ts) {
    const min = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    const hora = new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    if (min < 1) return `${hora} (agora mesmo)`;
    if (min < 60) return `${hora} (há ${min} min)`;
    return `${hora} (há ${Math.round(min / 60)}h)`;
}

const JANELA_AMBIGUIDADE_DUPLA_PENDENCIA_MS = 90_000;

// P6.1 (BUG-86): só nas etapas em que a pergunta aberta é de SIM/NÃO um
// "sim" curto disputa com a dose pendente (pela pergunta mais recente).
// Pergunta ABERTA de coleta (posologia, estoque, nome) não se responde com
// "sim" — a dose vence sempre (regra 5, caso A4). Mesma lista do M3.
const ETAPAS_COM_CONFIRMACAO_DE_FLUXO = new Set([
    'confirm_acao', 'reativ_confirmar', 'cad_lote_confirmar',
    'corrigir_mh79_confirmar', 'pos_alteracao', 'reativ_oferta', 'reativ_manter_ou_mudar',
    'reativ_com_mudanca_confirmar', 'confirm_acao_lote'
]);

function montarPendencia({ state, historicoConversa, ultimoLembrete }) {
    const estado = state?.state || 'idle';
    if (estado === 'idle') return null;
    const fluxo = FLUXO_DO_ESTADO[estado] || estado;
    const etapa = state?.context?.etapa || null;
    const ultimo = historicoConversa.at(-1) || null;

    const pendencia = {
        fluxo,
        etapa,
        pergunta: ultimo?.agent_response || null,
        obrigatoria: fluxo === 'cadastro' ? obrigatoriedadeNoCadastro(etapa, state?.context)
            : fluxo === 'pos_cadastro_inicial' ? false
            : true,
        quando: ultimo?.created_at ? relativo(ultimo.created_at) : null,
        mensagemPreservada: estado === 'post_onboarding' ? (state?.context?.mensagem_rica || null) : null
    };

    // P6.1: com pergunta de SIM/NÃO aberta E lembrete de dose, o código diz qual
    // é o mais recente — o principal nunca estima tempo. Fora dessas etapas, a
    // pergunta aberta não disputa um "sim" com a dose.
    if (ultimoLembrete?.momento && !ETAPAS_COM_CONFIRMACAO_DE_FLUXO.has(etapa)) {
        pendencia.maisRecente = 'a pergunta aberta NÃO é de sim/não — um "sim" curto agora é da DOSE (regra 1); a pergunta do fluxo continua aberta';
    } else if (ultimo?.created_at && ultimoLembrete?.momento) {
        const tPergunta = new Date(ultimo.created_at).getTime();
        const tLembrete = new Date(ultimoLembrete.momento).getTime();
        if (Math.abs(tPergunta - tLembrete) <= JANELA_AMBIGUIDADE_DUPLA_PENDENCIA_MS) {
            pendencia.maisRecente = 'chegaram praticamente juntos — um "sim" curto é ambíguo: pergunte em uma linha';
        } else if (tLembrete > tPergunta) {
            pendencia.maisRecente = `o LEMBRETE DE DOSE (grupo ${ultimoLembrete.grupo}) chegou depois da pergunta — um "sim" curto agora confirma a DOSE; a pergunta do fluxo continua aberta`;
        } else {
            pendencia.maisRecente = 'a PERGUNTA DO FLUXO foi feita depois do lembrete — um "sim" curto agora responde ao FLUXO; a dose continua aguardando';
        }
    }
    return pendencia;
}

// ============================================================
// DELEGAÇÃO AO ESPECIALISTA (§7) — mesmas entradas de hoje, sem S1–S4.
// Devolve { agentName, response } ou { devolveu: true }.
// ============================================================

async function delegarCadastro({ user, message, image, state, historicoConversa, delegar }) {
    const estado = state?.state || 'idle';
    const emColeta = estado === 'adding_med' || estado === 'cadastrando_medicamento';
    const prefixos = [];
    let contexto;
    let mensagem = message;
    let camposPorta = delegar.campos;

    if (delegar.relacao_pendencia === 'responde' && emColeta && state?.context?.etapa) {
        // A mensagem responde à coleta aberta: o runner continua de onde parou.
        contexto = state.context;
    } else if (delegar.relacao_pendencia === 'responde' && estado === 'post_onboarding' && state?.context?.mensagem_rica) {
        // P57: o aceite curto entrega ao cadastro a mensagem COM os dados.
        mensagem = state.context.mensagem_rica;
        contexto = { etapa: 'cad_nome' };
        if (!camposPorta?.medicamentos?.length && state.context.campos_rica) camposPorta = state.context.campos_rica;
    } else {
        // Cadastro NOVO: o anterior fecha pela verdade do banco (MH-83) —
        // nada dele vaza para o novo.
        if (emColeta && state?.context?.medication_id && state?.context?.nome) {
            prefixos.push(renderizarFechamentoAnterior(state.context.nome));
        }
        contexto = { etapa: 'cad_nome', ...(emColeta ? {} : (state?.context?.rascunho_cadastro || {})) };
        if (emColeta) await saveConversationState(user.id, { state: 'idle', context: {} });

        // v47 ajuste-referente §2 (aceite de OFERTA): os nomes propostos vieram
        // da fala referida — NENHUM está escrito na mensagem da pessoa. A
        // mensagem entregue ao runner ganha a linha dos nomes NA FRENTE,
        // preservando o que a pessoa escreveu (correção 08/10: "Sim, eu tomo
        // 1 cp as 20h" perdia a posologia quando a mensagem era substituída).
        const nomesPorta = camposPorta?.medicamentos || [];
        if (nomesPorta.length && !nomesPorta.some(m => nomeEscritoNaMensagem(m, message))) {
            console.log(`💊 [CADASTRO] Aceite de oferta: coleta aberta com ${nomesPorta.join(' e ')} (nome vindo da fala referida) — ${user.phone}`);
            mensagem = `${nomesPorta.join(' e ')}\n${message}`;
        }

        // Pedido de cadastro SEM remédio nomeado ("Quero cadastrar mais um!"): o
        // principal já decidiu que é cadastro novo — abre a coleta pela pergunta
        // do schema, sem pedir ao runner que reinterprete o pedido.
        if (!(camposPorta?.medicamentos || []).length && !contexto.nome) {
            const aberto = { sujeito: 'usuario', ...contexto, etapa: 'cad_nome' };
            await saveConversationState(user.id, { state: SCHEMA_CADASTRO.estadoConversa, context: aberto });
            const pergunta = await repetirPergunta({ schema: SCHEMA_CADASTRO, context: aberto, userName: user.name });
            return { agentName: 'cadastro', response: juntar(prefixos, pergunta) };
        }
    }

    const resultado = await executarRunner({
        schema: SCHEMA_CADASTRO, user, message: mensagem,
        state: contexto === state?.context ? state : { state: 'idle', context: {} },
        context: contexto, historicoConversa, camposPorta
    });

    if (resultado?.escalarParaRoteador) return { devolveu: true };

    // Medicamento JÁ ativo com ajuste embutido: a configuração assume.
    if (resultado?.configurarExistente) {
        const { medicationId, medicationNome, schedulesAtivos } = resultado.configurarExistente;
        console.log(`⚙️ [CADASTRO→CONFIG] Ajuste de medicamento ativo (${medicationNome}) — ${user.phone}`);
        const r = await handleConfiguracao({
            user, message, historicoConversa,
            state: { state: 'configurando', context: { etapa: 'identif_intencao' } },
            context: { etapa: 'identif_intencao', medicationId, medicationNome, schedulesAtivos }
        });
        if (r?.naoSuportado) return { naoSuportado: true, especialista: 'configuracao' };
        if (r?.escalarParaRoteador) return { devolveu: true };
        return { agentName: 'configuracao', response: juntar(prefixos, r) };
    }
    return { agentName: 'cadastro', response: juntar(prefixos, resultado) };
}

async function delegarConfiguracao({ user, message, state, historicoConversa, delegar }) {
    const continua = delegar.relacao_pendencia === 'responde' && state?.state === 'configurando' && state?.context;
    const contexto = continua ? state.context : { etapa: 'identif_intencao' };
    const r = await handleConfiguracao({
        user, message, historicoConversa,
        state: continua ? state : { state: 'configurando', context: contexto },
        context: contexto
    });
    if (r?.naoSuportado) return { naoSuportado: true, especialista: 'configuracao' };
    if (r?.escalarParaRoteador) return { devolveu: true };
    return { agentName: 'configuracao', response: r };
}

async function delegarRelatorios({ user, message, state, delegar }) {
    const { subtipo, medicamento, expressaoData } = delegar.campos;
    const r = await handleRelatorios({ user, message, subtipo, params: { medicamento, expressaoData }, state });
    if (!r) return { devolveu: true };
    return { agentName: 'relatorios', response: r };
}

async function delegarExclusao({ user, message, historicoConversa, state }) {
    // O passo de segurança continua: a exclusão só abre com a confirmação da
    // intenção (estágio 2) — nunca pela proposta do principal sozinha.
    const confirma = await confirmarIntencaoExclusaoConta({ message, historicoConversa, currentState: state?.state || 'idle' });
    if (!confirma) return { devolveu: true };
    const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
    return { agentName: 'exclusao_conta', response: r.response };
}

async function despacharDelegacao(args) {
    switch (args.delegar.especialista) {
        case 'cadastro': return delegarCadastro(args);
        case 'configuracao': return delegarConfiguracao(args);
        case 'relatorios': return delegarRelatorios(args);
        case 'excluir_conta': return delegarExclusao(args);
        default: return { devolveu: true };
    }
}

// ============================================================
// TURNO DO PRINCIPAL (§3–§7)
// ============================================================

async function carregarMedicamentos(userId, doses) {
    const meds = await getUserMedications(userId);
    const emAberto = new Set((doses || [])
        .filter(d => ['pendente', 'nao_informado', 'sem_estoque'].includes(d.status) && !d.confirmed)
        .map(d => d.medication_id));
    return meds.map(m => ({ ...m, temDoseEmAberto: emAberto.has(m.id) }));
}

// P1-ajustes 2 §1 — o "ainda não" é sempre texto do código: a `message` do
// principal nunca é lida aqui (um autor por fato). Com chave conhecida → a
// resposta honesta do inventário; sem chave → a reserva que nomeia o pedido.
// `misto_com_nunca` fica só no payload do evento, não muda o texto.
function textoAindaNao({ user, decisao, pedidoAnterior }) {
    const d = decisao?.delegar;
    const pedido = d?.pedido || pedidoAnterior || null;
    if (d?.chaveAindaNao) return `${respostaHonestaAindaNao(d.chaveAindaNao)}\n\nPosso te ajudar com outra coisa? 🌿`;
    return respostaAindaNaoPadrao({ nome: primeiroNome(user), pedido });
}

async function turnoDoPrincipal({ user, message, image, state, historicoConversa, contextoProativo,
                                  envioCitado, dosesCitadas, citacaoSemDose = false, falaDirecionada = null,
                                  doses, especialistaDevolveu = null,
                                  especialistaNaoExecuta = null, pedidoAnterior = null,
                                  textosAnteriores = [], assuntosAnteriores = [], composicaoAnterior = null }) {
    const estado = state?.state || 'idle';
    const { estrutura, mapa } = await montarDosesDoTurno({ userId: user.id, envioCitado, dosesCitadas, doses, citacaoSemDose });
    const pendencia = montarPendencia({ state, historicoConversa, ultimoLembrete: estrutura.ultimoLembrete });
    const medicamentos = await carregarMedicamentos(user.id, doses);

    const contexto = montarContextoPrincipal({
        user, estado, blocoDoses: renderizarBlocoDoses(estrutura), pendencia,
        eventosProativos: contextoProativo, medicamentos, historicoConversa,
        especialistaDevolveu, especialistaNaoExecuta, mensagem: message, temImagem: !!image,
        falaDirecionada
    });

    if (process.env.NAMI_DEBUG_PRINCIPAL) console.log(`🔎 [PRINCIPAL] contexto:\n${contexto}`);
    // v47 ajuste-referente §2: as falas da Nami a que a pessoa responde são
    // fonte legítima de nome de medicamento (aceite de oferta) — a porta as
    // confere por código (normalizarDecisao).
    const decisao = await interpretarComPrincipal({
        contexto, mensagem: message, image,
        textosReferentes: [falaDirecionada?.texto, envioCitado?.texto].filter(Boolean)
    });

    // §5.2: o especialista entendeu e não executa — a volta ao principal é
    // ÚNICA e termina no "ainda não", nunca em outra delegação nem em "não
    // entendi". Principal falhou → reserva do inventário.
    if (especialistaNaoExecuta) {
        // O texto é do código; do principal vêm só o pedido e a chave.
        const d = decisao?.delegar?.especialista === 'nao_suportado' ? decisao : null;
        if (!d) console.warn(`⚠️ [PRINCIPAL] "ainda não" de ${especialistaNaoExecuta} sem nao_suportado do principal — reserva — ${user.phone}`);
        return {
            agentName: 'principal',
            response: juntar(textosAnteriores, textoAindaNao({ user, decisao: d, pedidoAnterior })),
            feedback: decisao?.feedback ?? null,
            assuntos: assuntosAnteriores,
            composicao: composicaoAnterior,
            naoSuportado: {
                pedido: d?.delegar?.pedido || pedidoAnterior || null,
                especialista: especialistaNaoExecuta,
                chave: d?.delegar?.chaveAindaNao || null,
                mistoComNunca: !!d?.delegar?.mistoComNunca
            },
            escalouPara: 'principal'
        };
    }

    if (!decisao) {
        return { agentName: 'principal_degradado', response: juntar(textosAnteriores, reperguntaSegura(user)), feedback: null, assuntos: assuntosAnteriores, composicao: composicaoAnterior };
    }
    console.log(`🚪 [PRINCIPAL] tipo: ${decisao.tipo}${decisao.doses.length ? ` · doses: ${decisao.doses.map(d => `${d.ref}:${d.fato}`).join(',')}` : ''}${decisao.delegar ? ` · delegar: ${decisao.delegar.especialista}/${decisao.delegar.relacao_pendencia}` : ''}${decisao.actions.length ? ` · ações: ${decisao.actions.map(a => a.type).join(',')}` : ''} — ${user.phone}`);

    // §1: delegou a RESPOSTA ao convite de estoque ao especialista → quem grava
    // e escreve o estoque é ele; UPDATE_STOCK do mesmo turno é descartado.
    let actions = decisao.actions;
    if (['cadastro', 'configuracao'].includes(decisao.delegar?.especialista)
        && decisao.delegar.relacao_pendencia === 'responde' && conviteDeEstoqueAberto(state)
        && actions.some(a => a?.type === 'UPDATE_STOCK')) {
        console.log(`📦 [PRINCIPAL] UPDATE_STOCK descartado: a resposta ao convite de estoque é do ${decisao.delegar.especialista} — ${user.phone}`);
        actions = actions.filter(a => a?.type !== 'UPDATE_STOCK');
    }

    const partes = [...textosAnteriores];
    let agentName = 'principal';
    let dosesExecutadas = false;
    let dosesAbriram = false;
    let convitesEstoque = new Set();
    let naoSuportado = null;
    let assuntosDoTurno = [...assuntosAnteriores];
    let composicaoDoTurno = composicaoAnterior; // v47 Onda 1: composto | fallback_* | null

    // Na volta de uma devolução, doses e ações já foram executadas na 1ª rodada.
    const primeiraRodada = !especialistaDevolveu;

    // 7a. Doses primeiro — a EXECUÇÃO é intocada (TABELA status × fato, P56).
    let resultadoDoses = null;
    if (primeiraRodada && decisao.doses.length) {
        const medsComAcaoDeEstoque = new Set(actions
            .filter(a => a?.type === 'UPDATE_STOCK' && a.medicationId).map(a => a.medicationId));
        const r = await executarFatosDeDose({ user, fatos: decisao.doses, mapa, semAlertaPara: medsComAcaoDeEstoque });
        if (!r.ok) {
            // §6.1: ref inválida → o turno vira pergunta segura (degradar já registrado).
            return { agentName: 'principal_degradado', response: juntar(partes, reperguntaSegura(user)), feedback: decisao.feedback, assuntos: assuntosDoTurno, composicao: composicaoDoTurno };
        }
        assuntosDoTurno.push(...assuntosDosFatos(r.executados));
        if (r.soJaRegistradas) {
            if (!decisao.message) partes.push('Tudo certo — isso já estava registrado aqui ✅');
        } else if (!r.soAindaNao) {
            resultadoDoses = r;
            dosesExecutadas = true;
            dosesAbriram = !!r.abriu;
            convitesEstoque = r.convitesEstoque || new Set();
            agentName = 'principal_dose';
        }
    }

    const executaEstoque = primeiraRodada && actions.some(a => a?.type === 'UPDATE_STOCK');
    const aindaNaoDoTurno = decisao.delegar?.especialista === 'nao_suportado';

    // 7b. Ações do domínio do principal — executadas ANTES de qualquer texto
    // (escrita primeiro; todo texto sai de leitura pós-escrita, P56).
    let resultadoAcoes = { texto: '', fatos: [] };
    if (primeiraRodada && actions.length) {
        // §2: a abertura vem uma vez só no turno — a da confirmação de dose, se
        // houve; senão a do estoque, diferente da última usada com a pessoa.
        const abertura = executaEstoque && !dosesAbriram
            ? escolherAbertura({ nome: primeiroNome(user), ultima: await ultimaAberturaDoUsuario(user.id) })
            : null;
        resultadoAcoes = await executarAcoesDoPrincipal(actions, user, { abertura });
    }

    // v47 Onda 1 — COMPOSITOR (MH-100 B): turno com fatos de dose executados
    // sai como UMA mensagem composta dos fatos tipados, sob âncora, com
    // fallback no canônico (a montagem determinística abaixo). A `message` do
    // principal deixa de ir ao usuário como está: vira intenção conversacional.
    if (resultadoDoses) {
        const canonico = juntar(resultadoDoses.texto, resultadoDoses.textoDepois, resultadoAcoes.texto);
        const composicao = await comporComAncora({
            user,
            fatos: [...resultadoDoses.fatosDoTurno, ...resultadoAcoes.fatos],
            intencao: (decisao.tipo !== 'delegar' && !aindaNaoDoTurno) ? decisao.message : '',
            assuntoCitacao: envioCitado ? { origem: envioCitado.origem } : null,
            historicoCurto: historicoConversa.slice(-2).map(h => h?.agent_response).filter(Boolean),
            medicamentosDoUsuario: medicamentos.map(m => m.nome).filter(Boolean),
            canonico
        });
        partes.push(composicao.texto);
        composicaoDoTurno = composicao.caminho;
    } else {
        // SEM fato de dose executado: fluxo de hoje, intocado — este é o ÚNICO
        // ponto que concatena a `message` do principal (grep-guard A66).
        // P1-ajustes 2 §1/§2: no turno que grava estoque ou que é "ainda não",
        // o fato é do código — e o texto também; a `message` não entra.
        if (decisao.message && decisao.tipo !== 'delegar') {
            if (executaEstoque || aindaNaoDoTurno) {
                console.log(`🧾 [PRINCIPAL] message do principal descartada: o texto do ${executaEstoque ? 'estoque' : '"ainda não"'} é do código — ${user.phone}`);
            } else {
                partes.push(decisao.message);
            }
        }
        if (resultadoAcoes.texto) partes.push(resultadoAcoes.texto);
    }

    // 7c. Delegação.
    let delegou = false;
    if (decisao.delegar) {
        if (decisao.delegar.especialista === 'nao_suportado') {
            // §5: "ainda não" por padrão — sempre texto do código (P1-ajustes 2
            // §1), que nomeia o pedido (nunca "isso"). Vale também na volta de
            // uma devolução (§5.3: nunca "não entendi" para um pedido claro).
            partes.push(textoAindaNao({ user, decisao, pedidoAnterior }));
            naoSuportado = {
                pedido: decisao.delegar.pedido || pedidoAnterior || null,
                especialista: especialistaDevolveu || 'principal',
                chave: decisao.delegar.chaveAindaNao,
                mistoComNunca: decisao.delegar.mistoComNunca
            };
        } else {
            const r = await despacharDelegacao({ user, message, image, state, historicoConversa, delegar: { ...decisao.delegar } });
            if (r.naoSuportado) {
                // §5.2: o especialista entendeu e não executa → uma volta ao
                // principal, marcada, que escreve o "ainda não".
                console.log(`🌱 [PRINCIPAL] ${r.especialista} entendeu e não executa — "ainda não" pelo principal — ${user.phone}`);
                const estadoAtual = await getConversationState(user.id);
                return turnoDoPrincipal({
                    user, message, image, state: estadoAtual, historicoConversa, contextoProativo,
                    envioCitado, dosesCitadas, citacaoSemDose, falaDirecionada, doses: await getDosesJanelaPrincipal(user.id),
                    especialistaNaoExecuta: r.especialista, pedidoAnterior: decisao.delegar.pedido,
                    textosAnteriores: partes, assuntosAnteriores: assuntosDoTurno, composicaoAnterior: composicaoDoTurno
                }).then(volta => ({ ...volta, feedback: volta.feedback ?? decisao.feedback }));
            }
            if (r.devolveu) {
                if (especialistaDevolveu) {
                    // Segunda devolução → pergunta segura. Sem pingue-pongue.
                    console.warn(`⚠️ [PRINCIPAL] Segunda devolução (${decisao.delegar.especialista}) — pergunta segura — ${user.phone}`);
                    if (['configurando', 'aguardando_escolha_tratamento'].includes(estado)) {
                        await saveConversationState(user.id, { state: 'idle', context: {} });
                    }
                    return { agentName: 'principal_degradado', response: juntar(partes, reperguntaSegura(user)), feedback: decisao.feedback, assuntos: assuntosDoTurno, composicao: composicaoDoTurno };
                }
                console.log(`🔁 [PRINCIPAL] ${decisao.delegar.especialista} devolveu o turno — uma volta ao principal — ${user.phone}`);
                const estadoAtual = await getConversationState(user.id);
                const volta = await turnoDoPrincipal({
                    user, message, image, state: estadoAtual, historicoConversa, contextoProativo,
                    envioCitado, dosesCitadas, citacaoSemDose, falaDirecionada, doses: await getDosesJanelaPrincipal(user.id),
                    especialistaDevolveu: decisao.delegar.especialista, pedidoAnterior: decisao.delegar.pedido,
                    textosAnteriores: partes, assuntosAnteriores: assuntosDoTurno, composicaoAnterior: composicaoDoTurno
                });
                return { ...volta, feedback: volta.feedback ?? decisao.feedback, escalouPara: volta.agentName };
            }
            partes.push(r.response);
            agentName = r.agentName;
            delegou = true;
        }
    }

    // Estado. Fora de fluxo, o principal decide (idle/confirming); com fluxo
    // de especialista aberto, o estado dele é preservado (regra 5).
    if (!delegou) {
        if (estado === 'idle' || estado === 'confirming') {
            await saveConversationState(user.id, { state: decisao.newState, context: {} });
        } else if (estado === 'aguardando_escolha_tratamento') {
            // Estado leve de pergunta do relatório: sem dado a preservar.
            await saveConversationState(user.id, { state: 'idle', context: {} });
        } else if (estado === 'post_onboarding' && !dosesExecutadas) {
            // Rede de segurança P57: guarda a mensagem para um aceite seguinte.
            const exchanges = state?.context?.exchanges || 0;
            if (exchanges < 1) {
                await saveConversationState(user.id, {
                    state: 'post_onboarding',
                    context: { exchanges: exchanges + 1, mensagem_rica: message, campos_rica: null }
                });
            }
        } else if (dosesExecutadas) {
            const retomada = montarRetomadaColeta(state, convitesEstoque);
            if (retomada) partes.push(retomada);
        }
    } else if (estado === 'aguardando_escolha_tratamento' && decisao.delegar?.especialista !== 'relatorios') {
        const atual = await getConversationState(user.id);
        if (atual?.state === 'aguardando_escolha_tratamento') {
            await saveConversationState(user.id, { state: 'idle', context: {} });
        }
    }

    const response = juntar(partes);
    return {
        agentName,
        response: response || reperguntaSegura(user),
        feedback: decisao.feedback,
        naoSuportado,
        assuntos: assuntosDoTurno,
        composicao: composicaoDoTurno,
        escalouPara: especialistaDevolveu ? agentName : null
    };
}

// ============================================================
// ROTEADOR PRINCIPAL
// ============================================================

export async function routeMessage({ user, message, image, messageId, referenceMessageId }) {
    if (isDuplicateMessage(messageId)) {
        console.log(`⚠️  Mensagem duplicada ignorada: ${messageId}`);
        return null;
    }

    const { resultado, chamadasLLM } = await executarComContagemLLM(
        () => processarTurno({ user, message, image, referenceMessageId })
    );
    if (!resultado) return resultado;
    // §10: linha de log padronizada por turno.
    console.log(`📈 [TURNO] agente=${resultado.agente} chamadas_llm=${chamadasLLM} — ${user.phone}`);
    return { ...resultado, chamadasLLM };
}

async function processarTurno({ user, message, image, referenceMessageId }) {
    // ---- 2. CITAÇÃO: só anexa ao contexto qual envio foi citado e, se for
    // lembrete, qual grupo de doses. Nunca decide nada.
    let envioCitado = null;
    let dosesCitadas = [];
    let citacaoSemDose = false;
    if (referenceMessageId) {
        envioCitado = await getEnvioFunilPorProviderId(referenceMessageId);
        if (envioCitado) {
            // v47 §1: a fonte de verdade da citação é o ASSUNTO do envio; o
            // vínculo legado por funil_envio_id fica como fallback para envios
            // anteriores à migração (sem linhas de assunto).
            const assunto = await getAssuntoDoEnvio(envioCitado.id);
            dosesCitadas = assunto ? assunto.doses : await getDosesDoEnvio(envioCitado.id);
            // v47 ajuste-referente §3: "SEM dose associada" só quando o assunto
            // EXISTE e não tem dose — dado lido da tabela, nunca inferido.
            citacaoSemDose = !!assunto && assunto.doses.length === 0;
            console.log(`💬 [CITAÇÃO] referenceMessageId resolvido no funil (${envioCitado.origem}, ${dosesCitadas.length} dose(s), via ${assunto ? 'assunto' : 'fallback legado'}) — ${user.phone}`);
        } else {
            console.log(`💬 [CITAÇÃO] referenceMessageId ${referenceMessageId} sem correspondência no funil — ${user.phone}`);
        }
    }

    const state = await getConversationState(user.id);
    const currentState = state?.state || 'idle';

    // Histórico conversacional — buscado UMA vez, propagado a todos os agentes LLM.
    const historicoConversa = await getHistoricoRecente(user.id, 3);
    const ultimoTurnoAt = historicoConversa.at(-1)?.created_at ?? null;
    const contextoProativo = await getContextoProativoRecente(user.id, ultimoTurnoAt);
    // v47 ajuste-referente §1 (gatilho refinado na validação de 08/10): a fala
    // integral entra SÓ quando a direcionada é o evento proativo MAIS RECENTE
    // desde o último turno — a linha injetada afirma "foi a última coisa dita",
    // e o código só a afirma quando ela é verdadeira. Direcionada seguida de
    // lembretes = resposta tardia: o caminho é a citação (§3), não esta fala.
    const falaDirecionada = contextoProativo.at(-1)?.tipo === 'mensagem_direcionada'
        ? await getFalaDirecionadaRecente(user.id, ultimoTurnoAt)
        : null;

    let response;
    let agentName;
    let feedbackDetectado = null;
    let naoSuportadoDetectado = null; // P1-ajustes §5.5
    let escalouParaDetectado = null; // MH-48: sinal de escalada consultável em agent_logs
    let assuntosDetectados = []; // v47 §1: fatos de dose do turno → assunto do envio da resposta
    let composicaoDetectada = null; // v47 Onda 1 §3.4: composto | fallback_* | canonico_direto
    let passouPeloPrincipal = false; // v47 ajuste-referente §6: eventos no prompt só quando o principal rodou

    const irAoPrincipal = async (extras = {}) => {
        passouPeloPrincipal = true;
        const r = await turnoDoPrincipal({
            user, message, image, state, historicoConversa, contextoProativo,
            envioCitado, dosesCitadas, citacaoSemDose, falaDirecionada,
            doses: await getDosesJanelaPrincipal(user.id), ...extras
        });
        agentName = r.agentName;
        response = r.response;
        feedbackDetectado = r.feedback ?? feedbackDetectado;
        escalouParaDetectado = r.escalouPara ?? escalouParaDetectado;
        if (r.naoSuportado) naoSuportadoDetectado = r.naoSuportado;
        if (r.assuntos?.length) assuntosDetectados = r.assuntos;
        composicaoDetectada = r.composicao ?? composicaoDetectada;
    };

    // ---- 3. Onboarding no RUNNER (v44 M4) — sem mudança (P5).
    if (!user.onboarded || currentState === 'onboarding') {
        agentName = 'onboarding';
        console.log(`👋 Roteando para o onboarding (runner) — ${user.phone}`);
        const resultadoOnboarding = await executarOnboarding({ user, message, state, historicoConversa });
        if (resultadoOnboarding?.escalarParaRoteador) {
            // O onboarding devolveu o turno (pessoa já onboarded, nova intenção
            // na pergunta opcional): quem interpreta é o principal.
            const estadoDepois = await getConversationState(user.id);
            passouPeloPrincipal = true;
            const r = await turnoDoPrincipal({
                user, message, image, state: estadoDepois, historicoConversa, contextoProativo,
                envioCitado, dosesCitadas, citacaoSemDose, falaDirecionada,
                doses: await getDosesJanelaPrincipal(user.id),
                especialistaDevolveu: 'onboarding'
            });
            agentName = r.agentName;
            response = r.response;
            feedbackDetectado = r.feedback ?? feedbackDetectado;
            escalouParaDetectado = r.agentName;
            if (r.naoSuportado) naoSuportadoDetectado = r.naoSuportado;
            if (r.assuntos?.length) assuntosDetectados = r.assuntos;
        } else {
            response = resultadoOnboarding;
        }

    // ---- 4. MH-020 — confirmação pendente de exclusão de conta (sem mudança).
    } else if (currentState === 'aguardando_confirmacao_exclusao') {
        agentName = 'exclusao_conta';
        console.log(`🗑️ Roteando para exclusão de conta (confirmação pendente) — ${user.phone}`);
        const r = await handleExclusaoConta({ user, message, etapa: 'confirmar', historicoConversa });
        if (r.contaExcluida) {
            // Usuário não existe mais — retorna ANTES do logAgentInteraction
            // (inserir agent_logs com user_id apagado daria FK error).
            return { texto: r.response, agente: 'exclusao_conta', agentLogId: null };
        }
        response = r.response;

    } else {
        // ---- 5. ATALHO EXATO DE DOSE (§2): confirma sem LLM ou passa adiante.
        const doses = await getDosesJanelaPrincipal(user.id);
        const atalho = avaliarAtalhoExato({
            message, state, doses, dosesCitadas,
            ultimoTurnoUsuarioAt: await getUltimoTurnoUsuario(user.id)
        });
        if (atalho.doses) {
            const r = await executarAtalho({ user, doses: atalho.doses });
            if (r.ok) {
                agentName = 'atalho_dose_exato';
                response = r.texto;
                assuntosDetectados = assuntosDosFatos(r.executados);
                composicaoDetectada = 'canonico_direto'; // isenção do compositor (v47 Onda 1 §6.4)
                console.log(`⚡ [ATALHO] ${atalho.doses.length} dose(s) confirmada(s) sem LLM — ${user.phone}`);
            }
        } else {
            console.log(`⚡ [ATALHO] não se aplica (${atalho.motivo}) — ${user.phone}`);
        }

        // ---- 6–7. PRINCIPAL: a única chamada de interpretação do turno.
        if (response === undefined) await irAoPrincipal({ doses });
    }

    // v47 Onda 3 §2: envio da jornada carrega assunto — quando o turno não
    // produziu fatos de dose, o assunto vem do agente + estado pós-turno.
    if (!assuntosDetectados.length && response) {
        const estadoPos = await getConversationState(user.id);
        const assuntoJornada = derivarAssuntoDaJornada({ agente: agentName, estadoPos, naoSuportado: naoSuportadoDetectado });
        if (assuntoJornada) assuntosDetectados = [assuntoJornada];
    }

    // MH-48: quando o turno escalou, o sinal fica consultável em agent_logs.
    // v47 Onda 1 §3.4: o caminho da mensagem (composto | fallback_* |
    // canonico_direto) também — sem tabela nova, no contexto do log.
    const extrasLog = {};
    if (escalouParaDetectado) extrasLog.escalada = { para: escalouParaDetectado };
    if (composicaoDetectada) extrasLog.composicao = composicaoDetectada;
    // v47 ajuste-referente §6: o que de proativo FOI ao prompt do principal fica
    // consultável no log do turno (mesmo espírito do campo `composicao`) —
    // perguntas de causalidade se respondem por consulta, não por experimento.
    if (passouPeloPrincipal && (contextoProativo.length || falaDirecionada)) {
        extrasLog.contexto_proativo = {
            eventos: contextoProativo.map(e => ({ id: e.id, tipo: e.tipo })),
            fala_direcionada: !!falaDirecionada
        };
    }
    const agentLogId = await logAgentInteraction({
        userId: user.id,
        agent: agentName,
        userMessage: message,
        agentResponse: response,
        estadoConversa: currentState || null,
        contextoConversa: Object.keys(extrasLog).length
            ? { ...(state?.context || {}), ...extrasLog }
            : (state?.context || null),
        referenceMessageId: referenceMessageId || null
    });

    // §5.5: todo "ainda não" vira item da lista de demanda do roadmap.
    if (naoSuportadoDetectado) {
        const { pedido, especialista, chave, mistoComNunca } = naoSuportadoDetectado;
        await registrarEvento({
            tipo: 'intencao_nao_suportada',
            severidade: 'baixa',
            statusTriagem: 'novo',
            userId: user.id,
            agent: agentName,
            origem: 'porta',
            agentLogId,
            titulo: `Ainda não: ${pedido || chave || 'pedido sem paráfrase'}`.slice(0, 120),
            payload: { pedido: pedido || null, especialista, chave_ainda_nao: chave || null, misto_com_nunca: !!mistoComNunca }
        });
    }

    if (feedbackDetectado) {
        await registrarFeedback({
            userId: user.id,
            categoria: feedbackDetectado,
            origem: 'espontaneo',
            texto: message,
            agentLogId
        });
    }

    // v44 §5.5: o roteador devolve texto + vínculo — quem ENVIA é só o funil.
    // v47 §1: e devolve os fatos de dose executados, que viram o assunto do envio.
    return { texto: response, agente: agentName, agentLogId, assuntos: assuntosDetectados };
}
