import { classificarNivelEstoquePorDias } from '../database.js';

// ============================================================
// TEMPLATES DETERMINÍSTICOS — ALERTA DE ESTOQUE PÓS-CONFIRMAÇÃO
// BRIEFING_BUG065.md — nunca afirmar "zerado" quando novoEstoque > 0,
// mesmo que diasRestantes === 0 (dosesPerDia >= 2).
// ============================================================

export function buildAlertaEstoquePosConfirmacao(info) {
    const { medNome, novoEstoque, diasRestantes } = info;
    const nivel = classificarNivelEstoquePorDias({ novoEstoque, diasRestantes });
    const unidade = novoEstoque === 1 ? 'unidade' : 'unidades';

    if (nivel === 'zerado') {
        return (
            `\n\n⚠️ *Atenção:* você acabou de tomar o último comprimido do *${medNome}* disponível. ` +
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
    const { medNome, novoEstoque, diasRestantes } = info;
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
        `Quando puder, me avise se tomou, e não esqueça de providenciar a recompra! 💊`
    );
}
