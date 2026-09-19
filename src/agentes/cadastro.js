import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import {
    saveConversationState,
    saveMedication,
    saveSchedule,
    replaceMedication,
    verificarMedicamentoExistente,
    getUserMedications,
    formatarHistoricoConversa,
    converterDoseParaEstoque,
    registrarMovimentoEstoque,
    atualizarMedicamentoCampos,
    getMedicationComSchedulesAtivos,
    encerrarTratamento
} from '../database.js';
import { degradar } from '../observabilidade.js';
import { GUIA_COMPOSICAO } from '../templates/composicao.js';
import { detectarRecorrenciaNaoSuportada, extrairHorariosCitados } from '../validadores/recorrencia.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// CÁLCULO DETERMINÍSTICO DE HORÁRIOS A PARTIR DE FREQUÊNCIA (BUG-041)
// ============================================================

function calcularHorariosPorIntervalo(horarioInicio, intervaloHoras) {
    if (!horarioInicio || !intervaloHoras || intervaloHoras <= 0) return [];

    const dosesPerDia = Math.round(24 / intervaloHoras);
    if (dosesPerDia < 1) return [];

    const [h, m] = horarioInicio.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return [];

    const horarios = [];
    let minutoAtual = h * 60 + m;

    for (let i = 0; i < dosesPerDia; i++) {
        const minutoNormalizado = ((minutoAtual % 1440) + 1440) % 1440;
        const hh = String(Math.floor(minutoNormalizado / 60)).padStart(2, '0');
        const mm = String(minutoNormalizado % 60).padStart(2, '0');
        horarios.push(`${hh}:${mm}`);
        minutoAtual += intervaloHoras * 60;
    }

    return horarios;
}

// ============================================================
// MH-073 Parte B — DERIVAÇÃO DETERMINÍSTICA (nenhuma chama LLM)
// ============================================================

const FORMAS_VALIDAS = new Set(['comprimido', 'capsula', 'colirio', 'gotas', 'pomada', 'injetavel', 'xarope']);
const UNIDADES_DOSE_VALIDAS = new Set(['unidade', 'gota', 'ml']);
const HORARIO_REGEX = /^\d{2}:\d{2}$/;

// BUG-99 (briefing Parte B.3, seção 4.2): as únicas formas coerentes com cada unidade
// de dose já resolvida. Usado para descartar PALPITES incompatíveis — nunca para
// descartar o que o usuário disse explicitamente (forma_explicita/forma_confirmada
// vindas de fala literal só são sinalizadas, nunca sobrescritas — ver validarClassificacaoPosologia).
const FORMAS_COMPATIVEIS = {
    unidade: new Set(['comprimido', 'capsula', 'pomada', 'injetavel']),
    gota: new Set(['colirio', 'gotas']),
    ml: new Set(['xarope', 'colirio', 'gotas'])
};

// Sem forma ou sem unidade ainda resolvida, não há o que checar — compatível por
// ausência de contradição. Ponto único usado tanto para sinalizar fala explícita
// incoerente (nunca descartada) quanto para filtrar palpite incoerente (descartado).
function formaCompativelComUnidade(forma, unidadeDose) {
    if (!forma || !unidadeDose) return true;
    const compativeis = FORMAS_COMPATIVEIS[unidadeDose];
    return !compativeis || compativeis.has(forma);
}

// unidade_dose é chave de comportamento (princípio 45) e tem CHECK no schema.
// Esta tabela é a ÚNICA fonte das outras duas colunas — nenhuma combinação
// inválida é representável, então os CHECKs de coerência da Parte A
// (medications_coerencia_unidades_check, medications_gotas_por_ml_exigido_check)
// são satisfeitos por construção, não por sorte.
function derivarUnidades(unidadeDose) {
    switch (unidadeDose) {
        case 'gota': return { unidade_dose: 'gota', unidade_estoque: 'ml', gotas_por_ml: 20 };
        case 'ml': return { unidade_dose: 'ml', unidade_estoque: 'ml', gotas_por_ml: null };
        default: return { unidade_dose: 'unidade', unidade_estoque: 'unidade', gotas_por_ml: null };
    }
}

// Ordem de confiança (princípio 17): o que o usuário disse literalmente >
// o que ele confirmou quando perguntado > rótulo genérico derivado da unidade.
// NUNCA retorna null e NUNCA retorna 'comprimido' por default — ver briefing MH-073 Parte B, seção 2.3.
const ROTULO_CANONICO = {
    comprimido: 'comprimido', capsula: 'cápsula', colirio: 'colírio',
    gotas: 'gotas', pomada: 'pomada', injetavel: 'injetável', xarope: 'xarope'
};
const ROTULO_GENERICO = { unidade: 'unidade', gota: 'gotas', ml: 'líquido' };

function derivarFormaFarmaceutica(formaExplicita, formaConfirmada, unidadeDose) {
    return ROTULO_CANONICO[formaExplicita]
        ?? ROTULO_CANONICO[formaConfirmada]
        ?? ROTULO_GENERICO[unidadeDose]
        ?? 'unidade';
}

// BUG-93: o rótulo da QUANTIDADE vem da unidade de dose (ml/gota) ou, para
// "unidade", da forma quando ela é contável (comprimido/cápsula) — nunca da
// forma farmacêutica em geral (colírio, pomada etc. não contam "colírios").
const ROTULO_DOSE = { ml: 'ml', gota: 'gota' };

function rotuloDaDose(unidadeDose, forma) {
    if (ROTULO_DOSE[unidadeDose]) return ROTULO_DOSE[unidadeDose];
    return ['comprimido', 'cápsula'].includes(forma) ? forma : 'unidade';
}

// Recebe a lista de horários e ou (a) uma quantidade única aplicada a todos, ou
// (b) o mapa de quantidades por horário. Devolve sempre [{horario, quantidade}]
// ordenado por horário, sem duplicatas de horário.
function montarParesPosologia(horarios, quantidadePorHorario) {
    const unicos = [...new Set((horarios || []).filter(h => HORARIO_REGEX.test(h)))];
    unicos.sort();

    if (Array.isArray(quantidadePorHorario)) {
        const mapa = new Map(quantidadePorHorario.map(p => [p.horario, p.quantidade]));
        return unicos.map(h => ({ horario: h, quantidade: Number(mapa.get(h)) || 1 }));
    }

    const quantidade = Number(quantidadePorHorario) || 1;
    return unicos.map(h => ({ horario: h, quantidade }));
}

// BUG-91: corrigir só os horários no resumo não pode descartar a quantidade já
// coletada. Quando a contagem de horários bate, remapeia as quantidades antigas
// (ordenadas) para os novos horários (ordenados). Quando não bate, é ambíguo —
// devolve null e o fluxo repergunta a quantidade (comportamento correto, não regressão).
function remapearParesParaNovosHorarios(paresAntigos, novosHorarios) {
    if (!paresAntigos?.length) return null;
    if (paresAntigos.length !== novosHorarios.length) return null;
    const ordenados = [...paresAntigos].sort((a, b) => a.horario.localeCompare(b.horario));
    return [...novosHorarios].sort().map((h, i) => ({ horario: h, quantidade: ordenados[i].quantidade }));
}

// BUG-98 (briefing Parte B.3, seção 4.1): quando a posologia já é derivada de um
// intervalo, corrigir o primeiro horário precisa RECALCULAR a grade inteira em código
// a partir do novo início — nunca aceitar uma lista de horários "recalculada" pelo LLM,
// que é exatamente o tipo de aritmética de dado de saúde que o LLM erra (BUG-94).
// Devolve null só quando o próprio cálculo determinístico falha (entrada inválida);
// quando o cálculo funciona mas o remapeamento de quantidades é ambíguo, `pares` vem
// null e `horarios` traz a grade nova mesmo assim — o chamador decide o que fazer.
function recalcularGradePorIntervalo(paresAntigos, horarioInicio, intervaloHoras) {
    const novosHorarios = calcularHorariosPorIntervalo(horarioInicio, intervaloHoras);
    if (novosHorarios.length === 0) return null;
    const pares = remapearParesParaNovosHorarios(paresAntigos, novosHorarios);
    return { horarios: novosHorarios, pares };
}

// Identifica qual horário da correção é o novo "início" do intervalo — NUNCA assume que
// é simplesmente o mais cedo em relógio. Dois formatos chegam aqui: um único horário
// (correção pontual em cad_confirma_forma, sem MODO CORREÇÃO) ou a lista completa que o
// MODO CORREÇÃO devolve em cad_confirmacao (os que mudaram + os que a pessoa não
// mencionou, mantidos como estavam). No segundo formato, só é seguro tratar como "troca
// do início" quando o início antigo (horarioInicioAntigo) SUMIU da lista corrigida e
// exatamente um horário genuinamente novo apareceu em troca — senão a correção é de
// outra dose (ex: "a das 20h passa pra 21h"), que quebraria a grade se fosse recalculada
// como se fosse um novo início. Nesses casos devolve null e o chamador cai no remapeamento
// simples, que já lida bem com esse caso (a contagem bate, a ordenação resolve sozinha).
function identificarNovoInicio(paresAntigos, novosPares, horarioInicioAntigo) {
    const novosHorarios = novosPares.map(p => p.horario);
    if (novosHorarios.length === 1) return novosHorarios[0];

    if (horarioInicioAntigo && !novosHorarios.includes(horarioInicioAntigo)) {
        const horariosAntigos = new Set((paresAntigos || []).map(p => p.horario));
        const genuinamenteNovos = novosHorarios.filter(h => !horariosAntigos.has(h));
        if (genuinamenteNovos.length === 1) return genuinamenteNovos[0];
    }
    return null;
}

// Compartilhado entre corrigirPosologiaEmConfirmacao e decidirCadConfirmaForma (BUG-95 +
// BUG-98): uma correção horarios_apenas, quando dá para identificar com segurança que ela
// trocou o início de um intervalo já declarado, recalcula a grade INTEIRA em código a
// partir do novo início (nunca aceita a lista "recalculada" pelo LLM). Quando não dá —
// correção mira outra dose, ou não há intervalo declarado — cai no remapeamento simples
// por posição ordenada (BUG-91), que já preserva as quantidades corretamente nesse caso.
// Ao cair no fallback tendo um intervalo declarado, limpa intervalo_horas/horario_inicio:
// a grade resultante não é mais garantidamente uma progressão aritmética, então tentar
// recalculá-la de novo numa correção futura produziria um resultado errado.
function resolverCorrecaoHorariosApenas(paresAntigos, novosParesClassificados, intervaloHorasContexto, horarioInicioContexto) {
    if (intervaloHorasContexto) {
        const novoInicio = identificarNovoInicio(paresAntigos, novosParesClassificados, horarioInicioContexto);
        if (novoInicio) {
            const grade = recalcularGradePorIntervalo(paresAntigos, novoInicio, intervaloHorasContexto);
            if (grade) {
                return { horarios: grade.horarios, pares: grade.pares, extra: { intervalo_horas: intervaloHorasContexto, horario_inicio: novoInicio } };
            }
        }
    }
    const horarios = novosParesClassificados.map(p => p.horario);
    const pares = remapearParesParaNovosHorarios(paresAntigos, horarios);
    const extra = intervaloHorasContexto ? { intervalo_horas: null, horario_inicio: null } : {};
    return { horarios, pares, extra };
}

// v36 Briefing #1: intervalo e início são independentes da categoria (REGRA 7 do prompt).
// Quando a mensagem traz UM horário e um intervalo, o horário é o INÍCIO da grade, não a
// grade inteira — expandir em código, nunca no LLM (Princípio 28).
// Devolve null quando não há intervalo aplicável, e o chamador segue com os pares originais.
function expandirParesPorIntervalo(classificacao) {
    const { pares, intervaloHoras } = classificacao;
    if (!intervaloHoras || !Array.isArray(pares) || pares.length !== 1) return null;

    const inicio = classificacao.horarioInicio || pares[0].horario;
    const horarios = calcularHorariosPorIntervalo(inicio, intervaloHoras);
    if (horarios.length <= 1) return null;

    return {
        pares: montarParesPosologia(horarios, pares[0].quantidade),
        horarios,
        intervalo_horas: intervaloHoras,
        horario_inicio: inicio
    };
}

function pluralizarRotulo(rotulo, quantidade) {
    if (Number(quantidade) === 1) return rotulo;
    const plurais = {
        unidade: 'unidades', comprimido: 'comprimidos', capsula: 'cápsulas', cápsula: 'cápsulas',
        gota: 'gotas'
    };
    return plurais[rotulo] || rotulo; // gotas, ml, líquido, colírio, pomada, injetável, xarope já servem no singular/plural
}

function renderizarBlocoPosologia(pares, rotulo) {
    return [...(pares || [])]
        .sort((a, b) => a.horario.localeCompare(b.horario))
        .map(p => `*${p.quantidade} ${pluralizarRotulo(rotulo, p.quantidade)}* às ${p.horario}`)
        .join(' e ');
}

function renderizarListaPosologia(pares, rotulo) {
    return [...(pares || [])]
        .sort((a, b) => a.horario.localeCompare(b.horario))
        .map(p => `   • ${p.horario} — ${p.quantidade} ${pluralizarRotulo(rotulo, p.quantidade)}`)
        .join('\n');
}

// MH-073 Parte C, seção 7 — três variantes de resumo de estoque, escolhidas em código
// a partir de `estoque_motivo` (closed set gravado por processarEstoque). O LLM nunca
// escreve o número nem decide a variante.
const DESCRICAO_FRACAO_ESTOQUE = {
    recem_aberto: 'que está recém-aberto',
    tres_quartos: 'que ainda tem 3/4',
    metade: 'que está pela metade',
    um_quarto: 'que tem 1/4',
    quase_acabando: 'que está quase acabando'
};

function arredondarParaExibicao(n) {
    return Math.round(n * 10) / 10;
}

function renderizarLinhaEstoque(context, estoqueFinal) {
    const motivo = context?.estoque_motivo || null;
    const volume = context?.volume_frasco || null;

    if (motivo === 'aberto_fracao_nao_informada') {
        return `comecei com uma quantidade baixa (frasco de ${volume}ml), porque você ainda `
            + `não sabia quanto tinha sobrando — é só me atualizar assim que souber`;
    }

    if (typeof motivo === 'string' && motivo.startsWith('aberto_fracao:')) {
        const bucket = motivo.split(':')[1];
        const descricao = DESCRICAO_FRACAO_ESTOQUE[bucket] || 'que você descreveu';
        return `aproximadamente ${arredondarParaExibicao(estoqueFinal)}ml (frasco de ${volume}ml, `
            + `você disse ${descricao}) — vou guardar como estimativa, você pode corrigir quando quiser`;
    }

    // frascos_fechados, aberto_valor_exato, ou estoque sólido (motivo null) — texto
    // igual ao que já existia, sem qualquer menção a estimativa (variante 1).
    let linha = `${estoqueFinal} ${context?.unidade_estoque === 'ml' ? 'ml' : 'unidades'}`;
    if (context?.unidade_estoque === 'ml' && context?.frascos && volume) {
        linha += ` (${context.frascos} frasco${Number(context.frascos) === 1 ? '' : 's'} de ${volume}ml)`;
    }
    return linha;
}

function renderizarResumo(context, estoqueFinal) {
    const pares = context?.pares_posologia || [];
    const forma = derivarFormaFarmaceutica(context?.forma_explicita, context?.forma_confirmada, context?.unidade_dose);
    const rotuloDose = rotuloDaDose(context?.unidade_dose, forma);
    const tratamento = context?.tipo_tratamento === 'temporario'
        ? `${context?.tratamento_dias} dias`
        : 'contínuo';

    return `💊 Remédio: ${context?.nome}\n`
        + `📏 Dosagem: ${context?.dosagem}\n`
        + `💉 Forma: ${forma}\n`
        + `⏰ Posologia:\n${renderizarListaPosologia(pares, rotuloDose)}\n`
        + `🔄 Tratamento: ${tratamento}\n`
        + `📦 Estoque: ${renderizarLinhaEstoque(context, estoqueFinal)}`;
}

// v44 (decisão de produto, replay 19/09): o RESUMO migrou para logo após a
// gravação — a coleta de estoque nem sempre chega, e o resumo não podia depender
// dela. Depois do estoque vem só este fechamento curto, com o número lido
// PÓS-ESCRITA do banco (autoria única, §5.7) — e sem etapa de confirmação:
// correção depois do fechamento entra pela porta (configuração/estoque).
function montarFechamentoEstoque({ med, alerta, primeiroMedicamento, firstName }) {
    const linhas = [];

    if (med.estoque_atual !== null && med.estoque_atual !== undefined) {
        const unidadeLabel = med.unidade_estoque === 'ml'
            ? 'ml'
            : pluralizarRotulo(rotuloDaDose(med.unidade_dose, med.forma_farmaceutica), Number(med.estoque_atual));
        const sufixoEstimativa = med.estoque_estimado ? ' (estimativa)' : '';
        linhas.push(`📦 Anotado: *${med.estoque_atual}* ${unidadeLabel} de ${med.nome} no estoque${sufixoEstimativa}.`);
        if (alerta?.dias_restantes !== undefined && alerta?.dias_restantes !== null) {
            linhas.push(`⚠️ Esse estoque dura aproximadamente *${alerta.dias_restantes}* ${Number(alerta.dias_restantes) === 1 ? 'dia' : 'dias'} — bom já planejar a recompra! 💊`);
        } else {
            linhas.push('Quando estiver acabando, eu te aviso pra você comprar antes de ficar sem. 🌿');
        }
    } else {
        linhas.push(`Tudo bem${firstName ? `, ${firstName}` : ''}! O estoque fica pra depois — quando souber, é só me mandar a quantidade. 🌿`);
    }

    if (primeiroMedicamento) {
        linhas.push('Ah, e uma coisinha: eu ainda estou em desenvolvimento, sendo melhorada com carinho a cada dia — se eu escorregar em algo, me avisa? 😊');
    }
    return linhas.join('\n\n');
}

// Correção #1 (v36 #2, seção 1): a pergunta das três etapas de estoque é dado de
// saúde renderizado em código, função pura sem LLM — mesmo padrão de renderizarResumo
// acima. A causa raiz que este briefing ataca (seção 0): buildSystemPrompt montava
// as instruções de TODAS as etapas simultaneamente e o LLM seguia o histórico da
// conversa em vez da etapa real, trocando "VOLUME" por "DOSAGEM" e por aí vai. Uma
// etapa determinística com pergunta gerada pelo LLM ainda deixava esse espaço; com o
// texto fixo aqui, não sobra o que confundir.
function renderizarPerguntaEstoque(etapa, context, firstName = null) {
    const nome = context?.nome || '{nome}';
    const acao = context?.acaoEstoque;

    if (etapa === 'cad_estoque') {
        // Reformulações (mesmos textos que já estavam em buildSystemPrompt) — a de
        // frascos_indeterminado é nova (correção #4).
        if (acao === 'estoque_indeterminado') return `Quantas unidades de ${nome} você tem agora?`;
        if (acao === 'status_frasco_indeterminado') {
            return `Me diz assim: ele já está aberto, você já usou alguma coisa dele, ou ainda está lacrado, sem ter usado nada ainda?`;
        }
        if (acao === 'frascos_indeterminado') {
            return `Não peguei o número 😊 Me diz só quantos frascos de ${nome} você tem em casa — por exemplo: 1, 2, 3.`;
        }
        if (context?.unidade_estoque === 'ml') {
            if (context?.status_frasco === 'fechado') return `Quantos frascos de ${nome} você tem?`;
            return `O frasco de ${nome} já está *ABERTO* (você já está usando) ou ainda está *FECHADO* (nunca foi aberto)?`;
        }
        // v43 Bloco C Adendo 1 (seção 6): explica o benefício na mesma frase e usa o
        // rótulo da forma farmacêutica — nunca "unidades" genérico.
        // v44 (replay 19/09, Constituição regra 1): estoque é opcional — o pedido é
        // CONVITE, nunca ordem ("me fala..."), e carrega a porta de saída na própria
        // mensagem.
        {
            const forma = derivarFormaFarmaceutica(context?.forma_explicita, context?.forma_confirmada, context?.unidade_dose);
            const rotulo = pluralizarRotulo(rotuloDaDose(context?.unidade_dose, forma), 2);
            return `${firstName ? `${firstName}, se` : 'Se'} você souber e já quiser cadastrar o estoque do ${nome}, é só me falar quantos ${rotulo} tem em casa — eu anoto e te aviso quando estiver acabando, pra você comprar antes de ficar sem. Se não souber agora, tudo bem também.`;
        }
    }

    if (etapa === 'cad_estoque_volume') {
        if (acao === 'volume_indeterminado') return `Qual o VOLUME de cada frasco, em ml? (está no rótulo — ex: 10ml, 100ml)`;
        return `E qual o *VOLUME* desse frasco, em ml? Geralmente está no rótulo — ex: 10ml, 100ml.`;
    }

    if (etapa === 'cad_estoque_fracao') {
        if (acao === 'fracao_indeterminada') return `Pode ser algo como 'metade', '1/4', 'quase acabando' — ou um número em ml, tipo 30ml.`;
        return `E hoje, quanto mais ou menos ainda sobra nesse frasco de ${nome}? Pode ser algo como recém-aberto, 3/4, metade, 1/4, quase acabando — ou, se souber, me diz direto em ml.`;
    }

    return null;
}

// ============================================================
// MH-073 Parte B — EXTRAÇÃO NUMÉRICA DE ESTOQUE (frasco lacrado)
// ============================================================

