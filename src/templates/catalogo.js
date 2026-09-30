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
import { respostaRecusaAudio, respostaErroTecnico } from '../inventario.js';

// v47 Onda 3: renderizador cuja casa importa ESTE módulo (ex.: reperguntaSegura
// no router) registra-se aqui no load — o índice aponta sem criar ciclo.
const TARDIOS = {};
export function registrarRenderizadorTardio(tipo, fn) {
    TARDIOS[tipo] = fn;
}

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
        : buildConviteEstoqueNaoCadastrado(f.estoqueInfo),

    // --- Jornada (v47 Onda 3 §1) — entradas canônicas sem ciclo de import ---
    recusa_audio: () => respostaRecusaAudio(),
    erro_global: () => respostaErroTecnico(),
    degradado: (f) => {
        if (!TARDIOS.degradado) throw new Error('renderizador tardio "degradado" não registrado (router.js o registra no load)');
        return TARDIOS.degradado(f?.user ?? null);
    }
};

// ------------------------------------------------------------
// v47 Onda 3 §1 — ÍNDICE DA JORNADA: fatos cujo renderizador PERMANECE na
// casa de origem (a coesão manda — ex.: campo↔pergunta↔validador no schema,
// grep-guard M2 §8.2 em vigor). O catálogo unifica o LOOKUP e a autoria
// registrada; não força mudança de casa. `entrada: 'indice'` = apontador
// (não chamável por renderizarCanonico); os fluxos seguem chamando a casa.
// ------------------------------------------------------------
export const INDICE_DA_JORNADA = {
    pergunta_coleta: {
        casa: 'schemas/cadastro.js (renderizarPergunta*; montagem em runner.js: montarPerguntaPendente/repetirPergunta)',
        entrada: 'indice',
        nota: 'coesão campo↔pergunta↔validador fica no schema — sub-catálogo da coleta'
    },
    pergunta_onboarding: { casa: 'schemas/onboarding.js', entrada: 'indice' },
    pergunta_nascimento: { casa: 'schemas/onboarding.js (etapa onb_nascimento; parsing em dataNascimento.js)', entrada: 'indice' },
    boas_vindas: { casa: 'schemas/onboarding.js', entrada: 'indice', nota: 'redação-LLM com regras — sem canônico fixo' },
    dialogo_exclusao: { casa: 'agentes/exclusaoConta.js', entrada: 'indice' },
    nao_suportado: { casa: 'inventario.js (base) + router.js (composição do turno)', entrada: 'indice' },
    nunca: { casa: 'inventario.js (fronteira NUNCA)', entrada: 'indice', nota: 'redação-LLM: a postura é escrita pelo principal, a fronteira é a lista' },
    recusa_audio: { casa: 'inventario.js', entrada: 'canonico' },
    erro_global: { casa: 'inventario.js', entrada: 'canonico' },
    degradado: { casa: 'router.js (reperguntaSegura, registrada tardia)', entrada: 'canonico' },
    configuracao: { casa: 'agentes/configuracao.js', entrada: 'DIVIDA_ETAPA_3', nota: 'fora do catálogo até a reconstrução em runner+schema (Etapa 3)' }
};

// Fato fora do catálogo é erro de programação, nunca condição de runtime
// silenciosa — quem chama conhece o tipo por construção.
export function renderizarCanonico(tipo, fato) {
    const fn = CATALOGO[tipo];
    if (!fn) throw new Error(`Fato sem renderização canônica no catálogo: ${tipo}`);
    return fn(fato || {});
}

export const FATOS_CATALOGADOS = Object.keys(CATALOGO);
