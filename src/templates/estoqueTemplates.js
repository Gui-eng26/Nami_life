import { classificarNivelEstoquePorDias } from '../database.js';
import { verboDoMedicamento } from './verbos.js';
import { rotuloEstoquePlural } from './dose.js';

// ============================================================
// TEMPLATES DETERMINÍSTICOS — ALERTA DE ESTOQUE PÓS-CONFIRMAÇÃO
// BRIEFING_BUG065.md — nunca afirmar "zerado" quando novoEstoque > 0,
// mesmo que diasRestantes === 0 (dosesPerDia >= 2).
// ============================================================

export function buildAlertaEstoquePosConfirmacao(info) {
    const { medNome, medForma, novoEstoque, diasRestantes } = info;
    const nivel = classificarNivelEstoquePorDias({ novoEstoque, diasRestantes });
    const unidade = novoEstoque === 1 ? 'unidade' : 'unidades';
    const verbo = verboDoMedicamento(medForma);

    if (nivel === 'zerado') {
        return (
            `\n\n⚠️ *Atenção:* você acabou de ${verbo.infinitivo} a última dose do *${medNome}* disponível. ` +
            `Não esqueça de providenciar a recompra!\n` +
            `Quando comprar, me avise: *"Comprei 30 comprimidos de ${medNome}"* 💊`
        );
    }

    if (nivel === 'urgente') {
        return (
            `\n\n🚨 *Atenção:* você tem mais *${novoEstoque}* ${unidade} do *${medNome}*, e com esse estoque ` +
            `você NÃO consegue fechar mais um dia completo de tratamento. Como a recompra é urgente, que tal ` +
            `reservar alguns minutos pra ir até a farmácia mais próxima ou pedir entrega ainda hoje? ` +
            `Não podemos descuidar da sua saúde! 💊`
        );
    }

    const prazo = diasRestantes === 1 ? 'apenas mais *1 dia*' : `mais *${diasRestantes} dias*`;
    return (
        `\n\n⚠️ *Lembrete de estoque:* você tem *${novoEstoque}* ${unidade} do *${medNome}*, o que te garante ` +
        `${prazo} de tratamento. Assim que fizer a recompra, me avise aqui com a quantidade para eu atualizar ` +
        `seu estoque! 💊`
    );
}

export function buildAlertaEstoqueNaoInformado(firstName, info) {
    const { medNome, medForma, novoEstoque, diasRestantes, estoqueDesconhecido } = info;
    const verbo = verboDoMedicamento(medForma);

    // v43 Bloco C Adendo 1 (P49, seção 4): estoque nunca informado — a mensagem de
    // dose não confirmada continua, mas SEM citar quantidade nenhuma (nem "null", nem
    // um número inventado). O convite para informar o estoque não entra aqui — ele
    // vive só no caminho da confirmação de dose (buildConviteEstoqueNaoCadastrado).
    if (estoqueDesconhecido) {
        return (
            `⚠️ ${firstName}, não recebi confirmação da sua dose do *${medNome}*.\n\n` +
            `Quando puder, me avise se ${verbo.passado}! 💊`
        );
    }

    const nivel = classificarNivelEstoquePorDias({ novoEstoque, diasRestantes });
    const unidade = novoEstoque === 1 ? 'unidade' : 'unidades';

    const prazo = nivel === 'zerado'
        ? 'está esgotado'
        : nivel === 'urgente'
            ? 'não é suficiente para fechar mais um dia de tratamento'
            : (diasRestantes === 1 ? 'dura mais 1 dia' : `dura mais ${diasRestantes} dias`);

    return (
        `⚠️ ${firstName}, não recebi confirmação da sua dose do *${medNome}*.\n\n` +
        `Seu estoque atual é de *${novoEstoque}* ${unidade} — ${prazo}.\n` +
        `Quando puder, me avise se ${verbo.passado}, e não esqueça de providenciar a recompra! 💊`
    );
}

// v44 §5.7 — movidos de principal.js para cá: autor único de texto de estoque é
// este módulo (P30). Alerta de limiar pós-ajuste manual (MH-042) — mesmo
// crítico/baixo/ok de relatorioEstoque, sem segundo mecanismo.
export function buildAlertaEstoquePosAjuste(info) {
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

// v44 §5.7 — movido de principal.js. Informativo determinístico pós-ajuste manual
// de estoque (complemento MH-042): o único número comunicado depois de UPDATE_STOCK
// vem daqui, montado da leitura pós-escrita, nunca do texto do LLM.
export function buildEstoqueAtualizadoMessage({ medNome, estoqueAnterior, estoqueNovo, deltaAplicado, quantidadeSolicitada }) {
    let msg = `\n\n📦 Estoque atualizado! Seu novo estoque de *${medNome}* é *${estoqueNovo}* ${estoqueNovo === 1 ? 'unidade' : 'unidades'}.`;

    // Se o que foi de fato aplicado é menor (em módulo) do que o solicitado, o clamp em 0 entrou em ação —
    // só é detectável comparando o delta pedido com o delta realmente aplicado.
    if (quantidadeSolicitada != null && Math.abs(deltaAplicado) < quantidadeSolicitada) {
        msg += ` (Você tinha ${estoqueAnterior} — como o estoque não pode ficar negativo, o ajuste foi ` +
               `limitado a ${estoqueAnterior}, não aos ${quantidadeSolicitada} informados.)`;
    }

    return msg;
}

// v43 Bloco C Adendo 1 (seção 2) — estoque nunca informado (MH-094 / P49). NÃO é
// alerta de falta: a Nami não sabe quanto existe, então não afirma nada sobre a
// quantidade. É um convite a completar o cadastro, com o benefício explícito.
export function buildConviteEstoqueNaoCadastrado({ medNome, medForma, unidadeEstoque }) {
    const rotulo = rotuloEstoquePlural({ unidade_estoque: unidadeEstoque, forma_farmaceutica: medForma });
    return (
        `\n\n📦 Ainda não tenho o estoque do *${medNome}* cadastrado.\n` +
        `Me diz quantos ${rotulo} você tem em casa e eu te aviso quando estiver acabando, ` +
        `pra você comprar antes de ficar sem.`
    );
}
