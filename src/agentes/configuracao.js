import 'dotenv/config';
import {
    saveConversationState,
    getUserMedications,
    pausarMedicamento,
    encerrarTratamento,
    alterarHorarioSchedule,
    reativarComAtualizacao,
    removerSchedule,
    adicionarSchedule,
    formatarHistoricoConversa,
    getMedicationComSchedulesAtivos,
    atualizarQuantidadePorDose,
    registrarMovimentoEstoque,
    verificarMedicamentoExistente
} from '../database.js';
import { isCancelamento, encontrarMedicamento, encontrarTodosMedicamentos, normalizar } from '../nlp_helpers.js';
import { classificarComFerramenta } from '../validadores/llm.js';
import { AINDA_NAO, respostaHonestaAindaNao } from '../inventario.js';
import { executarCorrecao, executarCorrecaoPerfil, iniciarCadastroComNome } from '../runner.js';
import { extrairHorariosCitados, interpretarRecorrencia } from '../validadores/recorrencia.js';
import { classificarPosologia } from '../validadores/posologia.js';
import { validarEstoque, subEtapaEstoque, calcularAlertaEstoqueCadastro } from '../validadores/estoque.js';
import {
    ACOES_DE_FALHA, renderizarPerguntaEstoque, renderizarFechamentoEstoque,
    renderizarBloqueioRecorrencia, renderizarFotoComManterOuMudar,
    renderizarPerguntaOQueMudar, renderizarReativacaoConcluida,
    renderizarAvisoJaExiste, paresCongelados
} from '../schemas/cadastro.js';

// v44 §5.9: a fatia relevante para este agente deixou de ser posicional
// (slice(0, 3)) e passou a ser declarada no próprio inventário (escopo:
// 'configuracao'). No M3 P2 a edição de nome/dosagem/quantidade/duração/
// estoque virou capacidade (modo correção do runner) — o que resta no
// escopo é o reagendamento pontual (MH-27, honestidade).
const NAO_SUPORTADO_CONFIGURACAO = AINDA_NAO
    .filter(i => i.escopo === 'configuracao')
    .map(i => i.rotulo);

// Mapa ação → campo do modo correção do runner (P2).
const CAMPO_DA_ACAO_CORRIGIR = {
    corrigir_nome: 'nome',
    corrigir_dosagem: 'dosagem',
    corrigir_quantidade: 'quantidade',
    corrigir_duracao: 'duracao',
    corrigir_estoque: 'estoque'
};

// ============================================================
// REATIVAÇÃO EM 5 PASSOS (M3 P3): foto congelada → manter/mudar →
// alterações via P2 → confirmação declarando os horários vigentes →
// convite de estoque no MESMO template do cadastro.
// ============================================================

// Porta 2 (também usada por "reativar X" quando X foi encerrado): aviso +
// foto + oferta reativar/recadastrar (BUG-61).
async function oferecerReativacaoPorta2({ user, medicationId, statusAnterior }) {
    const medCompleto = await getMedicationComSchedulesAtivos(medicationId);
    const pares = paresCongelados(medCompleto);
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'reativ_oferta', medicationId, medicationNome: medCompleto.nome, statusAnterior }
    });
    return renderizarAvisoJaExiste({ med: medCompleto, pares, statusAnterior });
}

// Passos 1+2 (porta 1): foto congelada + "manter assim ou mudar algo?".
async function iniciarReativacao({ user, med }) {
    const medCompleto = await getMedicationComSchedulesAtivos(med.id);
    const pares = paresCongelados(medCompleto);
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'reativ_manter_ou_mudar', medicationId: med.id, medicationNome: medCompleto.nome }
    });
    return renderizarFotoComManterOuMudar({ med: medCompleto, pares });
}

// Passos 4+5: reativa (com ou sem alterações), DECLARA os horários vigentes
// (pós-escrita) e convida o estoque com o template do cadastro.
async function concluirReativacao({ user, firstName, medicationId, horariosNovos = null, diasPorHorario = null, quantidadeUnica = null, paresQuantidade = null }) {
    const medAntes = await getMedicationComSchedulesAtivos(medicationId);
    const grade = (horariosNovos && horariosNovos.length > 0)
        ? horariosNovos
        : paresCongelados(medAntes).map(p => p.horario);

    await reativarComAtualizacao({ medicationId, horarios: grade, apenasHorarios: true, diasPorHorario });
    if (quantidadeUnica !== null || (paresQuantidade && paresQuantidade.length > 0)) {
        await atualizarQuantidadePorDose(medicationId, { pares: paresQuantidade, quantidadeUnica });
    }

    const depois = await getMedicationComSchedulesAtivos(medicationId);
    const pares = depois.schedulesAtivos
        .map(s => ({
            horario: String(s.horario).slice(0, 5),
            quantidade: Number(s.quantidade_por_dose),
            dias_semana: s.dias_semana ?? null,
            intervalo_dias: s.intervalo_dias ?? null
        }))
        .sort((a, b) => a.horario.localeCompare(b.horario));

    await saveConversationState(user.id, {
        state: 'configurando',
        context: { etapa: 'reativ_estoque_convite', medicationId, medicationNome: depois.nome, camposEstoque: {} }
    });
    console.log(`▶️ [P3] Reativação concluída — ${depois.nome} (${pares.map(p => p.horario).join(', ')}) — ${user.phone}`);

    const camposConvite = { nome: depois.nome, unidade_dose: depois.unidade_dose, unidade_estoque: depois.unidade_estoque };
    return `${renderizarReativacaoConcluida({ med: depois, pares, firstName })}\n\n${renderizarPerguntaEstoque('cad_estoque', camposConvite)}`;
}

