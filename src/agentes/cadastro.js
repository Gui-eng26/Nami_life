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

// Etapa cad_estoque / cad_estoque_volume, ramificada por unidade_estoque (já resolvida
// três etapas antes). Só o CÓDIGO decide estoque, alerta e a próxima etapa — o LLM de
// geração apenas fraseia (mesmo princípio da seção 6 do briefing). Substitui o bloco
// pré-Parte B que dividia estoque por número de horários (BUG corrigido na Parte B,
// seção 7 do briefing): agora usa converterDoseParaEstoque sobre a posologia real.
function processarEstoque(etapaAtual, message, context) {
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
        const estoque = parseInt(message) || 0;
        return finalizarComEstoque(estoque);
    }

    // cad_estoque_volume — só existe para líquidos
    const volume = extrairNumero(message);
    const frascos = Number(context?.frascos) || 1;
    return finalizarComEstoque(frascos * (volume || 0), { volume_frasco: volume });
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
function validarClassificacaoPosologia(parsed) {
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

    return {
        paresDescartados,
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

async function classificarPosologia({ message, campoEsperado, nomeMedicamento, horariosJaColetados = [], historicoConversa = [], emCorrecao = false }) {
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

    const { resultado, paresDescartados } = validarClassificacaoPosologia(parsed);

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

function decidirCadTipoTratamento(classificacao) {
    switch (classificacao.categoria) {
        case 'continuo':
            return {
                acao: 'continuo',
                proximaEtapa: 'cad_estoque',
                contextUpdates: { tipo_tratamento: 'continuo', tratamento_dias: null, tipo_tratamento_pendente: false }
            };
        case 'dias':
            return {
                acao: 'dias_informado',
                proximaEtapa: 'cad_estoque',
                contextUpdates: { tipo_tratamento: 'temporario', tratamento_dias: classificacao.dias, tipo_tratamento_pendente: false }
            };
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

    const aplicarNovosPares = (pares) => {
        const unidades = derivarUnidades(classificacao.unidadeDose || context?.unidade_dose || 'unidade');
        const contextComPares = {
            ...context,
            pares_posologia: pares,
            horarios: pares.map(p => p.horario),
            unidade_dose: unidades.unidade_dose,
            unidade_estoque: unidades.unidade_estoque,
            gotas_por_ml: unidades.gotas_por_ml
        };
        const estoqueFinal = context?.estoque_resolvido ?? 0;
        const alerta = calcularAlertaEstoque(contextComPares, estoqueFinal);
        const contextUpdates = {
            pares_posologia: pares,
            horarios: pares.map(p => p.horario),
            unidade_dose: unidades.unidade_dose,
            unidade_estoque: unidades.unidade_estoque,
            gotas_por_ml: unidades.gotas_por_ml,
            alerta_estoque_baixo: alerta
        };
        return {
            acao: 'posologia_corrigida',
            proximaEtapa: 'cad_confirmacao',
            contextUpdates,
            resumoRenderizado: renderizarResumo({ ...contextComPares, ...contextUpdates }, estoqueFinal)
        };
    };

    if (classificacao.categoria === 'posologia_completa') {
        return aplicarNovosPares(classificacao.pares);
    }

    if (campoAlvo === 'horarios' && classificacao.categoria === 'horarios_apenas') {
        const novosHorarios = classificacao.pares.map(p => p.horario);
        const remapeados = remapearParesParaNovosHorarios(context?.pares_posologia, novosHorarios);
        if (remapeados) return aplicarNovosPares(remapeados);
        return {
            acao: 'horarios_corrigidos',
            proximaEtapa: 'cad_quantidade_por_dose',
            contextUpdates: { horarios: novosHorarios, pares_posologia: null }
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
    if (classificacao.formaExplicita) {
        return {
            acao: 'forma_corrigida',
            proximaEtapa: 'cad_tipo_tratamento',
            contextUpdates: { forma_confirmada: classificacao.formaExplicita }
        };
    }
    // confirmação explícita OU qualquer outra coisa (rótulo genérico, nunca trava)
    return {
        acao: respostaConfirmaSimples(message) ? 'confirmado' : 'avanca_sem_confirmacao_clara',
        proximaEtapa: 'cad_tipo_tratamento',
        contextUpdates: { forma_confirmada: context?.forma_sugerida || null }
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
async function decidirEtapa(etapaAtual, message, context, historicoConversa) {
    if (etapaAtual === 'cad_nome') {
        const c = await extrairCampoSimples({ campo: 'nome', message, historicoConversa });
        if (c.categoria === 'valor') {
            return { proximaEtapa: 'cad_dosagem', contextUpdates: { nome: c.valor } };
        }
        return { proximaEtapa: 'cad_nome', contextUpdates: {} };
    }

    if (etapaAtual === 'cad_dosagem') {
        const c = await extrairCampoSimples({ campo: 'dosagem', message, historicoConversa });
        if (c.categoria === 'valor') {
            return { proximaEtapa: 'cad_horarios', contextUpdates: { dosagem: c.valor } };
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
            historicoConversa
        });

        const decisao = etapaAtual === 'cad_horarios'
            ? decidirCadHorarios(classificacao, context)
            : decidirCadQuantidade(classificacao, context);

        const mencionaConcentracao = etapaAtual === 'cad_quantidade_por_dose' && decisao.acao === 'indeterminado'
            && /\d+(?:[.,]\d+)?\s*(mg|mcg|g|%|mg\/ml)\b/i.test(message);

        const contextParaPrompt = { acaoPosologia: decisao.acao, mencionaConcentracao };

        if (decisao.proximaEtapa === 'cad_confirma_forma') {
            const contextFinal = { ...context, ...decisao.contextUpdates };
            if (!contextFinal.forma_explicita) {
                // O palpite precisa existir ANTES de renderizar o bloco: é ele que aparece
                // na frase de confirmação, para o usuário poder corrigir. Decisão 2.2 da
                // Parte B: a inferência NUNCA entra na pergunta (moldaria a resposta), mas
                // SEMPRE é submetida ao usuário na confirmação. Guardar o palpite sem
                // mostrá-lo é pior que os dois extremos — persiste inferência não validada.
                contextFinal.forma_sugerida = await sugerirFormaFarmaceutica({ nomeMedicamento: context?.nome });
                decisao.contextUpdates.forma_sugerida = contextFinal.forma_sugerida;
            }
            const rotulo = rotuloDaDose(
                contextFinal.unidade_dose,
                ROTULO_CANONICO[contextFinal.forma_sugerida] || null
            );
            contextParaPrompt.blocoConfirmaForma = renderizarBlocoPosologia(contextFinal.pares_posologia, rotulo);
        }

        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt };
    }

    if (etapaAtual === 'cad_confirma_forma') {
        const classificacao = await classificarPosologia({
            message,
            campoEsperado: 'quantidade',
            nomeMedicamento: context?.nome,
            horariosJaColetados: (context?.pares_posologia || []).map(p => p.horario),
            historicoConversa
        });
        const decisao = decidirCadConfirmaForma(classificacao, message, context);
        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt: {} };
    }

    if (etapaAtual === 'cad_tipo_tratamento') {
        const aguardandoDias = !!context?.tipo_tratamento_pendente;
        const classificacao = await classificarTipoTratamento({ message, nomeMedicamento: context?.nome, aguardandoDias, historicoConversa });
        const decisao = decidirCadTipoTratamento(classificacao);
        return { proximaEtapa: decisao.proximaEtapa, contextUpdates: decisao.contextUpdates, contextParaPrompt: { acaoTipoTratamento: decisao.acao } };
    }

    if (etapaAtual === 'cad_estoque' || etapaAtual === 'cad_estoque_volume') {
        const decisao = processarEstoque(etapaAtual, message, context);
        return {
            proximaEtapa: decisao.proximaEtapa,
            contextUpdates: decisao.contextUpdates,
            contextParaPrompt: decisao.proximaEtapa === 'cad_confirmacao'
                ? { resumoRenderizado: decisao.resumoRenderizado || null }
                : {}
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
                        emCorrecao: classificacao.campoAlvo === 'horarios'
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
            return `Pergunte em quais **HORÁRIOS** a pessoa toma ou usa o ${nome}. Ex: "Agora vamos
à **FORMA DE USO**. Em quais **HORÁRIOS** você toma ou usa o ${nome}?"`;

        case 'cad_quantidade_por_dose':
            if (context?.mencionaConcentracao) {
                return `O usuário respondeu com a concentração do remédio (mg/ml/%), não com a
quantidade por dose. Distinga os dois: "Essa é a dosagem do remédio (a concentração). O que eu
preciso saber agora é **QUANTO** você toma de cada vez — por exemplo, 1 comprimido, 2 comprimidos,
20 gotas."`;
            }
            return `Pergunte **QUANTO** de ${nome} a pessoa toma ou usa em cada horário. Ex: "Ainda
sobre a **FORMA DE USO**: **QUANTO** de ${nome} você toma ou usa em cada horário? (ex: 2
comprimidos, 1 cápsula, 20 gotas, 5ml)"`;

        case 'cad_confirma_forma':
            return `A mensagem deve ser EXATAMENTE: "${nome}, só confirmando: ${context?.blocoConfirmaForma || ''}?" — não altere nada desse trecho, é dado de saúde renderizado em código.`;

        case 'cad_tipo_tratamento':
            if (context?.acaoTipoTratamento === 'temporario_sem_dias') {
                return `O usuário já disse que o tratamento é temporário mas não disse por quantos
dias. Pergunte: "Por quantos dias, aproximadamente, é o tratamento com ${nome}?"`;
            }
            return `Pergunte: "O ${nome} é de uso **CONTÍNUO** (sem previsão de parada) ou
**TEMPORÁRIO**, com prazo definido — como um antibiótico ou anti-inflamatório?" Se o usuário já
puder responder com o número de dias na mesma mensagem, tudo bem — a extração é feita em código.`;

        case 'cad_estoque':
            if (context?.unidade_estoque === 'ml') {
                return `Pergunte: "Quantos **FRASCOS** fechados de ${nome} você tem agora?" — a
palavra "fechados" é OBRIGATÓRIA (frasco aberto não é tratado como cheio).`;
            }
            return `Pergunte: "Quantas unidades de ${nome} você tem agora?"`;

        case 'cad_estoque_volume':
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
            return `O usuário tentou corrigir algo, mas não ficou claro o quê. Pergunte, sem repetir
o resumo: "Não entendi bem o que você quer corrigir. Pode me dizer qual informação está errada —
nome, dosagem, horários, quantidade, tratamento ou estoque?"`;

        case 'cad_salvo':
            return `O usuário confirmou os dados e o cadastro FOI SALVO com sucesso pelo código.
Gere uma mensagem de sucesso carinhosa. Ex: "Ótimo! ${nome} foi cadastrado com sucesso 💊✅ Vou te
lembrar nos horários certos!"`;

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
- Nunca invente nem recalcule dado de saúde (quantidade, horário, estoque). Quando a instrução
  abaixo fornecer um trecho pronto, insira-o exatamente como está.

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
