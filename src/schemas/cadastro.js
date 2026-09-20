// ============================================================
// SCHEMA DO CADASTRO DE TRATAMENTO (v44 M2 — briefing §1)
//
// Um tratamento é declarado como estrutura de CAMPOS; nada de
// prompt por etapa. Cada campo declara nível (have_to_have |
// importante | opcional), se o extrator completo pode preenchê-lo
// (extraivel — regra imutável: extrator só preenche vazio), o
// validador especializado e a PERGUNTA renderizada em código
// (absorve MH-85/P54; texto segue a Constituição e as emendas do
// guia, incluída a regra 6: nunca repetir o que a pessoa acabou
// de dizer; fechamento curto).
//
// GREP-GUARD (M2 §8.2): nenhuma string de pergunta de coleta do
// cadastro vive fora deste arquivo.
//
// Sujeito por tratamento (decisão care_network): default "o próprio
// usuário" — só modelagem, nenhuma pergunta nova (M2 §1).
// ============================================================

import {
    derivarFormaFarmaceutica, rotuloDaDose, pluralizarRotulo, derivarUnidades
} from '../validadores/derivacoes.js';
import { rotuloDias } from '../validadores/recorrencia.js';
import { subEtapaEstoque, validarEstoque } from '../validadores/estoque.js';
import { extrairCampoSimples, ehDosagemPura } from '../validadores/camposSimples.js';
import {
    classificarPosologia, decidirPosologia, interpretarIntervaloDeterministico
} from '../validadores/posologia.js';
import {
    extrairCadastroCompleto, mapearExtracaoParaCampos, aplicarExtracaoEmVazios, mensagemRica
} from '../validadores/extratorCompleto.js';

// Ações que significam "a camada 1 não reconheceu a mensagem" — ponto único (P30).
export const ACOES_DE_FALHA = new Set([
    'indeterminado', 'estoque_indeterminado', 'volume_indeterminado',
    'status_frasco_indeterminado', 'fracao_indeterminada', 'frascos_indeterminado'
]);

// ------------------------------------------------------------
// VALIDADORES DE CAMPO — contrato: ({ message, campos,
// historicoConversa }) → { acao, updates, resolvido?, extras? }.
// Falha = acao ∈ ACOES_DE_FALHA. O runner decide o que vem depois.
// ------------------------------------------------------------

async function validarCampoNome({ message, campos, historicoConversa }) {
    // MH-80: extração completa quando a mensagem tem indício de conteúdo além do
    // nome (dígito ou >6 palavras) — evita chamada extra em "Claritin".
    if (mensagemRica(message)) {
        const completo = await extrairCadastroCompleto({ message, historicoConversa });
        if (completo.nome) {
            // P57 (caso A2): o mapeamento respeita o que o contexto JÁ traz (ex.:
            // horários semeados pela entrada multi-med) — só preenche vazio.
            const mapeados = mapearExtracaoParaCampos(completo);
            return { acao: 'nome_com_extracao', updates: aplicarExtracaoEmVazios(campos, mapeados) };
        }
    }

    const c = await extrairCampoSimples({ campo: 'nome', message, historicoConversa });
    if (c.categoria === 'valor') {
        // ACH-4 / regra 7 (caso "1000mg" no staging): dosagem pura NUNCA é aceita
        // como nome — gravação errada em silêncio é a pior saída; repergunta.
        if (ehDosagemPura(c.valor)) {
            console.warn(`💊 [CADASTRO] Valor com cara de dosagem recusado como nome: "${c.valor}"`);
            return { acao: 'indeterminado', updates: {}, nomeRecusadoPorDosagem: true };
        }
        return { acao: 'nome_coletado', updates: { nome: c.valor } };
    }
    return { acao: 'indeterminado', updates: {} };
}

