// Escritas de backlog da seção 11 do BRIEFING_MH072_PARTEA.md — executado uma vez,
// via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v30';
const DATA = '2026-08-11';

async function main() {
    await registrarItemBacklog({
        tipo: 'MH', numero: 72, parte: 'A',
        titulo: 'Coleta de data de nascimento no onboarding',
        descricao: 'Coletar data de nascimento de todo novo usuário no onboarding, logo após o aceite '
            + 'da LGPD e antes do cadastro de medicamento — users.data_nascimento. Finalidade: idade '
            + 'média agregada do público da Nami, sem personalização por idade. Novo módulo determinístico '
            + 'src/dataNascimento.js (extração + validação) e novo agente src/agentes/data_nascimento.js '
            + '(estado coletando_nascimento). Ver briefings/BRIEFING_MH072_PARTEA.md.',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'MH', numero: 72, parte: 'B',
        titulo: 'Recepcionista: separar classificação de geração',
        descricao: 'pareceNome() e a pergunta dupla do recepcionista (junto com BUG-030 e MH-074) — '
            + 'substituir listas de palavras-chave do onboarding (pareceNome, querCadastrar/'
            + 'definirEstadoPosOnboarding) por classificação semântica central, seguindo o princípio 14.',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'MH', numero: 73,
        titulo: 'Gestão de medicamento em gotas',
        descricao: 'Achado durante a sessão v30 (MH-072 Parte A) — registrado para sessão futura.',
        status: 'aberto',
        prioridade: 'alta',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'MH', numero: 74,
        titulo: 'Pergunta funcional não exige nome nem LGPD',
        descricao: 'Achado durante a sessão v30 (MH-072 Parte A) — relacionado a MH-072 Parte B.',
        status: 'aberto',
        prioridade: 'alta',
        relacionado: 'MH-072 Parte B',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await registrarItemBacklog({
        tipo: 'MH', numero: 75,
        titulo: 'Editar dados cadastrais após o onboarding (nome e data de nascimento)',
        descricao: 'Fecha a lacuna documentada na seção 9 do BRIEFING_MH072_PARTEA.md: depois que o '
            + 'estado sai de coletando_nascimento, não há como corrigir data de nascimento (nem nome). '
            + 'Exige entrada no inventário do classificador do router.js no mesmo commit em que for '
            + 'implementado (princípio 21). Também é o caminho de remediação para usuários gravados com '
            + 'nome incorreto pelo BUG-030.',
        status: 'aberto',
        prioridade: 'media',
        relacionado: 'MH-072',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 9,
        novoStatus: 'aberto',
        prioridade: 'alta',
        notas: 'Prioridade elevada para alta na sessão v30 (MH-072 Parte A).'
    });

    await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 40,
        novoStatus: 'aberto',
        prioridade: 'alta',
        notas: 'Prioridade elevada para alta na sessão v30 (MH-072 Parte A).'
    });

    await atualizarStatusBacklogItem({
        tipo: 'BUG', numero: 30,
        novoStatus: 'aberto',
        prioridade: 'alta',
        relacionado: 'MH-072 Parte B',
        notas: 'Vinculado a MH-072 Parte B na sessão v30. Permanece aberto — a Parte A não o resolve.'
    });

    console.log('✅ Escritas de backlog da seção 11 concluídas.');
}

main().catch(e => {
    console.error('❌ Falha nas escritas de backlog:', e.message);
    process.exit(1);
});
