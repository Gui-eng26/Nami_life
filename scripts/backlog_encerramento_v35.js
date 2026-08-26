// Escritas de backlog do encerramento v35 (briefings/encerramento_v35.md, Tarefa 2) —
// executado uma vez, via src/backlog.js (único ponto de escrita em backlog_items, princípio 16).
import { registrarItemBacklog, atualizarStatusBacklogItem } from '../src/backlog.js';

const SESSAO = 'v35';
const DATA = '2026-08-26';

async function main() {
    // 2.1 — MH-073 Parte B.1 -> em_validacao, notas de validação em produção
    const mh073b1 = await atualizarStatusBacklogItem({
        tipo: 'MH', numero: 73, parte: 'B.1',
        novoStatus: 'em_validacao',
        sessaoFechamento: SESSAO,
        dataFechamento: DATA,
        notas: 'Implementada e validada em produção em 26/08/2026 (duas baterias). PENDENTE: ramos '
            + "'recusa' e 'duvida' do classificarIndeterminadoCadastro não exercitados em produção "
            + '(contagem nos logs: nova_intencao 4, ruido 3, recusa 0, duvida 0). PENDENTE: reentrada '
            + 'cadastro->cadastro não reproduzível sob demanda — exige discordância entre o '
            + "classificador de falha e o classificador central, e a delimitação estreita de "
            + "nova_intencao fechou os caminhos naturais. Ramo mantido como rede de proteção; "
            + 'revisitar quando MH-84 for implementado.'
    });
    console.log(`✅ MH-73 Parte ${mh073b1.parte} -> ${mh073b1.status}`);

    // 2.2 — BUG-101 (já inserido com status=em_validacao) — acrescentar notas de validação
    const bug101 = await atualizarStatusBacklogItem({
        tipo: 'BUG', numero: 101,
        novoStatus: 'em_validacao',
        sessaoFechamento: SESSAO,
        dataFechamento: DATA,
        notas: 'Validado em produção 26/08/2026: 5 chamadas ao classificador central em 4 escaladas '
            + '+ 1 roteamento normal, nenhuma duplicata. Escalada cad_horarios->relatorios preservou '
            + "subtipoRelatorio='meus_remedios' e params, provando a propagação do objeto inteiro. "
            + 'Não-regressão do caminho antigo confirmada: escalada de configuracao(identif_schedule)'
            + '->cadastro funcionou normalmente. PENDENTE: cenário 5 (escalada a partir de '
            + 'coletando_nascimento) não testado — exige número de usuário novo.'
    });
    console.log(`✅ BUG-101 -> ${bug101.status}`);

    // 2.3 — Novo achado: ACH-6
    const ach6 = await registrarItemBacklog({
        tipo: 'ACH', numero: 6, parte: '',
        titulo: "despacharEscalada passa currentState: 'configurando' fixo, independente do agente de origem",
        descricao: "router.js — despacharEscalada chama classificarIntencaoComContexto com currentState "
            + "hardcoded como 'configurando'. A string entra no prompt do classificador central (linha "
            + '"ESTADO ATUAL: ${currentState}") e não é lida por nenhum if em código — não altera nenhuma '
            + 'decisão determinística. Quando a escalada vem de data_nascimento (desde a v30) o valor é '
            + 'falso. Efeito: pode enviesar o classificador a favor de configuracao em mensagens '
            + 'AMBÍGUAS; mensagens auto-suficientes são resolvidas pelo texto e não sofrem. ORIGEM: a '
            + 'função nasceu na v18 servindo só ao configuracao.js, onde o valor era sempre verdadeiro; '
            + 'ganhou um segundo chamador na v30 e a linha nunca foi revisitada. HIPÓTESE NÃO MEDIDA — '
            + 'nenhuma ocorrência de dano registrada, e não mensurável hoje porque escalada não deixa '
            + 'rastro em agent_logs (ver MH-48). Menção original em MH-65 (superseded) e como '
            + 'complicação declarada no BUG-86. A MH-073 Parte B.1 NÃO alterou esta linha: '
            + 'despacharCadastro passa o currentState real por conta própria. O BUG-101 REDUZIU a '
            + 'exposição — escaladas vindas do cadastro deixaram de reclassificar, portanto deixaram de '
            + 'passar pelo estado falso.',
        status: 'aberto',
        prioridade: 'baixa',
        relacionado: 'BUG-86',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ ACH-${ach6.numero} criada (${ach6.status})`);

    // 2.4 — Novo item: MH-84
    const mh84 = await registrarItemBacklog({
        tipo: 'MH', numero: 84, parte: '',
        titulo: 'Trocar de medicamento no meio do cadastro mantém dosagem, horários e estoque do anterior',
        descricao: "Em cad_confirmacao, o case 'nome' de calcularDecisaoEtapa devolve { proximaEtapa: "
            + "'cad_nome', contextUpdates: {} } — volta a perguntar o nome mas NÃO limpa dosagem, "
            + 'horarios, pares_posologia, unidade_dose, unidade_estoque, gotas_por_ml, tipo_tratamento '
            + 'nem estoque_resolvido do medicamento anterior. Se o usuário trocar de remédio ali, o '
            + 'cadastro segue com os dados do remédio errado. Fora de cad_confirmacao (cad_dosagem, '
            + 'cad_horarios etc.) não existe nem o caminho de correção de nome — a frase cai em '
            + 'indeterminado e a etapa repete a pergunta. CAUSA RAIZ CONFIRMADA por leitura de código '
            + '(v35). MANIFESTAÇÃO OBSERVADA em produção 26/08 18:16: em cad_dosagem, "Não é esse '
            + 'remédio, é outro" e em seguida "Toragesic" caíram ambos em ruido e a etapa repetiu a '
            + 'pergunta. DECISÃO DE GUILHERME NA v35: NÃO corrigir agora — o cadastro funciona bem e um '
            + 'reset mal delimitado arriscaria desfazer a captação de dados construída nas Partes '
            + 'B/B.2/B.3. Por isso a Parte B.1 classifica deliberadamente "não é esse remédio, é outro" '
            + 'como ruido, nunca como nova_intencao (seção 3.4 de BRIEFING_MH073_B1.md). Ao implementar '
            + 'este MH, revisar essa classificação junto e revisitar o cenário de reentrada '
            + 'cadastro->cadastro, que passa a ser alcançável.',
        status: 'aberto',
        prioridade: 'media',
        relacionado: 'MH-073',
        sessaoCriacao: SESSAO,
        dataCriacao: DATA
    });
    console.log(`✅ MH-${mh84.numero} criada (${mh84.status})`);

    console.log('✅ Escritas de backlog do encerramento v35 concluídas.');
}

main().catch(e => {
    console.error('❌ Falha nas escritas de backlog:', e.message);
    process.exit(1);
});
