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
        id: 'A0',
        marco: 'M2',
        titulo: 'Guardas de construção do M2 (grep-guards §8.2 + ACH-3 vivo + ACH-4)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const fs = await import('node:fs');
            const path = await import('node:path');
            const url = await import('node:url');
            const raizSrc = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../src');

            const arquivos = [];
            (function varrer(dir) {
                for (const nome of fs.readdirSync(dir)) {
                    const p = path.join(dir, nome);
                    if (fs.statSync(p).isDirectory()) varrer(p);
                    else if (p.endsWith('.js')) arquivos.push(p);
                }
            })(raizSrc);
            const conteudo = new Map(arquivos.map(p => [path.relative(raizSrc, p), fs.readFileSync(p, 'utf8')]));

            // Grep-guard 1: nenhum sendTextMessage fora de whatsapp.js/funil.js.
            const violadoresEnvio = [...conteudo.entries()]
                .filter(([f, c]) => !['whatsapp.js', 'funil.js'].includes(f) && /sendTextMessage/.test(c))
                .map(([f]) => f);
            checks.push({ nome: 'grep: nenhum sendTextMessage fora de whatsapp.js/funil.js', ok: violadoresEnvio.length === 0, detalhe: violadoresEnvio.join(', ') || 'limpo' });

            // Grep-guard 2 (BUG-102): cad_confirma_forma não existe mais em src/.
            const violadoresForma = [...conteudo.entries()]
                .filter(([, c]) => /cad_confirma_forma/.test(c)).map(([f]) => f);
            checks.push({ nome: 'grep (BUG-102): cad_confirma_forma morto por construção', ok: violadoresForma.length === 0, detalhe: violadoresForma.join(', ') || 'limpo' });

            // Grep-guard 3: escrita em schedules só em database.js (saveSchedule
            // ponto único; os demais usos são update/delete de configuração lá).
            const violadoresSchedules = [...conteudo.entries()]
                .filter(([f, c]) => f !== 'database.js' && /from\(['"]schedules['"]\)\s*[\s\S]{0,80}?\.insert\(/.test(c))
                .map(([f]) => f);
            checks.push({ nome: 'grep (ACH-3): insert em schedules só em database.js', ok: violadoresSchedules.length === 0, detalhe: violadoresSchedules.join(', ') || 'limpo' });

            // Grep-guard 4: perguntas de coleta do cadastro só no schema.
            const violadoresPergunta = [...conteudo.entries()]
                .filter(([f, c]) => f !== path.join('schemas', 'cadastro.js')
                    && /Qual o \*nome\* d|quanto você toma ou usa por vez/i.test(c))
                .map(([f]) => f);
            checks.push({ nome: 'grep (MH-85/P54): pergunta de coleta só no schema', ok: violadoresPergunta.length === 0, detalhe: violadoresPergunta.join(', ') || 'limpo' });

            // ACH-3 vivo: saveSchedule recusa horário duplicado do mesmo medicamento.
            const user = await seeds.criarUsuario({ nome: 'Guarda', onboarded: true, estado: 'idle' });
            const { med } = await seeds.criarMedicamento({ userId: user.id, nome: 'Guarda ACH3', horarios: ['08:00'] });
            const { saveSchedule } = await import('../src/database.js');
            await saveSchedule({ medicationId: med.id, horario: '08:00', quantidadePorDose: 2 });
            const { data: schedules } = await ctx.db.from('schedules').select('id, horario').eq('medication_id', med.id);
            checks.push({
                nome: 'ACH-3: segundo saveSchedule no mesmo horário NÃO duplica',
                ok: (schedules || []).length === 1,
                detalhe: `${(schedules || []).length} schedule(s) para o mesmo horário`
            });

            // ACH-4: dosagem tem validador de formato — ponto único ehDosagemPura.
            const { ehDosagemPura, ehDosagemReconhecivel } = await import('../src/validadores/camposSimples.js');
            checks.push({
                nome: 'ACH-4: "1000mg" é dosagem pura (nunca nome); "Caltrat D" não é',
                ok: ehDosagemPura('1000mg') && ehDosagemPura('0,5%') && !ehDosagemPura('Caltrat D'),
                detalhe: `1000mg:${ehDosagemPura('1000mg')} 0,5%:${ehDosagemPura('0,5%')} CaltratD:${ehDosagemPura('Caltrat D')}`
            });
            checks.push({
                nome: 'ACH-4: formato de dosagem reconhecível (número+unidade)',
                ok: ehDosagemReconhecivel('50mg') && ehDosagemReconhecivel('100mg/ml') && !ehDosagemReconhecivel('bastante'),
                detalhe: `50mg:${ehDosagemReconhecivel('50mg')} 100mg/ml:${ehDosagemReconhecivel('100mg/ml')} bastante:${ehDosagemReconhecivel('bastante')}`
            });

            // Replay 19/09 (Priscila): "Vitamina D" NUNCA casa dentro de
            // "Vitamina de A a Z" — cada uma na sua linha, grupos distintos.
            const { dividirCandidatos } = await import('../src/validadores/multiMed.js');
            const divisao = dividirCandidatos({
                message: 'Curcuma C \nVitamina de A a Z \nVitamina b12\nVitamina D',
                medicamentosPropostos: ['Curcuma C', 'Vitamina de A a Z', 'Vitamina b12', 'Vitamina D']
            });
            const grupos = divisao.candidatos.map(c => c.grupo);
            checks.push({
                nome: 'divisão multi-med: Vitamina D com linha/grupo PRÓPRIOS (não herda a posologia da A a Z)',
                ok: new Set(grupos).size === 4 && grupos.every(g => g !== null),
                detalhe: `grupos: ${JSON.stringify(divisao.candidatos.map(c => ({ nome: c.nome, grupo: c.grupo })))}`
            });
            // E o caso legítimo de grupo compartilhado (A19) continua agrupando.
            const divisaoA19 = dividirCandidatos({
                message: 'Regenesis e ofolato D',
                medicamentosPropostos: ['Regenesis', 'ofolato D']
            });
            checks.push({
                nome: 'divisão multi-med: nomes na MESMA linha continuam num grupo só (A19)',
                ok: divisaoA19.candidatos[0].grupo === divisaoA19.candidatos[1].grupo && divisaoA19.candidatos[0].grupo !== null,
                detalhe: `grupos: ${JSON.stringify(divisaoA19.candidatos.map(c => c.grupo))}`
            });

            // Replay 19/09-20/09 (Priscila "5gr às 10h"; correção de Guilherme):
            // gramas são POSOLOGIA, nunca dosagem do produto. Convenção pré-MH-93:
            // cada dose em gramas = 1 unidade, POR VALOR (horários com scoop/sachê
            // não são tocados), sem NENHUMA escrita em dosagem.
            const { corrigirDoseEmGramas } = await import('../src/schemas/cadastro.js');
            const decisaoGr = { updates: { pares_posologia: [{ horario: '10:00', quantidade: 5 }], unidade_dose: 'ml', unidade_estoque: 'ml', gotas_por_ml: null } };
            corrigirDoseEmGramas('5gr as 10hrs', decisaoGr);
            checks.push({
                nome: 'gramas são posologia: "5gr às 10h" vira 1 unidade às 10:00, SEM tocar dosagem',
                ok: decisaoGr.updates.pares_posologia[0].quantidade === 1
                    && decisaoGr.updates.unidade_dose === 'unidade'
                    && decisaoGr.updates.dosagem === undefined
                    && decisaoGr.updates.convencao_po_gramas === '5g',
                detalhe: JSON.stringify(decisaoGr.updates)
            });
            // Caso da creatina (Felipe, produção): posologia mista por horário —
            // só o horário cuja quantidade veio dos gramas é coagido.
            const decisaoCreatina = { updates: { pares_posologia: [
                { horario: '10:00', quantidade: 1 }, { horario: '11:00', quantidade: 10 }, { horario: '20:00', quantidade: 1 }
            ], unidade_dose: 'unidade' } };
            corrigirDoseEmGramas('1 scoop às 10h, 10grs às 11h e 1 sachê às 20h', decisaoCreatina);
            checks.push({
                nome: 'gramas por valor: "1 scoop, 10grs, 1 sachê" → só o de 10g vira 1 unidade',
                ok: decisaoCreatina.updates.pares_posologia.every(p => p.quantidade === 1)
                    && decisaoCreatina.updates.pares_posologia.length === 3
                    && decisaoCreatina.updates.dosagem === undefined,
                detalhe: JSON.stringify(decisaoCreatina.updates.pares_posologia)
            });
            const decisaoMg = { updates: { pares_posologia: [{ horario: '08:00', quantidade: 2 }], unidade_dose: 'unidade' } };
            corrigirDoseEmGramas('2 comprimidos de 500mg as 8h', decisaoMg);
            checks.push({
                nome: 'gramas: mg/quantidade legítima NÃO são tocados pela coerção',
                ok: decisaoMg.updates.pares_posologia[0].quantidade === 2 && decisaoMg.updates.dosagem === undefined,
                detalhe: JSON.stringify(decisaoMg.updates)
            });
            return checks;
        }
    },

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
        marco: 'M2',
        titulo: 'Manô 18/09 15:26 — "seg a sexta às 6h, sáb e dom às 10h" (MH-77: recorrência SUPORTADA)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Manô', onboarded: true, nascimento: '2006-07-24', estado: 'post_onboarding' });

            const r1 = await turno(ctx, user, 'Desvenlafaxina 50mg, 3 comprimidos, segunda à sexta às 6h, sábado e domingo ás 10h');
            checagensDeForma(checks, 'turno 1', r1);

            // M2 (MH-77): a mensagem inteira é representável — dois schedules com
            // dias_semana distintos, gravados no MESMO turno, nada de recusa de limite.
            const meds1 = await medicamentos(ctx.db, user.id, { nomeIlike: 'Desvenlafaxina%' });
            const schedules1 = (meds1[0]?.schedules || []).filter(s => s.ativo)
                .map(s => ({ horario: String(s.horario).slice(0, 5), dias: [...(s.dias_semana || [])].sort() }));
            const s06 = schedules1.find(s => s.horario === '06:00');
            const s10 = schedules1.find(s => s.horario === '10:00');

            checks.push({
                nome: 'turno 1: medicamento gravado com os DOIS horários (06:00 e 10:00)',
                ok: meds1.length === 1 && !!s06 && !!s10 && schedules1.length === 2,
                detalhe: `schedules: ${JSON.stringify(schedules1)}`
            });
            checks.push({
                nome: 'turno 1: 06:00 só de segunda a sexta (dias_semana)',
                ok: JSON.stringify(s06?.dias) === JSON.stringify(['qua', 'qui', 'seg', 'sex', 'ter']),
                detalhe: `dias 06:00: ${JSON.stringify(s06?.dias ?? null)}`
            });
            checks.push({
                nome: 'turno 1: 10:00 só sábado e domingo (dias_semana)',
                ok: JSON.stringify(s10?.dias) === JSON.stringify(['dom', 'sab']),
                detalhe: `dias 10:00: ${JSON.stringify(s10?.dias ?? null)}`
            });
            // A honestidade de limite do M1 morreu por capacidade: nada de "ainda não
            // consigo" nem oferta de subconjunto.
            checks.push({ nome: 'turno 1: sem recusa de limite (recorrência agora FAZ)', ...naoContem(r1, /ainda n[ãa]o consigo|mesmos hor[áa]rios todos os dias/i, 'recusa de limite') });
            checks.push({ nome: 'turno 1: confirmação declarativa pós-gravação (regra 2)', ...contem(r1, /cadastrad/i, 'declarativa de cadastro') });
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
            // MH-83 (M2): NADA do cadastro anterior vaza para o novo — a Losartana
            // tem SÓ o horário da própria mensagem, nunca o 06:00 da Desvenlafaxina.
            checks.push({
                marco: 'M2',
                nome: 'M2 (MH-83): nada do anterior vaza — Losartana SÓ com 13:32',
                ok: losartana.length === 1 && horariosLosartana.length === 1 && horariosLosartana[0] === '13:32',
                detalhe: `horários da Losartana: ${horariosLosartana.join(', ') || 'nenhum'}`
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
    },

    // --------------------------------------------------------
    {
        id: 'A13',
        marco: 'M1',
        titulo: 'Caltrat 19/09 (staging) — estoque junto da resposta de posologia (P57)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'post_onboarding' });

            const r1 = await turno(ctx, user, 'Caltrat D');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ nome: 'turno 1: pergunta a posologia composta, sem etapa de dosagem', ...naoContem(r1, /\*?dosagem\*?/i, 'pergunta de dosagem') });

            const r2 = await turno(ctx, user, '1cp as 10h, eu tenho 40cps dele');
            checagensDeForma(checks, 'turno 2', r2);
            const meds = await medicamentos(ctx.db, user.id, { nomeIlike: 'Caltrat%' });
            const horarios = (meds[0]?.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5));
            checks.push({ nome: 'turno 2: medicamento gravado com o NOME certo e schedule 10:00', ok: meds.length === 1 && horarios.length === 1 && horarios[0] === '10:00', detalhe: `${meds.length} linha(s); horários: ${horarios.join(', ') || 'nenhum'}` });
            checks.push({ nome: 'turno 2: estoque da mensagem aproveitado (40, sem repergunta) — P57', ok: Number(meds[0]?.estoque_atual) === 40, detalhe: `estoque_atual: ${meds[0]?.estoque_atual}` });
            checks.push({ nome: 'turno 2: não pede o estoque que já foi dito', ...naoContem(r2, /quiser cadastrar o estoque|quantos comprimidos tem em casa/i, 'convite de estoque redundante') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A14',
        marco: 'M1',
        titulo: 'Dosagem pura nunca vira nome de medicamento (regra 7 — "1000mg" virou nome no staging)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({
                nome: 'Guilherme', onboarded: true,
                estado: 'adding_med', contexto: { etapa: 'cad_nome' }
            });

            const r1 = await turno(ctx, user, '1000mg');
            checagensDeForma(checks, 'turno 1', r1);
            const meds = await medicamentos(ctx.db, user.id);
            checks.push({ nome: 'nenhum medicamento chamado "1000mg" gravado', ok: !meds.some(m => /^\s*[\d.,]+\s*(mg|ml|g)\s*$/i.test(m.nome)), detalhe: `medicamentos: ${meds.map(m => m.nome).join(', ') || 'nenhum'}` });
            checks.push({ nome: 'resposta repergunta o NOME do medicamento', ...contem(r1, /nome/i, 'repergunta do nome') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A15',
        marco: 'M1',
        titulo: 'Nimesulida 19/09 (produção) — notação de receita "1cp 12/12 hrs por 5 dias"',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'post_onboarding' });

            await turno(ctx, user, 'Nimesulida 100mg');
            const r2 = await turno(ctx, user, '1cp 12/12 hrs por 5 dias');
            checagensDeForma(checks, 'turno 2', r2);
            // Em produção este turno caiu em loop de repergunta da posologia inteira.
            checks.push({ nome: 'turno 2: intervalo reconhecido — pede só o horário da 1ª dose', ...contem(r2, /primeira dose/i, 'pergunta da primeira dose') });
            checks.push({ nome: 'turno 2: não repergunta a posologia inteira', ...naoContem(r2, /quanto .{0,30}(e|em quais) .{0,15}hor[áa]rios/i, 'repergunta da posologia completa') });

            const r3 = await turno(ctx, user, '8h');
            checagensDeForma(checks, 'turno 3', r3);
            const meds = await medicamentos(ctx.db, user.id, { nomeIlike: 'Nimesulida%' });
            const schedules = (meds[0]?.schedules || []).filter(s => s.ativo)
                .map(s => ({ horario: String(s.horario).slice(0, 5), quantidade: Number(s.quantidade_por_dose) }))
                .sort((a, b) => a.horario.localeCompare(b.horario));
            checks.push({
                nome: 'turno 3: grade 08:00 e 20:00 com 1 comprimido (12/12 a partir das 8h)',
                ok: meds.length === 1 && schedules.length === 2
                    && schedules[0].horario === '08:00' && schedules[0].quantidade === 1
                    && schedules[1].horario === '20:00' && schedules[1].quantidade === 1,
                detalhe: `schedules: ${JSON.stringify(schedules)}`
            });
            checks.push({
                nome: 'turno 3: "por 5 dias" aproveitado — tratamento temporário de 5 dias (P57)',
                ok: meds[0]?.tipo_tratamento === 'temporario' && Number(meds[0]?.tratamento_dias) === 5,
                detalhe: `tipo: ${meds[0]?.tipo_tratamento}, dias: ${meds[0]?.tratamento_dias}`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A16',
        marco: 'M1',
        titulo: 'Aline 31/08 09:05 (produção) — lista nome+horário ×4 e "Sim" (dano máximo do BUG-104)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Aline', onboarded: true, estado: 'post_onboarding' });

            // Verdade de persistência (regra 2): afirmação de cadastro exige linha no banco.
            async function verdadeDePersistencia(rotulo, resposta) {
                const afirmou = /\bcadastrad[oa]s?\b|\bregistrad[oa]s?\b|tudo (anotado|certo|salvo)/i.test(resposta);
                const meds = await medicamentos(ctx.db, user.id);
                checks.push({
                    nome: `${rotulo}: nunca afirma cadastro sem linha no banco (regra 2)`,
                    ok: !afirmou || meds.length > 0,
                    detalhe: afirmou ? `afirmou persistência com ${meds.length} linha(s) no banco` : 'nenhuma afirmação de persistência'
                });
            }

            const r1 = await turno(ctx, user, 'Suplemento Bariatron 12:00\nImecap Hair : 08:00\nFluxetina 08:00\nTopiramato 21:00');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ nome: 'turno 1: reconhece Bariatron', ...contem(r1, /bariatron/i, 'Bariatron') });
            checks.push({ nome: 'turno 1: reconhece Imecap Hair', ...contem(r1, /imecap/i, 'Imecap') });
            checks.push({ nome: 'turno 1: reconhece Fluxetina', ...contem(r1, /flu[o]?xetina/i, 'Fluxetina') });
            checks.push({ nome: 'turno 1: reconhece Topiramato', ...contem(r1, /topiramato/i, 'Topiramato') });
            await verdadeDePersistencia('turno 1', r1);

            const r2 = await turno(ctx, user, 'Sim');
            checagensDeForma(checks, 'turno 2', r2);
            await verdadeDePersistencia('turno 2', r2);

            // M2 (expected-fail): os 4 no banco, cada um com o horário DA SUA linha.
            const meds = await medicamentos(ctx.db, user.id);
            const porNome = (padrao) => meds.find(m => padrao.test(m.nome));
            const horarioDe = (m) => (m?.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5)).join(',');
            const okM2 = meds.length === 4
                && horarioDe(porNome(/bariatron/i)) === '12:00'
                && horarioDe(porNome(/imecap/i)) === '08:00'
                && horarioDe(porNome(/flux?o?etina/i)) === '08:00'
                && horarioDe(porNome(/topiramato/i)) === '21:00';
            checks.push({ marco: 'M2', nome: 'M2: 4 medicamentos, cada um com o horário da própria linha', ok: okM2, detalhe: `${meds.length} med(s): ${meds.map(m => `${m.nome}@${horarioDe(m)}`).join(' | ') || 'nenhum'}` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A17',
        marco: 'M1',
        titulo: 'Priscila 30/08 23:35 (produção) — intenção pura → lista só-nomes → "Pó"',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Priscila', onboarded: true, estado: 'post_onboarding' });

            const r1 = await turno(ctx, user, 'Lembrar de tomar minhas vitaminas');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ nome: 'turno 1: roteia para coleta, nunca promessa vazia', ...naoContem(r1, /pode deixar|deixa comigo|vou (te )?lembrar/i, 'promessa sem executor') });
            checks.push({ nome: 'turno 1: pede o medicamento', ...contem(r1, /nome|qual|medicamento|vitamina/i, 'início da coleta') });

            const r2 = await turno(ctx, user, 'Curcuma C \nVitamina de A a Z \nVitamina b12\nVitamina D');
            checagensDeForma(checks, 'turno 2', r2);
            checks.push({ nome: 'turno 2: reconhece Curcuma C', ...contem(r2, /curcuma|cúrcuma/i, 'Curcuma') });
            checks.push({ nome: 'turno 2: reconhece Vitamina de A a Z', ...contem(r2, /de a a z/i, 'Vitamina A a Z') });
            checks.push({ nome: 'turno 2: reconhece Vitamina B12', ...contem(r2, /b12/i, 'B12') });
            checks.push({ nome: 'turno 2: reconhece Vitamina D', ...contem(r2, /vitamina d\b/i, 'Vitamina D') });

            const r3 = await turno(ctx, user, 'Pó');
            checagensDeForma(checks, 'turno 3', r3);
            checks.push({ nome: 'turno 3: NUNCA repergunta o nome que está na conversa', ...naoContem(r3, /qual o \*?nome\*?|\*NOME\*/i, 'repergunta de nome') });
            checks.push({ nome: 'turno 3: reconhece o "pó" com honestidade (regra 3/7)', ...contem(r3, /p[óo]\b|sach[êe]/i, 'reconhecimento da apresentação') });
            const medsGravados = await medicamentos(ctx.db, user.id);
            checks.push({ nome: 'turno 3: nada gravado errado em silêncio', ok: !medsGravados.some(m => /^p[óo]$/i.test(m.nome)), detalhe: `medicamentos: ${medsGravados.map(m => m.nome).join(', ') || 'nenhum'}` });

            // M2 (expected-fail): a lista dos 4 sobrevive no contexto para iterar item a item.
            const { data: st } = await ctx.db.from('conversation_state').select('context').eq('user_id', user.id).single();
            const ctxTexto = JSON.stringify(st?.context || {});
            const listaPreservada = /b12/i.test(ctxTexto) && /vitamina d/i.test(ctxTexto);
            checks.push({ marco: 'M2', nome: 'M2: coleta itera item a item sem perder a lista', ok: listaPreservada, detalhe: listaPreservada ? 'lista no contexto' : 'só o 1º item sobrevive no contexto' });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A18',
        marco: 'M1',
        titulo: 'Juliana 31/08 16:45 (produção) — "É para uma outra pessoa" na recepção',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: null, onboarded: false, estado: 'idle' });

            await turno(ctx, user, 'oi');
            const r2 = await turno(ctx, user, 'É para uma outra pessoa');
            checagensDeForma(checks, 'resposta', r2);
            checks.push({ nome: 'NÃO afirma capacidade de acompanhar outra pessoa', ...naoContem(r2, /funciona sim|consigo (cuidar|acompanhar)|posso acompanhar os medicamentos d/i, 'afirmação de capacidade fora do FAZ') });
            checks.push({ nome: 'postura AINDA_NAO: honestidade + expectativa', ...contem(r2, /ainda n[ãa]o|est(á|a) chegando|em breve|estou aprendendo/i, 'honestidade com expectativa') });
            checks.push({ nome: 'oferece o caminho real (a própria pessoa usar a Nami)', ...contem(r2, /pr[óo]pri[ao]|telefone del[ae]|n[úu]mero del[ae]|el[ae] .{0,25}(usar|falar|conversar|mandar|me chamar)/i, 'caminho real de hoje') });
            checks.push({ nome: 'mantém o acolhimento e segue a recepção (pede o nome)', ...contem(r2, /chamar|nome/i, 'retomada da recepção') });

            // Turno real da validação humana (19/09): o agradecimento de fechamento
            // recebia a explicação INTEIRA de novo (regra 6 do guia).
            const r3 = await turno(ctx, user, 'Ah não, eu não uso remédio. Obrigado');
            checagensDeForma(checks, 'fechamento', r3);
            // Aceno curto de porta aberta ("é só mandar um oi") é ok — o proibido é a
            // REEXPLICAÇÃO (limite de capacidade + expectativa + caminho, de novo).
            checks.push({ nome: 'fechamento: não reexplica o que acabou de dizer', ...naoContem(r3, /ainda n[ãa]o conect|est(á|a) chegando|funcionalidade|caminho que j[áa] funciona|pr[óo]pria pessoa que toma/i, 'reexplicação do turno anterior') });
            const linhasFechamento = r3.split('\n').map(l => l.trim()).filter(Boolean).length;
            checks.push({ nome: 'fechamento curto (até 3 linhas de conteúdo)', ok: linhasFechamento <= 3, detalhe: `${linhasFechamento} linha(s) de conteúdo` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A19',
        marco: 'M1',
        titulo: 'Flávia 01/09 (produção) — dois produtos num nome ("Regenesis e ofolato D")',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Flávia', onboarded: true, estado: 'post_onboarding' });

            await turno(ctx, user, 'Quero cadastrar um remédio');
            await turno(ctx, user, 'Regenesis e ofolato D');
            const r3 = await turno(ctx, user, '1 comprimido às 12h');
            checagensDeForma(checks, 'turno 3', r3);

            const meds = await medicamentos(ctx.db, user.id);
            // M2 (expected-fail): dois registros propostos, nunca um nome composto gravado em silêncio.
            checks.push({ marco: 'M2', nome: 'M2: "X e Y" vira DOIS registros (com confirmação)', ok: meds.length === 2, detalhe: `${meds.length} registro(s): ${meds.map(m => m.nome).join(' | ') || 'nenhum'}` });

            // M1: se gravou como um, a confirmação declara EXATAMENTE o que está no banco.
            if (meds.length === 1) {
                checks.push({ nome: 'turno 3: confirmação declara o nome exato gravado (verdade do banco)', ok: r3.includes(meds[0].nome), detalhe: `banco: "${meds[0].nome}"` });
                checks.push({ nome: 'turno 3: nunca "X e Y e Y" na renderização', ...naoContem(r3, /e ofolato D e ofolato D/i, 'nome duplicado na renderização') });
            } else if (meds.length === 0) {
                checks.push({ nome: 'turno 3: medicamento gravado após posologia completa', ok: false, detalhe: 'nenhuma linha em medications' });
            }
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A20',
        marco: 'M3',
        titulo: 'Guilherme 02/09 20:04 (produção) — "Encerrar todos" (seleção múltipla em lote)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'idle' });
            for (const [nome, horario] of [['Ômega 3', '08:00'], ['Losartana', '09:00'], ['Vitamina D', '10:00'], ['Melatonina', '22:00']]) {
                await seeds.criarMedicamento({ userId: user.id, nome, horarios: [horario] });
            }

            const r1 = await turno(ctx, user, 'Encerrar todos');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ marco: 'M3', nome: 'M3: reconhece "todos" com UMA confirmação agregada', ...contem(r1, /todos os (seus )?(4 )?(rem[ée]dios|medicamentos|tratamentos)|os 4 (rem[ée]dios|medicamentos|tratamentos)/i, 'confirmação agregada') });
            checks.push({ marco: 'M3', nome: 'M3: nunca pede para escolher UM de cada vez', ...naoContem(r1, /qual (deles|medicamento|rem[ée]dio|tratamento) você (quer|deseja)/i, 'seleção um-a-um') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A21',
        marco: 'M2',
        titulo: 'MH-30 — conclusão automática de tratamento agudo (tratamento_fim vencido)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Tantin', onboarded: true, estado: 'idle' });

            // Horário do schedule = AGORA em Brasília, para exercitar a janela da RPC.
            const agoraHHMM = new Date().toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            });
            const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000)
                .toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

            // Vencido: tratamento de 3 dias que terminou ontem, ainda ativo (estado
            // que o job diário deve encontrar e concluir).
            const { med, schedules } = await seeds.criarMedicamento({
                userId: user.id, nome: 'Amoxicilina', dosagem: '500mg',
                estoque: 10, horarios: [agoraHHMM], quantidadePorDose: 1
            });
            await ctx.db.from('medications')
                .update({ tipo_tratamento: 'temporario', tratamento_dias: 3, tratamento_fim: ontem })
                .eq('id', med.id);
            const dosePendente = await seeds.criarDosePendente({
                medicationId: med.id, scheduleId: schedules[0]?.id ?? null, horario: agoraHHMM, minutosAtras: 600
            });

            // Controle positivo: um contínuo no MESMO horário aparece na RPC —
            // prova que a janela casou e que a ausência do vencido é o filtro.
            const { med: medControle } = await seeds.criarMedicamento({
                userId: user.id, nome: 'Losartana Controle', estoque: 30, horarios: [agoraHHMM]
            });

            const { data: reminders } = await ctx.db.rpc('get_pending_reminders');
            const idsNaRPC = (reminders || []).map(r => r.medication_id);
            checks.push({
                nome: 'controle: medicamento contínuo no mesmo horário APARECE na RPC',
                ok: idsNaRPC.includes(medControle.id),
                detalhe: `janela da RPC ${idsNaRPC.includes(medControle.id) ? 'casou' : 'NÃO casou — checagem seguinte seria vácua'}`
            });
            checks.push({
                nome: 'dose NÃO nasce após tratamento_fim (filtro na RPC, antes do job)',
                ok: !idsNaRPC.includes(med.id),
                detalhe: `medication vencido ${idsNaRPC.includes(med.id) ? 'AINDA aparece' : 'ausente'} em get_pending_reminders`
            });

            // Job diário: desativa, pausa pendentes e avisa PELO FUNIL.
            const antes = ctx.enviosCapturados.length;
            await ctx.concluirTratamentosVencidos();

            const { data: medDepois } = await ctx.db.from('medications')
                .select('ativo, schedules(ativo)').eq('id', med.id).single();
            checks.push({
                nome: 'job: medicamento e schedules desativados',
                ok: medDepois?.ativo === false && (medDepois?.schedules || []).every(s => s.ativo === false),
                detalhe: `ativo: ${medDepois?.ativo}, schedules ativos: ${(medDepois?.schedules || []).filter(s => s.ativo).length}`
            });

            const logsDose = await doseLogs(ctx.db, med.id);
            const doseDepois = logsDose.find(d => d.id === dosePendente.id);
            checks.push({
                nome: 'job: dose pendente pausada (nenhum follow-up cobra tratamento concluído)',
                ok: doseDepois?.status === 'pausado',
                detalhe: `status: ${doseDepois?.status}`
            });

            const enviados = ctx.enviosCapturados.slice(antes).filter(e => e.phone === user.phone);
            checks.push({ nome: 'mensagem de conclusão sai PELO FUNIL', ok: enviados.length === 1, detalhe: `${enviados.length} envio(s) capturado(s)` });
            if (enviados.length === 1) {
                checagensDeForma(checks, 'conclusão', enviados[0].texto);
                checks.push({ nome: 'conclusão nomeia o medicamento e o fim do tratamento', ...contem(enviados[0].texto, /amoxicilina/i, 'nome do medicamento') });
                checks.push({ nome: 'conclusão avisa que os lembretes pararam', ...contem(enviados[0].texto, /lembretes/i, 'aviso dos lembretes') });
                checks.push({ nome: 'conclusão aponta o caminho se o médico estender', ...contem(enviados[0].texto, /cadastrar de novo|estender/i, 'caminho de extensão') });
            }
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A22',
        marco: 'M2',
        titulo: 'MH-49 — alerta de estoque de temporário compara com os dias RESTANTES do tratamento',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Tramal', onboarded: true, estado: 'idle' });

            const emTresDias = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
                .toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

            // medA: estoque cobre além do fim do tratamento (5 dias de estoque
            // pós-débito vs ~3 restantes) — o limiar fixo de contínuo (<=5)
            // alertaria ERRADO; o de temporário não pode alertar.
            const { med: medA, schedules: schedA } = await seeds.criarMedicamento({
                userId: user.id, nome: 'Prednisona', estoque: 6, horarios: ['08:00'], quantidadePorDose: 1
            });
            await ctx.db.from('medications')
                .update({ tipo_tratamento: 'temporario', tratamento_dias: 5, tratamento_fim: emTresDias })
                .eq('id', medA.id);

            // medB: estoque NÃO cobre os dias restantes (1 dia pós-débito vs ~3) — alerta.
            const { med: medB, schedules: schedB } = await seeds.criarMedicamento({
                userId: user.id, nome: 'Azitromicina', estoque: 2, horarios: ['12:00'], quantidadePorDose: 1
            });
            await ctx.db.from('medications')
                .update({ tipo_tratamento: 'temporario', tratamento_dias: 5, tratamento_fim: emTresDias })
                .eq('id', medB.id);

            await seeds.criarDosePendente({ medicationId: medA.id, scheduleId: schedA[0].id, horario: '08:00', minutosAtras: 120 });
            await seeds.criarDosePendente({ medicationId: medB.id, scheduleId: schedB[0].id, horario: '12:00', minutosAtras: 10 });

            // 1º "Sim" confirma o grupo mais recente (medB): estoque insuficiente
            // para os dias restantes → alerta, com número pós-débito (autor único).
            const r1 = await turno(ctx, user, 'Sim');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ nome: 'turno 1: confirma a dose do grupo mais recente (Azitromicina)', ...contem(r1, /azitromicina/i, 'Azitromicina') });
            checks.push({
                nome: 'turno 1: estoque que NÃO cobre os dias restantes ALERTA',
                ok: blocosDeEstoque(r1) === 1,
                detalhe: `${blocosDeEstoque(r1)} bloco(s) de estoque`
            });
            const { data: medBDepois } = await ctx.db.from('medications').select('estoque_atual').eq('id', medB.id).single();
            checks.push({ nome: 'turno 1: número do alerta == leitura pós-débito', ...numeroDeEstoqueConfere(r1, medBDepois?.estoque_atual) });

            // 2º turno confirma medA: estoque cobre até o fim do tratamento →
            // NUNCA "compre mais" para tratamento que acaba antes do estoque.
            const r2 = await turno(ctx, user, 'Tomei');
            checagensDeForma(checks, 'turno 2', r2);
            checks.push({ nome: 'turno 2: confirma a dose da Prednisona', ...contem(r2, /prednisona/i, 'Prednisona') });
            checks.push({
                nome: 'turno 2: estoque que cobre o fim do tratamento NÃO alerta recompra',
                ok: blocosDeEstoque(r2) === 0,
                detalhe: `${blocosDeEstoque(r2)} bloco(s) de estoque (esperado 0 — tratamento acaba antes do estoque)`
            });

            const logsA = await doseLogs(ctx.db, medA.id);
            const logsB = await doseLogs(ctx.db, medB.id);
            checks.push({
                nome: 'as duas doses confirmadas no banco',
                ok: logsA.some(d => d.confirmed === true) && logsB.some(d => d.confirmed === true),
                detalhe: `A: ${logsA.map(d => d.status).join(',')} | B: ${logsB.map(d => d.status).join(',')}`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A23',
        marco: 'M2',
        titulo: 'MH-86 — estoque líquido num turno só (validador composto, resgates determinísticos)',
        async executar() {
            const checks = [];
            const { validarEstoque } = await import('../src/validadores/estoque.js');
            const camposBase = { nome: 'Xarope Teste', unidade_estoque: 'ml', medication_id: 'fake' };

            // Status + volume + fração NA MESMA mensagem → resolve num turno,
            // sem nenhuma chamada de LLM (status e fração determinísticos).
            const r1 = await validarEstoque({
                message: 'Já uso, o frasco é de 60ml e tá pela metade', campos: camposBase
            });
            checks.push({
                nome: 'aberto + volume + fração num turno → resolvido (60ml × 1/2 = 30)',
                ok: r1.acao === 'estoque_resolvido' && r1.resolvido?.valor === 30
                    && r1.resolvido?.motivo === 'aberto_fracao:metade',
                detalhe: `acao: ${r1.acao}, valor: ${r1.resolvido?.valor}, motivo: ${r1.resolvido?.motivo}`
            });

            // Fechado + frascos + volume na mesma mensagem (MH-73 C.1 preservado).
            const r2 = await validarEstoque({
                message: 'Tá fechado ainda, tenho 2 frascos de 100ml', campos: camposBase
            });
            checks.push({
                nome: 'fechado + frascos + volume num turno → resolvido (2 × 100 = 200)',
                ok: r2.acao === 'estoque_resolvido' && r2.resolvido?.valor === 200
                    && r2.resolvido?.motivo === 'frascos_fechados',
                detalhe: `acao: ${r2.acao}, valor: ${r2.resolvido?.valor}, motivo: ${r2.resolvido?.motivo}`
            });

            // Fração sem volume → o que veio nunca se perde (P57): fica pendente
            // e falta SÓ o volume.
            const r3 = await validarEstoque({
                message: 'já abri, tá quase acabando', campos: camposBase
            });
            checks.push({
                nome: 'aberto + fração sem volume → fração preservada, falta só o volume',
                ok: r3.updates?.status_frasco === 'aberto' && r3.updates?.estoque_fracao_pendente === 'quase_acabando',
                detalhe: `acao: ${r3.acao}, updates: ${JSON.stringify(r3.updates)}`
            });

            // Volume declarado NÃO é confundido com sobra ("de 60ml" ≠ "sobram 60ml").
            const r4 = await validarEstoque({
                message: 'tá aberto, é de 60ml', campos: camposBase
            });
            checks.push({
                nome: 'volume declarado ("de 60ml") não vira valor de sobra',
                ok: r4.acao !== 'estoque_resolvido' && r4.updates?.volume_frasco === 60,
                detalhe: `acao: ${r4.acao}, updates: ${JSON.stringify(r4.updates)}`
            });

            // Sobra exata com volume já conhecido → resolve direto.
            const r5 = await validarEstoque({
                message: 'já tô usando, sobram uns 25ml',
                campos: { ...camposBase, volume_frasco: 60 }
            });
            checks.push({
                nome: 'sobra exata com volume conhecido → resolvido (25ml)',
                ok: r5.acao === 'estoque_resolvido' && r5.resolvido?.valor === 25,
                detalhe: `acao: ${r5.acao}, valor: ${r5.resolvido?.valor}, motivo: ${r5.resolvido?.motivo}`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    // Marco M2 de propósito: é a correção quente do Commit 0 do M3 (defeito de
    // produção do M2) — precisa gatear a promoção já, antes do restante do M3.
    {
        id: 'A32',
        marco: 'M2',
        titulo: 'Evandro 20/09 12:51 (produção) — "às 17hs" em duas linhas: lote + estoque agregado + correção de nome (Commit 0 do M3)',
        async executar({ ctx, seeds }) {
            const checks = [];

            // 0. Determinístico: variantes reais de sufixo de horário (a lacuna que
            // deixou o arnês verde com produção falhando — A16 usa ":").
            const { extrairHorariosCitados } = await import('../src/validadores/recorrencia.js');
            const variantes = { 'às 17hs': '17:00', '17hrs': '17:00', '17hr': '17:00', '17 horas': '17:00', 'às 19 hs': '19:00' };
            const variantesOk = Object.entries(variantes).every(([txt, hhmm]) => {
                const r = extrairHorariosCitados(txt);
                return r.length === 1 && r[0] === hhmm;
            });
            const intervaloNaoViraHorario = extrairHorariosCitados('1cp 12/12 hrs').length === 0;
            checks.push({
                nome: 'regex: "17hs"/"17hrs"/"17hr"/"17 horas" viram horário; "12/12 hrs" segue intervalo',
                ok: variantesOk && intervaloNaoViraHorario,
                detalhe: `variantes: ${variantesOk}, 12/12: ${JSON.stringify(extrairHorariosCitados('1cp 12/12 hrs'))}`
            });

            // 1. Input real do Evandro: lote dispara, os DOIS com o horário da sua linha.
            const user = await seeds.criarUsuario({ nome: 'Evandro', onboarded: true, estado: 'post_onboarding' });
            const r1 = await turno(ctx, user, 'Marevan 1 comprimido às 17hs\nKepra 1 comprimido às 19hs');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ nome: 'turno 1: reconhece Marevan', ...contem(r1, /marevan/i, 'Marevan') });
            checks.push({ nome: 'turno 1: reconhece Kepra', ...contem(r1, /kepp?ra/i, 'Kepra') });
            checks.push({ nome: 'turno 1: zero repergunta de dado presente (horário)', ...naoContem(r1, /quais .{0,12}hor[áa]rios/i, 'repergunta de horários') });
            checks.push({ nome: 'turno 1: zero repergunta de dado presente (quantidade)', ...naoContem(r1, /quanto você toma ou usa/i, 'repergunta de quantidade') });

            const r2 = await turno(ctx, user, 'Sim');
            checagensDeForma(checks, 'turno 2', r2);
            const meds = await medicamentos(ctx.db, user.id);
            const horarioDe = (m) => (m?.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5)).join(',');
            const marevan = meds.find(m => /marevan/i.test(m.nome));
            const kepra = meds.find(m => /kepp?ra/i.test(m.nome));
            checks.push({
                nome: 'turno 2: os DOIS gravados, cada um com o horário da SUA linha (17:00/19:00)',
                ok: meds.length === 2 && horarioDe(marevan) === '17:00' && horarioDe(kepra) === '19:00',
                detalhe: `${meds.length} med(s): ${meds.map(m => `${m.nome}@${horarioDe(m)}`).join(' | ') || 'nenhum'}`
            });
            checks.push({ nome: 'turno 2: convite de estoque agregado ("de cada um")', ...contem(r2, /de cada um/i, 'convite agregado') });

            // 2. Correção de grafia na resposta ao convite (Kepra → Keppra) — a que
            // foi engolida em produção.
            const r3 = await turno(ctx, user, 'Keppra');
            checagensDeForma(checks, 'turno 3', r3);
            const medsPosCorrecao = await medicamentos(ctx.db, user.id);
            const keppra = medsPosCorrecao.find(m => /^keppra$/i.test(m.nome));
            checks.push({
                nome: 'turno 3: correção aplicada — renomeado para Keppra, sem registro novo',
                ok: medsPosCorrecao.length === 2 && !!keppra,
                detalhe: `${medsPosCorrecao.length} med(s): ${medsPosCorrecao.map(m => m.nome).join(' | ')}`
            });
            checks.push({ nome: 'turno 3: declara a correção', ...contem(r3, /keppra/i, 'nome corrigido') });

            // 3. Forma nomeada: "Marevan 30, Keppra 29" — atribuição por nome.
            const r4 = await turno(ctx, user, 'Marevan 30, Keppra 29');
            checagensDeForma(checks, 'turno 4', r4);
            const medsFinal = await medicamentos(ctx.db, user.id);
            const estoqueDe = (re) => medsFinal.find(m => re.test(m.nome))?.estoque_atual;
            checks.push({
                nome: 'turno 4: estoque atribuído por NOME (Marevan=30, Keppra=29)',
                ok: Number(estoqueDe(/marevan/i)) === 30 && Number(estoqueDe(/keppra/i)) === 29,
                detalhe: `Marevan: ${estoqueDe(/marevan/i)}, Keppra: ${estoqueDe(/keppra/i)}`
            });
            checks.push({ nome: 'turno 4: fechamento pós-escrita declara os dois valores', ok: /30/.test(r4) && /29/.test(r4), detalhe: r4.slice(0, 160) });

            // 4. Número seco com DOIS pendentes → pergunta de qual é (uma pergunta,
            // última linha), sem gravação às cegas.
            const user2 = await seeds.criarUsuario({ nome: 'Evandro Dois', onboarded: true, estado: 'post_onboarding' });
            await turno(ctx, user2, 'Dipirona 1 comprimido às 8hs\nOmeprazol 1 comprimido às 21hs');
            await turno(ctx, user2, 'Sim');
            const r5 = await turno(ctx, user2, '30');
            checagensDeForma(checks, 'número seco', r5);
            const meds2 = await medicamentos(ctx.db, user2.id);
            checks.push({
                nome: 'número seco com 2 pendentes: NADA gravado às cegas',
                ok: meds2.length === 2 && meds2.every(m => m.estoque_atual === null),
                detalhe: `estoques: ${meds2.map(m => `${m.nome}=${m.estoque_atual}`).join(', ')}`
            });
            checks.push({ nome: 'número seco: pergunta de qual medicamento é', ...contem(r5, /qual|é d[oa]/i, 'pergunta de desambiguação') });

            const r6 = await turno(ctx, user2, 'Do Omeprazol');
            checagensDeForma(checks, 'desambiguação', r6);
            const meds2b = await medicamentos(ctx.db, user2.id);
            const est2 = (re) => meds2b.find(m => re.test(m.nome))?.estoque_atual;
            checks.push({
                nome: 'desambiguação: número guardado aplicado ao nomeado (Omeprazol=30, Dipirona segue NULL)',
                ok: Number(est2(/omeprazol/i)) === 30 && est2(/dipirona/i) === null,
                detalhe: `Omeprazol: ${est2(/omeprazol/i)}, Dipirona: ${est2(/dipirona/i)}`
            });

            // 5. Matriz do A9 completa (célula "nome" do BUG-103): correção de grafia
            // na pergunta de estoque do fluxo de UM medicamento.
            const user3 = await seeds.criarUsuario({ nome: 'Evandro Três', onboarded: true, estado: 'post_onboarding' });
            await turno(ctx, user3, 'Kepra 1 comprimido às 19h');
            const r7 = await turno(ctx, user3, 'Keppra');
            checagensDeForma(checks, 'correção single', r7);
            const meds3 = await medicamentos(ctx.db, user3.id);
            checks.push({
                nome: 'correção single: renomeado para Keppra no banco, um registro só',
                ok: meds3.length === 1 && /^keppra$/i.test(meds3[0].nome),
                detalhe: `${meds3.length} med(s): ${meds3.map(m => m.nome).join(' | ')}`
            });
            checks.push({ nome: 'correção single: declara e segue no estoque', ...contem(r7, /keppra/i, 'nome corrigido') });

            const r8 = await turno(ctx, user3, '29');
            checagensDeForma(checks, 'estoque single', r8);
            const meds3b = await medicamentos(ctx.db, user3.id);
            checks.push({
                nome: 'estoque single: 29 gravado para o nome certo',
                ok: Number(meds3b[0]?.estoque_atual) === 29,
                detalhe: `estoque_atual: ${meds3b[0]?.estoque_atual}`
            });
            return checks;
        }
    }
];