function extrairNumero(texto) {
    const m = String(texto).match(/\d+(?:[.,]\d+)?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
}

// MH-073 Parte C: mesma extração de extrairNumero, mas recusa notação de fração
// ("3/4") — sem a guarda, "3/4" seria lido como valor exato "3ml" em vez de cair no
// classificador de fração (classificarFracaoEstoque), que já entende esse formato.
function extrairValorExatoEstoque(texto) {
    if (/\d\s*\/\s*\d/.test(String(texto))) return null;
    return extrairNumero(texto);
}

// "2 frascos de 10ml" -> {frascos:2, volume:10}. "2" -> {frascos:2, volume:null}.
function extrairFrascosEVolume(message) {
    const texto = String(message).toLowerCase();
    const mlMatch = texto.match(/(\d+(?:[.,]\d+)?)\s*ml/);
    const volume = mlMatch ? parseFloat(mlMatch[1].replace(',', '.')) : null;
    const todosNumeros = (texto.match(/\d+(?:[.,]\d+)?/g) || []).map(n => parseFloat(n.replace(',', '.')));

    let frascos = null;
    if (volume !== null) {
        const outros = todosNumeros.filter(n => n !== volume);
        frascos = outros.length > 0 ? outros[0] : null;
    } else if (todosNumeros.length > 0) {
        frascos = todosNumeros[0];
    }
    return { frascos, volume };
}

// Calcula o alerta de estoque baixo a partir da posologia e do estoque final.
// Extraído para ser reaproveitado tanto por processarEstoque (primeira resolução)
// quanto por corrigirPosologiaEmConfirmacao (recálculo após correção no resumo) —
// ponto único, a mesma regra nos dois lugares.
function calcularAlertaEstoque(context, estoqueFinal) {
    const pares = context?.pares_posologia || [];
    const somaDoses = pares.reduce((acc, p) => acc + Number(p.quantidade || 0), 0);
    const consumoDiario = converterDoseParaEstoque({
        quantidade: somaDoses,
        unidade_dose: context?.unidade_dose,
        unidade_estoque: context?.unidade_estoque,
        gotas_por_ml: context?.gotas_por_ml
    });
    const diasRestantes = consumoDiario > 0 ? Math.floor(estoqueFinal / consumoDiario) : 0;
    const tratamentoDias = context?.tratamento_dias || null;
    const deveAlertar = tratamentoDias !== null
        ? diasRestantes < tratamentoDias
        : diasRestantes <= 5;

    return deveAlertar ? {
        dias_restantes: diasRestantes,
        estoque: estoqueFinal,
        doses_por_dia: pares.length || (context?.horarios || []).length || 1,
        tipo_tratamento: tratamentoDias ? 'temporario' : 'continuo',
        tratamento_dias: tratamentoDias
    } : null;
}

// ============================================================
// BUG-97 (briefing Parte B.3, seção 3.3) — CLASSIFICADOR DE ESTOQUE SÓLIDO
// ============================================================
//
// REGRESSÃO da Parte B: `parseInt(message) || 0` colapsava "não consegui ler" e "o
// usuário disse zero" no mesmo valor 0, e não entendia frase natural ("Tenho 30 cps",
// "Caixa com 60"). Substituído por classificador dedicado, no mesmo padrão dos demais
// desta etapa — zero é resposta LEGÍTIMA, mas só quando o classificador tem certeza
// que foi isso que a pessoa disse, nunca como fallback de falha.

function buildEstoqueSolidoSystemPrompt({ nomeMedicamento, historicoConversa, message }) {
    return `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami), que está
cadastrando o medicamento "${nomeMedicamento || ''}" e perguntou quantas unidades a pessoa TEM EM
ESTOQUE agora (comprimidos, cápsulas, drágeas etc — forma sólida ou contável).

Sua tarefa é extrair o TOTAL em unidades, já multiplicado quando a pessoa descrever embalagens.

CATEGORIAS (escolha exatamente UMA):
- quantidade: a pessoa deu um total em unidades, dito com confiança. Exemplos:
  "30" -> 30 | "Tenho 30 cps" -> 30 | "Caixa com 60" -> 60 | "2 caixas de 30" -> 60 |
  "1 caixa com 30" -> 30 | "3 cartelas de 10" -> 30 | "meia caixa de 20" -> 10 |
  "não tenho nenhum" -> 0 | "acabou" -> 0 | "zero" -> 0.
- estimativa: a pessoa deu um número, mas com incerteza/chute (hedge) — "acho que", "uns",
  "mais ou menos", "por volta de", "chuto uns", "talvez". Exemplos: "acho que uns 20" -> 20 |
  "uns 15 mais ou menos" -> 15 | "por volta de 30" -> 30.
- nao_sei: a pessoa não sabe quanto tem e NÃO arriscou nenhum número. Exemplos: "não sei",
  "não faço ideia", "nem sei direito", "não tenho certeza nenhuma".
- indeterminado: não há número reconhecível nem foi dito "não sei" — a embalagem foi citada sem
  o conteúdo dela ("uma caixa" sem dizer quantas unidades tem, "tenho bastante", resposta fora
  do assunto).

Zero é uma resposta LEGÍTIMA e DIFERENTE de "não sei" — só devolva "quantidade": 0 quando a
pessoa disser explicitamente que não tem nenhum. Nunca chute um número quando a mensagem não
permitir calcular um total com segurança — nesse caso é "nao_sei" ou "indeterminado", nunca
"quantidade": 0.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "categoria": "...", "quantidade": null }`;
}

function fallbackEstoqueSolidoIndeterminado() {
    return { categoria: 'indeterminado', quantidade: null };
}

async function classificarEstoqueSolido({ message, nomeMedicamento, historicoConversa = [] }) {
    const systemPrompt = buildEstoqueSolidoSystemPrompt({ nomeMedicamento, historicoConversa, message });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: classificador de estoque sólido não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_estoque_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: fallbackEstoqueSolidoIndeterminado()
        });
    }

    let quantidade = Number(parsed.quantidade);
    quantidade = Number.isFinite(quantidade) && quantidade >= 0 ? quantidade : null;

    const categoriasComNumero = new Set(['quantidade', 'estimativa']);
    let categoria = parsed.categoria;
    if (categoriasComNumero.has(categoria) && quantidade === null) categoria = 'indeterminado';
    if (!categoriasComNumero.has(categoria) && categoria !== 'nao_sei') categoria = 'indeterminado';
    if (categoria === 'nao_sei' || categoria === 'indeterminado') quantidade = null;

    console.log(`🔎 [CAD-CLASSIF] classificarEstoqueSolido -> ${categoria} (quantidade: ${quantidade})`);
    return { categoria, quantidade };
}

// ============================================================
// MH-073 Parte C — CLASSIFICADOR DE STATUS DO FRASCO (aberto/fechado)
// ============================================================

function buildStatusFrascoSystemPrompt({ nomeMedicamento, historicoConversa, message }) {
    return `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami), que está
cadastrando o medicamento líquido "${nomeMedicamento || ''}" e perguntou se o frasco já está
ABERTO (a pessoa já está usando) ou ainda FECHADO (nunca foi aberto, lacrado).

CATEGORIAS (escolha exatamente UMA):
- aberto: o frasco já está em uso, já foi aberto, já tem algo faltando. Ex: "já uso", "já tá
  aberto", "tô usando faz um tempo", "já abri", "tá pela metade", "uso desde semana passada".
- fechado: o frasco nunca foi aberto, ainda está lacrado, novo. Ex: "fechado", "lacrado",
  "ainda não abri", "novinho", "nunca usei".
- indeterminado: a resposta não permite decidir entre aberto e fechado.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "categoria": "..." }`;
}

function fallbackStatusFrascoIndeterminado() {
    return { categoria: 'indeterminado' };
}

async function classificarStatusFrasco({ message, nomeMedicamento, historicoConversa = [] }) {
    const systemPrompt = buildStatusFrascoSystemPrompt({ nomeMedicamento, historicoConversa, message });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: classificador de status do frasco não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_status_frasco_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: fallbackStatusFrascoIndeterminado()
        });
    }

    const categoriasValidas = new Set(['aberto', 'fechado', 'indeterminado']);
    const categoria = categoriasValidas.has(parsed.categoria) ? parsed.categoria : 'indeterminado';
    console.log(`🔎 [CAD-CLASSIF] classificarStatusFrasco -> ${categoria}`);
    return { categoria };
}

// ============================================================
// MH-073 Parte C — CLASSIFICADOR DE FRAÇÃO DE ESTOQUE (frasco já aberto)
// ============================================================

// Tabela de conversão fração -> número, em código, nunca no LLM (Princípio 4).
const FRACOES_ESTOQUE = {
    recem_aberto:   1.00,
    tres_quartos:   0.75,
    metade:         0.50,
    um_quarto:      0.25,
    quase_acabando: 0.10,
};

function buildFracaoEstoqueSystemPrompt({ nomeMedicamento, historicoConversa, message }) {
    return `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami), que está
cadastrando o medicamento líquido "${nomeMedicamento || ''}" e perguntou quanto ainda resta no
frasco JÁ ABERTO (não é a primeira vez que a pessoa usa).

CATEGORIAS (escolha exatamente UMA):
- recem_aberto: o frasco foi aberto agora, praticamente cheio. Ex: "recém-aberto", "acabei de
  abrir", "tá quase cheio ainda".
- tres_quartos: resta cerca de 3/4. Ex: "3/4", "uns 3 quartos".
- metade: resta cerca da metade. Ex: "metade", "meio frasco", "50%".
- um_quarto: resta cerca de 1/4. Ex: "1/4", "um quarto", "só um quartinho".
- quase_acabando: está quase no fim. Ex: "quase acabando", "tá no fim", "pouquinho só".
- nao_sei: a pessoa não sabe quanto resta. Ex: "não sei", "não faço ideia", "não tenho certeza".
- indeterminado: a resposta não permite decidir nenhuma das categorias acima (não responde à
  pergunta, ou é confusa).

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "categoria": "..." }`;
}

function fallbackFracaoEstoqueIndeterminada() {
    return { categoria: 'indeterminado' };
}

async function classificarFracaoEstoque({ message, nomeMedicamento, historicoConversa = [] }) {
    const systemPrompt = buildFracaoEstoqueSystemPrompt({ nomeMedicamento, historicoConversa, message });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: classificador de fração de estoque não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_fracao_estoque_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: fallbackFracaoEstoqueIndeterminada()
        });
    }

    const categoriasValidas = new Set([...Object.keys(FRACOES_ESTOQUE), 'nao_sei', 'indeterminado']);
    const categoria = categoriasValidas.has(parsed.categoria) ? parsed.categoria : 'indeterminado';
    console.log(`🔎 [CAD-CLASSIF] classificarFracaoEstoque -> ${categoria}`);
    return { categoria };
}

// v43 Bloco C (MH-094, Parte 3.5) — resumo de cad_confirmacao lido do medicamento JÁ
// GRAVADO (medication_id) e seus schedules ativos, nunca do rascunho em memória (P56).
// Só é alcançável depois da gravação antecipada (Parte 3.1: medication_id sempre existe
// antes de cad_confirmacao), então não há caminho para chamar isto sem um registro real.
// Simplificação deliberada em relação ao resumo de rascunho: sem a nuance de frascos/
// volume (não persistida em `medications`) — só número final + unidade + rótulo de
// estimativa, que é o que a pessoa efetivamente confirma.
async function montarResumoDoBanco(medicationId) {
    const med = await getMedicationComSchedulesAtivos(medicationId);
    const pares = med.schedulesAtivos
        .map(s => ({ horario: String(s.horario).substring(0, 5), quantidade: Number(s.quantidade_por_dose) }))
        .sort((a, b) => a.horario.localeCompare(b.horario));
    const rotulo = rotuloDaDose(med.unidade_dose, med.forma_farmaceutica);
    const tratamento = med.tipo_tratamento === 'temporario' ? `${med.tratamento_dias} dias` : 'contínuo';

    const linhas = [`💊 Remédio: ${med.nome}`];
    if (med.dosagem) linhas.push(`📏 Dosagem: ${med.dosagem}`);
    linhas.push(`💉 Forma: ${med.forma_farmaceutica}`);
    linhas.push(`⏰ Posologia:\n${renderizarListaPosologia(pares, rotulo)}`);
    linhas.push(`🔄 Tratamento: ${tratamento}`);
    // A linha de estoque só aparece se houver estoque (Parte 3.5) — "não sei" não vira
    // "0" nem "não informado" no resumo, simplesmente não é mencionado.
    if (med.estoque_atual !== null && med.estoque_atual !== undefined) {
        const unidadeLabel = med.unidade_estoque === 'ml' ? 'ml' : 'unidades';
        const sufixoEstimativa = med.estoque_estimado ? ' (estimativa)' : '';
        linhas.push(`📦 Estoque: ${med.estoque_atual} ${unidadeLabel}${sufixoEstimativa}`);
    }

    return { resumo: linhas.join('\n'), med, pares };
}

// Etapa cad_estoque / cad_estoque_fracao / cad_estoque_volume, ramificada por
// unidade_estoque (já resolvida três etapas antes). Só o CÓDIGO decide estoque, alerta
// e a próxima etapa — o LLM de geração apenas fraseia (mesmo princípio da seção 6 do
// briefing MH-073 Parte C). MH-073 Parte C: o ramo líquido ganhou um sub-estado
// (status_frasco) dentro da própria etapa cad_estoque — a primeira mensagem responde
// "aberto ou fechado?", a segunda (só no ramo fechado) responde "quantos frascos?",
// exatamente como a etapa única funcionava antes desta Parte.
async function processarEstoque(etapaAtual, message, context, historicoConversa) {
    const unidadeEstoque = context?.unidade_estoque || 'unidade';

    // v43 Bloco C (MH-094): a essa altura o medicamento JÁ está gravado (medication_id
    // sempre presente — gravação antecipada acontece antes do have-to-have de estoque,
    // ver primeiraEtapaFaltante). Resolver o estoque aqui escreve DIRETO no registro via
    // registrarMovimentoEstoque (ponto único de escrita de estoque) e o resumo de
    // cad_confirmacao é lido de volta do banco (P56) — nunca do rascunho.
    //
    // estimado é derivado do motivo (closed set, seção 6 do briefing MH-073 Parte C):
    // tudo que nasce de um frasco JÁ ABERTO é estimativa, mesmo o valor exato
    // autorrelatado — só a contagem de frascos fechados é medida exata. estimativa
    // (solid, hedge de linguagem) também marca estoque_estimado.
    const finalizarComEstoque = async (estoque, extra = {}) => {
        const estimado = (!!extra.estoque_motivo && extra.estoque_motivo !== 'frascos_fechados')
            || extra.estoque_motivo === 'estimativa_informada';
        const contextUpdates = {
            estoque_perguntado: true,
            estoque_resolvido: estoque,
            ...extra,
            estoque_estimado: estimado
        };

        await registrarMovimentoEstoque({
            medicationId: context?.medication_id,
            tipo: 'cadastro_inicial',
            origem: 'manual',
            motivo: extra.estoque_motivo || null,
            estimado,
            valorAbsoluto: estoque
        });

        const contextComExtra = { ...context, ...contextUpdates };
        contextUpdates.alerta_estoque_baixo = calcularAlertaEstoque(contextComExtra, estoque);

        const { resumo } = await montarResumoDoBanco(context?.medication_id);
        return {
            acao: 'estoque_resolvido',
            proximaEtapa: 'cad_confirmacao',
            contextUpdates,
            resumoRenderizado: resumo
        };
    };

    // "não sei" (BUG-104/MH-094, decisão de produto v43): estoque_atual permanece NULL —
    // nunca 0 (P49). A etapa é dada por RESOLVIDA (estoque_perguntado) sem nenhuma
    // escrita: saveMedication já gravou o registro com estoque_atual NULL na gravação
    // antecipada, e não há movimento a registrar aqui.
    const finalizarComEstoqueDesconhecido = async () => {
        const contextUpdates = {
            estoque_perguntado: true,
            estoque_resolvido: null,
            estoque_motivo: null,
            estoque_estimado: false,
            alerta_estoque_baixo: null
        };
        const { resumo } = await montarResumoDoBanco(context?.medication_id);
        return {
            acao: 'estoque_nao_informado',
            proximaEtapa: 'cad_confirmacao',
            contextUpdates,
            resumoRenderizado: resumo
        };
    };

    if (etapaAtual === 'cad_estoque') {
        if (unidadeEstoque === 'ml') {
            // Fase 2: status já resolvido como 'fechado' nesta mesma etapa — esta
            // mensagem responde à contagem de frascos (nova pergunta, sem mais exigir a
            // palavra "fechados" — seção 3 do briefing). Extração e cálculo idênticos ao
            // que já existia antes da Parte C.
            if (context?.status_frasco === 'fechado') {
                const { frascos, volume } = extrairFrascosEVolume(message);
                if (frascos !== null && volume !== null) {
                    return finalizarComEstoque(frascos * volume, { frascos, volume_frasco: volume, estoque_motivo: 'frascos_fechados' });
                }
                // Correção #4 (v36 #2, seção 4): sem frascos reconhecido, NÃO avança —
                // avançar com frascos null virava estoque=1*volume (BUG de 26-27/08).
                // Reformula em vez de aceitar qualquer resposta como contagem.
                if (frascos === null) {
                    return { acao: 'frascos_indeterminado', proximaEtapa: 'cad_estoque', contextUpdates: {} };
                }
                return {
                    acao: 'frascos_apenas',
                    proximaEtapa: 'cad_estoque_volume',
                    contextUpdates: { frascos }
                };
            }

            const statusClassificacao = await classificarStatusFrasco({ message, nomeMedicamento: context?.nome, historicoConversa });

            // MH-073 Parte C.1 (v36 #2, seção 5): aproveita frascos/volume ou valor/fração
            // já ditos na MESMA mensagem que respondeu o status, em vez de descartá-los e
            // perguntar de novo na etapa seguinte (Princípio 1).
            if (statusClassificacao.categoria === 'fechado') {
                const { frascos, volume } = extrairFrascosEVolume(message);
                if (frascos !== null && volume !== null) {
                    return finalizarComEstoque(frascos * volume, { status_frasco: 'fechado', frascos, volume_frasco: volume, estoque_motivo: 'frascos_fechados' });
                }
                if (frascos !== null) {
                    return {
                        acao: 'status_frasco_fechado_com_frascos',
                        proximaEtapa: 'cad_estoque_volume',
                        contextUpdates: { status_frasco: 'fechado', frascos }
                    };
                }
                return { acao: 'status_frasco_fechado', proximaEtapa: 'cad_estoque', contextUpdates: { status_frasco: 'fechado' } };
            }
            if (statusClassificacao.categoria === 'aberto') {
                const valorExato = extrairValorExatoEstoque(message);
                const volumeConhecido = Number(context?.volume_frasco) || null;
                if (valorExato !== null && volumeConhecido !== null) {
                    return finalizarComEstoque(valorExato, { status_frasco: 'aberto', volume_frasco: volumeConhecido, estoque_motivo: 'aberto_valor_exato' });
                }
                if (valorExato !== null) {
                    return {
                        acao: 'status_frasco_aberto_com_valor',
                        proximaEtapa: 'cad_estoque_volume',
                        contextUpdates: { status_frasco: 'aberto', estoque_valor_exato_pendente: valorExato }
                    };
                }
                return { acao: 'status_frasco_aberto', proximaEtapa: 'cad_estoque_fracao', contextUpdates: { status_frasco: 'aberto' } };
            }
            return { acao: 'status_frasco_indeterminado', proximaEtapa: 'cad_estoque', contextUpdates: {} };
        }
        const classificacao = await classificarEstoqueSolido({ message, nomeMedicamento: context?.nome, historicoConversa });
        if (classificacao.categoria === 'quantidade') {
            return finalizarComEstoque(classificacao.quantidade, { estoque_motivo: null });
        }
        if (classificacao.categoria === 'estimativa') {
            // "acho que uns 20" — aceita sem questionar (decisão de produto v43): a
            // pessoa deu um número, só marcado como estimativa (estoque_estimado).
            return finalizarComEstoque(classificacao.quantidade, { estoque_motivo: 'estimativa_informada' });
        }
        if (classificacao.categoria === 'nao_sei') {
            // Decisão de produto v43: NUNCA insiste — aceita "não sei" de primeira e segue.
            return finalizarComEstoqueDesconhecido();
        }
        // Falha de extração devolve indeterminado, NUNCA 0 (seção 3.3.b do briefing) —
        // permanece em cad_estoque e reformula a pergunta, nunca chega a salvar estoque nulo.
        return { acao: 'estoque_indeterminado', proximaEtapa: 'cad_estoque', contextUpdates: {} };
    }

    if (etapaAtual === 'cad_estoque_fracao') {
        // Camada 1, determinística: um número solto ("tem uns 40ml") é usado DIRETO como
        // valor exato de estoque, sem passar pelo classificador (seção 4 do briefing,
        // Princípio 1 — informação melhor que o usuário já deu nunca é substituída por
        // aproximação).
        const valorExato = extrairValorExatoEstoque(message);
        if (valorExato !== null) {
            const volume = Number(context?.volume_frasco) || null;
            if (volume !== null) {
                return finalizarComEstoque(valorExato, { estoque_motivo: 'aberto_valor_exato' });
            }
            return {
                acao: 'valor_exato_pendente',
                proximaEtapa: 'cad_estoque_volume',
                contextUpdates: { estoque_valor_exato_pendente: valorExato }
            };
        }

        const classificacao = await classificarFracaoEstoque({ message, nomeMedicamento: context?.nome, historicoConversa });
        const volume = Number(context?.volume_frasco) || null;

        if (classificacao.categoria === 'nao_sei') {
            // Aceita imediatamente, NUNCA repete a pergunta (seção 4 do briefing) — o
            // percentual do piso é detalhe interno, nunca mencionado ao usuário.
            if (volume !== null) {
                return finalizarComEstoque(volume * 0.10, { estoque_motivo: 'aberto_fracao_nao_informada' });
            }
            return {
                acao: 'fracao_nao_informada_pendente',
                proximaEtapa: 'cad_estoque_volume',
                contextUpdates: { estoque_fracao_pendente: 'nao_informada' }
            };
        }

        if (FRACOES_ESTOQUE[classificacao.categoria] !== undefined) {
            const bucket = classificacao.categoria;
            if (volume !== null) {
                return finalizarComEstoque(volume * FRACOES_ESTOQUE[bucket], { estoque_motivo: `aberto_fracao:${bucket}` });
            }
            return {
                acao: 'fracao_pendente',
                proximaEtapa: 'cad_estoque_volume',
                contextUpdates: { estoque_fracao_pendente: bucket }
            };
        }

        return { acao: 'fracao_indeterminada', proximaEtapa: 'cad_estoque_fracao', contextUpdates: {} };
    }

    // cad_estoque_volume — reordenada para vir sempre por último (seção 5 do briefing).
    // Chega aqui tanto pelo ramo fechado (frascos já contados, faltava só o volume)
    // quanto pelo ramo aberto (fração/valor exato já resolvidos, faltava só o volume).
    const volume = extrairNumero(message);
    if (volume === null) {
        return { acao: 'volume_indeterminado', proximaEtapa: 'cad_estoque_volume', contextUpdates: {} };
    }

    if (context?.estoque_valor_exato_pendente !== undefined && context?.estoque_valor_exato_pendente !== null) {
        return finalizarComEstoque(context.estoque_valor_exato_pendente, {
            volume_frasco: volume, estoque_motivo: 'aberto_valor_exato', estoque_valor_exato_pendente: null
        });
    }
    if (context?.estoque_fracao_pendente === 'nao_informada') {
        return finalizarComEstoque(volume * 0.10, {
            volume_frasco: volume, estoque_motivo: 'aberto_fracao_nao_informada', estoque_fracao_pendente: null
        });
    }
    if (context?.estoque_fracao_pendente) {
        const bucket = context.estoque_fracao_pendente;
        return finalizarComEstoque(volume * FRACOES_ESTOQUE[bucket], {
            volume_frasco: volume, estoque_motivo: `aberto_fracao:${bucket}`, estoque_fracao_pendente: null
        });
    }

    const frascos = Number(context?.frascos) || 1;
    return finalizarComEstoque(frascos * volume, { volume_frasco: volume, estoque_motivo: 'frascos_fechados' });
}

