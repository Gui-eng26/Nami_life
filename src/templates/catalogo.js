// ============================================================
// CATÁLOGO DE FATOS — v47 Onda 2 (MH-100 C)
//
// O mapa ÚNICO fato → função de renderização canônica. Todo texto proativo
// e todo fragmento canônico do turno (atalho exato, âncora/fallback do
// compositor) sai deste lookup — scheduler, lembrete e relatorios produzem
// o FATO tipado e pedem a renderização; nunca montam string.
//
// As funções vivem em templates/ (casa por domínio); este módulo é só o
// ponto de lookup. Nenhum texto é definido aqui.
// ============================================================

import {
    buildReminderMessage, buildGroupedReminderMessage,
    buildFollowUpMessage, buildGroupedFollowUpMessage,
    buildEstoqueZeradoMessage, buildConclusaoTratamentoMessage,
    buildCuidadorFollowUpEsgotado
} from './lembreteTemplates.js';
import {
    buildCobrancaEncerrada, buildAlertaEstoquePosConfirmacao, buildAlertaEstoquePosAjuste,
    buildConviteEstoqueNaoCadastrado, buildConviteEstoqueContestado, buildEstoqueAtualizadoMessage
} from './estoqueTemplates.js';
import { textoDeConfirmacao, linhaNaoTomada, linhaDosesRevertidas } from './dose.js';
import { montarResumoAdesao } from './adesaoTemplates.js';

const CATALOGO = {
    // --- Proativas (scheduler / lembrete / relatorios) ---
    lembrete: (f) => f.grupo
        ? buildGroupedReminderMessage(f.firstName, f.horario, f.grupo)
        : buildReminderMessage(f.firstName, f.reminder),
    follow_up: (f) => f.grupo
        ? buildGroupedFollowUpMessage(f.tentativa, f.firstName, f.horario, f.grupo, f.quantidadePorItem)
        : buildFollowUpMessage(f.tentativa, f.reminder, f.quantidade),
    cobranca_encerrada: (f) => buildCobrancaEncerrada(f.firstName, f.estoqueInfo),
    alerta_estoque_zerado: (f) => buildEstoqueZeradoMessage(f.firstName, f.reminder),
    conclusao_tratamento: (f) => buildConclusaoTratamentoMessage(f.firstName, f.med),
    resumo_semanal: (f) => montarResumoAdesao(f),
    cuidador_follow_up_esgotado: (f) => buildCuidadorFollowUpEsgotado(f),

    // §1: pass-through — o texto vem pronto do Guilherme; o catálogo não redige.
    mensagem_direcionada: (f) => f.texto,

    // --- Fatos do turno (Onda 1): fragmentos canônicos do fallback/atalho ---
    dose_confirmada: (f) => textoDeConfirmacao(f),          // { abertura, confirmadas, jaRegistradas }
    dose_nao_tomada: (f) => linhaNaoTomada(f.dose),
    dose_revertida: (f) => linhaDosesRevertidas(f),         // { doses }
    estoque_atualizado: (f) => buildEstoqueAtualizadoMessage(f),
    alerta_estoque: (f) => f.contexto === 'pos_ajuste'
        ? buildAlertaEstoquePosAjuste(f.statusInfo)
        : buildAlertaEstoquePosConfirmacao(f.estoqueInfo),
    convite_estoque: (f) => f.motivo === 'estoque_contestado'
        ? buildConviteEstoqueContestado({ medNome: f.medNome })
        : buildConviteEstoqueNaoCadastrado(f.estoqueInfo)
};

// Fato fora do catálogo é erro de programação, nunca condição de runtime
// silenciosa — quem chama conhece o tipo por construção.
export function renderizarCanonico(tipo, fato) {
    const fn = CATALOGO[tipo];
    if (!fn) throw new Error(`Fato sem renderização canônica no catálogo: ${tipo}`);
    return fn(fato || {});
}

export const FATOS_CATALOGADOS = Object.keys(CATALOGO);