// Passos 2/3: interpreta a resposta ao "manter ou mudar" — manter reativa a
// grade congelada; horários/quantidade ditos são a alteração via P2.
async function tratarManterOuMudar({ user, firstName, message, context, medicationsAtivos, historicoConversa }) {
    if (isCancelamentoGenuino(message, medicationsAtivos)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! O *${context.medicationNome}* segue como estava. Se precisar, é só me chamar 🌿`;
    }

    // Alteração de horários dita na resposta (com recorrência do M2).
    const estrutura = interpretarRecorrencia(message);
    if (estrutura && !estrutura.suportada) {
        return renderizarBloqueioRecorrencia(extrairHorariosCitados(message), estrutura.padroes);
    }
    // Replay 20/09 ("Vou tomar 5gr as 10 e as 20hrs"): "às N" sem sufixo
    // também é horário — o número precedido de "às/as" nunca é quantidade.
    const horariosComPreposicao = [...String(message).matchAll(/\b[àa]s?\s+(\d{1,2})\b(?!\s*(?:mg|mcg|gr?s?|ml|cps?|comprimidos?|c[áa]psulas?|gotas?|unidades?|dias?)\b)(?!\s*[:h])/gi)]
        .map(m => `${String(m[1]).padStart(2, '0')}:00`)
        .filter(h => Number(h.slice(0, 2)) <= 23);
    const horariosNovos = estrutura?.diasPorHorario
        ? Object.keys(estrutura.diasPorHorario)
        : [...new Set([...extrairHorariosCitados(message), ...horariosComPreposicao])].sort();
    if (horariosNovos.length > 0) {
        return await concluirReativacao({
            user, firstName, medicationId: context.medicationId,
            horariosNovos, diasPorHorario: estrutura?.diasPorHorario ?? null
        });
    }

    // "Manter"/"assim"/confirmação curta = reativar a grade congelada
    // (BUG-36 morre aqui: "manter horários"/"manter" é confirmação de manutenção).
    const msg = message.toLowerCase();
    if (isConfirmacao(message) || /\bmanter\b|\bassim\b|\bcomo estava\b|\bigual\b|\bmesmos?\b/.test(msg)) {
        return await concluirReativacao({ user, firstName, medicationId: context.medicationId });
    }

    // Quantidade dita na resposta ("2 comprimidos agora").
    if (/\d/.test(message) || /\bmeio\b|\bmetade\b/.test(msg)) {
        const cls = await classificarPosologia({
            message, campoEsperado: 'quantidade', nomeMedicamento: context.medicationNome,
            horariosJaColetados: [], historicoConversa
        });
        if (cls.quantidadeUnica || (cls.pares || []).length > 0) {
            return await concluirReativacao({
                user, firstName, medicationId: context.medicationId,
                quantidadeUnica: cls.quantidadeUnica ?? null,
                paresQuantidade: (cls.pares || []).length > 0 ? cls.pares : null
            });
        }
    }

    // "Mudar" sem dizer o quê: pergunta o alvo (uma pergunta, última linha).
    if (/\bmudar\b|\btrocar\b|\balterar\b|\bajustar\b/.test(msg)) {
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { ...context, etapa: 'reativ_manter_ou_mudar' }
        });
        return renderizarPerguntaOQueMudar(context.medicationNome);
    }

    return { escalarParaRoteador: true };
}

// ============================================================
// CLASSIFICAÇÃO VIA CLAUDE — única chamada LLM do agente
// ============================================================

const ACOES_CONFIGURACAO = [
    'pausar', 'reativar', 'encerrar', 'alterar_horario', 'remover_horario',
    'adicionar_horario', 'redefinir_horarios', 'esclarecer_pausar_encerrar',
    'recusa_opcoes_oferecidas',
    // M3 P2: edição via modo correção do runner.
    'corrigir_nome', 'corrigir_dosagem', 'corrigir_quantidade',
    'corrigir_duracao', 'corrigir_estoque', 'corrigir_dados_pessoais',
    // MH-27 (P6.7): reconhecido para responder com honestidade.
    'reagendar_dose_pontual',
    'nao_suportado'
];

async function classificarIntencao(message, medicamentosDisponiveis, historicoConversa = []) {
    const listaMeds = medicamentosDisponiveis.map(m => m.nome).join(', ') || 'nenhum';
    const historicoTexto = formatarHistoricoConversa(historicoConversa);

    const systemPrompt = `Você é um classificador de intenções para um assistente de saúde.
O usuário quer fazer algo com seus lembretes ou tratamentos.

Medicamentos cadastrados: ${listaMeds}

CONVERSA RECENTE:
${historicoTexto}

Registre a classificação pela ferramenta registrar_intencao:
- acao: uma das ações definidas abaixo
- medicamentoMencionado: nome mencionado (vazio se nenhum)
- novoHorario: HH:MM (vazio se não houver)

Definições:
- pausar: parar lembretes temporariamente, com intenção de retomar.
  Ex: "cancela o lembrete", "para de me lembrar", "quero pausar", "suspender os avisos", "para essa semana", "não quero ser lembrado por uns dias"

- reativar: ativar lembretes pausados.
  Ex: "volta os lembretes", "ativa de novo", "reativar", "quero retomar"

- encerrar: terminar o tratamento definitivamente.
  Ex: "não vou mais tomar", "encerrar", "encerrar tratamento", "terminei o tratamento", "já acabei de tomar esse", "não preciso mais desse remédio porque terminei"

- alterar_horario: mudar UM horário específico para outro — com ou sem horário explícito.
  Ex com horário: "muda das 8 para 9", "trocar o das 20h para 22h"
  Ex sem horário: "quero alterar horário", "mudar horário", "trocar horário"

- remover_horario: apagar um horário específico sem substituir — com ou sem horário explícito.
  Ex com horário: "tirar o das 8h", "apagar o das 20"
  Ex sem horário: "quero remover um horário", "excluir um lembrete"

- adicionar_horario: acrescentar horário novo sem mexer nos existentes — com ou sem horário explícito.
  Ex com horário: "quero tomar às 20 também", "adicionar lembrete às 14h"
  Ex sem horário: "quero adicionar um horário", "incluir mais um lembrete"

- redefinir_horarios: substituir TODOS os horários ou mudar a frequência de doses.
  Ex: "agora vou tomar 3x ao dia", "mudar para 6h, 14h e 22h", "mudar todos os horários"

- esclarecer_pausar_encerrar: USAR APENAS quando o usuário quer parar de tomar/ser lembrado, mas NÃO dá nenhuma pista se é TEMPORÁRIO (pausar) ou DEFINITIVO (encerrar).
  Ex: "quero parar com o losartana", "cancela o dipirona", "não quero mais esse remédio" (sem dizer se terminou ou se é pausa)

- recusa_opcoes_oferecidas: USAR quando a ÚLTIMA mensagem da Nami (ver CONVERSA RECENTE) apresentou
  uma lista de opções para escolher — pode ser medicamentos, horários, ou a escolha entre pausar/
  encerrar/contínuo/temporário — e a resposta do usuário rejeita TODAS essas opções sem mencionar
  nenhum assunto novo.
  Ex: "nenhum", "nenhuma", "nenhum dos dois", "nenhuma das opções", "nenhum desses", "nem um nem outro".

- corrigir_nome: corrigir/trocar o NOME de um medicamento já cadastrado (digitou errado).
  Ex: "o nome tá errado, é Keppra", "troca o nome do Kepra", "escrevi o nome errado"

- corrigir_dosagem: alterar a DOSAGEM (concentração do produto) de um medicamento já cadastrado.
  Ex: "a dosagem é 50mg, não 25", "mudou a dosagem do meu remédio", "agora é de 100mg"

- corrigir_quantidade: alterar a QUANTIDADE POR DOSE (quanto se toma de cada vez).
  Ex: "agora tomo 2 comprimidos", "na verdade são 20 gotas por vez", "passei a tomar meio"

- corrigir_duracao: alterar a DURAÇÃO do tratamento (encurtar/prolongar/virar contínuo).
  Ex: "mudar de 7 para 10 dias", "o médico estendeu por mais uma semana", "virou uso contínuo"

- corrigir_estoque: corrigir/atualizar a quantidade em ESTOQUE de um medicamento.
  Ex: "o estoque tá errado, tenho 20", "atualiza o estoque do Marevan pra 30"

- corrigir_dados_pessoais: corrigir dados DA PESSOA (nome do usuário ou data de nascimento) —
  nunca do remédio. Ex: "meu nome tá errado", "quero corrigir minha data de nascimento",
  "me cadastrei com o nome errado"

- reagendar_dose_pontual: ajustar o horário de UMA dose só de hoje/desta vez, SEM mudar o
  horário fixo. Ex: "hoje vou tomar mais tarde", "só hoje pode ser às 15h?", "adia a dose de hoje"

- nao_suportado: pedidos que a configuração não faz — ${NAO_SUPORTADO_CONFIGURACAO.join(', ') || 'fora das ações acima'}.
  Ex: "exportar meu histórico", "conectar minha filha"

REGRAS DE DECISÃO:
1. Se o verbo é claro (encerrar, pausar, alterar, remover, adicionar, redefinir, reativar, corrigir) → retorne a ação diretamente. NUNCA use esclarecer nesses casos.
2. "Encerrar" sozinho = encerrar. "Pausar" sozinho = pausar. Não exija a palavra "tratamento".
3. Se o usuário quer parar MAS dá pista temporal:
   - pista de definitivo ("já terminei", "acabou", "não preciso mais porque terminei") → encerrar
   - pista de temporário ("essa semana", "por uns dias", "por enquanto") → pausar
4. Só use esclarecer_pausar_encerrar quando quer parar e NÃO há nenhuma pista temporal.
5. Intenção de horário sem detalhes → classifique pelo tipo de operação, nunca esclarecer.
6. Alterar o horário FIXO do lembrete = alterar_horario/redefinir_horarios; ajustar só a dose de
   HOJE = reagendar_dose_pontual.
7. Se a última pergunta da Nami ofereceu uma lista de opções (medicamentos, horários, ou
   pausar/encerrar/contínuo/temporário) e a resposta rejeita todas sem introduzir assunto novo
   → recusa_opcoes_oferecidas. NUNCA confunda com reafirmar a ação anterior.`;

    // v44 M3 P6.2: tool-use com schema — mesmo padrão da porta (1 retry +
    // degradar). O prompt de classificação não mudou.
    const { parsed } = await classificarComFerramenta({
        systemPrompt,
        message,
        maxTokens: 200,
        nomeFerramenta: 'registrar_intencao',
        descricaoFerramenta: 'Registra a intenção de configuração classificada.',
        schema: {
            type: 'object',
            properties: {
                acao: { type: 'string', enum: ACOES_CONFIGURACAO },
                medicamentoMencionado: { type: 'string', description: 'Nome mencionado, exatamente como escrito. String vazia se nenhum.' },
                novoHorario: { type: 'string', description: 'HH:MM. String vazia se não houver.' }
            },
            required: ['acao']
        },
        validar: (input) => ACOES_CONFIGURACAO.includes(input?.acao),
        motivo: 'classificacao_falhou',
        agent: 'configuracao',
        origem: 'configuracao',
        fallback: { acao: 'esclarecer_pausar_encerrar', medicamentoMencionado: null, novoHorario: null }
    });

    const limpar = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    const resultado = {
        acao: parsed?.acao ?? 'esclarecer_pausar_encerrar',
        medicamentoMencionado: limpar(parsed?.medicamentoMencionado),
        novoHorario: limpar(parsed?.novoHorario)
    };
    console.log(`⚙️ Intenção classificada: ${JSON.stringify(resultado)}`);
    return resultado;
}

// ============================================================
// HELPERS DETERMINÍSTICOS
// ============================================================

function extrairHorarioOrigem(message) {
    const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (!matches.length) return null;
    const m = matches[0];
    return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

function extrairHorarioDestino(message) {
    const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (!matches.length) return null;
    const m = matches[matches.length - 1];
    return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

// Números por extenso mais comuns em pt-BR para horários (0-20). "vinte e X"
// tratado à parte pra não quebrar em "vinte" + "e" + "x" separadamente.
const NUMERO_POR_EXTENSO = {
    'zero': 0, 'uma': 1, 'um': 1, 'duas': 2, 'dois': 2, 'três': 3, 'tres': 3,
    'quatro': 4, 'cinco': 5, 'seis': 6, 'sete': 7, 'oito': 8, 'nove': 9,
    'dez': 10, 'onze': 11, 'doze': 12, 'treze': 13, 'catorze': 14, 'quatorze': 14,
    'quinze': 15, 'dezesseis': 16, 'dezessete': 17, 'dezoito': 18, 'dezenove': 19,
    'vinte': 20
};
const VINTE_E_ALGO = { 'um': 21, 'uma': 21, 'dois': 22, 'duas': 22, 'três': 23, 'tres': 23 };

// Converte números por extenso presentes na mensagem para dígitos, preservando
// o resto do texto — as camadas de regex existentes (dígito, "h", período do
// dia) passam a funcionar sem duplicar lógica nenhuma.
function converterNumerosPorExtenso(mensagem) {
    let resultado = mensagem.replace(/vinte\s+e\s+(um|uma|dois|duas|tr[êe]s)/gi,
        (_, palavra) => String(VINTE_E_ALGO[palavra.toLowerCase()]));
    for (const [palavra, numero] of Object.entries(NUMERO_POR_EXTENSO)) {
        resultado = resultado.replace(new RegExp(`\\b${palavra}\\b`, 'gi'), String(numero));
    }
    return resultado;
}

// Converte linguagem natural em HH:MM sem depender de lista de schedules.
// Usado em obter_horario (adicionar novo horário) onde o horário não existe ainda.
function interpretarHorarioLivre(message) {
    message = converterNumerosPorExtenso(message);
    const msg = message.toLowerCase().trim();

    // 1. Formato numérico explícito (HH:MM ou HHhMM) — pega o último (destino)
    const matchesNumericos = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (matchesNumericos.length > 0) {
        const m = matchesNumericos[matchesNumericos.length - 1];
        let hora = parseInt(m[1]);
        const min = m[2] || '00';
        if (/(da\s*tarde|da\s*noite|de\s*noite|pm)/i.test(msg) && hora < 12) hora += 12;
        if (hora >= 0 && hora <= 23) {
            return `${String(hora).padStart(2, '0')}:${min.padStart(2, '0')}`;
        }
    }

    // 2. Número isolado com período (ex: "3 da tarde", "8 da noite", "9 da manhã")
    const matchPeriodo = msg.match(/(\d{1,2})\s*(da\s*manh[aã]|de\s*manh[aã]|da\s*tarde|da\s*noite|de\s*noite|am|pm)/i);
    if (matchPeriodo) {
        let hora = parseInt(matchPeriodo[1]);
        const periodo = matchPeriodo[2].toLowerCase();
        const ehTardeNoite = /tarde|noite|pm/.test(periodo);
        if (ehTardeNoite && hora < 12) hora += 12;
        if (/manh[aã]|am/.test(periodo) && hora === 12) hora = 0;
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    // 3. Número com "h" isolado (ex: "14h", "8h")
    const matchHora = msg.match(/(\d{1,2})\s*h(?:oras?)?$/i);
    if (matchHora) {
        const hora = parseInt(matchHora[1]);
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    // 4. Número puro isolado (ex: "15", "8") — assume 24h
    const matchIsolado = msg.match(/^(\d{1,2})$/);
    if (matchIsolado) {
        const hora = parseInt(matchIsolado[1]);
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    // 5. Expressões nomeadas
    if (/meio.?dia/i.test(msg)) return '12:00';
    if (/meia.?noite/i.test(msg)) return '00:00';

    // 6. BUG-085: número solto embutido numa frase, sem ":"/"h"/período do dia
    // — pega o último (mesma convenção de destino das camadas anteriores).
    const numerosSoltos = [...msg.matchAll(/\b(\d{1,2})\b/g)];
    if (numerosSoltos.length > 0) {
        const hora = parseInt(numerosSoltos[numerosSoltos.length - 1][1]);
        if (hora >= 0 && hora <= 23) return `${String(hora).padStart(2, '0')}:00`;
    }

    return null;
}

function normalizarHorario(message, schedulesDisponiveis) {
    message = converterNumerosPorExtenso(message);
    const msg = message.toLowerCase().trim();

    // 1. Regex numérico (HH:MM ou HHhMM)
    const matchesNumericos = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)];
    if (matchesNumericos.length > 0) {
        const m = matchesNumericos[0];
        const horarioExtraido = `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
        const scheduleExato = schedulesDisponiveis.find(s => s.horario.startsWith(horarioExtraido));
        if (scheduleExato) return horarioExtraido;
        const horaSo = m[1].padStart(2, '0');
        const schedulePorHora = schedulesDisponiveis.find(s => s.horario.startsWith(horaSo + ':'));
        if (schedulePorHora) return schedulePorHora.horario.substring(0, 5);
    }

    // 2. Número isolado ("8", "20")
    const matchNumeroIsolado = msg.match(/^(\d{1,2})$/);
    if (matchNumeroIsolado) {
        const hora = matchNumeroIsolado[1].padStart(2, '0');
        const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(hora + ':'));
        if (schedule) return schedule.horario.substring(0, 5);
    }

    // 3. Períodos do dia com número
    const periodos = [
        { pattern: /(\d{1,2})\s*(da\s*manhã|de\s*manhã|am)/i, periodo: 'manha' },
        { pattern: /(\d{1,2})\s*(da\s*tarde|da\s*noite|pm|de\s*noite)/i, periodo: 'tarde_noite' },
        { pattern: /(\d{1,2})\s*h/i, periodo: null }
    ];

    for (const { pattern, periodo } of periodos) {
        const match = msg.match(pattern);
        if (match) {
            let hora = parseInt(match[1]);
            if (periodo === 'tarde_noite' && hora < 12) hora += 12;
            const horaStr = String(hora).padStart(2, '0');
            const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(horaStr + ':'));
            if (schedule) return schedule.horario.substring(0, 5);
        }
    }

    // 4. Expressões sem número
    const expressoes = {
        'meio.?dia': '12',
        'meia.?noite': '00',
        'meio da manhã': '06'
    };
    for (const [expr, hora] of Object.entries(expressoes)) {
        if (new RegExp(expr, 'i').test(msg)) {
            const schedule = schedulesDisponiveis.find(s => s.horario.startsWith(hora + ':'));
            if (schedule) return schedule.horario.substring(0, 5);
        }
    }

    // 4. BUG-085: número solto embutido numa frase (ex: "mudar das 11 para as
    // 10"), sem ":"/"h" nem período do dia. Pega o primeiro número (mesma
    // convenção de origem da camada 1), só como último recurso.
    const numerosSoltos = [...msg.matchAll(/\b(\d{1,2})\b/g)];
    if (numerosSoltos.length > 0) {
        const horaSolta = numerosSoltos[0][1].padStart(2, '0');
        const scheduleSolto = schedulesDisponiveis.find(s => s.horario.startsWith(horaSolta + ':'));
        if (scheduleSolto) return scheduleSolto.horario.substring(0, 5);
    }

    return null;
}

