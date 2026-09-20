// ============================================================
// VALIDADOR DE POSOLOGIA (v44 M2 — endereço novo do classificador
// único de posologia do MH-073 Parte B; a LÓGICA não mudou)
//
// Horário e quantidade são o mesmo fato de posologia, expresso junto
// na fala natural ("2 comprimidos às 8h"). Um classificador só, com
// validação determinística pós-parse e resgate por regex da notação
// de receita ("12/12 hrs" — caso Nimesulida 19/09).
//
// A decisão de campo (decidirPosologia) é pura: recebe classificação
// + campos coletados e devolve SÓ atualizações de campos — o runner
// deriva a pendência seguinte (função única "o que falta", M2 §2.1).
// ============================================================

import { formatarHistoricoConversa } from '../database.js';
import { degradar } from '../observabilidade.js';
import { classificarJSON } from './llm.js';
import {
    FORMAS_VALIDAS, UNIDADES_DOSE_VALIDAS, horarioValido,
    formaCompativelComUnidade, derivarUnidades,
    calcularHorariosPorIntervalo, montarParesPosologia, expandirParesPorIntervalo
} from './derivacoes.js';

function buildPosologiaSystemPrompt({ nomeMedicamento, campoEsperado, horariosJaColetados, historicoConversa, message, emCorrecao }) {
    const campoEsperadoTexto = campoEsperado === 'horarios'
        ? 'em quais horários a pessoa toma ou usa o medicamento'
        : 'quanto a pessoa toma ou usa em cada horário';

    const horariosTexto = horariosJaColetados && horariosJaColetados.length > 0
        ? horariosJaColetados.join(', ')
        : 'nenhum';

    // BUG-91: quando a mensagem corrige um horário já confirmado, o usuário costuma
    // mencionar só o horário que MUDOU — a instrução pede a lista completa de volta.
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

export function fallbackPosologiaIndeterminada() {
    return {
        categoria: 'indeterminado', pares: [], quantidadeUnica: null,
        intervaloHoras: null, horarioInicio: null, unidadeDose: null,
        formaExplicita: null, multiplicadorAplicado: false
    };
}

// Validação determinística pós-parse. Nunca deixa passar quantidade/horário
// chutado — cada par é validado individualmente.
export function validarClassificacaoPosologia(parsed, unidadeDoseContexto = null) {
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

    // v44 (caso Nimesulida): o modelo às vezes devolve o intervalo como TEXTO
    // ("12/12", "12h") — coerção pelo primeiro número do texto.
    let intervaloHoras = Number(parsed.intervalo_horas);
    if (!Number.isFinite(intervaloHoras)) {
        const m = String(parsed.intervalo_horas ?? '').match(/\d{1,2}/);
        intervaloHoras = m ? Number(m[0]) : NaN;
    }
    intervaloHoras = Number.isFinite(intervaloHoras) && intervaloHoras > 0 && intervaloHoras <= 24 ? intervaloHoras : null;
    const horarioInicio = horarioValido(parsed.horario_inicio) ? parsed.horario_inicio : null;
    if (categoria === 'frequencia_intervalo' && intervaloHoras === null) categoria = 'indeterminado';

    const formaExplicita = FORMAS_VALIDAS.has(parsed.forma_explicita) ? parsed.forma_explicita : null;

    // BUG-99: só SINALIZA incoerência entre fala do usuário e unidade — nunca descarta.
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

export async function classificarPosologia({ message, campoEsperado, nomeMedicamento, horariosJaColetados = [], historicoConversa = [], emCorrecao = false, unidadeDoseContexto = null }) {
    const systemPrompt = buildPosologiaSystemPrompt({ nomeMedicamento, campoEsperado, horariosJaColetados, historicoConversa, message, emCorrecao });

    const { parsed, degradado } = await classificarJSON({
        systemPrompt, message, maxTokens: 400,
        schema: {
            type: 'object',
            properties: {
                categoria: { type: 'string', enum: ['posologia_completa', 'horarios_apenas', 'quantidade_apenas', 'frequencia_intervalo', 'indeterminado'] },
                pares: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { horario: { type: 'string' }, quantidade: { type: 'number' } },
                        required: ['horario', 'quantidade']
                    }
                },
                quantidade_unica: { type: ['number', 'null'] },
                intervalo_horas: { type: ['number', 'null'] },
                horario_inicio: { type: ['string', 'null'] },
                unidade_dose: { type: ['string', 'null'] },
                forma_explicita: { type: ['string', 'null'] },
                multiplicador_aplicado: { type: 'boolean' }
            },
            required: ['categoria', 'pares']
        },
        motivo: 'classificador_posologia_falhou',
        detalheExtra: { campoEsperado },
        fallback: null
    });
    if (degradado || !parsed) return fallbackPosologiaIndeterminada();

    const { resultado, paresDescartados, formaExplicitaIncompativel } = validarClassificacaoPosologia(parsed, unidadeDoseContexto);

    if (formaExplicitaIncompativel) {
        // Fire-and-forget: é só registro, não bloqueia a resposta do usuário.
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

// v44 (caso Nimesulida): resgate DETERMINÍSTICO da notação de receita
// "1cp 12/12 hrs" quando o classificador LLM falha. Devolve uma classificação
// sintética no MESMO shape validado, para reapresentar à mesma máquina de decisão.
export function interpretarIntervaloDeterministico(message) {
    const msg = String(message || '');
    const mIntervalo = msg.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:h|hrs?|horas)?\b/i)
        || msg.match(/\bde\s+(\d{1,2})\s+em\s+(\d{1,2})\s*(?:h|hrs?|horas)?\b/i);
    if (!mIntervalo) return null;
    const a = Number(mIntervalo[1]);
    const b = Number(mIntervalo[2]);
    if (a !== b || a < 1 || a > 24) return null;

    const mQtd = msg.match(/\b(\d+(?:[.,]\d+)?)\s*(cps?|comprimidos?|c[áa]psulas?|gotas?|gts|ml)\b/i);
    let quantidadeUnica = null;
    let unidadeDose = null;
    let formaExplicita = null;
    if (mQtd) {
        quantidadeUnica = Number(mQtd[1].replace(',', '.'));
        const u = mQtd[2].toLowerCase();
        if (u.startsWith('gota') || u === 'gts') { unidadeDose = 'gota'; formaExplicita = 'gotas'; }
        else if (u === 'ml') { unidadeDose = 'ml'; }
        else if (u.startsWith('cá') || u.startsWith('ca')) { unidadeDose = 'unidade'; formaExplicita = 'capsula'; }
        else { unidadeDose = 'unidade'; formaExplicita = 'comprimido'; }
    }

    return {
        categoria: 'frequencia_intervalo',
        pares: [],
        quantidadeUnica,
        intervaloHoras: a,
        horarioInicio: null,
        unidadeDose,
        formaExplicita,
        multiplicadorAplicado: false
    };
}

