import { classificarNivelEstoquePorDias } from '../database.js';
import { verboDoMedicamento } from './verbos.js';
import { rotuloEstoquePlural, quantosDoRotulo, formatarQuantidadeDose } from './dose.js';

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

// v47 Onda 1 §2 (BUG-114 camada b): renomeada — este envio é a COBRANÇA
// ENCERRADA da dose (as 3 tentativas se esgotaram), não um alerta de estoque;
// o rótulo antigo ("alerta de estoque não informado") dava o quadro
// interpretativo errado. Texto byte-idêntico ao anterior (equivalência
// estrita, guardada pelo A63 — mover o template de casa é onda 3).
export function buildCobrancaEncerrada(firstName, info) {
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
// v45 P1-ajustes 2 §2: formato da confirmação de dose — a LINHA do fato, sem
// abertura (quem abre a mensagem é o router, uma vez só no turno) e com o
// rótulo da forma do remédio ("comprimidos", "gotas"…), nunca "unidades" para
// comprimido.
export function rotuloEstoque(quantidade, { unidade_estoque, forma_farmaceutica } = {}) {
    if (Number(quantidade) === 1) {
        const singular = formatarQuantidadeDose({
            quantidade: 1, unidade_dose: unidade_estoque === 'ml' ? 'ml' : 'unidade', forma_farmaceutica
        });
        if (singular) return singular.replace(/^1 /, '');
    }
    return rotuloEstoquePlural({ unidade_estoque, forma_farmaceutica });
}

export function buildEstoqueAtualizadoMessage({ medNome, estoqueAnterior, estoqueNovo, deltaAplicado,
                                               quantidadeSolicitada, unidadeEstoque, medForma }) {
    const numero = String(estoqueNovo).replace('.', ',');
    const rotulo = rotuloEstoque(estoqueNovo, { unidade_estoque: unidadeEstoque, forma_farmaceutica: medForma });
    let msg = `📦 Estoque do *${medNome}* atualizado: *${numero}* ${rotulo}.`;

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
// v45 P1-copy §7: a confirmação do turno CONTESTOU um estoque <= 0 (a palavra
// da pessoa prevaleceu e o estoque ficou em aberto). Nos dias seguintes, com o
// estoque já nulo, volta o convite comum (buildConviteEstoqueNaoCadastrado).
export function buildConviteEstoqueContestado({ medNome }) {
    return (
        `\n\n📦 Pelo que eu tinha anotado, o *${medNome}* tinha acabado — então deixei o estoque em aberto. ` +
        `Se souber quantos você tem em casa, me conta que eu volto a te avisar quando estiver acabando.`
    );
}

export function buildConviteEstoqueNaoCadastrado({ medNome, medForma, unidadeEstoque }) {
    const rotulo = rotuloEstoquePlural({ unidade_estoque: unidadeEstoque, forma_farmaceutica: medForma });
    // v44 (replay 19/09, Constituição regra 1): convite, nunca ordem — com a porta
    // de saída implícita ("se souber").
    return (
        `\n\n📦 Ainda não tenho o estoque do *${medNome}* cadastrado.\n` +
        `Se souber ${quantosDoRotulo(rotulo)} você tem em casa, é só me falar — eu anoto e te aviso ` +
        `quando estiver acabando, pra você comprar antes de ficar sem.`
    );
}