function sobrouConteudoAlemDoNome(message, medNome) {
    const semPontuacao = (s) => s.replace(/[^\w\s]/g, '').trim();
    const restante = semPontuacao(normalizar(message))
        .replace(semPontuacao(normalizar(medNome)), '')
        .replace(/\s+/g, ' ')
        .trim();
    return restante.length > 0;
}

// "Parar a dipirona" cita um remédio — isso é intenção de encerrar tratamento,
// não desistência da operação. Só aceita como cancelamento puro quando a
// mensagem não menciona nenhum medicamento conhecido.
function isCancelamentoGenuino(message, medicationsAtivos) {
    return isCancelamento(message) && !encontrarMedicamento(message, medicationsAtivos);
}

function isConfirmacao(message) {
    const msg = message.toLowerCase().trim();
    const termos = ['sim', 's', 'ok', 'pode', 'claro', 'confirmar', 'confirmo', 'vai', 'vamos', 'isso'];
    return termos.some(t => msg === t || msg.startsWith(t + ' '));
}

function formatarHorarios(schedules) {
    return (schedules || [])
        .filter(s => s.ativo)
        .map(s => s.horario.substring(0, 5))
        .join(' e ');
}

// ============================================================
// MENSAGENS DE CONFIRMAÇÃO
// ============================================================

