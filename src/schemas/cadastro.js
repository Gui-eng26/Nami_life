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
    derivarFormaFarmaceutica, rotuloDaDose, pluralizarRotulo
} from '../validadores/derivacoes.js';
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

    return { ...decisao, mencionaConcentracao };
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
        // cad_confirma_forma morreu por construção — BUG-102).
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

export function renderizarPerguntaPosologia({ campos, userName, acao = null, motivoFalha = null, mencionaConcentracao = false, nomeRecemColetado = false, mensagemUsuario = '' }) {
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

function renderizarListaPosologia(pares, rotulo) {
    return [...(pares || [])]
        .sort((a, b) => a.horario.localeCompare(b.horario))
        .map(p => `   • ${p.horario} — ${p.quantidade} ${pluralizarRotulo(rotulo, p.quantidade)}`)
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
// RECORRÊNCIA NÃO SUPORTADA (validador v44 §5.7, evidência A3) —
// honestidade de limite + oferta do subconjunto representável.
// ------------------------------------------------------------

export function renderizarBloqueioRecorrencia(horariosCitados) {
    const oferta = (horariosCitados || []).length > 0
        ? `Qual desses horários você quer usar todos os dias — ${horariosCitados.join(' ou ')}?`
        : 'Qual horário você quer usar todos os dias?';
    return (
        `Por enquanto eu ainda não consigo variar os horários por dia da semana — ` +
        `só consigo te lembrar nos *mesmos horários todos os dias*. É algo que está chegando! 😊\n\n` +
        `Se estiver bom pra você, a gente já deixa um horário fixo por enquanto.\n\n` +
        oferta
    );
}