// ============================================================
// MH-073 Parte B — CLASSIFICADOR ÚNICO DE POSOLOGIA
// ============================================================
//
// Horário e quantidade são o mesmo fato de posologia, expresso junto na fala
// natural ("2 comprimidos às 8h"). Um classificador só, reaproveitado em
// cad_horarios, cad_quantidade_por_dose, cad_confirma_forma e nas correções feitas
// a partir de cad_confirmacao, evita estados incoerentes e permite o salto de etapa
// quando a resposta já traz tudo.
//
// A pergunta que este classificador faz é "o que é isso?", nunca "isso serve
// para o campo que eu esperava?" — mesma forma do extrairComponenteData do
// MH-072, evitando a falácia formato-≠-pertencimento (BUG-030, BUG-086).

function buildPosologiaSystemPrompt({ nomeMedicamento, campoEsperado, horariosJaColetados, historicoConversa, message, emCorrecao }) {
    const campoEsperadoTexto = campoEsperado === 'horarios'
        ? 'em quais horários a pessoa toma ou usa o medicamento'
        : 'quanto a pessoa toma ou usa em cada horário';

    const horariosTexto = horariosJaColetados && horariosJaColetados.length > 0
        ? horariosJaColetados.join(', ')
        : 'nenhum';

    // BUG-91 (seção 6.4 do briefing): quando a mensagem corrige um horário dentro de um
    // resumo já confirmado, o usuário costuma mencionar só o horário que MUDOU ("o
    // primeiro é 14:40, não 8h"), não a lista inteira. Sem esta instrução, "pares" viria
    // com um único horário e o remapeamento por contagem (remapearParesParaNovosHorarios)
    // sempre bateria como ambíguo, reperguntando a quantidade à toa.
    const instrucaoCorrecao = emCorrecao ? `

MODO CORREÇÃO — ESTA MENSAGEM CORRIGE HORÁRIOS JÁ CONFIRMADOS ANTES (não é coleta nova).
Os horários atuais são: ${horariosTexto}. Se a pessoa mencionar só o(s) horário(s) que mudou(aram)
("o primeiro é 14:40, não 8h"), devolva em "pares" a LISTA COMPLETA de horários corretos após a
correção: o(s) que mudou(aram) com o valor novo, e o(s) que ela NÃO mencionou mantidos como
estavam. Categoria continua "horarios_apenas" (quantidade pode ser 0, é preenchida pelo código).` : '';

    return `Você é um classificador de posologia para uma assistente de saúde via WhatsApp (a Nami), que
ajuda pessoas a tomarem seus medicamentos corretamente.

A Nami está cadastrando o medicamento "${nomeMedicamento || ''}" e perguntou sobre ${campoEsperadoTexto}.
Sua tarefa é extrair da mensagem TUDO o que ela contiver sobre a posologia — mesmo o que não foi
perguntado.${instrucaoCorrecao}

CATEGORIAS (escolha exatamente UMA):

- posologia_completa: a mensagem traz horário(s) E quantidade(s). Ex: "2 comprimidos às 8 e 1 às
  20", "20 gotas de manhã", "5ml às 7h e às 19h".
- horarios_apenas: só horários, sem quantidade. Ex: "às 8 e às 20", "de manhã e à noite",
  "8h, 14h e 22h".
- quantidade_apenas: só quantidade, sem horário. Ex: "2 comprimidos", "20 gotas", "5ml", "2 por
  vez", "duas".
- frequencia_intervalo: frequência regular expressa como intervalo ou vezes-ao-dia, com ou sem
  horário de início mencionado. Ex: "de 8 em 8 horas", "3 vezes ao dia", "12/12h".
- indeterminado: nada de posologia foi dito, ou a resposta é confusa, ou fora de contexto.

REGRA 1 — HORÁRIO NÃO É QUANTIDADE (crítica).
Números precedidos de "às", "as", "ás" são HORÁRIOS, nunca quantidades.
  "tomo às 8"        -> horarios_apenas, horário 08:00. NÃO é quantidade 8.
  "tomo 2 às 8"      -> posologia_completa, quantidade 2, horário 08:00.
  "tomo 8"           -> quantidade_apenas, quantidade 8 (sem preposição de hora).
Expressões de período viram horário convencional: "de manhã" -> 07:00, "à tarde" -> 14:00,
"à noite" -> 21:00, "meio-dia" -> 12:00, "antes de dormir" -> 22:00.
Horários sempre no formato 24h "HH:MM". "8 da noite" -> "20:00".

REGRA 2 — MULTIPLICADOR DE APLICAÇÃO (crítica).
Quando a dose é aplicada em mais de um sítio, a quantidade devolvida é a dose TOTAL por horário,
já multiplicada — nunca a quantidade por sítio.
  "2 gotas em cada olho"      -> quantidade 4, multiplicador_aplicado: true
  "1 gota em cada narina"     -> quantidade 2, multiplicador_aplicado: true
  "3 gotas no olho direito"   -> quantidade 3, multiplicador_aplicado: false
  "2 gotas nos dois ouvidos"  -> quantidade 4, multiplicador_aplicado: true
Em qualquer outro caso, multiplicador_aplicado: false.

REGRA 3 — UNIDADE DA DOSE.
Derive unidade_dose do que a pessoa disse:
  comprimido, cápsula, cápsulas, cp, cps, drágea, pastilha, sachê, tubo, ampola, adesivo,
  aplicação, "por vez", "unidade"  -> unidade
  gota, gotas, gts                                                          -> gota
  ml, mL, mililitro, "medida", "colher de chá" (=5ml), "colher de sopa" (=15ml) -> ml
Colher vira ml com a quantidade convertida: "1 colher de chá" -> quantidade 5, unidade ml.
Se a pessoa não indicar unidade nenhuma ("2 por vez", "duas"), unidade_dose = "unidade" e
forma_explicita = null.

REGRA 4 — FORMA EXPLÍCITA.
forma_explicita só é preenchida quando a pessoa NOMEOU a forma. NUNCA infira pelo nome do
medicamento nem pela unidade.
  "2 comprimidos"  -> comprimido
  "20 gotas"       -> gotas
  "5ml de xarope"  -> xarope
  "2 por vez"      -> null
  "20 gotas no olho" -> colirio
Valores permitidos: comprimido, capsula, colirio, gotas, pomada, injetavel, xarope, null.

REGRA 5 — CONCENTRAÇÃO NÃO É QUANTIDADE.
Resposta em mg, mcg, g, % ou mg/ml é DOSAGEM (concentração do remédio), não quantidade por dose.
  "50mg"  -> indeterminado
  "0,5%"  -> indeterminado
Exceção: "5ml" É quantidade (volume administrado, não concentração).

REGRA 6 — NÚMEROS POR EXTENSO contam normalmente: "duas gotas" -> 2, "meio comprimido" -> 0.5.

REGRA 7 — INTERVALO E HORÁRIO DE INÍCIO (crítica).
Sempre que a mensagem mencionar um intervalo regular ("de 8 em 8 horas", "8/8hrs", "12/12",
"3 vezes ao dia"), preencha "intervalo_horas" — INDEPENDENTE da categoria escolhida.
Sempre que a mensagem indicar quando a pessoa toma/tomou a primeira dose ("comecei às 17h",
"tomo às 20hrs agora", "a primeira é 8h"), preencha "horario_inicio" no formato "HH:MM" —
INDEPENDENTE da categoria escolhida.
Estes dois campos são INDEPENDENTES da categoria: uma mensagem pode ser posologia_completa E
trazer intervalo_horas; pode ser frequencia_intervalo E trazer horario_inicio.
  "5ml 8/8hrs. Tomo as 20hrs agora"     -> posologia_completa, pares [{20:00, 5}],
                                            intervalo_horas 8, horario_inicio "20:00"
  "5ml de 8 em 8hrs comecei as 17hrs"   -> posologia_completa, pares [{17:00, 5}],
                                            intervalo_horas 8, horario_inicio "17:00"
  "de 8 em 8 horas"                     -> frequencia_intervalo, intervalo_horas 8,
                                            horario_inicio null
NUNCA calcule você mesmo os demais horários da grade a partir do intervalo — devolva apenas o
início. A grade inteira é calculada em código (dado de saúde, Princípio 28).

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

HORÁRIOS JÁ COLETADOS: ${horariosTexto}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{
  "categoria": "...",
  "pares": [{"horario": "HH:MM", "quantidade": 0}],
  "quantidade_unica": null,
  "intervalo_horas": null,
  "horario_inicio": null,
  "unidade_dose": null,
  "forma_explicita": null,
  "multiplicador_aplicado": false
}`;
}

function horarioValido(h) {
    if (typeof h !== 'string' || !HORARIO_REGEX.test(h)) return false;
    const [hh, mm] = h.split(':').map(Number);
    return hh <= 23 && mm <= 59;
}

function fallbackPosologiaIndeterminada() {
    return {
        categoria: 'indeterminado', pares: [], quantidadeUnica: null,
        intervaloHoras: null, horarioInicio: null, unidadeDose: null,
        formaExplicita: null, multiplicadorAplicado: false
    };
}

// Validação determinística pós-parse (seção 4.6 do briefing). Nunca deixa passar
// quantidade/horário chutado — cada par é validado individualmente.
function validarClassificacaoPosologia(parsed, unidadeDoseContexto = null) {
    const categoriasValidas = new Set([
        'posologia_completa', 'horarios_apenas', 'quantidade_apenas', 'frequencia_intervalo', 'indeterminado'
    ]);
    let categoria = categoriasValidas.has(parsed.categoria) ? parsed.categoria : 'indeterminado';

    const paresBrutos = Array.isArray(parsed.pares) ? parsed.pares : [];
    const paresComHorarioValido = paresBrutos.filter(p => horarioValido(p?.horario));
    const paresCompletos = paresComHorarioValido
        .filter(p => Number.isFinite(Number(p.quantidade)) && Number(p.quantidade) > 0)
        .map(p => ({ horario: p.horario, quantidade: Number(p.quantidade) }));

    let paresDescartados = false;
    let pares = [];

    if (categoria === 'posologia_completa') {
        if (paresCompletos.length === 0) {
            categoria = 'indeterminado';
            paresDescartados = paresBrutos.length > 0;
        } else {
            pares = paresCompletos;
        }
    } else if (categoria === 'horarios_apenas') {
        const horarios = [...new Set(paresComHorarioValido.map(p => p.horario))];
        if (horarios.length === 0) {
            categoria = 'indeterminado';
            paresDescartados = paresBrutos.length > 0;
        } else {
            pares = horarios.map(h => ({ horario: h, quantidade: 0 }));
        }
    }

    const unidadeDose = UNIDADES_DOSE_VALIDAS.has(parsed.unidade_dose) ? parsed.unidade_dose : null;

    let quantidadeUnica = Number(parsed.quantidade_unica);
    quantidadeUnica = Number.isFinite(quantidadeUnica) && quantidadeUnica > 0 ? quantidadeUnica : null;
    if (categoria === 'quantidade_apenas' && quantidadeUnica === null) categoria = 'indeterminado';

    let intervaloHoras = Number(parsed.intervalo_horas);
    intervaloHoras = Number.isFinite(intervaloHoras) && intervaloHoras > 0 ? intervaloHoras : null;
    const horarioInicio = horarioValido(parsed.horario_inicio) ? parsed.horario_inicio : null;
    if (categoria === 'frequencia_intervalo' && intervaloHoras === null) categoria = 'indeterminado';

    const formaExplicita = FORMAS_VALIDAS.has(parsed.forma_explicita) ? parsed.forma_explicita : null;

    // BUG-99 (seção 4.2 do briefing): só SINALIZA incoerência entre o que o usuário disse
    // e a unidade de dose — nunca descarta a fala do usuário. Se ele disse "comprimido" e a
    // unidade ficou "ml", quem provavelmente está errado é a unidade, não a forma; descartar
    // a forma explícita seria pior que os dois errados juntos.
    //
    // A checagem usa a unidade que esta mensagem indicou; quando ela não indicou nenhuma
    // (ex: correção em cad_confirma_forma que só fala da forma, "REGRA 3" default o campo
    // pra "unidade" mesmo sem a pessoa ter dito nada de unidade), cai na unidade JÁ
    // RESOLVIDA no contexto — sem isso, uma correção que não repete a unidade nunca seria
    // checada contra a unidade real, e a incoerência passaria batida.
    const unidadeParaChecagem = unidadeDose || unidadeDoseContexto;
    const formaExplicitaIncompativel = !formaCompativelComUnidade(formaExplicita, unidadeParaChecagem);

    return {
        paresDescartados,
        formaExplicitaIncompativel,
        resultado: {
            categoria,
            pares,
            quantidadeUnica,
            intervaloHoras,
            horarioInicio,
            unidadeDose,
            formaExplicita,
            multiplicadorAplicado: !!parsed.multiplicador_aplicado
        }
    };
}

async function classificarPosologia({ message, campoEsperado, nomeMedicamento, horariosJaColetados = [], historicoConversa = [], emCorrecao = false, unidadeDoseContexto = null }) {
    const systemPrompt = buildPosologiaSystemPrompt({ nomeMedicamento, campoEsperado, horariosJaColetados, historicoConversa, message, emCorrecao });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: classificador de posologia não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_posologia_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length, campoEsperado },
            fallback: fallbackPosologiaIndeterminada()
        });
    }

    const { resultado, paresDescartados, formaExplicitaIncompativel } = validarClassificacaoPosologia(parsed, unidadeDoseContexto);

    if (formaExplicitaIncompativel) {
        // Fire-and-forget: é só registro (degradar nunca lança e o fallback é descartado),
        // não há motivo pra bloquear a resposta do usuário nesse insert.
        degradar({
            origem: 'cadastro',
            motivo: 'forma_explicita_incompativel',
            agent: 'cadastro',
            detalhe: { forma_explicita: resultado.formaExplicita, unidade_dose: resultado.unidadeDose || unidadeDoseContexto },
            fallback: null
        });
    }

    if (paresDescartados) {
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_posologia_falhou',
            agent: 'cadastro',
            detalhe: { motivo_interno: 'todos_os_pares_descartados', campoEsperado },
            fallback: resultado
        });
    }

    console.log(`🔎 [CAD-CLASSIF] classificarPosologia -> ${resultado.categoria} `
        + `(campo: ${campoEsperado}, pares: ${resultado.pares.length}, `
        + `intervalo: ${resultado.intervaloHoras}, inicio: ${resultado.horarioInicio})`);
    return resultado;
}

// ============================================================
// MH-073 Parte B.2 — CLASSIFICADOR DE CAMPO SIMPLES (nome / dosagem)
// ============================================================

function buildCampoSimplesSystemPrompt({ campo, historicoConversa, message }) {
    const descricao = campo === 'nome'
        ? 'o NOME do medicamento'
        : 'a DOSAGEM do medicamento (a concentração, como vem no rótulo — ex: 50mg, 0,5%, 100mg/ml)';

    return `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami), que está
cadastrando um medicamento e perguntou ${descricao}.

CATEGORIAS (escolha exatamente UMA):
- valor: a mensagem contém ${descricao}. Extraia o valor tal como a pessoa escreveu (mantendo
  unidade quando houver, ex: "50mg").
- indeterminado: a mensagem não responde à pergunta, é confusa, ou é sobre outra coisa.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "categoria": "...", "valor": null }`;
}

function fallbackCampoSimplesIndeterminado() {
    return { categoria: 'indeterminado', valor: null };
}

async function extrairCampoSimples({ campo, message, historicoConversa = [] }) {
    const systemPrompt = buildCampoSimplesSystemPrompt({ campo, historicoConversa, message });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error(`❌ cadastro: classificador de campo simples (${campo}) não retornou JSON válido:`, rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_campo_simples_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length, campo },
            fallback: fallbackCampoSimplesIndeterminado()
        });
    }

    const categoria = parsed.categoria === 'valor' && typeof parsed.valor === 'string' && parsed.valor.trim()
        ? 'valor'
        : 'indeterminado';

    console.log(`🔎 [CAD-CLASSIF] extrairCampoSimples -> ${categoria} (campo: ${campo})`);
    return { categoria, valor: categoria === 'valor' ? parsed.valor.trim() : null };
}

// ============================================================
// MH-073 Parte B.2 — CLASSIFICADOR DE TIPO DE TRATAMENTO
// ============================================================

function buildTipoTratamentoSystemPrompt({ nomeMedicamento, aguardandoDias, historicoConversa, message }) {
    return `Você é um classificador de tipo de tratamento para uma assistente de saúde via WhatsApp (a
Nami). A Nami perguntou se o uso do medicamento "${nomeMedicamento || ''}" é contínuo ou
temporário${aguardandoDias ? ', e o usuário já respondeu que é temporário — agora ela está esperando por quantos dias' : ''}.

CATEGORIAS (escolha exatamente UMA):
- continuo: o usuário indicou uso contínuo, sem prazo de parada. Ex: "é contínuo", "uso pra
  sempre", "não tem previsão de parar".
- dias: o usuário informou um número de dias (implica tratamento temporário), mesmo sem dizer a
  palavra "temporário". Ex: "10 dias", "é por 7 dias", "uma semana" (=7), "duas semanas" (=14).
- temporario: o usuário indicou que é temporário mas NÃO informou quantos dias.
- indeterminado: a resposta não permite decidir nenhuma das categorias acima.

Números por extenso e expressões de tempo contam: "uma semana" = 7 dias, "duas semanas" = 14 dias,
"um mês" = 30 dias.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "categoria": "...", "dias": null }`;
}

function fallbackTipoTratamentoIndeterminado() {
    return { categoria: 'indeterminado', dias: null };
}

async function classificarTipoTratamento({ message, nomeMedicamento, aguardandoDias, historicoConversa = [] }) {
    const systemPrompt = buildTipoTratamentoSystemPrompt({ nomeMedicamento, aguardandoDias, historicoConversa, message });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: classificador de tipo de tratamento não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_tipo_tratamento_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: fallbackTipoTratamentoIndeterminado()
        });
    }

    const categoriasValidas = new Set(['continuo', 'dias', 'temporario', 'indeterminado']);
    let categoria = categoriasValidas.has(parsed.categoria) ? parsed.categoria : 'indeterminado';

    let dias = Number(parsed.dias);
    dias = Number.isFinite(dias) && dias > 0 ? dias : null;
    if (categoria === 'dias' && dias === null) categoria = 'indeterminado';

    console.log(`🔎 [CAD-CLASSIF] classificarTipoTratamento -> ${categoria} (dias: ${dias})`);
    return { categoria, dias };
}

