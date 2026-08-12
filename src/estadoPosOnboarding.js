// ============================================================
// DECISÃO DE ESTADO PÓS-ONBOARDING (MH-072 Parte A)
// Extraído de recepcionista.js (bloco if (lgpdAccepted), v3-v29) para ponto nomeado
// único, chamado agora só por data_nascimento.js ao fechar a coleta de nascimento.
//
// O querCadastrar embutido aqui é uma lista de palavras-chave — mesma família do
// pareceNome() (princípio 14: classificação semântica central, nunca lista de
// exclusão/inclusão de palavras). "Quero começar", "vamos lá", "pode ser" não estão
// na lista e caem no post_onboarding errado. Isolar num ponto nomeado tira a
// heurística de dentro do handler e deixa o alvo visível para a Parte B, onde as
// listas de palavras do onboarding são substituídas por classificação semântica.
// Alvo declarado da Parte B, junto com pareceNome().
// ============================================================

import { saveConversationState } from './database.js';

export async function definirEstadoPosOnboarding(user, mensagemInicial) {
    const msg = (mensagemInicial || '').toLowerCase();
    const querCadastrar = [
        'cadastrar', 'remédio', 'remedios', 'remedio', 'medicamento',
        'registrar', 'me ajuda', 'ajuda'
    ].some(t => msg.includes(t));

    if (querCadastrar) {
        await saveConversationState(user.id, {
            state: 'adding_med',
            context: { etapa: 'cad_nome' }
        });
        console.log(`✅ Pós-onboarding: roteando para cadastro (${user.phone})`);
    } else {
        await saveConversationState(user.id, { state: 'post_onboarding', context: {} });
        console.log(`✅ Pós-onboarding: aguardando intenção (${user.phone})`);
    }
}