// ============================================================
// DECISÃO DE CAMPO — código decide, LLM só classifica.
//
// Fusão de decidirCadHorarios/decidirCadQuantidade (a "etapa" morreu:
// o modo é derivado dos campos já coletados). Devolve { acao, updates } —
// o runner deriva a pendência seguinte pela função única "o que falta".
// ============================================================

export function decidirPosologia(classificacao, campos) {
    const quantidadePendente = campos?.quantidade_pendente ?? null;
    const horariosJaColetados = campos?.horarios || [];
    const modoQuantidade = horariosJaColetados.length > 0;

    const resolverComHorarios = (horarios, extra = {}) => {
        if (quantidadePendente !== null) {
            // O usuário já respondeu a quantidade adiantado — não repergunta.
            const unidades = derivarUnidades(campos?.unidade_dose_pendente || 'unidade');
            const pares = montarParesPosologia(horarios, quantidadePendente);
            const formaExplicita = campos?.forma_explicita_pendente || null;
            return {
                acao: 'horarios_completados_com_quantidade_pendente',
                updates: {
                    horarios, pares_posologia: pares,
                    unidade_dose: unidades.unidade_dose,
                    unidade_estoque: unidades.unidade_estoque,
                    gotas_por_ml: unidades.gotas_por_ml,
                    forma_explicita: formaExplicita,
                    quantidade_pendente: null, unidade_dose_pendente: null, forma_explicita_pendente: null,
                    ...extra
                }
            };
        }
        return {
            acao: modoQuantidade ? 'horarios_corrigidos' : 'horarios_apenas',
            updates: { horarios, ...extra }
        };
    };

    // Estado "aguardando horário da primeira dose" (viemos de frequencia_sem_inicio).
    // Aceita o primeiro horário reconhecido em QUALQUER categoria que traga horário.
    if (campos?.intervalo_horas && !campos?.horario_inicio) {
        const candidato = classificacao.horarioInicio || (classificacao.pares[0] && classificacao.pares[0].horario) || null;
        if (candidato) {
            const horarios = calcularHorariosPorIntervalo(candidato, campos.intervalo_horas);
            if (horarios.length > 0) {
                return resolverComHorarios(horarios, {
                    intervalo_horas: campos.intervalo_horas,
                    horario_inicio: candidato
                });
            }
        }
        // A mensagem pode trazer, além do horário (que não veio), a quantidade
        // adiantada ("5ml") — sem isso, ela era descartada (Correção #6, v36 #2).
        return {
            acao: 'frequencia_sem_inicio',
            updates: {
                intervalo_horas: campos.intervalo_horas,
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
            return {
                acao: 'posologia_completa',
                updates: {
                    horarios: paresFinais.map(p => p.horario),
                    pares_posologia: paresFinais,
                    unidade_dose: unidades.unidade_dose,
                    unidade_estoque: unidades.unidade_estoque,
                    gotas_por_ml: unidades.gotas_por_ml,
                    forma_explicita: classificacao.formaExplicita || null,
                    ...(expandido ? { intervalo_horas: expandido.intervalo_horas, horario_inicio: expandido.horario_inicio } : {})
                }
            };
        }
        case 'horarios_apenas':
            return resolverComHorarios(classificacao.pares.map(p => p.horario));
        case 'frequencia_intervalo': {
            // Em modo quantidade (horários já coletados), frequência solta segue
            // sendo indeterminado — comportamento preservado de decidirCadQuantidade.
            if (modoQuantidade) return { acao: 'indeterminado', updates: {} };
            if (classificacao.horarioInicio) {
                const horarios = calcularHorariosPorIntervalo(classificacao.horarioInicio, classificacao.intervaloHoras);
                if (horarios.length > 0) {
                    return resolverComHorarios(horarios, {
                        intervalo_horas: classificacao.intervaloHoras,
                        horario_inicio: classificacao.horarioInicio
                    });
                }
            }
            return {
                acao: 'frequencia_sem_inicio',
                updates: { intervalo_horas: classificacao.intervaloHoras }
            };
        }
        case 'quantidade_apenas': {
            if (modoQuantidade) {
                const unidades = derivarUnidades(classificacao.unidadeDose || 'unidade');
                const pares = montarParesPosologia(horariosJaColetados, classificacao.quantidadeUnica);
                return {
                    acao: 'quantidade_apenas',
                    updates: {
                        pares_posologia: pares,
                        unidade_dose: unidades.unidade_dose,
                        unidade_estoque: unidades.unidade_estoque,
                        gotas_por_ml: unidades.gotas_por_ml,
                        forma_explicita: classificacao.formaExplicita || null
                    }
                };
            }
            return {
                acao: 'quantidade_apenas_precoce',
                updates: {
                    quantidade_pendente: classificacao.quantidadeUnica,
                    unidade_dose_pendente: classificacao.unidadeDose,
                    forma_explicita_pendente: classificacao.formaExplicita
                }
            };
        }
        default:
            return { acao: 'indeterminado', updates: {} };
    }
}