// ADENDO MH-80 (25/08/2026), DEFEITO 2 — ponto único de decisão de avanço. Tanto o
// salto do MH-80 quanto as transições passo a passo (dosagem, confirma_forma, tipo de
// tratamento) consultam esta função, para que nenhuma etapa já resolvida no contexto
// seja perguntada de novo. Caminhos de indeterminado/repergunta NÃO a usam — eles
// devolvem a própria etapa de propósito, e substituí-los faria o fluxo avançar sem
// ter coletado o dado.
// v43 Bloco C (MH-094): ordem reescrita — have-to-have (nome + posologia) primeiro,
// gravação em seguida (ANTES de qualquer campo opcional), nice-to-have depois. dosagem,
// forma e tipo_tratamento saem do caminho obrigatório: continuam existindo (alcançáveis
// por correção no resumo, forma sempre derivada), mas nunca são perguntadas por
// iniciativa da Nami. Decisão de produto v43 (Guilherme): have-to-have é só nome +
// quantidade por dose + horário — é o mínimo pra existir um lembrete.
function primeiraEtapaFaltante(ctx) {
    // HAVE-TO-HAVE: sem estes dois não existe lembrete.
    if (!ctx?.nome) return 'cad_nome';
    if (!ctx?.pares_posologia?.length) {
        // v44 (arnês A2, P57): horários já coletados sem quantidade não voltam a
        // cad_horarios — falta só o QUANTO (mesmo destino que decidirCadHorarios
        // já dava no caso 'horarios_apenas').
        return ctx?.horarios?.length ? 'cad_quantidade_por_dose' : 'cad_horarios';
    }

    // Gravação acontece aqui, antes de qualquer campo opcional (MH-094/BUG-104/P56/P57).
    if (!ctx?.medication_id) return 'cad_gravar';

    // NICE-TO-HAVE: a partir daqui o medicamento já existe e já gera lembrete.
    // estoque_perguntado (não estoque_resolvido === null): "não sei" também RESOLVE a
    // etapa sem nunca gravar 0 (P49) — ver processarEstoque/finalizarComEstoqueDesconhecido.
    if (!ctx?.estoque_perguntado) {
        if (ctx?.unidade_estoque !== 'ml') return 'cad_estoque';

        // MH-073 Parte C: ramo líquido reordenado — status do frasco primeiro, depois
        // quantidade/fração, e o volume sempre por último (seção 5/8 do briefing).
        if (!ctx?.status_frasco) return 'cad_estoque';
        if (ctx?.status_frasco === 'fechado') {
            return (ctx?.frascos && !ctx?.volume_frasco) ? 'cad_estoque_volume' : 'cad_estoque';
        }
        const fracaoOuValorConhecido = !!ctx?.estoque_fracao_pendente
            || (ctx?.estoque_valor_exato_pendente !== undefined && ctx?.estoque_valor_exato_pendente !== null);
        return (fracaoOuValorConhecido && !ctx?.volume_frasco) ? 'cad_estoque_volume' : 'cad_estoque_fracao';
    }
    return 'cad_confirmacao';
}

function decidirCadTipoTratamento(classificacao, context) {
    switch (classificacao.categoria) {
        case 'continuo': {
            const upd = { tipo_tratamento: 'continuo', tratamento_dias: null, tipo_tratamento_pendente: false };
            return { acao: 'continuo', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
        }
        case 'dias': {
            const upd = { tipo_tratamento: 'temporario', tratamento_dias: classificacao.dias, tipo_tratamento_pendente: false };
            return { acao: 'dias_informado', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
        }
        case 'temporario':
            return {
                acao: 'temporario_sem_dias',
                proximaEtapa: 'cad_tipo_tratamento',
                contextUpdates: { tipo_tratamento_pendente: true }
            };
        default:
            return { acao: 'indeterminado', proximaEtapa: 'cad_tipo_tratamento', contextUpdates: {} };
    }
}

// ============================================================
// MH-073 Parte B.2 — CLASSIFICADOR DE CONFIRMAÇÃO DO CADASTRO
// ============================================================

function buildConfirmacaoSystemPrompt({ nomeMedicamento, historicoConversa, message }) {
    return `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami). A Nami acabou
de mostrar o resumo do cadastro do medicamento "${nomeMedicamento || ''}" e perguntou se está tudo
certo.

CATEGORIAS (escolha exatamente UMA):
- confirma: o usuário confirmou que o resumo está correto. Ex: "sim", "tá certo", "pode salvar",
  "isso mesmo", "confirmo", "beleza", "vamos".
- corrige: o usuário apontou que algo está errado ou quer mudar algo.
- indeterminado: não dá para saber se confirmou ou quer corrigir algo.

Quando a categoria for "corrige", identifique também campoAlvo — o campo que o usuário quer
mudar — exatamente um destes:
  nome, dosagem, horarios, quantidade, tipo_tratamento, estoque, forma
Exemplos:
  "o horário está errado" -> horarios
  "na verdade é às 14:40, não às 8h" -> horarios
  "a dosagem não é essa" -> dosagem
  "é pra 5 dias, não 3" -> tipo_tratamento
  "é 2 comprimidos, não 1" -> quantidade
  "o nome está errado" -> nome
  "o estoque não é esse" -> estoque
  "não é cápsula, é comprimido" -> forma
  "isso não é xarope" -> forma

ATENÇÃO — dosagem e forma são campos DIFERENTES:
  dosagem = a concentração do medicamento (50mg, 0,5%, 100mg/ml)
  forma   = o formato farmacêutico (comprimido, cápsula, xarope, colírio, gotas, pomada, injetável)
"não é cápsula, é comprimido" corrige a FORMA, nunca a dosagem.

Se a categoria for "corrige" mas não der para saber qual campo, campoAlvo = null.
Se a categoria não for "corrige", campoAlvo = null.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "categoria": "...", "campoAlvo": null }`;
}

function fallbackConfirmacaoIndeterminada() {
    return { categoria: 'indeterminado', campoAlvo: null };
}

async function classificarConfirmacaoCadastro({ message, nomeMedicamento, historicoConversa = [] }) {
    const systemPrompt = buildConfirmacaoSystemPrompt({ nomeMedicamento, historicoConversa, message });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: classificador de confirmação não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_confirmacao_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: fallbackConfirmacaoIndeterminada()
        });
    }

    const categoriasValidas = new Set(['confirma', 'corrige', 'indeterminado']);
    const categoria = categoriasValidas.has(parsed.categoria) ? parsed.categoria : 'indeterminado';

    const camposValidos = new Set(['nome', 'dosagem', 'horarios', 'quantidade', 'tipo_tratamento', 'estoque', 'forma']);
    const campoAlvo = camposValidos.has(parsed.campoAlvo) ? parsed.campoAlvo : null;

    if (categoria === 'corrige' && campoAlvo === null) {
        // "corrige" sem campo identificável é uma anomalia de classificação (não um "não
        // entendi" comum, que é 'indeterminado') — degrada para investigação. O fallback
        // continua pedindo esclarecimento ao usuário, nunca finge confirmação.
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_confirmacao_falhou',
            agent: 'cadastro',
            detalhe: { motivo_interno: 'corrige_sem_campo_alvo' },
            fallback: fallbackConfirmacaoIndeterminada()
        });
    }

    console.log(`🔎 [CAD-CLASSIF] classificarConfirmacaoCadastro -> ${categoria} (campoAlvo: ${campoAlvo})`);
    return { categoria, campoAlvo };
}

// ============================================================
// v36 #3 — EXTRAÇÃO DE FORMA NA MENSAGEM DE CORREÇÃO
// ============================================================
//
// Usado só quando campoAlvo === 'forma' em cad_confirmacao. A mensagem de correção quase
// sempre JÁ contém a forma certa ("não é cápsula, é comprimido") — extrair aqui evita um
// turno inteiro de repergunta (briefing v36 #3, seção 2.2).

function buildExtrairFormaSystemPrompt({ nomeMedicamento, historicoConversa, message }) {
    return `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami). O usuário
acabou de dizer que a FORMA FARMACÊUTICA do medicamento "${nomeMedicamento || ''}" está errada no
resumo do cadastro, e a mensagem abaixo é a correção.

Identifique a forma farmacêutica correta que o usuário mencionou, exatamente uma destas:
comprimido, capsula, colirio, gotas, pomada, injetavel, xarope.

Se a mensagem não mencionar nenhuma forma reconhecível (ex: só disse "a forma está errada" sem
dizer qual é), responda null. Não confunda com dosagem (concentração) — extraia só a forma.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "forma": null }`;
}

async function extrairFormaDaMensagem(message, historicoConversa = [], nomeMedicamento = null) {
    const systemPrompt = buildExtrairFormaSystemPrompt({ nomeMedicamento, historicoConversa, message });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: extração de forma na correção não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_forma_correcao_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: null
        });
    }

    const forma = FORMAS_VALIDAS.has(parsed.forma) ? parsed.forma : null;
    console.log(`🔎 [CAD-CLASSIF] extrairFormaDaMensagem -> ${forma}`);
    return forma;
}

// Reaplica a posologia corrigida a partir de cad_confirmacao. Recalcula o alerta de
// estoque (a quantidade por dose pode ter mudado) e regenera o resumo — o fluxo volta
// para cad_confirmacao já mostrando o resumo atualizado, sem repetir perguntas já
// respondidas (BUG-91, seção 6.4 do briefing).
async function corrigirPosologiaEmConfirmacao(campoAlvo, classificacao, context) {
    const horariosAtuais = (context?.pares_posologia || []).map(p => p.horario);

    // v43 Bloco C (MH-094, Parte 4): cad_confirmacao só existe depois da gravação
    // antecipada — o registro já existe. A correção escreve NELE direto (nunca só no
    // rascunho — P56/P57) e o resumo é remontado a partir do que ficou gravado.
    const aplicarNovosPares = async (pares, extra = {}) => {
        const unidades = derivarUnidades(classificacao.unidadeDose || context?.unidade_dose || 'unidade');
        const contextUpdates = {
            pares_posologia: pares,
            horarios: pares.map(p => p.horario),
            unidade_dose: unidades.unidade_dose,
            unidade_estoque: unidades.unidade_estoque,
            gotas_por_ml: unidades.gotas_por_ml,
            ...extra
        };

        if (!context?.medication_id) {
            // Invariante MH-094: cad_confirmacao só é alcançada após a gravação
            // antecipada (Parte 3.1) — chegar aqui sem medication_id não deveria ocorrer.
            return degradar({
                origem: 'cadastro',
                motivo: 'correcao_posologia_sem_medication_id',
                agent: 'cadastro',
                detalhe: { campoAlvo },
                fallback: { acao: 'indeterminado', proximaEtapa: 'cad_confirmacao', contextUpdates: {} }
            });
        }

        await replaceMedication({ medicationId: context.medication_id, horarios: pares });
        if (unidades.unidade_dose !== context?.unidade_dose) {
            await atualizarMedicamentoCampos({
                medicationId: context.medication_id,
                campos: {
                    unidade_dose: unidades.unidade_dose,
                    unidade_estoque: unidades.unidade_estoque,
                    gotas_por_ml: unidades.gotas_por_ml
                }
            });
        }

        // P49: estoque "não sei" (estoque_perguntado true, estoque_resolvido null) NUNCA
        // vira "0" aqui — sem contagem real não há alerta de estoque baixo pra calcular.
        // Reproduziu, num teste de staging, exatamente o bug que este briefing corrige:
        // "seu estoque está zerado" para um estoque que na verdade nunca foi informado.
        const estoqueConhecido = context?.estoque_perguntado && context?.estoque_resolvido === null
            ? null
            : (context?.estoque_resolvido ?? null);
        contextUpdates.alerta_estoque_baixo = estoqueConhecido === null
            ? null
            : calcularAlertaEstoque({ ...context, ...contextUpdates }, estoqueConhecido);

        const { resumo } = await montarResumoDoBanco(context.medication_id);
        return {
            acao: 'posologia_corrigida',
            proximaEtapa: 'cad_confirmacao',
            contextUpdates,
            resumoRenderizado: resumo
        };
    };

    // Ambíguo (contagem de horários não bate) — nunca chuta quantidade, avança para
    // repreguntá-la (a etapa nunca trava, seção 6.3 do briefing).
    const aplicarGradeAmbigua = (horarios, extra = {}) => ({
        acao: 'horarios_corrigidos',
        proximaEtapa: 'cad_quantidade_por_dose',
        contextUpdates: { horarios, pares_posologia: null, ...extra }
    });

    if (classificacao.categoria === 'posologia_completa') {
        const expandido = expandirParesPorIntervalo(classificacao);
        if (expandido) {
            return aplicarNovosPares(expandido.pares, { intervalo_horas: expandido.intervalo_horas, horario_inicio: expandido.horario_inicio });
        }
        return aplicarNovosPares(classificacao.pares);
    }

    // BUG-98: quando dá pra identificar com segurança que a correção trocou o início de
    // um intervalo já declarado, a grade INTEIRA é recalculada em código a partir do novo
    // início — nunca a lista "recalculada" pelo LLM (dado de saúde, princípio 28). Quando
    // não dá (correção mira outra dose, ou não há intervalo), cai no remapeamento simples.
    if (campoAlvo === 'horarios' && classificacao.categoria === 'horarios_apenas') {
        const { horarios, pares, extra } = resolverCorrecaoHorariosApenas(
            context?.pares_posologia, classificacao.pares, context?.intervalo_horas, context?.horario_inicio
        );
        return pares ? aplicarNovosPares(pares, extra) : aplicarGradeAmbigua(horarios, extra);
    }

    // BUG-96: frequência/intervalo corrigida a partir da confirmação ("de 8 em 8hrs
    // começando às 16hrs"). Com horário de início, recalcula a grade e remapeia as
    // quantidades; sem início, avança para cad_horarios (que já sabe pedir só a
    // primeira dose quando intervalo_horas está preenchido sem horario_inicio).
    if (campoAlvo === 'horarios' && classificacao.categoria === 'frequencia_intervalo') {
        // v36 Briefing #1, seção 3.3: início em cascata — a mensagem pode não repetir o
        // horário de início que já foi confirmado antes (só "de 8 em 8hrs", sem "comecei
        // às X"). Cai no que o contexto já sabe: horario_inicio persistido, ou o primeiro
        // par já confirmado (o primeiro cronologicamente só quando a grade tem um único
        // horário — ver ⚠️ do briefing sobre a ordenação de pares_posologia).
        const inicio = classificacao.horarioInicio
            || context?.horario_inicio
            || (context?.pares_posologia?.[0]?.horario ?? null);
        if (inicio) {
            const grade = recalcularGradePorIntervalo(context?.pares_posologia, inicio, classificacao.intervaloHoras);
            if (grade) {
                const extra = { intervalo_horas: classificacao.intervaloHoras, horario_inicio: inicio };
                return grade.pares ? aplicarNovosPares(grade.pares, extra) : aplicarGradeAmbigua(grade.horarios, extra);
            }
        }
        return {
            acao: 'frequencia_sem_inicio',
            proximaEtapa: 'cad_horarios',
            contextUpdates: { intervalo_horas: classificacao.intervaloHoras }
        };
    }

    if (campoAlvo === 'quantidade' && classificacao.categoria === 'quantidade_apenas') {
        const pares = montarParesPosologia(horariosAtuais, classificacao.quantidadeUnica);
        return aplicarNovosPares(pares);
    }

    return { acao: 'indeterminado', proximaEtapa: 'cad_confirmacao', contextUpdates: {} };
}

// ============================================================
// MH-073 Parte B.2 — SUGESTÃO DE FORMA FARMACÊUTICA (palpite silencioso)
// ============================================================
//
// Usado só quando a forma não veio explícita na posologia (cad_confirma_forma).
// O palpite nunca é falado na pergunta — é guardado em forma_sugerida como
// default silencioso, usado por decidirCadConfirmaForma se o usuário não corrigir.

function buildFormaSugeridaSystemPrompt({ nomeMedicamento }) {
    return `Você ajuda a inferir a forma farmacêutica mais provável de um medicamento a partir do
nome comercial ou princípio ativo. Isto é só um palpite inicial — o usuário vai confirmar depois.

Medicamento: "${nomeMedicamento || ''}"

Formas possíveis: comprimido, capsula, colirio, gotas, pomada, injetavel, xarope.
Se não for possível inferir com confiança razoável, responda null.

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{ "forma": null }`;
}

async function sugerirFormaFarmaceutica({ nomeMedicamento }) {
    const systemPrompt = buildFormaSugeridaSystemPrompt({ nomeMedicamento });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        system: systemPrompt,
        messages: [{ role: 'user', content: nomeMedicamento || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: sugestão de forma farmacêutica não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_forma_sugerida_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: null
        });
    }

    return FORMAS_VALIDAS.has(parsed.forma) ? parsed.forma : null;
}

// ============================================================
// MH-80 (briefing MH-073 Parte B.3, seção 5) — EXTRAÇÃO COMPLETA NA
// PRIMEIRA MENSAGEM DO CADASTRO
// ============================================================

function buildCadastroCompletoSystemPrompt({ historicoConversa, message }) {
    return `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami), que está
começando o cadastro de um medicamento. O usuário pode ter enviado, numa única mensagem, várias
informações além do nome do medicamento.

Sua tarefa é extrair APENAS o que estiver EXPLÍCITO na mensagem. Campo ausente -> null. NUNCA
infira dosagem a partir do nome, nem quantidade a partir do estoque, nem forma a partir do nome.

Reaproveite estas regras (as mesmas usadas na coleta normal de posologia):
- Números precedidos de "às"/"as" são HORÁRIOS, nunca quantidade.
- Quando a dose é aplicada em mais de um sítio (ex: "em cada olho"), a quantidade já vem
  multiplicada (ex: "2 gotas em cada olho" -> quantidade 4).
- Resposta em mg/mcg/g/% é DOSAGEM (concentração), nunca quantidade por dose ou estoque.

REGRAS ADICIONAIS:
- intervaloHoras: quando a pessoa disser frequência regular sem horários explícitos.
  "de 12 em 12 horas" / "12/12 hrs" -> 12    "de 8 em 8h" -> 8
  "3 vezes ao dia" -> 8                      "2x ao dia" -> 12
  "uma vez ao dia" -> 24
- horarioInicio: só quando a pessoa disser onde a grade começa ("começando às 8h",
  "a primeira às 7"). Se ela não disser, deixe null — NUNCA invente o início.
- statusFrasco: só para estoque líquido, quando a pessoa disser explicitamente se o frasco já
  está aberto/em uso ("já uso", "já abri", "tá pela metade" -> "aberto") ou ainda fechado/lacrado
  ("ainda fechado", "lacrado", "nunca abri" -> "fechado"). Sem menção, deixe null.
- fracaoEstoque: só quando statusFrasco for "aberto" e a pessoa disser quanto ainda resta —
  um destes valores: recem_aberto | tres_quartos | metade | um_quarto | quase_acabando | nao_sei.
  Sem essa informação, deixe null.
- quantidadeUnica: a quantidade por dose quando ela NÃO estiver amarrada a um horário
  específico. "vou tomar 5ml de 12/12 hrs" -> quantidadeUnica: 5, unidadeDose: "ml".
  Se a quantidade já estiver em "pares", deixe quantidadeUnica null.
- tipoTratamento: expressão de duração JÁ determina o tipo.
  "por 6 dias" / "durante 6 dias" / "por 6 dias seguidos" -> temporario, tratamentoDias 6
  "por uma semana" -> temporario, 7      "por 15 dias" -> temporario, 15
  "todo dia" / "de uso contínuo" / "sempre" / "pra sempre" -> continuo, tratamentoDias null
  Sem indicação de duração -> null.

CAMPOS A EXTRAIR:
- nome: nome do medicamento.
- dosagem: a concentração, como no rótulo (ex: "50mg").
- pares: lista de {"horario": "HH:MM", "quantidade": 0} — só quando horário E quantidade
  estiverem explícitos juntos para o mesmo horário.
- intervaloHoras: número de horas entre doses (ver REGRAS ADICIONAIS), só quando NÃO houver
  horários explícitos.
- horarioInicio: "HH:MM" do início da grade, só quando dito explicitamente (ver REGRAS
  ADICIONAIS).
- quantidadeUnica: quantidade por dose sem horário associado (ver REGRAS ADICIONAIS).
- unidadeDose: "unidade" | "gota" | "ml", derivada do que a pessoa disse.
- formaExplicita: comprimido | capsula | colirio | gotas | pomada | injetavel | xarope | null —
  só quando a pessoa NOMEOU a forma.
- estoqueQuantidade: total em unidades já multiplicado (ex: "1 caixa com 30" -> 30), só quando a
  forma de estoque for sólida/contável.
- frascos e volumeFrasco: só para estoque líquido (ex: "1 vidro de 100ml" -> frascos:1,
  volumeFrasco:100). Se o frasco já estiver aberto (statusFrasco: "aberto"), volumeFrasco ainda
  pode vir (tamanho do frasco, ex: "é de 60ml"), mas frascos não se aplica — deixe null.
- statusFrasco e fracaoEstoque: ver REGRAS ADICIONAIS.
- tipoTratamento: "continuo" | "temporario" | null (ver REGRAS ADICIONAIS).
- tratamentoDias: número de dias, só quando explícito e o tratamento for temporário.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{
  "nome": null, "dosagem": null, "pares": [], "intervaloHoras": null, "horarioInicio": null,
  "quantidadeUnica": null, "unidadeDose": null, "formaExplicita": null,
  "estoqueQuantidade": null, "frascos": null, "volumeFrasco": null, "statusFrasco": null,
  "fracaoEstoque": null, "tipoTratamento": null, "tratamentoDias": null
}`;
}

function fallbackCadastroCompleto() {
    return {
        nome: null, dosagem: null, pares: [], intervaloHoras: null, horarioInicio: null,
        quantidadeUnica: null, unidadeDose: null, formaExplicita: null,
        estoqueQuantidade: null, frascos: null, volumeFrasco: null, statusFrasco: null,
        fracaoEstoque: null, tipoTratamento: null, tratamentoDias: null
    };
}

