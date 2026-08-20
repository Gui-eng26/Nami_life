// Escritas de backlog do encerramento v34 (briefings/BRIEFING_MH073_PARTEB.md, seção 13) —
// executado uma vez, via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v34';
const DATA = '2026-08-19';

async function main() {
    // a) MH-073 Parte B -> em_validacao (implementação concluída nesta sessão)
    const mh073b = await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 73, parte: 'B',
        novoStatus: 'em_validacao',
        sessaoFechamento: SESSAO,
        dataFechamento: DATA,
        notas: 'cad_forma removida; classificador único de posologia (classificarPosologia) '
            + 'introduzido para cad_horarios/cad_quantidade_por_dose/cad_confirma_forma; '
            + 'derivarUnidades/derivarFormaFarmaceutica/montarParesPosologia adicionadas; '
            + 'cadastro.js:409-431 corrigido para usar converterDoseParaEstoque em vez de dividir '
            + 'por número de horários; saveMedication passa a aceitar unidade_dose/unidade_estoque/'
            + 'gotas_por_ml; processarAcao grava quantidade_por_dose por horário. Pendente: '
            + 'validação em produção (cenários da seção 12 do briefing).'
    });
    console.log(`✅ MH-73 Parte ${mh073b.parte} -> ${mh073b.status}`);

    // b) Abrir MH-073 Parte B.1 — autorizado explicitamente por Guilherme nesta sessão
    const parteB1 = await registrarItemBacklog({
        tipo: 'MH', numero: 73, parte: 'B.1',
        titulo: 'Blindagem de becos sem saida no cadastro.js — escalada ao roteador via ponto unico de despacho',
        descricao: 'handleCadastro nunca retorna {escalarParaRoteador:true} — router.js o chama de '
            + '8 pontos (linhas 549, 715, 786, 873, 965, 978, 990, 1046) sem nenhuma escalada '
            + 'instrumentada. Mesmo trabalho que a v18 fez em configuracao.js, com o risco '
            + 'conhecido do BUG-069 (1 de 6 call sites esquecido) e exigindo ponto único de '
            + 'despacho (princípio 30). Deliberadamente separada da Parte B: riscos de regressão '
            + 'de natureza diferente (schema/persistência × roteamento) — misturar torna '
            + 'impossível saber qual causou um defeito na validação.',
        status: 'aberto',
        prioridade: 'alta',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-73 Parte ${parteB1.parte} criada (${parteB1.status})`);

    console.log('✅ Escritas de backlog do encerramento v34 concluídas.');
}

main().catch(e => {
    console.error('❌ Falha nas escritas de backlog:', e.message);
    process.exit(1);
});
