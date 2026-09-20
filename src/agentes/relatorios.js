import 'dotenv/config';
import {
    getDosesDoDia,
    getMedicamentosAtivos,
    getEstoque,
    getProximosMedicamentos,
    calcularAdesao,
    calcularProgressoTratamento,
    getAdesaoEstado,
    upsertAdesaoEstado,
    saveConversationState,
    precisaSaudacao,
    registrarEventoProativo,
    getMedicamentosEncerrados,
    getUltimasDosesDoMedicamento,
    getMedicationComSchedulesAtivos,
    calcularConsumoDiario
} from '../database.js';
import { registrarEvento } from '../observabilidade.js';
import { enviarAoUsuario } from '../funil.js';
import { encontrarMedicamento } from '../nlp_helpers.js';
import {
    escolherFaixa,
    montarMensagemSemanal,
    montarMensagemMensal,
    montarBlocoMotivo,
    montarBlocoTurno,
    montarBlocoTendencia,
    montarBlocoMarco,
    montarBlocoEstoque,
    escolherFaseProgresso,
    montarMensagemProgresso,
    montarFallbackContinuo,
    montarResumoCompacto
} from '../templates/adesaoTemplates.js';
import {
    resolverDataReferencia, validarJanela, rotularData, diasAtras, hojeBRT,
    extrairExpressaoData, extrairIntervalo, diasDoIntervalo
} from '../dataReferencia.js';
import { rotuloDias } from '../validadores/recorrencia.js';
import { rotuloDaDose, pluralizarRotulo } from '../validadores/derivacoes.js';
import {
    montarBlocoFactual, resumirSituacao, molduraPadrao, montarCabecalhoData,
    TEXTO_FORA_DA_JANELA, TEXTO_DATA_FUTURA, TEXTO_DATA_NAO_RECONHECIDA
} from '../templates/balancoTemplates.js';
import { classificarComFerramenta } from '../validadores/llm.js';

// Considera fechamento mensal quando o último fechamento tem 28+ dias (ou nunca fechou).
const DIAS_FECHAMENTO_MENSAL = 28;
// '100' > '80_99' > '50_79' > 'abaixo_50' — usado para marco (melhor faixa já atingida)
const RANKING_FAIXA = { abaixo_50: 0, '50_79': 1, '80_99': 2, '100': 3 };
const JANELA_CONFIRMACAO_RETROATIVA_DIAS = 2;

// Saudação condicional dos templates "sob demanda" (BRIEFING_APRESENTACAO_V2.md, seção 1) —
// evita repetir "Olá, [Nome]!" quando o usuário manda várias perguntas seguidas em pouco tempo.
async function comSaudacao(userId, nome, corpo) {
    const saudacao = await precisaSaudacao(userId) ? `Olá, ${nome}! ` : '';
    return saudacao + corpo;
}

// ============================================================
// CLASSIFICADOR DE INTENÇÃO DE RELATÓRIO
// Exportado para uso no router.js (Camada 1 — fast-path por palavra-chave)
// ============================================================

export function classificarIntencaoRelatorio(message) {
    if (!message) return null;
    const msg = message.toLowerCase().trim();

    const padroes = {
        balanco_do_dia: [
            'tomei hoje?',
            'já tomei meus remédios',
            'tomei alguma coisa hoje',
            'registrei hoje',
            'esqueci de tomar hoje',
            'tomei tudo hoje',
            'tomei o remédio hoje',
            'ficou alguma dose pendente',
            'faltou algum remédio',
            'pulei algum remédio'
        ],
        meus_remedios: [
            'quais meus remédios',
            'que remédios tenho',
            'o que tenho cadastrado',
            'quais remédios eu tomo',
            'me mostra meus remédios',
            'lista meus remédios',
            'remédios cadastrados',
            'quais são meus remédios',
            'ver meus remédios'
        ],
        estoque: [
            'quanto tenho de cada',
            'tô ficando sem remédio',
            'quando preciso comprar',
            'quanto sobrou',
            'como está meu estoque',
            'preciso comprar remédio',
            'quanto tenho ainda de',
            'tô sem remédio'
        ],
        proximo_remedio: [
            'o que tenho que tomar',
            'que horas é o próximo',
            'tenho remédio pra tomar agora',
            'esqueci de tomar alguma coisa',
            'qual o próximo remédio',
            'o que devo tomar agora',
            'que remédio tomo agora'
        ],
        // P4.4 (M3): os padrões de adesão apontam para o balanço — o pedido
        // de adesão cai no período livre.
        balanco_periodo: [
            'quantas vezes esqueci',
            'tenho esquecido muito',
            'como está minha adesão',
            'tô tomando direitinho',
            'quantas doses perdi',
            'faltei alguma dose',
            'como tá meu histórico',
            'tô me cuidando bem'
        ],
        progresso_tratamento: [
            'como estou no meu tratamento',
            'como está meu tratamento',
            'quanto falta pro tratamento acabar',
            'quantos dias faltam de tratamento',
            'em que dia do tratamento eu estou',
            'já estou terminando o tratamento',
            'quanto tempo ainda vou tomar esse remédio',
            'meu tratamento já acabou?'
        ]
    };

    for (const [tipo, termos] of Object.entries(padroes)) {
        if (termos.some(t => msg.includes(t))) return tipo === 'balanco_periodo' ? 'balanco_do_dia' : tipo;
    }

    return null;
}