// MH-80 é aceleração, nunca caminho obrigatório: se a extração falhar (degradar()), o
// fallback devolve nome: null e o chamador (decidirEtapa) segue exatamente como hoje —
// pergunta o nome de novo pelo classificador simples de sempre.
async function extrairCadastroCompleto({ message, historicoConversa = [] }) {
    const systemPrompt = buildCadastroCompletoSystemPrompt({ historicoConversa, message });

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || '' }]
    });

    const rawText = response.content[0]?.text || '';
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error('❌ cadastro: extração de cadastro completo (MH-80) não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'extracao_cadastro_completo_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: fallbackCadastroCompleto()
        });
    }

    const paresBrutos = Array.isArray(parsed.pares) ? parsed.pares : [];
    const pares = paresBrutos
        .filter(p => horarioValido(p?.horario) && Number.isFinite(Number(p?.quantidade)) && Number(p.quantidade) > 0)
        .map(p => ({ horario: p.horario, quantidade: Number(p.quantidade) }));

    const unidadeDose = UNIDADES_DOSE_VALIDAS.has(parsed.unidadeDose) ? parsed.unidadeDose : null;
    const formaExplicita = FORMAS_VALIDAS.has(parsed.formaExplicita) ? parsed.formaExplicita : null;

    // Zero é estoque LEGÍTIMO (mesmo colapso do BUG-97) — `Number(null) === 0`, então o
    // campo só é aceito quando realmente veio preenchido no JSON, nunca por conversão de
    // ausência. Campo ausente tem que sobreviver como null até cad_estoque perguntar.
    let estoqueQuantidade = null;
    if (typeof parsed.estoqueQuantidade === 'number' || typeof parsed.estoqueQuantidade === 'string') {
        const n = Number(parsed.estoqueQuantidade);
        estoqueQuantidade = Number.isFinite(n) && n >= 0 ? n : null;
    }

    let frascos = Number(parsed.frascos);
    frascos = Number.isFinite(frascos) && frascos > 0 ? frascos : null;
    let volumeFrasco = Number(parsed.volumeFrasco);
    volumeFrasco = Number.isFinite(volumeFrasco) && volumeFrasco > 0 ? volumeFrasco : null;

    // MH-073 Parte C (seção 8): status do frasco e fração de estoque, reconhecidos se
    // já vierem na mensagem inicial rica ("já uso, tá acabando, é de 60ml").
    const statusFrasco = ['aberto', 'fechado'].includes(parsed.statusFrasco) ? parsed.statusFrasco : null;
    const fracoesValidas = new Set([...Object.keys(FRACOES_ESTOQUE), 'nao_sei']);
    const fracaoEstoque = fracoesValidas.has(parsed.fracaoEstoque) ? parsed.fracaoEstoque : null;

    const tipoTratamento = ['continuo', 'temporario'].includes(parsed.tipoTratamento) ? parsed.tipoTratamento : null;
    let tratamentoDias = Number(parsed.tratamentoDias);
    tratamentoDias = Number.isFinite(tratamentoDias) && tratamentoDias > 0 ? tratamentoDias : null;

    // intervaloHoras/horarioInicio/quantidadeUnica (briefing MH-80 correção, seção 3.1):
    // mesmos limites determinísticos usados em validarClassificacaoPosologia. Zero NÃO é
    // quantidade de dose válida (diferente de estoque, onde zero é legítimo — BUG-97).
    let intervaloHoras = Number(parsed.intervaloHoras);
    intervaloHoras = Number.isFinite(intervaloHoras) && intervaloHoras > 0 && intervaloHoras <= 24
        ? intervaloHoras : null;

    const horarioInicio = horarioValido(parsed.horarioInicio) ? parsed.horarioInicio : null;

    let quantidadeUnica = Number(parsed.quantidadeUnica);
    quantidadeUnica = Number.isFinite(quantidadeUnica) && quantidadeUnica > 0 ? quantidadeUnica : null;

    const resultado = {
        nome: typeof parsed.nome === 'string' && parsed.nome.trim() ? parsed.nome.trim() : null,
        dosagem: typeof parsed.dosagem === 'string' && parsed.dosagem.trim() ? parsed.dosagem.trim() : null,
        pares,
        intervaloHoras,
        horarioInicio,
        quantidadeUnica,
        unidadeDose,
        formaExplicita,
        estoqueQuantidade,
        frascos,
        volumeFrasco,
        statusFrasco,
        fracaoEstoque,
        tipoTratamento,
        tratamentoDias: tipoTratamento === 'temporario' ? tratamentoDias : null
    };

    // Nunca logar VALORES (dado de saúde) — só quais chaves vieram preenchidas.
    const chavesPreenchidas = Object.entries(resultado)
        .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== null))
        .map(([k]) => k);
    console.log(`🔎 [CAD-CLASSIF] extrairCadastroCompleto -> campos: [${chavesPreenchidas.join(', ')}]`);

    return resultado;
}

// ============================================================
// MH-073 Parte B — DECISÃO DE ETAPA (código decide, LLM só fraseia)
// ============================================================

function decidirCadHorarios(classificacao, context) {
    const quantidadePendente = context?.quantidade_pendente ?? null;

    const resolverComHorarios = (horarios) => {
        if (quantidadePendente !== null) {
            // O usuário já respondeu a quantidade adiantado, numa mensagem anterior
            // de cad_horarios (categoria quantidade_apenas) — não repergunta.
            const unidades = derivarUnidades(context?.unidade_dose_pendente || 'unidade');
            const pares = montarParesPosologia(horarios, quantidadePendente);
            const formaExplicita = context?.forma_explicita_pendente || null;
            const upd = {
                horarios, pares_posologia: pares,
                unidade_dose: unidades.unidade_dose,
                unidade_estoque: unidades.unidade_estoque,
                gotas_por_ml: unidades.gotas_por_ml,
                forma_explicita: formaExplicita,
                quantidade_pendente: null, unidade_dose_pendente: null, forma_explicita_pendente: null
            };
            return {
                acao: 'horarios_completados_com_quantidade_pendente',
                proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }),
                contextUpdates: upd
            };
        }
        return {
            acao: 'horarios_apenas',
            proximaEtapa: 'cad_quantidade_por_dose',
            contextUpdates: { horarios }
        };
    };

    // Estado "aguardando horário da primeira dose" (viemos de frequencia_sem_inicio).
    // A resposta do usuário aqui é só uma hora ("19h", "de manhã") — não necessariamente
    // reclassificada como frequencia_intervalo pelo classificador. Aceita o primeiro
    // horário reconhecido em QUALQUER categoria que traga horário.
    if (context?.intervalo_horas && !context?.horario_inicio) {
        const candidato = classificacao.horarioInicio || (classificacao.pares[0] && classificacao.pares[0].horario) || null;
        if (candidato) {
            const horarios = calcularHorariosPorIntervalo(candidato, context.intervalo_horas);
            if (horarios.length > 0) {
                const decisao = resolverComHorarios(horarios);
                decisao.contextUpdates.intervalo_horas = context.intervalo_horas;
                decisao.contextUpdates.horario_inicio = candidato;
                return decisao;
            }
        }
        // Correção #6 (v36 #2, seção 6): a mensagem pode trazer, além do horário (que não
        // veio), a quantidade adiantada ("5ml") — sem isso, ela era descartada e o usuário
        // tinha que repetir depois. Mesmos campos que o case 'quantidade_apenas' persiste.
        return {
            acao: 'frequencia_sem_inicio',
            proximaEtapa: 'cad_horarios',
            contextUpdates: {
                intervalo_horas: context.intervalo_horas,
                ...(classificacao.quantidadeUnica ? {
                    quantidade_pendente: classificacao.quantidadeUnica,
                    unidade_dose_pendente: classificacao.unidadeDose,
                    forma_explicita_pendente: classificacao.formaExplicita
                } : {})
            }
        };
    }

    switch (classificacao.categoria) {
        case 'posologia_completa': {
            const unidades = derivarUnidades(classificacao.unidadeDose || 'unidade');
            const expandido = expandirParesPorIntervalo(classificacao);
            const paresFinais = expandido ? expandido.pares : classificacao.pares;
            const upd = {
                horarios: paresFinais.map(p => p.horario),
                pares_posologia: paresFinais,
                unidade_dose: unidades.unidade_dose,
                unidade_estoque: unidades.unidade_estoque,
                gotas_por_ml: unidades.gotas_por_ml,
                forma_explicita: classificacao.formaExplicita || null,
                ...(expandido ? { intervalo_horas: expandido.intervalo_horas, horario_inicio: expandido.horario_inicio } : {})
            };
            return { acao: 'posologia_completa', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
        }
        case 'horarios_apenas':
            return resolverComHorarios(classificacao.pares.map(p => p.horario));
        case 'frequencia_intervalo': {
            if (classificacao.horarioInicio) {
                const horarios = calcularHorariosPorIntervalo(classificacao.horarioInicio, classificacao.intervaloHoras);
                if (horarios.length > 0) {
                    const decisao = resolverComHorarios(horarios);
                    decisao.contextUpdates.intervalo_horas = classificacao.intervaloHoras;
                    decisao.contextUpdates.horario_inicio = classificacao.horarioInicio;
                    return decisao;
                }
            }
            return {
                acao: 'frequencia_sem_inicio',
                proximaEtapa: 'cad_horarios',
                contextUpdates: { intervalo_horas: classificacao.intervaloHoras }
            };
        }
        case 'quantidade_apenas':
            return {
                acao: 'quantidade_apenas_precoce',
                proximaEtapa: 'cad_horarios',
                contextUpdates: {
                    quantidade_pendente: classificacao.quantidadeUnica,
                    unidade_dose_pendente: classificacao.unidadeDose,
                    forma_explicita_pendente: classificacao.formaExplicita
                }
            };
        default:
            return { acao: 'indeterminado', proximaEtapa: 'cad_horarios', contextUpdates: {} };
    }
}

function decidirCadQuantidade(classificacao, context) {
    const horariosJaColetados = context?.horarios || [];

    switch (classificacao.categoria) {
        case 'quantidade_apenas': {
            const unidades = derivarUnidades(classificacao.unidadeDose || 'unidade');
            const pares = montarParesPosologia(horariosJaColetados, classificacao.quantidadeUnica);
            const upd = {
                pares_posologia: pares,
                unidade_dose: unidades.unidade_dose,
                unidade_estoque: unidades.unidade_estoque,
                gotas_por_ml: unidades.gotas_por_ml,
                forma_explicita: classificacao.formaExplicita || null
            };
            return { acao: 'quantidade_apenas', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
        }
        case 'posologia_completa': {
            const unidades = derivarUnidades(classificacao.unidadeDose || 'unidade');
            const expandido = expandirParesPorIntervalo(classificacao);
            const paresFinais = expandido ? expandido.pares : classificacao.pares;
            const upd = {
                horarios: paresFinais.map(p => p.horario),
                pares_posologia: paresFinais,
                unidade_dose: unidades.unidade_dose,
                unidade_estoque: unidades.unidade_estoque,
                gotas_por_ml: unidades.gotas_por_ml,
                forma_explicita: classificacao.formaExplicita || null,
                ...(expandido ? { intervalo_horas: expandido.intervalo_horas, horario_inicio: expandido.horario_inicio } : {})
            };
            return { acao: 'posologia_completa', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
        }
        case 'horarios_apenas':
            return {
                acao: 'horarios_corrigidos',
                proximaEtapa: 'cad_quantidade_por_dose',
                contextUpdates: { horarios: classificacao.pares.map(p => p.horario) }
            };
        default:
            return { acao: 'indeterminado', proximaEtapa: 'cad_quantidade_por_dose', contextUpdates: {} };
    }
}

function respostaConfirmaSimples(message) {
    const msg = String(message).toLowerCase().trim();
    const termos = ['sim', 'isso', 'isso mesmo', 'e isso', 'é isso', 'ok', 'ta', 'tá', 'esta certo',
        'está certo', 'certo', 'correto', 'pode', 'confirmo', 'confirmado', 'isso ai', 'isso aí', 'beleza'];
    return termos.some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ','));
}

// Etapa cad_confirma_forma NUNCA bloqueia (seção 6.3) — qualquer resposta avança.
//
// BUG-95 (briefing Parte B.3, seção 3.1): o classificador de posologia devolve 5
// categorias possíveis nesta etapa, mas só `posologia_completa` era tratada — uma
// correção de só horário ("na vdd vai começar às 16hrs") ou de frequência ("de 8 em
// 8hrs") caía direto no fallback genérico e era descartada em silêncio.
function decidirCadConfirmaForma(classificacao, message, context) {
    if (classificacao.categoria === 'posologia_completa' && classificacao.pares.length > 0) {
        const expandido = expandirParesPorIntervalo(classificacao);
        const paresFinais = expandido ? expandido.pares : classificacao.pares;
        const upd = {
            pares_posologia: paresFinais,
            // Correção #2 (v36 #2, seção 2): forma_sugerida é sempre null em líquidos
            // sem a forma no nome (BUG-99 descarta o palpite incompatível) — persistir
            // null aqui travava primeiraEtapaFaltante de volta em cad_confirma_forma.
            // 'generico' é o mesmo sentinela já usado na decisão em memória.
            forma_confirmada: classificacao.formaExplicita || context?.forma_sugerida || 'generico',
            ...(expandido ? { intervalo_horas: expandido.intervalo_horas, horario_inicio: expandido.horario_inicio } : {})
        };
        // v43 Bloco C: cad_tipo_tratamento saiu do caminho obrigatório —
        // primeiraEtapaFaltante decide (normalmente volta direto pra cad_confirmacao,
        // já que este sub-fluxo só é alcançado com medication_id já existindo).
        return { acao: 'quantidade_corrigida', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
    }

    if (classificacao.categoria === 'horarios_apenas' && classificacao.pares.length > 0) {
        // BUG-98: mesma lógica de corrigirPosologiaEmConfirmacao — recalcula em código a
        // partir de um intervalo já declarado só quando dá pra identificar com segurança
        // que foi o início que mudou; senão remapeia por posição ordenada.
        const { horarios, pares, extra } = resolverCorrecaoHorariosApenas(
            context?.pares_posologia, classificacao.pares, context?.intervalo_horas, context?.horario_inicio
        );
        if (pares) {
            const upd = {
                horarios,
                pares_posologia: pares,
                forma_confirmada: context?.forma_sugerida || 'generico',
                ...extra
            };
            return { acao: 'horarios_corrigidos', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
        }
        return {
            acao: 'horarios_corrigidos_ambiguo',
            proximaEtapa: 'cad_quantidade_por_dose',
            contextUpdates: { horarios, pares_posologia: null, ...extra }
        };
    }

    if (classificacao.categoria === 'frequencia_intervalo') {
        // v36 Briefing #1, seção 3.3: mesma cascata de início de corrigirPosologiaEmConfirmacao.
        const inicio = classificacao.horarioInicio
            || context?.horario_inicio
            || (context?.pares_posologia?.[0]?.horario ?? null);
        if (inicio) {
            const grade = recalcularGradePorIntervalo(context?.pares_posologia, inicio, classificacao.intervaloHoras);
            if (grade) {
                const extra = { intervalo_horas: classificacao.intervaloHoras, horario_inicio: inicio };
                if (grade.pares) {
                    const upd = { horarios: grade.horarios, pares_posologia: grade.pares, forma_confirmada: context?.forma_sugerida || 'generico', ...extra };
                    return { acao: 'horarios_corrigidos', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
                }
                return {
                    acao: 'horarios_corrigidos_ambiguo',
                    proximaEtapa: 'cad_quantidade_por_dose',
                    contextUpdates: { horarios: grade.horarios, pares_posologia: null, ...extra }
                };
            }
        }
        return {
            acao: 'frequencia_sem_inicio',
            proximaEtapa: 'cad_horarios',
            contextUpdates: { intervalo_horas: classificacao.intervaloHoras }
        };
    }

    if (classificacao.formaExplicita) {
        const upd = { forma_confirmada: classificacao.formaExplicita };
        return {
            acao: 'forma_corrigida',
            proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }),
            contextUpdates: upd
        };
    }
    // confirmação explícita OU qualquer outra coisa (rótulo genérico, nunca trava).
    // Correção #2 (v36 #2, seção 2): forma_confirmada NUNCA persiste null — quando não
    // há forma_sugerida (líquido sem forma no nome), grava o sentinela 'generico', que
    // `primeiraEtapaFaltante` (check `!ctx?.forma_confirmada`) já trata como truthy.
    const upd = { forma_confirmada: context?.forma_sugerida || 'generico' };
    return {
        acao: respostaConfirmaSimples(message) ? 'confirmado' : 'avanca_sem_confirmacao_clara',
        proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }),
        contextUpdates: upd
    };
}

// Cancelamento é deterministico como o resto do fluxo (MH-073 Parte B.2, seção 6): o
// LLM não decide mais transições, então "deixa pra lá" não pode depender dele reconhecer
// a intenção e devolver proximaEtapa: idle — o código reconhece e encerra diretamente.
const TERMOS_CANCELAMENTO = [
    'cancela', 'cancelar', 'deixa pra lá', 'deixa pra la', 'deixa quieto', 'esquece isso',
    'esquece', 'desiste', 'não quero mais', 'nao quero mais'
];

function ehCancelamento(message) {
    const msg = String(message).toLowerCase().trim();
    return TERMOS_CANCELAMENTO.some(t => msg === t || msg.startsWith(t + ' ') || msg.startsWith(t + ','));
}

// Dispatcher central: para CADA etapa, decide em código a próxima etapa e as
// atualizações de contexto. contextParaPrompt carrega só dado efêmero de fraseio
// (nunca persistido em conversation_state) — ver handleCadastro.
// O palpite de forma precisa existir ANTES de renderizar o bloco de cad_confirma_forma —
// compartilhado entre o fluxo normal (cad_horarios/cad_quantidade_por_dose) e o salto do
// MH-80 (cad_nome). BUG-99: o palpite passa pela checagem de coerência com a unidade de
// dose já resolvida antes de ser aceito — nunca chega a aparecer na confirmação se for
// incompatível (ex: "comprimido" sugerido para uma unidade "ml").
async function prepararContextoConfirmaForma(contextFinal, contextUpdates, nomeMedicamento) {
    if (!contextFinal.forma_explicita) {
        // Decisão 2.2 da Parte B: a inferência NUNCA entra na pergunta (moldaria a
        // resposta), mas SEMPRE é submetida ao usuário na confirmação.
        let palpite = await sugerirFormaFarmaceutica({ nomeMedicamento });
        if (palpite && !formaCompativelComUnidade(palpite, contextFinal.unidade_dose)) {
            // Fire-and-forget: é só registro (degradar nunca lança e o fallback é
            // descartado), não há motivo pra bloquear a resposta do usuário nesse insert.
            degradar({
                origem: 'cadastro',
                motivo: 'palpite_forma_incompativel',
                agent: 'cadastro',
                detalhe: { palpite, unidade_dose: contextFinal.unidade_dose },
                fallback: null
            });
            palpite = null;
        }
        contextFinal.forma_sugerida = palpite;
        contextUpdates.forma_sugerida = palpite;
    }
    const rotulo = rotuloDaDose(contextFinal.unidade_dose, ROTULO_CANONICO[contextFinal.forma_sugerida] || null);
    return renderizarBlocoPosologia(contextFinal.pares_posologia, rotulo);
}