async function validarCampoPosologia({ message, campos, historicoConversa }) {
    const campoEsperado = (campos?.horarios || []).length > 0 ? 'quantidade' : 'horarios';
    const classificacao = await classificarPosologia({
        message,
        campoEsperado,
        nomeMedicamento: campos?.nome,
        horariosJaColetados: campos?.horarios || [],
        historicoConversa,
        unidadeDoseContexto: campos?.unidade_dose
    });

    let decisao = decidirPosologia(classificacao, campos);

    // v44 (caso Nimesulida): "1cp 12/12 hrs" escapava do classificador. Antes de
    // tratar como falha, a notação de intervalo é lida por regex e reapresentada
    // à MESMA máquina de decisão.
    if (ACOES_DE_FALHA.has(decisao.acao)) {
        const sintetica = interpretarIntervaloDeterministico(message);
        if (sintetica) {
            console.log(`⏱️ [CADASTRO] Intervalo resgatado por regex: ${sintetica.intervaloHoras}/${sintetica.intervaloHoras}h (quantidade: ${sintetica.quantidadeUnica ?? 'não dita'})`);
            decisao = decidirPosologia(sintetica, campos);
        }
    }

    const mencionaConcentracao = campoEsperado === 'quantidade' && decisao.acao === 'indeterminado'
        && /\d+(?:[.,]\d+)?\s*(mg|mcg|g|%|mg\/ml)\b/i.test(message);

    corrigirDoseEmGramas(message, decisao, campos);

    return { ...decisao, mencionaConcentracao };
}

// Achado do replay 19/09 (Priscila, "5gr às 10h"): dose em GRAMAS não é
// representável — nem "5ml" nem "5 unidades". Convenção da micro-entrega
// (MH-93): 1 unidade por horário, com o tamanho da dose preservado como
// dosagem ("5g"). Coerção determinística, nunca do LLM.
export function corrigirDoseEmGramas(message, decisao, campos) {
    const pares = decisao.updates?.pares_posologia;
    if (!pares?.length) return;
    if (/\b(mg|mcg|kg)\b/i.test(message)) return;

    const mGramas = String(message).match(/\b(\d+(?:[.,]\d+)?)\s*(?:g|gr|gramas?)\b/i);
    if (!mGramas) return;

    const valorG = Number(mGramas[1].replace(',', '.'));
    const doseVeioDosGramas = decisao.updates.unidade_dose === 'ml'
        || pares.every(p => Number(p.quantidade) === valorG);
    if (!doseVeioDosGramas) return;

    console.log(`⚖️ [CADASTRO] Dose em gramas ("${mGramas[0]}") — convenção MH-93: 1 unidade por horário, dosagem "${mGramas[1]}g"`);
    decisao.updates.pares_posologia = pares.map(p => ({ ...p, quantidade: 1 }));
    Object.assign(decisao.updates, derivarUnidades('unidade'));
    decisao.updates.forma_explicita = null;
    if (!campos?.dosagem && !decisao.updates.dosagem) {
        decisao.updates.dosagem = `${mGramas[1]}g`;
    }
}

async function validarCampoEstoque({ message, campos, historicoConversa }) {
    return validarEstoque({ message, campos, historicoConversa });
}

// ------------------------------------------------------------
// DECLARAÇÃO DOS CAMPOS (ordem canônica, P50)
//
// Níveis (decisões v43/v44 mantidas): have-to-have = nome +
// posologia composta (quantidade+horários). Gravação no instante
// have-to-have completo (P56); estoque = convite leve pós-gravação;
// dosagem/forma/tipo de tratamento nunca são perguntados por
// iniciativa da Nami (extraíveis/inferidos).
// ------------------------------------------------------------