function buildConfirmacaoMessage(firstName, ctx) {
    const { acao, medicationNome, schedulesAtivos, novoHorario, horarioAtual, novosHorarios } = ctx;
    const horarios = formatarHorarios(schedulesAtivos);

    switch (acao) {
        case 'pausar':
            return `Só confirmar, ${firstName}: vou *pausar* todos os lembretes do *${medicationNome}*${horarios ? ` (${horarios})` : ''}.\n\nVocê pode reativar quando quiser. Confirmar?`;
        case 'encerrar':
            return `Só confirmar: vou *encerrar o tratamento* com *${medicationNome}* e desativar todos os lembretes permanentemente.\n\nConfirmar?`;
        case 'alterar_horario':
            return `Só confirmar: vou mudar o lembrete${horarioAtual ? ` das *${horarioAtual.substring(0,5)}*` : ''} do *${medicationNome}* para *${novoHorario}*.\n\nConfirmar?`;
        case 'remover_horario':
            return `Só confirmar, ${firstName}: vou *remover* o lembrete das *${horarioAtual ? horarioAtual.substring(0,5) : '?'}* do *${medicationNome}* permanentemente.\n\nConfirmar?`;
        case 'adicionar_horario':
            return `Só confirmar, ${firstName}: vou *adicionar* um lembrete às *${novoHorario}* para o *${medicationNome}*.\n\nConfirmar?`;
        case 'redefinir_horarios': {
            const listaHorarios = (novosHorarios || []).join(', ');
            return `Só confirmar, ${firstName}: vou *substituir todos os horários* do *${medicationNome}*.\n\nNovos horários: *${listaHorarios}*\n\nConfirmar?`;
        }
        default:
            return 'Confirmar a alteração?';
    }
}

// ============================================================
// EXECUÇÃO DA AÇÃO
// ============================================================

