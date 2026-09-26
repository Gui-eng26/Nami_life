// ============================================================
// DOSES DO TURNO (v45 P1 §2, §3.2, §6)
//
// Três responsabilidades, todas do CÓDIGO — o LLM só relata o fato:
//
// 1. BLOCO ÚNICO de doses para o principal: hoje, ontem e anteontem,
//    agrupadas por dia e horário, com referências curtas D1…Dn. O mapa
//    ref → dose_logs.id vive só neste turno; nenhum UUID vai ao LLM.
// 2. ATALHO EXATO: confirma sem LLM somente quando as quatro guardas
//    valem (mensagem idêntica à lista, dose candidata, um único grupo,
//    nenhuma outra pergunta aberta). Qualquer falha → principal.
// 3. EXECUÇÃO: o fato relatado (tomou | nao_tomou | desfazer) vira a
//    função de dose pela tabela status × fato; o texto de confirmação
//    é template montado de leitura PÓS-escrita (P56).
// ============================================================

import {
    getDosesJanelaPrincipal, conferirDonoEStatusDaDose, contestarEstoque,
    confirmDoseByLogId, confirmarDoseRetroativa, confirmarDoseSemEstoque,
    registrarNaoTomado, reverterConfirmacao, getDosesPorIds,
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque
} from './database.js';
import { buildAlertaEstoquePosConfirmacao, buildConviteEstoqueNaoCadastrado } from './templates/estoqueTemplates.js';
import { degradar } from './observabilidade.js';

const FUSO = 'America/Sao_Paulo';
const DIAS_SEMANA_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// ------------------------------------------------------------
// Rótulos de tempo — sempre calculados aqui, nunca pelo LLM (BUG-059).
// ------------------------------------------------------------

function dataISOBRT(data) {
    return new Date(data).toLocaleDateString('en-CA', { timeZone: FUSO });
}

function horaBRT(data) {
    return new Date(data).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: FUSO });
}

function ddmm(dataISO) {
    const [, m, d] = dataISO.split('-');
    return `${d}/${m}`;
}

function diaSemanaCurto(dataISO) {
    const [a, m, d] = dataISO.split('-').map(Number);
    return DIAS_SEMANA_CURTO[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
}

// 'hoje' | 'ontem' | 'anteontem' | null (fora da janela).
export function calcularRotuloDia(scheduledAt, agora = new Date()) {
    const alvo = dataISOBRT(scheduledAt);
    for (const [rotulo, dias] of [['hoje', 0], ['ontem', 1], ['anteontem', 2]]) {
        if (alvo === dataISOBRT(new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000))) return rotulo;
    }
    return null;
}

function horaDaDose(dose) {
    return dose.horario_agendado ? String(dose.horario_agendado).slice(0, 5) : horaBRT(dose.scheduled_at);
}

function momentoDoLembrete(dose) {
    return dose.ultima_tentativa_at || dose.reminder_sent_at || dose.scheduled_at;
}

// Status em linguagem de negócio (§3.2).
function statusNegocio(dose) {
    switch (dose.status) {
        case 'confirmado': return 'confirmada';
        case 'nao_tomado': return 'nao_tomada';
        case 'nao_informado': return 'sem_resposta';
        case 'sem_estoque': return 'sem_estoque';
        default: return dose.confirmed ? 'confirmada' : 'aguardando_resposta';
    }
}

const ROTULO_UNIDADE = { comprimido: 'comprimido', capsula: 'cápsula', 'cápsula': 'cápsula', gota: 'gota', ml: 'ml' };

function quantidadeTexto(dose) {
    const n = Number(dose.quantidade_por_dose);
    if (!Number.isFinite(n) || n <= 0) return null;
    const med = dose.medications || {};
    const base = med.unidade_dose === 'gota' ? 'gota'
        : med.unidade_dose === 'ml' ? 'ml'
        : ROTULO_UNIDADE[med.forma_farmaceutica] || 'unidade';
    if (base === 'ml') return `${n} ml`;
    return `${n} ${base}${n > 1 ? 's' : ''}`;
}

