// ============================================================
// ARNÊS — casos-ouro (briefing v44 §3)
//
// Cada caso reproduz uma conversa REAL de agent_logs de produção
// (datas indicadas), como replay multi-turno contra o código atual,
// com asserções determinísticas sobre o texto final e o banco.
//
// Fonte: transcrições extraídas de agent_logs em 19/09/2026.
// NUNCA usar classificações do juizOffline como evidência (decisão v44).
//
// Cada checagem tem um marco; checagem de marco acima do alvo da
// execução falha como "conhecido" (expected-fail), nunca como regressão.
// ============================================================

import {
    umaPerguntaNaUltimaLinha, semNegritoMarkdown, contem, naoContem,
    numeroDeEstoqueConfere, blocosDeEstoque,
    estadoDaConversa, medicamentos, doseLogs, turnosLogados
} from './asserts.js';

let contadorTurno = 0;

async function turno(ctx, user, mensagem, extras = {}) {
    contadorTurno++;
    const resposta = await ctx.routeMessage({
        user,
        message: mensagem,
        image: null,
        messageId: `arnes-${Date.now()}-${contadorTurno}`,
        referenceMessageId: extras.referenceMessageId || null
    });
    // v44 §5.5: routeMessage devolve { texto, agente, agentLogId }.
    if (resposta == null) return '';
    return typeof resposta === 'string' ? resposta : (resposta.texto ?? '');
}

// Checagens de forma da Constituição (regras 8 e 9) — aplicadas a toda resposta.
function checagensDeForma(checks, rotuloTurno, resposta) {
    checks.push({ nome: `${rotuloTurno}: uma pergunta, na última linha`, ...umaPerguntaNaUltimaLinha(resposta) });
    checks.push({ nome: `${rotuloTurno}: sem negrito markdown (**)`, ...semNegritoMarkdown(resposta) });
}