async function executarAcao(user, firstName, ctx) {
    const { acao, medicationId, medicationNome, scheduleId, novoHorario, horarioAtual, schedulesAtivos, novosHorarios } = ctx;
    const horarios = formatarHorarios(schedulesAtivos);

    switch (acao) {
        case 'pausar':
            await saveConversationState(user.id, { state: 'idle', context: {} });
            await pausarMedicamento(medicationId);
            return `✅ Pronto, ${firstName}! Lembretes do *${medicationNome}*${horarios ? ` (${horarios})` : ''} pausados.\n\nQuando quiser retomar, é só me dizer *"reativar ${medicationNome}"* 🌿`;

        case 'encerrar':
            await saveConversationState(user.id, { state: 'idle', context: {} });
            await encerrarTratamento(medicationId);
            return `✅ Tratamento com *${medicationNome}* encerrado. Os lembretes foram desativados 🌿\n\nSe precisar cadastrar novamente no futuro, é só me chamar!`;

        case 'alterar_horario': {
            await alterarHorarioSchedule(scheduleId, novoHorario);

            const remainingSchedules = (schedulesAtivos || []).filter(s => s.id !== scheduleId);

            if (remainingSchedules.length > 0) {
                const lista = remainingSchedules.map(s => `• ${s.horario.substring(0, 5)}`).join('\n');
                const plural = remainingSchedules.length > 1 ? 's' : '';

                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: {
                        etapa: 'pos_alteracao',
                        acao: 'alterar_horario',
                        medicationId,
                        medicationNome,
                        schedulesAtivos: remainingSchedules
                    }
                });

                return `✅ Pronto! Lembrete das *${horarioAtual ? horarioAtual.substring(0, 5) : '?'}* do *${medicationNome}* atualizado para *${novoHorario}* ⏰\n\nVocê ainda tem lembrete${plural} cadastrado${plural} para esse medicamento:\n${lista}\n\nQuer alterar algum?`;
            }

            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `✅ Pronto! Seu lembrete do *${medicationNome}* foi atualizado para *${novoHorario}* ⏰`;
        }

        case 'remover_horario': {
            await removerSchedule(scheduleId, medicationId, horarioAtual);
            const remainingSchedules = (schedulesAtivos || []).filter(s => s.id !== scheduleId);
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `✅ Pronto, ${firstName}! Lembrete das *${horarioAtual ? horarioAtual.substring(0,5) : '?'}* do *${medicationNome}* removido.\n\n${remainingSchedules.length > 0
                ? `Você ainda tem lembrete${remainingSchedules.length > 1 ? 's' : ''} às ${remainingSchedules.map(s => s.horario.substring(0,5)).join(' e ')} para esse medicamento.`
                : ''}`;
        }

        case 'adicionar_horario': {
            try {
                await adicionarSchedule(medicationId, novoHorario);
                await saveConversationState(user.id, { state: 'idle', context: {} });
                const todosHorarios = [...(schedulesAtivos || []).map(s => s.horario.substring(0,5)), novoHorario]
                    .sort()
                    .join(', ');
                return `✅ Pronto, ${firstName}! Adicionei um lembrete às *${novoHorario}* para o *${medicationNome}* 💊\n\nAgora você tem lembretes às: ${todosHorarios}`;
            } catch (e) {
                if (e.message.startsWith('HORARIO_DUPLICADO')) {
                    await saveConversationState(user.id, { state: 'idle', context: {} });
                    return `O *${medicationNome}* já tem um lembrete às *${novoHorario}*. Nada foi alterado 🌿`;
                }
                throw e;
            }
        }

        case 'redefinir_horarios': {
            await reativarComAtualizacao({
                medicationId,
                estoque: null,
                tipo_tratamento: null,
                tratamento_dias: null,
                horarios: novosHorarios,
                apenasHorarios: true
            });
            const horariosLabel = (novosHorarios || []).sort().join(', ');
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `✅ Pronto, ${firstName}! Horários do *${medicationNome}* atualizados 💊\n\nNovos lembretes: ${horariosLabel}`;
        }

        default:
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Ih, me perdi aqui e não consegui fazer o ajuste. 😅 Pode me dizer de novo o que você quer mudar?`;
    }
}

// ── HELPER: classifica a intenção da mensagem atual (via classificarIntencao)
// e decide o próximo passo — usado pela entrada fresca em identif_intencao E
// por qualquer outra etapa que precise reconfirmar se a intenção mudou.
async function processarIntencaoOuEscalar({ user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa, context }) {
    if (context.medicationId && isCancelamentoGenuino(message, medicationsAtivos)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }
    // MH-51 (M3 P6.6): pergunta de esclarecimento no meio do fluxo é DÚVIDA —
    // responde (a lista real) e retoma, nunca repete a mesma pergunta como se
    // fosse ruído.
    const ehPerguntaDeQualMedicamento = /\?\s*$/.test(message.trim())
        && /\bqua(l|is)\b/i.test(message)
        && /medicamento|rem[eé]dio/i.test(message)
        && !encontrarMedicamento(message, medicationsAtivos);
    if (ehPerguntaDeQualMedicamento && medicationsAtivos.length > 0) {
        const lista = medicationsAtivos.map(m => `• *${m.nome}*`).join('\n');
        const retomada = context.medicationNome && context.medicationNome !== 'esse medicamento'
            ? `A gente estava falando do *${context.medicationNome}* — quer seguir com ele?`
            : 'Sobre qual deles você quer falar?';
        console.log(`❓ [MH-51] Dúvida de esclarecimento respondida com a lista — ${user.phone}`);
        return `Claro! Seus medicamentos cadastrados são:\n\n${lista}\n\n${retomada}`;
    }

    const { acao, medicamentoMencionado, novoHorario } = await classificarIntencao(message, medicationsAtivos, historicoConversa);

    // MH-75 (P2): dados pessoais não dependem de medicamento cadastrado.
    if (acao === 'corrigir_dados_pessoais') {
        return await executarCorrecaoPerfil({ user, message, historicoConversa });
    }

    // MH-27 (P6.7): reagendar UMA dose pontual segue AINDA_NAO — honestidade
    // com expectativa + o que já existe hoje.
    if (acao === 'reagendar_dose_pontual') {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `${respostaHonestaAindaNao('reagendar_dose_pontual')}\n\nO que já dá pra fazer: mudar o horário fixo do lembrete (vale pra todos os dias), ou tomar quando der e me confirmar depois — eu registro certinho. 🌿`;
    }

    if (medicationsAtivos.length === 0) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Você não tem nenhum medicamento cadastrado ainda, ${firstName}. Quer cadastrar um agora?`;
    }

    // Rede de segurança do classificador interno — não decide mais sozinho se é
    // "não suportado de verdade" ou "suportado por outro agente". Escala pro
    // classificador central em vez de responder direto.
    if (acao === 'nao_suportado') {
        return { escalarParaRoteador: true };
    }

    if (acao === 'recusa_opcoes_oferecidas') {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
    }

    // Intenção de parar sem pista temporal → perguntar se quer pausar ou encerrar
    if (acao === 'esclarecer_pausar_encerrar') {
        const medNaMensagemAtual = encontrarMedicamento(message, medicationsAtivos);
        const med = medNaMensagemAtual
            || (context.medicationId ? medicationsAtivos.find(m => m.id === context.medicationId) : null)
            || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);
        const nomeExibir = med?.nome || medicamentoMencionado || context.medicationNome || 'esse medicamento';
        await saveConversationState(user.id, {
            state: 'configurando',
            context: {
                etapa: 'identif_intencao',
                medicationId: med?.id || null,
                medicationNome: nomeExibir,
                schedulesAtivos: med ? (med.schedules || []).filter(s => s.ativo) : []
            }
        });
        return `Entendido, ${firstName}! Sobre o *${nomeExibir}*, você quer:\n\n• *Pausar* os lembretes (temporário — pode retomar depois)\n• *Encerrar* o tratamento definitivamente\n\nO que prefere?`;
    }

    // P6.4 (M3, MH-82/39): "encerrar todos" / seleção múltipla → UMA
    // confirmação agregada (vale também para pausar — mesmo mecanismo).
    if (acao === 'encerrar' || acao === 'pausar') {
        const querTodos = /\b(todos|todas|tudo)\b/i.test(message);
        const citados = encontrarTodosMedicamentos(message, medicationsAtivos);
        const alvosLote = querTodos ? medicationsAtivos : (citados.length > 1 ? citados : []);
        if (alvosLote.length > 1) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: {
                    etapa: 'confirm_acao_lote',
                    acao,
                    medicationIds: alvosLote.map(m => m.id),
                    nomes: alvosLote.map(m => m.nome)
                }
            });
            const verboLabel = acao === 'encerrar' ? 'encerrar o tratamento' : 'pausar os lembretes';
            const lista = alvosLote.map(m => `• *${m.nome}*`).join('\n');
            console.log(`⚙️ [P6.4] Lote de ${acao}: ${alvosLote.length} tratamento(s) — ${user.phone}`);
            return `Só confirmar, ${firstName}: vou ${verboLabel} de todos os seus ${alvosLote.length} medicamentos:\n\n${lista}\n\nConfirmar?`;
        }
    }

    // Medicamento já identificado no contexto (vem de esclarecer_pausar_encerrar anterior ou de outro fluxo)
    const medNaMensagemAtual = encontrarMedicamento(message, medicationsAtivos);
    const medDoContexto = context.medicationId
        ? medicationsAtivos.find(m => m.id === context.medicationId)
        : null;
    const med = medNaMensagemAtual || medDoContexto
        || (medicamentoMencionado ? encontrarMedicamento(medicamentoMencionado, medicationsAtivos) : null);
    return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, historicoConversa, medicamentoMencionado });
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