// ------------------------------------------------------------
// 1. Estrutura do bloco — compartilhada entre o turno real (banco) e o
// adaptador `principal_p1` do corpus (itens.json). O renderizador só
// conhece esta estrutura.
// ------------------------------------------------------------

// Monta a estrutura e o mapa ref → dose a partir das doses do banco.
// Refs em ordem cronológica (dia, horário, nome), como no briefing §3.2.
export function estruturarDoses({ doses, agora = new Date(), dosesCitadas = [], envioCitado = null }) {
    const janela = (doses || [])
        .map(d => ({ d, rotulo: calcularRotuloDia(d.scheduled_at, agora) }))
        .filter(x => x.rotulo)
        .sort((a, b) => new Date(a.d.scheduled_at) - new Date(b.d.scheduled_at)
            || (a.d.medications?.nome || '').localeCompare(b.d.medications?.nome || ''));

    const mapa = new Map();
    const porId = new Map();
    const linhas = janela.map(({ d, rotulo }, i) => {
        const ref = `D${i + 1}`;
        const status = statusNegocio(d);
        const iso = dataISOBRT(d.scheduled_at);
        mapa.set(ref, { id: d.id, status, statusBanco: d.status, medicationId: d.medication_id, nome: d.medications?.nome });
        porId.set(d.id, ref);
        return {
            ref,
            dia: rotulo,
            data: ddmm(iso),
            diaSemana: diaSemanaCurto(iso),
            hora: horaDaDose(d),
            medicamento: d.medications?.nome || 'medicamento',
            quantidade: quantidadeTexto(d),
            status,
            tentativa: status === 'aguardando_resposta' ? Math.min(Number(d.tentativas) || 1, 3) : null,
            confirmadaAs: status === 'confirmada' && d.taken_at ? horaBRT(d.taken_at) : null,
            momentoLembrete: momentoDoLembrete(d)
        };
    });

    // Último lembrete enviado: o grupo cujo envio (ou cobrança) é o mais recente.
    let ultimoLembrete = null;
    for (const l of linhas) {
        if (!l.momentoLembrete) continue;
        if (!ultimoLembrete || new Date(l.momentoLembrete) > new Date(ultimoLembrete.momento)) {
            ultimoLembrete = { momento: l.momentoLembrete, dia: l.dia, hora: l.hora };
        }
    }
    if (ultimoLembrete) {
        const doGrupo = linhas.filter(l => l.dia === ultimoLembrete.dia && l.hora === ultimoLembrete.hora);
        const tentativas = doGrupo.map(l => l.tentativa).filter(Boolean);
        ultimoLembrete = {
            quando: `${ultimoLembrete.dia} ${horaBRT(ultimoLembrete.momento)}`,
            momento: ultimoLembrete.momento,
            tentativa: tentativas.length ? Math.max(...tentativas) : null,
            grupo: doGrupo.map(l => l.ref).join(','),
            tipo: doGrupo.some(l => l.status === 'sem_estoque') ? 'estoque_zerado' : 'lembrete'
        };
    }

    let mensagemCitada = null;
    if (envioCitado) {
        const refsCitadas = (dosesCitadas || []).map(d => porId.get(d.id)).filter(Boolean);
        mensagemCitada = {
            origem: String(envioCitado.origem || '').replace(/^proativo:/, ''),
            quando: `${calcularRotuloDia(envioCitado.created_at, agora) || ddmm(dataISOBRT(envioCitado.created_at))} ${horaBRT(envioCitado.created_at)}`,
            texto: envioCitado.texto,
            grupo: refsCitadas.join(',') || null
        };
    }

    const agoraISO = dataISOBRT(agora);
    return {
        estrutura: {
            agora: { data: ddmm(agoraISO), diaSemana: diaSemanaCurto(agoraISO), hora: horaBRT(agora) },
            ultimoLembrete, mensagemCitada, doses: linhas
        },
        mapa
    };
}

