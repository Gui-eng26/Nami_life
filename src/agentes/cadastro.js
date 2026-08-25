import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import {
    saveConversationState,
    saveMedication,
    saveSchedule,
    replaceMedication,
    verificarMedicamentoExistente,
    formatarHistoricoConversa,
    converterDoseParaEstoque
} from '../database.js';
import { degradar } from '../observabilidade.js';

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
        .map(p => `**${p.quantidade} ${pluralizarRotulo(rotulo, p.quantidade)}** às ${p.horario}`)
        .join(' e ');
}

function renderizarListaPosologia(pares, rotulo) {
    return [...(pares || [])]
        .sort((a, b) => a.horario.localeCompare(b.horario))
        .map(p => `   • ${p.horario} — ${p.quantidade} ${pluralizarRotulo(rotulo, p.quantidade)}`)
        .join('\n');
}

function renderizarResumo(context, estoqueFinal) {
    const pares = context?.pares_posologia || [];
    const forma = derivarFormaFarmaceutica(context?.forma_explicita, context?.forma_confirmada, context?.unidade_dose);
    const rotuloDose = rotuloDaDose(context?.unidade_dose, forma);
    const tratamento = context?.tipo_tratamento === 'temporario'
        ? `${context?.tratamento_dias} dias`
        : 'contínuo';

    let linhaEstoque = `${estoqueFinal} ${context?.unidade_estoque === 'ml' ? 'ml' : 'unidades'}`;
    if (context?.unidade_estoque === 'ml' && context?.frascos && context?.volume_frasco) {
        linhaEstoque += ` (${context.frascos} frasco${Number(context.frascos) === 1 ? '' : 's'} de ${context.volume_frasco}ml)`;
    }

    return `💊 Remédio: ${context?.nome}\n`
        + `📏 Dosagem: ${context?.dosagem}\n`
        + `💉 Forma: ${forma}\n`
        + `⏰ Posologia:\n${renderizarListaPosologia(pares, rotuloDose)}\n`
        + `🔄 Tratamento: ${tratamento}\n`
        + `📦 Estoque: ${linhaEstoque}`;
}

// ============================================================
// MH-073 Parte B — EXTRAÇÃO NUMÉRICA DE ESTOQUE (frasco lacrado)
// ============================================================