export const SCHEMA_CADASTRO = {
    nome: 'cadastro',
    estadoConversa: 'adding_med',
    sujeito: { padrao: 'usuario' },

    campos: [
        {
            nome: 'nome',
            nivel: 'have_to_have',
            extraivel: true,
            faltando: c => !c?.nome,
            etapa: () => 'cad_nome',
            validador: validarCampoNome
        },
        {
            nome: 'posologia',
            nivel: 'have_to_have',
            extraivel: true,
            faltando: c => !(c?.pares_posologia?.length),
            etapa: c => (c?.horarios || []).length > 0 ? 'cad_quantidade_por_dose' : 'cad_horarios',
            validador: validarCampoPosologia
        },
        {
            nome: 'estoque',
            nivel: 'importante',
            posGravacao: true,
            extraivel: true,
            faltando: c => !c?.estoque_perguntado,
            etapa: subEtapaEstoque,
            validador: validarCampoEstoque
        },
        // Opcionais: nunca perguntados por iniciativa da Nami. dosagem e
        // tipo/duração chegam pelo extrator completo (P57); forma é INFERIDA da
        // unidade/fala — pergunta só na ambiguidade real (que hoje não existe:
        // a etapa de confirmação de forma morreu por construção — BUG-102).
        { nome: 'dosagem', nivel: 'opcional', extraivel: true, perguntavel: false },
        { nome: 'forma', nivel: 'opcional', inferida: true, perguntavel: false },
        { nome: 'tipo_tratamento', nivel: 'opcional', extraivel: true, perguntavel: false }
    ]
};

// ------------------------------------------------------------
// PERGUNTAS DE COLETA — renderizadas em código (MH-85/P54).
// ------------------------------------------------------------

// Apresentações que o schema não representa (MH-93 fica no M2 como convenção da
// micro-entrega): reconhecidas com honestidade, dose cai em "unidade" (caso A17).
// \b do JS é ASCII e falha em "pó" — fronteiras unicode explícitas.
const RE_APRESENTACAO_NAO_REPRESENTADA = /(?:^|[^\p{L}])(p[óo]|sach[êe]s?|spray|creme|gel|adesivos?)(?:$|[^\p{L}])/iu;

// Reconhecimento honesto de apresentação não representada (regra 3 — caso A17
// "Pó"; MH-93 fica na convenção da micro-entrega: cada sachê/dose = 1 unidade).
function aberturaApresentacao(nome, mensagemUsuario) {
    const m = String(mensagemUsuario || '').match(RE_APRESENTACAO_NAO_REPRESENTADA);
    if (!m) return null;
    const apresentacao = m[1].toLowerCase();
    const emAplicacao = /spray|creme|gel|adesivo/.test(apresentacao);
    const convencao = emAplicacao ? 'cada aplicação' : 'cada dose (o sachê ou a medida)';
    return `Vi que o ${nome} é em ${apresentacao} — pode deixar: ${convencao} eu registro como uma unidade. 😊`;
}

function primeiroNome(userName) {
    return userName ? userName.split(' ')[0] : null;
}

export function renderizarPerguntaNome({ userName, motivoFalha = null, nomeRecusadoPorDosagem = false }) {
    const first = primeiroNome(userName);
    if (nomeRecusadoPorDosagem) {
        return `Esse valor parece a concentração do remédio — o que eu preciso primeiro é o nome dele. 😊\n\n`
            + `Qual o *nome* do medicamento?`;
    }
    if (motivoFalha) {
        return `Desculpa, não consegui identificar 😊\n\nQual o *nome* do medicamento?`;
    }
    return `Vamos cadastrar seu medicamento${first ? `, ${first}` : ''}! 💊\n\nQual o *nome* dele?`;
}