export async function handleConfiguracao({ user, message, state, context, historicoConversa = [] }) {
    const etapa = context?.etapa || 'identif_intencao';
    const firstName = user.name?.split(' ')[0] || 'você';
    const medications = await getUserMedications(user.id);
    const medicationsAtivos = medications.filter(m => m.ativo !== false);
    const temScheduleAtivo = m => (m.schedules || []).some(s => s.ativo);
    const medicamentosComSchedule = medications.filter(m => m.ativo && temScheduleAtivo(m));
    // P1/P3: pausado é ESTADO explícito (fallback pela inferência antiga só
    // para registro anterior ao backfill).
    const medicamentosPausados = medications.filter(m => m.status === 'pausado' || (m.ativo && !temScheduleAtivo(m) && (m.schedules || []).length > 0));

    console.log(`⚙️ Configuração — etapa: ${etapa} — ${user.phone}`);

    // ── ETAPA 1: Classificar intenção via Claude ─────────────────────────────
    if (etapa === 'identif_intencao') {
        return await processarIntencaoOuEscalar({ user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa, context });
    }

    // ── ETAPA 3: Usuário especifica qual medicamento ──────────────────────────
    if (etapa === 'identif_medicamento') {
        const med = encontrarMedicamento(message, medicationsAtivos);
        const listaParaMostrar = context.acao === 'reativar' ? medicamentosPausados : medicamentosComSchedule;

        if (!med) {
            if (isCancelamento(message)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }

        const schedulesAtivos = (med.schedules || []).filter(s => s.ativo);

        // A mensagem trouxe mais do que só o nome do remédio? Pode ser mudança de
        // intenção ("quero parar o Neosaldina" em vez de só "Neosaldina") — reaproveita
        // o mesmo classificador/escalada de identif_intencao em vez de seguir cego
        // com a ação que já estava fixada no contexto.
        if (sobrouConteudoAlemDoNome(message, med.nome)) {
            return await processarIntencaoOuEscalar({
                user, firstName, message, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, historicoConversa,
                context: { etapa: 'identif_intencao', medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
            });
        }

        const { acao, novoHorario } = context;
        return await continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, schedulesAtivos, historicoConversa });
    }

    // ── ETAPA 4: Usuário especifica qual horário alterar ─────────────────────
    if (etapa === 'identif_schedule') {
        const schedulesAtivos = context.schedulesAtivos || [];
        const msg = message.toLowerCase();
        const querTodos = /\b(todos|os dois|ambos|os três|tudo|todas)\b/.test(msg);

        if (querTodos) {
            const schedulesOrdenados = [...schedulesAtivos].sort((a, b) => a.horario.localeCompare(b.horario));
            const primeiro = schedulesOrdenados[0];
            await saveConversationState(user.id, {
                state: 'configurando',
                context: {
                    ...context,
                    etapa: 'obter_horario',
                    scheduleId: primeiro.id,
                    horarioAtual: primeiro.horario,
                    schedulesAtivos: schedulesOrdenados
                }
            });
            return `Certo! Vou alterar todos os horários do *${context.medicationNome}* um a um.\n\nComeçando pelo primeiro: lembrete das *${primeiro.horario.substring(0,5)}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
        }

        const horarioMencionado = normalizarHorario(message, schedulesAtivos);
        const schedule = horarioMencionado
            ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
            : null;

        if (!schedule) {
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }

        // BUG-085: extrai o destino sempre da MESMA mensagem que resolveu a seleção
        // — nunca reaproveita context.novoHorario de uma tentativa anterior (poderia
        // não corresponder a esta mensagem). Só confia no destino se houver dois
        // números distintos na mensagem, mesma proteção do BUG-083 contra um único
        // número servir pros dois papéis (seleção e destino) ao mesmo tempo.
        const mensagemConvertida = converterNumerosPorExtenso(message);
        const temDoisHorarios = [...mensagemConvertida.matchAll(/\b\d{1,2}\b/g)].length >= 2;
        const novoHorarioAtual = temDoisHorarios ? interpretarHorarioLivre(message) : null;

        if (!novoHorarioAtual) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { ...context, etapa: 'obter_horario', scheduleId: schedule.id, horarioAtual: schedule.horario }
            });
            return `Certo! Vou alterar o lembrete das *${schedule.horario.substring(0,5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
        }

        const newCtx = { ...context, etapa: 'confirm_acao', scheduleId: schedule.id, horarioAtual: schedule.horario, novoHorario: novoHorarioAtual };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 4b: Usuário escolhe qual horário remover ───────────────────────
    if (etapa === 'identif_schedule_remocao') {
        const schedulesAtivos = context.schedulesAtivos || [];
        const horarioMencionado = normalizarHorario(message, schedulesAtivos);
        const schedule = horarioMencionado
            ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
            : null;

        if (!schedule) {
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }

        const ctx = { ...context, etapa: 'confirm_acao', scheduleId: schedule.id, horarioAtual: schedule.horario };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // ── ETAPA 4c: Coleta novos horários para redefinição ─────────────────────
    if (etapa === 'obter_novos_horarios') {
        const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)].map(m => {
            const h = m[1].padStart(2, '0');
            const min = (m[2] || '00').padStart(2, '0');
            return `${h}:${min}`;
        });

        if (matches.length === 0) {
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }

        const horariosUnicos = [...new Set(matches)];
        const ctx = { ...context, etapa: 'confirm_acao', novosHorarios: horariosUnicos };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // ── ETAPA 5: Obter o novo horário ────────────────────────────────────────
    if (etapa === 'obter_horario') {
        const novoHorario = interpretarHorarioLivre(message);
        if (!novoHorario) {
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }
        const newCtx = { ...context, etapa: 'confirm_acao', novoHorario };
        await saveConversationState(user.id, { state: 'configurando', context: newCtx });
        return buildConfirmacaoMessage(firstName, newCtx);
    }

    // ── ETAPA 6: Confirmar e executar ────────────────────────────────────────
    if (etapa === 'confirm_acao') {
        const negacaoPresente = /\b(não|nao)\b/i.test(message.toLowerCase());
        const horarioCorrecao = interpretarHorarioLivre(message);

        if (negacaoPresente && horarioCorrecao) {
            const newCtx = { ...context, etapa: 'confirm_acao', novoHorario: horarioCorrecao };
            await saveConversationState(user.id, { state: 'configurando', context: newCtx });
            return buildConfirmacaoMessage(firstName, newCtx);
        }

        if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        if (!isConfirmacao(message)) {
            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }
        return await executarAcao(user, firstName, context);
    }

    // ── ETAPAS DA REATIVAÇÃO EM 5 PASSOS (M3 P3) ─────────────────────────────

    // Passo 2/3: "manter assim ou mudar algo?" (também recebe o valor da mudança).
    if (etapa === 'reativ_manter_ou_mudar') {
        return await tratarManterOuMudar({ user, firstName, message, context, medicationsAtivos, historicoConversa });
    }

    // Porta 2: oferta reativar/recadastrar sobre med pausado ou encerrado.
    if (etapa === 'reativ_oferta') {
        const msg = message.toLowerCase();
        if (isCancelamento(message) || /\b(n[aã]o|nao|n)\b/.test(msg)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Deixei o *${context.medicationNome}* como estava. Se precisar, é só me chamar 🌿`;
        }
        const querRecadastrar = /recadastr|cadastrar|novo|do zero|de novo/.test(msg);
        const querReativar = /reativ|volta|retoma|como estava|manter/.test(msg);

        // "Sim"/"Isso" seco decide pelo caminho natural do gatilho: quem tentou
        // CADASTRAR um encerrado quer o recadastro (BUG-61 morre aqui); quem
        // estava com o tratamento pausado quer reativar.
        const escolha = querRecadastrar ? 'recadastrar'
            : querReativar ? 'reativar'
            : isConfirmacao(message)
                ? (context.statusAnterior === 'encerrado' ? 'recadastrar' : 'reativar')
                : null;

        if (escolha === 'recadastrar') {
            console.log(`💊 [P3] Porta 2 — recadastro pós-${context.statusAnterior} (${context.medicationNome}) — ${user.phone}`);
            return await iniciarCadastroComNome({ user, nome: context.medicationNome });
        }
        if (escolha === 'reativar') {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'reativ_manter_ou_mudar', medicationId: context.medicationId, medicationNome: context.medicationNome }
            });
            return `Vamos reativar o *${context.medicationNome}* então! Quer manter tudo como estava, ou mudar algo antes (horários, quantidade)?`;
        }
        return { escalarParaRoteador: true };
    }

    // Passo 5: resposta ao convite de estoque (mesmo validador do cadastro).
    if (etapa === 'reativ_estoque_convite') {
        if (isCancelamentoGenuino(message, medicationsAtivos) || /\bn[aã]o sei\b|\bdepois\b/i.test(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem${firstName ? `, ${firstName}` : ''}! O estoque fica pra depois — quando souber, é só me mandar a quantidade. 🌿`;
        }
        const medAtual = await getMedicationComSchedulesAtivos(context.medicationId);
        const camposEstoque = {
            nome: medAtual.nome,
            unidade_dose: medAtual.unidade_dose,
            unidade_estoque: medAtual.unidade_estoque,
            medication_id: context.medicationId,
            ...(context.camposEstoque || {})
        };
        const v = await validarEstoque({ message, campos: camposEstoque, historicoConversa });

        if (v.resolvido !== undefined && v.resolvido !== null) {
            if (v.resolvido.valor === null) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return renderizarFechamentoEstoque({ med: { ...medAtual, estoque_atual: null }, alerta: null, primeiroMedicamento: false, firstName });
            }
            await registrarMovimentoEstoque({
                medicationId: context.medicationId,
                tipo: 'reativacao_com_estoque', origem: 'manual',
                motivo: v.resolvido.motivo, estimado: v.resolvido.estimado,
                valorAbsoluto: v.resolvido.valor
            });
            const medDepois = await getMedicationComSchedulesAtivos(context.medicationId);
            const paresAtivos = medDepois.schedulesAtivos.map(sch => ({
                horario: String(sch.horario).slice(0, 5),
                quantidade: Number(sch.quantidade_por_dose),
                dias_semana: sch.dias_semana ?? null
            }));
            const alerta = calcularAlertaEstoqueCadastro({
                pares_posologia: paresAtivos,
                unidade_dose: medDepois.unidade_dose,
                unidade_estoque: medDepois.unidade_estoque,
                gotas_por_ml: medDepois.gotas_por_ml,
                tratamento_dias: medDepois.tratamento_dias
            }, medDepois.estoque_atual);
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return renderizarFechamentoEstoque({ med: medDepois, alerta, primeiroMedicamento: false, firstName });
        }

        if (ACOES_DE_FALHA.has(v.acao)) {
            const camposNovos = { ...camposEstoque, ...(v.updates || {}) };
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { ...context, camposEstoque: { ...(context.camposEstoque || {}), ...(v.updates || {}) } }
            });
            return renderizarPerguntaEstoque(subEtapaEstoque(camposNovos), camposNovos, ACOES_DE_FALHA.has(v.acao) ? v.acao : null);
        }

        // Sub-etapa intermediária do líquido (status/volume/fração pendentes).
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { ...context, camposEstoque: { ...(context.camposEstoque || {}), ...(v.updates || {}) } }
        });
        const camposNovos = { ...camposEstoque, ...(v.updates || {}) };
        return renderizarPerguntaEstoque(subEtapaEstoque(camposNovos), camposNovos);
    }

    // ── ETAPA pos_alteracao: usuário quer alterar outro horário? ─────────────
    if (etapa === 'pos_alteracao') {
        if (isCancelamento(message) || /\b(não|nao|n|chega|pronto|ok|tudo bem)\b/i.test(message.toLowerCase())) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
        }

        if (!isConfirmacao(message)) {
            // A pergunta "quer alterar algum?" já oferece uma lista implícita (os horários
            // restantes). Se a mensagem nomeia diretamente um deles, é "sim" + seleção na
            // mesma mensagem — mesmo princípio já usado no ramo de 1 horário só (pula
            // pergunta desnecessária quando a resposta já é inequívoca). Reaproveita o
            // mesmo casador determinístico que identif_schedule usa, em vez de escalar
            // para um classificador geral que não tem essa lista em mãos.
            const schedulesRestantesParaCheck = context.schedulesAtivos || [];
            if (schedulesRestantesParaCheck.length > 1) {
                const horarioMencionado = normalizarHorario(message, schedulesRestantesParaCheck);
                const scheduleEspecifico = horarioMencionado
                    ? schedulesRestantesParaCheck.find(s => s.horario.startsWith(horarioMencionado))
                    : null;
                if (scheduleEspecifico) {
                    await saveConversationState(user.id, {
                        state: 'configurando',
                        context: { ...context, etapa: 'obter_horario', scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario }
                    });
                    return `Certo! Vou alterar o lembrete das *${scheduleEspecifico.horario.substring(0, 5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
                }
            }

            if (isCancelamentoGenuino(message, medicationsAtivos)) {
                await saveConversationState(user.id, { state: 'idle', context: {} });
                return `Tudo certo, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
            }
            return { escalarParaRoteador: true };
        }

        const schedulesRestantes = context.schedulesAtivos || [];

        if (schedulesRestantes.length === 1) {
            const schedule = schedulesRestantes[0];
            await saveConversationState(user.id, {
                state: 'configurando',
                context: {
                    ...context,
                    etapa: 'obter_horario',
                    scheduleId: schedule.id,
                    horarioAtual: schedule.horario
                }
            });
            return `Certo! Vou alterar o lembrete das *${schedule.horario.substring(0, 5)}* do *${context.medicationNome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
        }

        const lista = schedulesRestantes.map(s => `• ${s.horario.substring(0, 5)}`).join('\n');
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { ...context, etapa: 'identif_schedule' }
        });
        return `Qual desses você quer alterar?\n\n${lista}\n\nMe responda com o horário — por exemplo: *${schedulesRestantes[0]?.horario?.substring(0, 5)}*`;
    }

    // ── ETAPA confirm_acao_lote (P6.4 — MH-82/39): UMA confirmação agregada ──
    if (etapa === 'confirm_acao_lote') {
        if (isCancelamento(message) || /\b(n[aã]o|nao|n)\b/i.test(message.toLowerCase())) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        if (!isConfirmacao(message)) {
            return { escalarParaRoteador: true };
        }
        const acaoLote = context.acao;
        for (const medicationId of context.medicationIds || []) {
            if (acaoLote === 'encerrar') await encerrarTratamento(medicationId);
            else await pausarMedicamento(medicationId);
        }
        await saveConversationState(user.id, { state: 'idle', context: {} });
        const nomes = (context.nomes || []).map(n => `*${n}*`).join(', ');
        const n = (context.medicationIds || []).length;
        console.log(`⚙️ [P6.4] Lote executado: ${acaoLote} × ${n} — ${user.phone}`);
        if (acaoLote === 'encerrar') {
            return `✅ Prontinho, ${firstName}! Encerrei os ${n} tratamentos: ${nomes}. Os lembretes foram desativados 🌿\n\nSe quiser retomar algum deles no futuro, é só me pedir.`;
        }
        return `✅ Prontinho, ${firstName}! Pausei os lembretes dos ${n}: ${nomes}. Quando quiser retomar algum, é só me dizer "reativar" 🌿`;
    }

    // ── ETAPAS DO MODO CORREÇÃO (M3 P2) ──────────────────────────────────────
    if (etapa === 'corrigir_campo') {
        if (isCancelamentoGenuino(message, medicationsAtivos)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        return await executarCorrecao({
            user, message,
            campoAlvo: context.campoAlvo,
            medicationId: context.medicationId,
            historicoConversa,
            jaPerguntou: true
        });
    }

    if (etapa === 'corrigir_perfil') {
        if (isCancelamento(message)) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Nada foi alterado. Se precisar de algo, é só me chamar 🌿`;
        }
        return await executarCorrecaoPerfil({
            user, message,
            campoAlvo: context.campoAlvo || null,
            historicoConversa,
            jaPerguntou: !!context.campoAlvo
        });
    }

    // MH-79: oferta de novo tratamento para apresentação distinta.
    if (etapa === 'corrigir_mh79_confirmar') {
        if (isConfirmacao(message)) {
            console.log(`🔀 [CONFIG] MH-79 aceito — novo cadastro: ${context.nomeQualificado} — ${user.phone}`);
            return await iniciarCadastroComNome({ user, nome: context.nomeQualificado });
        }
        if (isCancelamento(message) || /\b(não|nao|n)\b/i.test(message.toLowerCase())) {
            await saveConversationState(user.id, { state: 'idle', context: {} });
            return `Tudo bem, ${firstName}! Mantive o *${context.medicationNome}* como está. 🌿`;
        }
        return { escalarParaRoteador: true };
    }

    // Fallback
    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `Me perdi um pouquinho aqui, ${firstName}. 😅 Pode me dizer de novo o que você quer ajustar?`;
}