// Converte um item do corpus (contexto P0 §2) na MESMA estrutura.
export function estruturaDoItemDoCorpus(contexto) {
    const agoraISO = (contexto.agora || '').slice(0, 10);
    const agoraHora = (contexto.agora || '').slice(11, 16);
    const mapa = new Map();
    const doses = (contexto.doses || []).map(d => {
        mapa.set(d.ref, { id: d.ref, status: d.status, nome: d.medicamento });
        return { ...d, diaSemana: null, tentativa: null, confirmadaAs: null };
    });
    return {
        estrutura: {
            agora: agoraISO ? { data: ddmm(agoraISO), diaSemana: diaSemanaCurto(agoraISO), hora: agoraHora } : null,
            ultimoLembrete: contexto.ultimo_lembrete || null,
            mensagemCitada: contexto.mensagem_citada || null,
            doses
        },
        mapa
    };
}

const TEXTO_STATUS = {
    aguardando_resposta: (l) => `aguardando resposta${l.tentativa ? ` (${l.tentativa} de 3)` : ''}`,
    sem_resposta: () => 'sem resposta (cobranças esgotadas)',
    confirmada: (l) => `confirmada${l.confirmadaAs ? ` ${l.confirmadaAs}` : ''}`,
    nao_tomada: () => 'não tomada',
    sem_estoque: () => 'sem estoque registrado (o lembrete avisou estoque zerado)'
};

export function renderizarBlocoDoses(estrutura) {
    const { agora, ultimoLembrete, mensagemCitada, doses } = estrutura;
    const linhas = [agora ? `Agora: ${agora.diaSemana ? `${agora.diaSemana} ` : ''}${agora.data}, ${agora.hora}` : 'Agora: —'];
    if (mensagemCitada) {
        linhas.push(`Mensagem citada: ${mensagemCitada.origem} de ${mensagemCitada.quando}${mensagemCitada.grupo ? ` → grupo ${mensagemCitada.grupo}` : ''}`);
        linhas.push(`  texto citado: "${String(mensagemCitada.texto || '').replace(/\s+/g, ' ').slice(0, 240)}"`);
    }
    if (ultimoLembrete) {
        const tent = ultimoLembrete.tentativa ? ` (${ultimoLembrete.tentativa}ª tentativa)` : '';
        const tipo = ultimoLembrete.tipo === 'estoque_zerado' ? ' — aviso de estoque zerado' : '';
        linhas.push(`Último lembrete: ${ultimoLembrete.quando}${tent}${tipo} → grupo ${ultimoLembrete.grupo}`);
    }
    if (!doses.length) {
        linhas.push('', 'Nenhuma dose com lembrete enviado hoje, ontem ou anteontem.');
        return linhas.join('\n');
    }

    const dias = [];
    for (const d of doses) {
        const chave = `${d.dia}|${d.data}`;
        let dia = dias.find(x => x.chave === chave);
        if (!dia) { dia = { chave, rotulo: d.dia, data: d.data, diaSemana: d.diaSemana, horas: [] }; dias.push(dia); }
        let hora = dia.horas.find(h => h.hora === d.hora);
        if (!hora) { hora = { hora: d.hora, doses: [] }; dia.horas.push(hora); }
        hora.doses.push(d);
    }
    const ordemDia = { anteontem: 0, ontem: 1, hoje: 2 };
    dias.sort((a, b) => (ordemDia[a.rotulo] ?? 9) - (ordemDia[b.rotulo] ?? 9));

    for (const dia of dias) {
        linhas.push('', `${dia.rotulo.toUpperCase()} · ${dia.diaSemana ? `${dia.diaSemana} ` : ''}${dia.data}`);
        dia.horas.sort((a, b) => a.hora.localeCompare(b.hora));
        for (const h of dia.horas) {
            h.doses.forEach((d, i) => {
                const prefixo = i === 0 ? `  ${h.hora}  ` : '         ';
                const status = (TEXTO_STATUS[d.status] || (() => d.status))(d);
                linhas.push(`${prefixo}[${d.ref}] ${d.medicamento}${d.quantidade ? ` · ${d.quantidade}` : ''} · ${status}`);
            });
        }
    }
    return linhas.join('\n');
}

// Leitura do banco + estrutura, para o turno real.
export async function montarDosesDoTurno({ userId, envioCitado = null, dosesCitadas = [], doses = null }) {
    const lista = doses ?? await getDosesJanelaPrincipal(userId);
    return { ...estruturarDoses({ doses: lista, dosesCitadas, envioCitado }), doses: lista };
}