export function renderizarPerguntaPosologia({ campos, userName, acao = null, motivoFalha = null, mencionaConcentracao = false, nomeRecemColetado = false, aberturaFila = false, mensagemUsuario = '' }) {
    const first = primeiroNome(userName);
    const nome = campos?.nome || 'o medicamento';
    const horarios = (campos?.horarios || []).map(h => String(h).slice(0, 5));

    // Aguardando só o horário da primeira dose (intervalo já declarado).
    if (acao === 'frequencia_sem_inicio' || (campos?.intervalo_horas && !campos?.horario_inicio)) {
        const n = campos?.intervalo_horas;
        return `Anotei: ${nome} de ${n} em ${n} horas. 🌿\n\nQual o horário da *primeira dose* do dia?`;
    }

    // Falta só a quantidade (horários já coletados).
    if (horarios.length > 0) {
        if (mencionaConcentracao) {
            return `Essa é a dosagem do remédio (a concentração) — o que eu preciso agora é quanto você toma de cada vez. 😊\n\n`
                + `Quanto de ${nome} você toma ou usa em cada horário?\n`
                + `Por exemplo: 1 comprimido, ou 20 gotas`;
        }
        const listaHorarios = horarios.join(' e às ');
        if (motivoFalha) {
            const abertura = aberturaApresentacao(nome, mensagemUsuario)
                || `Desculpa, não peguei direito 😊 Os horários já estão anotados — falta só o quanto.`;
            return `${abertura}\n\nQuanto de ${nome} você toma ou usa às ${listaHorarios}?\n`
                + `Por exemplo: 1 unidade, ou 2 comprimidos`;
        }
        if (aberturaFila) {
            // Copy compacta da fila (replay 19/09): destaque em negrito e a
            // pergunta na mesma linha da abertura — sem repetir a lista.
            const nomeComDosagemFila = campos?.dosagem ? `${nome} ${campos.dosagem}` : nome;
            return `Vamos começar pelo *${nomeComDosagemFila}* (às ${listaHorarios}): quanto você toma ou usa em cada horário?\n`
                + `Por exemplo: 1 comprimido, ou 20 gotas`;
        }
        return `Os horários já anotei (às ${listaHorarios}) 🌿\n\n`
            + `Quanto de ${nome} você toma ou usa em cada um?\n`
            + `Por exemplo: 1 comprimido, ou 20 gotas`;
    }

    // Falta só o horário (quantidade adiantada).
    if (campos?.quantidade_pendente !== null && campos?.quantidade_pendente !== undefined) {
        return `A quantidade já anotei — falta só o horário. 🌿\n\nEm quais *horários* você toma ou usa o ${nome}?`;
    }

    // Repergunta da posologia inteira (falha da camada 1), com reconhecimento
    // honesto de apresentação não representada (regra 3 — caso A17 "Pó").
    if (motivoFalha) {
        const abertura = aberturaApresentacao(nome, mensagemUsuario)
            || `Desculpa, não peguei direito 😊`;
        return `${abertura}\n\n`
            + `Me conta: quanto de ${nome} você toma ou usa por vez, e em quais horários?\n`
            + `Por exemplo: 1 unidade às 8h`;
    }

    // Posologia composta — primeira pergunta após o nome (decisão de produto
    // 19/09: quantidade E horários numa pergunta só; a abertura CONFIRMA a ação
    // em curso, conectando com o que a pessoa acabou de mandar).
    const nomeComDosagem = campos?.dosagem ? `${nome} ${campos.dosagem}` : nome;
    if (aberturaFila) {
        return `Vamos começar pelo *${nomeComDosagem}*: quanto você toma ou usa por vez, e em quais horários?\n`
            + `Por exemplo: 1 comprimido às 8h`;
    }
    const abertura = nomeRecemColetado
        ? `Certo${first ? `, ${first}` : ''}! Vamos cadastrar o ${nomeComDosagem} pra você. 😊`
        : `Seguindo com o ${nomeComDosagem}. 😊`;
    return `${abertura}\n\n`
        + `Me conta: quanto você toma ou usa por vez, e em quais horários?\n`
        + `Por exemplo: 1 comprimido às 22h`;
}

