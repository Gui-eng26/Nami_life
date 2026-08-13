// Escritas de backlog da seção 7 do BRIEFING_MH072_PB0.md — executado uma vez,
// via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v31';
const DATA = '2026-08-13';

async function main() {
    await registrarItemBacklog({
        tipo: 'BUG', numero: 88,
        titulo: "Recusa de consentimento LGPD gravada como aceite (keyword 's' em includes)",
        descricao: 'isLgpdAccepted() em src/agentes/recepcionista.js testava a keyword "s" com '
            + 'includes() sobre a mensagem inteira — casava com qualquer palavra contendo a letra '
            + '"s" (ex: "pa*s*sar" em "prefiro nao passar os dados"), gravando lgpd_accepted=true '
            + 'para uma recusa explícita. contemRecusa() existia e teria detectado a recusa, mas '
            + 'era inalcançável (curto-circuitada por lgpdAccepted já ter retornado true). Corrigido '
            + 'na forma definitiva do item 6 da Parte B (MH-072): classificarConsentimentoLgpd(), '
            + 'classificador semântico único com categoria fechada (aceite|recusa|duvida|'
            + 'indeterminado), remove a duplicidade de julgamento entre o classificador léxico e a '
            + 'LLM geradora de texto. Ver briefings/BRIEFING_MH072_PB0.md.',
        causaRaiz: 'Lista de keywords testada com String.includes() — antipadrão do princípio 14 '
            + '(classificação lexical em vez de semântica); agravado por dois julgamentos '
            + 'independentes sobre a mesma mensagem sem ponto de reconciliação.',
        status: 'em_validacao',
        prioridade: 'alta',
        relacionado: 'MH-072',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });

    console.log('✅ BUG-88 registrado em backlog_items (status: em_validacao).');
}

main().catch(e => {
    console.error('❌ Falha na escrita de backlog:', e.message);
    process.exit(1);
});
