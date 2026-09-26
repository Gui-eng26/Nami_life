// ============================================================
// v45 P1 — registros de backlog do §12 (26/09/2026, "pode registrar"
// de Guilherme). As correções dos três BUGs estão em staging (P1) mas
// não promovidas: nascem 'aberto' e viram 'resolvido' no encerramento
// do P1. Escritas exclusivamente via src/backlog.js (padrão técnico nº 7).
// ============================================================

import { registrarItemBacklog } from '../src/backlog.js';

const HOJE = '2026-09-26';
const SESSAO = 'v45';

async function main() {
    await registrarItemBacklog({
        tipo: 'BUG', numero: 105,
        titulo: 'Confirmação de dose por lista de palavras engole mensagens com conteúdo adicional',
        descricao: 'Os atalhos de dose testavam se a mensagem CONTINHA "sim"/"tomei" e confirmavam a dose mais '
            + 'recente sem ler o resto. Casos: João 26/09 ("Ontem eu tomei" confirmou a dose de hoje), Flávia '
            + '24/09 ("Comprei 60 comprimidos / Sim" confirmou a dose e perdeu a compra), Julia 11/07 ("já tomei '
            + 'o Elani e já providenciei mais" perdeu a recompra). Nas 140 respostas que passaram pelos atalhos, '
            + 'os 3 erros foram exatamente as mensagens que continham a palavra e mais alguma coisa.',
        causaRaiz: 'detectarConfirmacaoDose decidia por substring antes de qualquer interpretação. '
            + 'Correção no v45 P1: atalho só com mensagem IDÊNTICA à lista (quatro guardas); o resto vai ao principal.',
        status: 'aberto', prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ BUG-105 criado → aberto (atalho de dose por lista engole conteúdo adicional)');

    await registrarItemBacklog({
        tipo: 'BUG', numero: 106,
        titulo: '"Yes" com dose aberta não é confirmado: o principal não recebia o lembrete nem a citação',
        descricao: 'João 24/09 08:43: "Yes" com a dose de hoje recém-esgotada → "não há dose pendente". '
            + 'Guilherme 26/09 13:21 e 13:25: "Yes" (a segunda citando o lembrete) durante cad_estoque → a Nami '
            + 'repetiu a pergunta de estoque e a dose ficou aberta.',
        causaRaiz: '"Yes" fora da lista dos atalhos; o principal era chamado sem o lembrete, sem a mensagem citada e '
            + 'com três blocos de dose de sentido sobreposto; a regra S1 do despacho jogava "principal" para o fluxo '
            + 'de cadastro aberto. Correção no v45 P1: bloco único de doses com o último lembrete e o grupo citado; '
            + 'S1–S4 removidas.',
        status: 'aberto', prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ BUG-106 criado → aberto ("Yes" com dose aberta não confirmado)');

    await registrarItemBacklog({
        tipo: 'BUG', numero: 107,
        titulo: 'Pedido de novo cadastro durante o convite de estoque vira continuação da coleta',
        descricao: 'Fran 24/09 07:03 ("Cadastrar medicamento semanal") e 19:56 ("Quero cadastrar mais um!"), e o '
            + 'caso do Sid: a Nami repetiu o convite de estoque do medicamento anterior e o pedido se perdeu.',
        causaRaiz: 'A escalada do cadastro tratava "cadastro sem medicamento diferente nomeado" como continuação do '
            + 'fluxo. Correção no v45 P1: o principal diz a relação com a pendência (responde/novo); "novo" abre '
            + 'cadastro novo mesmo sem nome, fechando o anterior pela verdade do banco.',
        status: 'aberto', prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ BUG-107 criado → aberto (novo cadastro durante o convite de estoque)');

    await registrarItemBacklog({
        tipo: 'ACH', numero: 13,
        titulo: 'Doses sem_estoque com confirmação do usuário distorcem a métrica de doses perdidas por falta de estoque',
        descricao: 'Achado do P1. O scheduler grava sem_estoque quando estoque_atual <= 0, e o lembrete diz que não pode '
            + 'registrar a dose — mas a pessoa pode ter o remédio (estoque do sistema errado). Eloísa respondeu "Sim" '
            + 'aos 4 avisos de 4 dias (CONTEXT §13.5): as 4 doses contaram como perdidas por falta de estoque. Com o '
            + 'P1, confirmar uma dose com estoque <= 0 torna o estoque desconhecido (movimento estoque_contestado). '
            + 'O histórico anterior segue contaminado: qualquer análise de "doses perdidas por falta de estoque" '
            + 'precisa descontar as sem_estoque com resposta afirmativa do usuário.',
        status: 'aberto', prioridade: 'media',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ ACH-13 criado → aberto (sem_estoque confirmado distorce a métrica)');
}

main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