// MH-80 (briefing Parte B.3, seção 5): aproveita dados completos informados já na
// primeira mensagem do cadastro, evitando repreguntar o que já veio explícito. NÃO pula
// nenhuma etapa que ficou faltando no meio — cada campo extraído é gravado no contexto
// independente de qual é a "próxima etapa"; a próxima etapa é sempre a primeira faltante
// na ordem canônica, então nada do que já veio é reperguntado depois.
function montarSaltoCadastroCompleto(completo) {
    const contextUpdates = { nome: completo.nome };
    if (completo.dosagem) contextUpdates.dosagem = completo.dosagem;

    // A unidade de dose é conhecida sempre que a pessoa disser QUANTO ("5ml"),
    // mesmo sem horário. Amarrar isso a `pares` descartava estoque líquido já
    // extraído — foi o que perdeu "1 vidro de 100ml" no teste de 21/08.
    const temInfoDose = completo.pares.length > 0 || completo.quantidadeUnica !== null
        || completo.unidadeDose !== null;
    const unidades = temInfoDose ? derivarUnidades(completo.unidadeDose || 'unidade') : null;

    if (unidades) {
        contextUpdates.unidade_dose = unidades.unidade_dose;
        contextUpdates.unidade_estoque = unidades.unidade_estoque;
        contextUpdates.gotas_por_ml = unidades.gotas_por_ml;
        contextUpdates.forma_explicita = completo.formaExplicita || null;
    }

    // Reaproveita a função determinística do BUG-041 — nunca recalcular a grade aqui.
    let pares = completo.pares;
    if (pares.length === 0 && completo.intervaloHoras && completo.horarioInicio) {
        const horarios = calcularHorariosPorIntervalo(completo.horarioInicio, completo.intervaloHoras);
        if (completo.quantidadeUnica !== null) {
            pares = horarios.map(h => ({ horario: h, quantidade: completo.quantidadeUnica }));
        } else {
            contextUpdates.horarios = horarios;
        }
    }
    // v44 (arnês A2, P57): horário solto SEM intervalo ("Lamotrigina, 8h") é O horário
    // do remédio — descartá-lo fazia a pessoa repetir o que já disse. Com quantidade
    // conhecida vira par completo; sem quantidade, vira horário coletado aguardando o
    // QUANTO (primeiraEtapaFaltante segue para cad_quantidade_por_dose).
    if (pares.length === 0 && !completo.intervaloHoras && completo.horarioInicio
        && horarioValido(completo.horarioInicio)) {
        if (completo.quantidadeUnica !== null) {
            pares = [{ horario: completo.horarioInicio, quantidade: completo.quantidadeUnica }];
        } else {
            contextUpdates.horarios = [completo.horarioInicio];
        }
    }
    if (pares.length > 0) {
        contextUpdates.horarios = pares.map(p => p.horario);
        contextUpdates.pares_posologia = pares;
    }

    // Sem horário de início, a grade não pode ser montada — mas o intervalo e a
    // quantidade já ditos precisam sobreviver, senão cad_horarios repergunta tudo.
    if (completo.intervaloHoras && !completo.horarioInicio) {
        contextUpdates.intervalo_horas = completo.intervaloHoras;
    }
    if (pares.length === 0 && completo.quantidadeUnica !== null) {
        // Mesmo trio de campos que decidirCadHorarios grava no caso 'quantidade_apenas'
        // (unidade_dose_pendente + forma_explicita_pendente ao lado de quantidade_pendente):
        // quando os horários forem completados depois, resolverComHorarios deriva a
        // unidade e a forma a partir DESTES campos — sem eles, cairia no default
        // ('unidade', forma null) e descartaria o que já foi extraído aqui.
        contextUpdates.quantidade_pendente = completo.quantidadeUnica;
        contextUpdates.unidade_dose_pendente = completo.unidadeDose;
        contextUpdates.forma_explicita_pendente = completo.formaExplicita;
    }

    if (completo.tipoTratamento === 'continuo') {
        contextUpdates.tipo_tratamento = 'continuo';
        contextUpdates.tratamento_dias = null;
    } else if (completo.tipoTratamento === 'temporario' && completo.tratamentoDias) {
        contextUpdates.tipo_tratamento = 'temporario';
        contextUpdates.tratamento_dias = completo.tratamentoDias;
    }

    if (completo.tipoTratamento === 'temporario' && !completo.tratamentoDias) {
        contextUpdates.tipo_tratamento_pendente = true;
    }

    // A checagem de unidade_estoque === 'ml' sai daqui: quem diz "1 vidro de 100ml"
    // já indicou o formato do estoque, sem depender da unidade de dose ter sido
    // resolvida antes.
    let estoqueResolvido = null;
    let estoqueMotivo = null;

    if (completo.statusFrasco === 'aberto') {
        // MH-073 Parte C: ramo aberto — volumeFrasco (quando dito) é só o TAMANHO do
        // frasco, nunca multiplicado por frascos (não se aplica a frasco já em uso).
        contextUpdates.status_frasco = 'aberto';
        if (completo.volumeFrasco) contextUpdates.volume_frasco = completo.volumeFrasco;

        if (completo.estoqueQuantidade !== null) {
            estoqueMotivo = 'aberto_valor_exato';
            estoqueResolvido = completo.estoqueQuantidade;
        } else if (completo.fracaoEstoque === 'nao_sei') {
            if (completo.volumeFrasco) {
                estoqueMotivo = 'aberto_fracao_nao_informada';
                estoqueResolvido = completo.volumeFrasco * 0.10;
            } else {
                contextUpdates.estoque_fracao_pendente = 'nao_informada';
            }
        } else if (completo.fracaoEstoque && FRACOES_ESTOQUE[completo.fracaoEstoque] !== undefined) {
            if (completo.volumeFrasco) {
                estoqueMotivo = `aberto_fracao:${completo.fracaoEstoque}`;
                estoqueResolvido = completo.volumeFrasco * FRACOES_ESTOQUE[completo.fracaoEstoque];
            } else {
                contextUpdates.estoque_fracao_pendente = completo.fracaoEstoque;
            }
        }
    } else {
        if (completo.statusFrasco === 'fechado') contextUpdates.status_frasco = 'fechado';
        if (completo.frascos && completo.volumeFrasco) {
            estoqueResolvido = completo.frascos * completo.volumeFrasco;
            estoqueMotivo = 'frascos_fechados';
            contextUpdates.frascos = completo.frascos;
            contextUpdates.volume_frasco = completo.volumeFrasco;
        } else if (completo.frascos) {
            contextUpdates.frascos = completo.frascos;
        } else if (completo.estoqueQuantidade !== null) {
            estoqueResolvido = completo.estoqueQuantidade;
        }
    }

    // ADENDO MH-80, DEFEITO 1: o estoque precisa entrar no contexto AGORA, não só no
    // caminho completo — qualquer saída antecipada (dosagem, horários, forma, tipo de
    // tratamento) descartaria um valor já extraído corretamente. `!== null` (nunca
    // truthy): zero é estoque legítimo (BUG-97).
    if (estoqueResolvido !== null) {
        contextUpdates.estoque_resolvido = estoqueResolvido;
        contextUpdates.estoque_motivo = estoqueMotivo;
        contextUpdates.estoque_estimado = !!estoqueMotivo && estoqueMotivo !== 'frascos_fechados';
    }

    // ADENDO MH-80, DEFEITO 2: ponto único de decisão de avanço (Princípio 30) — a
    // mesma ordem canônica usada nas transições passo a passo, para que nenhuma etapa
    // já resolvida aqui seja perguntada de novo depois.
    //
    // v43 Bloco C (MH-094): este salto nunca inclui medication_id (o medicamento ainda
    // não existe) — primeiraEtapaFaltante nunca devolve 'cad_confirmacao' diretamente
    // daqui, no máximo 'cad_gravar' (que faz a gravação antecipada e, se o estoque já
    // veio nesta mesma mensagem — estoque_resolvido acima —, aplica-o na hora, sem
    // perguntar de novo). alerta_estoque_baixo e o resumo são montados depois da
    // gravação, a partir do banco (P56) — não mais aqui, a partir do rascunho.
    return { proximaEtapa: primeiraEtapaFaltante(contextUpdates), contextUpdates };
}

// v43 Bloco C (MH-094, Parte 5) — destrava o portão do extrator multi-campo para além
// de cad_nome, respeitando a regra obrigatória: SÓ preenche campo que está vazio no
// contexto, NUNCA sobrescreve campo já coletado (corrigir campo já confirmado continua
// sendo exclusividade do fluxo de correção em cad_confirmacao).
//
// Escopo desta rodada (decisão de engenharia, registrada e não mascarada — mesmo
// espírito do "não resolvido" da seção 5 do briefing): aplicado a cad_dosagem e
// cad_tipo_tratamento, etapas de campo único onde reaproveitar montarSaltoCadastroCompleto
// é seguro. cad_horarios/cad_quantidade_por_dose e cad_estoque* NÃO entram aqui — usam
// classificadores especializados (classificarPosologia, processarEstoque) com anos de
// casos de borda ajustados (BUG-041/091/096/098 etc.); deixar o extrator genérico
// decidir a próxima etapa nesses pontos arriscaria reintroduzir exatamente os bugs que
// aquelas correções específicas resolveram. Retorna null quando não há nada de novo a
// aplicar (mensagem pobre, ou tudo que ela trouxe já estava preenchido) — o chamador
// cai no classificador de campo único de sempre.
async function tentarExtracaoRicaParcial(message, context, historicoConversa) {
    const mensagemRica = /\d/.test(message) || String(message).trim().split(/\s+/).filter(Boolean).length > 6;
    if (!mensagemRica) return null;

    const completo = await extrairCadastroCompleto({ message, historicoConversa });
    const bruto = montarSaltoCadastroCompleto({ ...completo, nome: context?.nome || completo.nome });

    const contextUpdatesFiltrado = { ...bruto.contextUpdates };
    delete contextUpdatesFiltrado.nome; // nome já é do contexto — nunca sobrescreve aqui
    for (const campo of Object.keys(contextUpdatesFiltrado)) {
        const atual = context?.[campo];
        const jaPreenchido = Array.isArray(atual) ? atual.length > 0 : (atual !== null && atual !== undefined);
        if (jaPreenchido) delete contextUpdatesFiltrado[campo];
    }

    if (!Object.keys(contextUpdatesFiltrado).length) return null;

    const contextFinal = { ...context, ...contextUpdatesFiltrado };
    return { proximaEtapa: primeiraEtapaFaltante(contextFinal), contextUpdates: contextUpdatesFiltrado };
}

// ============================================================
// MH-073 Parte B.1 — CLASSIFICADOR DE FALHA (camada 2 do modelo canônico)
// ============================================================
//
// Roda SÓ quando a camada 1 (classificador de campo/parser da etapa) já falhou.
// Não julga domínio — julga POR QUE a mensagem não foi reconhecida. Mesma forma do
// classificarIndeterminado de data_nascimento.js (MH-072), agora declarada como
// modelo canônico de escalada do projeto (v35).
//
// Ponto ÚNICO de definição das categorias de falha (Princípio 30): nenhum dos 6
// classificadores de campo existentes tem prompt ou contrato alterado por esta parte.
//
// nova_intencao é DELIBERADAMENTE ESTREITA: só "quer fazer algo FORA do cadastro".
// Correção dentro do cadastro — inclusive trocar de medicamento — é 'ruido', e a
// etapa repete a pergunta. Ver seção 3.4 do briefing e o MH de reset parcial.

async function classificarIndeterminadoCadastro({ message, etapa, nomeMedicamento, historicoConversa = [] }) {
    const systemPrompt = `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami),
que está no meio do cadastro de um medicamento${nomeMedicamento ? ` ("${nomeMedicamento}")` : ''} e fez
uma pergunta ao usuário. A mensagem do usuário NÃO foi reconhecida como resposta a essa pergunta.

Classifique-a em UMA destas categorias:

- recusa: o usuário não quer continuar o cadastro agora, está incomodado, ou pede para parar.
  Ex: "não quero mais", "chega", "deixa isso pra depois", "para com isso".
- duvida: o usuário pergunta o motivo da pergunta ou questiona a necessidade dela, sem recusar
  e sem mudar de assunto. Ex: "pra que você precisa disso?", "por que essa pergunta?",
  "isso é obrigatório?".
- nova_intencao: o usuário quer fazer OUTRA COISA, FORA do cadastro de medicamento.
  Ex: "quero ver meus remédios", "qual meu estoque de atenolol?", "tomei o remédio das 8",
  "quero pausar os lembretes da dipirona", "quanto tempo falta pro meu tratamento acabar".
  ATENÇÃO — o seguinte NÃO é nova_intencao, é ruido:
    * corrigir qualquer informação DO PRÓPRIO cadastro em andamento (nome do remédio,
      dosagem, horário, quantidade, estoque);
    * dizer que o medicamento está errado ou que quer cadastrar outro
      (ex: "não é esse remédio, é outro", "na verdade é o losartana");
    * qualquer coisa que continue sendo sobre o cadastro que está acontecendo agora.
- ruido: a mensagem não se encaixa em nenhuma das anteriores — resposta confusa,
  incompreensível, fora de contexto, ou que simplesmente não responde à pergunta.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

ETAPA ATUAL DO CADASTRO: ${etapa}

MENSAGEM ATUAL: "${message}"

Responda APENAS com uma palavra: recusa, duvida, nova_intencao ou ruido.
Sem pontuação, sem explicação.`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: systemPrompt,
            messages: [{ role: 'user', content: message || '' }]
        });
        const texto = (resposta.content[0]?.text || '').toLowerCase().trim();
        const validos = ['recusa', 'duvida', 'nova_intencao', 'ruido'];
        const achado = validos.find(v => texto.includes(v));
        console.log(`💊 [CADASTRO] Classificador de falha (etapa ${etapa}): "${message}" -> ${achado || 'ruido (fallback)'}`);
        console.log(`🔎 [CAD-CLASSIF] classificarIndeterminadoCadastro -> ${achado || 'ruido'} (etapa: ${etapa})`);
        return achado || 'ruido';
    } catch (e) {
        console.error(`❌ [CADASTRO] Erro no classificador de falha: ${e.message} — assumindo ruido`);
        return await degradar({
            origem: 'cadastro',
            motivo: 'classificador_falha_indeterminado',
            agent: 'cadastro',
            detalhe: { erro: e.name, status: e?.status ?? null, etapa },
            fallback: 'ruido'
        });
    }
}

async function calcularDecisaoEtapa(etapaAtual, message, context, historicoConversa) {
    if (etapaAtual === 'cad_nome') {
        // MH-80: só dispara a extração completa quando a mensagem tem indício de
        // conteúdo além do nome (dígito ou mais de 6 palavras) — evita uma chamada extra
        // em mensagens simples como "Claritin".
        const pareceCompleto = /\d/.test(message) || String(message).trim().split(/\s+/).filter(Boolean).length > 6;
        if (pareceCompleto) {
            const completo = await extrairCadastroCompleto({ message, historicoConversa });
            if (completo.nome) {
                // v43 Bloco C: cad_confirma_forma saiu do caminho obrigatório (forma é
                // sempre derivada) — o salto do MH-80 nunca mais aterrissa lá, então o
                // preparo de blocoConfirmaForma não é mais necessário aqui.
                const decisao = montarSaltoCadastroCompleto(completo);
                return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates };
            }
        }

        const c = await extrairCampoSimples({ campo: 'nome', message, historicoConversa });
        if (c.categoria === 'valor') {
            // v43 Bloco C (Parte 4): medication_id já presente = isto é uma CORREÇÃO vinda
            // de cad_confirmacao ("corrige nome"), não a coleta inicial — o registro já
            // existe, então a correção escreve nele direto (P56/P57) e volta pro resumo.
            if (context?.medication_id) {
                await atualizarMedicamentoCampos({ medicationId: context.medication_id, campos: { nome: c.valor } });
                return { proximaEtapa: 'cad_confirmacao', contextUpdates: { nome: c.valor } };
            }
            // v43 Bloco C (MH-094): dosagem saiu do caminho obrigatório — o próximo passo
            // é sempre a primeira etapa faltante na nova ordem canônica (horários).
            return { proximaEtapa: primeiraEtapaFaltante({ ...context, nome: c.valor }), contextUpdates: { nome: c.valor } };
        }
        return { proximaEtapa: 'cad_nome', contextUpdates: {}, acao: 'indeterminado' };
    }

    if (etapaAtual === 'cad_dosagem') {
        // v43 Bloco C (Parte 5): extrator rico destravado nesta etapa. Só é aceito
        // quando resolve o próprio campo pedido (dosagem) — nunca avança a etapa por
        // causa só de um campo incidental capturado junto. Campo caro (extrairCadastroCompleto)
        // só roda em mensagem "rica" (dígito ou >6 palavras) — uma correção de dosagem
        // típica ("500mg", "não, é 20mg") não bate nesse gatilho.
        const saltoDosagem = await tentarExtracaoRicaParcial(message, context, historicoConversa);
        if (saltoDosagem?.contextUpdates?.dosagem !== undefined) {
            if (context?.medication_id) {
                // v43 Bloco C (Parte 4): correção vinda de cad_confirmacao — escreve só os
                // campos que atualizarMedicamentoCampos sabe persistir (nunca estoque/
                // posologia, que têm ponto único próprio de escrita).
                await atualizarMedicamentoCampos({
                    medicationId: context.medication_id,
                    campos: {
                        dosagem: saltoDosagem.contextUpdates.dosagem,
                        ...(saltoDosagem.contextUpdates.tipo_tratamento !== undefined ? { tipo_tratamento: saltoDosagem.contextUpdates.tipo_tratamento } : {}),
                        ...(saltoDosagem.contextUpdates.tratamento_dias !== undefined ? { tratamento_dias: saltoDosagem.contextUpdates.tratamento_dias } : {})
                    }
                });
                return {
                    proximaEtapa: 'cad_confirmacao',
                    contextUpdates: {
                        dosagem: saltoDosagem.contextUpdates.dosagem,
                        ...(saltoDosagem.contextUpdates.tipo_tratamento !== undefined ? { tipo_tratamento: saltoDosagem.contextUpdates.tipo_tratamento, tipo_tratamento_pendente: false } : {}),
                        ...(saltoDosagem.contextUpdates.tratamento_dias !== undefined ? { tratamento_dias: saltoDosagem.contextUpdates.tratamento_dias } : {})
                    }
                };
            }
            return saltoDosagem;
        }

        const c = await extrairCampoSimples({ campo: 'dosagem', message, historicoConversa });
        if (c.categoria === 'valor') {
            // v43 Bloco C (Parte 4): correção vinda de cad_confirmacao — o registro já
            // existe, escreve nele direto e volta pro resumo (P56/P57).
            if (context?.medication_id) {
                await atualizarMedicamentoCampos({ medicationId: context.medication_id, campos: { dosagem: c.valor } });
                return { proximaEtapa: 'cad_confirmacao', contextUpdates: { dosagem: c.valor } };
            }
            return { proximaEtapa: primeiraEtapaFaltante({ ...context, dosagem: c.valor }), contextUpdates: { dosagem: c.valor } };
        }
        return { proximaEtapa: 'cad_dosagem', contextUpdates: {}, acao: 'indeterminado' };
    }

    if (etapaAtual === 'cad_horarios' || etapaAtual === 'cad_quantidade_por_dose') {
        const campoEsperado = etapaAtual === 'cad_horarios' ? 'horarios' : 'quantidade';
        const classificacao = await classificarPosologia({
            message,
            campoEsperado,
            nomeMedicamento: context?.nome,
            horariosJaColetados: context?.horarios || [],
            historicoConversa,
            unidadeDoseContexto: context?.unidade_dose
        });

        const decisao = etapaAtual === 'cad_horarios'
            ? decidirCadHorarios(classificacao, context)
            : decidirCadQuantidade(classificacao, context);

        const mencionaConcentracao = etapaAtual === 'cad_quantidade_por_dose' && decisao.acao === 'indeterminado'
            && /\d+(?:[.,]\d+)?\s*(mg|mcg|g|%|mg\/ml)\b/i.test(message);

        const contextParaPrompt = { acaoPosologia: decisao.acao, mencionaConcentracao };

        if (decisao.proximaEtapa === 'cad_confirma_forma') {
            const contextFinal = { ...context, ...decisao.contextUpdates };
            contextParaPrompt.blocoConfirmaForma = await prepararContextoConfirmaForma(contextFinal, decisao.contextUpdates, context?.nome);
        }

        // MH-073 Parte B.1: propaga acao no nível de topo (não só dentro de
        // contextParaPrompt.acaoPosologia) para que decidirEtapa detecte a falha da
        // camada 1 e acione a camada 2. Valores de sucesso (ex: horarios_completos) não
        // batem em ACOES_DE_FALHA e seguem inertes.
        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt, acao: decisao.acao };
    }

    if (etapaAtual === 'cad_confirma_forma') {
        const classificacao = await classificarPosologia({
            message,
            campoEsperado: 'quantidade',
            nomeMedicamento: context?.nome,
            horariosJaColetados: (context?.pares_posologia || []).map(p => p.horario),
            historicoConversa,
            unidadeDoseContexto: context?.unidade_dose
        });
        const decisao = decidirCadConfirmaForma(classificacao, message, context);

        // v43 Bloco C (Parte 4): esta etapa só é alcançada por correção a partir de
        // cad_confirmacao (forma saiu do caminho obrigatório) — o registro já existe.
        // Sincroniza no banco qualquer campo que a decisão tenha mudado, senão o
        // resumo (lido do banco) mostraria dado desatualizado depois de uma correção
        // de horário feita por aqui (raro, mas P56 não permite essa divergência).
        if (context?.medication_id) {
            if (decisao.contextUpdates?.pares_posologia) {
                await replaceMedication({ medicationId: context.medication_id, horarios: decisao.contextUpdates.pares_posologia });
            }
            if (decisao.contextUpdates?.forma_confirmada) {
                const formaFinal = derivarFormaFarmaceutica(
                    decisao.contextUpdates.forma_explicita ?? context?.forma_explicita,
                    decisao.contextUpdates.forma_confirmada,
                    decisao.contextUpdates.unidade_dose ?? context?.unidade_dose
                );
                await atualizarMedicamentoCampos({ medicationId: context.medication_id, campos: { forma_farmaceutica: formaFinal } });
            }
        }

        // decisao.acao vira acaoPosologia quando o salto sai para cad_horarios/
        // cad_quantidade_por_dose (ex: frequencia_sem_inicio) — o mesmo mecanismo que
        // decidirCadHorarios usa, para que montarBlocoEtapa saiba fazer a pergunta certa
        // em vez da pergunta genérica de horários.
        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt: { acaoPosologia: decisao.acao } };
    }

    if (etapaAtual === 'cad_tipo_tratamento') {
        const aguardandoDias = !!context?.tipo_tratamento_pendente;
        const classificacao = await classificarTipoTratamento({ message, nomeMedicamento: context?.nome, aguardandoDias, historicoConversa });
        const decisao = decidirCadTipoTratamento(classificacao, context);

        // v43 Bloco C (Parte 4): esta etapa só é alcançada por correção a partir de
        // cad_confirmacao (tipo_tratamento saiu do caminho obrigatório) — escreve no
        // registro já existente assim que a categoria é decisiva (continuo/dias).
        if (context?.medication_id && (classificacao.categoria === 'continuo' || classificacao.categoria === 'dias')) {
            await atualizarMedicamentoCampos({
                medicationId: context.medication_id,
                campos: {
                    tipo_tratamento: decisao.contextUpdates.tipo_tratamento,
                    tratamento_dias: decisao.contextUpdates.tratamento_dias
                }
            });
        }

        // MH-073 Parte B.1: acao no nível de topo — ver comentário no ramo cad_horarios.
        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt: { acaoTipoTratamento: decisao.acao }, acao: decisao.acao };
    }

    if (etapaAtual === 'cad_estoque' || etapaAtual === 'cad_estoque_fracao' || etapaAtual === 'cad_estoque_volume') {
        const decisao = await processarEstoque(etapaAtual, message, context, historicoConversa);
        // MH-073 Parte B.1: acao no nível de topo — ver comentário no ramo cad_horarios.
        return {
            proximaEtapa: decisao.proximaEtapa,
            contextUpdates: decisao.contextUpdates,
            contextParaPrompt: decisao.proximaEtapa === 'cad_confirmacao'
                ? { resumoRenderizado: decisao.resumoRenderizado || null }
                : { acaoEstoque: decisao.acao },
            acao: decisao.acao
        };
    }

    if (etapaAtual === 'cad_confirmacao') {
        const classificacao = await classificarConfirmacaoCadastro({ message, nomeMedicamento: context?.nome, historicoConversa });

        if (classificacao.categoria === 'confirma') {
            return { proximaEtapa: 'cad_salvo', contextUpdates: {} };
        }

        if (classificacao.categoria === 'corrige') {
            switch (classificacao.campoAlvo) {
                case 'nome':
                    return { proximaEtapa: 'cad_nome', contextUpdates: {} };
                case 'dosagem':
                    return { proximaEtapa: 'cad_dosagem', contextUpdates: {} };
                case 'tipo_tratamento':
                    return { proximaEtapa: 'cad_tipo_tratamento', contextUpdates: { tipo_tratamento_pendente: false } };
                case 'estoque':
                    // MH-073 Parte C: reseta todo o sub-estado do ramo líquido — sem
                    // isso, uma correção genérica de estoque reentraria em cad_estoque
                    // com status_frasco já resolvido de uma rodada anterior e seria
                    // interpretada como resposta à contagem de frascos (fase 2), pulando
                    // a pergunta "aberto ou fechado?" que a correção deveria refazer.
                    // v43 Bloco C: estoque_perguntado também reseta — é ele quem faz
                    // primeiraEtapaFaltante voltar a perguntar (MH-094).
                    return {
                        proximaEtapa: 'cad_estoque',
                        contextUpdates: {
                            status_frasco: null, frascos: null, volume_frasco: null,
                            estoque_perguntado: false, estoque_resolvido: null,
                            estoque_motivo: null, estoque_estimado: false,
                            estoque_fracao_pendente: null, estoque_valor_exato_pendente: null,
                            alerta_estoque_baixo: null
                        }
                    };
                case 'forma': {
                    // A mensagem de correção quase sempre JÁ contém a forma certa ("não é
                    // cápsula, é comprimido"). Aproveitá-la evita um turno inteiro de
                    // repergunta — mesmo raciocínio da MH-073 Parte C.1 e do Princípio 1.
                    const forma = await extrairFormaDaMensagem(message, historicoConversa, context?.nome);
                    if (forma) {
                        // NÃO deriva nem altera unidade_dose/unidade_estoque a partir da
                        // forma corrigida (briefing v36 #3, seção 2.2) — forma_farmaceutica
                        // é puramente descritiva; incoerência com a unidade já coletada
                        // fica visível no resumo, não é silenciada nem inferida aqui.
                        // v43 Bloco C (Parte 4): o registro já existe — escreve direto nele.
                        if (context?.medication_id) {
                            await atualizarMedicamentoCampos({ medicationId: context.medication_id, campos: { forma_farmaceutica: forma } });
                        }
                        return {
                            proximaEtapa: 'cad_confirmacao',
                            contextUpdates: { forma_explicita: forma, forma_confirmada: forma }
                        };
                    }
                    // Sem forma reconhecível na mensagem, pergunta — sem inventar valor.
                    return { proximaEtapa: 'cad_confirma_forma', contextUpdates: {} };
                }
                case 'horarios':
                case 'quantidade': {
                    const posologia = await classificarPosologia({
                        message,
                        campoEsperado: classificacao.campoAlvo === 'horarios' ? 'horarios' : 'quantidade',
                        nomeMedicamento: context?.nome,
                        horariosJaColetados: (context?.pares_posologia || []).map(p => p.horario),
                        historicoConversa,
                        emCorrecao: classificacao.campoAlvo === 'horarios',
                        unidadeDoseContexto: context?.unidade_dose
                    });
                    const r = await corrigirPosologiaEmConfirmacao(classificacao.campoAlvo, posologia, context);
                    return {
                        proximaEtapa: r.proximaEtapa,
                        contextUpdates: r.contextUpdates,
                        contextParaPrompt: r.proximaEtapa === 'cad_confirmacao'
                            ? { resumoRenderizado: r.resumoRenderizado || null }
                            : { acaoPosologia: r.acao }
                    };
                }
                default:
                    return { proximaEtapa: 'cad_confirmacao', contextUpdates: {} };
            }
        }

        return { proximaEtapa: 'cad_confirmacao', contextUpdates: {}, acao: 'indeterminado' };
    }

    // Fallback de segurança — etapa desconhecida não deveria ocorrer.
    return { proximaEtapa: 'cad_nome', contextUpdates: {} };
}