// ============================================================
// HANDLER PRINCIPAL
// subtipo é sempre fornecido por quem chama (Camada 1 ou Camada 2 do router.js) —
// nunca mais recalculado aqui dentro (Camada 3 eliminada, causa raiz do BUG-037).
// ============================================================

export async function handleRelatorios({ user, message, subtipo, params, state }) {
    const p = params || { medicamento: null, expressaoData: null };

    switch (subtipo) {
        case 'balanco_do_dia':
            return await relatorioBalancoDoDia({ user, message, params: p });
        // P4.1 (M3): pergunta sobre UM medicamento responde sobre ELE — a
        // mensagem e os params chegam até aqui (o defeito era de roteamento).
        case 'meus_remedios':
            return await relatorioMeusRemedios({ user, message, params: p });
        case 'estoque':
            return await relatorioEstoque({ user, message, params: p });
        case 'proximo_remedio':
            return await relatorioProximoRemedio({ user, message, params: p });
        // MH-31 (M3): encerrados só sob pedido.
        case 'historico_encerrados':
            return await relatorioEncerrados(user);
        case 'progresso_tratamento':
            return await relatorioProgressoTratamento({ user, message, state });
        default:
            return null; // não reconheceu — router cai no agente_principal
    }
}

// Princípio 17: o texto da mensagem atual resolve primeiro; o palpite do classificador
// é só fallback. Retorna { id, nome } ou null.
async function resolverMedicamento({ userId, message, medicamentoParam }) {
    const medications = await getMedicamentosAtivos(userId);
    if (medications.length === 0) return null;

    const porTexto = encontrarMedicamento(message, medications);
    if (porTexto) return { id: porTexto.id, nome: porTexto.nome };

    if (medicamentoParam) {
        const porParam = encontrarMedicamento(medicamentoParam, medications);
        if (porParam) return { id: porParam.id, nome: porParam.nome };
    }
    return null;
}

// ============================================================
// R-001 (v25): BALANÇO DO DIA — substitui tomei_hoje
// Núcleo factual determinístico + moldura escrita pelo LLM.
// ============================================================

