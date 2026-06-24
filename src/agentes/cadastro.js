import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import {
    saveConversationState,
    saveMedication,
    saveSchedule,
    replaceMedication,
    verificarMedicamentoExistente,
    formatarHistoricoConversa
} from '../database.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// CÁLCULO DETERMINÍSTICO DE HORÁRIOS A PARTIR DE FREQUÊNCIA
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

function dosesPerDiaParaIntervalo(dosesPerDia) {
    if (!dosesPerDia || dosesPerDia < 1) return null;
    return 24 / dosesPerDia;
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(etapa, context, userName, historicoConversa = []) {
    return `Você é a Nami, assistente de saúde. Você está no fluxo de cadastro de um novo medicamento.

Sua única função agora é coletar as informações necessárias para cadastrar o medicamento corretamente, uma pergunta por vez.

Etapa atual: ${etapa}
Contexto coletado até agora: ${JSON.stringify(context)}
Nome do usuário: ${userName || 'usuário'}

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

REGRAS:
- Colete UMA informação por mensagem
- Seja clara e direta nas perguntas
- Adapte a linguagem à forma farmacêutica quando relevante
- NÃO confirme parcialmente durante a coleta — só mostre o resumo completo na etapa cad_confirmacao
- Se o usuário quiser cancelar ("deixa pra lá", "cancela", "esquece"), encerre o fluxo com gentileza (proximaEtapa: "idle")

REGRA DE PERSISTÊNCIA DE CONTEXTO (CRÍTICA):
Ao retornar novoContext, SEMPRE inclua TODOS os campos já coletados nas etapas
anteriores com seus valores atuais. NUNCA retorne um campo já preenchido como null.
O contexto recebido ("Contexto coletado até agora") contém o estado atual —
preserve todos os valores e apenas ADICIONE ou ATUALIZE o que mudou nesta etapa.
Exemplo: se horarios já tem ["19:00","03:00","11:00"], mantenha esse valor
em novoContext a menos que o usuário peça explicitamente para mudá-lo.

REGRA ANTI-LOOP (CRÍTICA):
Se o usuário demonstrar frustração, confusão repetida, ou se a mesma etapa
se repetir várias vezes sem progresso, ofereça uma saída clara:
"Desculpe a confusão! 😊 Vamos com calma. Me diga em uma frase: o nome do
remédio, quantas vezes por dia e a partir de que horário você toma. Ex:
'Dipirona, 3 vezes ao dia, começando às 7h'. Que eu organizo tudo pra você!"
Isso permite recomeçar a coleta de horários de forma limpa.

ETAPAS E O QUE FAZER EM CADA UMA:

cad_nome:
  Pergunta o nome do medicamento.

cad_forma:
  Pergunta a forma farmacêutica.
  Sugestões: comprimido, cápsula, colírio, gotas, pomada, injetável, xarope, outro.
  Se o usuário já mencionou a forma farmacêutica na etapa anterior (ex: "colírio Voltaren"), pule direto para cad_dosagem e informe a forma detectada no novoContext.

cad_dosagem:
  Pergunta a dosagem. Adapte à forma:
  - comprimido/cápsula → "Qual a dosagem? (ex: 50mg)"
  - colírio/gotas → "Qual a concentração? (ex: 0,5%)"
  - pomada → "Qual a concentração? (ex: 1%)"
  - outros → "Qual a dosagem ou concentração?"

cad_tipo_tratamento:
  Pergunta se é uso contínuo ou com prazo determinado.
  Mensagem: "Este remédio é de uso contínuo (sem previsão de parada) ou tem prazo determinado, como um antibiótico ou anti-inflamatório?"
  Se o usuário disser temporário, pergunte quantos dias dura o tratamento.
  Salve tipo_tratamento como "continuo" ou "temporario" e tratamento_dias como número (ou null se contínuo).

cad_horarios:
  Seu objetivo é obter os horários das doses. Há DOIS caminhos:

  CAMINHO 1 — Horários específicos informados → salve diretamente em "horarios":
     "de manhã e à noite" → horarios: ["07:00", "21:00"]
     "às 8 e às 20" → horarios: ["08:00", "20:00"]
     "só de manhã" → horarios: ["07:00"]
     Neste caso, defina doses_por_dia = quantidade de horários, intervalo_horas = null.

  CAMINHO 2 — Frequência regular (intervalo) → você precisa de DOIS dados:
     a) o intervalo ou número de doses por dia
     b) o horário de início

     Quando o usuário informar a frequência ("de 8 em 8 horas", "3 vezes ao dia",
     "12/12h"), extraia e salve no contexto:
       - "de 8 em 8 horas" → intervalo_horas: 8, doses_por_dia: 3
       - "de 12 em 12 horas" → intervalo_horas: 12, doses_por_dia: 2
       - "de 6 em 6 horas" → intervalo_horas: 6, doses_por_dia: 4
       - "3 vezes ao dia" → doses_por_dia: 3, intervalo_horas: 8
       - "2 vezes ao dia" → doses_por_dia: 2, intervalo_horas: 12

     Se você ainda NÃO tem o horário de início, pergunte:
       "Qual o horário da primeira dose do dia?"

     Quando o usuário informar o horário de início, salve em horario_inicio
     (ex: "às 19h" → horario_inicio: "19:00") e mantenha intervalo_horas/doses_por_dia.

  IMPORTANTE: NÃO calcule os horários você mesmo. O sistema fará o cálculo
  automaticamente a partir de intervalo_horas + horario_inicio. Você apenas
  precisa garantir que esses dois campos estejam preenchidos no novoContext
  quando ambos forem conhecidos.

  Quando tiver (horarios preenchido) OU (intervalo_horas + horario_inicio
  preenchidos), avance para cad_estoque.

cad_estoque:
  Pergunta a quantidade em estoque. Adapte à forma:
  - comprimido/cápsula → "Quantos comprimidos você tem agora?"
  - colírio/gotas → "Quantos frascos você tem agora?"
  - pomada → "Quantos tubos você tem agora?"
  - outros → "Qual a quantidade em estoque?"

  QUANDO O USUÁRIO RESPONDER COM A QUANTIDADE, siga estas regras:

  CASO 1 — context.alerta_estoque_baixo existe E tipo_tratamento = 'temporario' E estoque NÃO cobre o tratamento:
    Exiba o aviso de estoque insuficiente E em seguida já exiba o resumo completo para confirmação:
    "Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia, seu estoque
     cobre apenas {dias_restantes} dias — mas seu tratamento é de {tratamento_dias} dias.
     Pode ser bom providenciar mais! 💊

     Mas já deixa eu confirmar o que coletei antes de salvar:

     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: {tratamento_dias} dias
     ⏰ Horários: {horarios}
     📦 Estoque: {estoque}

     Está tudo certinho?"

  CASO 2 — context.alerta_estoque_baixo existe E tipo_tratamento = 'temporario' E estoque cobre o tratamento:
    Confirme que o estoque é suficiente E já exiba o resumo completo:
    "Ótimo! Seu estoque é suficiente para o tratamento completo. 😊

     Deixa eu confirmar tudo antes de salvar:

     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: {tratamento_dias} dias
     ⏰ Horários: {horarios}
     📦 Estoque: {estoque}

     Está tudo certinho?"

  CASO 3 — context.alerta_estoque_baixo existe E tipo_tratamento = 'continuo' E dias_restantes = 0:
    "Entendi! Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia,
     você já está sem estoque suficiente para hoje mesmo. Quer cadastrar assim mesmo
     e comprar mais em breve, ou prefere registrar a quantidade depois da compra?"
    (Neste caso aguardar resposta do usuário antes de exibir o resumo.)

  CASO 4 — context.alerta_estoque_baixo existe E tipo_tratamento = 'continuo' E dias_restantes <= 5:
    Exiba o aviso E em seguida já exiba o resumo completo:
    "Anotado! Só um aviso: seu estoque dura apenas {dias_restantes} dias. Não esqueça
     de fazer a recompra em breve! 💊

     Deixa eu confirmar tudo antes de salvar:

     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: contínuo
     ⏰ Horários: {horarios}
     📦 Estoque: {estoque}

     Está tudo certinho?"

  CASO 5 — context.alerta_estoque_baixo NÃO existe (estoque normal):
    Não comente sobre estoque. Exiba diretamente o resumo completo:
    "Deixa eu confirmar tudo antes de salvar:

     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: {contínuo | X dias}
     ⏰ Horários: {horarios}
     📦 Estoque: {estoque}

     Está tudo certinho?"

  Em todos os casos acima (exceto CASO 3), defina proximaEtapa: "cad_confirmacao".
  O resumo já está sendo exibido nesta mensagem — na próxima etapa o Claude só precisa
  processar a confirmação ou correção do usuário, não exibir o resumo novamente.

cad_confirmacao:
  O resumo já foi exibido na etapa anterior (cad_estoque). NÃO repita o resumo.
  Aguarde a resposta do usuário e processe:

  - Se o usuário CONFIRMAR → avance para cad_salvo
  - Se o usuário indicar CORREÇÃO → identifique o campo a corrigir e volte à etapa correspondente
    Exemplos:
    "o horário está errado" → volte para cad_horarios
    "a dosagem não é essa" → volte para cad_dosagem
    "é pra 5 dias, não 3" → volte para cad_tipo_tratamento

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
  Usuário confirmou os dados.
  - Preencha o campo action com SAVE_MEDICATION
  - Envie mensagem de sucesso carinhosa (ex: "Ótimo! {nome} foi cadastrado com sucesso 💊✅ Vou te lembrar nos horários certos!")
  - proximaEtapa: "idle"

FORMATO DE RESPOSTA — JSON válido, sem markdown, sem backticks:
{
  "message": "mensagem para o usuário",
  "proximaEtapa": "cad_nome | cad_forma | cad_dosagem | cad_tipo_tratamento | cad_horarios | cad_estoque | cad_confirmacao | cad_salvo | idle",
  "novoContext": {
    "etapa": "próxima etapa a ser executada",
    "nome": "nome do remédio",
    "forma": "forma farmacêutica",
    "dosagem": "dosagem",
    "tipo_tratamento": "continuo | temporario",
    "tratamento_dias": null,
    "doses_por_dia": null,
    "intervalo_horas": null,
    "horario_inicio": null,
    "horarios": [],
    "estoque": null
  },
  "action": null
}

O campo action SÓ é preenchido em cad_salvo:
{
  "type": "SAVE_MEDICATION",
  "nome": "",
  "forma": "",
  "dosagem": "",
  "tipo_tratamento": "continuo | temporario",
  "tratamento_dias": null,
  "horarios": ["HH:MM"],
  "estoque": 0
}`;
}

// ============================================================
// CHAMADA AO CLAUDE
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
        return {
            message: 'Desculpe, tive um probleminha. Pode repetir? 🌿',
            proximaEtapa: context?.etapa || 'cad_nome',
            novoContext: context || {},
            action: null
        };
    }
}