// ADENDO 2 MH-80 (25/08/2026), DEFEITO 1 — pré-condição de cad_confirmacao. A etapa
// não pode ser alcançada sem o resumo montado: era a ausência disso que fazia o prompt
// cair no ramo de "correção não compreendida" e produzir o laço observado em 25/08
// (o roteamento novo do ADENDO 1 passou a saltar direto para cad_confirmacao por fora
// do único ponto — dentro de processarEstoque — que antes sempre renderizava o resumo).
// Aplicada UMA vez, no despacho (ponto único, Princípio 30), em vez de espalhada pelas
// transições que levam até a etapa.
//
// v43 Bloco C (MH-094, Parte 3.5, P56): o resumo passou a ser lido do BANCO
// (montarResumoDoBanco), nunca mais do rascunho — cad_confirmacao só é alcançável
// depois da gravação antecipada (Parte 3.1), então medication_id sempre existe aqui.
// Continua idempotente: quando um chamador já montou o resumo (finalizarComEstoque,
// finalizarComEstoqueDesconhecido, corrigirPosologiaEmConfirmacao — todos já leem do
// banco eles mesmos, no momento exato da escrita), este ponto único não repete a leitura.
async function garantirResumo(proximaEtapa, contextCompleto, contextParaPrompt) {
    if (proximaEtapa !== 'cad_confirmacao') return contextParaPrompt;
    if (contextParaPrompt?.resumoRenderizado) return contextParaPrompt;

    if (!contextCompleto?.medication_id) {
        // Invariante MH-094: nunca deveria ocorrer (ver comentário acima).
        return degradar({
            origem: 'cadastro',
            motivo: 'confirmacao_sem_medication_id',
            agent: 'cadastro',
            detalhe: { pares_posologia_len: contextCompleto?.pares_posologia?.length ?? 0 },
            fallback: contextParaPrompt
        });
    }

    const { resumo } = await montarResumoDoBanco(contextCompleto.medication_id);
    return {
        ...contextParaPrompt,
        resumoRenderizado: resumo
    };
}

// Correção #3 (v36 #2, seção 3), espelhando garantirResumo acima: cad_confirma_forma
// também tem uma pré-condição — sem blocoConfirmaForma o template renderiza
// literalmente "só confirmando: ?". O bloco só era preparado nos 3 pontos de entrada
// que saltam PARA a etapa (cad_nome, cad_horarios/cad_quantidade_por_dose,
// repetirPerguntaCadastro); alcançá-la via primeiraEtapaFaltante (vindo de
// cad_dosagem, cad_tipo_tratamento ou do próprio decidirCadConfirmaForma) não passava
// por nenhum deles. Aplicada UMA vez, no ponto único de despacho, como garantirResumo.
async function garantirBlocoConfirmaForma(proximaEtapa, contextCompleto, contextParaPrompt) {
    if (proximaEtapa !== 'cad_confirma_forma') return contextParaPrompt;
    if (contextParaPrompt?.blocoConfirmaForma) return contextParaPrompt;

    return {
        ...contextParaPrompt,
        blocoConfirmaForma: await prepararContextoConfirmaForma({ ...contextCompleto }, {}, contextCompleto?.nome)
    };
}

// Ações que significam "a camada 1 não reconheceu a mensagem". Ponto único de
// definição (Princípio 30) — acrescentar aqui, nunca espalhar checagens por etapa.
const ACOES_DE_FALHA = new Set([
    'indeterminado', 'estoque_indeterminado', 'volume_indeterminado',
    'status_frasco_indeterminado', 'fracao_indeterminada', 'frascos_indeterminado'
]);

// Ponto ÚNICO de dispatch (Princípio 30): calcula a decisão em calcularDecisaoEtapa e
// garante, aqui e só aqui, que cad_confirmacao nunca é devolvida sem resumo — cobre
// TODOS os retornos da função interna, não apenas alguns.
//
// MH-073 Parte B.1: também é o ponto único onde a camada 1 (falhou) escala para a
// camada 2 (classificarIndeterminadoCadastro). Só roda quando a camada 1 falhou; no
// caminho feliz não há chamada de LLM adicional.
async function decidirEtapa(etapaAtual, message, context, historicoConversa) {
    const resultado = await calcularDecisaoEtapa(etapaAtual, message, context, historicoConversa);

    if (ACOES_DE_FALHA.has(resultado.acao)) {
        const motivo = await classificarIndeterminadoCadastro({
            message,
            etapa: etapaAtual,
            nomeMedicamento: context?.nome,
            historicoConversa
        });

        if (motivo === 'nova_intencao') {
            return { escalarParaRoteador: true };
        }

        // recusa: encerra o cadastro pelo mesmo caminho já usado por ehCancelamento.
        if (motivo === 'recusa') {
            return { encerrarCadastro: true };
        }

        // duvida e ruido seguem o fluxo normal (repetem a pergunta da etapa), com
        // motivoFalha disponível para o gerador de texto fraseá-la adequadamente.
        resultado.contextParaPrompt = { ...(resultado.contextParaPrompt || {}), motivoFalha: motivo };
    }

    const contextCompleto = { ...context, ...resultado.contextUpdates };
    const contextParaPromptComResumo = await garantirResumo(resultado.proximaEtapa, contextCompleto, resultado.contextParaPrompt);
    return {
        ...resultado,
        contextParaPrompt: await garantirBlocoConfirmaForma(resultado.proximaEtapa, contextCompleto, contextParaPromptComResumo)
    };
}

// ============================================================
// SYSTEM PROMPT — FLUXO DE GERAÇÃO
// ============================================================
//
// MH-073 Parte B.2 (BUG-90): recebe a etapa cuja PERGUNTA deve ser escrita —
// proximaEtapa, já decidida em código — e inclui SOMENTE o bloco daquela etapa.
// Antes o parâmetro era a etapa de ENTRADA e o prompt listava todas as etapas
// juntas num bloco só (Princípio 44): o LLM tinha que inferir qual bloco seguir
// olhando o histórico, e errava. Agora não há inferência nem ambiguidade possível.

function montarBlocoEtapa(etapaDaPergunta, context, nome) {
    switch (etapaDaPergunta) {
        case 'cad_nome':
            return `Pergunte o *NOME* do medicamento. Ex: "Vamos cadastrar seu *MEDICAMENTO*! Qual o *NOME* dele?"`;

        case 'cad_dosagem':
            return `Pergunte a *DOSAGEM* do ${nome} — geralmente vem no rótulo (ex: 50mg, 0,5%, 100mg/ml).`;

        case 'cad_horarios':
            if (context?.acaoPosologia === 'frequencia_sem_inicio') {
                return `Pergunte apenas: "Qual o horário da primeira dose do dia?"`;
            }
            if (context?.acaoPosologia === 'indeterminado') {
                return `Desculpe, não peguei direito 😊 Pergunte de novo a posologia do ${nome} —
quanto por vez e em quais horários. Não cite nenhum horário ou quantidade — nem os que apareceram
antes na conversa. Qualquer explicação vem ANTES; a pergunta fica sozinha na última linha (regra 8).`;
            }
            if (context?.quantidade_pendente !== null && context?.quantidade_pendente !== undefined) {
                return `A quantidade por vez JÁ foi dita e está anotada — falta só o horário.
Pergunte apenas em quais *HORÁRIOS* a pessoa toma ou usa o ${nome}, sem repetir a quantidade.
A pergunta fica sozinha na última linha (regra 8).`;
            }
            // v44 (decisão de produto, replay 19/09): pede a POSOLOGIA COMPLETA numa
            // pergunta só — quantidade E horários. O público pediu agilidade: o formato
            // composto vem primeiro, e o código coleta os pedaços que faltarem.
            return `Pergunte a posologia do ${nome} numa pergunta só: QUANTO a pessoa toma por vez
E em quais HORÁRIOS. Um exemplo curto vem ANTES da pergunta (como "1 comprimido às 8h e às 20h");
a pergunta fica sozinha na última linha (regra 8). Ex:
"Pode me mandar tudo junto — por exemplo: 1 comprimido às 8h e às 20h.

Quanto de ${nome} você toma por vez, e em quais horários?"`;

        case 'cad_quantidade_por_dose':
            if (context?.mencionaConcentracao) {
                return `O usuário respondeu com a concentração do remédio (mg/ml/%), não com a
quantidade por dose. Distinga os dois: "Essa é a dosagem do remédio (a concentração). O que eu
preciso saber agora é *QUANTO* você toma de cada vez — por exemplo, 1 comprimido, 2 comprimidos,
20 gotas."`;
            }
            if (context?.acaoPosologia === 'indeterminado') {
                return `Desculpe, não peguei direito 😊 Pergunte de novo *QUANTO* de ${nome} a
pessoa toma ou usa em cada horário. Não cite quantidades que apareceram antes na conversa.
Exemplos e explicações vêm ANTES; a pergunta fica sozinha na última linha (regra 8).`;
            }
            // v44 (decisão de produto, replay 19/09): os horários JÁ vieram — a pergunta
            // da quantidade cita esses horários para ficar concreta ("quantos você toma
            // às 07:00 e às 19:00?"), em vez de uma pergunta genérica de etapa.
            {
                const horariosColetados = (context?.horarios || [])
                    .map(h => String(h).slice(0, 5))
                    .join(' e às ');
                const referenciaHorarios = horariosColetados ? ` às ${horariosColetados}` : ' em cada horário';
                return `Os horários já foram ditos e estão anotados${horariosColetados ? ` (${horariosColetados})` : ''} —
falta só a quantidade. Pergunte *QUANTO* de ${nome} a pessoa toma ou usa${referenciaHorarios},
citando os horários EXATAMENTE como estão acima. Pode ser em comprimidos, cápsulas, gotas ou ml —
essa explicação vem ANTES; a pergunta fica sozinha na última linha (regra 8). Ex:
"Pode ser em comprimidos, cápsulas, gotas ou ml.

Quanto de ${nome} você toma${referenciaHorarios}?"`;
            }

        case 'cad_confirma_forma':
            return `A mensagem deve ser EXATAMENTE: "${nome}, só confirmando: ${context?.blocoConfirmaForma || ''}?" — não altere nada desse trecho, é dado de saúde renderizado em código.`;

        case 'cad_tipo_tratamento':
            if (context?.acaoTipoTratamento === 'indeterminado') {
                return `Desculpe, não peguei direito 😊 Pergunte de novo: "O ${nome} é de uso
*CONTÍNUO* (sem previsão de parada) ou *TEMPORÁRIO*, com prazo definido — como um antibiótico
ou anti-inflamatório?" Não repita horários nem quantidade coletados antes.`;
            }
            if (context?.acaoTipoTratamento === 'temporario_sem_dias' || context?.tipo_tratamento_pendente) {
                return `O usuário já disse que o tratamento é temporário mas não disse por quantos
dias. Pergunte: "Por quantos dias, aproximadamente, é o tratamento com ${nome}?" Não repita
horários nem quantidade coletados antes.`;
            }
            return `Pergunte: "O ${nome} é de uso *CONTÍNUO* (sem previsão de parada) ou
*TEMPORÁRIO*, com prazo definido — como um antibiótico ou anti-inflamatório?" Se o usuário já
puder responder com o número de dias na mesma mensagem, tudo bem — a extração é feita em código.
Não repita horários nem quantidade coletados antes.`;

        // Correção #1 (v36 #2, seção 1): as três etapas de estoque usam pergunta
        // renderizada em código (renderizarPerguntaEstoque), no mesmo padrão de
        // cad_confirmacao — o LLM só fraseia, nunca decide o que perguntar. A proibição
        // de confirmar sucesso existe porque a Nami chegou a dizer "Estoque registrado
        // com sucesso" no meio deste sub-fluxo (seção 0 do briefing).
        case 'cad_estoque':
        case 'cad_estoque_fracao':
        case 'cad_estoque_volume': {
            const pergunta = renderizarPerguntaEstoque(etapaDaPergunta, context);
            // v43 Bloco C (MH-094, Parte 3.2): chegando direto da gravação antecipada, a
            // pessoa precisa de confirmação de que o medicamento JÁ foi salvo — lida de
            // volta do registro (P56), nunca "prometida" em prosa.
            // v44 (Constituição regra 2): a confirmação de persistência é DECLARATIVA e
            // completa — "Anotei" ficou restrito a captura intermediária de campo.
            const prefixoGravacao = context?.medicamentoRecemGravado
                ? `Comece com a linha EXATA "*${context.medicamentoRecemGravado}* cadastrado! Vou te lembrar nos horários certos. 💊", pule uma linha, e então `
                : '';
            return `${prefixoGravacao}Reproduza EXATAMENTE este texto, sem reescrever, sem acrescentar pergunta e
sem antecipar nenhuma etapa seguinte (é fluxo de dado de saúde renderizado em código):
"${pergunta}"
${context?.medicamentoRecemGravado ? '' : 'Você pode acrescentar no máximo uma saudação curta e calorosa ANTES dele.\n'}Não confirme nada como registrado ou salvo por conta própria.`;
        }

        case 'cad_confirmacao':
            if (context?.resumoRenderizado) {
                const alerta = context?.alerta_estoque_baixo;
                const avisoInstrucao = alerta
                    ? `Comece com um aviso breve e gentil de estoque baixo: restam
aproximadamente ${alerta.dias_restantes} dias de estoque. Depois disso, `
                    : '';
                return `${avisoInstrucao}Insira EXATAMENTE este resumo, palavra por palavra, sem alterar NENHUMA linha — nem números, nem nomes, nem a forma, nem o estoque. É dado de saúde
renderizado em código. Se o usuário acabou de pedir uma correção, o resumo abaixo JÁ reflete o
estado atual do sistema: não ajuste nada por conta própria.\n${context.resumoRenderizado}\nFinalize
perguntando "Está tudo certinho?"`;
            }
            return `O usuário tentou corrigir algo, mas não ficou claro o quê. Pergunte, com
acolhimento e sem repetir o resumo nem citar nenhum número: "Desculpe, não peguei direito 😊 Pode
me dizer qual informação está errada — nome, dosagem, forma, horários, quantidade, tratamento ou
estoque?"`;

        case 'cad_salvo': {
            // BUG-94: a mensagem de sucesso só pode citar horário/quantidade a partir de um
            // bloco renderizado em código — nunca do que o LLM leu na CONVERSA RECENTE (foi
            // assim que "Com 60 unidades e 3 comprimidos por dia... 20 dias" saiu com estoque
            // real = 0). Sem bloco, a mensagem não cita nenhum desses dados.
            const pares = context?.pares_posologia || [];
            const forma = derivarFormaFarmaceutica(context?.forma_explicita, context?.forma_confirmada, context?.unidade_dose);
            const rotulo = rotuloDaDose(context?.unidade_dose, forma);
            const blocoHorarios = pares.length > 0 ? renderizarBlocoPosologia(pares, rotulo) : null;
            const instrucaoHorarios = blocoHorarios
                ? ` Se quiser citar os horários, use EXATAMENTE este trecho, sem alterar nada: "${blocoHorarios}".`
                : ' Não cite horários, quantidade nem estoque — nenhum bloco renderizado está disponível para esta mensagem.';
            const instrucaoPrimeiroMedicamento = context?.primeiroMedicamento
                ? ` Se este for o PRIMEIRO medicamento cadastrado por esta pessoa, acrescente ao final,
em UMA linha curta e leve, que você ainda está sendo construída e melhorando a cada dia, e que por
isso pode escorregar de vez em quando. NUNCA use a expressão "teste beta". Exemplo: "Ah, e uma
coisinha: eu ainda estou sendo construída e melhorando a cada dia — se eu escorregar em algo, me
avisa? 😊"`
                : '';
            return `O usuário confirmou os dados e o cadastro FOI SALVO com sucesso pelo código.
Gere uma mensagem de sucesso carinhosa, sem inventar nem recalcular horário, quantidade ou
estoque.${instrucaoHorarios} Ex: "Ótimo! ${nome} foi cadastrado com sucesso 💊✅ Vou te lembrar nos
horários certos!"${instrucaoPrimeiroMedicamento}`;
        }

        default:
            return `Pergunte o *NOME* do medicamento.`;
    }
}

function buildSystemPrompt(etapaDaPergunta, context, userName, historicoConversa = []) {
    const nome = context?.nome || '{nome}';
    const blocoEtapa = montarBlocoEtapa(etapaDaPergunta, context, nome);

    // MH-073 Parte B.1 — Princípio 44: entra no bloco base compartilhado, não dentro de
    // montarBlocoEtapa (que fica isolado só com o bloco da etapa ativa desde a B.2).
    const blocoMotivoFalha = context?.motivoFalha === 'duvida'
        ? `\n\nA pessoa perguntou POR QUE você precisa dessa informação. Antes de repetir a
pergunta, responda com honestidade e em uma frase curta: você precisa desse dado para
montar os lembretes certos e acompanhar o tratamento dela. Não insista, não negocie e não
minimize a pergunta dela.`
        : '';

    return `Você é a Nami, assistente de saúde. Você está no fluxo de cadastro de um novo medicamento.

Sua única função agora é escrever UMA mensagem para o usuário — uma pergunta ou uma confirmação.
Toda decisão sobre em qual etapa estamos, o que já foi coletado e o que fazer com a resposta
anterior do usuário já foi tomada em código antes desta chamada. Você só fraseia.

Nome do usuário: ${userName || 'usuário'}

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}
${GUIA_COMPOSICAO}
REGRAS DE TEXTO:
- Seja clara e direta. UMA informação por mensagem.
- O verbo é sempre "toma ou usa", nunca só "toma" — pomada e colírio não são ingeridos.
- O nome do medicamento (${nome}) SEMPRE aparece na pergunta.
- O rótulo do dado pedido vem em MAIÚSCULA e em negrito de um asterisco (regra de composição
  acima): *NOME*, *DOSAGEM*, *HORÁRIOS*, *QUANTO*, *CONTÍNUO*/*TEMPORÁRIO*, *FRASCOS*, *VOLUME*.
- Você NUNCA escreve horário, quantidade, unidade ou número de estoque de próprio punho — nem
  recalculando, nem repetindo o que apareceu na CONVERSA RECENTE. Esses valores só podem vir de um
  trecho pronto indicado explicitamente na instrução abaixo. Se a instrução não fornecer nenhum
  trecho pronto, não mencione esses dados de jeito nenhum, mesmo que eles apareçam na conversa.

O QUE ESCREVER AGORA (etapa: ${etapaDaPergunta}):
${blocoEtapa}${blocoMotivoFalha}

FORMATO DE RESPOSTA — JSON válido, sem markdown, sem backticks:
{ "message": "mensagem para o usuário" }`;
}