async function relatorioBalancoDoDia({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';

    // P4.3 (M3) — PERÍODO LIVRE: intervalo detectado na mensagem (ou na
    // expressão da porta) vira balanço de período; a adesão reativa morreu e
    // seus pedidos caem aqui.
    const intervalo = extrairIntervalo(message)
        || (params.expressaoData ? extrairIntervalo(params.expressaoData) : null);
    if (intervalo) {
        return await relatorioBalancoPeriodo({ user, message, params, intervalo });
    }

    // Princípio 17: texto da mensagem primeiro; params do classificador como fallback.
    // Necessário porque a Camada 1 não produz params (C-1, v25).
    const expressao = extrairExpressaoData(message) || params.expressaoData;
    const { dataISO, erro } = resolverDataReferencia(expressao);
    if (erro === 'futuro') return comSaudacao(user.id, firstName, TEXTO_DATA_FUTURA);
    if (erro) return comSaudacao(user.id, firstName, TEXTO_DATA_NAO_RECONHECIDA);

    // P4.3: leitura livre desde o início do usuário na Nami; antes disso,
    // resposta honesta com a data de início.
    const janela = validarJanela(dataISO, user.created_at || null);
    if (!janela.ok) {
        if (janela.motivo === 'futuro') return comSaudacao(user.id, firstName, TEXTO_DATA_FUTURA);
        if (janela.motivo === 'antes_do_inicio') {
            return comSaudacao(user.id, firstName, montarTextoAntesDoInicio(user.created_at));
        }
        return comSaudacao(user.id, firstName, TEXTO_FORA_DA_JANELA);
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const doses = await getDosesDoDia(user.id, dataISO, med?.id || null);
    const resumo = resumirSituacao(doses);
    const rotuloData = rotularData(dataISO);
    const blocoFactual = montarBlocoFactual(doses);

    // Janela de confirmação retroativa: só até 2 dias (mesma janela de getDosesRetroativas).
    // Além dela, é leitura pura — estoque só se ajusta por pedido direto do usuário.
    const podeConfirmarRetroativo = diasAtras(dataISO) <= JANELA_CONFIRMACAO_RETROATIVA_DIAS;

    const moldura = await gerarMoldura({
        nome: firstName, rotuloData, resumo, med, podeConfirmarRetroativo
    });

    const cabecalhoData = montarCabecalhoData(dataISO, rotuloData);

    const partes = [moldura.abertura];
    if (cabecalhoData) partes.push(cabecalhoData);
    if (blocoFactual) partes.push(blocoFactual);
    if (moldura.fechamento) partes.push(moldura.fechamento);

    return comSaudacao(user.id, firstName, partes.join('\n\n'));
}

// P4.3: balanço de PERÍODO — leitura pura, 100% determinística (sem moldura
// LLM), um resumo por dia + total do período. Fora da janela de confirmação
// retroativa não há oferta de registro (A28).
function montarTextoAntesDoInicio(criadoEm) {
    const inicio = String(criadoEm || '').slice(0, 10);
    const [ano, mes, dia] = inicio.split('-');
    const dataBR = dia ? `${dia}/${mes}/${ano}` : null;
    return `A gente começou a conversar${dataBR ? ` em ${dataBR}` : ' há pouco tempo'} — antes disso eu ainda não estava com você, então não tenho registros. 🌿`;
}

async function relatorioBalancoPeriodo({ user, message, params, intervalo }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const hoje = hojeBRT();
    const inicioUsuario = String(user.created_at || '').slice(0, 10) || null;

    let { inicioISO, fimISO } = intervalo;
    if (fimISO > hoje) fimISO = hoje;
    if (inicioUsuario && fimISO < inicioUsuario) {
        return comSaudacao(user.id, firstName, montarTextoAntesDoInicio(user.created_at));
    }
    if (inicioUsuario && inicioISO < inicioUsuario) inicioISO = inicioUsuario;
    if (inicioISO > fimISO) {
        return comSaudacao(user.id, firstName, TEXTO_DATA_FUTURA);
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const linhas = [];
    let totalDoses = 0;
    let totalConfirmadas = 0;
    for (const dia of diasDoIntervalo(inicioISO, fimISO)) {
        const doses = await getDosesDoDia(user.id, dia, med?.id || null);
        const reais = doses.filter(d => d.status !== 'agendado' || d.horarioJaPassou);
        if (reais.length === 0) continue;
        const confirmadas = reais.filter(d => d.status === 'confirmado').length;
        totalDoses += reais.length;
        totalConfirmadas += confirmadas;
        const [, m, d] = dia.split('-');
        const icone = confirmadas === reais.length ? '✅' : confirmadas === 0 ? '❌' : '◽';
        linhas.push(`${icone} ${d}/${m} — ${confirmadas} de ${reais.length} doses`);
    }

    const cabecalho = `📅 ${intervalo.rotulo}${med ? ` — *${med.nome}*` : ''}`;
    if (totalDoses === 0) {
        return comSaudacao(user.id, firstName,
            `${cabecalho}\n\nNão encontrei registros de doses nesse período, ${firstName}. 🌿`);
    }

    const percentual = Math.round((totalConfirmadas / totalDoses) * 100);
    const corpo = [
        cabecalho,
        linhas.join('\n'),
        `No período: *${totalConfirmadas}* de *${totalDoses}* doses confirmadas (${percentual}%).`
    ].join('\n\n');

    return comSaudacao(user.id, firstName, corpo);
}

const PROMPT_MOLDURA = `Você é a Nami, assistente de saúde via WhatsApp. Linguagem simples, clara e
carinhosa, com emojis usados com moderação.

Você vai escrever a ABERTURA e o FECHAMENTO de uma mensagem. Entre as duas, o usuário verá uma
lista de doses que JÁ ESTÁ PRONTA e que você NÃO escreve.

REGRAS ABSOLUTAS:
1. NUNCA cite nome de medicamento, horário, quantidade, data ou status na abertura ou no
   fechamento. Esses dados já aparecem na lista. Fale de forma geral ("suas doses", "alguns
   remédios", "o dia").
2. NUNCA invente informação. Você recebe apenas um resumo numérico — use só ele.
3. NUNCA mencione mecanismo interno (sistema, aplicativo, banco de dados, registro técnico).
   Para o usuário existe só você.
4. Abertura: no máximo 2 frases. Fechamento: no máximo 2 frases, ou vazio.
5. Não repita a saudação com o nome mais de uma vez.
6. Negrito do WhatsApp é UM asterisco de cada lado (*assim*) — NUNCA dois: eles aparecem
   literalmente na tela do usuário. No máximo uma pergunta, e sempre no fechamento.

Sobre o CENÁRIO recebido:
- tudo_confirmado: celebre com leveza.
- nada_chegou_ainda: informe que o dia ainda está começando, sem cobrança.
- nada_confirmado: acolha, sem culpa, e convide a atualizar.
- parcial: reconheça o que foi feito e aponte com gentileza o que ficou em aberto.
- sem_doses: informe que não há registro para esse dia, sem alarme.

Sobre os números recebidos:
- "aguardandoConfirmacao": doses cujo horário já passou e que ainda esperam a resposta do usuário.
- "aindaNaoChegaram": doses do dia cujo horário ainda não chegou — não são atraso, não cobre.
- "semRegistro": doses cujo horário passou sem registro. Não afirme que o usuário não tomou;
  trate como pendência de confirmação.

Se "podeConfirmarRetroativo" for true E houver doses faltantes, o FECHAMENTO deve convidar o
usuário a avisar caso tenha tomado e esquecido de confirmar — dizendo que você registra e ajusta
o estoque para ele.
Se for false E houver doses faltantes, o fechamento NÃO deve oferecer registro: explique com
delicadeza que para dias mais antigos você só consegue mostrar o histórico, e que ajustes de
estoque precisam ser pedidos diretamente.

Responda APENAS com JSON válido, sem markdown e sem texto antes ou depois:
{"abertura": "...", "fechamento": "..."}`;

async function gerarMoldura({ nome, rotuloData, resumo, med, podeConfirmarRetroativo }) {
    const entrada = JSON.stringify({
        nome,
        dia: rotuloData,
        medicamentoEspecifico: med ? true : false,
        cenario: resumo.cenario,
        totalDoses: resumo.total,
        confirmadas: resumo.confirmadas,
        faltantes: resumo.faltantes,
        aguardandoConfirmacao: resumo.aguardandoConfirmacao,
        aindaNaoChegaram: resumo.aindaNaoChegaram,
        semRegistro: resumo.semRegistro,
        podeConfirmarRetroativo
    });

    // v44 M3 P6.2: tool-use com schema — a moldura chega estruturada, nunca
    // JSON em texto livre (mesmo padrão da porta: 1 retry + degradar). Na
    // degradação, a moldura padrão determinística assume (comportamento antigo).
    const { parsed, degradado } = await classificarComFerramenta({
        systemPrompt: PROMPT_MOLDURA,
        message: entrada,
        maxTokens: 300,
        nomeFerramenta: 'registrar_moldura',
        descricaoFerramenta: 'Registra a abertura e o fechamento da mensagem.',
        schema: {
            type: 'object',
            properties: {
                abertura: { type: 'string', description: 'Abertura da mensagem (máx. 2 frases).' },
                fechamento: { type: 'string', description: 'Fechamento (máx. 2 frases), ou string vazia.' }
            },
            required: ['abertura']
        },
        // Critério de FORMA, não de tamanho (lição do BUG-067): texto que começa
        // com "{" nunca é exposto cru ao usuário.
        validar: (input) => typeof input?.abertura === 'string'
            && input.abertura.trim().length > 0
            && !input.abertura.trim().startsWith('{'),
        motivo: 'moldura_relatorio_falhou',
        agent: 'relatorios',
        origem: 'relatorios',
        fallback: null
    });

    if (degradado || !parsed) {
        console.warn('[relatorios] Moldura via LLM degradou — usando padrão determinístico');
        return molduraPadrao({ nome, rotuloData, resumo });
    }

    const fechamento = typeof parsed.fechamento === 'string' ? parsed.fechamento.trim() : '';
    return {
        abertura: parsed.abertura.trim(),
        fechamento: fechamento.startsWith('{') ? '' : fechamento
    };
}

// ============================================================
// R-002: QUAIS MEUS REMÉDIOS?
// ============================================================

async function relatorioMeusRemedios({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const medications = await getMedicamentosAtivos(user.id);

    if (medications.length === 0) {
        return `Você ainda não tem remédios cadastrados, ${firstName}. Quer cadastrar agora? 💊`;
    }

    // P4.1 (M3): pergunta sobre UM medicamento responde sobre ELE — nunca a
    // lista completa (o defeito era de roteamento: a função nem recebia a
    // mensagem; resolverMedicamento já existia).
    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params?.medicamento
    });
    if (med) {
        return await relatorioMedicamentoEspecifico({ user, firstName, medicationId: med.id });
    }

    // A-2 (v25): ordem alfabética. Feita AQUI e não em getUserMedications de propósito —
    // aquela função tem sete consumidores e reordenar na origem mudaria o comportamento
    // de quem não pediu. localeCompare com 'pt-BR' para acentuação correta (Ômega).
    const ordenados = [...medications].sort((a, b) =>
        String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR')
    );

    // P1/P4 (M3): a lista separa Ativos de Pausados pelo estado EXPLÍCITO
    // (medications.status) — nunca mais tudo misturado. Encerrados só sob
    // pedido (MH-31).
    const ativos = ordenados.filter(m => (m.status || 'ativo') === 'ativo');
    const pausados = ordenados.filter(m => m.status === 'pausado');

    const linhaDoMedicamento = (med, i, semLembretes = false) => {
        const horariosAtivos = (med.schedules || []).filter(s => s.ativo);
        // Replay 20/09 (correção de Guilherme): a lista mostra a POSOLOGIA
        // (quanto em cada horário, com recorrência), não só os horários.
        // A-2 (v25): sempre ordenados — antes saíam na ordem do banco.
        let posologia;
        if (semLembretes) {
            posologia = 'lembretes pausados';
        } else if (horariosAtivos.length === 0) {
            posologia = 'sem horário cadastrado';
        } else {
            const rotulo = rotuloDaDose(med.unidade_dose, med.forma_farmaceutica);
            const pares = horariosAtivos
                .map(s => ({
                    h: String(s.horario).substring(0, 5),
                    q: Number(s.quantidade_por_dose) || 1,
                    dias: rotuloDias(s.dias_semana)
                }))
                .sort((a, b) => a.h.localeCompare(b.h));
            const quantidadesIguais = new Set(pares.map(par => par.q)).size === 1;
            const diasIguais = new Set(pares.map(par => par.dias || '')).size === 1;
            if (quantidadesIguais && diasIguais) {
                const q = pares[0].q;
                posologia = `${q} ${pluralizarRotulo(rotulo, q)} às ${pares.map(par => par.h).join(' e às ')}`
                    + (pares[0].dias ? ` (${pares[0].dias})` : '');
            } else {
                posologia = pares
                    .map(par => `${par.h} — ${par.q} ${pluralizarRotulo(rotulo, par.q)}${par.dias ? ` (${par.dias})` : ''}`)
                    .join(' · ');
            }
        }
        const forma = med.forma_farmaceutica || 'unidade';
        // A-4 (v25): dosagem nula era exibida literalmente como "null".
        const dosagem = med.dosagem || 'dosagem não informada';
        return `${i}. *${med.nome}* — ${dosagem} (${forma})\n   ⏰ ${posologia}\n\n`;
    };

    let msg = `💊 Seus remédios cadastrados, ${firstName}:\n\n`;
    let n = 0;

    if (pausados.length > 0 && ativos.length > 0) msg += `✅ *Ativos*\n\n`;
    for (const med of ativos) msg += linhaDoMedicamento(med, ++n);
    if (pausados.length > 0) {
        msg += `⏸️ *Pausados*\n\n`;
        for (const med of pausados) msg += linhaDoMedicamento(med, ++n, true);
    }

    return msg.trim();
}

// P4.1 (M3): visão de UM tratamento — posologia, horários, status explícito,
// estoque e últimas doses, tudo lido do banco (P56).
async function relatorioMedicamentoEspecifico({ user, firstName, medicationId }) {
    const med = await getMedicationComSchedulesAtivos(medicationId);
    const ultimas = await getUltimasDosesDoMedicamento(medicationId, 5);

    const statusLabel = med.status === 'pausado'
        ? '⏸️ lembretes pausados'
        : med.status === 'encerrado' ? '🔴 encerrado' : '✅ ativo';

    const pares = (med.schedulesAtivos.length > 0 ? med.schedulesAtivos : med.schedules || [])
        .map(sch => ({
            horario: String(sch.horario).slice(0, 5),
            quantidade: Number(sch.quantidade_por_dose),
            dias: rotuloDias(sch.dias_semana)
        }))
        .sort((a, b) => a.horario.localeCompare(b.horario));
    const linhasPosologia = pares
        .map(par => `   • ${par.horario} — ${par.quantidade} por vez${par.dias ? ` (${par.dias})` : ''}`)
        .join('\n');

    const linhas = [`💊 *${med.nome}*${med.dosagem ? ` — ${med.dosagem}` : ''} (${med.forma_farmaceutica})`];
    linhas.push(`Status: ${statusLabel}`);
    if (linhasPosologia) linhas.push(`⏰ Posologia:\n${linhasPosologia}`);
    linhas.push(`🔄 Tratamento: ${med.tipo_tratamento === 'temporario' ? `${med.tratamento_dias} dias` : 'contínuo'}`);
    if (med.estoque_atual !== null && med.estoque_atual !== undefined) {
        linhas.push(`📦 Estoque: ${med.estoque_atual} ${med.unidade_estoque === 'ml' ? 'ml' : 'unidades'}${med.estoque_estimado ? ' (estimativa)' : ''}`);
    } else {
        linhas.push('📦 Estoque: não informado (me diga quantos você tem e eu acompanho)');
    }

    if (ultimas.length > 0) {
        const ICONE_DOSE = { confirmado: '✅', nao_informado: '⏳', nao_tomado: '❌', sem_estoque: '📦', pendente: '❓', pausado: '⏸️' };
        const linhasDoses = ultimas.map(d => {
            const quando = new Date(d.scheduled_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
            const hora = d.horario_agendado ? String(d.horario_agendado).slice(0, 5)
                : new Date(d.scheduled_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
            const rotulo = d.status === 'confirmado' ? 'confirmada'
                : d.status === 'nao_tomado' ? 'não tomada'
                : d.status === 'nao_informado' ? 'sem confirmação'
                : d.status === 'sem_estoque' ? 'sem estoque'
                : d.status === 'pendente' ? 'aguardando confirmação' : d.status;
            return `   ${ICONE_DOSE[d.status] || '•'} ${quando} ${hora} — ${rotulo}`;
        }).join('\n');
        linhas.push(`Últimas doses:\n${linhasDoses}`);
    }

    return comSaudacao(user.id, firstName, linhas.join('\n'));
}

// MH-31 (M3): histórico de tratamentos encerrados — só sob pedido.
async function relatorioEncerrados(user) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const encerrados = await getMedicamentosEncerrados(user.id);

    if (encerrados.length === 0) {
        return comSaudacao(user.id, firstName, 'Você ainda não tem nenhum tratamento encerrado por aqui. 🌿');
    }

    const linhas = encerrados.map(m => {
        const quando = m.status_alterado_em
            ? new Date(m.status_alterado_em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' })
            : null;
        return `• *${m.nome}*${m.dosagem ? ` — ${m.dosagem}` : ''}${quando ? ` (encerrado em ${quando})` : ''}`;
    }).join('\n');

    return comSaudacao(user.id, firstName,
        `🗂️ Tratamentos que você já encerrou:\n\n${linhas}\n\nSe quiser retomar algum deles, é só me pedir pra reativar. 🌿`);
}

// ============================================================
// R-003: ESTOQUE
// ============================================================

async function relatorioEstoque({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const estoque = await getEstoque(user.id);

    if (estoque.length === 0) {
        return `Você ainda não tem remédios cadastrados, ${firstName}. 💊`;
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    let lista = med ? estoque.filter(e => e.id === med.id) : estoque;
    if (lista.length === 0) return null; // não encontrou — cai no principal

    // MH-60 (M3 P4.8): ordena por DIAS DE COBERTURA crescente (mais urgente
    // primeiro) — unidades enganam (8 a 1/dia duram mais que 10 a 3/dia).
    const comCobertura = [];
    for (const item of lista) {
        let cobertura = null;
        if (item.estoque_atual !== null && item.estoque_atual !== undefined) {
            const { consumoDiario } = await calcularConsumoDiario(item.id);
            cobertura = consumoDiario > 0 ? Math.floor(item.estoque_atual / consumoDiario) : null;
        }
        comCobertura.push({ ...item, _cobertura: cobertura });
    }
    lista = comCobertura.sort((a, b) => {
        if (a._cobertura === null && b._cobertura === null) return String(a.nome).localeCompare(String(b.nome), 'pt-BR');
        if (a._cobertura === null) return 1;
        if (b._cobertura === null) return -1;
        return a._cobertura - b._cobertura;
    });

    const cabecalho = med
        ? `📦 Estoque do *${med.nome}*, ${firstName}:\n\n`
        : `📦 Estoque dos seus remédios, ${firstName}:\n\n`;

    let msg = cabecalho;
    for (const m of lista) {
        // v43 Bloco C Adendo 1 (P49): NULL é "nunca informado", nunca "acabou" —
        // ramo próprio ANTES do `<= 0`, que em JS é `true` para null.
        if (m.estoque_atual === null || m.estoque_atual === undefined) {
            msg += `📦 *${m.nome}* — estoque não informado (me diga quantos você tem e eu acompanho)\n`;
        } else if (m.estoque_atual <= 0) {
            msg += `🚨 *${m.nome}* — sem estoque! Compre com urgência\n`;
        } else if (m.estoque_atual <= m.estoque_minimo) {
            msg += `⚠️ *${m.nome}* — ${m.estoque_atual} unidades (hora de comprar mais!)\n`;
        } else {
            msg += `✅ *${m.nome}* — ${m.estoque_atual} unidades\n`;
        }
    }
    return msg.trim();
}

// ============================================================
// R-004: O QUE TENHO QUE TOMAR AGORA?
// ============================================================

async function relatorioProximoRemedio({ user, message, params }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const { passados, agora, proximos } = await getProximosMedicamentos(user.id);

    if (passados.length === 0 && agora.length === 0 && proximos.length === 0) {
        return `Não encontrei remédios agendados para hoje, ${firstName}. 💊`;
    }

    const med = await resolverMedicamento({
        userId: user.id, message, medicamentoParam: params.medicamento
    });

    const linhaPassado = m => `${m.confirmado ? '✅' : '⚠️'} *${m.nome}* (${m.horario}) — ${m.confirmado ? 'já registrado' : 'não registrado'}`;
    // N-2 (v25): a linha "agora" ignorava m.confirmado e anunciava dose já confirmada como
    // pendente, contradizendo o balanco_do_dia.
    const linhaAgora = m => m.confirmado
        ? `✅ *${m.nome}* (${m.horario}) — já registrado`
        : `💊 *${m.nome}* (${m.horario}) — está na hora de tomar!`;
    const linhaProximo = m => m.confirmado
        ? `✅ *${m.nome}* (${m.horario}) — já registrado`
        : `🔜 *${m.nome}* — próximo às ${m.horario}`;

    // Sem medicamento nomeado: mostra o que ainda importa.
    // N-3 (v25): "quais minhas próximas doses?" devolvia o dia inteiro, incluindo doses já
    // registradas. Passado já confirmado é ruído aqui; passado NÃO confirmado permanece,
    // porque é pendência real.
    if (!med) {
        const passadosPendentes = passados.filter(m => !m.confirmado);
        const agoraRelevantes = agora.filter(m => !m.confirmado);
        const proximosRelevantes = proximos.filter(m => !m.confirmado);

        if (passadosPendentes.length === 0 && agoraRelevantes.length === 0 && proximosRelevantes.length === 0) {
            return `Tudo em ordem por hoje, ${firstName}! Você já registrou todas as doses do dia. ✅`;
        }

        let msg = `⏰ Seus próximos remédios, ${firstName}:\n\n`;
        for (const m of agoraRelevantes) msg += linhaAgora(m) + '\n';
        for (const m of proximosRelevantes) msg += linhaProximo(m) + '\n';

        if (passadosPendentes.length > 0) {
            msg += `\nAinda sem confirmação de hoje:\n\n`;
            for (const m of passadosPendentes) msg += linhaPassado(m) + '\n';
        }
        return msg.trim();
    }

    // Com medicamento nomeado: destaque primeiro, resto como lembrete complementar.
    const ehDoMed = m => m.nome === med.nome;
    const destaqueAgora = agora.filter(ehDoMed);
    const destaqueProximos = proximos.filter(ehDoMed);
    const destaquePassados = passados.filter(ehDoMed);

    let msg = '';
    if (destaqueAgora.length > 0) {
        msg += `⏰ *${med.nome}*, ${firstName}:\n\n`;
        for (const m of destaqueAgora) msg += linhaAgora(m) + '\n';
        for (const m of destaqueProximos) msg += linhaProximo(m) + '\n';
    } else if (destaqueProximos.length > 0) {
        msg += `⏰ Seu próximo *${med.nome}*, ${firstName}:\n\n`;
        msg += linhaProximo(destaqueProximos[0]) + '\n';
        for (const m of destaqueProximos.slice(1)) msg += linhaProximo(m) + '\n';
    } else if (destaquePassados.length > 0) {
        msg += `⏰ *${med.nome}*, ${firstName}:\n\n`;
        for (const m of destaquePassados) msg += linhaPassado(m) + '\n';
        msg += `\nNão há mais doses do ${med.nome} programadas para hoje.\n`;
    } else {
        msg += `Não encontrei doses do *${med.nome}* programadas para hoje, ${firstName}.\n`;
    }

    const outros = [
        ...agora.filter(m => !ehDoMed(m)).map(linhaAgora),
        ...proximos.filter(m => !ehDoMed(m)).map(linhaProximo)
    ];

    if (outros.length > 0) {
        msg += `\nAh, e só pra lembrar — hoje você também tem:\n\n${outros.join('\n')}`;
    }

    return msg.trim();
}

// ============================================================
// R-005 morreu no M3 (P4.4): a adesão reativa (7/15/30) saiu — pedidos de
// adesão caem no PERÍODO LIVRE do balanço (relatorioBalancoPeriodo). O
// cálculo calcularAdesao permanece para o resumo semanal PROATIVO, intocado.
// ============================================================

// ============================================================
// R-006: PROGRESSO DO TRATAMENTO
// ============================================================

function montarBlocoIndividual(p) {
    const fase = escolherFaseProgresso(p.percentualDecorrido);
    const diasCobertosPeloEstoque = Math.floor(p.estoqueAtual / (p.consumoDiario || 1));
    const suficiente = diasCobertosPeloEstoque >= p.diasRestantes;
    const blocoEstoque = montarBlocoEstoque({
        suficiente,
        estoque: p.estoqueAtual,
        diasRestantes: p.diasRestantes,
        diasCobertos: diasCobertosPeloEstoque
    });

    return montarMensagemProgresso({
        medicamento: p.nome,
        diasDecorridos: p.diasDecorridos,
        tratamentoDias: p.tratamentoDias,
        diasRestantes: p.diasRestantes,
        dosesRestantes: p.dosesRestantes,
        blocoEstoque,
        fase
    });
}

async function relatorioProgressoTratamento({ user, message }) {
    const firstName = user.name?.split(' ')[0] || 'você';
    const progressos = await calcularProgressoTratamento(user.id);

    if (progressos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return comSaudacao(user.id, firstName, montarFallbackContinuo());
    }

    if (progressos.length === 1) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return comSaudacao(user.id, firstName, montarBlocoIndividual(progressos[0]));
    }

    // 2+ tratamentos — tenta casar nome mencionado
    const medicationsElegiveis = progressos.map(p => ({ id: p.medicationId, nome: p.nome }));
    const mencionado = encontrarMedicamento(message, medicationsElegiveis);

    if (mencionado) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        const p = progressos.find(x => x.medicationId === mencionado.id);
        return comSaudacao(user.id, firstName, montarBlocoIndividual(p));
    }

    // Pedido genérico ("todos", "tudo", "meu tratamento" sem nome) — resumo compacto
    await saveConversationState(user.id, {
        state: 'aguardando_escolha_tratamento',
        context: { medicationIds: progressos.map(p => p.medicationId) }
    });
    return comSaudacao(user.id, firstName, montarResumoCompacto(progressos));
}

// ============================================================
// RESUMO AUTOMÁTICO — SEMANAL OU FECHAMENTO MENSAL (chamado pelo scheduler)
// ============================================================

// ============================================================
// P5 (M3) — ELEGIBILIDADE DO PROATIVO: função PURA, testável sem LLM
// (asserção determinística A29). Resumo semanal só para quem tem mais
// de 7 dias de Nami; fechamento mensal só para mais de 28. Quem não é
// elegível simplesmente não recebe — sem mensagem substituta.
// ============================================================

export function elegivelParaResumo(user, tipo, hoje = hojeBRT()) {
    const inicio = String(user?.created_at || '').slice(0, 10);
    if (!inicio || !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) return false;
    const diasDeNami = Math.round(
        (Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000
    );
    if (tipo === 'mensal') return diasDeNami > 28;
    return diasDeNami > 7;
}

export async function enviarResumoSemanal(user) {
    try {
        const firstName = user.name?.split(' ')[0] || 'você';

        // P5: sem 7 dias de Nami, nenhum resumo — nem substituto.
        if (!elegivelParaResumo(user, 'semanal')) {
            console.log(`⏭️  Resumo semanal ignorado (usuário com ≤7 dias de Nami): ${user.phone}`);
            return;
        }

        const adesaoEstado = await getAdesaoEstado(user.id);

        // Fechamento mensal só para quem tem mais de 28 dias — antes disso o
        // ciclo fica no semanal (nunca um "mensal" com histórico de dias vazios).
        const isMensal = (!adesaoEstado.ultimo_fechamento_mensal_at ||
            (Date.now() - new Date(adesaoEstado.ultimo_fechamento_mensal_at).getTime()) >= DIAS_FECHAMENTO_MENSAL * 24 * 60 * 60 * 1000)
            && elegivelParaResumo(user, 'mensal');
        const dias = isMensal ? 30 : 7;

        const dados = await calcularAdesao(user.id, dias);
        if (dados.esperado === 0) {
            console.log(`⏭️  Resumo ${isMensal ? 'mensal' : 'semanal'} ignorado (sem doses no período): ${user.phone}`);
            return;
        }

        const faixaNova = escolherFaixa(dados.percentual);
        const mudouDeFaixa = adesaoEstado.faixa_atual !== null && adesaoEstado.faixa_atual !== faixaNova;
        const semanaNova = (adesaoEstado.faixa_atual === null || mudouDeFaixa)
            ? 1
            : (adesaoEstado.semana_atual_na_faixa || 1) + 1;

        let texto = isMensal
            ? montarMensagemMensal({ nome: firstName, taxa: dados.percentual, faixa: faixaNova })
            : montarMensagemSemanal({ nome: firstName, taxa: dados.percentual, faixa: faixaNova, semana: semanaNova });

        // Bloco motivo dominante — só o de maior contagem entre os 3; empate/zerado, omite
        const motivos = ['nao_tomado', 'nao_informado', 'sem_estoque'];
        const motivoDominante = motivos.reduce((maior, atual) =>
            dados.porStatus[atual] > (dados.porStatus[maior] || 0) ? atual : maior, null);

        if (motivoDominante) {
            texto += `\n\n${montarBlocoMotivo(motivoDominante)}`;

            // Turno — só no fechamento mensal, só para nao_tomado/nao_informado
            if (isMensal && motivoDominante !== 'sem_estoque' && dados.diagnosticoPorTurno) {
                const turno = dados.diagnosticoPorTurno[motivoDominante];
                if (turno) texto += `\n\n${montarBlocoTurno(turno)}`;
            }
        }

        // Bloco tendência — compara com o envio automático anterior
        if (adesaoEstado.percentual_ultimo_envio !== null && adesaoEstado.percentual_ultimo_envio !== undefined) {
            const diff = dados.percentual - adesaoEstado.percentual_ultimo_envio;
            const tipoTendencia = diff > 5 ? 'subiu' : diff < -5 ? 'caiu' : 'estavel';
            texto += `\n\n${montarBlocoTendencia(tipoTendencia, {
                taxaAnterior: adesaoEstado.percentual_ultimo_envio,
                taxaAtual: dados.percentual
            })}`;
        }

        // Bloco marco — primeira vez alcançando 100%
        const melhorAnterior = adesaoEstado.melhor_faixa_atingida;
        if (faixaNova === '100' && melhorAnterior !== '100') {
            texto += `\n\n${montarBlocoMarco()}`;
        }

        await enviarAoUsuario({
            phone: user.phone,
            userId: user.id,
            texto,
            origem: 'proativo:resumo_semanal'
        });
        await registrarEventoProativo({
            userId: user.id,
            tipo: 'resumo_semanal'
        });

        const melhorFaixaNova = (!melhorAnterior || RANKING_FAIXA[faixaNova] > RANKING_FAIXA[melhorAnterior])
            ? faixaNova
            : melhorAnterior;

        await upsertAdesaoEstado(user.id, {
            faixa_atual: faixaNova,
            percentual_ultimo_envio: dados.percentual,
            semana_atual_na_faixa: semanaNova,
            melhor_faixa_atingida: melhorFaixaNova,
            ultimo_fechamento_mensal_at: isMensal ? new Date().toISOString() : adesaoEstado.ultimo_fechamento_mensal_at
        });

        console.log(`📊 Resumo ${isMensal ? 'mensal' : 'semanal'} enviado para ${user.phone} (faixa: ${faixaNova}, ${dados.percentual}%)`);

    } catch (error) {
        console.error(`❌ Erro ao enviar resumo semanal para ${user.phone}:`, error.message);
    }
}