// Perguntas das sub-etapas de estoque — mesmos textos que viviam em
// renderizarPerguntaEstoque (cadastro.js); escolhidas em código a partir da
// ação do validador, nunca pelo LLM.
export function renderizarPerguntaEstoque(etapa, campos, acao = null) {
    const nome = campos?.nome || '{nome}';

    if (etapa === 'cad_estoque') {
        if (acao === 'estoque_indeterminado') return `Quantas unidades de ${nome} você tem agora?`;
        if (acao === 'status_frasco_indeterminado') {
            return `Me diz assim: ele já está aberto, você já usou alguma coisa dele, ou ainda está lacrado, sem ter usado nada ainda?`;
        }
        if (acao === 'frascos_indeterminado') {
            return `Não peguei o número 😊 Me diz só quantos frascos de ${nome} você tem em casa — por exemplo: 1, 2, 3.`;
        }
        if (campos?.unidade_estoque === 'ml') {
            if (campos?.status_frasco === 'fechado') return `Quantos frascos de ${nome} você tem?`;
            return `O frasco de ${nome} já está *ABERTO* (você já está usando) ou ainda está *FECHADO* (nunca foi aberto)?`;
        }
        // v44 (Constituição regra 1): estoque é opcional — o pedido é CONVITE,
        // nunca ordem, com a porta de saída na própria mensagem. Formato leve.
        {
            const forma = derivarFormaFarmaceutica(campos?.forma_explicita, campos?.forma_confirmada, campos?.unidade_dose);
            const rotulo = pluralizarRotulo(rotuloDaDose(campos?.unidade_dose, forma), 2);
            return `📦 *Estoque:* se você souber quantos ${rotulo} tem em casa, é só me falar — eu te aviso quando estiver acabando.\nSe não souber agora, tudo bem também. 🌿`;
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

// Prefácio da dúvida (camada 2: motivo 'duvida') — honestidade em uma frase,
// sem insistir nem negociar; a pergunta pendente vem em seguida.
export function renderizarPrefacioDuvida() {
    return `Boa pergunta! Eu preciso disso pra montar os lembretes certinhos e acompanhar seu tratamento. 🌿`;
}

// ------------------------------------------------------------
// MENSAGENS DE PERSISTÊNCIA — 100% template lendo PÓS-ESCRITA (regra
// 2 da Constituição; responsabilidade 3 do runner). O runner lê o
// banco e passa o registro; aqui só se renderiza.
// ------------------------------------------------------------

export function renderizarDeclarativa(med, userName) {
    const first = primeiroNome(userName);
    // Sem emoji na declarativa: o 💊 da linha "Remédio" do resumo vem logo abaixo.
    return `*${med.nome}* cadastrado${first ? `, ${first}` : ''}! Vou te lembrar nos horários certos.`;
}

function sufixoRecorrencia(par) {
    if (Number(par?.intervalo_dias) === 2) return ' (dia sim, dia não)';
    if (Number(par?.intervalo_dias) >= 3) return ` (a cada ${par.intervalo_dias} dias)`;
    const rotulo = rotuloDias(par?.dias_semana);
    return rotulo ? ` (${rotulo})` : '';
}

function renderizarListaPosologia(pares, rotulo) {
    return [...(pares || [])]
        .sort((a, b) => a.horario.localeCompare(b.horario))
        .map(p => `   • ${p.horario} — ${p.quantidade} ${pluralizarRotulo(rotulo, p.quantidade)}${sufixoRecorrencia(p)}`)
        .join('\n');
}

// Resumo lido do medicamento JÁ GRAVADO e seus schedules ativos (P56) — nunca do
// rascunho em memória. A linha de estoque só aparece se houver estoque: "não sei"
// não vira "0" nem "não informado", simplesmente não é mencionado (P49).
export function renderizarResumoDoMedicamento(med, pares) {
    const rotulo = rotuloDaDose(med.unidade_dose, med.forma_farmaceutica);
    const tratamento = med.tipo_tratamento === 'temporario' ? `${med.tratamento_dias} dias` : 'contínuo';

    const linhas = [`💊 Remédio: ${med.nome}`];
    if (med.dosagem) linhas.push(`📏 Dosagem: ${med.dosagem}`);
    linhas.push(`💉 Forma: ${med.forma_farmaceutica}`);
    linhas.push(`⏰ Posologia:\n${renderizarListaPosologia(pares, rotulo)}`);
    linhas.push(`🔄 Tratamento: ${tratamento}`);
    if (med.estoque_atual !== null && med.estoque_atual !== undefined) {
        const unidadeLabel = med.unidade_estoque === 'ml' ? 'ml' : 'unidades';
        const sufixoEstimativa = med.estoque_estimado ? ' (estimativa)' : '';
        linhas.push(`📦 Estoque: ${med.estoque_atual} ${unidadeLabel}${sufixoEstimativa}`);
    }

    return linhas.join('\n');
}

// Fechamento pós-estoque (v44, decisão de produto 19/09): estoque respondido —
// com valor ou "não sei" — fecha com mensagem curta; número lido PÓS-ESCRITA.
export function renderizarFechamentoEstoque({ med, alerta, primeiroMedicamento, firstName, resumoJaMostraEstoque = false }) {
    const linhas = [];

    if (med.estoque_atual !== null && med.estoque_atual !== undefined) {
        if (!resumoJaMostraEstoque) {
            const unidadeLabel = med.unidade_estoque === 'ml'
                ? 'ml'
                : pluralizarRotulo(rotuloDaDose(med.unidade_dose, med.forma_farmaceutica), Number(med.estoque_atual));
            const sufixoEstimativa = med.estoque_estimado ? ' (estimativa)' : '';
            linhas.push(`📦 Anotado: *${med.estoque_atual}* ${unidadeLabel} de ${med.nome} no estoque${sufixoEstimativa}.`);
        }
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

// Fechamento com cadastro JÁ GRAVADO (evidência A6 — Carla): recusar/adiar o
// que resta NÃO é cancelar — a resposta afirma a verdade do banco (P56).
export function renderizarFechamentoCadastroJaGravado({ nome, horarios, firstName }) {
    const horariosTexto = (horarios || []).length > 0 ? ` (${horarios.join(', ')})` : '';
    return `Tudo bem${firstName ? `, ${firstName}` : ''}! O *${nome}* já está cadastrado e os lembretes estão ativos${horariosTexto}. 🌿\n\nO estoque fica pra depois — quando quiser me falar, é só mandar a quantidade.`;
}

export function renderizarCancelamentoSemGravacao() {
    return `Tudo bem, cancelei o cadastro 🌿 Se quiser recomeçar, é só me chamar!`;
}

export function renderizarRecusaSemGravacao() {
    return `Tudo bem, parei o cadastro por aqui 🌿 Se quiser retomar depois, é só me chamar!`;
}

// ------------------------------------------------------------
// MEDICAMENTO EXISTENTE (duplicata / reativação / reencadastro)
// ------------------------------------------------------------

export function renderizarDuplicataAtiva(existente, horariosAtivos) {
    const horariosFormatados = horariosAtivos.map(h => `• ${h}`).join('\n');
    const tipoLabel = existente.tipo_tratamento === 'temporario'
        ? `${existente.tratamento_dias} dias`
        : 'uso contínuo';
    return `O *${existente.nome}* já está cadastrado e ativo 💊\n\nDosagem: ${existente.dosagem}\nHorários:\n${horariosFormatados}\nEstoque: ${existente.estoque_atual} unidades\nTratamento: ${tipoLabel}\n\nSe quiser atualizar alguma informação, é só me dizer!`;
}

export function renderizarDuplicataPausada(existente, horariosTodos) {
    const horariosFormatados = horariosTodos.map(h => `• ${h}`).join('\n');
    const tipoLabel = existente.tipo_tratamento === 'temporario'
        ? `${existente.tratamento_dias} dias`
        : 'uso contínuo';
    return `O *${existente.nome}* está com os lembretes pausados 💊\n\nÚltimos dados cadastrados:\n${horariosFormatados}\nEstoque: ${existente.estoque_atual} unidades\nTratamento: ${tipoLabel}\n\nQuer reativar os lembretes?`;
}

export function renderizarPropostaReencadastro(nome) {
    return `O *${nome}* foi encerrado anteriormente.\n\nQuer cadastrar um novo tratamento com ele agora?`;
}

export function renderizarReencadastroRecusado() {
    return `Tudo bem! Se precisar de algo mais, é só me chamar 🌿`;
}

export function renderizarDuplicataNaGravacao(med) {
    return `Já tenho o *${med.nome}* cadastrado! 💊\n\n`
        + `Cadastro atual: ${med.dosagem}, estoque: ${med.estoque_atual} unidades.\n\n`
        + `Se quiser atualizar, me diga "quero atualizar o ${med.nome}". `
        + `Caso contrário, está tudo certo como está! ✅`;
}

// ------------------------------------------------------------
// MULTI-MEDICAMENTO (MH-96, M2 §3) — proposta de lote, fila e
// fechamentos agregados. Tudo lido/confirmado pela pessoa; a
// gravação só acontece com o have-to-have completo de cada um.
// ------------------------------------------------------------

function linhaDoCandidatoNaProposta(c) {
    const nomeComDosagem = c.dosagem ? `${c.nome} ${c.dosagem}` : c.nome;
    const qtd = c.quantidade ? `${c.quantidade} ${pluralizarRotulo(c.formaRotulo || 'unidade', c.quantidade)} ` : '';
    return `• ${nomeComDosagem} — ${qtd}às ${c.horarios.join(' e às ')}`;
}

// Proposta agregada (casos A2/A16): todos os itens já têm horário; a quantidade
// que faltar é proposta EXPLICITAMENTE como 1 unidade — confirmação da pessoa,
// nunca suposição gravada em silêncio (regra 7).
export function renderizarPropostaLote(candidatos) {
    const linhas = candidatos.map(linhaDoCandidatoNaProposta).join('\n');
    const algumSemQuantidade = candidatos.some(c => !c.quantidade);
    const notaQuantidade = algumSemQuantidade
        ? `Onde você não me disse a quantidade, deixo *1 unidade* por vez — depois é só me corrigir se for diferente.\n\n`
        : '';
    return `Vi tudo o que você me mandou! Pelo que entendi:\n\n${linhas}\n\n`
        + notaQuantidade
        + `Posso cadastrar ${candidatos.length === 2 ? 'os dois' : `os ${candidatos.length}`} assim?`;
}

// Abertura da fila (caso A17): reconhece TODOS de imediato (regra 3), um por
// linha e em negrito (ajuste de copy do replay 19/09 — Priscila); o começo
// pelo primeiro vem embutido na própria pergunta (aberturaFila), sem repetir.
export function renderizarAberturaFila(candidatos) {
    const lista = candidatos.map(c => `• *${c.nome}*`).join('\n');
    return `Vi tudo o que você me mandou:\n${lista}`;
}

// Divisão de nome composto (caso A19 — "Regenesis e ofolato D"): dois produtos
// propostos e confirmáveis; a posologia respondida vale para os dois.
export function renderizarPropostaDivisaoNome(nomes) {
    return `Pelo que entendi são *dois* produtos: ${nomes.join(' e ')} — vou cadastrar os dois. Se for um produto só, me avisa! 😊\n\n`
        + `Me conta: quanto você toma ou usa de cada um por vez, e em quais horários?\n`
        + `Por exemplo: 1 comprimido às 12h`;
}

// Transição da fila: o anterior está pronto (pós-escrita), o próximo começa —
// sempre em negrito (ajuste de copy do replay 19/09).
export function renderizarTransicaoFila({ proximo }) {
    const nomeComDosagem = proximo.dosagem ? `${proximo.nome} ${proximo.dosagem}` : proximo.nome;
    if ((proximo.horarios || []).length > 0) {
        return `Agora o *${nomeComDosagem}* (às ${proximo.horarios.join(' e às ')}) — quanto você toma ou usa em cada horário?\n`
            + `Por exemplo: 1 comprimido, ou 20 gotas`;
    }
    return `Agora o *${nomeComDosagem}* — me conta: quanto você toma ou usa por vez, e em quais horários?\n`
        + `Por exemplo: 1 comprimido às 22h`;
}

// Fechamento do lote — 100% pós-escrita (P56): cada linha vem do registro
// gravado e seus schedules ativos.
export function renderizarFechamentoLote({ gravados, duplicatas = [], primeiroMedicamento = false }) {
    const linhas = gravados.map(({ med, pares }) => {
        const horarios = pares.map(p => p.horario).join(' e às ');
        return `• *${med.nome}* — às ${horarios}`;
    }).join('\n');

    const partes = [];
    partes.push(`Prontinho! ${gravados.length === 2 ? 'Os dois estão' : `Os ${gravados.length} estão`} cadastrados:\n\n${linhas}\n\nVou te lembrar nos horários certos de cada um.`);

    if (duplicatas.length > 0) {
        const nomes = duplicatas.map(d => `*${d.nome}*`).join(', ');
        partes.push(`${nomes} já ${duplicatas.length === 1 ? 'estava cadastrado' : 'estavam cadastrados'} — mantive como estava.`);
    }

    partes.push(renderizarConviteEstoqueLote());

    if (primeiroMedicamento) {
        partes.push('Ah, e uma coisinha: eu ainda estou em desenvolvimento, sendo melhorada com carinho a cada dia — se eu escorregar em algo, me avisa? 😊');
    }
    return partes.join('\n\n');
}

// Declarativa curta de um item gravado em cadeia na fila (pós-escrita).
export function renderizarDeclarativaCurta(med, pares) {
    const horarios = pares.map(p => p.horario).join(' e às ');
    return `*${med.nome}* também cadastrado — vou te lembrar às ${horarios}.`;
}

export function renderizarDuplicataCurta(nome) {
    return `O *${nome}* já estava cadastrado — mantive como estava.`;
}

// Convite de estoque agregado no fim da fila/lote (leve, com porta de saída).
export function renderizarConviteEstoqueLote() {
    return `📦 *Estoque:* se você souber quantos tem em casa de cada um, é só me falar — eu te aviso quando estiver acabando.\nSe não souber agora, tudo bem também. 🌿`;
}

// Repetição da proposta de lote (falha da camada 1 na confirmação).
export function renderizarRepeticaoPropostaLote(candidatos) {
    return `Só me confirma uma coisa 😊\n\n${renderizarPropostaLote(candidatos)}`;
}

// Fechamento do cadastro ANTERIOR quando um medicamento diferente chega no meio
// (MH-83) — pela verdade do banco: ele JÁ existe e gera lembretes.
export function renderizarFechamentoAnterior(nomeAnterior) {
    return `Só fechando o anterior: o *${nomeAnterior}* já está cadastrado, e o estoque dele fica pra depois — quando quiser, é só me mandar a quantidade. 🌿`;
}

// ------------------------------------------------------------
// RECORRÊNCIA NÃO SUPORTADA (validador v44 §5.7, evidência A3) —
// honestidade de limite + oferta do subconjunto representável.
// ------------------------------------------------------------

// MH-77: o que era limite geral virou capacidade — o bloqueio agora só cobre
// o que segue fora do representável (ciclos por semanas) e o padrão semanal
// sem dia nomeado (pede o dia, nunca grava suposição).
export function renderizarBloqueioRecorrencia(horariosCitados, padroes = []) {
    if (padroes.includes('x_por_semana') && !padroes.includes('dia_da_semana') && !padroes.includes('abreviacao_de_dias')) {
        return (
            `Uma vez por semana eu faço sim! Só preciso saber o dia certinho. 😊\n\n` +
            `Em qual dia da semana você toma?`
        );
    }
    const oferta = (horariosCitados || []).length > 0
        ? `Como você prefere deixar os lembretes — ${horariosCitados.join(' ou ')}?`
        : 'Como você prefere deixar os lembretes?';
    return (
        `Esse padrão de ciclo eu ainda não consigo acompanhar — por enquanto eu sei fazer ` +
        `dias da semana (ex: seg a sex), *dia sim, dia não* e 1x por semana. É algo que está chegando! 😊\n\n` +
        `Se um desses formatos servir por enquanto, a gente já deixa combinado.\n\n` +
        oferta
    );
}