// ============================================================
// CHAMADA AO CLAUDE (geração de mensagem)
// ============================================================
//
// MH-073 Parte B.2 (BUG-90/BUG-91): o contrato encolheu para { message }. proximaEtapa,
// novoContext e action saem — não existe mais caminho pelo qual o LLM escreva em
// pares_posologia ou decida a próxima etapa.

async function callClaude({ systemPrompt, message }) {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message || 'Olá' }]
    });

    const rawText = response.content[0].text;

    try {
        return JSON.parse(rawText);
    } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch { /* fall through */ }
        }
        console.error('❌ cadastro: Claude não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'parse_json_falhou',
            agent: 'cadastro',
            detalhe: { stop_reason: response?.stop_reason ?? null, tamanho_raw: rawText.length },
            fallback: { message: 'Desculpe, tive um probleminha. Pode repetir? 🌿' }
        });
    }
}

// ============================================================
// PROCESSAMENTO DE AÇÃO
// ============================================================

async function processarAcao(action, user) {
    const forma = derivarFormaFarmaceutica(action.forma_explicita, action.forma_confirmada, action.unidade_dose);

    const med = await saveMedication({
        userId: user.id,
        nome: action.nome,
        forma,
        dosagem: action.dosagem,
        tipo_tratamento: action.tipo_tratamento || 'continuo',
        tratamento_dias: action.tratamento_dias || null,
        // v43 Bloco C (P49): NUNCA `action.estoque || 0` — "não informado" (null/undefined)
        // é diferente de "zero", e `|| 0` colapsava os dois no mesmo valor.
        estoque: action.estoque ?? null,
        unidade_dose: action.unidade_dose || 'unidade',
        unidade_estoque: action.unidade_estoque || 'unidade',
        gotas_por_ml: action.gotas_por_ml ?? null,
        estoqueMotivo: action.estoque_motivo || null,
        estoqueEstimado: !!action.estoque_estimado
    });

    // Medicamento duplicado — informa o usuário e encerra o fluxo
    if (med.isDuplicate) {
        return {
            messageOverride:
                `Já tenho o *${med.nome}* cadastrado! 💊\n\n` +
                `Cadastro atual: ${med.dosagem}, estoque: ${med.estoque_atual} unidades.\n\n` +
                `Se quiser atualizar, me diga "quero atualizar o ${med.nome}". ` +
                `Caso contrário, está tudo certo como está! ✅`
        };
    }

    // Salva os horários com a quantidade por dose de cada um (MH-073 Parte B).
    // v43 Bloco C (Parte 3.3): invariante "todo medications.ativo=true tem ao menos um
    // schedules ativo" — o bloco medication+schedules é tratado como unidade. Se o
    // insert de schedules falhar (ex: no meio de vários horários), o medicamento recém
    // criado é desativado antes de propagar o erro, nunca fica órfão sem horário nenhum.
    try {
        for (const par of action.pares || []) {
            await saveSchedule({
                medicationId: med.id,
                horario: String(par.horario).trim().substring(0, 5),
                quantidadePorDose: Number(par.quantidade) || 1
            });
        }
    } catch (e) {
        console.error(`❌ Falha ao salvar horários de ${action.nome} (id: ${med.id}) — desativando para preservar o invariante:`, e.message);
        await encerrarTratamento(med.id);
        throw e;
    }

    console.log(`✅ Medicamento salvo: ${action.nome} (id: ${med.id}) para ${user.phone}`);
    return { med };
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleCadastro({ user, message, state, context, historicoConversa = [] }) {
    const etapaAtual = context?.etapa || 'cad_nome';
    console.log(`💊 Cadastro — etapa: ${etapaAtual} — ${user.phone}`);

    // TRABALHO 2: resposta do usuário sobre re-encadastrar medicamento encerrado
    if (etapaAtual === 'cad_reencadastro_confirmar') {
        const msg = message.toLowerCase().trim();
        const confirmou = ['sim', 's', 'ok', 'pode', 'claro', 'quero', 'sim quero', 'vai', 'vamos'].some(t => msg === t || msg.startsWith(t + ' '));

        if (!confirmou) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem! Se precisar de algo mais, é só me chamar 🌿`;
        }

        // Item 9.2 do briefing MH-073 Parte B: cad_forma foi removida. v43 Bloco C
        // (MH-094): dosagem também saiu do caminho obrigatório — reencadastro (novo
        // tratamento, novo registro) entra na primeira etapa faltante de verdade
        // (horários), não mais em cad_dosagem.
        const etapaReinicio = primeiraEtapaFaltante({ nome: context.nome });
        const systemPrompt = buildSystemPrompt(etapaReinicio, { nome: context.nome }, user.name, historicoConversa);
        const claudeResponse = await callClaude({
            systemPrompt,
            message: `Quero cadastrar o ${context.nome} novamente`
        });

        await saveConversationState(user.id, {
            state: 'adding_med',
            context: { nome: context.nome, etapa: etapaReinicio }
        });
        return claudeResponse.message;
    }

    // v44 (evidência A6 — Carla 18/09): com o medicamento JÁ gravado (gravação
    // antecipada do MH-094), recusar/adiar o que resta (estoque, opcionais) NÃO é
    // cancelar o cadastro — ele existe no banco e os lembretes valem. A resposta
    // afirma a verdade do banco (P56), nunca "parei o cadastro".
    async function fecharComCadastroJaGravado() {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        let nome = context?.nome || 'seu remédio';
        let horariosTexto = '';
        try {
            const med = await getMedicationComSchedulesAtivos(context.medication_id);
            if (med) {
                nome = med.nome;
                const horarios = (med.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5));
                if (horarios.length > 0) horariosTexto = ` (${horarios.join(', ')})`;
            }
        } catch (e) {
            console.error('⚠️ Erro ao ler medicamento gravado no fechamento:', e.message);
        }
        const firstName = user.name ? user.name.split(' ')[0] : null;
        return `Tudo bem${firstName ? `, ${firstName}` : ''}! O *${nome}* já está cadastrado e os lembretes estão ativos${horariosTexto}. 🌿\n\nO estoque fica pra depois — quando quiser me falar, é só mandar a quantidade.`;
    }

    if (ehCancelamento(message)) {
        if (context?.medication_id) return await fecharComCadastroJaGravado();
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, cancelei o cadastro 🌿 Se quiser recomeçar, é só me chamar!`;
    }

    const decisao = await decidirEtapa(etapaAtual, message, context, historicoConversa);

    // MH-073 Parte B.1 — camada 3. O sinal sobe para o router, que despacha.
    if (decisao?.escalarParaRoteador) {
        console.log(`💊 [CADASTRO] Nova intenção fora do cadastro — escalando ao roteador — ${user.phone}`);
        return { escalarParaRoteador: true };
    }

    if (decisao?.encerrarCadastro) {
        if (context?.medication_id) {
            console.log(`💊 [CADASTRO] Recusa do opcional com medicamento já gravado — fechando pela verdade do banco — ${user.phone}`);
            return await fecharComCadastroJaGravado();
        }
        console.log(`💊 [CADASTRO] Recusa explícita — encerrando cadastro — ${user.phone}`);
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, parei o cadastro por aqui 🌿 Se quiser retomar depois, é só me chamar!`;
    }

    // ========================================================
    // VALIDADOR DE RECORRÊNCIA (v44 §5.7, evidência A3 — Manô 18/09)
    // Padrão de dia-da-semana/frequência que o sistema não representa NUNCA vira
    // gravação silenciosa de horários diários (regra 7). Os horários desta mensagem
    // são bloqueados; todo o resto que ela trouxe (nome, dosagem, quantidade) é
    // preservado (P57); a resposta é honestidade de limite + oferta do subconjunto
    // representável — só grava com o consentimento do turno seguinte.
    // ========================================================
    const updHorarios = decisao?.contextUpdates || {};
    const mensagemTrouxeHorarios =
        (Array.isArray(updHorarios.horarios) && updHorarios.horarios.length > 0) ||
        (Array.isArray(updHorarios.pares_posologia) && updHorarios.pares_posologia.length > 0);
    const recorrencia = detectarRecorrenciaNaoSuportada(message);
    // Achado da 1ª execução do arnês (A3): com texto de dia-da-semana o extrator de
    // posologia costuma NÃO produzir pares — o gatilho não pode depender só dele.
    // Horários citados na própria mensagem (regex determinística) também disparam.
    const horariosNaMensagem = extrairHorariosCitados(message);

    if (recorrencia.detectado && (mensagemTrouxeHorarios || horariosNaMensagem.length > 0)) {
        const { horarios, pares_posologia, intervalo_horas, horario_inicio, ...updatesPreservados } = updHorarios;

        // Quantidade embutida nos pares bloqueados sobrevive como pendente —
        // mesma mecânica que decidirCadHorarios já usa (quantidade_pendente).
        const quantidades = [...new Set((pares_posologia || []).map(p => Number(p.quantidade)).filter(Boolean))];
        if (quantidades.length === 1 && updatesPreservados.quantidade_pendente == null) {
            updatesPreservados.quantidade_pendente = quantidades[0];
            updatesPreservados.unidade_dose_pendente = updatesPreservados.unidade_dose || null;
            updatesPreservados.forma_explicita_pendente = updatesPreservados.forma_explicita || null;
        }

        const contextoBloqueado = { ...(context || {}), ...updatesPreservados, etapa: 'cad_horarios' };
        await saveConversationState(user.id, { state: 'adding_med', context: contextoBloqueado });

        const oferta = horariosNaMensagem.length > 0
            ? `Qual desses horários você quer usar todos os dias — ${horariosNaMensagem.join(' ou ')}?`
            : 'Qual horário você quer usar todos os dias?';

        console.log(`🧱 [VALIDADOR] Recorrência não suportada (${recorrencia.padroes.join(', ')}) — horários bloqueados — ${user.phone}`);
        return (
            `Por enquanto eu ainda não consigo variar os horários por dia da semana — ` +
            `só consigo te lembrar nos *mesmos horários todos os dias*. É algo que está chegando! 😊\n\n` +
            `Se estiver bom pra você, a gente já deixa um horário fixo por enquanto.\n\n` +
            oferta
        );
    }

    const proximaEtapa = decisao.proximaEtapa;
    // MH-073 Parte B.2 (BUG-91): novoContext vem só de context + decisao.contextUpdates —
    // não existe mais caminho pelo qual o LLM escreva no contexto persistido.
    const novoContext = { ...(context || {}), ...decisao.contextUpdates };

    // v44 (decisão de produto, replay 19/09): estoque respondido — com valor ou
    // "não sei" — FECHA o cadastro com o fechamento curto e determinístico. O
    // resumo já foi mostrado na gravação; a etapa de confirmação saiu do fluxo
    // principal (correção depois disso entra pela porta: configuração/estoque).
    if (decisao?.acao === 'estoque_resolvido' || decisao?.acao === 'estoque_nao_informado') {
        const medFechamento = await getMedicationComSchedulesAtivos(context.medication_id);
        const fechamento = montarFechamentoEstoque({
            med: medFechamento,
            alerta: decisao.contextUpdates?.alerta_estoque_baixo || null,
            primeiroMedicamento: !!context?.primeiroMedicamento,
            firstName: user.name ? user.name.split(' ')[0] : null
        });
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return fechamento;
    }

    // TRABALHO 2: verificação antecipada de medicamento existente. O gatilho é o FATO
    // "o nome acabou de ser coletado", não a posição na máquina de estados (seção 6.6
    // do briefing) — robusto a novas etapas inseridas antes de cad_dosagem no futuro.
    //
    // v43 Bloco C: esta checagem roda ANTES de qualquer geração de mensagem (inclusive
    // antes de cad_gravar) — sem isso, o MH-80 poderia extrair nome+horários na mesma
    // mensagem e gravar um medicamento duplicado antes de perguntar "quer reativar?".
    const nomeRecemColetado = !context?.nome && !!novoContext.nome;
    if (nomeRecemColetado) {
        const existente = await verificarMedicamentoExistente(user.id, novoContext.nome);

        if (existente) {
            const schedules = existente.schedules || [];
            const schedulesAtivos = schedules.filter(s => s.ativo);
            const todosInativos = schedules.length > 0 && schedulesAtivos.length === 0;

            if (!existente.ativo) {
                await saveConversationState(user.id, {
                    state: 'adding_med',
                    context: {
                        etapa: 'cad_reencadastro_confirmar',
                        nome: existente.nome,
                        medicationId: existente.id
                    }
                });
                return `O *${existente.nome}* foi encerrado anteriormente.\n\nQuer cadastrar um novo tratamento com ele agora?`;
            }

            if (todosInativos) {
                const horariosFormatados = schedules
                    .map(s => `• ${s.horario.substring(0, 5)}`)
                    .join('\n');
                const tipoLabel = existente.tipo_tratamento === 'temporario'
                    ? `${existente.tratamento_dias} dias`
                    : 'uso contínuo';

                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: {
                        etapa: 'reativ_confirmar',
                        medicationId: existente.id,
                        medicationNome: existente.nome,
                        estoqueAtual: existente.estoque_atual,
                        tipo_tratamento: existente.tipo_tratamento,
                        tratamento_dias: existente.tratamento_dias,
                        schedulesExistentes: schedules,
                        schedulesAtivos: schedulesAtivos
                    }
                });
                return `O *${existente.nome}* está com os lembretes pausados 💊\n\nÚltimos dados cadastrados:\n${horariosFormatados}\nEstoque: ${existente.estoque_atual} unidades\nTratamento: ${tipoLabel}\n\nQuer reativar os lembretes?`;
            }

            const horariosFormatados = schedulesAtivos
                .map(s => `• ${s.horario.substring(0, 5)}`)
                .join('\n');
            const tipoLabel = existente.tipo_tratamento === 'temporario'
                ? `${existente.tratamento_dias} dias`
                : 'uso contínuo';

            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `O *${existente.nome}* já está cadastrado e ativo 💊\n\nDosagem: ${existente.dosagem}\nHorários:\n${horariosFormatados}\nEstoque: ${existente.estoque_atual} unidades\nTratamento: ${tipoLabel}\n\nSe quiser atualizar alguma informação, é só me dizer!`;
        }
    }

    // v43 Bloco C (MH-094, Parte 3.2): cad_gravar é ação interna, nunca vista pelo
    // usuário como etapa. Grava o have-to-have (nome + posologia) AGORA — antes de
    // qualquer campo opcional — e segue, no MESMO turno, para a pergunta real seguinte
    // (normalmente estoque), com a confirmação de gravação lida de volta do banco (P56).
    if (proximaEtapa === 'cad_gravar') {
        // Se o estoque já veio nesta mesma mensagem (MH-80/extrairCadastroCompleto), a
        // gravação já aplica esse valor — sem isso, a pessoa teria que repetir o que já
        // disse (P57). `!== null && !== undefined`: zero é estoque legítimo (BUG-97).
        const estoqueJaConhecido = novoContext.estoque_resolvido !== null && novoContext.estoque_resolvido !== undefined;

        const medicamentosAtivosAntes = await getUserMedications(user.id);
        const primeiroMedicamento = medicamentosAtivosAntes.length === 0;

        const action = {
            nome: novoContext.nome,
            dosagem: novoContext.dosagem ?? null,
            tipo_tratamento: novoContext.tipo_tratamento || 'continuo',
            tratamento_dias: novoContext.tratamento_dias || null,
            pares: novoContext.pares_posologia || [],
            estoque: estoqueJaConhecido ? novoContext.estoque_resolvido : null,
            unidade_dose: novoContext.unidade_dose || 'unidade',
            unidade_estoque: novoContext.unidade_estoque || 'unidade',
            gotas_por_ml: novoContext.gotas_por_ml ?? null,
            forma_explicita: novoContext.forma_explicita || null,
            forma_confirmada: novoContext.forma_confirmada || null,
            estoque_motivo: estoqueJaConhecido ? (novoContext.estoque_motivo || null) : null,
            estoque_estimado: estoqueJaConhecido ? !!novoContext.estoque_estimado : false
        };
        const resultado = await processarAcao(action, user);

        if (resultado?.messageOverride) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return resultado.messageOverride;
        }

        console.log(`✅ [MH-094] Gravação antecipada: ${resultado.med.nome} (id: ${resultado.med.id}) — ${user.phone}`);

        const contextComMedId = {
            ...novoContext,
            medication_id: resultado.med.id,
            primeiroMedicamento,
            ...(estoqueJaConhecido ? {
                estoque_perguntado: true,
                alerta_estoque_baixo: calcularAlertaEstoque(novoContext, novoContext.estoque_resolvido)
            } : {})
        };
        const proximaEtapaReal = primeiraEtapaFaltante(contextComMedId);

        // v44 (decisão de produto, replay 19/09): a mensagem pós-gravação é 100%
        // determinística — declaração (regra 2) + RESUMO lido do banco (P56) + a
        // pergunta de estoque (código). O resumo vinha só depois do estoque, mas o
        // estoque nem sempre chega; sem estoque informado, o resumo sai sem a linha 📦.
        const firstName = user.name ? user.name.split(' ')[0] : null;
        const declarativa = `*${resultado.med.nome}* cadastrado${firstName ? `, ${firstName}` : ''}! Vou te lembrar nos horários certos. 💊`;
        const { resumo, med: medGravado } = await montarResumoDoBanco(resultado.med.id);

        if (proximaEtapaReal.startsWith('cad_estoque')) {
            const pergunta = renderizarPerguntaEstoque(proximaEtapaReal, contextComMedId, firstName);
            await saveConversationState(user.id, {
                state: 'adding_med',
                context: { ...contextComMedId, etapa: proximaEtapaReal }
            });
            return `${declarativa}\n\n${resumo}\n\n${pergunta}`;
        }

        // Estoque já veio na mesma mensagem (MH-80) — nada mais a coletar:
        // fechamento curto, sem etapa de confirmação.
        const fechamento = montarFechamentoEstoque({
            med: medGravado,
            alerta: contextComMedId.alerta_estoque_baixo || null,
            primeiroMedicamento,
            firstName
        });
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `${declarativa}\n\n${resumo}\n\n${fechamento}`;
    }

    const contextResolvido = { ...(context || {}), ...decisao.contextUpdates, ...(decisao.contextParaPrompt || {}) };
    const systemPrompt = buildSystemPrompt(proximaEtapa, contextResolvido, user.name, historicoConversa);
    const claudeResponse = await callClaude({ systemPrompt, message });
    const mensagemFinal = claudeResponse.message;

    if (proximaEtapa === 'cad_salvo') {
        // v43 Bloco C (MH-094): o medicamento já foi gravado em cad_gravar, e estoque/
        // correções já escrevem direto no banco (Parte 4) — não existe mais nada a
        // salvar aqui. cad_salvo só fecha o fluxo (P56: a mensagem de sucesso reflete
        // um estado que já está gravado, nunca uma promessa).
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return mensagemFinal;
    }

    await saveConversationState(user.id, {
        state: 'adding_med',
        context: { ...novoContext, etapa: proximaEtapa }
    });
    return mensagemFinal;
}

// ============================================================
// MH-073 Parte B.1 — REPETIÇÃO DA PERGUNTA PENDENTE (regra de reentrada, seção 3.3)
// ============================================================
//
// Usada por despacharCadastro (router.js) quando { escalarParaRoteador: true } sobe e o
// classificador central, ao reclassificar, devolve 'cadastro' de novo — ele está
// CONCORDANDO que o usuário não saiu do fluxo. Chama buildSystemPrompt/callClaude
// DIRETO, sem passar por decidirEtapa: a mensagem que causou a escalada já foi julgada
// nova_intencao pela camada 2 (classificarIndeterminadoCadastro) e reclassificá-la de
// novo aqui arriscaria um segundo veredito divergente, além de dobrar a chamada de LLM
// no caminho de falha. Não há nada novo para decidir — só repetir a pergunta.
//
// resumoRenderizado (cad_confirmacao) e blocoConfirmaForma (cad_confirma_forma) não
// ficam persistidos no contexto salvo (são só contextParaPrompt, descartado após o uso)
// — por isso são recompostos aqui a partir do contexto já coletado, sem reclassificar
// nada: garantirResumo é puro código (renderizarResumo), e prepararContextoConfirmaForma
// só chama LLM para sugerir forma farmacêutica quando ainda não há forma_explicita —
// mesmo custo que a primeira vez que a etapa foi montada.
export async function repetirPerguntaCadastro({ context, userName, historicoConversa = [] }) {
    const etapa = context?.etapa || 'cad_nome';
    let contextParaPrompt = {};

    if (etapa === 'cad_confirma_forma') {
        // Cópia rasa: prepararContextoConfirmaForma muta o objeto recebido
        // (forma_sugerida) — mesma disciplina de calcularDecisaoEtapa, nunca passar o
        // context original do chamador.
        contextParaPrompt.blocoConfirmaForma = await prepararContextoConfirmaForma({ ...context }, {}, context?.nome);
    }
    contextParaPrompt = await garantirResumo(etapa, context, contextParaPrompt);

    const contextResolvido = { ...(context || {}), ...contextParaPrompt };
    const systemPrompt = buildSystemPrompt(etapa, contextResolvido, userName, historicoConversa);
    const claudeResponse = await callClaude({ systemPrompt, message: '' });
    return claudeResponse.message;
}