export const CASOS = [

    // --------------------------------------------------------
    {
        id: 'A1',
        marco: 'M1',
        titulo: 'Sid 18/09 — mensagem rica única ("Minoxidil 3mg, 1 comprimido às 21h")',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Sid', onboarded: true, nascimento: '1986-10-10', estado: 'post_onboarding' });

            const r1 = await turno(ctx, user, 'Minoxidil 3mg, 1 comprimido às 21h');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ nome: 'turno 1: não repergunta o nome do medicamento', ...naoContem(r1, /qual o \*?nome\*?/i, 'repergunta de nome') });
            checks.push({ nome: 'turno 1: não repergunta horários', ...naoContem(r1, /quais .{0,12}hor[áa]rios/i, 'repergunta de horários') });
            checks.push({ nome: 'turno 1: não repergunta quantidade', ...naoContem(r1, /\*?quanto\*? de/i, 'repergunta de quantidade') });

            const meds1 = await medicamentos(ctx.db, user.id, { nomeIlike: 'Minoxidil%' });
            const gravado = meds1.length === 1;
            checks.push({ nome: 'turno 1: medicamento gravado (cadastro em ≤2 turnos)', ok: gravado, detalhe: `${meds1.length} linha(s) em medications` });
            if (gravado) {
                const horarios = (meds1[0].schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5));
                checks.push({ nome: 'turno 1: schedule único às 21:00', ok: horarios.length === 1 && horarios[0] === '21:00', detalhe: `horários: ${horarios.join(', ') || 'nenhum'}` });
            }
            checks.push({
                nome: 'turno 1: confirmação declarativa (regra 2 — nome + "cadastrado" + lembrete, nunca só "Anotei")',
                ...((/minoxidil/i.test(r1) && /cadastrad/i.test(r1) && /lembr/i.test(r1))
                    ? { ok: true, detalhe: 'declarativa e completa' }
                    : { ok: false, detalhe: `resposta: "${r1.slice(0, 120)}..."` })
            });

            const r2 = await turno(ctx, user, '30');
            checagensDeForma(checks, 'turno 2', r2);
            const meds2 = await medicamentos(ctx.db, user.id, { nomeIlike: 'Minoxidil%' });
            checks.push({ nome: 'turno 2: estoque gravado = 30', ok: Number(meds2[0]?.estoque_atual) === 30, detalhe: `estoque_atual: ${meds2[0]?.estoque_atual}` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A2',
        marco: 'M1',
        titulo: 'Thaielly 18/09 16:19 — 4 medicamentos + "8h" em post_onboarding',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Thaielly', onboarded: true, nascimento: '1992-02-15', estado: 'post_onboarding' });
            const mensagemRica = 'Lamotrigina 100mg\nRosovastatina \nDesvelafaxina \nVitamina D \n\n8h';

            const r1 = await turno(ctx, user, mensagemRica);
            checagensDeForma(checks, 'turno 1', r1);
            // Regra 3: nada do que a pessoa disse é ignorado — os 4 nomes reconhecidos.
            checks.push({ nome: 'turno 1: reconhece Lamotrigina', ...contem(r1, /lamotrigina/i, 'Lamotrigina') });
            checks.push({ nome: 'turno 1: reconhece Rosuvastatina', ...contem(r1, /ros[ou]?vastatina/i, 'Rosuvastatina (como escrita ou corrigida)') });
            checks.push({ nome: 'turno 1: reconhece Desvenlafaxina', ...contem(r1, /desve[nl]?lafaxina/i, 'Desvenlafaxina') });
            checks.push({ nome: 'turno 1: reconhece Vitamina D', ...contem(r1, /vitamina d/i, 'Vitamina D') });
            // Regra 6: nunca afirmar o que não foi executado neste turno.
            const medsAntes = await medicamentos(ctx.db, user.id);
            if (medsAntes.length === 0) {
                checks.push({ nome: 'turno 1: não afirma cadastro sem linha no banco (P56)', ...naoContem(r1, /cadastrad[oa]s?|registrad[oa]s?|tudo (anotado|certo|salvo)/i, 'afirmação de persistência') });
            }

            const r2 = await turno(ctx, user, 'Sim');
            checagensDeForma(checks, 'turno 2', r2);
            // P57: o "sim" não pode fazer a pessoa repetir o que já disse.
            checks.push({ nome: 'turno 2: não repergunta o nome do 1º medicamento', ...naoContem(r2, /qual o \*?nome\*?/i, 'repergunta de nome') });
            checks.push({ nome: 'turno 2: não repergunta o horário já dado (8h)', ...naoContem(r2, /quais .{0,12}hor[áa]rios/i, 'repergunta de horários') });

            // M2 (pleno): os 4 registrados.
            const medsDepois = await medicamentos(ctx.db, user.id);
            checks.push({ marco: 'M2', nome: 'M2: os 4 medicamentos registrados', ok: medsDepois.length === 4, detalhe: `${medsDepois.length} medicamento(s) no banco` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A3',
        marco: 'M1',
        titulo: 'Manô 18/09 15:26 — "seg a sexta às 6h, sáb e dom às 10h" (recorrência não suportada)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Manô', onboarded: true, nascimento: '2006-07-24', estado: 'post_onboarding' });

            const r1 = await turno(ctx, user, 'Desvenlafaxina 50mg, 3 comprimidos, segunda à sexta às 6h, sábado e domingo ás 10h');
            checagensDeForma(checks, 'turno 1', r1);

            // NUNCA gravar os dois horários como diários (limite: mesmos horários todos os dias).
            const meds1 = await medicamentos(ctx.db, user.id);
            const horarios1 = meds1.flatMap(m => (m.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5)));
            checks.push({
                nome: 'turno 1: NUNCA grava 06:00 e 10:00 como horários diários',
                ok: !(horarios1.includes('06:00') && horarios1.includes('10:00')),
                detalhe: `horários gravados: ${horarios1.join(', ') || 'nenhum'}`
            });
            // Resposta honesta de limite (regras 6/7), sem gravação errada em silêncio.
            checks.push({ nome: 'turno 1: resposta honesta de limite (ainda não faz dias da semana)', ...contem(r1, /ainda não|por enquanto|todos os dias/i, 'honestidade de limite') });
            checks.push({ nome: 'turno 1: oferece o subconjunto representável', ...contem(r1, /6\s*h|06:00/i, 'oferta do horário representável') });

            // Consentimento do subconjunto → grava só 06:00.
            const r2 = await turno(ctx, user, 'Pode ser às 6h todos os dias então');
            checagensDeForma(checks, 'turno 2', r2);
            const meds2 = await medicamentos(ctx.db, user.id);
            const horarios2 = meds2.flatMap(m => (m.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5)));
            checks.push({
                nome: 'turno 2: grava só o subconjunto consentido (06:00)',
                ok: horarios2.length === 1 && horarios2[0] === '06:00',
                detalhe: `horários gravados: ${horarios2.join(', ') || 'nenhum'}`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A4',
        marco: 'M1',
        titulo: 'Manô 19/09 09:58 — "sim" com dose pendente durante adding_med (regra 5)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Manô', onboarded: true, estado: 'post_onboarding' });

            // Chega ao ponto real: cadastro gravado, coleta de estoque pendente.
            await turno(ctx, user, 'Desvenlafaxina 50mg, 3 comprimidos às 10h');
            const meds = await medicamentos(ctx.db, user.id, { nomeIlike: 'Desvenlafaxina%' });
            if (meds.length !== 1) {
                return [{ nome: 'setup: medicamento gravado no turno 1', ok: false, detalhe: `${meds.length} linha(s) — replay não alcançou o estado do caso` }];
            }
            const schedule = (meds[0].schedules || [])[0] || null;
            const dose = await seeds.criarDosePendente({
                medicationId: meds[0].id,
                scheduleId: schedule?.id ?? null,
                horario: schedule ? String(schedule.horario).slice(0, 5) : '10:00'
            });

            const r2 = await turno(ctx, user, 'sim');
            checagensDeForma(checks, 'turno "sim"', r2);

            const logsDose = await doseLogs(ctx.db, meds[0].id);
            const doseDepois = logsDose.find(d => d.id === dose.id);
            checks.push({ nome: 'dose confirmada no banco (confirmação vence coleta)', ok: doseDepois?.confirmed === true, detalhe: `confirmed: ${doseDepois?.confirmed}, status: ${doseDepois?.status}` });
            checks.push({ nome: 'resposta reconhece a dose confirmada', ...contem(r2, /dose|confirmad|anotei|✅/i, 'reconhecimento da dose') });
            checks.push({ nome: 'coleta retomada depois (estado continua adding_med)', ...(await estadoDaConversa(ctx.db, user.id, 'adding_med')) });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A5',
        marco: 'M1',
        titulo: 'Eloísa/Wellington/Flávia 18/09 — confirmação de dose com estoque baixo (autor único do número)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Eloísa', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({
                userId: user.id, nome: 'Desogestrel', dosagem: '75mcg',
                estoque: 4, horarios: ['08:00'], quantidadePorDose: 1
            });
            await seeds.criarDosePendente({ medicationId: med.id, scheduleId: schedules[0].id, horario: '08:00' });

            const r1 = await turno(ctx, user, 'Sim');
            checagensDeForma(checks, 'turno 1', r1);

            const nBlocos = blocosDeEstoque(r1);
            checks.push({ nome: 'exatamente UM bloco de estoque na mensagem', ok: nBlocos === 1, detalhe: `${nBlocos} bloco(s) de estoque (esperado exatamente 1 com estoque baixo)` });

            const { data: medDepois } = await ctx.db.from('medications').select('estoque_atual').eq('id', med.id).single();
            checks.push({ nome: 'número do bloco == leitura pós-débito do banco', ...numeroDeEstoqueConfere(r1, medDepois?.estoque_atual) });

            // Regra 2: o segmento redigido pela LLM (antes do bloco de template) não carrega números de estado.
            const posicaoBloco = r1.search(/(\*Lembrete de estoque:\*|🚨 \*Atenção:\*|⚠️ \*Atenção:\*|📦 )/);
            const segmentoLLM = posicaoBloco === -1 ? r1 : r1.slice(0, posicaoBloco);
            checks.push({ nome: 'segmento da LLM sem números de estoque/dias', ...naoContem(segmentoLLM, /\d+\s*(unidade|comprimido|dia)/i, 'número de estado no texto da LLM') });

            const logsDose = await doseLogs(ctx.db, med.id);
            checks.push({ nome: 'dose confirmada no banco', ok: logsDose.some(d => d.confirmed === true), detalhe: `status: ${logsDose.map(d => d.status).join(', ')}` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A6',
        marco: 'M1',
        titulo: 'Carla 18/09 — "Depois faço isso" na pergunta de estoque (verdade do banco)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Carla', onboarded: true, nascimento: '1983-06-15', estado: 'post_onboarding' });

            await turno(ctx, user, 'Vitamina, 1 comprimido, 13:40');
            const meds = await medicamentos(ctx.db, user.id, { nomeIlike: 'Vitamina%' });
            if (meds.length !== 1) {
                return [{ nome: 'setup: medicamento gravado no turno 1', ok: false, detalhe: `${meds.length} linha(s) — replay não alcançou o estado do caso` }];
            }

            const r2 = await turno(ctx, user, 'Depois faço isso');
            checagensDeForma(checks, 'turno 2', r2);
            checks.push({ nome: 'resposta afirma que o medicamento ESTÁ cadastrado', ...contem(r2, /cadastrad|registrad|lembrete/i, 'afirmação do que já está no banco') });
            checks.push({ nome: 'resposta NÃO nega o cadastro já feito ("parei/cancelei o cadastro")', ...naoContem(r2, /parei o cadastro|cancelei o cadastro|cancelei/i, 'negação do cadastro existente') });

            const { data: medDepois } = await ctx.db.from('medications').select('ativo, estoque_atual').eq('id', meds[0].id).single();
            checks.push({ nome: 'medicamento continua ativo (lembretes valem)', ok: medDepois?.ativo === true, detalhe: `ativo: ${medDepois?.ativo}` });
            checks.push({ nome: 'estoque continua não informado (NULL, nunca 0) — P49', ok: medDepois?.estoque_atual === null, detalhe: `estoque_atual: ${medDepois?.estoque_atual}` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A7',
        marco: 'M1',
        titulo: 'LGPD (João, staging 18/09 06:36) — forma da mensagem de consentimento',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: null, onboarded: false, estado: 'idle' });

            await turno(ctx, user, 'oi');
            const r2 = await turno(ctx, user, 'Ana');

            checagensDeForma(checks, 'consentimento', r2);
            // Formato lista: nome, telefone e data de nascimento como itens em linhas próprias,
            // cada um aberto por emoji semântico — independente do nome do usuário.
            const linhas = r2.split('\n').map(l => l.trim());
            for (const item of ['nome', 'telefone', 'nascimento']) {
                const linha = linhas.find(l => l.toLowerCase().includes(item));
                const emLinhaPropria = !!linha && !/[.?!]\s+\w+.*[.?!]/.test(linha);
                const abreComEmoji = !!linha && !/^[a-zà-úA-ZÀ-Ú*"']/.test(linha);
                checks.push({
                    nome: `item "${item}" em linha própria aberta por emoji`,
                    ok: emLinhaPropria && abreComEmoji,
                    detalhe: linha ? `linha: "${linha.slice(0, 60)}"` : `"${item}" não aparece como item de lista`
                });
            }
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A8',
        marco: 'M1',
        titulo: 'Áudio recebido — recusa da lista AINDA_NAO, dentro do pipeline e registrada',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Teste Áudio', onboarded: true, estado: 'idle' });

            const antes = ctx.enviosCapturados.length;
            await ctx.handleIncomingMessage({
                phone: user.phone, text: null, audio: 'https://exemplo.invalido/audio.ogg',
                image: null, messageId: `arnes-audio-${Date.now()}`, referenceMessageId: null
            });

            const enviados = ctx.enviosCapturados.slice(antes);
            checks.push({ nome: 'recusa sai pelo funil (mock capturou o envio)', ok: enviados.length === 1, detalhe: `${enviados.length} envio(s) capturado(s)${ctx.funilMockado ? '' : ' — funil ainda não existe'}` });
            if (enviados.length === 1) {
                checks.push({ nome: 'recusa menciona áudio com honestidade de expectativa', ...contem(enviados[0].texto, /áudio/i, 'menção a áudio') });
                checagensDeForma(checks, 'recusa', enviados[0].texto);
            }

            const logs = await turnosLogados(ctx.db, user.id);
            checks.push({ nome: 'turno de áudio registrado em agent_logs (hoje é invisível)', ok: logs.length >= 1, detalhe: `${logs.length} linha(s) em agent_logs` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A9',
        marco: 'M2',
        titulo: 'João Pedro 18/09 15:52 — "Na verdade 9 no estoque" pós-pergunta de estoque (BUG-103)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'João Pedro', onboarded: true, nascimento: '2006-10-31', estado: 'post_onboarding' });

            await turno(ctx, user, 'Roacutan 20mg, 1 comprimido, 6:30');
            await turno(ctx, user, '10');
            const r3 = await turno(ctx, user, 'Na verdade 9 no estoque');

            const meds = await medicamentos(ctx.db, user.id, { nomeIlike: 'Roacutan%' });
            checks.push({ marco: 'M2', nome: 'correção aceita no mesmo turno (estoque = 9)', ok: Number(meds[0]?.estoque_atual) === 9, detalhe: `estoque_atual: ${meds[0]?.estoque_atual}` });
            checks.push({ marco: 'M2', nome: 'não repete a pergunta de estoque ignorando a correção', ...naoContem(r3, /quantos comprimidos de Roacutan você tem/i, 'repergunta de estoque') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A10',
        marco: 'M4',
        titulo: 'Felipe 18/09 12:02 — data de nascimento junto do nome (não reperguntar)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: null, onboarded: false, estado: 'idle' });

            await turno(ctx, user, 'Oi! Quero conhecer a Nami (folheto)');
            await turno(ctx, user, 'Felipe Piva Silva\n19 99686 3809\n19/03/2008');
            const r3 = await turno(ctx, user, 'Concordo');

            const { data: userDepois } = await ctx.db.from('users').select('data_nascimento').eq('id', user.id).single();
            const aproveitou = userDepois?.data_nascimento === '2008-03-19';
            const reperguntou = /data de nascimento/i.test(r3);
            checks.push({
                marco: 'M4',
                nome: 'data de nascimento fornecida não é reperguntada',
                ok: aproveitou || !reperguntou,
                detalhe: `data no banco: ${userDepois?.data_nascimento ?? 'nenhuma'}; resposta ${reperguntou ? 'repergunta' : 'não repergunta'} a data`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A11',
        marco: 'M1',
        titulo: 'Guilherme 19/09 (staging) — novo cadastro com coleta de estoque do anterior pendente',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'post_onboarding' });

            // Chega ao ponto real: 1º medicamento gravado, coleta de estoque pendente.
            await turno(ctx, user, 'Desvenlafaxina 50mg, 3 comprimidos às 6h');
            const medsAntes = await medicamentos(ctx.db, user.id, { nomeIlike: 'Desvenlafaxina%' });
            if (medsAntes.length !== 1) {
                return [{ nome: 'setup: 1º medicamento gravado no turno 1', ok: false, detalhe: `${medsAntes.length} linha(s) — replay não alcançou o estado do caso` }];
            }

            // Evidência real: a Nami repetiu a pergunta de estoque da Desvenlafaxina
            // e ignorou a Losartana inteira (2x, mesmo com "Quero cadastrar...").
            const r2 = await turno(ctx, user, 'Losartana 50mg, 1cp às 13:32');
            checagensDeForma(checks, 'turno 2', r2);
            checks.push({ nome: 'turno 2: nada ignorado — responde sobre a Losartana (regra 3)', ...contem(r2, /losartana/i, 'Losartana') });
            checks.push({ nome: 'turno 2: não repete o convite de estoque do anterior', ...naoContem(r2, /quantos .{0,30}Desvenlafaxina|cadastrar o estoque do \*?Desvenlafaxina/i, 'convite de estoque do anterior') });

            const losartana = await medicamentos(ctx.db, user.id, { nomeIlike: 'Losartana%' });
            const horariosLosartana = losartana.flatMap(m => (m.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5)));
            checks.push({
                nome: 'turno 2: Losartana gravada com schedule 13:32',
                ok: losartana.length === 1 && horariosLosartana.includes('13:32'),
                detalhe: `${losartana.length} linha(s); horários: ${horariosLosartana.join(', ') || 'nenhum'}`
            });

            const desven = await medicamentos(ctx.db, user.id, { nomeIlike: 'Desvenlafaxina%' });
            checks.push({
                nome: 'anterior continua ativo, estoque não informado (NULL — P49)',
                ok: desven[0]?.ativo === true && desven[0]?.estoque_atual === null,
                detalhe: `ativo: ${desven[0]?.ativo}, estoque_atual: ${desven[0]?.estoque_atual}`
            });
            checks.push({ nome: 'coleta segue no cadastro novo (estado adding_med)', ...(await estadoDaConversa(ctx.db, user.id, 'adding_med')) });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A12',
        marco: 'M1',
        titulo: 'Quantidades diferentes por horário ("1 cp às 7 e 2 cps às 18h") — o schema já representa',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'post_onboarding' });

            const r1 = await turno(ctx, user, 'Enalapril 10mg, 1 comprimido às 7h e 2 comprimidos às 18h');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ nome: 'turno 1: não repergunta horários nem quantidade', ...naoContem(r1, /quais .{0,12}hor[áa]rios|quanto de enalapril/i, 'repergunta de posologia') });

            const meds = await medicamentos(ctx.db, user.id, { nomeIlike: 'Enalapril%' });
            const schedules = (meds[0]?.schedules || []).filter(s => s.ativo)
                .map(s => ({ horario: String(s.horario).slice(0, 5), quantidade: Number(s.quantidade_por_dose) }))
                .sort((a, b) => a.horario.localeCompare(b.horario));
            checks.push({
                nome: 'turno 1: gravado 07:00 com 1 e 18:00 com 2 (quantidade POR horário)',
                ok: meds.length === 1 && schedules.length === 2
                    && schedules[0].horario === '07:00' && schedules[0].quantidade === 1
                    && schedules[1].horario === '18:00' && schedules[1].quantidade === 2,
                detalhe: `schedules: ${JSON.stringify(schedules)}`
            });
            return checks;
        }
    }
];
