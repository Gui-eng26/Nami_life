// ============================================================
// v45 P1-ajustes — registros de backlog do §8 (27/09/2026, "sim, registra"
// de Guilherme). As correções dos dois BUGs estão em staging (64af505) mas
// não promovidas: nascem 'aberto' e viram 'resolvido' na promoção do P1.
// Escritas exclusivamente via src/backlog.js (padrão técnico nº 7).
// ============================================================

import { registrarItemBacklog } from '../src/backlog.js';

const HOJE = '2026-09-27';
const SESSAO = 'v45';

async function main() {
    await registrarItemBacklog({
        tipo: 'BUG', numero: 109,
        titulo: 'Estoque gravado duas vezes quando o principal age e delega sobre o mesmo convite de estoque',
        descricao: 'Staging 26/09 23:15: "Juvix 10, Sonex 30" com o convite de estoque do lote aberto. O principal '
            + 'devolveu delegar cadastro/responde E UPDATE_STOCK, UPDATE_STOCK: as ações gravaram (correcao_set) e o '
            + 'runner gravou de novo (cadastro_inicial) — quatro movimentos para dois fatos e três blocos de texto com '
            + 'o mesmo número. Mesma família em produção (Fran 26/09 22:27, Evandro 26/09 18:14): o principal escreveu '
            + '"Anotado! Vou registrar…" e o sistema acrescentou "📦 Estoque atualizado!".',
        causaRaiz: 'Dois autores para o mesmo fato: nada impedia o principal de executar UPDATE_STOCK ao delegar a '
            + 'resposta do convite ao especialista, e o prompt pedia que a message narrasse a gravação. Correção no v45 '
            + 'P1-ajustes §1: UPDATE_STOCK descartado pelo código nesse caso; com UPDATE_STOCK do próprio principal, a '
            + 'message não repete o número nem narra a gravação.',
        status: 'aberto', prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ BUG-109 criado → aberto (estoque gravado duas vezes)');

    await registrarItemBacklog({
        tipo: 'BUG', numero: 110,
        titulo: 'Pedido claro fora das listas do inventário vira "não entendi"',
        descricao: 'Evandro 27/09 17:00: "Posso alterar a dose do Marevan para dias alternados?" → porta: configuracao → '
            + 'configuração: nao_suportado (classificação certa) → devolveu o turno → configuracao de novo → '
            + 'nao_suportado de novo → escalada dupla → "desculpa, não consegui te entender direito".',
        causaRaiz: 'Só era "ainda não" o que estava escrito em AINDA_NAO, e o especialista que não executa devolvia o '
            + 'turno em vez de dizer que não faz. Correção no v45 P1-ajustes §5: FAZ e NUNCA fechados, o resto é "ainda '
            + 'não" por padrão; a configuração retorna naoSuportado e o principal escreve o "ainda não" numa volta '
            + 'única; todo "ainda não" grava intencao_nao_suportada com o pedido.',
        status: 'aberto', prioridade: 'alta',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ BUG-110 criado → aberto (pedido claro vira "não entendi")');

    await registrarItemBacklog({
        tipo: 'MH', numero: 99,
        titulo: 'Alterar a frequência de um remédio já cadastrado (dias da semana, dia sim/dia não)',
        descricao: 'Hoje é "ainda não" (AINDA_NAO alterar_frequencia, escopo configuração — v45 P1-ajustes §6). O '
            + 'cadastro de um remédio NOVO com dias da semana ou dia sim/dia não já funciona (caminho unitário); falta '
            + 'a edição de um já cadastrado. Evidência: Evandro 27/09 (Marevan em dias alternados). Previsto para o P4.',
        causaRaiz: null,
        status: 'aberto', prioridade: 'media',
        sessaoCriacao: SESSAO, dataCriacao: HOJE
    });
    console.log('✅ MH-99 criado → aberto (alterar frequência de remédio já cadastrado)');
}

main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