// ------------------------------------------------------------
// 2. ATALHO EXATO (§2)
// ------------------------------------------------------------

// Lista SÓ positiva (decisão de 26/09): toda negativa vai ao principal.
const LISTA_ATALHO = new Set(['sim', 's', 'tomei', 'tomei sim', 'ja tomei', 'ja tomei sim', 'ok tomei']);

export function normalizarParaAtalho(message) {
    return String(message ?? '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        // pontuação e emoji nas bordas
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
        .replace(/\s+/g, ' ')
        // letras repetidas reduzidas ("Simmm" → "sim")
        .replace(/([a-z])\1+/g, '$1')
        .trim();
}

export function mensagemDoAtalho(message) {
    return LISTA_ATALHO.has(normalizarParaAtalho(message));
}

const VINTE_E_QUATRO_HORAS = 24 * 60 * 60 * 1000;

function chaveDoGrupo(d) {
    return `${dataISOBRT(d.scheduled_at)}|${horaDaDose(d)}`;
}

// Devolve { doses } quando as quatro guardas valem; senão { motivo }.
export function avaliarAtalhoExato({ message, state, doses, dosesCitadas = [], ultimoTurnoUsuarioAt = null, agora = new Date() }) {
    // Guarda 1 — mensagem idêntica a uma entrada da lista.
    if (!mensagemDoAtalho(message)) return { motivo: 'mensagem_fora_da_lista' };

    // Guarda 4 — nenhuma outra pergunta aberta.
    const estado = state?.state || 'idle';
    if (estado !== 'idle') return { motivo: `estado_${estado}` };

    // Guarda 2 — existe dose candidata.
    const abertas = (d) => ['pendente', 'nao_informado', 'sem_estoque'].includes(d.status) && d.confirmed !== true;
    let candidatas;
    if ((dosesCitadas || []).length > 0) {
        // O grupo do lembrete citado — e só ele.
        candidatas = dosesCitadas.filter(abertas);
    } else {
        const corte = ultimoTurnoUsuarioAt ? new Date(ultimoTurnoUsuarioAt).getTime() : 0;
        candidatas = (doses || []).filter(d => {
            if (d.status === 'pendente' && d.reminder_sent === true && d.confirmed !== true) return true;
            if (d.status === 'nao_informado' || d.status === 'sem_estoque') {
                const t = new Date(momentoDoLembrete(d)).getTime();
                return t > corte && (agora.getTime() - t) <= VINTE_E_QUATRO_HORAS;
            }
            return false;
        });
    }
    if (candidatas.length === 0) return { motivo: 'sem_dose_candidata' };

    // Guarda 3 — um único grupo candidato (mesmo horário, mesmo dia — MH-032).
    const grupos = new Set(candidatas.map(chaveDoGrupo));
    if (grupos.size !== 1) return { motivo: `grupos_candidatos_${grupos.size}` };

    return { doses: candidatas };
}

// ------------------------------------------------------------
// 3. EXECUÇÃO (§6)
// ------------------------------------------------------------

// Tabela status × fato (§6.2). Status do BANCO → fato → função.
const TABELA = {
    pendente: { tomou: 'confirmar_pendente', nao_tomou: 'nao_tomado' },
    nao_informado: { tomou: 'confirmar_retroativa', nao_tomou: 'nao_tomado' },
    sem_estoque: { tomou: 'confirmar_sem_estoque', nao_tomou: 'manter_sem_estoque' },
    confirmado: { desfazer: 'reverter' },
    nao_tomado: { tomou: 'corrigir_para_tomada' }
};

export function acaoDaTabela(statusBanco, fato) {
    return TABELA[statusBanco]?.[fato] ?? null;
}

// Valida TODOS os fatos antes de escrever qualquer um: referência fora do
// mapa ou combinação fora da tabela → nada é executado (§6.1).
export function validarFatos(fatos, mapa) {
    const planos = [];
    for (const f of fatos || []) {
        const alvo = mapa.get(f.ref);
        if (!alvo) return { ok: false, motivo: `ref_fora_do_mapa:${f.ref}` };
        const acao = acaoDaTabela(alvo.statusBanco, f.fato);
        if (!acao) return { ok: false, motivo: `combinacao_invalida:${alvo.statusBanco}×${f.fato}` };
        planos.push({ ref: f.ref, fato: f.fato, acao, ...alvo });
    }
    return { ok: true, planos };
}

async function alertaEstoquePosConfirmacao(medicationId) {
    try {
        const estoqueInfo = await getEstoqueInfoParaAlerta(medicationId);
        if (!estoqueInfo) return '';
        const confirmacoesDoDia = await contarConfirmacoesHoje(medicationId);
        if (estoqueInfo.estoqueDesconhecido) {
            // Estoque nunca informado (ou contestado): CONVITE, só na 1ª do dia.
            return confirmacoesDoDia <= 1 ? buildConviteEstoqueNaoCadastrado(estoqueInfo) : '';
        }
        const deveAlertar = calcularAlertaEstoque({
            diasRestantes: estoqueInfo.diasRestantes,
            tipo_tratamento: estoqueInfo.tipo_tratamento,
            tratamento_dias: estoqueInfo.tratamento_dias,
            diasRestantesTratamento: estoqueInfo.diasRestantesTratamento,
            confirmacoesDoDia
        });
        return deveAlertar ? buildAlertaEstoquePosConfirmacao(estoqueInfo) : '';
    } catch (e) {
        console.error('⚠️ Erro ao verificar alerta de estoque pós-confirmação:', e.message);
        return '';
    }
}

// Escreve um plano validado. Confere dono e status no banco antes (§6.1):
// se a dose mudou desde que o mapa foi montado, não escreve.
async function executarPlano(plano, userId) {
    const statusPermitidos = [plano.statusBanco];
    const conferencia = await conferirDonoEStatusDaDose(plano.id, { userId, statusPermitidos });
    if (!conferencia.ok) return { ok: false, motivo: conferencia.motivo };
    const estoqueAtual = conferencia.log.medications?.estoque_atual;

    const tomou = plano.fato === 'tomou';
    // §6.4: confirmação de dose com estoque <= 0 contesta o estoque ANTES de
    // gravar — com estoque nulo, a confirmação não debita nada.
    let contestado = false;
    if (tomou && estoqueAtual !== null && estoqueAtual !== undefined && estoqueAtual <= 0) {
        contestado = await contestarEstoque(plano.medicationId, plano.id);
    }

    switch (plano.acao) {
        case 'confirmar_pendente':
            await confirmDoseByLogId(plano.id);
            break;
        case 'confirmar_retroativa':
            await confirmarDoseRetroativa(plano.id, 'confirmação retroativa relatada pela pessoa (P1)');
            break;
        case 'corrigir_para_tomada':
            await confirmarDoseRetroativa(plano.id, 'correção: a pessoa tomou a dose registrada como não tomada', { statusPermitidos: ['nao_tomado'] });
            break;
        case 'confirmar_sem_estoque':
            await confirmarDoseSemEstoque(plano.id);
            break;
        case 'nao_tomado':
            await registrarNaoTomado(null, plano.id);
            break;
        case 'manter_sem_estoque':
            break; // §6.2: a dose já está como sem_estoque — nada a escrever
        case 'reverter':
            await reverterConfirmacao(plano.id, 'a pessoa informou que não tomou (P1)');
            break;
        default:
            return { ok: false, motivo: `acao_desconhecida:${plano.acao}` };
    }
    return { ok: true, contestado };
}

function primeiroNome(user) {
    return user?.name ? user.name.split(' ')[0] : null;
}

// Linha de uma dose lida do banco: "*Roacutan* de ontem (25/09, 06:28)".
function descreverDose(dose, agora = new Date()) {
    const nome = dose.medications?.nome || 'seu remédio';
    const rotulo = calcularRotuloDia(dose.scheduled_at, agora);
    const data = ddmm(dataISOBRT(dose.scheduled_at));
    return `*${nome}* de ${rotulo || data} (${data}, ${horaDaDose(dose)})`;
}

// §6.3: o texto sai de uma leitura do banco DEPOIS da gravação e diz qual
// dose e de qual dia. Texto provisório até a sessão de copy.
async function montarTextoPosEscrita({ executados, user, semAlertaPara = new Set() }) {
    const lidas = await getDosesPorIds(executados.map(p => p.id));
    const porId = new Map(lidas.map(d => [d.id, d]));
    const nome = primeiroNome(user);

    const confirmadas = executados.filter(p => p.fato === 'tomou' && porId.get(p.id)?.status === 'confirmado');
    const naoTomadas = executados.filter(p => p.fato === 'nao_tomou');
    const desfeitas = executados.filter(p => p.fato === 'desfazer' && porId.get(p.id)?.status !== 'confirmado');

    const partes = [];
    if (confirmadas.length === 1) {
        partes.push(`✅ ${descreverDose(porId.get(confirmadas[0].id))} confirmada${nome ? `, ${nome}` : ''}! 💊`);
    } else if (confirmadas.length > 1) {
        partes.push(`✅ Doses confirmadas${nome ? `, ${nome}` : ''}:\n${confirmadas.map(p => `• ${descreverDose(porId.get(p.id))}`).join('\n')}`);
    }
    if (naoTomadas.length) {
        partes.push(`Anotei que você não tomou: ${naoTomadas.map(p => descreverDose(porId.get(p.id))).join(', ')}. 🌿`);
    }
    if (desfeitas.length) {
        partes.push(`Desfiz a confirmação: ${desfeitas.map(p => descreverDose(porId.get(p.id))).join(', ')}. 🌿`);
    }

    // Estoque: alerta/convite de template, uma vez por medicamento confirmado —
    // exceto o que tem ação de estoque no MESMO turno (a recompra escreve o
    // número depois; o convite de "não tenho o estoque" a contradiria).
    let alertas = '';
    for (const medId of [...new Set(confirmadas.map(p => p.medicationId))].filter(id => !semAlertaPara.has(id))) {
        alertas += await alertaEstoquePosConfirmacao(medId);
    }
    return partes.join('\n\n') + alertas;
}

// Executa os fatos relatados (pelo principal ou pelo atalho). Tudo ou nada
// na validação; texto final só de leitura pós-escrita.
export async function executarFatosDeDose({ user, fatos, mapa, semAlertaPara = new Set() }) {
    if (!fatos?.length) return { ok: true, texto: '', executados: [] };

    const validacao = validarFatos(fatos, mapa);
    if (!validacao.ok) {
        await degradar({
            origem: 'principal', motivo: 'ref_dose_invalida', agent: 'principal', userId: user.id,
            detalhe: { motivo: validacao.motivo, fatos }, fallback: null
        });
        return { ok: false, motivo: validacao.motivo, texto: '', executados: [] };
    }

    const executados = [];
    for (const plano of validacao.planos) {
        const r = await executarPlano(plano, user.id);
        if (!r.ok) {
            await degradar({
                origem: 'principal', motivo: 'ref_dose_invalida', agent: 'principal', userId: user.id,
                detalhe: { motivo: r.motivo, ref: plano.ref, fato: plano.fato }, fallback: null
            });
            continue;
        }
        executados.push({ ...plano, contestado: r.contestado });
    }
    if (executados.length === 0) return { ok: false, motivo: 'nenhuma_dose_executada', texto: '', executados };

    console.log(`💊 [DOSES] ${executados.map(p => `${p.ref}:${p.fato}`).join(', ')} — ${user.phone}`);
    return { ok: true, texto: await montarTextoPosEscrita({ executados, user, semAlertaPara }), executados };
}

// O atalho executa a mesma tabela: monta um mapa mínimo só com as candidatas.
export async function executarAtalho({ user, doses }) {
    const mapa = new Map();
    const fatos = doses.map((d, i) => {
        const ref = `A${i + 1}`;
        mapa.set(ref, { id: d.id, status: statusNegocio(d), statusBanco: d.status, medicationId: d.medication_id, nome: d.medications?.nome });
        return { ref, fato: 'tomou' };
    });
    return executarFatosDeDose({ user, fatos, mapa });
}
