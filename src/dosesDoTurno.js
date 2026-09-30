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
    getEstoqueInfoParaAlerta, contarConfirmacoesHoje, calcularAlertaEstoque,
    classificarNivelEstoquePorDias, getUltimasRespostasDaNami
} from './database.js';
// v47 Onda 2 (MH-100 C): rótulos de tempo e fragmentos canônicos de dose
// moram em templates/dose.js (por equivalência estrita); a renderização
// canônica sai SÓ do catálogo — este módulo produz fatos e estrutura.
import { dataISOBRT, horaBRT, ddmm, calcularRotuloDia, horaDaDose, quandoDaDose, descreverDose } from './templates/dose.js';
import { renderizarCanonico } from './templates/catalogo.js';
import { degradar } from './observabilidade.js';

const DIAS_SEMANA_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function diaSemanaCurto(dataISO) {
    const [a, m, d] = dataISO.split('-').map(Number);
    return DIAS_SEMANA_CURTO[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
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
// P1-copy §3: `ainda_nao` ("não", "ainda não", "daqui a pouco", "não tomei"
// com a dose ainda na janela de cobranças) não grava nada — a dose segue
// pendente e as cobranças continuam. Fora de "aguardando resposta" ele vale
// como `nao_tomou` (regra antiga).
const TABELA = {
    pendente: { tomou: 'confirmar_pendente', nao_tomou: 'nao_tomado', ainda_nao: 'ainda_nao' },
    nao_informado: { tomou: 'confirmar_retroativa', nao_tomou: 'nao_tomado', ainda_nao: 'nao_tomado' },
    sem_estoque: { tomou: 'confirmar_sem_estoque', nao_tomou: 'manter_sem_estoque', ainda_nao: 'manter_sem_estoque' },
    confirmado: { desfazer: 'reverter', tomou: 'ja_registrada' },
    nao_tomado: { tomou: 'corrigir_para_tomada', nao_tomou: 'ja_registrada', ainda_nao: 'ja_registrada' }
};

// Fato que o banco JÁ registra ("tomei todos" cobrindo também doses já
// confirmadas): nada a escrever, e o turno não cai por isso — só as outras
// doses do mesmo relato são executadas.
const JA_REGISTRADA = 'ja_registrada';
// Fatos que não escrevem nada no banco.
const SEM_ESCRITA = new Set([JA_REGISTRADA, 'ainda_nao']);

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

// Devolve { texto, convite, nivel } — `convite` diz se o texto é o CONVITE de
// estoque (P1-ajustes §4: a retomada da coleta de estoque não repete o
// convite); `nivel` alimenta o fato alerta_estoque do compositor (v47 Onda 1).
async function alertaEstoquePosConfirmacao(medicationId) {
    try {
        const estoqueInfo = await getEstoqueInfoParaAlerta(medicationId);
        if (!estoqueInfo) return { texto: '', convite: false, nivel: null };
        const confirmacoesDoDia = await contarConfirmacoesHoje(medicationId);
        if (estoqueInfo.estoqueDesconhecido) {
            // Estoque nunca informado (ou contestado): CONVITE, só na 1ª do dia.
            return confirmacoesDoDia <= 1
                ? { texto: renderizarCanonico('convite_estoque', { estoqueInfo }), convite: true, nivel: null }
                : { texto: '', convite: false, nivel: null };
        }
        const deveAlertar = calcularAlertaEstoque({
            diasRestantes: estoqueInfo.diasRestantes,
            tipo_tratamento: estoqueInfo.tipo_tratamento,
            tratamento_dias: estoqueInfo.tratamento_dias,
            diasRestantesTratamento: estoqueInfo.diasRestantesTratamento,
            confirmacoesDoDia
        });
        if (!deveAlertar) return { texto: '', convite: false, nivel: null };
        return {
            texto: renderizarCanonico('alerta_estoque', { contexto: 'pos_confirmacao', estoqueInfo }),
            convite: false,
            nivel: classificarNivelEstoquePorDias({ novoEstoque: estoqueInfo.novoEstoque, diasRestantes: estoqueInfo.diasRestantes })
        };
    } catch (e) {
        console.error('⚠️ Erro ao verificar alerta de estoque pós-confirmação:', e.message);
        return { texto: '', convite: false, nivel: null };
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

// P1-copy §2.1 — abertura variável (lista fechada, aprovada em 26/09). O
// código escolhe uma DIFERENTE da última confirmação daquela pessoa; o fato
// que vem depois dela é fixo. Nenhuma chamada de LLM.
export const ABERTURAS_CONFIRMACAO = ['Boa', 'Perfeito', 'Isso aí', 'Que bom', 'Tudo certo', 'Show'];
// P1-ajustes 2 §2: a mesma abertura abre a atualização de estoque ("! 📦").
const RE_ABERTURA = new RegExp(`^(${ABERTURAS_CONFIRMACAO.join('|')})(?:, [^!\\n]+)?! (?:✅|📦)`);

export function aberturaUsada(texto) {
    return String(texto || '').match(RE_ABERTURA)?.[1] ?? null;
}

export function escolherAbertura({ nome, ultima = null, sorteio = Math.random }) {
    const candidatas = ABERTURAS_CONFIRMACAO.filter(a => a !== ultima);
    const base = candidatas[Math.floor(sorteio() * candidatas.length)] || ABERTURAS_CONFIRMACAO[0];
    return nome ? `${base}, ${nome}!` : `${base}!`;
}

export async function ultimaAberturaDoUsuario(userId) {
    try {
        const respostas = await getUltimasRespostasDaNami(userId, 20);
        for (const r of respostas) {
            const a = aberturaUsada(r);
            if (a) return a;
        }
    } catch (e) {
        console.error('⚠️ Erro ao ler a última abertura de confirmação:', e.message);
    }
    return null;
}

// §6.3: o texto sai de uma leitura do banco DEPOIS da gravação e diz qual
// dose e de qual dia. Devolve duas partes: `antes` (confirmações, com a
// abertura) e `depois` (fatos negativos, que seguem o acolhimento do principal).
// v47 Onda 1: devolve também os FATOS TIPADOS pós-escrita (§1 do briefing do
// compositor) — este módulo é o produtor de fatos E o dono da renderização
// canônica; o texto daqui é o fallback determinístico da composição.
async function montarTextoPosEscrita({ executados, jaRegistradas = [], user, semAlertaPara = new Set() }) {
    const lidas = await getDosesPorIds([...executados, ...jaRegistradas].map(p => p.id));
    const porId = new Map(lidas.map(d => [d.id, d]));
    const nome = primeiroNome(user);

    const confirmadas = executados.filter(p => p.fato === 'tomou' && porId.get(p.id)?.status === 'confirmado');
    const naoTomadas = executados.filter(p => p.acao === 'nao_tomado' && porId.get(p.id)?.status === 'nao_tomado');
    const desfeitas = executados.filter(p => p.fato === 'desfazer' && porId.get(p.id)?.status !== 'confirmado');
    const jaConfirmadas = jaRegistradas.filter(p => p.fato === 'tomou').map(p => porId.get(p.id)).filter(Boolean);

    // Fatos tipados — cada um com os dados prontos (rótulo de dia/hora por
    // código, BUG-059) e o fragmento canônico correspondente.
    const fatos = [];
    const fatoDeDose = (p, extras = {}) => {
        const d = porId.get(p.id);
        return {
            sujeito: 'usuario',
            medicamento: d?.medications?.nome || 'seu remédio',
            medicationId: p.medicationId,
            doseLogId: p.id,
            quando: d ? quandoDaDose(d) : null,
            canonico: d ? descreverDose(d) : '',
            ...extras
        };
    };
    for (const p of confirmadas) {
        fatos.push(fatoDeDose(p, {
            tipo: 'dose_confirmada',
            retroativa: ['confirmar_retroativa', 'corrigir_para_tomada', 'confirmar_sem_estoque'].includes(p.acao),
            corrigida: p.acao === 'corrigir_para_tomada',
            semEstoque: p.acao === 'confirmar_sem_estoque',
            contestado: !!p.contestado
        }));
    }
    for (const p of desfeitas) {
        fatos.push(fatoDeDose(p, { tipo: 'dose_revertida', statusDevolvido: porId.get(p.id)?.status }));
    }
    for (const p of naoTomadas) {
        fatos.push(fatoDeDose(p, { tipo: 'dose_nao_tomada', canonico: renderizarCanonico('dose_nao_tomada', { dose: porId.get(p.id) }) }));
    }
    for (const p of jaRegistradas.filter(x => x.fato === 'tomou')) {
        if (porId.get(p.id)) fatos.push(fatoDeDose(p, { tipo: 'dose_ja_registrada' }));
    }

    const antes = [];
    const abriu = confirmadas.length > 0;
    if (confirmadas.length) {
        const abertura = escolherAbertura({ nome, ultima: await ultimaAberturaDoUsuario(user.id) });
        antes.push(renderizarCanonico('dose_confirmada', {
            abertura,
            confirmadas: confirmadas.map(p => porId.get(p.id)),
            jaRegistradas: jaConfirmadas
        }));
    }
    if (desfeitas.length) {
        antes.push(renderizarCanonico('dose_revertida', { doses: desfeitas.map(p => porId.get(p.id)) }));
    }
    const depois = naoTomadas.map(p => renderizarCanonico('dose_nao_tomada', { dose: porId.get(p.id) }));

    // Estoque: alerta/convite de template, uma vez por medicamento confirmado —
    // exceto o que tem ação de estoque no MESMO turno (a recompra escreve o
    // número depois; o convite de "não tenho o estoque" a contradiria).
    // §7: estoque contestado neste turno → convite próprio.
    let alertas = '';
    const convitesEstoque = new Set();
    const contestados = new Set(confirmadas.filter(p => p.contestado).map(p => p.medicationId));
    for (const medId of [...new Set(confirmadas.map(p => p.medicationId))].filter(id => !semAlertaPara.has(id))) {
        const dose = porId.get(confirmadas.find(p => p.medicationId === medId).id);
        const medNome = dose?.medications?.nome || 'seu remédio';
        if (contestados.has(medId)) {
            const fragmento = renderizarCanonico('convite_estoque', { motivo: 'estoque_contestado', medNome });
            alertas += fragmento;
            convitesEstoque.add(medId);
            fatos.push({ tipo: 'convite_estoque', motivo: 'estoque_contestado', sujeito: 'usuario', medicamento: medNome, medicationId: medId, canonico: fragmento.trim() });
        } else {
            const alerta = await alertaEstoquePosConfirmacao(medId);
            alertas += alerta.texto;
            if (alerta.convite) {
                convitesEstoque.add(medId);
                fatos.push({ tipo: 'convite_estoque', motivo: 'estoque_nao_informado', sujeito: 'usuario', medicamento: medNome, medicationId: medId, canonico: alerta.texto.trim() });
            } else if (alerta.texto) {
                fatos.push({ tipo: 'alerta_estoque', nivel: alerta.nivel, sujeito: 'usuario', medicamento: medNome, medicationId: medId, canonico: alerta.texto.trim() });
            }
        }
    }
    return { antes: antes.join('\n\n') + alertas, depois: depois.join('\n'), convitesEstoque, abriu, fatos };
}

// Executa os fatos relatados (pelo principal ou pelo atalho). Tudo ou nada
// na validação; texto final só de leitura pós-escrita.
export async function executarFatosDeDose({ user, fatos, mapa, semAlertaPara = new Set() }) {
    if (!fatos?.length) return { ok: true, texto: '', textoDepois: '', executados: [], fatosDoTurno: [] };

    const validacao = validarFatos(fatos, mapa);
    if (!validacao.ok) {
        await degradar({
            origem: 'principal', motivo: 'ref_dose_invalida', agent: 'principal', userId: user.id,
            detalhe: { motivo: validacao.motivo, fatos }, fallback: null
        });
        return { ok: false, motivo: validacao.motivo, texto: '', textoDepois: '', executados: [], fatosDoTurno: [] };
    }

    const jaRegistradas = validacao.planos.filter(p => p.acao === JA_REGISTRADA);
    const aindaNao = validacao.planos.filter(p => p.acao === 'ainda_nao');
    if (jaRegistradas.length) console.log(`💊 [DOSES] já registradas, ignoradas: ${jaRegistradas.map(p => `${p.ref}:${p.fato}`).join(', ')} — ${user.phone}`);
    if (aindaNao.length) console.log(`💊 [DOSES] ainda não — dose segue pendente: ${aindaNao.map(p => p.ref).join(', ')} — ${user.phone}`);
    const planos = validacao.planos.filter(p => !SEM_ESCRITA.has(p.acao));
    if (planos.length === 0) {
        return { ok: true, texto: '', textoDepois: '', executados: [], fatosDoTurno: [], soJaRegistradas: aindaNao.length === 0, soAindaNao: aindaNao.length > 0 };
    }

    const executados = [];
    for (const plano of planos) {
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
    if (executados.length === 0) return { ok: false, motivo: 'nenhuma_dose_executada', texto: '', textoDepois: '', executados, fatosDoTurno: [] };

    console.log(`💊 [DOSES] ${executados.map(p => `${p.ref}:${p.fato}`).join(', ')} — ${user.phone}`);
    const { antes, depois, convitesEstoque, abriu, fatos: fatosDoTurno } = await montarTextoPosEscrita({ executados, jaRegistradas, user, semAlertaPara });
    // v47 Onda 1: "ainda não" não escreve nada, mas é fato do turno — o
    // compositor precisa saber que a dose segue aberta (a porta fica aberta).
    for (const p of aindaNao) {
        fatosDoTurno.push({ tipo: 'ainda_nao', sujeito: 'usuario', medicamento: p.nome || 'seu remédio', medicationId: p.medicationId, doseLogId: p.id, canonico: '' });
    }
    return { ok: true, texto: antes, textoDepois: depois, executados, fatosDoTurno, convitesEstoque, abriu };
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