// ============================================================
// PROCESSAMENTO DE AÇÃO
// ============================================================

async function processarAcao(action, user) {
    if (action.type !== 'SAVE_MEDICATION') return null;

    const med = await saveMedication({
        userId: user.id,
        nome: action.nome,
        forma: action.forma,
        dosagem: action.dosagem,
        tipo_tratamento: action.tipo_tratamento || 'continuo',
        tratamento_dias: action.tratamento_dias || null,
        estoque: action.estoque || 0
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

    // Salva os horários
    if (action.horarios && action.horarios.length > 0) {
        for (let horario of action.horarios) {
            if (typeof horario === 'object') {
                horario = horario.horario || horario.hora || Object.values(horario)[0];
            }
            const horarioStr = String(horario).trim().substring(0, 5);
            await saveSchedule({ medicationId: med.id, horario: horarioStr });
        }
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

        const systemPrompt = buildSystemPrompt('cad_forma', { nome: context.nome }, user.name, historicoConversa);
        const claudeResponse = await callClaude({
            systemPrompt,
            message: `Quero cadastrar o ${context.nome} novamente`,
            context: { nome: context.nome }
        });

        const proximaEtapa = claudeResponse.proximaEtapa || 'cad_forma';
        const novoContext = { ...claudeResponse.novoContext, nome: context.nome };
        await saveConversationState(user.id, {
            state: 'adding_med',
            context: { ...novoContext, etapa: proximaEtapa }
        });
        return claudeResponse.message;
    }

    // Pré-calcula alerta de estoque baixo antes de chamar Claude,
    // para que o prompt possa mencionar o aviso na mesma mensagem de coleta
    let contextParaClaude = context || {};
    if (etapaAtual === 'cad_estoque') {
        const estoque = parseInt(message) || 0;
        const horarios = context?.horarios || [];
        const dosesPerDia = context?.doses_por_dia || horarios.length || 1;
        const diasRestantes = Math.floor(estoque / dosesPerDia);
        const tratamentoDias = context?.tratamento_dias || null;

        // Tratamento com duração definida (agudo): alerta só se estoque não cobre o tratamento
        // Tratamento contínuo: alerta quando <= 5 dias de estoque
        const deveAlertar = tratamentoDias !== null
            ? diasRestantes < tratamentoDias
            : diasRestantes <= 5;

        contextParaClaude = {
            ...contextParaClaude,
            alerta_estoque_baixo: deveAlertar ? {
                dias_restantes: diasRestantes,
                estoque,
                doses_por_dia: dosesPerDia,
                tipo_tratamento: tratamentoDias ? 'temporario' : 'continuo',
                tratamento_dias: tratamentoDias
            } : null
        };
    }

    const systemPrompt = buildSystemPrompt(etapaAtual, contextParaClaude, user.name, historicoConversa);
    const claudeResponse = await callClaude({ systemPrompt, message, context: contextParaClaude });

    const proximaEtapa = claudeResponse.proximaEtapa || 'cad_nome';
    const novoContext = claudeResponse.novoContext || {};

    // BUG-041: cálculo determinístico de horários a partir de frequência + início.
    // Se temos intervalo_horas e horario_inicio mas horarios ainda não foi calculado
    // (ou tem menos itens que doses_por_dia), o código calcula — nunca o LLM.
    if (novoContext.intervalo_horas && novoContext.horario_inicio) {
        const calculados = calcularHorariosPorIntervalo(
            novoContext.horario_inicio,
            novoContext.intervalo_horas
        );
        if (calculados.length > 0) {
            novoContext.horarios = calculados;
            console.log(`🕐 [BUG-041] Horários calculados: ${calculados.join(', ')} (início ${novoContext.horario_inicio}, intervalo ${novoContext.intervalo_horas}h)`);
        }
    }

    // TRABALHO 2: verificação antecipada de medicamento existente
    if (etapaAtual === 'cad_nome' && novoContext.nome && proximaEtapa === 'cad_forma') {
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

    // Executa ação antes de salvar o estado (pode retornar override de mensagem)
    let mensagemFinal = claudeResponse.message;
    if (claudeResponse.action) {
        const resultado = await processarAcao(claudeResponse.action, user);
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