// ── HELPER: continua após intenção clara + medicamento opcional ──────────────
async function continuarComAcao({ user, firstName, acao, med, medicationsAtivos, medicamentosComSchedule, medicamentosPausados, novoHorario, message, schedulesAtivos, historicoConversa = [], medicamentoMencionado = null }) {
    const acaoTexto = {
        'alterar_horario':    'alterar o horário de',
        'remover_horario':    'remover um horário de',
        'adicionar_horario':  'adicionar um horário para',
        'redefinir_horarios': 'redefinir os horários de',
        'pausar':             'pausar',
        'reativar':           'reativar',
        'encerrar':           'encerrar o tratamento de',
        'corrigir_nome':      'corrigir o nome de',
        'corrigir_dosagem':   'ajustar a dosagem de',
        'corrigir_quantidade': 'ajustar a quantidade por dose de',
        'corrigir_duracao':   'ajustar a duração do tratamento de',
        'corrigir_estoque':   'atualizar o estoque de'
    };

    // Sem medicamento identificado
    if (!med) {
        // P3: "reativar X" com X ENCERRADO — o registro não está na lista de
        // ativos; a porta 2 assume com aviso + foto + oferta (BUG-61).
        if (acao === 'reativar') {
            const nomeBuscado = medicamentoMencionado || message;
            const existente = await verificarMedicamentoExistente(user.id, nomeBuscado);
            if (existente && (existente.status === 'encerrado' || existente.ativo === false)) {
                return await oferecerReativacaoPorta2({ user, medicationId: existente.id, statusAnterior: 'encerrado' });
            }
        }
        const listaParaMostrar = acao === 'reativar' ? medicamentosPausados : medicamentosComSchedule;
        if (listaParaMostrar.length === 1) {
            med = listaParaMostrar[0];
        } else {
            const lista = listaParaMostrar.map(m => `• ${m.nome}`).join('\n');
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_medicamento', acao, novoHorario }
            });
            return `Qual medicamento você quer ${acaoTexto[acao] || 'configurar'}?\n\n${lista}`;
        }
    }

    // M3 P2 — edição = modo correção do runner (validador do schema + escrita
    // por ponto único + confirmação ANTES → DEPOIS pós-escrita).
    if (CAMPO_DA_ACAO_CORRIGIR[acao]) {
        return await executarCorrecao({
            user, message,
            campoAlvo: CAMPO_DA_ACAO_CORRIGIR[acao],
            medicationId: med.id,
            historicoConversa
        });
    }

    // M3 P3 — porta 1 da reativação: foto congelada + manter/mudar (o fluxo
    // cego de confirmar-e-reativar morreu).
    if (acao === 'reativar') {
        return await iniciarReativacao({ user, med });
    }

    schedulesAtivos = schedulesAtivos || (med.schedules || []).filter(s => s.ativo);

    // remover_horario
    if (acao === 'remover_horario') {
        if (schedulesAtivos.length <= 1) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_intencao', medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
            });
            return `O *${med.nome}* tem apenas um horário de lembrete cadastrado (${schedulesAtivos[0]?.horario?.substring(0,5) || '?'}). Não é possível remover o único horário.\n\nSe quiser parar os lembretes, posso *pausar* temporariamente ou *encerrar* o tratamento. O que prefere?`;
        }

        const horarioMencionado = normalizarHorario(message, schedulesAtivos);
        const scheduleAlvo = horarioMencionado
            ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
            : null;

        if (!scheduleAlvo) {
            const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'identif_schedule_remocao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
            });
            return `O *${med.nome}* tem lembretes nos seguintes horários:\n\n${lista}\n\nQual você quer remover? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
        }

        const ctx = {
            etapa: 'confirm_acao',
            acao: 'remover_horario',
            medicationId: med.id,
            medicationNome: med.nome,
            schedulesAtivos,
            scheduleId: scheduleAlvo.id,
            horarioAtual: scheduleAlvo.horario
        };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // adicionar_horario
    if (acao === 'adicionar_horario') {
        if (novoHorario) {
            const ctx = {
                etapa: 'confirm_acao',
                acao: 'adicionar_horario',
                medicationId: med.id,
                medicationNome: med.nome,
                schedulesAtivos,
                novoHorario
            };
            await saveConversationState(user.id, { state: 'configurando', context: ctx });
            return buildConfirmacaoMessage(firstName, ctx);
        }

        await saveConversationState(user.id, {
            state: 'configurando',
            context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
        });
        const horariosAtuais = schedulesAtivos.map(s => s.horario.substring(0,5)).join(' e ');
        return `Você tem lembretes do *${med.nome}* às ${horariosAtuais}.\n\nQual horário quer adicionar? Me diga só o horário — por exemplo: *14:00*`;
    }

    // redefinir_horarios
    if (acao === 'redefinir_horarios') {
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { etapa: 'obter_novos_horarios', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
        });
        const horariosAtuais = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
        return `Vou substituir todos os horários do *${med.nome}*.\n\nHorários atuais:\n${horariosAtuais}\n\nMe diga os novos horários — por exemplo: *06:00, 14:00 e 22:00*`;
    }

    // alterar_horario: verificar se precisamos do schedule específico e/ou novo horário
    if (acao === 'alterar_horario') {
        // Múltiplos schedules sem horário específico mencionado
        if (schedulesAtivos.length > 1) {
            const horarioMencionado = normalizarHorario(message, schedulesAtivos);
            const scheduleEspecifico = horarioMencionado
                ? schedulesAtivos.find(s => s.horario.startsWith(horarioMencionado))
                : null;

            if (!scheduleEspecifico) {
                const lista = schedulesAtivos.map(s => `• ${s.horario.substring(0,5)}`).join('\n');
                const qtd = schedulesAtivos.length;
                const descricaoQtd = qtd === 1 ? 'um horário' :
                                     qtd === 2 ? 'dois horários' :
                                     `${qtd} horários`;
                // BUG-085: não carregamos novoHorario adiante. Se a origem não foi
                // reconhecida nesta mensagem, qualquer destino que a IA tenha lido aqui
                // pode não corresponder a uma tentativa futura — cada seleção de horário
                // deve pedir o destino de novo, na sua própria vez.
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: { etapa: 'identif_schedule', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos }
                });
                return `O *${med.nome}* tem lembretes em ${descricaoQtd}:\n\n${lista}\n\nQual desses você quer alterar? Me responda com o horário — por exemplo: *${schedulesAtivos[0]?.horario?.substring(0,5)}*`;
            }

            // BUG-083: um único número na mensagem não pode ser origem E destino ao mesmo tempo.
            // scheduleEspecifico (seleção) e novoHorario (destino) só podem ter vindo de tokens
            // DIFERENTES quando a mensagem realmente contém dois números distintos (padrão
            // "das X para Y"). Com um número só, novoHorario nunca é confiável aqui — mesmo que
            // esteja preenchido, tratamos como ausente e pedimos o destino separadamente.
            const temDoisHorariosNaMensagem = [...message.matchAll(/\d{1,2}[:h]\d{2}/g)].length >= 2;

            if (!novoHorario || !temDoisHorariosNaMensagem) {
                await saveConversationState(user.id, {
                    state: 'configurando',
                    context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario }
                });
                return `Certo! Vou alterar o lembrete das *${scheduleEspecifico.horario.substring(0,5)}* do *${med.nome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
            }

            const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: scheduleEspecifico.id, horarioAtual: scheduleEspecifico.horario, novoHorario };
            await saveConversationState(user.id, { state: 'configurando', context: ctx });
            return buildConfirmacaoMessage(firstName, ctx);
        }

        // Schedule único
        if (!novoHorario) {
            await saveConversationState(user.id, {
                state: 'configurando',
                context: { etapa: 'obter_horario', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: schedulesAtivos[0]?.id, horarioAtual: schedulesAtivos[0]?.horario }
            });
            return `Certo! Vou alterar o lembrete das *${schedulesAtivos[0]?.horario?.substring(0,5)}* do *${med.nome}*.\n\nPara qual horário? Me responda só com o novo horário — por exemplo: *08:00*`;
        }

        const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, scheduleId: schedulesAtivos[0]?.id, horarioAtual: schedulesAtivos[0]?.horario, novoHorario };
        await saveConversationState(user.id, { state: 'configurando', context: ctx });
        return buildConfirmacaoMessage(firstName, ctx);
    }

    // Outros casos (pausar, reativar, encerrar) → confirmação direta
    const ctx = { etapa: 'confirm_acao', acao, medicationId: med.id, medicationNome: med.nome, schedulesAtivos, novoHorario };
    await saveConversationState(user.id, { state: 'configurando', context: ctx });
    return buildConfirmacaoMessage(firstName, ctx);
}
