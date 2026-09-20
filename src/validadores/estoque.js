// ============================================================
// VALIDADOR DE ESTOQUE (v44 M2 — endereço novo dos classificadores
// de estoque do MH-073 Partes B/C; a LÓGICA e a matemática de
// gotas/ml não mudaram)
//
// O validador DECIDE (acao + updates + resolução); quem ESCREVE o
// estoque é o runner, pelo ponto único registrarMovimentoEstoque
// (responsabilidade 3 do runner, M2 §2).
// ============================================================

import { formatarHistoricoConversa, converterDoseParaEstoque } from '../database.js';
import { classificarJSON } from './llm.js';

// ------------------------------------------------------------
// Extrações determinísticas
// ------------------------------------------------------------

export function extrairNumero(texto) {
    const m = String(texto).match(/\d+(?:[.,]\d+)?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
}

// Recusa notação de fração ("3/4") — sem a guarda, "3/4" seria lido como "3ml".
export function extrairValorExatoEstoque(texto) {
    if (/\d\s*\/\s*\d/.test(String(texto))) return null;
    return extrairNumero(texto);
}

// "2 frascos de 10ml" -> {frascos:2, volume:10}. "2" -> {frascos:2, volume:null}.
export function extrairFrascosEVolume(message) {
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

// Tabela de conversão fração -> número, em código, nunca no LLM.
export const FRACOES_ESTOQUE = {
    recem_aberto:   1.00,
    tres_quartos:   0.75,
    metade:         0.50,
    um_quarto:      0.25,
    quase_acabando: 0.10,
};

// ------------------------------------------------------------
// MH-86 (v44 M2) — resgates DETERMINÍSTICOS do turno composto.
// Status + frascos + volume + fração ditos numa mensagem só nunca
// são descartados (absorve MH-73 C.1/C.2 na prática — P57). A
// matemática de gotas/ml não muda; muda só o ponto de entrada.
// ------------------------------------------------------------

const FRACOES_DETERMINISTICAS = [
    ['recem_aberto', /rec[ée]m[- ]aberto|acabei de abrir|quase cheio/i],
    ['tres_quartos', /3\s*\/\s*4|tr[êe]s quartos/i],
    ['um_quarto', /1\s*\/\s*4|um quarto|um quartinho/i],
    ['metade', /\bmetade\b|meio frasco|50\s*%/i],
    ['quase_acabando', /quase acabando|quase no fim|t[áa] no fim|s[óo] um pouquinho/i]
];

export function extrairFracaoDeterministica(texto) {
    const t = String(texto || '');
    for (const [bucket, re] of FRACOES_DETERMINISTICAS) {
        if (re.test(t)) return bucket;
    }
    return null;
}

const RE_STATUS_ABERTO = /\bj[áa]\s+(uso|abri|estou usando|t[ôo] usando|comecei)|\babert[oa]\b|\bem uso\b|pela metade/i;
const RE_STATUS_FECHADO = /\blacrad|\bfechad[oa]\b|nunca abri|n[ãa]o abri|ainda n[ãa]o us|novinho/i;

export function extrairStatusDeterministico(texto) {
    const t = String(texto || '');
    const aberto = RE_STATUS_ABERTO.test(t);
    const fechado = RE_STATUS_FECHADO.test(t);
    if (aberto && !fechado) return 'aberto';
    if (fechado && !aberto) return 'fechado';
    return null;
}

// ------------------------------------------------------------
// Classificadores LLM (prompts inalterados — BUG-97, MH-073 C)
// ------------------------------------------------------------

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

export async function classificarEstoqueSolido({ message, nomeMedicamento, historicoConversa = [] }) {
    const { parsed, degradado } = await classificarJSON({
        systemPrompt: buildEstoqueSolidoSystemPrompt({ nomeMedicamento, historicoConversa, message }),
        message, maxTokens: 200,
        schema: {
            type: 'object',
            properties: {
                categoria: { type: 'string', enum: ['quantidade', 'estimativa', 'nao_sei', 'indeterminado'] },
                quantidade: { type: ['number', 'null'] }
            },
            required: ['categoria']
        },
        motivo: 'classificador_estoque_falhou',
        fallback: null
    });
    if (degradado || !parsed) return { categoria: 'indeterminado', quantidade: null };

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

export async function classificarStatusFrasco({ message, nomeMedicamento, historicoConversa = [] }) {
    const { parsed, degradado } = await classificarJSON({
        systemPrompt: buildStatusFrascoSystemPrompt({ nomeMedicamento, historicoConversa, message }),
        message, maxTokens: 50, temperature: 0,
        schema: {
            type: 'object',
            properties: { categoria: { type: 'string', enum: ['aberto', 'fechado', 'indeterminado'] } },
            required: ['categoria']
        },
        motivo: 'classificador_status_frasco_falhou',
        fallback: null
    });
    if (degradado || !parsed) return { categoria: 'indeterminado' };

    const categoriasValidas = new Set(['aberto', 'fechado', 'indeterminado']);
    const categoria = categoriasValidas.has(parsed.categoria) ? parsed.categoria : 'indeterminado';
    console.log(`🔎 [CAD-CLASSIF] classificarStatusFrasco -> ${categoria}`);
    return { categoria };
}

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

export async function classificarFracaoEstoque({ message, nomeMedicamento, historicoConversa = [] }) {
    const { parsed, degradado } = await classificarJSON({
        systemPrompt: buildFracaoEstoqueSystemPrompt({ nomeMedicamento, historicoConversa, message }),
        message, maxTokens: 50, temperature: 0,
        schema: {
            type: 'object',
            properties: {
                categoria: { type: 'string', enum: ['recem_aberto', 'tres_quartos', 'metade', 'um_quarto', 'quase_acabando', 'nao_sei', 'indeterminado'] }
            },
            required: ['categoria']
        },
        motivo: 'classificador_fracao_estoque_falhou',
        fallback: null
    });
    if (degradado || !parsed) return { categoria: 'indeterminado' };

    const categoriasValidas = new Set([...Object.keys(FRACOES_ESTOQUE), 'nao_sei', 'indeterminado']);
    const categoria = categoriasValidas.has(parsed.categoria) ? parsed.categoria : 'indeterminado';
    console.log(`🔎 [CAD-CLASSIF] classificarFracaoEstoque -> ${categoria}`);
    return { categoria };
}

// ------------------------------------------------------------
// Sub-pendência do campo estoque — mesma ramificação que vivia em
// primeiraEtapaFaltante (ml: status primeiro, volume sempre por último).
// ------------------------------------------------------------

export function subEtapaEstoque(campos) {
    if (campos?.unidade_estoque !== 'ml') return 'cad_estoque';

    if (!campos?.status_frasco) return 'cad_estoque';
    if (campos?.status_frasco === 'fechado') {
        return (campos?.frascos && !campos?.volume_frasco) ? 'cad_estoque_volume' : 'cad_estoque';
    }
    const fracaoOuValorConhecido = !!campos?.estoque_fracao_pendente
        || (campos?.estoque_valor_exato_pendente !== undefined && campos?.estoque_valor_exato_pendente !== null);
    return (fracaoOuValorConhecido && !campos?.volume_frasco) ? 'cad_estoque_volume' : 'cad_estoque_fracao';
}

// ------------------------------------------------------------
// Decisão do campo estoque — mesma máquina de processarEstoque
// (MH-073 Parte C), sem nenhuma escrita: `resolvido` sobe ao runner.
//   resolvido: { valor, motivo, extra }  — valor null = "não sei" (P49)
// ------------------------------------------------------------

export async function validarEstoque({ message, campos, historicoConversa = [] }) {
    const etapaAtual = subEtapaEstoque(campos);
    const unidadeEstoque = campos?.unidade_estoque || 'unidade';

    const resolver = (estoque, extra = {}) => {
        const estimado = (!!extra.estoque_motivo && extra.estoque_motivo !== 'frascos_fechados')
            || extra.estoque_motivo === 'estimativa_informada';
        return {
            acao: 'estoque_resolvido',
            updates: {
                estoque_perguntado: true,
                estoque_resolvido: estoque,
                ...extra,
                estoque_estimado: estimado
            },
            resolvido: { valor: estoque, motivo: extra.estoque_motivo || null, estimado }
        };
    };

    // "não sei": estoque_atual permanece NULL — nunca 0 (P49). A etapa é dada por
    // RESOLVIDA sem nenhuma escrita.
    const resolverDesconhecido = () => ({
        acao: 'estoque_nao_informado',
        updates: {
            estoque_perguntado: true,
            estoque_resolvido: null,
            estoque_motivo: null,
            estoque_estimado: false,
            alerta_estoque_baixo: null
        },
        resolvido: { valor: null, motivo: null, estimado: false }
    });

    if (etapaAtual === 'cad_estoque') {
        if (unidadeEstoque === 'ml') {
            if (campos?.status_frasco === 'fechado') {
                const { frascos, volume } = extrairFrascosEVolume(message);
                if (frascos !== null && volume !== null) {
                    return resolver(frascos * volume, { frascos, volume_frasco: volume, estoque_motivo: 'frascos_fechados' });
                }
                // Sem frascos reconhecido, NÃO avança — reformula (Correção #4, v36 #2).
                if (frascos === null) {
                    return { acao: 'frascos_indeterminado', updates: {} };
                }
                return { acao: 'frascos_apenas', updates: { frascos } };
            }

            // MH-86 (M2 §6): PONTO DE ENTRADA ÚNICO do estoque líquido — status +
            // nº de frascos + volume + fração ditos num turno só são todos
            // aproveitados (absorve MH-73 C.1/C.2; P57). Determinístico primeiro;
            // o classificador LLM de status só roda quando a fala não o resolve.
            const fracaoDet = extrairFracaoDeterministica(message);
            const statusDet = extrairStatusDeterministico(message);
            const { frascos, volume } = extrairFrascosEVolume(message);
            // Volume DECLARADO como tamanho do frasco ("frasco de 60ml", "é de
            // 60ml") — nunca confundido com a sobra ("sobram 30ml").
            const mVolumeFrasco = String(message).match(/(?:frasco|vidro)\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*ml|\bde\s+(\d+(?:[.,]\d+)?)\s*ml/i);
            const volumeDeclarado = mVolumeFrasco ? parseFloat((mVolumeFrasco[1] || mVolumeFrasco[2]).replace(',', '.')) : null;

            const status = statusDet
                ?? (fracaoDet ? 'aberto' : null)
                ?? (await classificarStatusFrasco({ message, nomeMedicamento: campos?.nome, historicoConversa })).categoria;

            if (status === 'fechado') {
                if (frascos !== null && volume !== null) {
                    return resolver(frascos * volume, { status_frasco: 'fechado', frascos, volume_frasco: volume, estoque_motivo: 'frascos_fechados' });
                }
                if (frascos !== null) {
                    return { acao: 'status_frasco_fechado_com_frascos', updates: { status_frasco: 'fechado', frascos } };
                }
                return { acao: 'status_frasco_fechado', updates: { status_frasco: 'fechado' } };
            }
            if (status === 'aberto') {
                const volumeConhecido = volumeDeclarado ?? (Number(campos?.volume_frasco) || null);

                // Fração + volume no mesmo turno → resolve na hora.
                if (fracaoDet) {
                    if (volumeConhecido !== null) {
                        return resolver(volumeConhecido * FRACOES_ESTOQUE[fracaoDet], {
                            status_frasco: 'aberto', volume_frasco: volumeConhecido, estoque_motivo: `aberto_fracao:${fracaoDet}`
                        });
                    }
                    return { acao: 'status_frasco_aberto_com_fracao', updates: { status_frasco: 'aberto', estoque_fracao_pendente: fracaoDet } };
                }

                const valorExato = extrairValorExatoEstoque(message);
                const valorEhVolumeDoFrasco = valorExato !== null && volumeDeclarado !== null && valorExato === volumeDeclarado;
                if (valorExato !== null && !valorEhVolumeDoFrasco) {
                    if (volumeConhecido !== null) {
                        return resolver(valorExato, { status_frasco: 'aberto', volume_frasco: volumeConhecido, estoque_motivo: 'aberto_valor_exato' });
                    }
                    return { acao: 'status_frasco_aberto_com_valor', updates: { status_frasco: 'aberto', estoque_valor_exato_pendente: valorExato } };
                }
                if (volumeDeclarado !== null) {
                    return { acao: 'status_frasco_aberto_com_volume', updates: { status_frasco: 'aberto', volume_frasco: volumeDeclarado } };
                }
                return { acao: 'status_frasco_aberto', updates: { status_frasco: 'aberto' } };
            }
            return { acao: 'status_frasco_indeterminado', updates: {} };
        }

        const classificacao = await classificarEstoqueSolido({ message, nomeMedicamento: campos?.nome, historicoConversa });
        if (classificacao.categoria === 'quantidade') {
            return resolver(classificacao.quantidade, { estoque_motivo: null });
        }
        if (classificacao.categoria === 'estimativa') {
            // "acho que uns 20" — aceita sem questionar, só marcado como estimativa.
            return resolver(classificacao.quantidade, { estoque_motivo: 'estimativa_informada' });
        }
        if (classificacao.categoria === 'nao_sei') {
            // NUNCA insiste — aceita "não sei" de primeira e segue.
            return resolverDesconhecido();
        }
        // Falha de extração devolve indeterminado, NUNCA 0.
        return { acao: 'estoque_indeterminado', updates: {} };
    }

    if (etapaAtual === 'cad_estoque_fracao') {
        // Camada 1, determinística: um número solto ("tem uns 40ml") é usado DIRETO
        // como valor exato, sem passar pelo classificador (Princípio 1).
        const valorExato = extrairValorExatoEstoque(message);
        if (valorExato !== null) {
            const volume = Number(campos?.volume_frasco) || null;
            if (volume !== null) {
                return resolver(valorExato, { estoque_motivo: 'aberto_valor_exato' });
            }
            return { acao: 'valor_exato_pendente', updates: { estoque_valor_exato_pendente: valorExato } };
        }

        // MH-86: fração dita em palavras conhecidas resolve sem LLM (mesma
        // tabela); o classificador continua cobrindo o resto.
        const fracaoDet = extrairFracaoDeterministica(message);
        const classificacao = fracaoDet
            ? { categoria: fracaoDet }
            : await classificarFracaoEstoque({ message, nomeMedicamento: campos?.nome, historicoConversa });
        const volume = Number(campos?.volume_frasco) || null;

        if (classificacao.categoria === 'nao_sei') {
            // Aceita imediatamente — o percentual do piso é detalhe interno.
            if (volume !== null) {
                return resolver(volume * 0.10, { estoque_motivo: 'aberto_fracao_nao_informada' });
            }
            return { acao: 'fracao_nao_informada_pendente', updates: { estoque_fracao_pendente: 'nao_informada' } };
        }

        if (FRACOES_ESTOQUE[classificacao.categoria] !== undefined) {
            const bucket = classificacao.categoria;
            if (volume !== null) {
                return resolver(volume * FRACOES_ESTOQUE[bucket], { estoque_motivo: `aberto_fracao:${bucket}` });
            }
            return { acao: 'fracao_pendente', updates: { estoque_fracao_pendente: bucket } };
        }

        return { acao: 'fracao_indeterminada', updates: {} };
    }

    // cad_estoque_volume — sempre por último.
    const volume = extrairNumero(message);
    if (volume === null) {
        return { acao: 'volume_indeterminado', updates: {} };
    }

    if (campos?.estoque_valor_exato_pendente !== undefined && campos?.estoque_valor_exato_pendente !== null) {
        return resolver(campos.estoque_valor_exato_pendente, {
            volume_frasco: volume, estoque_motivo: 'aberto_valor_exato', estoque_valor_exato_pendente: null
        });
    }
    if (campos?.estoque_fracao_pendente === 'nao_informada') {
        return resolver(volume * 0.10, {
            volume_frasco: volume, estoque_motivo: 'aberto_fracao_nao_informada', estoque_fracao_pendente: null
        });
    }
    if (campos?.estoque_fracao_pendente) {
        const bucket = campos.estoque_fracao_pendente;
        return resolver(volume * FRACOES_ESTOQUE[bucket], {
            volume_frasco: volume, estoque_motivo: `aberto_fracao:${bucket}`, estoque_fracao_pendente: null
        });
    }

    const frascos = Number(campos?.frascos) || 1;
    return resolver(frascos * volume, { volume_frasco: volume, estoque_motivo: 'frascos_fechados' });
}

// ------------------------------------------------------------
// Alerta de estoque baixo no fechamento do cadastro — mesma conta
// que vivia em cadastro.js (ponto único entre primeira resolução e
// gravação com estoque já conhecido).
// ------------------------------------------------------------

export function calcularAlertaEstoqueCadastro(campos, estoqueFinal) {
    const pares = campos?.pares_posologia || [];
    // MH-77: consumo POR SEMANA ÷ 7 — um horário de seg-sex consome 5/7 do que
    // um diário consumiria; "dia sim, dia não" consome metade.
    const diasPorSemanaDoPar = (p) => {
        if (Number(campos?.intervalo_dias_recorrencia) >= 2) return 7 / Number(campos.intervalo_dias_recorrencia);
        const dias = campos?.dias_por_horario?.[p.horario] ?? campos?.dias_semana_pendente ?? p?.dias_semana;
        return (Array.isArray(dias) && dias.length > 0) ? dias.length : 7;
    };
    const somaDoses = pares.reduce((acc, p) => acc + Number(p.quantidade || 0) * diasPorSemanaDoPar(p) / 7, 0);
    const consumoDiario = converterDoseParaEstoque({
        quantidade: somaDoses,
        unidade_dose: campos?.unidade_dose,
        unidade_estoque: campos?.unidade_estoque,
        gotas_por_ml: campos?.gotas_por_ml
    });
    const diasRestantes = consumoDiario > 0 ? Math.floor(estoqueFinal / consumoDiario) : 0;
    const tratamentoDias = campos?.tratamento_dias || null;
    const deveAlertar = tratamentoDias !== null
        ? diasRestantes < tratamentoDias
        : diasRestantes <= 5;

    return deveAlertar ? {
        dias_restantes: diasRestantes,
        estoque: estoqueFinal,
        doses_por_dia: pares.length || (campos?.horarios || []).length || 1,
        tipo_tratamento: tratamentoDias ? 'temporario' : 'continuo',
        tratamento_dias: tratamentoDias
    } : null;
}
