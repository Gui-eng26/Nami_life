// ============================================================
// EXTRATOR COMPLETO (v44 M2 — endereço novo do MH-80; a LÓGICA
// de extração não mudou)
//
// REGRA IMUTÁVEL (M2 §1): o extrator só preenche campo VAZIO —
// NUNCA sobrescreve o que um validador especializado já decidiu.
// Quem aplica essa regra é o runner (aplicarExtracaoEmVazios).
// ============================================================

import { formatarHistoricoConversa } from '../database.js';
import { classificarJSON } from './llm.js';
import {
    FORMAS_VALIDAS, UNIDADES_DOSE_VALIDAS, horarioValido, derivarUnidades,
    calcularHorariosPorIntervalo
} from './derivacoes.js';
import { FRACOES_ESTOQUE } from './estoque.js';

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

// Uma mensagem "rica" (dígito ou mais de 6 palavras) justifica a chamada cara do
// extrator completo — gate idêntico ao do MH-80.
export function mensagemRica(message) {
    return /\d/.test(message) || String(message).trim().split(/\s+/).filter(Boolean).length > 6;
}

// MH-80 é aceleração, nunca caminho obrigatório: se a extração falhar, o fallback
// devolve nome: null e o chamador segue pelo classificador simples de sempre.
export async function extrairCadastroCompleto({ message, historicoConversa = [] }) {
    const { parsed, degradado } = await classificarJSON({
        systemPrompt: buildCadastroCompletoSystemPrompt({ historicoConversa, message }),
        message, maxTokens: 500,
        motivo: 'extracao_cadastro_completo_falhou',
        fallback: null
    });
    if (degradado || !parsed) return fallbackCadastroCompleto();

    const paresBrutos = Array.isArray(parsed.pares) ? parsed.pares : [];
    const pares = paresBrutos
        .filter(p => horarioValido(p?.horario) && Number.isFinite(Number(p?.quantidade)) && Number(p.quantidade) > 0)
        .map(p => ({ horario: p.horario, quantidade: Number(p.quantidade) }));

    const unidadeDose = UNIDADES_DOSE_VALIDAS.has(parsed.unidadeDose) ? parsed.unidadeDose : null;
    const formaExplicita = FORMAS_VALIDAS.has(parsed.formaExplicita) ? parsed.formaExplicita : null;

    // Zero é estoque LEGÍTIMO — o campo só é aceito quando realmente veio
    // preenchido no JSON, nunca por conversão de ausência (BUG-97).
    let estoqueQuantidade = null;
    if (typeof parsed.estoqueQuantidade === 'number' || typeof parsed.estoqueQuantidade === 'string') {
        const n = Number(parsed.estoqueQuantidade);
        estoqueQuantidade = Number.isFinite(n) && n >= 0 ? n : null;
    }

    let frascos = Number(parsed.frascos);
    frascos = Number.isFinite(frascos) && frascos > 0 ? frascos : null;
    let volumeFrasco = Number(parsed.volumeFrasco);
    volumeFrasco = Number.isFinite(volumeFrasco) && volumeFrasco > 0 ? volumeFrasco : null;

    const statusFrasco = ['aberto', 'fechado'].includes(parsed.statusFrasco) ? parsed.statusFrasco : null;
    const fracoesValidas = new Set([...Object.keys(FRACOES_ESTOQUE), 'nao_sei']);
    const fracaoEstoque = fracoesValidas.has(parsed.fracaoEstoque) ? parsed.fracaoEstoque : null;

    const tipoTratamento = ['continuo', 'temporario'].includes(parsed.tipoTratamento) ? parsed.tipoTratamento : null;
    let tratamentoDias = Number(parsed.tratamentoDias);
    tratamentoDias = Number.isFinite(tratamentoDias) && tratamentoDias > 0 ? tratamentoDias : null;

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
// MAPEAMENTO EXTRAÇÃO → CAMPOS DO SCHEMA (ex-montarSaltoCadastroCompleto,
// sem decidir etapa: o runner deriva a pendência pela função única).
// ============================================================

export function mapearExtracaoParaCampos(completo) {
    const campos = { nome: completo.nome };
    if (completo.dosagem) campos.dosagem = completo.dosagem;

    // A unidade de dose é conhecida sempre que a pessoa disser QUANTO ("5ml"),
    // mesmo sem horário — amarrar a `pares` descartava estoque líquido já extraído.
    const temInfoDose = completo.pares.length > 0 || completo.quantidadeUnica !== null
        || completo.unidadeDose !== null;
    const unidades = temInfoDose ? derivarUnidades(completo.unidadeDose || 'unidade') : null;

    if (unidades) {
        campos.unidade_dose = unidades.unidade_dose;
        campos.unidade_estoque = unidades.unidade_estoque;
        campos.gotas_por_ml = unidades.gotas_por_ml;
        campos.forma_explicita = completo.formaExplicita || null;
    }

    // Reaproveita a grade determinística do BUG-041 — nunca recalcular aqui.
    let pares = completo.pares;
    if (pares.length === 0 && completo.intervaloHoras && completo.horarioInicio) {
        const horarios = calcularHorariosPorIntervalo(completo.horarioInicio, completo.intervaloHoras);
        if (completo.quantidadeUnica !== null) {
            pares = horarios.map(h => ({ horario: h, quantidade: completo.quantidadeUnica }));
        } else {
            campos.horarios = horarios;
        }
    }
    // v44 (arnês A2, P57): horário solto SEM intervalo ("Lamotrigina, 8h") é O
    // horário do remédio — com quantidade conhecida vira par completo; sem, vira
    // horário coletado aguardando o QUANTO.
    if (pares.length === 0 && !completo.intervaloHoras && completo.horarioInicio
        && horarioValido(completo.horarioInicio)) {
        if (completo.quantidadeUnica !== null) {
            pares = [{ horario: completo.horarioInicio, quantidade: completo.quantidadeUnica }];
        } else {
            campos.horarios = [completo.horarioInicio];
        }
    }
    if (pares.length > 0) {
        campos.horarios = pares.map(p => p.horario);
        campos.pares_posologia = pares;
    }

    // Sem horário de início, a grade não pode ser montada — mas o intervalo e a
    // quantidade já ditos precisam sobreviver.
    if (completo.intervaloHoras && !completo.horarioInicio) {
        campos.intervalo_horas = completo.intervaloHoras;
    }
    if (pares.length === 0 && completo.quantidadeUnica !== null) {
        // Mesmo trio de campos do caso 'quantidade_apenas' do validador de posologia.
        campos.quantidade_pendente = completo.quantidadeUnica;
        campos.unidade_dose_pendente = completo.unidadeDose;
        campos.forma_explicita_pendente = completo.formaExplicita;
    }

    if (completo.tipoTratamento === 'continuo') {
        campos.tipo_tratamento = 'continuo';
        campos.tratamento_dias = null;
    } else if (completo.tipoTratamento === 'temporario' && completo.tratamentoDias) {
        campos.tipo_tratamento = 'temporario';
        campos.tratamento_dias = completo.tratamentoDias;
    }

    if (completo.tipoTratamento === 'temporario' && !completo.tratamentoDias) {
        campos.tipo_tratamento_pendente = true;
    }

    // Estoque já dito na mesma mensagem (MH-073 Parte C, seção 8).
    let estoqueResolvido = null;
    let estoqueMotivo = null;

    if (completo.statusFrasco === 'aberto') {
        campos.status_frasco = 'aberto';
        if (completo.volumeFrasco) campos.volume_frasco = completo.volumeFrasco;

        if (completo.estoqueQuantidade !== null) {
            estoqueMotivo = 'aberto_valor_exato';
            estoqueResolvido = completo.estoqueQuantidade;
        } else if (completo.fracaoEstoque === 'nao_sei') {
            if (completo.volumeFrasco) {
                estoqueMotivo = 'aberto_fracao_nao_informada';
                estoqueResolvido = completo.volumeFrasco * 0.10;
            } else {
                campos.estoque_fracao_pendente = 'nao_informada';
            }
        } else if (completo.fracaoEstoque && FRACOES_ESTOQUE[completo.fracaoEstoque] !== undefined) {
            if (completo.volumeFrasco) {
                estoqueMotivo = `aberto_fracao:${completo.fracaoEstoque}`;
                estoqueResolvido = completo.volumeFrasco * FRACOES_ESTOQUE[completo.fracaoEstoque];
            } else {
                campos.estoque_fracao_pendente = completo.fracaoEstoque;
            }
        }
    } else {
        if (completo.statusFrasco === 'fechado') campos.status_frasco = 'fechado';
        if (completo.frascos && completo.volumeFrasco) {
            estoqueResolvido = completo.frascos * completo.volumeFrasco;
            estoqueMotivo = 'frascos_fechados';
            campos.frascos = completo.frascos;
            campos.volume_frasco = completo.volumeFrasco;
        } else if (completo.frascos) {
            campos.frascos = completo.frascos;
        } else if (completo.estoqueQuantidade !== null) {
            estoqueResolvido = completo.estoqueQuantidade;
        }
    }

    // `!== null` (nunca truthy): zero é estoque legítimo (BUG-97).
    if (estoqueResolvido !== null) {
        campos.estoque_resolvido = estoqueResolvido;
        campos.estoque_motivo = estoqueMotivo;
        campos.estoque_estimado = !!estoqueMotivo && estoqueMotivo !== 'frascos_fechados';
    }

    return campos;
}

// REGRA IMUTÁVEL do extrator (M2 §1): só preenche campo VAZIO no contexto —
// nunca sobrescreve o que o validador especializado já coletou/decidiu.
// `permitidos` restringe a fatia resgatável (ex.: só campos de estoque).
export function aplicarExtracaoEmVazios(camposAtuais, camposExtraidos, permitidos = null) {
    const aplicados = {};
    for (const [campo, valor] of Object.entries(camposExtraidos)) {
        if (valor === undefined) continue;
        if (permitidos && !permitidos.includes(campo)) continue;
        const atual = camposAtuais?.[campo];
        const jaPreenchido = Array.isArray(atual) ? atual.length > 0 : (atual !== null && atual !== undefined);
        if (jaPreenchido) continue;
        aplicados[campo] = valor;
    }
    return aplicados;
}