function extrairNumero(texto) {
    const m = String(texto).match(/\d+(?:[.,]\d+)?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
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
- quantidade: dá para calcular um total em unidades. Exemplos:
  "30" -> 30 | "Tenho 30 cps" -> 30 | "Caixa com 60" -> 60 | "2 caixas de 30" -> 60 |
  "1 caixa com 30" -> 30 | "3 cartelas de 10" -> 30 | "meia caixa de 20" -> 10 |
  "não tenho nenhum" -> 0 | "acabou" -> 0 | "zero" -> 0.
- indeterminado: não há número reconhecível, ou a embalagem foi citada sem o conteúdo dela
  ("uma caixa" sem dizer quantas unidades tem, "tenho bastante", "bastante coisa").

Zero é uma resposta LEGÍTIMA e DIFERENTE de "não consegui entender" — só devolva "quantidade": 0
quando a pessoa disser explicitamente que não tem nenhum. Nunca chute um número quando a mensagem
não permitir calcular um total com segurança.

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
    const categoria = parsed.categoria === 'quantidade' && quantidade !== null ? 'quantidade' : 'indeterminado';

    return { categoria, quantidade: categoria === 'quantidade' ? quantidade : null };
}

// Etapa cad_estoque / cad_estoque_volume, ramificada por unidade_estoque (já resolvida
// três etapas antes). Só o CÓDIGO decide estoque, alerta e a próxima etapa — o LLM de
// geração apenas fraseia (mesmo princípio da seção 6 do briefing). Substitui o bloco
// pré-Parte B que dividia estoque por número de horários (BUG corrigido na Parte B,
// seção 7 do briefing): agora usa converterDoseParaEstoque sobre a posologia real.
async function processarEstoque(etapaAtual, message, context, historicoConversa) {
    const unidadeEstoque = context?.unidade_estoque || 'unidade';

    const finalizarComEstoque = (estoque, extra = {}) => {
        const contextComExtra = { ...context, ...extra };
        const contextUpdates = {
            estoque_resolvido: estoque,
            ...extra,
            alerta_estoque_baixo: calcularAlertaEstoque(contextComExtra, estoque)
        };

        return {
            acao: 'estoque_resolvido',
            proximaEtapa: 'cad_confirmacao',
            contextUpdates,
            resumoRenderizado: renderizarResumo({ ...context, ...contextUpdates }, estoque)
        };
    };

    if (etapaAtual === 'cad_estoque') {
        if (unidadeEstoque === 'ml') {
            const { frascos, volume } = extrairFrascosEVolume(message);
            if (frascos !== null && volume !== null) {
                // resposta única ("2 frascos de 10ml") — salta cad_estoque_volume (seção 2.5)
                return finalizarComEstoque(frascos * volume, { frascos, volume_frasco: volume });
            }
            return {
                acao: 'frascos_apenas',
                proximaEtapa: 'cad_estoque_volume',
                contextUpdates: { frascos: frascos ?? null }
            };
        }
        const classificacao = await classificarEstoqueSolido({ message, nomeMedicamento: context?.nome, historicoConversa });
        if (classificacao.categoria === 'quantidade') {
            return finalizarComEstoque(classificacao.quantidade);
        }
        // Falha de extração devolve indeterminado, NUNCA 0 (seção 3.3.b do briefing) —
        // permanece em cad_estoque e reformula a pergunta, nunca chega a salvar estoque nulo.
        return { acao: 'estoque_indeterminado', proximaEtapa: 'cad_estoque', contextUpdates: {} };
    }

    // cad_estoque_volume — só existe para líquidos. Única mudança no ramo líquido: quando
    // o volume não é reconhecido, repergunta em vez de assumir 0 (seção 3.3, "ramo líquido").
    const volume = extrairNumero(message);
    if (volume === null) {
        return { acao: 'volume_indeterminado', proximaEtapa: 'cad_estoque_volume', contextUpdates: {} };
    }
    const frascos = Number(context?.frascos) || 1;
    return finalizarComEstoque(frascos * volume, { volume_frasco: volume });
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
- frequencia_intervalo: frequência regular sem horários explícitos. Ex: "de 8 em 8 horas",
  "3 vezes ao dia", "12/12h".
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

    return { categoria, dias };
}

// ADENDO MH-80 (25/08/2026), DEFEITO 2 — ponto único de decisão de avanço. Tanto o
// salto do MH-80 quanto as transições passo a passo (dosagem, confirma_forma, tipo de
// tratamento) consultam esta função, para que nenhuma etapa já resolvida no contexto
// seja perguntada de novo. Caminhos de indeterminado/repergunta NÃO a usam — eles
// devolvem a própria etapa de propósito, e substituí-los faria o fluxo avançar sem
// ter coletado o dado.
function primeiraEtapaFaltante(ctx) {
    if (!ctx?.nome) return 'cad_nome';
    if (!ctx?.dosagem) return 'cad_dosagem';
    if (!ctx?.pares_posologia?.length) return 'cad_horarios';
    if (!ctx?.forma_explicita && !ctx?.forma_confirmada) return 'cad_confirma_forma';
    if (!ctx?.tipo_tratamento || ctx?.tipo_tratamento_pendente) return 'cad_tipo_tratamento';
    // estoque_resolvido === null/undefined — NUNCA `!ctx.estoque_resolvido`: zero é
    // estoque legítimo (BUG-97) e `!0` é `true`, o que repergunta eternamente um
    // estoque zerado válido.
    if (ctx?.estoque_resolvido === null || ctx?.estoque_resolvido === undefined) {
        if (ctx?.unidade_estoque === 'ml' && ctx?.frascos && !ctx?.volume_frasco) return 'cad_estoque_volume';
        return 'cad_estoque';
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
  nome, dosagem, horarios, quantidade, tipo_tratamento, estoque
Exemplos:
  "o horário está errado" -> horarios
  "na verdade é às 14:40, não às 8h" -> horarios
  "a dosagem não é essa" -> dosagem
  "é pra 5 dias, não 3" -> tipo_tratamento
  "é 2 comprimidos, não 1" -> quantidade
  "o nome está errado" -> nome
  "o estoque não é esse" -> estoque
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

    const camposValidos = new Set(['nome', 'dosagem', 'horarios', 'quantidade', 'tipo_tratamento', 'estoque']);
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

    return { categoria, campoAlvo };
}

// Reaplica a posologia corrigida a partir de cad_confirmacao. Recalcula o alerta de
// estoque (a quantidade por dose pode ter mudado) e regenera o resumo — o fluxo volta
// para cad_confirmacao já mostrando o resumo atualizado, sem repetir perguntas já
// respondidas (BUG-91, seção 6.4 do briefing).
function corrigirPosologiaEmConfirmacao(campoAlvo, classificacao, context) {
    const horariosAtuais = (context?.pares_posologia || []).map(p => p.horario);

    const aplicarNovosPares = (pares, extra = {}) => {
        const unidades = derivarUnidades(classificacao.unidadeDose || context?.unidade_dose || 'unidade');
        const contextComPares = {
            ...context,
            pares_posologia: pares,
            horarios: pares.map(p => p.horario),
            unidade_dose: unidades.unidade_dose,
            unidade_estoque: unidades.unidade_estoque,
            gotas_por_ml: unidades.gotas_por_ml,
            ...extra
        };
        const estoqueFinal = context?.estoque_resolvido ?? 0;
        const alerta = calcularAlertaEstoque(contextComPares, estoqueFinal);
        const contextUpdates = {
            pares_posologia: pares,
            horarios: pares.map(p => p.horario),
            unidade_dose: unidades.unidade_dose,
            unidade_estoque: unidades.unidade_estoque,
            gotas_por_ml: unidades.gotas_por_ml,
            alerta_estoque_baixo: alerta,
            ...extra
        };
        return {
            acao: 'posologia_corrigida',
            proximaEtapa: 'cad_confirmacao',
            contextUpdates,
            resumoRenderizado: renderizarResumo({ ...contextComPares, ...contextUpdates }, estoqueFinal)
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
        if (classificacao.horarioInicio) {
            const grade = recalcularGradePorIntervalo(context?.pares_posologia, classificacao.horarioInicio, classificacao.intervaloHoras);
            if (grade) {
                const extra = { intervalo_horas: classificacao.intervaloHoras, horario_inicio: classificacao.horarioInicio };
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
  volumeFrasco:100).
- tipoTratamento: "continuo" | "temporario" | null (ver REGRAS ADICIONAIS).
- tratamentoDias: número de dias, só quando explícito e o tratamento for temporário.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

MENSAGEM ATUAL: "${message}"

Responda APENAS com um objeto JSON válido, sem markdown, sem backticks, sem explicação:
{
  "nome": null, "dosagem": null, "pares": [], "intervaloHoras": null, "horarioInicio": null,
  "quantidadeUnica": null, "unidadeDose": null, "formaExplicita": null,
  "estoqueQuantidade": null, "frascos": null, "volumeFrasco": null, "tipoTratamento": null,
  "tratamentoDias": null
}`;
}

function fallbackCadastroCompleto() {
    return {
        nome: null, dosagem: null, pares: [], intervaloHoras: null, horarioInicio: null,
        quantidadeUnica: null, unidadeDose: null, formaExplicita: null,
        estoqueQuantidade: null, frascos: null, volumeFrasco: null, tipoTratamento: null,
        tratamentoDias: null
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

    return {
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
        tipoTratamento,
        tratamentoDias: tipoTratamento === 'temporario' ? tratamentoDias : null
    };
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
            return {
                acao: 'horarios_completados_com_quantidade_pendente',
                proximaEtapa: formaExplicita ? 'cad_tipo_tratamento' : 'cad_confirma_forma',
                contextUpdates: {
                    horarios, pares_posologia: pares,
                    unidade_dose: unidades.unidade_dose,
                    unidade_estoque: unidades.unidade_estoque,
                    gotas_por_ml: unidades.gotas_por_ml,
                    forma_explicita: formaExplicita,
                    quantidade_pendente: null, unidade_dose_pendente: null, forma_explicita_pendente: null
                }
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
        return {
            acao: 'frequencia_sem_inicio',
            proximaEtapa: 'cad_horarios',
            contextUpdates: { intervalo_horas: context.intervalo_horas }
        };
    }

    switch (classificacao.categoria) {
        case 'posologia_completa': {
            const unidades = derivarUnidades(classificacao.unidadeDose || 'unidade');
            return {
                acao: 'posologia_completa',
                proximaEtapa: classificacao.formaExplicita ? 'cad_tipo_tratamento' : 'cad_confirma_forma',
                contextUpdates: {
                    horarios: classificacao.pares.map(p => p.horario),
                    pares_posologia: classificacao.pares,
                    unidade_dose: unidades.unidade_dose,
                    unidade_estoque: unidades.unidade_estoque,
                    gotas_por_ml: unidades.gotas_por_ml,
                    forma_explicita: classificacao.formaExplicita || null
                }
            };
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
            return {
                acao: 'quantidade_apenas',
                proximaEtapa: classificacao.formaExplicita ? 'cad_tipo_tratamento' : 'cad_confirma_forma',
                contextUpdates: {
                    pares_posologia: pares,
                    unidade_dose: unidades.unidade_dose,
                    unidade_estoque: unidades.unidade_estoque,
                    gotas_por_ml: unidades.gotas_por_ml,
                    forma_explicita: classificacao.formaExplicita || null
                }
            };
        }
        case 'posologia_completa': {
            const unidades = derivarUnidades(classificacao.unidadeDose || 'unidade');
            return {
                acao: 'posologia_completa',
                proximaEtapa: classificacao.formaExplicita ? 'cad_tipo_tratamento' : 'cad_confirma_forma',
                contextUpdates: {
                    horarios: classificacao.pares.map(p => p.horario),
                    pares_posologia: classificacao.pares,
                    unidade_dose: unidades.unidade_dose,
                    unidade_estoque: unidades.unidade_estoque,
                    gotas_por_ml: unidades.gotas_por_ml,
                    forma_explicita: classificacao.formaExplicita || null
                }
            };
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
        return {
            acao: 'quantidade_corrigida',
            proximaEtapa: 'cad_tipo_tratamento',
            contextUpdates: {
                pares_posologia: classificacao.pares,
                forma_confirmada: classificacao.formaExplicita || context?.forma_sugerida || null
            }
        };
    }

    if (classificacao.categoria === 'horarios_apenas' && classificacao.pares.length > 0) {
        // BUG-98: mesma lógica de corrigirPosologiaEmConfirmacao — recalcula em código a
        // partir de um intervalo já declarado só quando dá pra identificar com segurança
        // que foi o início que mudou; senão remapeia por posição ordenada.
        const { horarios, pares, extra } = resolverCorrecaoHorariosApenas(
            context?.pares_posologia, classificacao.pares, context?.intervalo_horas, context?.horario_inicio
        );
        if (pares) {
            return {
                acao: 'horarios_corrigidos',
                proximaEtapa: 'cad_tipo_tratamento',
                contextUpdates: {
                    horarios,
                    pares_posologia: pares,
                    forma_confirmada: context?.forma_sugerida || null,
                    ...extra
                }
            };
        }
        return {
            acao: 'horarios_corrigidos_ambiguo',
            proximaEtapa: 'cad_quantidade_por_dose',
            contextUpdates: { horarios, pares_posologia: null, ...extra }
        };
    }

    if (classificacao.categoria === 'frequencia_intervalo') {
        if (classificacao.horarioInicio) {
            const grade = recalcularGradePorIntervalo(context?.pares_posologia, classificacao.horarioInicio, classificacao.intervaloHoras);
            if (grade) {
                const extra = { intervalo_horas: classificacao.intervaloHoras, horario_inicio: classificacao.horarioInicio };
                if (grade.pares) {
                    return {
                        acao: 'horarios_corrigidos',
                        proximaEtapa: 'cad_tipo_tratamento',
                        contextUpdates: { horarios: grade.horarios, pares_posologia: grade.pares, forma_confirmada: context?.forma_sugerida || null, ...extra }
                    };
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
    // forma_confirmada pode legitimamente ser null (rótulo genérico) — o objeto passado
    // a primeiraEtapaFaltante usa um marcador que CONTA como truthy (o check ali é
    // `!ctx?.forma_confirmada`; '' também é falsy em JS e cairia de volta em
    // cad_confirma_forma, travando o fluxo — por isso não usar string vazia). O
    // contextUpdates persistido continua com o valor real (null).
    const upd = { forma_confirmada: context?.forma_sugerida || null };
    return {
        acao: respostaConfirmaSimples(message) ? 'confirmado' : 'avanca_sem_confirmacao_clara',
        proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd, forma_confirmada: upd.forma_confirmada ?? 'generico' }),
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
    if (completo.frascos && completo.volumeFrasco) {
        estoqueResolvido = completo.frascos * completo.volumeFrasco;
        contextUpdates.frascos = completo.frascos;
        contextUpdates.volume_frasco = completo.volumeFrasco;
    } else if (completo.frascos) {
        contextUpdates.frascos = completo.frascos;
    } else if (completo.estoqueQuantidade !== null) {
        estoqueResolvido = completo.estoqueQuantidade;
    }

    // ADENDO MH-80, DEFEITO 1: o estoque precisa entrar no contexto AGORA, não só no
    // caminho completo — qualquer saída antecipada (dosagem, horários, forma, tipo de
    // tratamento) descartaria um valor já extraído corretamente. `!== null` (nunca
    // truthy): zero é estoque legítimo (BUG-97).
    if (estoqueResolvido !== null) {
        contextUpdates.estoque_resolvido = estoqueResolvido;
    }

    // ADENDO MH-80, DEFEITO 2: ponto único de decisão de avanço (Princípio 30) — a
    // mesma ordem canônica usada nas transições passo a passo, para que nenhuma etapa
    // já resolvida aqui seja perguntada de novo depois.
    const proximaEtapa = primeiraEtapaFaltante(contextUpdates);
    if (proximaEtapa !== 'cad_confirmacao') {
        return { proximaEtapa, contextUpdates };
    }

    // alerta_estoque_baixo só é calculado no caminho completo, onde a posologia já
    // existe — calculá-lo sem posologia produziria dias-restantes errado (o defeito
    // original do cadastro.js:409, corrigido na Parte B).
    contextUpdates.alerta_estoque_baixo = calcularAlertaEstoque(contextUpdates, estoqueResolvido);
    return {
        proximaEtapa: 'cad_confirmacao',
        contextUpdates,
        contextParaPrompt: { resumoRenderizado: renderizarResumo(contextUpdates, estoqueResolvido) }
    };
}

async function decidirEtapa(etapaAtual, message, context, historicoConversa) {
    if (etapaAtual === 'cad_nome') {
        // MH-80: só dispara a extração completa quando a mensagem tem indício de
        // conteúdo além do nome (dígito ou mais de 6 palavras) — evita uma chamada extra
        // em mensagens simples como "Claritin".
        const pareceCompleto = /\d/.test(message) || String(message).trim().split(/\s+/).filter(Boolean).length > 6;
        if (pareceCompleto) {
            const completo = await extrairCadastroCompleto({ message, historicoConversa });
            if (completo.nome) {
                const decisao = montarSaltoCadastroCompleto(completo);
                const contextParaPrompt = { ...(decisao.contextParaPrompt || {}) };
                if (decisao.proximaEtapa === 'cad_confirma_forma') {
                    const contextFinal = { ...context, ...decisao.contextUpdates };
                    contextParaPrompt.blocoConfirmaForma = await prepararContextoConfirmaForma(contextFinal, decisao.contextUpdates, completo.nome);
                }
                return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt };
            }
        }

        const c = await extrairCampoSimples({ campo: 'nome', message, historicoConversa });
        if (c.categoria === 'valor') {
            return { proximaEtapa: 'cad_dosagem', contextUpdates: { nome: c.valor } };
        }
        return { proximaEtapa: 'cad_nome', contextUpdates: {} };
    }

    if (etapaAtual === 'cad_dosagem') {
        const c = await extrairCampoSimples({ campo: 'dosagem', message, historicoConversa });
        if (c.categoria === 'valor') {
            return { proximaEtapa: primeiraEtapaFaltante({ ...context, dosagem: c.valor }), contextUpdates: { dosagem: c.valor } };
        }
        return { proximaEtapa: 'cad_dosagem', contextUpdates: {} };
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

        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt };
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
        // decisao.acao vira acaoPosologia quando o salto sai para cad_horarios/
        // cad_quantidade_por_dose (ex: frequencia_sem_inicio) — o mesmo mecanismo que
        // decidirCadHorarios usa, para que montarBlocoEtapa saiba fazer a pergunta certa
        // em vez da pergunta genérica de horários.
        const contextParaPrompt = decisao.proximaEtapa !== 'cad_tipo_tratamento'
            ? { acaoPosologia: decisao.acao }
            : {};
        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt };
    }

    if (etapaAtual === 'cad_tipo_tratamento') {
        const aguardandoDias = !!context?.tipo_tratamento_pendente;
        const classificacao = await classificarTipoTratamento({ message, nomeMedicamento: context?.nome, aguardandoDias, historicoConversa });
        const decisao = decidirCadTipoTratamento(classificacao, context);
        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt: { acaoTipoTratamento: decisao.acao } };
    }

    if (etapaAtual === 'cad_estoque' || etapaAtual === 'cad_estoque_volume') {
        const decisao = await processarEstoque(etapaAtual, message, context, historicoConversa);
        return {
            proximaEtapa: decisao.proximaEtapa,
            contextUpdates: decisao.contextUpdates,
            contextParaPrompt: decisao.proximaEtapa === 'cad_confirmacao'
                ? { resumoRenderizado: decisao.resumoRenderizado || null }
                : { acaoEstoque: decisao.acao }
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
                    return { proximaEtapa: 'cad_estoque', contextUpdates: {} };
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
                    const r = corrigirPosologiaEmConfirmacao(classificacao.campoAlvo, posologia, context);
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

        return { proximaEtapa: 'cad_confirmacao', contextUpdates: {} };
    }

    // Fallback de segurança — etapa desconhecida não deveria ocorrer.
    return { proximaEtapa: 'cad_nome', contextUpdates: {} };
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
            return `Pergunte o **NOME** do medicamento. Ex: "Vamos cadastrar seu **MEDICAMENTO**! Qual o **NOME** dele?"`;

        case 'cad_dosagem':
            return `Pergunte a **DOSAGEM** do ${nome} — geralmente vem no rótulo (ex: 50mg, 0,5%, 100mg/ml).`;

        case 'cad_horarios':
            if (context?.acaoPosologia === 'frequencia_sem_inicio') {
                return `Pergunte apenas: "Qual o horário da primeira dose do dia?"`;
            }
            if (context?.acaoPosologia === 'indeterminado') {
                return `Desculpe, não peguei direito 😊 Pergunte de novo em quais **HORÁRIOS** a
pessoa toma ou usa o ${nome}. Não cite nenhum horário ou quantidade — nem os que apareceram antes
na conversa.`;
            }
            return `Pergunte em quais **HORÁRIOS** a pessoa toma ou usa o ${nome}. Ex: "Agora vamos
à **FORMA DE USO**. Em quais **HORÁRIOS** você toma ou usa o ${nome}?"`;

        case 'cad_quantidade_por_dose':
            if (context?.mencionaConcentracao) {
                return `O usuário respondeu com a concentração do remédio (mg/ml/%), não com a
quantidade por dose. Distinga os dois: "Essa é a dosagem do remédio (a concentração). O que eu
preciso saber agora é **QUANTO** você toma de cada vez — por exemplo, 1 comprimido, 2 comprimidos,
20 gotas."`;
            }
            if (context?.acaoPosologia === 'indeterminado') {
                return `Desculpe, não peguei direito 😊 Pergunte de novo **QUANTO** de ${nome} a
pessoa toma ou usa em cada horário — por exemplo, 1 comprimido, 2 comprimidos, 20 gotas. Não cite
horários nem quantidades — nem os que apareceram antes na conversa.`;
            }
            return `Pergunte **QUANTO** de ${nome} a pessoa toma ou usa em cada horário. Ex: "Ainda
sobre a **FORMA DE USO**: **QUANTO** de ${nome} você toma ou usa em cada horário? (ex: 2
comprimidos, 1 cápsula, 20 gotas, 5ml)"`;

        case 'cad_confirma_forma':
            return `A mensagem deve ser EXATAMENTE: "${nome}, só confirmando: ${context?.blocoConfirmaForma || ''}?" — não altere nada desse trecho, é dado de saúde renderizado em código.`;

        case 'cad_tipo_tratamento':
            if (context?.acaoTipoTratamento === 'indeterminado') {
                return `Desculpe, não peguei direito 😊 Pergunte de novo: "O ${nome} é de uso
**CONTÍNUO** (sem previsão de parada) ou **TEMPORÁRIO**, com prazo definido — como um antibiótico
ou anti-inflamatório?" Não repita horários nem quantidade coletados antes.`;
            }
            if (context?.acaoTipoTratamento === 'temporario_sem_dias' || context?.tipo_tratamento_pendente) {
                return `O usuário já disse que o tratamento é temporário mas não disse por quantos
dias. Pergunte: "Por quantos dias, aproximadamente, é o tratamento com ${nome}?" Não repita
horários nem quantidade coletados antes.`;
            }
            return `Pergunte: "O ${nome} é de uso **CONTÍNUO** (sem previsão de parada) ou
**TEMPORÁRIO**, com prazo definido — como um antibiótico ou anti-inflamatório?" Se o usuário já
puder responder com o número de dias na mesma mensagem, tudo bem — a extração é feita em código.
Não repita horários nem quantidade coletados antes.`;

        case 'cad_estoque':
            if (context?.acaoEstoque === 'estoque_indeterminado') {
                return `Desculpe, não peguei direito 😊 Repita a pergunta, sem citar nenhum número:
"Quantas unidades de ${nome} você tem agora?" Não mencione horários nem posologia.`;
            }
            if (context?.unidade_estoque === 'ml') {
                return `Pergunte: "Quantos **FRASCOS** fechados de ${nome} você tem agora?" — a
palavra "fechados" é OBRIGATÓRIA (frasco aberto não é tratado como cheio). Não mencione horários
nem posologia.`;
            }
            return `Pergunte: "Quantas unidades de ${nome} você tem agora?" Não mencione horários
nem posologia.`;

        case 'cad_estoque_volume':
            if (context?.acaoEstoque === 'volume_indeterminado') {
                return `Desculpe, não peguei direito 😊 Repita, sem citar números: "Qual o
**VOLUME** de cada frasco, em ml? (está no rótulo — ex: 10ml, 100ml)"`;
            }
            return `Pergunte: "E qual o **VOLUME** de cada frasco, em ml? (está no rótulo — ex:
10ml, 100ml)"`;

        case 'cad_confirmacao':
            if (context?.resumoRenderizado) {
                const alerta = context?.alerta_estoque_baixo;
                const avisoInstrucao = alerta
                    ? `Comece com um aviso breve e gentil de estoque baixo: restam
aproximadamente ${alerta.dias_restantes} dias de estoque. Depois disso, `
                    : '';
                return `${avisoInstrucao}Insira EXATAMENTE este resumo (é dado de saúde renderizado
em código, nunca reescreva os números):\n${context.resumoRenderizado}\nFinalize perguntando "Está
tudo certinho?"`;
            }
            return `O usuário tentou corrigir algo, mas não ficou claro o quê. Pergunte, com
acolhimento e sem repetir o resumo nem citar nenhum número: "Desculpe, não peguei direito 😊 Pode
me dizer qual informação está errada — nome, dosagem, horários, quantidade, tratamento ou
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
            return `O usuário confirmou os dados e o cadastro FOI SALVO com sucesso pelo código.
Gere uma mensagem de sucesso carinhosa, sem inventar nem recalcular horário, quantidade ou
estoque.${instrucaoHorarios} Ex: "Ótimo! ${nome} foi cadastrado com sucesso 💊✅ Vou te lembrar nos
horários certos!"`;
        }

        default:
            return `Pergunte o **NOME** do medicamento.`;
    }
}

function buildSystemPrompt(etapaDaPergunta, context, userName, historicoConversa = []) {
    const nome = context?.nome || '{nome}';
    const blocoEtapa = montarBlocoEtapa(etapaDaPergunta, context, nome);

    return `Você é a Nami, assistente de saúde. Você está no fluxo de cadastro de um novo medicamento.

Sua única função agora é escrever UMA mensagem para o usuário — uma pergunta ou uma confirmação.
Toda decisão sobre em qual etapa estamos, o que já foi coletado e o que fazer com a resposta
anterior do usuário já foi tomada em código antes desta chamada. Você só fraseia.

Nome do usuário: ${userName || 'usuário'}

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

REGRAS DE TEXTO:
- Seja clara e direta. UMA informação por mensagem.
- O verbo é sempre "toma ou usa", nunca só "toma" — pomada e colírio não são ingeridos.
- O nome do medicamento (${nome}) SEMPRE aparece na pergunta.
- O rótulo do dado pedido vem em NEGRITO e MAIÚSCULA: **NOME**, **DOSAGEM**, **HORÁRIOS**,
  **QUANTO**, **CONTÍNUO**/**TEMPORÁRIO**, **FRASCOS**, **VOLUME**.
- Você NUNCA escreve horário, quantidade, unidade ou número de estoque de próprio punho — nem
  recalculando, nem repetindo o que apareceu na CONVERSA RECENTE. Esses valores só podem vir de um
  trecho pronto indicado explicitamente na instrução abaixo. Se a instrução não fornecer nenhum
  trecho pronto, não mencione esses dados de jeito nenhum, mesmo que eles apareçam na conversa.

O QUE ESCREVER AGORA (etapa: ${etapaDaPergunta}):
${blocoEtapa}

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
        estoque: action.estoque || 0,
        unidade_dose: action.unidade_dose || 'unidade',
        unidade_estoque: action.unidade_estoque || 'unidade',
        gotas_por_ml: action.gotas_por_ml ?? null
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

    // Salva os horários com a quantidade por dose de cada um (MH-073 Parte B)
    for (const par of action.pares || []) {
        await saveSchedule({
            medicationId: med.id,
            horario: String(par.horario).trim().substring(0, 5),
            quantidadePorDose: Number(par.quantidade) || 1
        });
    }

    console.log(`✅ Medicamento salvo: ${action.nome} (id: ${med.id}) para ${user.phone}`);
    return null;
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

        // Item 9.2 do briefing MH-073 Parte B: cad_forma foi removida — reencadastro
        // entra em cad_dosagem, não mais em cad_forma.
        const systemPrompt = buildSystemPrompt('cad_dosagem', { nome: context.nome }, user.name, historicoConversa);
        const claudeResponse = await callClaude({
            systemPrompt,
            message: `Quero cadastrar o ${context.nome} novamente`
        });

        await saveConversationState(user.id, {
            state: 'adding_med',
            context: { nome: context.nome, etapa: 'cad_dosagem' }
        });
        return claudeResponse.message;
    }

    if (ehCancelamento(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, cancelei o cadastro 🌿 Se quiser recomeçar, é só me chamar!`;
    }

    const decisao = await decidirEtapa(etapaAtual, message, context, historicoConversa);
    const contextResolvido = { ...(context || {}), ...decisao.contextUpdates, ...(decisao.contextParaPrompt || {}) };

    const systemPrompt = buildSystemPrompt(decisao.proximaEtapa, contextResolvido, user.name, historicoConversa);
    const claudeResponse = await callClaude({ systemPrompt, message });

    const proximaEtapa = decisao.proximaEtapa;
    // MH-073 Parte B.2 (BUG-91): novoContext vem só de context + decisao.contextUpdates —
    // não existe mais caminho pelo qual o LLM escreva no contexto persistido.
    const novoContext = { ...(context || {}), ...decisao.contextUpdates };

    // TRABALHO 2: verificação antecipada de medicamento existente. O gatilho é o FATO
    // "o nome acabou de ser coletado", não a posição na máquina de estados (seção 6.6
    // do briefing) — robusto a novas etapas inseridas antes de cad_dosagem no futuro.
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

    let mensagemFinal = claudeResponse.message;
    if (proximaEtapa === 'cad_salvo') {
        // Observabilidade (seção 7 do briefing) — nenhum dos cenários de validação
        // pegaria o "Claritin fantasma" sem isso: agent_logs registra a resposta
        // pretendida, não o efeito real (Princípio 24).
        const paresVazio = (novoContext.pares_posologia || []).length === 0;
        const estoqueNulo = novoContext.estoque_resolvido === null || novoContext.estoque_resolvido === undefined;
        if (paresVazio || estoqueNulo) {
            await degradar({
                origem: 'cadastro',
                motivo: 'salvamento_com_estado_incompleto',
                agent: 'cadastro',
                userId: user.id,
                detalhe: { pares_vazio: paresVazio, estoque_nulo: estoqueNulo },
                fallback: null
            });
        }

        const action = {
            type: 'SAVE_MEDICATION',
            nome: novoContext.nome,
            dosagem: novoContext.dosagem,
            tipo_tratamento: novoContext.tipo_tratamento || 'continuo',
            tratamento_dias: novoContext.tratamento_dias || null,
            pares: novoContext.pares_posologia || [],
            estoque: novoContext.estoque_resolvido ?? 0,
            unidade_dose: novoContext.unidade_dose || 'unidade',
            unidade_estoque: novoContext.unidade_estoque || 'unidade',
            gotas_por_ml: novoContext.gotas_por_ml ?? null,
            forma_explicita: novoContext.forma_explicita || null,
            forma_confirmada: novoContext.forma_confirmada || null
        };
        const resultado = await processarAcao(action, user);

        // BUG-92: o cadastro terminou AGORA. Não existe "próximo turno de cad_salvo" —
        // o estado precisa sair de adding_med imediatamente, senão a próxima mensagem
        // do usuário (inclusive confirmação de dose) é sequestrada pelo cadastro.
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return resultado?.messageOverride || mensagemFinal;
    }

    await saveConversationState(user.id, {
        state: 'adding_med',
        context: { ...novoContext, etapa: proximaEtapa }
    });
    return mensagemFinal;
}
