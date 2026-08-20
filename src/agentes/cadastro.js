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

function pluralizarRotulo(rotulo, quantidade) {
    if (Number(quantidade) === 1) return rotulo;
    const plurais = {
        unidade: 'unidades', comprimido: 'comprimidos', capsula: 'cápsulas', cápsula: 'cápsulas'
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
        + `⏰ Posologia:\n${renderizarListaPosologia(pares, forma)}\n`
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

// Etapa cad_estoque / cad_estoque_volume, ramificada por unidade_estoque (já resolvida
// três etapas antes). Só o CÓDIGO decide estoque, alerta e a próxima etapa — o LLM de
// geração apenas fraseia (mesmo princípio da seção 6 do briefing). Substitui o bloco
// pré-Parte B que dividia estoque por número de horários (BUG corrigido na Parte B,
// seção 7 do briefing): agora usa converterDoseParaEstoque sobre a posologia real.
function processarEstoque(etapaAtual, message, context) {
    const unidadeEstoque = context?.unidade_estoque || 'unidade';

    const finalizarComEstoque = (estoque, extra = {}) => {
        const pares = context?.pares_posologia || [];
        const somaDoses = pares.reduce((acc, p) => acc + Number(p.quantidade || 0), 0);
        const consumoDiario = converterDoseParaEstoque({
            quantidade: somaDoses,
            unidade_dose: context?.unidade_dose,
            unidade_estoque: context?.unidade_estoque,
            gotas_por_ml: context?.gotas_por_ml
        });
        const diasRestantes = consumoDiario > 0 ? Math.floor(estoque / consumoDiario) : 0;
        const tratamentoDias = context?.tratamento_dias || null;
        const deveAlertar = tratamentoDias !== null
            ? diasRestantes < tratamentoDias
            : diasRestantes <= 5;

        const contextUpdates = {
            estoque_resolvido: estoque,
            ...extra,
            alerta_estoque_baixo: deveAlertar ? {
                dias_restantes: diasRestantes,
                estoque,
                doses_por_dia: pares.length || (context?.horarios || []).length || 1,
                tipo_tratamento: tratamentoDias ? 'temporario' : 'continuo',
                tratamento_dias: tratamentoDias
            } : null
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
// cad_horarios, cad_quantidade_por_dose e cad_confirma_forma, evita estados
// incoerentes e permite o salto de etapa quando a resposta já traz tudo.
//
// A pergunta que este classificador faz é "o que é isso?", nunca "isso serve
// para o campo que eu esperava?" — mesma forma do extrairComponenteData do
// MH-072, evitando a falácia formato-≠-pertencimento (BUG-030, BUG-086).

function buildPosologiaSystemPrompt({ nomeMedicamento, campoEsperado, horariosJaColetados, historicoConversa, message }) {
    const campoEsperadoTexto = campoEsperado === 'horarios'
        ? 'em quais horários a pessoa toma ou usa o medicamento'
        : 'quanto a pessoa toma ou usa em cada horário';

    const horariosTexto = horariosJaColetados && horariosJaColetados.length > 0
        ? horariosJaColetados.join(', ')
        : 'nenhum';

    return `Você é um classificador de posologia para uma assistente de saúde via WhatsApp (a Nami), que
ajuda pessoas a tomarem seus medicamentos corretamente.

A Nami está cadastrando o medicamento "${nomeMedicamento || ''}" e perguntou sobre ${campoEsperadoTexto}.
Sua tarefa é extrair da mensagem TUDO o que ela contiver sobre a posologia — mesmo o que não foi
perguntado.

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

async function classificarPosologia({ message, campoEsperado, nomeMedicamento, horariosJaColetados = [], historicoConversa = [] }) {
    const systemPrompt = buildPosologiaSystemPrompt({ nomeMedicamento, campoEsperado, horariosJaColetados, historicoConversa, message });

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

// ============================================================
// SYSTEM PROMPT — FLUXO DE GERAÇÃO
// ============================================================

function buildSystemPrompt(etapa, context, userName, historicoConversa = []) {
    return `Você é a Nami, assistente de saúde. Você está no fluxo de cadastro de um novo medicamento.

Sua única função agora é coletar as informações necessárias para cadastrar o medicamento corretamente, uma pergunta por vez.

Etapa atual: ${etapa}
Contexto coletado até agora: ${JSON.stringify(context)}
Nome do usuário: ${userName || 'usuário'}

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

REGRAS GERAIS:
- Colete UMA informação por mensagem.
- Seja clara e direta nas perguntas.
- O verbo é sempre "toma ou usa", nunca só "toma" — pomada e colírio não são ingeridos.
- O nome do medicamento (context.nome) SEMPRE aparece na pergunta. Nunca "qual a dosagem?",
  sempre "qual a dosagem do ${context?.nome || '{nome}'}?".
- O rótulo do dado pedido vem em NEGRITO e MAIÚSCULA: **NOME**, **DOSAGEM**, **HORÁRIOS**,
  **QUANTO**, **CONTÍNUO**/**TEMPORÁRIO**, **FRASCOS**, **VOLUME**.
- NÃO confirme parcialmente durante a coleta — só mostre o resumo completo na etapa cad_confirmacao.
- Se o usuário quiser cancelar ("deixa pra lá", "cancela", "esquece"), encerre o fluxo com gentileza (proximaEtapa: "idle").

REGRA DE PERSISTÊNCIA DE CONTEXTO (CRÍTICA):
Ao retornar novoContext, SEMPRE inclua TODOS os campos já coletados nas etapas
anteriores com seus valores atuais. NUNCA retorne um campo já preenchido como null.
O contexto recebido ("Contexto coletado até agora") contém o estado atual —
preserve todos os valores e apenas ADICIONE ou ATUALIZE o que mudou nesta etapa.

REGRA ANTI-LOOP (CRÍTICA):
Se o usuário demonstrar frustração, confusão repetida, ou se a mesma etapa
se repetir várias vezes sem progresso, ofereça uma saída clara:
"Desculpe a confusão! 😊 Vamos com calma. Me diga em uma frase: o nome do
remédio, quantas vezes por dia e a partir de que horário você toma. Ex:
'Dipirona, 3 vezes ao dia, começando às 7h'. Que eu organizo tudo pra você!"

ETAPAS E O QUE FAZER EM CADA UMA:

cad_nome:
  Pergunta o **NOME** do medicamento. Ex: "Vamos cadastrar seu **MEDICAMENTO**! Qual o **NOME** dele?"
  proximaEtapa: "cad_dosagem".

cad_dosagem:
  Pergunta a **DOSAGEM** do ${context?.nome || '{nome}'} — geralmente vem no rótulo (ex: 50mg, 0,5%, 100mg/ml).
  Salve em dosagem. proximaEtapa: "cad_horarios".

cad_horarios / cad_quantidade_por_dose / cad_confirma_forma:
  A EXTRAÇÃO DE HORÁRIO, QUANTIDADE E UNIDADE JÁ FOI DECIDIDA EM CÓDIGO — está em
  context.acaoPosologia e nos campos já preenchidos de context (pares_posologia, horarios,
  unidade_dose, forma_explicita, forma_sugerida, blocoConfirmaForma). VOCÊ NUNCA decide
  horário, quantidade ou unidade — apenas fraseia a mensagem certa para a situação e ecoa
  os campos de novoContext exatamente como recebidos (não recalcule nada de posologia).

  Situações possíveis (context.acaoPosologia):
  - "indeterminado" (em cad_horarios): a mensagem não trouxe posologia reconhecível.
    Reformule a pergunta de **HORÁRIOS**: "Agora vamos à **FORMA DE USO**. Em quais
    **HORÁRIOS** você toma ou usa o ${context?.nome || '{nome}'}?"
  - "indeterminado" (em cad_quantidade_por_dose) COM context.mencionaConcentracao=true:
    distinga dosagem de quantidade: "Essa é a dosagem do remédio (a concentração). O que
    eu preciso saber agora é **QUANTO** você toma de cada vez — por exemplo, 1 comprimido,
    2 comprimidos, 20 gotas."
  - "indeterminado" (em cad_quantidade_por_dose) sem mencionar concentração: reformule
    "Ainda sobre a **FORMA DE USO**: **QUANTO** de ${context?.nome || '{nome}'} você toma
    ou usa em cada horário? (ex: 2 comprimidos, 1 cápsula, 20 gotas, 5ml)"
  - "frequencia_sem_inicio": pergunte "Qual o horário da primeira dose do dia?"
  - "horarios_apenas" / "horarios_corrigidos" / "quantidade_apenas_precoce": os horários
    foram salvos, agora pergunte **QUANTO** se toma em cada horário (mesmo texto do item
    "indeterminado sem concentração" acima).
  - "posologia_completa" / "quantidade_apenas" / "horarios_completados_com_quantidade_pendente"
    com proximaEtapaCalculada="cad_tipo_tratamento": tudo já foi coletado (forma incluída).
    Pule direto para a pergunta de **CONTÍNUO**/**TEMPORÁRIO** do ${context?.nome || '{nome}'}.
  - proximaEtapaCalculada="cad_confirma_forma": a forma não foi dita explicitamente. Com
    base APENAS no nome do medicamento (${context?.nome || '{nome}'}), tente adivinhar a
    forma farmacêutica mais provável entre comprimido, cápsula, colírio, gotas, pomada,
    injetável, xarope — ou null se não for possível inferir com confiança. Grave o palpite
    em novoContext.forma_sugerida. A mensagem deve ser: "${context?.nome || '{nome}'}, só
    confirmando: " + context.blocoConfirmaForma (INSIRA ESSE TRECHO EXATAMENTE COMO ESTÁ,
    é dado de saúde renderizado em código, nunca reescreva os números) + "?"
  - Ao processar a resposta À pergunta de cad_confirma_forma (etapa atual =
    cad_confirma_forma), context.acaoPosologia informa o resultado
    ("confirmado" | "forma_corrigida" | "quantidade_corrigida" | "avanca_sem_confirmacao_clara").
    Em QUALQUER caso, agradeça brevemente e já faça a pergunta de **CONTÍNUO**/**TEMPORÁRIO**
    do ${context?.nome || '{nome}'} — esta etapa nunca trava, mesmo se a resposta não fizer sentido.

  Em todos os casos acima, defina proximaEtapa EXATAMENTE como context.proximaEtapaCalculada
  informar (o código força esse valor de qualquer forma — mas mantenha coerência na mensagem).

cad_tipo_tratamento:
  Pergunta: "O ${context?.nome || '{nome}'} é de uso **CONTÍNUO** (sem previsão de parada) ou
  **TEMPORÁRIO**, com prazo definido — como um antibiótico ou anti-inflamatório?"
  Se o usuário disser temporário, pergunte quantos dias dura o tratamento (pode ser na mesma
  resposta: "10 dias" já responde os dois).
  Salve tipo_tratamento como "continuo" ou "temporario" e tratamento_dias como número (ou null).
  proximaEtapa: "cad_estoque".

cad_estoque / cad_estoque_volume:
  A QUANTIDADE DE ESTOQUE, O ALERTA E A PRÓXIMA ETAPA JÁ FORAM DECIDIDOS EM CÓDIGO — estão em
  context.acaoEstoque, context.alerta_estoque_baixo e context.resumoRenderizado. Você nunca
  calcula estoque, dias restantes ou o resumo — apenas fraseia.

  - Se a etapa atual é cad_estoque e a unidade de estoque (context.unidade_estoque) é "unidade":
    pergunta original: "Quantas unidades de ${context?.nome || '{nome}'} você tem agora?"
  - Se é "ml" e context.acaoEstoque="frascos_apenas" (resposta ainda não veio): pergunte
    "Quantos **FRASCOS** fechados de ${context?.nome || '{nome}'} você tem agora?" — a palavra
    "fechados" é OBRIGATÓRIA (frasco aberto não é tratado como cheio).
  - Se a etapa atual é cad_estoque_volume: pergunte "E qual o **VOLUME** de cada frasco, em ml?
    (está no rótulo — ex: 10ml, 100ml)"
  - Se context.acaoEstoque="estoque_resolvido": o estoque final já foi calculado. Monte a
    mensagem de aviso (se context.alerta_estoque_baixo não for null) seguida do resumo
    EXATAMENTE igual a context.resumoRenderizado (insira literalmente, é dado de saúde
    renderizado em código) e finalize perguntando "Está tudo certinho?". Se
    context.alerta_estoque_baixo for null, não comente sobre estoque — vá direto ao resumo.
    proximaEtapa: "cad_confirmacao".

cad_confirmacao:
  O resumo já foi exibido na etapa anterior. NÃO repita o resumo.
  Aguarde a resposta do usuário e processe:

  - Se o usuário CONFIRMAR → avance para cad_salvo
  - Se o usuário indicar CORREÇÃO → identifique o campo a corrigir e volte à etapa correspondente
    Exemplos:
    "o horário está errado" → volte para cad_horarios
    "a dosagem não é essa" → volte para cad_dosagem
    "é pra 5 dias, não 3" → volte para cad_tipo_tratamento
    "é 2 comprimidos, não 1" → volte para cad_quantidade_por_dose

  EXPRESSÕES QUE CONTAM COMO CONFIRMAÇÃO (avance para cad_salvo):
  "sim", "é isso", "está", "tá", "tá bom", "ok", "pode", "salva", "salvar",
  "confirmar", "confirmo", "perfeito", "certo", "correto", "isso mesmo",
  "beleza", "pode salvar", "pode cadastrar", "isso", "está certo",
  "está certinho", "tudo certo", "certinho", "pode sim", "vai", "vamos",
  "agora sim", "deu certo", "está correto"

  EXPRESSÕES QUE INDICAM CORREÇÃO (mantenha em cad_confirmacao ou volte à etapa relevante):
  "não", "errado", "muda", "altera", "quero mudar", "não está certo",
  "não é isso", "corrige", "tem erro"

cad_salvo:
  Usuário confirmou os dados. O salvamento em si é feito pelo código a partir do contexto —
  você só precisa gerar a mensagem de sucesso carinhosa (ex: "Ótimo! ${context?.nome || '{nome}'}
  foi cadastrado com sucesso 💊✅ Vou te lembrar nos horários certos!"). action: null.
  proximaEtapa: "idle".

FORMATO DE RESPOSTA — JSON válido, sem markdown, sem backticks:
{
  "message": "mensagem para o usuário",
  "proximaEtapa": "cad_nome | cad_dosagem | cad_horarios | cad_quantidade_por_dose | cad_confirma_forma | cad_tipo_tratamento | cad_estoque | cad_estoque_volume | cad_confirmacao | cad_salvo | idle",
  "novoContext": {},
  "action": null
}`;
}

// ============================================================
// CHAMADA AO CLAUDE (geração de mensagem)
// ============================================================

async function callClaude({ systemPrompt, message, context }) {
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
            userId: null, // `user` não está no escopo de callClaude() — ver briefing MH-064 T1, risco 3.
            detalhe: {
                stop_reason: response?.stop_reason ?? null,
                tamanho_raw: rawText.length,
                etapa: context?.etapa || 'cad_nome'
            },
            fallback: {
                message: 'Desculpe, tive um probleminha. Pode repetir? 🌿',
                proximaEtapa: context?.etapa || 'cad_nome',
                novoContext: context || {},
                action: null
            }
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
            message: `Quero cadastrar o ${context.nome} novamente`,
            context: { nome: context.nome }
        });

        const proximaEtapa = claudeResponse.proximaEtapa || 'cad_dosagem';
        const novoContext = { ...claudeResponse.novoContext, nome: context.nome };
        await saveConversationState(user.id, {
            state: 'adding_med',
            context: { ...novoContext, etapa: proximaEtapa }
        });
        return claudeResponse.message;
    }

    let contextParaClaude = context || {};
    let proximaEtapaForcada = null;
    let contextUpdatesForcados = null;

    // MH-073 Parte B — etapas de posologia: código decide, LLM só fraseia (seção 6 do briefing)
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

        const contextFinal = { ...contextParaClaude, ...decisao.contextUpdates };
        let blocoConfirmaForma = null;
        if (decisao.proximaEtapa === 'cad_confirma_forma') {
            const rotulo = ROTULO_GENERICO[contextFinal.unidade_dose] || 'unidade';
            blocoConfirmaForma = renderizarBlocoPosologia(contextFinal.pares_posologia, rotulo);
        }

        contextParaClaude = {
            ...contextFinal,
            acaoPosologia: decisao.acao,
            proximaEtapaCalculada: decisao.proximaEtapa,
            mencionaConcentracao,
            blocoConfirmaForma
        };
        proximaEtapaForcada = decisao.proximaEtapa;
        contextUpdatesForcados = decisao.contextUpdates;
    } else if (etapaAtual === 'cad_confirma_forma') {
        const classificacao = await classificarPosologia({
            message,
            campoEsperado: 'quantidade',
            nomeMedicamento: context?.nome,
            horariosJaColetados: (context?.pares_posologia || []).map(p => p.horario),
            historicoConversa
        });
        const decisao = decidirCadConfirmaForma(classificacao, message, context);
        contextParaClaude = { ...contextParaClaude, ...decisao.contextUpdates, acaoPosologia: decisao.acao, proximaEtapaCalculada: decisao.proximaEtapa };
        proximaEtapaForcada = decisao.proximaEtapa;
        contextUpdatesForcados = decisao.contextUpdates;
    } else if (etapaAtual === 'cad_estoque' || etapaAtual === 'cad_estoque_volume') {
        const decisao = processarEstoque(etapaAtual, message, context);
        contextParaClaude = {
            ...contextParaClaude,
            ...decisao.contextUpdates,
            acaoEstoque: decisao.acao,
            resumoRenderizado: decisao.resumoRenderizado || null
        };
        proximaEtapaForcada = decisao.proximaEtapa;
        contextUpdatesForcados = decisao.contextUpdates;
    }

    const systemPrompt = buildSystemPrompt(etapaAtual, contextParaClaude, user.name, historicoConversa);
    const claudeResponse = await callClaude({ systemPrompt, message, context: contextParaClaude });

    let proximaEtapa = proximaEtapaForcada || claudeResponse.proximaEtapa || 'cad_nome';
    // Base em `context` (não só em claudeResponse.novoContext) — rede de segurança contra o
    // LLM esquecer de ecoar um campo já coletado (a REGRA DE PERSISTÊNCIA depende dele fazer
    // isso certo). contextUpdatesForcados sempre vence por último: é derivação de código.
    let novoContext = { ...(context || {}), ...(claudeResponse.novoContext || {}), ...(contextUpdatesForcados || {}) };

    // TRABALHO 2: verificação antecipada de medicamento existente.
    // Item 9.1 do briefing MH-073 Parte B: cad_forma foi removida — a checagem de
    // duplicata acontece agora na transição cad_nome -> cad_dosagem.
    if (etapaAtual === 'cad_nome' && novoContext.nome && proximaEtapa === 'cad_dosagem') {
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

    // cad_salvo: a ação é montada em código a partir do context acumulado, nunca do
    // que o LLM disser — o LLM só produz a mensagem de sucesso (seção 8.4 do briefing:
    // "nunca recalcule, nunca invente").
    let mensagemFinal = claudeResponse.message;
    if (proximaEtapa === 'cad_salvo') {
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
        if (resultado?.messageOverride) {
            mensagemFinal = resultado.messageOverride;
        }
    }

    // Salva novo estado da conversa
    const novoState = proximaEtapa === 'idle' ? 'idle' : 'adding_med';
    await saveConversationState(user.id, {
        state: novoState,
        context: novoState === 'idle' ? {} : { ...novoContext, etapa: proximaEtapa }
    });

    return mensagemFinal;
}
