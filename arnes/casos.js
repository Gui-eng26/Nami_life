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

// v45 P1: o turno inteiro (texto + agente + chamadas de LLM) — para as
// asserções de "nenhuma chamada de LLM" do atalho exato.
async function turnoCompleto(ctx, user, mensagem, extras = {}) {
    contadorTurno++;
    const r = await ctx.routeMessage({
        user,
        message: mensagem,
        image: null,
        messageId: `arnes-${Date.now()}-${contadorTurno}`,
        referenceMessageId: extras.referenceMessageId || null
    });
    return { texto: r?.texto ?? '', chamadasLLM: r?.chamadasLLM ?? null, agente: r?.agente ?? null };
}

// Momento "hoje", N minutos atrás, sem nunca cruzar a meia-noite de Brasília
// (a suíte pode rodar de madrugada; o rótulo de dia é o que o caso mede).
function hojeHaMinutos(minutos) {
    const agora = new Date();
    const hhmm = agora.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const [h, m] = hhmm.split(':').map(Number);
    const desdeMeiaNoite = h * 60 + m;
    const efetivo = Math.max(1, Math.min(minutos, desdeMeiaNoite - 1));
    return new Date(agora.getTime() - efetivo * 60_000).toISOString();
}
function diasAtras(dias, minutos = 120) {
    return new Date(new Date(hojeHaMinutos(minutos)).getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
}

// Checagens de forma da Constituição (regras 8 e 9) — aplicadas a toda resposta.
function checagensDeForma(checks, rotuloTurno, resposta) {
    checks.push({ nome: `${rotuloTurno}: uma pergunta, na última linha`, ...umaPerguntaNaUltimaLinha(resposta) });
    checks.push({ nome: `${rotuloTurno}: sem negrito markdown (**)`, ...semNegritoMarkdown(resposta) });
}

// v45 P1-ajustes: a pergunta aberta vem do último texto da Nami em agent_logs
// (montarPendencia) — o caso semeia essa fala sem gastar um turno de LLM.
async function falaDaNami(ctx, user, texto, { estado = 'idle', minutosAtras = 2 } = {}) {
    const { error } = await ctx.db.from('agent_logs').insert({
        user_id: user.id, agent: 'cadastro', user_message: '(seed do arnês)', agent_response: texto,
        estado_conversa: estado, created_at: new Date(Date.now() - minutosAtras * 60_000).toISOString()
    });
    if (error) throw new Error(`Seed de fala da Nami falhou: ${error.message}`);
}

// Quantas vezes o número aparece como número (não como parte de outro).
function ocorrenciasDoNumero(texto, n) {
    return (String(texto).match(new RegExp(`(^|[^\\d])${n}(?![\\d])`, 'g')) || []).length;
}

// Eventos "ainda não" do usuário (§5.5) — lidos e apagados (staging limpo).
async function eventosAindaNao(ctx, userId) {
    const { data } = await ctx.db.from('system_events')
        .select('id, titulo, payload, origem, severidade, status_triagem, agent_log_id')
        .eq('user_id', userId).eq('tipo', 'intencao_nao_suportada');
    return data || [];
}

// P1-ajustes 2 §1 — o "ainda não" do turno é SEMPRE texto do código: o
// esperado é reconstruído do payload do evento (chave ou pedido).
async function textoAindaNaoEsperado(ev, nome) {
    const { respostaHonestaAindaNao, respostaAindaNaoPadrao } = await import('../src/inventario.js');
    if (ev?.payload?.chave_ainda_nao) return `${respostaHonestaAindaNao(ev.payload.chave_ainda_nao)}\n\nPosso te ajudar com outra coisa? 🌿`;
    return respostaAindaNaoPadrao({ nome, pedido: ev?.payload?.pedido || null });
}

const RE_ABERTURA_ESTOQUE = /^(Boa|Perfeito|Isso aí|Que bom|Tudo certo|Show)(, [^!\n]+)?! /;

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

            // Grep-guard 5 (M3 P6.2 — A0 estendida): nenhum JSON.parse de saída de
            // LLM fora de tool-use em TODO o sistema. Como toda saída estruturada
            // de LLM agora chega por ferramenta, src/ não tem NENHUM JSON.parse.
            const violadoresJsonParse = [...conteudo.entries()]
                .filter(([, c]) => /JSON\.parse\(/.test(c)).map(([f]) => f);
            checks.push({ marco: 'M2', nome: 'grep (A0 estendida): zero JSON.parse em src/ (tool-use em tudo)', ok: violadoresJsonParse.length === 0, detalhe: violadoresJsonParse.join(', ') || 'limpo' });

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

            // Replay 20/09 (Jhony/Centrum): encontrarMedicamento com FRONTEIRA —
            // "mudar o nome da Vitamina de A a Z" NUNCA casa com "Vitamina D".
            const { encontrarMedicamento } = await import('../src/nlp_helpers.js');
            const medsFronteira = [{ nome: 'Vitamina D' }, { nome: 'Vitamina de A a Z' }];
            checks.push({
                nome: 'encontrarMedicamento: nome mais longo com fronteira vence (nunca o alvo errado)',
                ok: encontrarMedicamento('Quero mudar o nome da Vitamina de A a Z pra Centrum', medsFronteira)?.nome === 'Vitamina de A a Z'
                    && encontrarMedicamento('Quais horários da Vitamina D?', medsFronteira)?.nome === 'Vitamina D',
                detalhe: `alvo: ${encontrarMedicamento('Quero mudar o nome da Vitamina de A a Z pra Centrum', medsFronteira)?.nome}`
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

            // ---- Guardas do M4 (onboarding no runner) ----

            // Grep-guard: recepcionista e o agente de nascimento mortos por construção.
            const arquivosMortosM4 = ['agentes/recepcionista.js', 'agentes/data_nascimento.js']
                .filter(f => fs.existsSync(path.join(raizSrc, f)));
            checks.push({ marco: 'M4', nome: 'grep (M4): recepcionista/data_nascimento mortos por construção', ok: arquivosMortosM4.length === 0, detalhe: arquivosMortosM4.join(', ') || 'limpos' });

            // Grep-guard: nenhum estado legado do onboarding sobrevive em src/.
            const tokensLegados = ['recep' + '_', 'coletando' + '_nascimento'];
            const violadoresOnb = [...conteudo.entries()]
                .filter(([, c]) => tokensLegados.some(t => c.includes(t)))
                .map(([f]) => f);
            checks.push({ marco: 'M4', nome: 'grep (M4): estados legados do onboarding ausentes de src/', ok: violadoresOnb.length === 0, detalhe: violadoresOnb.join(', ') || 'limpo' });

            // Guarda LGPD determinística (M4 §2.5, teste de unidade SEM LLM):
            // nenhum caminho grava dado pessoal declarado sem consentimento —
            // o ponto único de montagem da escrita LANÇA sem aceite.
            const { montarPersistenciaOnboarding, detectarConsentimentoDeterministico } = await import('../src/schemas/onboarding.js');
            let guardaLancou = false;
            try {
                montarPersistenciaOnboarding({ nome_coletado: 'Ana', data_nascimento: '1990-01-01' });
            } catch {
                guardaLancou = true;
            }
            checks.push({
                marco: 'M4',
                nome: 'M4 (guarda LGPD): persistência SEM consentimento é recusada (lança)',
                ok: guardaLancou,
                detalhe: guardaLancou ? 'lançou como esperado' : 'NÃO lançou — dado pessoal gravável sem aceite'
            });
            const persistencia = montarPersistenciaOnboarding({
                consentimento_lgpd: true, nome_coletado: 'Ana', data_nascimento: '1990-01-01'
            });
            checks.push({
                marco: 'M4',
                nome: 'M4 (guarda LGPD): persistência COM consentimento monta o rascunho inteiro',
                ok: persistencia.onboarded === true && persistencia.lgpd_accepted === true
                    && persistencia.name === 'Ana' && persistencia.data_nascimento === '1990-01-01',
                detalhe: JSON.stringify(persistencia)
            });
            // Replay 21/09 (Predsin 2mg / Glifage 850mg): a porta devolveu o
            // nome COM a concentração, a divisão multi-med extraiu a dosagem da
            // linha de novo ("Predsin 2mg 2mg") e o nome foi GRAVADO sujo. A
            // limpeza é ponto único na porta; o rótulo nunca repete a dosagem.
            const { limparDosagemDoNome } = await import('../src/porta.js');
            const limpezas = [
                ['Predsin 2mg', 'Predsin'], ['Glifage 850mg', 'Glifage'],
                ['Puran T4 50mcg', 'Puran T4'], ['Dipirona 500 mg', 'Dipirona'],
                ['Vitamina D', 'Vitamina D'], ['Ômega 3', 'Ômega 3'],
                ['Vitamina de A a Z', 'Vitamina de A a Z'], ['1000mg', '1000mg']
            ];
            const erros = limpezas.filter(([entrada, esperado]) => limparDosagemDoNome(entrada) !== esperado);
            checks.push({
                marco: 'M4',
                nome: 'M4 (replay 21/09): porta limpa a dosagem do NOME e preserva nome legítimo',
                ok: erros.length === 0,
                detalhe: erros.map(([e, esp]) => `"${e}" → "${limparDosagemDoNome(e)}" (esperado "${esp}")`).join('; ') || 'todas as 8 corretas'
            });

            const { rotularNomeComDosagem, renderizarPropostaLote } = await import('../src/schemas/cadastro.js');
            const propostaSuja = renderizarPropostaLote([
                { nome: 'Predsin 2mg', dosagem: '2mg', horarios: ['10:00'], quantidade: 1, formaRotulo: 'comprimido' },
                { nome: 'Glifage', dosagem: '850mg', horarios: ['07:00'], quantidade: 1, formaRotulo: 'comprimido' }
            ]);
            checks.push({
                marco: 'M4',
                nome: 'M4: rótulo nome+dosagem NUNCA duplica a concentração',
                ok: rotularNomeComDosagem('Predsin 2mg', '2mg') === 'Predsin 2mg'
                    && rotularNomeComDosagem('Predsin', '2mg') === 'Predsin 2mg'
                    && !/2mg\s+2mg/.test(propostaSuja) && /Glifage 850mg/.test(propostaSuja),
                detalhe: propostaSuja.split('\n').filter(l => l.startsWith('•')).join(' | ')
            });

            // Replay 21/09 (Predsin + Glifage): todo texto do onboarding que
            // menciona o que chegou cita TODOS os medicamentos reconhecidos —
            // citar um só dava a impressão de que a Nami perdeu os outros.
            const { renderizarBoasVindas, renderizarPedidoConsentimento, renderizarPedidoNome, renderizarPedidoNascimento } =
                await import('../src/schemas/onboarding.js');
            const doisMeds = ['Predsin', 'Glifage'];
            const textosComMeds = [
                renderizarBoasVindas({ intencao: 'cadastrar', medsReconhecidos: doisMeds }),
                renderizarPedidoConsentimento({ nomeColetado: 'Guilherme', medsNoRascunho: doisMeds }),
                renderizarPedidoNome({ motivo: 'contexto_saude', medsNoRascunho: doisMeds })
            ];
            checks.push({
                marco: 'M4',
                nome: 'M4 (replay 21/09): recepção, LGPD e pedido de nome citam TODOS os medicamentos',
                ok: textosComMeds.every(t => /Predsin/.test(t) && /Glifage/.test(t)),
                detalhe: textosComMeds.map(t => t.split('\n')[0]).join(' | ')
            });
            checks.push({
                marco: 'M4',
                nome: 'M4: com UM medicamento a copy segue no singular (sem lista)',
                ok: /do \*Predsin\*/.test(renderizarBoasVindas({ intencao: 'cadastrar', medsReconhecidos: ['Predsin'] }))
                    && !/•/.test(renderizarBoasVindas({ intencao: 'cadastrar', medsReconhecidos: ['Predsin'] })),
                detalhe: renderizarBoasVindas({ intencao: 'cadastrar', medsReconhecidos: ['Predsin'] }).split('\n')[0]
            });

            // Decisão de Guilherme (21/09): a data de nascimento é opcional no
            // COMPORTAMENTO, mas a pergunta não anuncia isso — nem o pedido, nem
            // a repetição, nem o aviso de data inválida.
            const { renderizarDataInvalidaOnboarding } = await import('../src/schemas/onboarding.js');
            const perguntasDeData = [
                renderizarPedidoNascimento({ nomeColetado: 'Guilherme' }),
                renderizarPedidoNascimento({ nomeColetado: 'Guilherme', repeticao: true }),
                renderizarDataInvalidaOnboarding()
            ];
            checks.push({
                marco: 'M4',
                nome: 'M4 (21/09): pergunta da data NÃO anuncia opcionalidade',
                ok: perguntasDeData.every(t => !/opcional|se preferir n[ãa]o informar|pode pular/i.test(t))
                    && perguntasDeData.every(t => /data de nascimento/i.test(t)),
                detalhe: perguntasDeData.map(t => t.replace(/\n/g, ' / ')).join(' || ')
            });

            const aceitesOk = detectarConsentimentoDeterministico('Maria Lima\nsim\n02/02/1975') === 'aceite'
                && detectarConsentimentoDeterministico('Concordo') === 'aceite';
            const nuncaAceite = detectarConsentimentoDeterministico('prefiro nao passar os dados') === 'recusa'
                && detectarConsentimentoDeterministico('sim, mas não quero passar a data') !== 'aceite'
                && detectarConsentimentoDeterministico('Simone') !== 'aceite';
            checks.push({
                marco: 'M4',
                nome: 'M4 (BUG-88 vivo): "sim" no dump aceita; negação/substring nunca viram aceite',
                ok: aceitesOk && nuncaAceite,
                detalhe: `aceites: ${aceitesOk}, guardas de negação/substring: ${nuncaAceite}`
            });

            // ---- Guardas do v45 P1 (o principal é a porta única) ----

            // Nada que interpretava linguagem ANTES do principal volta ao caminho
            // do routeMessage.
            const proibidosNoRouter = ['interpretarTurno', 'confirmarDosePendenteDeterministico',
                'tentarConfirmarRespostaTardia', 'pareceExclusaoConta', 'isAffirmativeSimple',
                'detectarConfirmacaoDose', 'despacharPorProposta', 'excluirPrincipal'];
            const router = conteudo.get('router.js') || '';
            const noRouter = proibidosNoRouter.filter(t => router.includes(t));
            checks.push({ marco: 'M4', nome: 'grep (P1): atalhos/porta/S1–S4 fora do caminho do routeMessage', ok: noRouter.length === 0, detalhe: noRouter.join(', ') || 'limpo' });
            const decisorVivo = [...conteudo.entries()].filter(([, c]) => /detectarConfirmacaoDose/.test(c)).map(([f]) => f);
            checks.push({ marco: 'M4', nome: 'grep (P1): detectarConfirmacaoDose não existe mais', ok: decisorVivo.length === 0, detalhe: decisorVivo.join(', ') || 'limpo' });
            const vocabularioVelho = [...conteudo.entries()]
                .filter(([f, c]) => ['prompts.js', path.join('agentes', 'principal.js')].includes(f) && /CONFIRM_DOSE|CONFIRM_RETROATIVA|REVERSE_CONFIRMATION|REGISTER_NAO_TOMADO/.test(c))
                .map(([f]) => f);
            checks.push({ marco: 'M4', nome: 'grep (P1): CONFIRM_*/REVERSE/REGISTER fora do vocabulário do LLM', ok: vocabularioVelho.length === 0, detalhe: vocabularioVelho.join(', ') || 'limpo' });

            // Nenhum UUID de dose no prompt do principal: o bloco usa refs curtas.
            const { estruturarDoses, renderizarBlocoDoses, normalizarParaAtalho } = await import('../src/dosesDoTurno.js');
            const uuidDose = '3f1c2a9e-7b1d-4c6e-9a8f-0d2e4b6c8a10';
            const { estrutura: estP1, mapa: mapaP1 } = estruturarDoses({ doses: [{
                id: uuidDose, medication_id: 'b2a1c3d4-0000-4000-8000-000000000000', status: 'pendente', confirmed: false,
                reminder_sent: true, scheduled_at: new Date(Date.now() - 60_000).toISOString(),
                reminder_sent_at: new Date(Date.now() - 60_000).toISOString(), horario_agendado: '08:00',
                tentativas: 1, quantidade_por_dose: 1, medications: { nome: 'Ômega 3', forma_farmaceutica: 'capsula', unidade_dose: 'unidade' }
            }] });
            const blocoP1 = renderizarBlocoDoses(estP1);
            checks.push({
                marco: 'M4',
                nome: 'P1: nenhum UUID de dose no bloco do principal (ref curta D1, mapa só no turno)',
                ok: !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(blocoP1) && /\[D1\] Ômega 3/.test(blocoP1) && mapaP1.get('D1')?.id === uuidDose,
                detalhe: blocoP1.split('\n').filter(l => l.includes('[D')).join(' | ')
            });
            // ---- Guardas do v45 P1-copy (textos, sem LLM) ----
            // v47 Onda 2: builders proativos moram em templates/ (movidos por equivalência).
            const { buildEstoqueZeradoMessage } = await import('../src/templates/lembreteTemplates.js');
            const zerado = buildEstoqueZeradoMessage('Eloísa', { med_nome: 'Desogestrel' });
            checks.push({
                marco: 'M4',
                nome: 'P1-copy §1: lembrete de estoque zerado NÃO diz "não foi possível registrar" e oferece o SIM',
                ok: !/não foi possível registrar/i.test(zerado) && /responder SIM que eu registro/.test(zerado),
                detalhe: zerado.replace(/\n/g, ' / ')
            });
            const { escolherAbertura, aberturaUsada, ABERTURAS_CONFIRMACAO } = await import('../src/dosesDoTurno.js');
            const { textoDeConfirmacao, linhaNaoTomada } = await import('../src/templates/dose.js');
            const agoraP1 = new Date();
            const doseHoje = { scheduled_at: new Date(agoraP1.getTime() - 60_000).toISOString(), horario_agendado: '06:28', medications: { nome: 'Roacutan' } };
            const doseOntem = { scheduled_at: new Date(agoraP1.getTime() - 24 * 60 * 60 * 1000).toISOString(), horario_agendado: '06:28', medications: { nome: 'Roacutan' } };
            const ddmmOntem = new Date(doseOntem.scheduled_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
            const tHoje = textoDeConfirmacao({ abertura: 'Isso aí, João!', confirmadas: [doseHoje] });
            const tOntem = textoDeConfirmacao({ abertura: 'Tudo certo, João!', confirmadas: [doseOntem] });
            checks.push({
                marco: 'M4',
                nome: 'P1-copy §2: confirmação de HOJE sem data; de ONTEM com data (formato do fato)',
                ok: tHoje === 'Isso aí, João! ✅ *Roacutan* de hoje (06:28) confirmada 💊'
                    && tOntem === `Tudo certo, João! ✅ *Roacutan* de ontem (${ddmmOntem}, 06:28) confirmada 💊`,
                detalhe: `${tHoje} | ${tOntem}`
            });
            const sorteios = Array.from({ length: 30 }, () => escolherAbertura({ nome: 'João', ultima: 'Boa' }));
            checks.push({
                marco: 'M4',
                nome: 'P1-copy §2.1: abertura nunca repete a última; sem nome, sem vírgula',
                ok: sorteios.every(a => !a.startsWith('Boa') && ABERTURAS_CONFIRMACAO.includes(aberturaUsada(`${a} ✅ x`)))
                    && /^[A-Za-zÀ-ú ]+!$/.test(escolherAbertura({ nome: null })),
                detalhe: `${[...new Set(sorteios)].join(' · ')} | sem nome: ${escolherAbertura({ nome: null })}`
            });
            const tParcial = textoDeConfirmacao({ abertura: 'Show, João!', confirmadas: [doseHoje], jaRegistradas: [doseOntem] });
            checks.push({
                marco: 'M4',
                nome: 'P1-copy §4: confirmação parcial lista "Confirmei agora" e "Já estavam registradas"',
                ok: tParcial === `Show, João! ✅ Confirmei agora:\n• Roacutan de hoje (06:28)\n\nJá estavam registradas: Roacutan (${ddmmOntem}, 06:28).`,
                detalhe: tParcial.replace(/\n/g, ' / ')
            });
            checks.push({
                marco: 'M4',
                nome: 'P1-copy §2.2: linha fixa da dose fechada como não tomada',
                ok: linhaNaoTomada(doseOntem) === `O *Roacutan* de ontem (${ddmmOntem}, 06:28) ficou registrado como não tomado.`,
                detalhe: linhaNaoTomada(doseOntem)
            });
            const { renderizarPerguntaNome } = await import('../src/schemas/cadastro.js');
            const conviteP1 = renderizarPerguntaNome({ userName: 'Fran' });
            const conviteFalha = renderizarPerguntaNome({ userName: 'Fran', motivoFalha: 'ruido' });
            checks.push({
                marco: 'M4',
                nome: 'P1-copy §9: cadastro novo abre com o convite de três linhas, sem "Qual o *nome*"',
                ok: conviteP1.startsWith('Vamos cadastrar, Fran! 💊') && /• o nome do remédio\n• quanto você toma por vez\n• os horários/.test(conviteP1)
                    && !/Qual o \*nome\*/.test(conviteP1) && conviteFalha.startsWith('Desculpa, não consegui identificar o remédio 😊')
                    && /Qual o \*nome\*/.test(renderizarPerguntaNome({ userName: 'Fran', nomeRecusadoPorDosagem: true })),
                detalhe: conviteP1.replace(/\n/g, ' / ')
            });
            const { respostaHonestaAindaNao } = await import('../src/inventario.js');
            checks.push({
                marco: 'M4',
                nome: 'P1-copy §8: "ainda não faço" com chave nomeia o item do inventário (nunca "isso")',
                ok: /ouvir áudios/.test(respostaHonestaAindaNao('audio')) && !/\bisso\b/.test(respostaHonestaAindaNao('audio')),
                detalhe: respostaHonestaAindaNao('audio')
            });
            checks.push({
                marco: 'M4',
                nome: 'P1: normalização do atalho reduz letras repetidas e bordas ("Simmm!" → "sim")',
                ok: normalizarParaAtalho('Simmm!') === 'sim' && normalizarParaAtalho('Já tomei 👍') === 'ja tomei' && normalizarParaAtalho('Não') === 'nao',
                detalhe: `${normalizarParaAtalho('Simmm!')} | ${normalizarParaAtalho('Já tomei 👍')} | ${normalizarParaAtalho('Não')}`
            });

            // ---- Guardas do v45 P1-ajustes 2 (um autor por fato, sem LLM) ----
            const filtroRegex = [...conteudo.entries()].filter(([, c]) => /limparTextoDoFatoDeEstoque|RE_NARRA_GRAVACAO/.test(c)).map(([f]) => f);
            checks.push({ marco: 'M4', nome: 'grep (P1-ajustes 2 §2): limparTextoDoFatoDeEstoque/RE_NARRA_GRAVACAO não existem', ok: filtroRegex.length === 0, detalhe: filtroRegex.join(', ') || 'limpo' });
            const corpoAindaNao = router.match(/function textoAindaNao\([\s\S]*?\n\}/)?.[0] || '';
            checks.push({ marco: 'M4', nome: 'grep (P1-ajustes 2 §1): textoAindaNao não lê decisao.message', ok: !!corpoAindaNao && !/\.message\b/.test(corpoAindaNao), detalhe: corpoAindaNao ? 'limpo' : 'função não encontrada' });
            const promptP = conteudo.get('prompts.js') || '';
            checks.push({
                marco: 'M4',
                nome: 'grep (P1-ajustes 2 §3): bloco "ERRO" SEM DIZER O QUÊ fora do prompt; regra de INTENÇÃO DE CORRIGIR no lugar',
                ok: !/"ERRO" SEM DIZER O QU/.test(promptP) && /INTENÇÃO DE CORRIGIR/.test(promptP),
                detalhe: `bloco antigo: ${/"ERRO" SEM DIZER O QU/.test(promptP)}, regra nova: ${/INTENÇÃO DE CORRIGIR/.test(promptP)}`
            });
            checks.push({
                marco: 'M4',
                nome: 'grep (P1-ajustes 2 §1): prompt sem a regra de oferecer alternativa no "ainda não"',
                ok: !/algo próximo que a Nami já faz/.test(promptP),
                detalhe: /algo próximo que a Nami já faz/.test(promptP) ? 'regra presente' : 'limpo'
            });
            const { respostaAindaNaoPadrao } = await import('../src/inventario.js');
            const padraoSimples = respostaAindaNaoPadrao({ nome: 'Ana', pedido: 'mudar o Rivotril para dias alternados' });
            checks.push({
                marco: 'M4',
                nome: 'P1-ajustes 2 §1: reserva do "ainda não" não muda com misto_com_nunca',
                ok: respostaAindaNaoPadrao({ nome: 'Ana', pedido: 'mudar o Rivotril para dias alternados', mistoComNunca: true }) === padraoSimples,
                detalhe: padraoSimples
            });
            const { buildEstoqueAtualizadoMessage } = await import('../src/templates/estoqueTemplates.js');
            const linhaEst = (n, medForma, unidadeEstoque = 'unidade') => buildEstoqueAtualizadoMessage({ medNome: 'X', estoqueAnterior: 0, estoqueNovo: n, deltaAplicado: n, quantidadeSolicitada: n, medForma, unidadeEstoque });
            const linhasEst = [linhaEst(20, 'comprimido'), linhaEst(1, 'comprimido'), linhaEst(30, 'capsula'), linhaEst(20, 'gotas', 'ml')];
            checks.push({
                marco: 'M4',
                nome: 'P1-ajustes 2 §2: linha do estoque no formato da confirmação, com o rótulo da forma (nunca "unidades" p/ comprimido)',
                ok: linhasEst[0] === '📦 Estoque do *X* atualizado: *20* comprimidos.' && linhasEst[1] === '📦 Estoque do *X* atualizado: *1* comprimido.'
                    && linhasEst[2] === '📦 Estoque do *X* atualizado: *30* cápsulas.' && linhasEst[3] === '📦 Estoque do *X* atualizado: *20* ml.',
                detalhe: linhasEst.join(' | ')
            });
            checks.push({
                marco: 'M4',
                nome: 'P1-ajustes 2 §2: a abertura do estoque conta como "última abertura" da pessoa',
                ok: aberturaUsada('Show, Ana! 📦 Estoque do *X* atualizado: *20* comprimidos.') === 'Show',
                detalhe: String(aberturaUsada('Show, Ana! 📦 Estoque do *X* atualizado: *20* comprimidos.'))
            });

            // ---- Guardas do v45 P1-ajustes 3 (contrato único da decisão, sem LLM) ----
            // Cada combinação que o prompt instrui o principal a usar tem que passar
            // no validador — se divergirem, quebra aqui, não no WhatsApp.
            const { decisaoValida } = await import('../src/agentes/principal.js');
            const { textoDosTipos, textoDasRegras, TIPOS: TIPOS_CONTRATO } = await import('../src/contratoPrincipal.js');
            const est = { type: 'UPDATE_STOCK', medicationId: 'm1', modo: 'soma', quantidade: 20, motivo: 'recompra' };
            const base = { message: '', doses: [], actions: [], feedback: 'nenhum' };
            const combinacoes = [
                ['acao + message vazia + UPDATE_STOCK (soma)', { ...base, tipo: 'acao', actions: [est] }, true],
                ['acao + message vazia + UPDATE_STOCK (set)', { ...base, tipo: 'acao', actions: [{ ...est, modo: 'set', motivo: null }] }, true],
                ['dose + dose + UPDATE_STOCK (compra + "Sim")', { ...base, tipo: 'dose', doses: [{ ref: 'D1', fato: 'tomou' }], actions: [est] }, true],
                ['dose "tomou" pura, message vazia', { ...base, tipo: 'dose', doses: [{ ref: 'D1', fato: 'tomou' }] }, true],
                ['delegar nao_suportado + message vazia + chave', { ...base, tipo: 'delegar', delegar: { especialista: 'nao_suportado', relacao_pendencia: 'novo', chave_ainda_nao: 'alterar_frequencia' } }, true],
                ['delegar nao_suportado + message vazia + pedido', { ...base, tipo: 'delegar', delegar: { especialista: 'nao_suportado', relacao_pendencia: 'novo', pedido: 'me lembrar de beber água' } }, true],
                ['delegar configuracao + message vazia', { ...base, tipo: 'delegar', delegar: { especialista: 'configuracao', relacao_pendencia: 'novo' } }, true],
                ['dose ainda_nao + acolhimento', { ...base, tipo: 'dose', message: 'Tudo bem, me avisa quando tomar. 🌿', doses: [{ ref: 'D1', fato: 'ainda_nao' }] }, true],
                ['dose nao_tomou + acolhimento', { ...base, tipo: 'dose', message: 'Tudo bem, acontece. 🌿', doses: [{ ref: 'D1', fato: 'nao_tomou' }] }, true],
                ['perguntar + message', { ...base, tipo: 'perguntar', message: 'Poxa, me desculpa! O que ficou errado?' }, true],
                ['responder + message', { ...base, tipo: 'responder', message: 'Oi! 🌿' }, true],
                ['acao + SET_USER_NAME + message', { ...base, tipo: 'acao', message: 'Combinado, Gui! 🌿', actions: [{ type: 'SET_USER_NAME', name: 'Gui' }] }, true],
                ['RECUSA: acao sem ação', { ...base, tipo: 'acao' }, false],
                ['RECUSA: acao só SET_USER_NAME sem message', { ...base, tipo: 'acao', actions: [{ type: 'SET_USER_NAME', name: 'Gui' }] }, false],
                ['RECUSA: dose sem dose', { ...base, tipo: 'dose', actions: [est] }, false],
                ['RECUSA: nao_suportado sem chave nem pedido', { ...base, tipo: 'delegar', delegar: { especialista: 'nao_suportado', relacao_pendencia: 'novo' } }, false],
                ['RECUSA: nao_tomou sem acolhimento', { ...base, tipo: 'dose', doses: [{ ref: 'D1', fato: 'nao_tomou' }] }, false],
                ['RECUSA: perguntar sem message', { ...base, tipo: 'perguntar' }, false]
            ];
            const { NAMI_SYSTEM_PROMPT: promptRender } = await import('../src/prompts.js');
            const avessas = combinacoes.filter(([, dec, esperado]) => decisaoValida(dec) !== esperado).map(([n]) => n);
            checks.push({ marco: 'M4', nome: `P1-ajustes 3 §2: validador aceita cada combinação que o prompt instrui (${combinacoes.length} combinações, 6 recusas)`, ok: avessas.length === 0, detalhe: avessas.join(' | ') || 'todas conforme' });
            checks.push({
                marco: 'M4',
                nome: 'P1-ajustes 3 §1.2: prompt descreve os tipos e as regras a partir do contrato único (inclui "acao")',
                ok: promptRender.includes(textoDosTipos()) && promptRender.includes(textoDasRegras()) && TIPOS_CONTRATO.includes('acao'),
                detalhe: `tipos: ${promptRender.includes(textoDosTipos())}, regras: ${promptRender.includes(textoDasRegras())}, tipos do contrato: ${TIPOS_CONTRATO.join(',')}`
            });
            const principalSrc = conteudo.get(path.join('agentes', 'principal.js')) || '';
            const corpoValida = principalSrc.match(/function decisaoValida\([\s\S]*?\n\}/)?.[0] || '';
            checks.push({ marco: 'M4', nome: 'grep (P1-ajustes 3 §1.2): nenhuma regra de tipo escrita à mão no validador', ok: !!corpoValida && !/input\.tipo\s*===|\.message\.trim|doses\.length/.test(corpoValida) && /violacaoDoContrato/.test(corpoValida), detalhe: corpoValida ? 'só o contrato' : 'decisaoValida não encontrada' });
            checks.push({ marco: 'M4', nome: 'P1-ajustes 3 §1.3: estoque manda usar o tipo "acao" com message vazia', ok: /use o tipo "acao"[\s\S]{0,80}deixe "message" vazia/.test(promptP), detalhe: 'regra UM FATO, UM AUTOR' });
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
            checks.push({ marco: 'M3', nome: 'M3: reconhece "todos" com UMA confirmação agregada', ...contem(r1, /todos os (seus )?(4 )?(rem[ée]dios|medicamentos|tratamentos)|os 4 (rem[ée]dios|medicamentos|tratamentos)|4 medicamentos/i, 'confirmação agregada') });
            checks.push({ marco: 'M3', nome: 'M3: nunca pede para escolher UM de cada vez', ...naoContem(r1, /qual (deles|medicamento|rem[ée]dio|tratamento) você (quer|deseja)/i, 'seleção um-a-um') });

            // P6.4 (M3): a confirmação executa o lote inteiro, com status explícito.
            const r2 = await turno(ctx, user, 'Sim');
            checagensDeForma(checks, 'turno 2', r2);
            const medsDepois = await medicamentos(ctx.db, user.id);
            const todosEncerrados = medsDepois.length === 4
                && medsDepois.every(m => m.status === 'encerrado' && (m.schedules || []).every(s => !s.ativo));
            checks.push({
                marco: 'M3',
                nome: 'M3: os 4 encerrados no banco com status explícito (P1) e schedules inativos',
                ok: todosEncerrados,
                detalhe: medsDepois.map(m => `${m.nome}:${m.status}`).join(', ')
            });
            checks.push({ marco: 'M3', nome: 'M3: fechamento declara os 4 pelo nome', ok: /ômega|omega/i.test(r2) && /losartana/i.test(r2) && /vitamina d/i.test(r2) && /melatonina/i.test(r2), detalhe: r2.slice(0, 200) });
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
    },

    // --------------------------------------------------------
    {
        id: 'A26',
        marco: 'M3',
        titulo: 'Edição = schema em modo correção (P2): nome, dosagem, qtd/dose, duração, horário (MH-41) e perfil (MH-75)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Editor', onboarded: true, nascimento: '1980-01-01', estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({
                userId: user.id, nome: 'Enalapril', dosagem: '10mg',
                estoque: 30, horarios: ['08:00'], quantidadePorDose: 1
            });

            // 1. NOME — antes → depois pós-escrita.
            const r1 = await turno(ctx, user, 'O nome do Enalapril tá errado, o certo é Enalapril Maleato');
            checagensDeForma(checks, 'nome', r1);
            let m = (await medicamentos(ctx.db, user.id))[0];
            checks.push({
                nome: 'nome corrigido no banco (Enalapril → Enalapril Maleato)',
                ok: /^enalapril maleato$/i.test(m?.nome || ''),
                detalhe: `nome: ${m?.nome}`
            });
            checks.push({ nome: 'nome: declara antes → depois', ok: /enalapril/i.test(r1) && /maleato/i.test(r1) && /atualizad|corrig/i.test(r1), detalhe: r1.slice(0, 140) });

            // 2. DOSAGEM.
            const r2 = await turno(ctx, user, 'A dosagem do Enalapril Maleato na verdade é 20mg');
            checagensDeForma(checks, 'dosagem', r2);
            m = (await medicamentos(ctx.db, user.id))[0];
            checks.push({ nome: 'dosagem corrigida no banco (10mg → 20mg)', ok: m?.dosagem === '20mg', detalhe: `dosagem: ${m?.dosagem}` });
            checks.push({ nome: 'dosagem: declara antes → depois', ok: /10mg/.test(r2) && /20mg/.test(r2), detalhe: r2.slice(0, 140) });

            // 3. QUANTIDADE POR DOSE.
            const r3 = await turno(ctx, user, 'Agora eu tomo 2 comprimidos do Enalapril Maleato por vez');
            checagensDeForma(checks, 'quantidade', r3);
            m = (await medicamentos(ctx.db, user.id))[0];
            const qtds = (m?.schedules || []).filter(s => s.ativo).map(s => Number(s.quantidade_por_dose));
            checks.push({ nome: 'quantidade por dose atualizada (1 → 2)', ok: qtds.length === 1 && qtds[0] === 2, detalhe: `quantidades: ${qtds.join(', ')}` });

            // 4. DURAÇÃO — recalcula tratamento_fim (MH-43 parcial).
            const r4 = await turno(ctx, user, 'O tratamento do Enalapril Maleato agora é por 10 dias');
            checagensDeForma(checks, 'duração', r4);
            m = (await medicamentos(ctx.db, user.id))[0];
            const fimEsperado = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            checks.push({
                nome: 'duração: temporário de 10 dias com tratamento_fim recalculada',
                ok: m?.tipo_tratamento === 'temporario' && Number(m?.tratamento_dias) === 10 && m?.tratamento_fim === fimEsperado,
                detalhe: `tipo: ${m?.tipo_tratamento}, dias: ${m?.tratamento_dias}, fim: ${m?.tratamento_fim} (esperado ${fimEsperado})`
            });

            // 5. HORÁRIO — MH-41: dose pendente do horário antigo CANCELADA no ato.
            const dosePendente = await seeds.criarDosePendente({
                medicationId: med.id, scheduleId: schedules[0].id, horario: '08:00', minutosAtras: 60
            });
            await turno(ctx, user, 'Muda o lembrete do Enalapril Maleato das 8 para as 9 da manhã');
            const r5 = await turno(ctx, user, 'Sim');
            m = (await medicamentos(ctx.db, user.id))[0];
            const horariosAtivos = (m?.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5));
            checks.push({ nome: 'horário alterado no banco (08:00 → 09:00)', ok: horariosAtivos.length === 1 && horariosAtivos[0] === '09:00', detalhe: `horários: ${horariosAtivos.join(', ')}` });
            const logs = await doseLogs(ctx.db, med.id);
            const dosePos = logs.find(d => d.id === dosePendente.id);
            checks.push({
                nome: 'MH-41: dose pendente das 08:00 CANCELADA no mesmo ato',
                ok: dosePos?.status === 'pausado',
                detalhe: `status da dose antiga: ${dosePos?.status}`
            });

            // 5b. NOME com "de → para" na MESMA mensagem (replay 20/09): o "pra Y"
            // resolve na hora — nunca repergunta.
            const r5b = await turno(ctx, user, 'Troca o nome do Enalapril Maleato pra Enalapril Max');
            checagensDeForma(checks, 'nome pra', r5b);
            m = (await medicamentos(ctx.db, user.id))[0];
            checks.push({
                nome: '"pra Y" aplicado em UM turno (Enalapril Maleato → Enalapril Max)',
                ok: /^enalapril max$/i.test(m?.nome || ''),
                detalhe: `nome: ${m?.nome}`
            });
            checks.push({ nome: '"pra Y": nunca repergunta o nome certo', ...naoContem(r5b, /qual o nome certo/i, 'repergunta') });

            // 5c. PERFIL — nome do usuário (replay 20/09: "Corrigir meu nome"
            // virou o nome!): sem valor claro, PERGUNTA; nunca escreve dedução.
            const r5c = await turno(ctx, user, 'Quero corrigir meu nome');
            checagensDeForma(checks, 'perfil nome pergunta', r5c);
            const { data: userMeio } = await ctx.db.from('users').select('name').eq('id', user.id).single();
            checks.push({
                nome: 'pedido sem valor NÃO altera o nome (pergunta primeiro)',
                ok: userMeio?.name === 'Editor',
                detalhe: `name: ${userMeio?.name}`
            });
            checks.push({ nome: 'pergunta como quer ser chamado', ...contem(r5c, /chame|chamar|nome/i, 'pergunta do nome') });
            const r5d = await turno(ctx, user, 'Pode me chamar de Eduardo');
            checagensDeForma(checks, 'perfil nome valor', r5d);
            const { data: userFim } = await ctx.db.from('users').select('name').eq('id', user.id).single();
            checks.push({
                nome: 'nome do usuário atualizado (Editor → Eduardo)',
                ok: userFim?.name === 'Eduardo',
                detalhe: `name: ${userFim?.name}`
            });

            // 6. PERFIL (MH-75): data de nascimento em dois turnos.
            const r6 = await turno(ctx, user, 'Quero corrigir minha data de nascimento');
            checagensDeForma(checks, 'perfil pergunta', r6);
            checks.push({ nome: 'perfil: pede a data (nunca ignora o pedido)', ...contem(r6, /data de nascimento|nascimento/i, 'pergunta da data') });
            const r7 = await turno(ctx, user, '19/03/1985');
            checagensDeForma(checks, 'perfil valor', r7);
            const { data: userDepois } = await ctx.db.from('users').select('data_nascimento').eq('id', user.id).single();
            checks.push({
                nome: 'MH-75: data de nascimento atualizada no banco',
                ok: userDepois?.data_nascimento === '1985-03-19',
                detalhe: `data_nascimento: ${userDepois?.data_nascimento}`
            });
            checks.push({ nome: 'perfil: declara antes → depois', ok: /19\/03\/1985/.test(r7), detalhe: r7.slice(0, 140) });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A30',
        marco: 'M3',
        titulo: 'BUG-86 em duas partes — dupla pendência: vence a pergunta feita por último (P6.1)',
        async executar({ ctx, seeds }) {
            const checks = [];

            // (a) Cenário registrado de 01/08: fluxo de configuração aberto, o
            // follow-up da dose chega DEPOIS da pergunta → "Sim" é da DOSE.
            const userA = await seeds.criarUsuario({ nome: 'Parte A', onboarded: true, estado: 'idle' });
            const { med: cataflamA } = await seeds.criarMedicamento({ userId: userA.id, nome: 'Cataflam', horarios: ['08:00'] });
            const { med: omegaA, schedules: schedOmegaA } = await seeds.criarMedicamento({ userId: userA.id, nome: 'Ômega 3', horarios: ['12:00'] });

            const r1 = await turno(ctx, userA, 'Quero pausar o Cataflam');
            checks.push({ nome: '(a) setup: pergunta de confirmação do pausar', ...contem(r1, /pausar|confirmar/i, 'pergunta de confirmação') });
            // Follow-up da dose chega DEPOIS da pergunta do fluxo (fora da janela
            // de ambiguidade): a dose é o evento mais recente.
            await seeds.criarDosePendente({ medicationId: omegaA.id, scheduleId: schedOmegaA[0].id, horario: '12:00', minutosAtras: -3 });

            const r2 = await turno(ctx, userA, 'Sim');
            checagensDeForma(checks, '(a) "Sim"', r2);
            const logsOmegaA = await doseLogs(ctx.db, omegaA.id);
            checks.push({
                nome: '(a) dose do Ômega 3 confirmada (o follow-up era a pergunta mais recente)',
                ok: logsOmegaA.some(d => d.confirmed === true),
                detalhe: `status: ${logsOmegaA.map(d => d.status).join(', ')}`
            });
            const { data: cataflamDepoisA } = await ctx.db.from('medications')
                .select('status, schedules(ativo)').eq('id', cataflamA.id).single();
            checks.push({
                nome: '(a) Cataflam NÃO foi pausado pelo "Sim" da dose',
                ok: cataflamDepoisA?.status !== 'pausado' && (cataflamDepoisA?.schedules || []).some(s => s.ativo),
                detalhe: `status: ${cataflamDepoisA?.status}, schedules ativos: ${(cataflamDepoisA?.schedules || []).filter(s => s.ativo).length}`
            });

            // (b) O inverso: a dose chegou ANTES; a pergunta do fluxo é a mais
            // recente → "Sim" é da AÇÃO; a dose segue pendente.
            const userB = await seeds.criarUsuario({ nome: 'Parte B', onboarded: true, estado: 'idle' });
            const { med: cataflamB } = await seeds.criarMedicamento({ userId: userB.id, nome: 'Cataflam', horarios: ['08:00'] });
            const { med: omegaB, schedules: schedOmegaB } = await seeds.criarMedicamento({ userId: userB.id, nome: 'Ômega 3', horarios: ['12:00'] });
            const doseB = await seeds.criarDosePendente({ medicationId: omegaB.id, scheduleId: schedOmegaB[0].id, horario: '12:00', minutosAtras: 10 });

            await turno(ctx, userB, 'Quero pausar o Cataflam');
            const r4 = await turno(ctx, userB, 'Sim');
            checagensDeForma(checks, '(b) "Sim"', r4);
            const { data: cataflamDepoisB } = await ctx.db.from('medications')
                .select('status, schedules(ativo)').eq('id', cataflamB.id).single();
            checks.push({
                nome: '(b) Cataflam PAUSADO (a pergunta do fluxo era a mais recente) — status explícito P1',
                ok: cataflamDepoisB?.status === 'pausado' && (cataflamDepoisB?.schedules || []).every(s => !s.ativo),
                detalhe: `status: ${cataflamDepoisB?.status}, schedules ativos: ${(cataflamDepoisB?.schedules || []).filter(s => s.ativo).length}`
            });
            const doseBDepois = (await doseLogs(ctx.db, omegaB.id)).find(d => d.id === doseB.id);
            checks.push({
                nome: '(b) dose do Ômega 3 segue pendente (o "Sim" não era dela)',
                ok: doseBDepois?.confirmed === false && doseBDepois?.status === 'pendente',
                detalhe: `confirmed: ${doseBDepois?.confirmed}, status: ${doseBDepois?.status}`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A24',
        marco: 'M3',
        titulo: 'Reativação em 5 passos — porta 1 ("reativar X"): foto congelada, manter/mudar, horários declarados, convite de estoque',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Reativa', onboarded: true, estado: 'idle' });
            const { med } = await seeds.criarMedicamento({
                userId: user.id, nome: 'Sertralina', dosagem: '50mg',
                estoque: null, horarios: ['07:00', '19:00'], quantidadePorDose: 2
            });
            // Pausa pelo fluxo real (escreve o status explícito do P1).
            await turno(ctx, user, 'Pausar a Sertralina');
            await turno(ctx, user, 'Sim');
            const { data: medPausado } = await ctx.db.from('medications').select('status').eq('id', med.id).single();
            if (medPausado?.status !== 'pausado') {
                return [{ nome: 'setup: Sertralina pausada com status explícito', ok: false, detalhe: `status: ${medPausado?.status}` }];
            }

            // Porta 1 — passo 1+2: foto congelada + manter ou mudar.
            const r1 = await turno(ctx, user, 'Quero reativar a Sertralina');
            checagensDeForma(checks, 'passo 1+2', r1);
            checks.push({ nome: 'foto congelada: horários preservados exibidos (07:00 e 19:00)', ok: /07:00/.test(r1) && /19:00/.test(r1), detalhe: r1.slice(0, 200) });
            checks.push({ nome: 'foto congelada: posologia exibida (2 por horário)', ...contem(r1, /2 comprimidos|2 unidades/i, 'quantidade da foto') });
            checks.push({ nome: 'passo 2: pergunta "manter ou mudar"', ...contem(r1, /manter|mudar/i, 'manter ou mudar') });

            // Passo 3: alteração dita na resposta — na forma REAL dos replays de
            // 20/09: "as 8" sem sufixo (vazava pro cadastro) e QUANTIDADES junto
            // dos horários (eram ignoradas no caso Pratz).
            const r2 = await turno(ctx, user, 'Vou tomar 2 comprimidos as 8 e 1 comprimido as 20hrs');
            checagensDeForma(checks, 'passo 3+4', r2);
            checks.push({ nome: 'passo 3: a resposta fica no fluxo (nunca repergunta o nome do medicamento)', ...naoContem(r2, /qual o \*?nome\*?/i, 'repergunta de nome') });
            const { data: medDepois } = await ctx.db.from('medications')
                .select('status, schedules(horario, ativo, quantidade_por_dose)').eq('id', med.id).single();
            const ativos = (medDepois?.schedules || []).filter(s => s.ativo)
                .map(s => ({ h: String(s.horario).slice(0, 5), q: Number(s.quantidade_por_dose) }))
                .sort((a, b) => a.h.localeCompare(b.h));
            checks.push({
                nome: 'passo 4: reativado com a grade NOVA e as QUANTIDADES ditas (08:00 — 2, 20:00 — 1)',
                ok: medDepois?.status === 'ativo' && ativos.length === 2
                    && ativos[0].h === '08:00' && ativos[0].q === 2
                    && ativos[1].h === '20:00' && ativos[1].q === 1,
                detalhe: `status: ${medDepois?.status}, schedules: ${JSON.stringify(ativos)}`
            });
            checks.push({ nome: 'passo 4: confirmação DECLARA os horários vigentes', ok: /08:00/.test(r2) && /20:00/.test(r2), detalhe: r2.slice(0, 200) });
            checks.push({ nome: 'passo 5: convite de estoque no template do cadastro (com porta de saída)', ok: /📦/.test(r2) && /tudo bem/i.test(r2), detalhe: r2.slice(-200) });

            // Passo 5: estoque respondido fecha pelo template pós-escrita.
            const r3 = await turno(ctx, user, '30');
            checagensDeForma(checks, 'passo 5', r3);
            const { data: medFinal } = await ctx.db.from('medications').select('estoque_atual').eq('id', med.id).single();
            checks.push({ nome: 'estoque do convite gravado (30)', ok: Number(medFinal?.estoque_atual) === 30, detalhe: `estoque_atual: ${medFinal?.estoque_atual}` });

            // Replay 20/09: "reativar" um tratamento JÁ ATIVO responde a verdade
            // do banco, nunca abre o fluxo.
            const r4 = await turno(ctx, user, 'Reativar a Sertralina');
            checagensDeForma(checks, 'já ativo', r4);
            checks.push({ nome: 'já ativo: responde direto com os horários vigentes', ok: /j[áa] est[áa] ativ/i.test(r4) && /08:00/.test(r4), detalhe: r4.slice(0, 160) });
            checks.push({ nome: 'já ativo: não abre o fluxo de reativação', ...naoContem(r4, /manter|mudar algo/i, 'fluxo de reativação') });

            // Replay 20/09 (foto do Pratz com 4 horários): grades substituídas
            // são APAGADAS — a foto congelada de um novo pause mostra SÓ a grade
            // vigente, nunca horários de grades mortas.
            await turno(ctx, user, 'Pausar a Sertralina');
            await turno(ctx, user, 'Sim');
            const r5 = await turno(ctx, user, 'Reativar a Sertralina');
            checagensDeForma(checks, 'foto exata', r5);
            checks.push({
                nome: 'foto congelada EXATA: só a grade vigente (08:00/20:00), sem grades mortas (07:00/19:00)',
                ok: /08:00/.test(r5) && /20:00/.test(r5) && !/07:00/.test(r5) && !/19:00/.test(r5),
                detalhe: r5.slice(0, 220)
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A25',
        marco: 'M3',
        titulo: 'Porta 2 — cadastrar medicamento pausado/encerrado: aviso + foto + oferta (BUG-61 morre)',
        async executar({ ctx, seeds }) {
            const checks = [];

            // (1) PAUSADO: cadastrar de novo → aviso + foto + oferta; "sim" reativa.
            const userP = await seeds.criarUsuario({ nome: 'Porta Dois', onboarded: true, estado: 'idle' });
            const { med: medP } = await seeds.criarMedicamento({
                userId: userP.id, nome: 'Atorvastatina', dosagem: '20mg', horarios: ['22:00'], quantidadePorDose: 1
            });
            await turno(ctx, userP, 'Pausar a Atorvastatina');
            await turno(ctx, userP, 'Sim');

            const r1 = await turno(ctx, userP, 'Quero cadastrar Atorvastatina');
            checagensDeForma(checks, 'pausado: aviso', r1);
            checks.push({ nome: 'pausado: avisa que já existe e mostra a foto (22:00)', ok: /pausad/i.test(r1) && /22:00/.test(r1), detalhe: r1.slice(0, 220) });
            checks.push({ nome: 'pausado: oferece reativar/recadastrar', ok: /reativ/i.test(r1) && /cadastrar/i.test(r1), detalhe: r1.slice(-160) });
            const medsP = await medicamentos(ctx.db, userP.id, { nomeIlike: 'Atorvastatina%' });
            checks.push({ nome: 'pausado: NUNCA registro duplicado silencioso', ok: medsP.length === 1, detalhe: `${medsP.length} registro(s)` });

            const r2 = await turno(ctx, userP, 'Sim');
            checagensDeForma(checks, 'pausado: escolha', r2);
            const r3 = await turno(ctx, userP, 'Manter assim');
            const { data: medPDepois } = await ctx.db.from('medications')
                .select('status, schedules(horario, ativo)').eq('id', medP.id).single();
            checks.push({
                nome: 'pausado: "sim" → reativação com a grade congelada (22:00 ativa)',
                ok: medPDepois?.status === 'ativo'
                    && (medPDepois?.schedules || []).some(s => s.ativo && String(s.horario).slice(0, 5) === '22:00'),
                detalhe: `status: ${medPDepois?.status}, resposta: ${String(r3).slice(0, 120)}`
            });

            // (2) ENCERRADO (BUG-61): cadastrar de novo avança para novo tratamento.
            const userE = await seeds.criarUsuario({ nome: 'Encerrou', onboarded: true, estado: 'idle' });
            await seeds.criarMedicamento({ userId: userE.id, nome: 'Amoxicilina', horarios: ['08:00'] });
            await turno(ctx, userE, 'Encerrar a Amoxicilina');
            await turno(ctx, userE, 'Sim');
            const { data: medE } = await ctx.db.from('medications')
                .select('id, status').eq('user_id', userE.id).single();
            if (medE?.status !== 'encerrado') {
                checks.push({ nome: 'setup: Amoxicilina encerrada', ok: false, detalhe: `status: ${medE?.status}` });
                return checks;
            }

            const r4 = await turno(ctx, userE, 'Quero cadastrar Amoxicilina de novo');
            checagensDeForma(checks, 'encerrado: aviso', r4);
            checks.push({ nome: 'encerrado: avisa o encerramento e mostra a foto', ok: /encerrad/i.test(r4) && /08:00/.test(r4), detalhe: r4.slice(0, 220) });

            // BUG-61: a confirmação curta ("Isso") AVANÇA o recadastro.
            const r5 = await turno(ctx, userE, 'Isso');
            checagensDeForma(checks, 'encerrado: "Isso"', r5);
            checks.push({ nome: 'BUG-61: "Isso" avança (pede a posologia do novo tratamento)', ...contem(r5, /quanto|hor[áa]rio/i, 'pergunta de posologia') });
            checks.push({ nome: 'encerrado: não repergunta o nome', ...naoContem(r5, /qual o \*?nome\*?/i, 'repergunta de nome') });

            const r6 = await turno(ctx, userE, '1 comprimido às 9h por 7 dias');
            checagensDeForma(checks, 'encerrado: posologia', r6);
            const medsE = await medicamentos(ctx.db, userE.id, { nomeIlike: 'Amoxicilina%' });
            const novo = medsE.find(m => m.status === 'ativo' || m.ativo === true);
            const antigo = medsE.find(m => m.id === medE.id);
            checks.push({
                nome: 'BUG-61: novo tratamento gravado (registro NOVO), encerrado preservado no histórico (MH-31)',
                ok: medsE.length === 2 && !!novo && novo.id !== medE.id && antigo?.status === 'encerrado',
                detalhe: `${medsE.length} registro(s); novo: ${novo?.id !== medE.id}; antigo: ${antigo?.status}`
            });
            const horariosNovo = (novo?.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5));
            checks.push({
                nome: 'recadastro: schedule 09:00 e tratamento de 7 dias',
                ok: horariosNovo.length === 1 && horariosNovo[0] === '09:00' && Number(novo?.tratamento_dias) === 7,
                detalhe: `horários: ${horariosNovo.join(', ')}; dias: ${novo?.tratamento_dias}`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A27',
        marco: 'M3',
        titulo: 'P4.1 — pergunta sobre UM medicamento responde sobre ELE (nunca a lista completa)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Consulta', onboarded: true, estado: 'idle' });
            await seeds.criarMedicamento({ userId: user.id, nome: 'Losartana', dosagem: '50mg', estoque: 30, horarios: ['08:00'] });
            await seeds.criarMedicamento({ userId: user.id, nome: 'Ômega 3', estoque: null, horarios: ['12:00'], quantidadePorDose: 2 });

            const r1 = await turno(ctx, user, 'Me mostra os dados do Ômega 3');
            checagensDeForma(checks, 'visão específica', r1);
            checks.push({ nome: 'responde sobre ELE: nome + horário do banco', ok: /ômega|omega/i.test(r1) && /12:00/.test(r1), detalhe: r1.slice(0, 220) });
            checks.push({ nome: 'nunca a lista completa (Losartana fora)', ...naoContem(r1, /losartana/i, 'outro medicamento') });
            checks.push({ nome: 'dados do banco: posologia (2 por vez) e estoque não informado', ok: /2 por vez|2 unidades|— 2\b/.test(r1) && /n[ãa]o informado/i.test(r1), detalhe: r1.slice(0, 260) });
            checks.push({ nome: 'status explícito exibido (ativo)', ...contem(r1, /ativo/i, 'status') });

            // Replay 20/09 (correção de Guilherme): a LISTA mostra a posologia,
            // não só os horários.
            const r2 = await turno(ctx, user, 'Mostra meus remédios');
            checagensDeForma(checks, 'lista', r2);
            checks.push({
                nome: 'lista com POSOLOGIA: quantidade por dose em cada linha',
                ok: /1 comprimido às 08:00/i.test(r2) && /2 comprimidos às 12:00/i.test(r2),
                detalhe: r2.slice(0, 300)
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A28',
        marco: 'M3',
        titulo: 'P4.3 — período livre: dia antigo é leitura pura; intervalo funciona; antes do início é resposta honesta',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Leitor', onboarded: true, estado: 'idle' });
            // Usuário com 40 dias de Nami (o seed nasce agora — recua o created_at).
            const inicioISO = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
            await ctx.db.from('users').update({ created_at: inicioISO }).eq('id', user.id);
            user.created_at = inicioISO;
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Enalapril', horarios: ['08:00'] });

            // Dose CONFIRMADA há 5 dias e uma SEM resposta há 5 dias (mesmo dia).
            const cincoDiasAtras = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
            const dataAntigaISO = cincoDiasAtras.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
            const [, mesA, diaA] = dataAntigaISO.split('-');
            await ctx.db.from('dose_logs').insert([
                {
                    medication_id: med.id, schedule_id: schedules[0].id,
                    scheduled_at: new Date(`${dataAntigaISO}T08:00:00-03:00`).toISOString(),
                    horario_agendado: '08:00', reminder_sent: true, confirmed: true,
                    status: 'confirmado', taken_at: new Date(`${dataAntigaISO}T08:05:00-03:00`).toISOString()
                },
                {
                    medication_id: med.id, schedule_id: schedules[0].id,
                    scheduled_at: new Date(`${dataAntigaISO}T20:00:00-03:00`).toISOString(),
                    horario_agendado: '20:00', reminder_sent: true, confirmed: false,
                    status: 'nao_informado'
                }
            ]);

            // (a) Dia antigo (5 dias, fora da janela de 30 que existia): leitura pura.
            const r1 = await turno(ctx, user, `O que eu tomei no dia ${diaA}/${mesA}?`);
            checagensDeForma(checks, 'dia antigo', r1);
            checks.push({ nome: '(a) dia antigo LIDO (a trava de 30 dias não existe mais para leitura)', ...naoContem(r1, /[úu]ltimos 30 dias/i, 'trava antiga de janela') });
            checks.push({ nome: '(a) fato do banco: dose confirmada aparece', ...contem(r1, /enalapril/i, 'nome do medicamento') });
            checks.push({ nome: '(a) A31: nunca "não tomou" para dose sem resposta', ...naoContem(r1, /n[ãa]o tomou|n[ãa]o tomad[oa]/i, 'afirmação de não-tomada') });

            // (b) Intervalo: "como foi minha semana?" agrega os dias.
            const r2 = await turno(ctx, user, 'Como foi minha semana? Quero ver minha adesão');
            checagensDeForma(checks, 'intervalo', r2);
            checks.push({ nome: '(b) intervalo funciona: resposta agregada com contagem de doses', ok: /doses confirmadas|de \d+ doses/i.test(r2), detalhe: r2.slice(0, 260) });
            checks.push({ nome: '(b) sem a recusa antiga dos períodos fechados (7/15/30)', ...naoContem(r2, /per[íi]odos fechados|7, 15 ou 30/i, 'recusa da adesão reativa') });

            // (c) Data anterior ao created_at: resposta honesta.
            const r3 = await turno(ctx, user, 'O que eu tomei em 01/01/2025?');
            checagensDeForma(checks, 'antes do início', r3);
            checks.push({ nome: '(c) antes do início da Nami → resposta honesta com a data de começo', ...contem(r3, /come[çc]amos a conversar|come[çc]ou a conversar|ainda n[ãa]o estava com você/i, 'resposta honesta') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A29',
        marco: 'M3',
        titulo: 'P5 — elegibilidade do proativo (função pura, determinística): <7d sem semanal; <28d sem mensal',
        async executar({ ctx, seeds }) {
            const checks = [];
            const { elegivelParaResumo, enviarResumoSemanal } = await import('../src/agentes/relatorios.js');

            const casos = [
                ['2026-09-17', 'semanal', false], // 3 dias
                ['2026-09-13', 'semanal', false], // exatamente 7 — precisa de MAIS de 7
                ['2026-09-10', 'semanal', true],  // 10 dias
                ['2026-09-10', 'mensal', false],  // 10 dias
                ['2026-08-23', 'mensal', false],  // exatamente 28
                ['2026-08-20', 'mensal', true],   // 31 dias
                [null, 'semanal', false]
            ];
            const hoje = '2026-09-20';
            const falhas = casos.filter(([created, tipo, esperado]) =>
                elegivelParaResumo({ created_at: created }, tipo, hoje) !== esperado);
            checks.push({
                nome: 'função pura: fronteiras de 7 e 28 dias exatas (> estrito)',
                ok: falhas.length === 0,
                detalhe: falhas.length ? `falhas: ${JSON.stringify(falhas)}` : 'todas as fronteiras corretas'
            });

            // Quem não é elegível simplesmente NÃO recebe — sem mensagem substituta.
            const userNovo = await seeds.criarUsuario({ nome: 'Recém Chegado', onboarded: true, estado: 'idle' });
            const antes = ctx.enviosCapturados.length;
            await enviarResumoSemanal(userNovo);
            checks.push({
                nome: 'usuário com <7 dias NÃO recebe o resumo de domingo (nenhum envio)',
                ok: ctx.enviosCapturados.length === antes,
                detalhe: `${ctx.enviosCapturados.length - antes} envio(s) capturado(s)`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A31',
        marco: 'M3',
        titulo: 'A31 — epistemologia de status (transversal): confirmado ≠ tomado; semanal byte a byte',
        async executar({ ctx, seeds }) {
            const checks = [];

            // Semanal INTOCADO (critério de aceite 4): byte a byte contra o
            // snapshot capturado antes do M3.
            const crypto = await import('node:crypto');
            const { montarMensagemSemanal } = await import('../src/templates/adesaoTemplates.js');
            const amostras = [
                montarMensagemSemanal({ nome: 'Maria', taxa: 92, faixa: '80_99', semana: 2 }),
                montarMensagemSemanal({ nome: 'Maria', taxa: 100, faixa: '100', semana: 1 }),
                montarMensagemSemanal({ nome: 'Maria', taxa: 45, faixa: 'abaixo_50', semana: 1 })
            ];
            const esperados = [
                'fa8feb5eef416c8de4e4c5a75733e7583ec7d80ae91353faf56ef37b71cac362',
                'ed263f4ad5407f74376fbc5f8517ad21dab2cdbd47bba1c636ab92cf40f833c8',
                '1265d832f054c43fd7fac112efe55fe314c28cf605d45890339ae01f430897d2'
            ];
            const intocado = amostras.every((a, i) =>
                crypto.createHash('sha256').update(a).digest('hex') === esperados[i]);
            checks.push({ nome: 'copy do resumo semanal byte a byte IGUAL ao pré-M3', ok: intocado, detalhe: intocado ? 'hashes idênticos' : 'o copy semanal MUDOU' });

            // "Quais remédios tomei hoje?" — confirmados + pendências, nunca
            // "você não tomou" para dose sem resposta.
            const user = await seeds.criarUsuario({ nome: 'Episteme', onboarded: true, estado: 'idle' });
            const { med: medA, schedules: schedA } = await seeds.criarMedicamento({ userId: user.id, nome: 'Losartana', estoque: 30, horarios: ['06:00'] });
            const { med: medB, schedules: schedB } = await seeds.criarMedicamento({ userId: user.id, nome: 'Metformina', estoque: null, horarios: ['06:30'] });
            const hojeISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
            await ctx.db.from('dose_logs').insert([
                {
                    medication_id: medA.id, schedule_id: schedA[0].id,
                    scheduled_at: new Date(`${hojeISO}T06:00:00-03:00`).toISOString(),
                    horario_agendado: '06:00', reminder_sent: true, confirmed: true,
                    status: 'confirmado', taken_at: new Date(`${hojeISO}T06:05:00-03:00`).toISOString()
                },
                {
                    medication_id: medB.id, schedule_id: schedB[0].id,
                    scheduled_at: new Date(`${hojeISO}T06:30:00-03:00`).toISOString(),
                    horario_agendado: '06:30', reminder_sent: true, confirmed: false,
                    status: 'nao_informado'
                }
            ]);

            const r1 = await turno(ctx, user, 'Quais remédios eu tomei hoje?');
            checagensDeForma(checks, 'balanço', r1);
            checks.push({ nome: 'o confirmado aparece como confirmado', ok: /losartana/i.test(r1) && /confirmad/i.test(r1), detalhe: r1.slice(0, 240) });
            checks.push({ nome: 'o sem-resposta aparece como pendência ("sem confirmação"), nunca sumido', ok: /metformina/i.test(r1) && /sem confirma|aguardando/i.test(r1), detalhe: r1.slice(0, 300) });
            checks.push({ nome: 'NUNCA "você não tomou" para dose sem registro', ...naoContem(r1, /n[ãa]o tomou|n[ãa]o tomad[oa]/i, 'afirmação de não-tomada') });
            checks.push({ nome: '"sem estoque" só com estoque cadastrado (nenhum aqui)', ...naoContem(r1, /sem estoque/i, 'sem estoque indevido') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A33',
        marco: 'M4',
        titulo: 'Dump completo na etapa LGPD (§2.2) — nada persistido antes do aceite; nada perdido',
        async executar({ ctx, seeds }) {
            const checks = [];

            // Parte 1 — dump SEM aceite: listagem curta + só o consentimento.
            const user1 = await seeds.criarUsuario({ nome: null, onboarded: false, estado: 'idle' });
            await turno(ctx, user1, 'oi');
            await turno(ctx, user1, 'Carlos');
            const r3 = await turno(ctx, user1, 'Carlos Alberto Souza\n11 91234 5678\n05/07/1980');
            checagensDeForma(checks, 'dump sem aceite', r3);
            checks.push({ nome: 'dump: reconhece a data de nascimento', ...contem(r3, /05\/07\/1980/, 'data reconhecida') });
            checks.push({ nome: 'dump: repede SÓ o consentimento', ...contem(r3, /concorda|consentimento/i, 'repergunta de consentimento') });

            const { data: u1meio } = await ctx.db.from('users')
                .select('name, data_nascimento, lgpd_accepted, onboarded').eq('id', user1.id).single();
            checks.push({
                nome: 'dump: NADA persistido antes do aceite (users intocado)',
                ok: u1meio?.name === null && u1meio?.data_nascimento === null
                    && u1meio?.lgpd_accepted === false && u1meio?.onboarded === false,
                detalhe: `name: ${u1meio?.name}, nasc: ${u1meio?.data_nascimento}, lgpd: ${u1meio?.lgpd_accepted}, onboarded: ${u1meio?.onboarded}`
            });

            const r4 = await turno(ctx, user1, 'Sim');
            checagensDeForma(checks, 'aceite', r4);
            const { data: u1fim } = await ctx.db.from('users')
                .select('name, data_nascimento, lgpd_accepted, onboarded').eq('id', user1.id).single();
            checks.push({
                nome: 'aceite: rascunho INTEIRO persistido (nome + data) com o consentimento',
                ok: u1fim?.name === 'Carlos' && u1fim?.data_nascimento === '1980-07-05'
                    && u1fim?.lgpd_accepted === true && u1fim?.onboarded === true,
                detalhe: `name: ${u1fim?.name}, nasc: ${u1fim?.data_nascimento}, lgpd: ${u1fim?.lgpd_accepted}, onboarded: ${u1fim?.onboarded}`
            });
            checks.push({ nome: 'aceite: data de nascimento NUNCA reperguntada', ...naoContem(r4, /data de nascimento/i, 'repergunta da data') });
            checks.push({ nome: 'aceite: segue direto para o primeiro cadastro', ...contem(r4, /rem[ée]dio|medicamento/i, 'convite ao cadastro') });

            // Parte 2 — dump COM "sim" no meio: aceite identificado, nada reperguntado.
            const user2 = await seeds.criarUsuario({ nome: null, onboarded: false, estado: 'idle' });
            await turno(ctx, user2, 'oi');
            await turno(ctx, user2, 'Maria');
            const r7 = await turno(ctx, user2, 'Maria Lima\nsim\n02/02/1975');
            checagensDeForma(checks, 'dump com sim', r7);
            const { data: u2fim } = await ctx.db.from('users')
                .select('name, data_nascimento, lgpd_accepted, onboarded').eq('id', user2.id).single();
            checks.push({
                nome: 'dump com "sim" no meio: aceite identificado e tudo persistido',
                ok: u2fim?.lgpd_accepted === true && u2fim?.onboarded === true
                    && u2fim?.data_nascimento === '1975-02-02',
                detalhe: `lgpd: ${u2fim?.lgpd_accepted}, onboarded: ${u2fim?.onboarded}, nasc: ${u2fim?.data_nascimento}`
            });
            checks.push({ nome: 'dump com "sim": não repergunta data nem consentimento', ...naoContem(r7, /data de nascimento|concorda\?/i, 'repergunta') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A34',
        marco: 'M4',
        titulo: 'Data de nascimento OPCIONAL — recusa completa o onboarding sem atraso; editável via perfil',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: null, onboarded: false, estado: 'idle' });

            await turno(ctx, user, 'oi');
            await turno(ctx, user, 'Paula');
            const r3 = await turno(ctx, user, 'concordo');
            checagensDeForma(checks, 'pedido da data', r3);
            checks.push({ nome: 'pedido pergunta a data com exemplo de formato', ...contem(r3, /data de nascimento/i, 'pergunta da data') });
            // Decisão de Guilherme (21/09): opcional no comportamento, nunca
            // anunciada na pergunta.
            checks.push({ nome: 'pedido NÃO anuncia opcionalidade', ...naoContem(r3, /opcional|se preferir n[ãa]o informar|pode pular/i, 'anúncio de opcionalidade') });

            const r4 = await turno(ctx, user, 'prefiro não informar');
            checagensDeForma(checks, 'recusa', r4);
            checks.push({ nome: 'recusa: sem insistência e sem nova menção a nascimento', ...naoContem(r4, /nascimento|s[óo] mais uma|rapidinho|prometo/i, 'insistência') });
            checks.push({ nome: 'recusa: acolhe em uma frase ("tudo bem") e segue', ...contem(r4, /tudo bem/i, 'acolhimento curto') });
            checks.push({ nome: 'recusa: chegada ao cadastro sem atraso (convite ao 1º remédio)', ...contem(r4, /rem[ée]dio|medicamento/i, 'convite ao cadastro') });

            const { data: uDepois } = await ctx.db.from('users')
                .select('name, onboarded, lgpd_accepted, data_nascimento').eq('id', user.id).single();
            checks.push({
                nome: 'onboarding COMPLETO com a data em NULL (nunca trava o usuário)',
                ok: uDepois?.name === 'Paula' && uDepois?.onboarded === true
                    && uDepois?.lgpd_accepted === true && uDepois?.data_nascimento === null,
                detalhe: `name: ${uDepois?.name}, onboarded: ${uDepois?.onboarded}, nasc: ${uDepois?.data_nascimento}`
            });
            checks.push({ nome: 'estado pós-onboarding', ...(await estadoDaConversa(ctx.db, user.id, 'post_onboarding')) });

            // Editável DEPOIS via perfil (MH-75/M3) — usuário recarregado do banco,
            // como o webhook faz em produção.
            const { data: userAtual } = await ctx.db.from('users').select('*').eq('id', user.id).single();
            const r5 = await turno(ctx, userAtual, 'Quero corrigir minha data de nascimento');
            checks.push({ nome: 'perfil: pedido de correção pede a data (nunca ignora)', ...contem(r5, /nascimento/i, 'pergunta da data') });
            await turno(ctx, userAtual, '19/03/1985');
            const { data: uFim } = await ctx.db.from('users').select('data_nascimento').eq('id', user.id).single();
            checks.push({
                nome: 'editável depois: data gravada pelo perfil',
                ok: uFim?.data_nascimento === '1985-03-19',
                detalhe: `data_nascimento: ${uFim?.data_nascimento}`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A35',
        marco: 'M4',
        titulo: 'Medicamento com posologia na 1ª mensagem (pré-onboarding) — semeadura sem repergunta (§3)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: null, onboarded: false, estado: 'idle' });

            const r1 = await turno(ctx, user, 'Oi! Preciso de ajuda com a Losartana 50mg, tomo 1 comprimido às 8h');
            checagensDeForma(checks, 'turno 1', r1);
            checks.push({ nome: 'turno 1: reconhece a Losartana na hora (regra 3)', ...contem(r1, /losartana/i, 'Losartana') });
            checks.push({ nome: 'turno 1: o onboarding segue (pede o nome)', ...contem(r1, /chamar|nome/i, 'pedido do nome') });
            let meds = await medicamentos(ctx.db, user.id);
            checks.push({ nome: 'turno 1: NADA no banco antes do aceite', ok: meds.length === 0, detalhe: `${meds.length} linha(s) em medications` });

            await turno(ctx, user, 'Felipe');
            meds = await medicamentos(ctx.db, user.id);
            checks.push({ nome: 'pré-aceite: medications segue vazio', ok: meds.length === 0, detalhe: `${meds.length} linha(s) em medications` });

            await turno(ctx, user, 'Concordo');
            const r4 = await turno(ctx, user, 'prefiro não dizer');
            checagensDeForma(checks, 'fechamento + cadastro', r4);
            checks.push({ nome: 'pós-onboarding: zero repergunta do nome do medicamento', ...naoContem(r4, /qual o \*?nome\*?/i, 'repergunta de nome') });
            checks.push({ nome: 'pós-onboarding: zero repergunta dos horários', ...naoContem(r4, /quais .{0,12}hor[áa]rios/i, 'repergunta de horários') });
            checks.push({ nome: 'pós-onboarding: cadastro declarado na resposta (regra 2)', ...contem(r4, /losartana/i, 'Losartana no fechamento') });

            const losartana = await medicamentos(ctx.db, user.id, { nomeIlike: 'Losartana%' });
            const horarios = losartana.flatMap(m => (m.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5)));
            checks.push({
                nome: 'cadastro semeado GRAVADO no mesmo turno (Losartana às 08:00)',
                ok: losartana.length === 1 && horarios.length === 1 && horarios[0] === '08:00',
                detalhe: `${losartana.length} linha(s); horários: ${horarios.join(', ') || 'nenhum'}`
            });
            checks.push({ nome: 'coleta segue no cadastro (estado adding_med, estoque pendente)', ...(await estadoDaConversa(ctx.db, user.id, 'adding_med')) });

            // Parte 2 — replay manual de Guilherme (21/09, teste (d)): DOIS
            // remédios na 1ª mensagem. Funcionava (os dois eram cadastrados),
            // mas a recepção e o pedido de LGPD citavam só o primeiro — a
            // pessoa achava que a Nami tinha perdido o outro.
            const user2 = await seeds.criarUsuario({ nome: null, onboarded: false, estado: 'idle' });
            const r2a = await turno(ctx, user2, 'Oi! Quero cadastrar meus remédios:\nPredsin 2mg - 1cp as 10h\nGlifage 850mg - 1cp às 7h');
            checagensDeForma(checks, 'dois meds: recepção', r2a);
            checks.push({ nome: 'dois meds: a recepção cita o Predsin', ...contem(r2a, /predsin/i, 'Predsin') });
            checks.push({ nome: 'dois meds: a recepção cita o Glifage (nenhum some — regra 3)', ...contem(r2a, /glifage/i, 'Glifage') });

            const r2b = await turno(ctx, user2, 'Guilherme');
            checagensDeForma(checks, 'dois meds: LGPD', r2b);
            checks.push({ nome: 'dois meds: o pedido de LGPD cita os DOIS', ok: /predsin/i.test(r2b) && /glifage/i.test(r2b), detalhe: r2b.split('\n')[0] });
            checks.push({ nome: 'dois meds: LGPD não anuncia a data como opcional', ...naoContem(r2b, /opcional/i, 'anúncio de opcionalidade') });

            await turno(ctx, user2, 'Sim');
            const r2d = await turno(ctx, user2, '06/11/1989');
            checagensDeForma(checks, 'dois meds: fechamento', r2d);
            const meds2 = await medicamentos(ctx.db, user2.id);
            const nomes2 = meds2.map(m => m.nome).join(', ');
            // Proposta de lote (todos com horário) → confirmação única.
            if (meds2.length === 0) {
                checks.push({ nome: 'dois meds: proposta de lote cita os dois antes de gravar', ok: /predsin/i.test(r2d) && /glifage/i.test(r2d), detalhe: r2d.slice(0, 200) });
                // Usuário recarregado do banco, como o webhook faz a cada
                // mensagem (getOrCreateUser): depois do aceite ele é onboarded.
                const { data: user2Atual } = await ctx.db.from('users').select('*').eq('id', user2.id).single();
                const r2e = await turno(ctx, user2Atual, 'Pode');
                checagensDeForma(checks, 'dois meds: gravação', r2e);
            }
            const meds2fim = await medicamentos(ctx.db, user2.id);
            const horarios2 = meds2fim.flatMap(m => (m.schedules || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5))).sort();
            checks.push({
                nome: 'dois meds: AMBOS cadastrados, cada um com o horário da SUA linha',
                ok: meds2fim.length === 2 && horarios2.join(',') === '07:00,10:00',
                detalhe: `${meds2fim.length} registro(s): ${meds2fim.map(m => m.nome).join(' | ') || nomes2}; horários: ${horarios2.join(', ')}`
            });
            // Replay 21/09: a concentração é coluna própria — nunca some no nome
            // (nem na proposta: "Predsin 2mg 2mg").
            checks.push({ nome: 'dois meds: proposta NÃO duplica a dosagem', ...naoContem(r2d, /(\d+\s*(?:mg|mcg|ml|g))\s+\1/i, 'dosagem duplicada') });
            checks.push({
                nome: 'dois meds: nome gravado SEM a dosagem embutida (coluna própria)',
                ok: meds2fim.length === 2 && meds2fim.every(m => !/\d+\s*(mg|mcg|ml|ui)\b/i.test(m.nome))
                    && meds2fim.some(m => /^predsin$/i.test(m.nome)) && meds2fim.some(m => /^glifage$/i.test(m.nome)),
                detalhe: meds2fim.map(m => `${m.nome} (dosagem: ${m.dosagem})`).join(' | ')
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A36',
        marco: 'M4',
        titulo: 'Retomada depois de semanas na etapa do nome (estados legados migrados — micro-entrega v45)',
        async executar({ ctx, seeds }) {
            const checks = [];

            // Formato EXATO das linhas migradas em produção (22/09): o M4
            // eliminou os estados `recep_*` e o runner descartava qualquer
            // etapa fora do vocabulário `onb_` — a pessoa que voltava semanas
            // depois era tratada como primeira mensagem e a resposta que ela
            // deu à pergunta pendente ia para o lixo (caso Fran, 22/09 07:38).
            // A correção é DADO, não código: a migração reescreveu essas linhas
            // para o vocabulário novo, e o grep-guard do A0 segue impedindo que
            // o mapeamento volte para dentro de src/.
            const user = await seeds.criarUsuario({
                nome: null, onboarded: false, estado: 'onboarding',
                contexto: {
                    etapa: 'onb_nome',
                    tentativas_nome: 0,
                    intencao_inicial: 'cadastrar',
                    mensagem_inicial: 'Oi Nami! Quero sua ajuda pra cuidar da minha saúde.'
                }
            });

            const r1 = await turno(ctx, user, 'Fran');
            checagensDeForma(checks, 'retomada', r1);

            const { data: estado } = await ctx.db.from('conversation_state')
                .select('state, context').eq('user_id', user.id).single();

            // 1. a resposta à pergunta pendente é APROVEITADA (regras 3 e 4).
            checks.push({
                nome: 'retomada: o nome respondido é reconhecido e persiste no contexto',
                ok: estado?.context?.nome_coletado === 'Fran',
                detalhe: `nome_coletado: ${JSON.stringify(estado?.context?.nome_coletado)}`
            });

            // 2. a pergunta pendente NÃO é repetida.
            checks.push({ nome: 'retomada: zero repergunta do nome', ...naoContem(r1, /como posso te chamar|como quer que eu te chame|qual (?:é )?o seu nome/i, 'repergunta de nome') });

            // 3. a conversa avança para a pendência seguinte (consentimento).
            checks.push({ nome: 'retomada: a resposta pede o consentimento LGPD', ...contem(r1, /concorda|autoriza[çc][ãa]o/i, 'pedido de consentimento') });
            checks.push({
                nome: 'retomada: estado salvo avança para onb_lgpd (state onboarding)',
                ok: estado?.state === 'onboarding' && estado?.context?.etapa === 'onb_lgpd',
                detalhe: `state: ${estado?.state}, etapa: ${estado?.context?.etapa}`
            });

            // 4. nada de boas-vindas de primeira mensagem.
            checks.push({ nome: 'retomada: sem boas-vindas de primeira mensagem', ...naoContem(r1, /sou a Nami|vi que voc[êe] j[áa] chegou|vou te ajudar a organizar seus rem[ée]dios, sim/i, 'boas-vindas de primeira mensagem') });

            return checks;
        }
    },

    // ========================================================
    // v45 P1 — o principal vira a porta única (casos A37–A47).
    // Conversas reais; asserções sobre o banco e o texto, nunca sobre o
    // nome do agente.
    // ========================================================

    // --------------------------------------------------------
    {
        id: 'A37',
        marco: 'M4',
        titulo: 'João 24/09 08:43 — "Yes" com a dose de hoje esgotada',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'João', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Roacutan', dosagem: '20mg', estoque: 10, horarios: ['06:28'] });
            await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '06:28', quando: diasAtras(1), status: 'confirmado' });
            const hoje = await seeds.criarDose({
                medicationId: med.id, scheduleId: schedules[0].id, horario: '06:28',
                quando: hojeHaMinutos(135), status: 'nao_informado', tentativas: 3, minutosDesdeUltimaTentativa: 45
            });

            const r = await turno(ctx, user, 'Yes');
            checagensDeForma(checks, '"Yes"', r);
            const depois = (await doseLogs(ctx.db, med.id)).find(d => d.id === hoje.id);
            checks.push({ nome: 'dose de hoje confirmada', ok: depois?.status === 'confirmado', detalhe: `status: ${depois?.status}` });
            checks.push({ nome: 'nunca diz que não há dose pendente', ...naoContem(r, /n[ãa]o h[áa] (nenhuma )?dose/i, 'negação da dose') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A38',
        marco: 'M4',
        titulo: 'João 26/09 12:01 — "Ontem eu tomei" com três doses esgotadas',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'João', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Roacutan', dosagem: '20mg', estoque: 10, horarios: ['06:28'] });
            const base = { medicationId: med.id, scheduleId: schedules[0].id, horario: '06:28', status: 'nao_informado', tentativas: 3 };
            const hoje = await seeds.criarDose({ ...base, quando: hojeHaMinutos(200), minutosDesdeUltimaTentativa: 110 });
            const ontem = await seeds.criarDose({ ...base, quando: diasAtras(1, 200) });
            const anteontem = await seeds.criarDose({ ...base, quando: diasAtras(2, 200) });

            const r = await turno(ctx, user, 'Ontem eu tomei');
            checagensDeForma(checks, '"Ontem eu tomei"', r);
            const logs = await doseLogs(ctx.db, med.id);
            const st = (d) => logs.find(x => x.id === d.id)?.status;
            checks.push({ nome: 'a dose de ONTEM confirmada', ok: st(ontem) === 'confirmado', detalhe: `ontem: ${st(ontem)}` });
            checks.push({ nome: 'a dose de HOJE segue aberta', ok: st(hoje) === 'nao_informado', detalhe: `hoje: ${st(hoje)}` });
            checks.push({ nome: 'a de anteontem segue aberta', ok: st(anteontem) === 'nao_informado', detalhe: `anteontem: ${st(anteontem)}` });
            checks.push({ nome: 'o texto cita o dia da dose registrada, com data (§2)', ...contem(r, /\*Roacutan\* de ontem \(\d{2}\/\d{2}, 06:28\) confirmada/, 'ontem + data + hora') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A39',
        marco: 'M4',
        titulo: 'Guilherme 26/09 13:21 — "Yes" com dose pendente durante cad_estoque',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'post_onboarding' });
            const { med: omega, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Ômega 3', estoque: 30, horarios: ['12:58'] });

            await turno(ctx, user, 'Aerolin spray, 4 jatos às 7h');
            const { data: estadoAntes } = await ctx.db.from('conversation_state').select('state, context').eq('user_id', user.id).single();
            if (estadoAntes?.state !== 'adding_med' || !String(estadoAntes?.context?.etapa || '').startsWith('cad_estoque')) {
                return [{ nome: 'setup: coleta de estoque aberta', ok: false, detalhe: `estado: ${estadoAntes?.state}, etapa: ${estadoAntes?.context?.etapa}` }];
            }
            const dose = await seeds.criarDose({ medicationId: omega.id, scheduleId: schedules[0].id, horario: '12:58', minutosAtras: 20 });

            const r = await turno(ctx, user, 'Yes');
            checagensDeForma(checks, '"Yes"', r);
            const depois = (await doseLogs(ctx.db, omega.id)).find(d => d.id === dose.id);
            checks.push({ nome: 'dose do Ômega 3 confirmada (confirmação vence coleta)', ok: depois?.status === 'confirmado', detalhe: `status: ${depois?.status}` });
            checks.push({ nome: 'coleta de estoque preservada', ...(await estadoDaConversa(ctx.db, user.id, 'adding_med')) });
            checks.push({ nome: 'retoma o convite de estoque', ...contem(r, /estoque/i, 'menção ao estoque') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A40',
        marco: 'M4',
        titulo: 'Guilherme 26/09 13:25 — "Yes" CITANDO o lembrete: confirma o grupo citado',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'post_onboarding' });
            const { med: omega, schedules: sO } = await seeds.criarMedicamento({ userId: user.id, nome: 'Ômega 3', estoque: 30, horarios: ['09:00'] });
            const { med: creatina, schedules: sC } = await seeds.criarMedicamento({ userId: user.id, nome: 'Creatina', estoque: 30, horarios: ['12:00'] });

            await turno(ctx, user, 'Aerolin spray, 4 jatos às 7h');
            // O grupo CITADO é o mais antigo — sem a citação, a pista seria o último lembrete.
            const { envio, messageId } = await seeds.criarEnvioFunil({
                user, minutosAtras: 40,
                texto: '⏰ Olá, Guilherme!\n\nHora do seu *Ômega 3*.\nQuantidade: 1 comprimido\n\nJá tomou? Responda *SIM* ou *NÃO* 💊'
            });
            const citada = await seeds.criarDose({ medicationId: omega.id, scheduleId: sO[0].id, horario: '09:00', minutosAtras: 40, funilEnvioId: envio.id });
            const outra = await seeds.criarDose({ medicationId: creatina.id, scheduleId: sC[0].id, horario: '12:00', minutosAtras: 5 });

            const r = await turno(ctx, user, 'Yes', { referenceMessageId: messageId });
            checagensDeForma(checks, '"Yes" citando', r);
            const stCitada = (await doseLogs(ctx.db, omega.id)).find(d => d.id === citada.id)?.status;
            const stOutra = (await doseLogs(ctx.db, creatina.id)).find(d => d.id === outra.id)?.status;
            checks.push({ nome: 'a dose do grupo CITADO confirmada', ok: stCitada === 'confirmado', detalhe: `Ômega 3: ${stCitada}` });
            checks.push({ nome: 'a dose do outro grupo segue pendente', ok: stOutra === 'pendente', detalhe: `Creatina: ${stOutra}` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A41',
        marco: 'M4',
        titulo: 'Eloísa 22/09 — "Simmm" com dose sem_estoque: estoque contestado, sem LLM',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Eloísa', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Desogestrel', dosagem: '75mcg', estoque: 0, horarios: ['11:58'] });
            const dose = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '11:58', minutosAtras: 15, status: 'sem_estoque' });

            const r = await turnoCompleto(ctx, user, 'Simmm');
            checagensDeForma(checks, '"Simmm"', r.texto);
            const depois = (await doseLogs(ctx.db, med.id)).find(d => d.id === dose.id);
            checks.push({ nome: 'dose confirmada', ok: depois?.status === 'confirmado' && depois?.confirmed === true, detalhe: `status: ${depois?.status}` });
            const { data: medDepois } = await ctx.db.from('medications').select('estoque_atual').eq('id', med.id).single();
            checks.push({ nome: 'estoque passa a NULO (a palavra da pessoa prevalece)', ok: medDepois?.estoque_atual === null, detalhe: `estoque_atual: ${medDepois?.estoque_atual}` });
            const { data: movs } = await ctx.db.from('stock_movements').select('tipo, estoque_novo').eq('medication_id', med.id);
            checks.push({ nome: 'movimento estoque_contestado registrado', ok: (movs || []).some(m => m.tipo === 'estoque_contestado' && m.estoque_novo === null), detalhe: JSON.stringify(movs) });
            checks.push({ nome: 'nenhuma chamada de LLM (atalho exato)', ok: r.chamadasLLM === 0, detalhe: `chamadas: ${r.chamadasLLM}` });
            checks.push({ nome: 'P1-copy §7: convite do estoque contestado (não o convite comum)', ...contem(r.texto, /Pelo que eu tinha anotado, o \*Desogestrel\* tinha acabado — então deixei o estoque em aberto/, 'convite contestado') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A42',
        marco: 'M4',
        titulo: 'Flávia 24/09 — "Comprei 60 comprimidos / Sim": dose confirmada E estoque atualizado',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Flávia', onboarded: true, estado: 'idle' });
            const { med: ofolato, schedules: sO } = await seeds.criarMedicamento({ userId: user.id, nome: 'Ofolato D', estoque: 20, horarios: ['11:58'] });
            const { med: regenesis, schedules: sR } = await seeds.criarMedicamento({ userId: user.id, nome: 'Regenesis e ofolato D', estoque: 0, horarios: ['11:58'] });
            const { envio, messageId } = await seeds.criarEnvioFunil({
                user, minutosAtras: 4, origem: 'proativo:alerta_estoque_zerado',
                texto: '⏰ Flávia, está na hora do seu *Regenesis e ofolato D*!\n\nPelas minhas contas o estoque acabou — mas se você ainda tem e já tomou, é só responder SIM que eu registro. 💊\n\nSe comprou mais, me conta quantos: *"Comprei 30 comprimidos de Regenesis e ofolato D"*'
            });
            await seeds.criarDose({ medicationId: ofolato.id, scheduleId: sO[0].id, horario: '11:58', minutosAtras: 4 });
            const doseR = await seeds.criarDose({ medicationId: regenesis.id, scheduleId: sR[0].id, horario: '11:58', minutosAtras: 4, status: 'sem_estoque', funilEnvioId: envio.id });

            const r = await turno(ctx, user, 'Comprei 60 comprimidos\nSim', { referenceMessageId: messageId });
            checagensDeForma(checks, 'compra + sim', r);
            const stR = (await doseLogs(ctx.db, regenesis.id)).find(d => d.id === doseR.id)?.status;
            checks.push({ nome: 'dose do Regenesis (citado) confirmada', ok: stR === 'confirmado', detalhe: `status: ${stR}` });
            const { data: medR } = await ctx.db.from('medications').select('estoque_atual').eq('id', regenesis.id).single();
            checks.push({ nome: 'estoque do Regenesis atualizado com a compra (60)', ok: Number(medR?.estoque_atual) === 60, detalhe: `estoque_atual: ${medR?.estoque_atual}` });
            checks.push({ nome: 'texto não convida a informar o estoque que acabou de chegar', ...naoContem(r, /Ainda não tenho o estoque do \*Regenesis/i, 'convite contraditório') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A43',
        marco: 'M4',
        titulo: 'Fran 25–26/09 — "Não"/"não tomei" com a dose aberta = ainda não; "pulei" fecha (P1-copy §3)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Fran', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Ferro quelato', estoque: null, horarios: ['12:18'] });
            const dose = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '12:18', minutosAtras: 3 });
            const statusDaDose = async () => (await doseLogs(ctx.db, med.id)).find(d => d.id === dose.id)?.status;

            const r1 = await turno(ctx, user, 'Não');
            checagensDeForma(checks, '"Não" (1)', r1);
            checks.push({ nome: '"Não": a dose segue aguardando', ok: (await statusDaDose()) === 'pendente', detalhe: `status: ${await statusDaDose()}` });

            const r2 = await turno(ctx, user, 'Não');
            checks.push({ nome: '"Não" de novo: a resposta NÃO é idêntica à anterior (§2.2)', ok: r1.trim() !== r2.trim() && r2.trim().length > 0, detalhe: `1: "${r1.slice(0, 60)}" | 2: "${r2.slice(0, 60)}"` });

            const r3 = await turno(ctx, user, 'Não tomei');
            checks.push({ nome: '"Não tomei" com a dose aguardando: nada gravado, segue pendente (§3)', ok: (await statusDaDose()) === 'pendente', detalhe: `status: ${await statusDaDose()} — "${r3.slice(0, 60)}"` });

            const r4 = await turno(ctx, user, 'Pulei essa, hoje não vou tomar');
            checagensDeForma(checks, '"pulei"', r4);
            checks.push({ nome: '"pulei": dose fechada como não tomada', ok: (await statusDaDose()) === 'nao_tomado', detalhe: `status: ${await statusDaDose()}` });
            checks.push({ nome: '"pulei": linha fixa do fato', ...contem(r4, /O \*Ferro quelato\* de hoje \(12:18\) ficou registrado como não tomado\./, 'linha fixa') });
            checks.push({ nome: '"pulei": sem "se tomar mais tarde"', ...naoContem(r4, /se tomar mais tarde/i, 'porta aberta indevida') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A44',
        marco: 'M4',
        titulo: 'Fran 24/09 19:56 — "Quero cadastrar mais um!" durante o convite de estoque',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Fran', onboarded: true, estado: 'post_onboarding' });
            await turno(ctx, user, 'Ferro quelato, 1 comprimido às 12:20 e às 20:20');
            const { data: antes } = await ctx.db.from('conversation_state').select('state, context').eq('user_id', user.id).single();
            if (!String(antes?.context?.etapa || '').startsWith('cad_estoque')) {
                return [{ nome: 'setup: convite de estoque aberto', ok: false, detalhe: `estado: ${antes?.state}, etapa: ${antes?.context?.etapa}` }];
            }

            const r = await turno(ctx, user, 'Quero cadastrar mais um!');
            checagensDeForma(checks, '"Quero cadastrar mais um!"', r);
            const { data: depois } = await ctx.db.from('conversation_state').select('state, context').eq('user_id', user.id).single();
            checks.push({
                nome: 'cadastro NOVO aberto (pergunta o nome, sem o anterior no rascunho)',
                ok: depois?.state === 'adding_med' && depois?.context?.etapa === 'cad_nome' && !depois?.context?.medication_id,
                detalhe: `estado: ${depois?.state}, etapa: ${depois?.context?.etapa}, nome: ${depois?.context?.nome}`
            });
            checks.push({ nome: 'o convite anterior NÃO é repetido', ...naoContem(r, /quantos comprimidos|se voc[êe] souber quant[oa]s/i, 'convite de estoque repetido') });
            checks.push({ nome: 'P1-copy §9: abre com o convite de três linhas', ...contem(r, /Pode me mandar tudo de uma vez, se quiser:\n• o nome do remédio\n• quanto você toma por vez\n• os horários/, 'convite único') });
            checks.push({ nome: 'P1-copy §9: sem "Qual o *nome*"', ...naoContem(r, /Qual o \*nome\*/, 'pergunta campo a campo') });
            const meds = await medicamentos(ctx.db, user.id, { nomeIlike: 'Ferro%' });
            checks.push({ nome: 'o Ferro quelato continua cadastrado e ativo', ok: meds.length === 1 && meds[0].ativo === true, detalhe: `${meds.length} linha(s)` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A45',
        marco: 'M4',
        titulo: 'Fran 22/09 07:58 — "Erro" logo após o cadastro (P1-ajustes 2 §3: verde pela INTENÇÃO de corrigir, não pela palavra)',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Fran', onboarded: true, estado: 'post_onboarding' });
            await turno(ctx, user, 'Puran T4 75mcg, 1 comprimido às 6:30');
            const r = await turno(ctx, user, 'Erro');
            checagensDeForma(checks, '"Erro"', r);
            checks.push({ nome: 'pergunta o que ficou errado', ...contem(r, /\?/, 'uma pergunta') });
            checks.push({ nome: 'não repete o convite de estoque', ...naoContem(r, /quantos comprimidos|se voc[êe] souber quant[oa]s|estoque/i, 'convite de estoque') });
            const meds = await medicamentos(ctx.db, user.id);
            checks.push({ nome: 'nada é gravado: o Puran T4 segue único, sem estoque', ok: meds.length === 1 && meds[0].estoque_atual === null, detalhe: `${meds.length} medicamento(s), estoque: ${meds[0]?.estoque_atual}` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A46',
        marco: 'M4',
        titulo: 'Fran 22/09 07:59 — "A vitamina b12 é uma vez por semana…" em cad_estoque_lote',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Fran', onboarded: true, estado: 'post_onboarding' });
            await turno(ctx, user, 'Puran T4 75mcg às 6:30h\nVitamina b12 2 comprimidos 1000 mcg toda segunda, as 7h');
            await turno(ctx, user, 'Pode');
            const { data: antes } = await ctx.db.from('conversation_state').select('state, context').eq('user_id', user.id).single();
            const b12 = (await medicamentos(ctx.db, user.id, { nomeIlike: 'Vitamina b12%' }))[0];
            if (antes?.context?.etapa !== 'cad_estoque_lote' || !b12) {
                return [{ nome: 'setup: lote gravado e convite agregado aberto', ok: false, detalhe: `etapa: ${antes?.context?.etapa}, b12: ${!!b12}` }];
            }

            const r = await turno(ctx, user, 'A vitamina b12 é uma vez por semana apenas, toda segunda-feira');
            checagensDeForma(checks, 'b12 semanal', r);
            const { data: b12Depois } = await ctx.db.from('medications').select('estoque_atual').eq('id', b12.id).single();
            checks.push({ nome: 'estoque da B12 intocado (o 12 do nome NÃO vira estoque)', ok: b12Depois?.estoque_atual === null, detalhe: `estoque_atual: ${b12Depois?.estoque_atual}` });
            const { data: movs } = await ctx.db.from('stock_movements').select('tipo').eq('medication_id', b12.id);
            checks.push({ nome: 'nenhum movimento de estoque na B12', ok: (movs || []).length === 0, detalhe: JSON.stringify(movs) });
            checks.push({ nome: 'nada de "estoque anotado"', ...naoContem(r, /estoque anotado|12 comprimidos/i, 'estoque inventado') });
            const { data: depois } = await ctx.db.from('conversation_state').select('state, context').eq('user_id', user.id).single();
            checks.push({ nome: 'a mensagem saiu do convite de estoque (vai à configuração)', ok: depois?.context?.etapa !== 'cad_estoque_lote', detalhe: `estado: ${depois?.state}, etapa: ${depois?.context?.etapa}` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A47',
        marco: 'M4',
        titulo: '"sim" simples, um grupo pendente, estado idle — atalho exato sem LLM',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Fran', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Puran T4', estoque: 30, horarios: ['06:28'] });
            const dose = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '06:28', minutosAtras: 25 });

            const r = await turnoCompleto(ctx, user, 'sim');
            checagensDeForma(checks, '"sim"', r.texto);
            const depois = (await doseLogs(ctx.db, med.id)).find(d => d.id === dose.id);
            checks.push({ nome: 'dose confirmada', ok: depois?.status === 'confirmado', detalhe: `status: ${depois?.status}` });
            checks.push({ nome: 'nenhuma chamada de LLM', ok: r.chamadasLLM === 0, detalhe: `chamadas: ${r.chamadasLLM}` });
            checks.push({ nome: 'o texto diz qual dose e de qual dia (hoje: só a hora)', ...contem(r.texto, /Puran T4\* de hoje \(\d{2}:\d{2}\) confirmada 💊/, 'medicamento + dia + hora, sem data') });

            // P1-copy §2.1: a confirmação seguinte da MESMA pessoa sai com outra
            // abertura; a linha do fato mantém o formato.
            const { aberturaUsada } = await import('../src/dosesDoTurno.js');
            const dose2 = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '06:28', minutosAtras: 2 });
            const r2 = await turnoCompleto(ctx, user, 'sim');
            const a1 = aberturaUsada(r.texto), a2 = aberturaUsada(r2.texto);
            checks.push({ nome: 'segunda dose confirmada, também sem LLM', ok: (await doseLogs(ctx.db, med.id)).find(d => d.id === dose2.id)?.status === 'confirmado' && r2.chamadasLLM === 0, detalhe: `chamadas: ${r2.chamadasLLM}` });
            checks.push({ nome: 'duas confirmações seguidas com aberturas DIFERENTES', ok: !!a1 && !!a2 && a1 !== a2, detalhe: `"${a1}" → "${a2}"` });
            checks.push({ nome: 'a linha do fato mantém o formato', ...contem(r2.texto, /^[^✅]+! ✅ \*Puran T4\* de hoje \(\d{2}:\d{2}\) confirmada 💊/, 'formato do §2.1') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A48',
        marco: 'M4',
        titulo: 'Hotfix v45 — encerrar tratamento fecha a dose pendente do dia (Isaque, 26/09): sem follow-up depois do encerramento',
        async executar({ ctx, seeds }) {
            const checks = [];
            const { getPendingFollowUps } = await import('../src/database.js');
            const user = await seeds.criarUsuario({ nome: 'Encerra Pendente', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({
                userId: user.id, nome: 'Runner', horarios: ['20:58']
            });
            // Lembrete enviado há 22 min, sem resposta: 1 tentativa registrada.
            const dose = await seeds.criarDosePendente({
                medicationId: med.id, scheduleId: schedules[0].id, horario: '20:58', minutosAtras: 22
            });
            const antes = await getPendingFollowUps();
            if (!antes.some(d => d.id === dose.id)) {
                return [{ nome: 'setup: dose pendente na fila de follow-ups antes do encerramento', ok: false, detalhe: `${antes.length} item(ns) na fila` }];
            }

            // Encerramento pelo fluxo real da configuração: pedido + "Isso".
            await turno(ctx, user, 'Encerrar o Runner');
            const r = await turno(ctx, user, 'Isso');
            const { data: medDepois } = await ctx.db.from('medications').select('status').eq('id', med.id).single();
            checks.push({ nome: 'setup: Runner encerrado pelo fluxo real', ok: medDepois?.status === 'encerrado', detalhe: `status: ${medDepois?.status}` });

            const logs = await doseLogs(ctx.db, med.id);
            const doseDepois = logs.find(l => l.id === dose.id);
            checks.push({ nome: 'a dose pendente ficou "pausado"', ok: doseDepois?.status === 'pausado', detalhe: `status: ${doseDepois?.status}` });

            const depois = await getPendingFollowUps();
            checks.push({ nome: 'getPendingFollowUps() não devolve a dose', ok: !depois.some(d => d.id === dose.id), detalhe: `${depois.filter(d => d.medication_id === med.id).length} dose(s) do Runner na fila` });

            checks.push({
                nome: 'texto de encerramento é o de hoje (sem mudança de copy)',
                ...contem(r, /Tratamento com \*?Runner\*? encerrado\. Os lembretes foram desativados/, 'texto de encerramento')
            });
            return checks;
        }
    },
    // --------------------------------------------------------
    {
        id: 'A49',
        marco: 'M4',
        titulo: 'P1-ajustes §1 (staging 26/09 23:15) — "Juvix 10, Sonex 30" com o convite de estoque do lote aberto: um fato, um autor',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'idle' });
            const { med: juvix } = await seeds.criarMedicamento({ userId: user.id, nome: 'Juvix', estoque: null, horarios: ['08:00'] });
            const { med: sonex } = await seeds.criarMedicamento({ userId: user.id, nome: 'Sonex', estoque: null, horarios: ['22:00'] });
            await ctx.db.from('conversation_state').update({
                state: 'adding_med',
                context: { sujeito: 'usuario', etapa: 'cad_estoque_lote', estoque_lote: [
                    { medicationId: juvix.id, nome: 'Juvix' }, { medicationId: sonex.id, nome: 'Sonex' }
                ] }
            }).eq('user_id', user.id);
            await falaDaNami(ctx, user, 'Prontinho, cadastrei os dois! ✅\n\n📦 *Estoque:* se você souber quantos comprimidos tem de cada um, é só me falar — eu te aviso quando estiver acabando.\nSe não souber agora, tudo bem também. 🌿', { estado: 'adding_med' });

            const r = await turno(ctx, user, 'Juvix 10, Sonex 30');
            checagensDeForma(checks, '"Juvix 10, Sonex 30"', r);
            for (const [med, n] of [[juvix, 10], [sonex, 30]]) {
                const { data: m } = await ctx.db.from('medications').select('estoque_atual').eq('id', med.id).single();
                checks.push({ nome: `estoque do ${med.nome} = ${n}`, ok: Number(m?.estoque_atual) === n, detalhe: `estoque_atual: ${m?.estoque_atual}` });
                const { data: movs } = await ctx.db.from('stock_movements').select('tipo, estoque_novo').eq('medication_id', med.id);
                checks.push({ nome: `UM movimento de estoque no ${med.nome}`, ok: (movs || []).length === 1, detalhe: JSON.stringify(movs) });
                checks.push({ nome: `o número ${n} aparece UMA vez na resposta`, ok: ocorrenciasDoNumero(r, n) === 1, detalhe: `${ocorrenciasDoNumero(r, n)} ocorrência(s)` });
            }
            checks.push({ nome: 'sem o informativo do principal ("Estoque atualizado!")', ...naoContem(r, /Estoque atualizado!/, 'segundo autor do fato') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A50',
        marco: 'M4',
        titulo: 'P1-ajustes §1 (Fran 26/09 22:27, Evandro 26/09 18:14) — "120" fora de coleta: principal com UPDATE_STOCK, número uma vez',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Evandro', onboarded: true, estado: 'confirming' });
            const { med } = await seeds.criarMedicamento({ userId: user.id, nome: 'Losartana', dosagem: '50mg', estoque: 30, horarios: ['08:00', '20:00'] });
            await falaDaNami(ctx, user, 'Claro, Evandro! Qual a quantidade atual em estoque do *Losartana*?', { estado: 'confirming' });

            const r = await turno(ctx, user, '120');
            checagensDeForma(checks, '"120"', r);
            const { data: m } = await ctx.db.from('medications').select('estoque_atual').eq('id', med.id).single();
            checks.push({ nome: 'estoque do Losartana = 120', ok: Number(m?.estoque_atual) === 120, detalhe: `estoque_atual: ${m?.estoque_atual}` });
            const { data: movs } = await ctx.db.from('stock_movements').select('tipo').eq('medication_id', med.id);
            checks.push({ nome: 'UM movimento de estoque', ok: (movs || []).length === 1, detalhe: JSON.stringify(movs) });
            checks.push({ nome: 'o número 120 aparece UMA vez', ok: ocorrenciasDoNumero(r, 120) === 1, detalhe: `${ocorrenciasDoNumero(r, 120)} ocorrência(s)` });
            checks.push({ nome: 'nada de narrar a gravação', ...naoContem(r, /\b(vou|vamos) (registrar|anotar|atualizar)\b|\banotad[oa]\b|\banotei\b/i, '"vou registrar…"') });
            // P1-ajustes 2 §2: o texto do turno de estoque é todo do código.
            checks.push({ nome: 'resposta = abertura + linha 📦 do código (nenhum texto do principal)', ok: RE_ABERTURA_ESTOQUE.test(r) && r.replace(RE_ABERTURA_ESTOQUE, '') === '📦 Estoque do *Losartana* atualizado: *120* comprimidos.', detalhe: JSON.stringify(r) });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A51',
        marco: 'M4',
        titulo: 'P1-ajustes §2 — fim do onboarding: ponte para o cadastro (template, sem LLM)',
        async executar() {
            const checks = [];
            const { renderizarConviteAoPrimeiroCadastro } = await import('../src/schemas/onboarding.js');
            const { renderizarPerguntaNome } = await import('../src/schemas/cadastro.js');
            const comData = renderizarConviteAoPrimeiroCadastro({ nomeColetado: 'Maria Silva' });
            const esperado = 'Prontinho, Maria, tudo guardado! 📝\n\n'
                + 'Agora, pra seguirmos com o cadastro dos seus remédios, pode me mandar tudo de uma vez, se quiser:\n'
                + '• o nome do remédio\n• quanto você toma por vez\n• os horários\n\n'
                + 'Por exemplo: Losartana 50mg, 1 comprimido, 8h e 20h';
            checks.push({ nome: 'com data: texto do §2, com a ponte', ok: comData === esperado, detalhe: JSON.stringify(comData) });
            const semData = renderizarConviteAoPrimeiroCadastro({ nomeColetado: 'Maria', semData: true });
            checks.push({ nome: 'sem data: "Tudo bem, {nome}! 🌿" com a mesma ponte', ok: semData === esperado.replace('Prontinho, Maria, tudo guardado! 📝', 'Tudo bem, Maria! 🌿'), detalhe: JSON.stringify(semData.slice(0, 120)) });
            const novo = renderizarPerguntaNome({ userName: 'Maria' });
            checks.push({ nome: 'cadastro novo NÃO muda (sem a ponte)', ...naoContem(novo, /pra seguirmos com o cadastro/, 'ponte fora do onboarding') });
            checks.push({ nome: 'cadastro novo segue com o convite de três linhas', ...contem(novo, /Pode me mandar tudo de uma vez, se quiser:/, 'convite único') });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A52',
        marco: 'M4',
        titulo: 'P1-ajustes §3 (staging 26/09 Topiramato/Resilex) — "quantos comprimidos" / "quantas unidades" (template, sem LLM)',
        async executar() {
            const checks = [];
            const { renderizarPerguntaEstoque } = await import('../src/schemas/cadastro.js');
            const { buildConviteEstoqueNaoCadastrado } = await import('../src/templates/estoqueTemplates.js');
            const { quantosDoRotulo } = await import('../src/templates/dose.js');
            const pComp = renderizarPerguntaEstoque('cad_estoque', { nome: 'Topiramato', unidade_dose: 'unidade', forma_explicita: 'comprimido' });
            const pUnid = renderizarPerguntaEstoque('cad_estoque', { nome: 'Resilex', unidade_dose: 'unidade' });
            checks.push({ nome: 'coleta, comprimido: "quantos comprimidos"', ...contem(pComp, /quantos comprimidos/, '"quantos comprimidos"') });
            checks.push({ nome: 'coleta, unidade: "quantas unidades"', ...contem(pUnid, /quantas unidades/, '"quantas unidades"') });
            const cComp = buildConviteEstoqueNaoCadastrado({ medNome: 'Topiramato', medForma: 'comprimido', unidadeEstoque: 'unidade' });
            const cUnid = buildConviteEstoqueNaoCadastrado({ medNome: 'Resilex', medForma: null, unidadeEstoque: 'unidade' });
            checks.push({ nome: 'convite pós-dose, comprimido: "quantos comprimidos"', ...contem(cComp, /quantos comprimidos/, '"quantos comprimidos"') });
            checks.push({ nome: 'convite pós-dose, unidade: "quantas unidades"', ...contem(cUnid, /quantas unidades/, '"quantas unidades"') });
            const todos = [pComp, pUnid, cComp, cUnid].join('\n');
            checks.push({ nome: 'nenhum "quantos unidades/cápsulas/gotas"', ...naoContem(todos, /quantos (unidades|cápsulas|gotas)/, 'concordância errada') });
            const mapa = ['comprimidos', 'frascos', 'sachês', 'ml', 'unidades', 'cápsulas', 'gotas'].map(quantosDoRotulo).join(' · ');
            checks.push({ nome: 'mapa único do pronome', ok: mapa === 'quantos comprimidos · quantos frascos · quantos sachês · quantos ml · quantas unidades · quantas cápsulas · quantas gotas', detalhe: mapa });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A53',
        marco: 'M4',
        titulo: 'P1-ajustes §4 (staging 26/09 23:00, Topiramato) — "Yes" com dose pendente durante o convite de estoque do mesmo remédio: convite uma vez',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Topiramato', dosagem: '25mg', estoque: null, horarios: ['22:58'] });
            await ctx.db.from('conversation_state').update({
                state: 'adding_med',
                context: { sujeito: 'usuario', etapa: 'cad_estoque', medication_id: med.id, nome: 'Topiramato', unidade_dose: 'unidade', forma_explicita: 'comprimido' }
            }).eq('user_id', user.id);
            await falaDaNami(ctx, user, 'Topiramato cadastrado! ✅\n\n📦 *Estoque:* se você souber quantos comprimidos tem em casa, é só me falar — eu te aviso quando estiver acabando.\nSe não souber agora, tudo bem também. 🌿', { estado: 'adding_med', minutosAtras: 10 });
            const dose = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '22:58', minutosAtras: 2 });

            const r = await turno(ctx, user, 'Yes');
            checagensDeForma(checks, '"Yes"', r);
            const depois = (await doseLogs(ctx.db, med.id)).find(d => d.id === dose.id);
            checks.push({ nome: 'dose do Topiramato confirmada', ok: depois?.status === 'confirmado', detalhe: `status: ${depois?.status}` });
            const convites = (r.match(/estoque/gi) || []).length;
            checks.push({ nome: 'o convite de estoque aparece UMA vez', ok: convites === 1, detalhe: `${convites} menção(ões) a "estoque": "${r.replace(/\n/g, ' ').slice(0, 200)}"` });
            checks.push({ nome: 'sem a linha de retomada repetida', ...naoContem(r, /E quando quiser me falar do estoque/, 'retomada duplicada') });
            checks.push({ nome: 'coleta de estoque preservada', ...(await estadoDaConversa(ctx.db, user.id, 'adding_med')) });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A54',
        marco: 'M4',
        titulo: 'P1-ajustes §5 (Evandro 27/09 17:00) — "Posso alterar a dose do Marevan para dias alternados?": ainda não + NUNCA, sem "não entendi"',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Evandro', onboarded: true, estado: 'idle' });
            const { med } = await seeds.criarMedicamento({ userId: user.id, nome: 'Marevan', dosagem: '5mg', estoque: 30, horarios: ['18:00'] });

            const r = await turno(ctx, user, 'Posso alterar a dose do Marevan para dias alternados?');
            checagensDeForma(checks, 'Marevan dias alternados', r);
            checks.push({ nome: 'nenhuma pergunta segura ("não consegui te entender")', ...naoContem(r, /n[ãa]o consegui te entender/i, 'pergunta segura') });
            checks.push({ nome: 'a resposta nomeia o pedido', ...contem(r, /alternad|dia sim,? dia n[ãa]o|frequ[êe]ncia/i, 'o pedido (dias alternados)') });
            checks.push({ nome: 'o lembrete recebe o "ainda não"', ...contem(r, /\bainda\b/i, '"ainda"') });
            const { data: scheds } = await ctx.db.from('schedules').select('horario, ativo').eq('medication_id', med.id);
            checks.push({ nome: 'nada muda no Marevan', ok: (scheds || []).length === 1 && scheds[0].ativo === true, detalhe: JSON.stringify(scheds) });
            const eventos = await eventosAindaNao(ctx, user.id);
            checks.push({ nome: 'UM evento intencao_nao_suportada', ok: eventos.length === 1, detalhe: `${eventos.length} evento(s)` });
            const ev = eventos[0];
            checks.push({ nome: 'evento com pedido no payload e título "Ainda não: …"', ok: !!ev?.payload?.pedido && /^Ainda não: /.test(ev?.titulo || ''), detalhe: JSON.stringify({ titulo: ev?.titulo, payload: ev?.payload }) });
            checks.push({ nome: 'evento: origem porta, severidade baixa, triagem novo, com agent_log_id', ok: ev?.origem === 'porta' && ev?.severidade === 'baixa' && ev?.status_triagem === 'novo' && !!ev?.agent_log_id, detalhe: JSON.stringify({ origem: ev?.origem, severidade: ev?.severidade, status: ev?.status_triagem, log: ev?.agent_log_id }) });
            // P1-ajustes 2 §1: o texto é do código (nenhuma frase do principal).
            const esperado54 = await textoAindaNaoEsperado(ev, 'Evandro');
            checks.push({ nome: 'resposta = texto do código do "ainda não"', ok: r === esperado54, detalhe: JSON.stringify({ r, esperado: esperado54 }).slice(0, 400) });
            if (eventos.length) await ctx.db.from('system_events').delete().in('id', eventos.map(e => e.id));
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A55',
        marco: 'M4',
        titulo: 'P1-ajustes §5 — pedido fora de todas as listas ("consegue me lembrar de beber água?"): "ainda não" por padrão, evento gravado',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Ana', onboarded: true, estado: 'idle' });
            await seeds.criarMedicamento({ userId: user.id, nome: 'Losartana', estoque: 30, horarios: ['08:00'] });

            const r = await turno(ctx, user, 'consegue me lembrar de beber água?');
            checagensDeForma(checks, 'beber água', r);
            checks.push({ nome: 'nenhuma pergunta segura', ...naoContem(r, /n[ãa]o consegui te entender/i, 'pergunta segura') });
            checks.push({ nome: '"ainda não" (honestidade)', ...contem(r, /\bainda\b/i, '"ainda"') });
            checks.push({ nome: 'não promete nem confirma o lembrete', ...naoContem(r, /(vou|vamos) te lembrar|lembrete (criado|cadastrado|configurado)|combinado, vou/i, 'promessa') });
            const meds = await medicamentos(ctx.db, user.id);
            checks.push({ nome: 'nenhum medicamento novo (água não vira cadastro)', ok: meds.length === 1, detalhe: `${meds.length} medicamento(s)` });
            const eventos = await eventosAindaNao(ctx, user.id);
            checks.push({ nome: 'UM evento intencao_nao_suportada com pedido', ok: eventos.length === 1 && !!eventos[0]?.payload?.pedido, detalhe: JSON.stringify(eventos.map(e => ({ titulo: e.titulo, payload: e.payload }))) });
            // P1-ajustes 2 §1: o texto é do código (nenhuma frase do principal).
            const esperado55 = await textoAindaNaoEsperado(eventos[0], 'Ana');
            checks.push({ nome: 'resposta = texto do código do "ainda não"', ok: r === esperado55, detalhe: JSON.stringify({ r, esperado: esperado55 }).slice(0, 400) });
            if (eventos.length) await ctx.db.from('system_events').delete().in('id', eventos.map(e => e.id));
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A56',
        marco: 'M4',
        titulo: 'P1-ajustes 2 §1 (staging 28/09 18:19/18:21, Rivotril) — duas perguntas de mesmo teor sobre dias alternados: as duas com o texto do código, sem oferta de recadastro',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'idle' });
            const { med } = await seeds.criarMedicamento({ userId: user.id, nome: 'Rivotril', dosagem: '2mg', estoque: 30, horarios: ['22:00'] });

            const respostas = [];
            for (const [i, msg] of ['Posso alterar a dose do Rivotril para dias alternados?', 'Quero atualizar os dias, tomo em dias alternados'].entries()) {
                const r = await turno(ctx, user, msg);
                respostas.push(r);
                checagensDeForma(checks, `turno ${i + 1}`, r);
                const eventos = await eventosAindaNao(ctx, user.id);
                checks.push({ nome: `turno ${i + 1}: ${i + 1} evento(s) intencao_nao_suportada no total (um por turno)`, ok: eventos.length === i + 1, detalhe: `${eventos.length} evento(s)` });
                const esperados = await Promise.all(eventos.map(e => textoAindaNaoEsperado(e, 'Guilherme')));
                checks.push({ nome: `turno ${i + 1}: resposta = texto do código do "ainda não"`, ok: esperados.includes(r), detalhe: JSON.stringify({ r, esperados }).slice(0, 400) });
                checks.push({ nome: `turno ${i + 1}: não oferece cadastrar de novo`, ...naoContem(r, /cadastr/i, 'oferta de recadastro') });
            }
            const meds = await medicamentos(ctx.db, user.id);
            checks.push({ nome: 'o Rivotril segue único e ativo', ok: meds.length === 1 && meds[0].id === med.id, detalhe: `${meds.length} medicamento(s)` });
            const eventos = await eventosAindaNao(ctx, user.id);
            if (eventos.length) await ctx.db.from('system_events').delete().in('id', eventos.map(e => e.id));
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A57',
        marco: 'M4',
        titulo: 'P1-ajustes 2 §2 — "Comprei 20 comprimidos do Atenolol" fora de coleta: abertura + linha 📦 do código, número uma vez',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Ana', onboarded: true, estado: 'idle' });
            const { med } = await seeds.criarMedicamento({ userId: user.id, nome: 'Atenolol', dosagem: '25mg', estoque: 0, horarios: ['08:00'] });
            await ctx.db.from('medications').update({ estoque_minimo: 5 }).eq('id', med.id);

            const r = await turno(ctx, user, 'Comprei 20 comprimidos do Atenolol');
            checagensDeForma(checks, 'compra', r);
            const { data: m } = await ctx.db.from('medications').select('estoque_atual').eq('id', med.id).single();
            checks.push({ nome: 'estoque do Atenolol = 20', ok: Number(m?.estoque_atual) === 20, detalhe: `estoque_atual: ${m?.estoque_atual}` });
            checks.push({ nome: 'resposta = abertura + "📦 Estoque do *Atenolol* atualizado: *20* comprimidos."', ok: RE_ABERTURA_ESTOQUE.test(r) && r.replace(RE_ABERTURA_ESTOQUE, '') === '📦 Estoque do *Atenolol* atualizado: *20* comprimidos.', detalhe: JSON.stringify(r) });
            checks.push({ nome: 'o número 20 aparece UMA vez', ok: ocorrenciasDoNumero(r, 20) === 1, detalhe: `${ocorrenciasDoNumero(r, 20)} ocorrência(s)` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A58',
        marco: 'M4',
        titulo: 'P1-ajustes 2 §2 — "Comprei 60 comprimidos / Sim" com a dose aberta: uma abertura, a linha da dose, a linha do estoque',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Flávia', onboarded: true, estado: 'idle' });
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Regenesis', estoque: 0, horarios: ['11:58'] });
            await ctx.db.from('medications').update({ estoque_minimo: 5 }).eq('id', med.id);
            const { envio, messageId } = await seeds.criarEnvioFunil({
                user, minutosAtras: 4, origem: 'proativo:alerta_estoque_zerado',
                texto: '⏰ Flávia, está na hora do seu *Regenesis*!\n\nPelas minhas contas o estoque acabou — mas se você ainda tem e já tomou, é só responder SIM que eu registro. 💊\n\nSe comprou mais, me conta quantos: *"Comprei 30 comprimidos de Regenesis"*'
            });
            const dose = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '11:58', minutosAtras: 4, status: 'sem_estoque', funilEnvioId: envio.id });

            const r = await turno(ctx, user, 'Comprei 60 comprimidos\nSim', { referenceMessageId: messageId });
            checagensDeForma(checks, 'compra + sim', r);
            const st = (await doseLogs(ctx.db, med.id)).find(d => d.id === dose.id)?.status;
            checks.push({ nome: 'dose confirmada', ok: st === 'confirmado', detalhe: `status: ${st}` });
            const { data: m } = await ctx.db.from('medications').select('estoque_atual').eq('id', med.id).single();
            checks.push({ nome: 'estoque = 60 (a dose do mesmo turno pode ter baixado 1)', ok: [59, 60].includes(Number(m?.estoque_atual)), detalhe: `estoque_atual: ${m?.estoque_atual}` });
            const aberturas = (r.match(/(^|\n)(Boa|Perfeito|Isso aí|Que bom|Tudo certo|Show)(, [^!\n]+)?! /g) || []).length;
            checks.push({ nome: 'UMA abertura', ok: aberturas === 1, detalhe: `${aberturas} abertura(s): ${JSON.stringify(r)}` });
            const iDose = r.search(/\*Regenesis\* de hoje \(\d{2}:\d{2}\) confirmada 💊/);
            const iEst = r.search(/📦 Estoque do \*Regenesis\* atualizado: \*\d+\* comprimidos\./);
            checks.push({ nome: 'a linha da dose e depois a linha do estoque', ok: iDose >= 0 && iEst > iDose, detalhe: `dose@${iDose}, estoque@${iEst}` });
            checks.push({ nome: 'a abertura abre a mensagem (na linha da dose)', ok: RE_ABERTURA_ESTOQUE.test(r) && /^[^\n]+! ✅/.test(r), detalhe: r.split('\n')[0] });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A59',
        marco: 'M4',
        titulo: 'P1-ajustes 2 §3 — "hmm, não foi isso que eu te falei" logo após o cadastro (sem a palavra "erro"): pergunta o que mudar, nada gravado',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Fran', onboarded: true, estado: 'post_onboarding' });
            await turno(ctx, user, 'Puran T4 75mcg, 1 comprimido às 6:30');
            const antes = await medicamentos(ctx.db, user.id);
            const { data: schedAntes } = await ctx.db.from('schedules').select('id, horario, ativo').in('medication_id', antes.map(m => m.id));

            const r = await turno(ctx, user, 'hmm, não foi isso que eu te falei');
            checagensDeForma(checks, '"não foi isso"', r);
            checks.push({ nome: 'pergunta o que mudar', ...contem(r, /\?/, 'uma pergunta') });
            checks.push({ nome: 'não repete o convite de estoque', ...naoContem(r, /quantos comprimidos|se voc[êe] souber quant[oa]s|estoque/i, 'convite de estoque') });
            const depois = await medicamentos(ctx.db, user.id);
            const { data: schedDepois } = await ctx.db.from('schedules').select('id, horario, ativo').in('medication_id', depois.map(m => m.id));
            const chave = (l) => JSON.stringify((l || []).map(x => [x.id, x.horario, x.ativo]).sort());
            checks.push({ nome: 'nada é gravado (medicamentos e horários iguais)', ok: depois.length === antes.length && chave(schedDepois) === chave(schedAntes) && depois.every(m => m.estoque_atual === null), detalhe: `${antes.length}→${depois.length} medicamento(s)` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A60',
        marco: 'M4',
        titulo: 'P1-ajustes 2 §3 (Guilherme 28/09 18:30, Decadron) — "não é esse horário, é 18:30" logo após cadastrar às 18:00: vai à configuração e o horário passa a 18:30',
        async executar({ ctx, seeds }) {
            const checks = [];
            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'post_onboarding' });
            await turno(ctx, user, 'Decadron 4mg, 1 comprimido às 18:00');
            const [dec] = await medicamentos(ctx.db, user.id, { nomeIlike: 'Decadron%' });
            if (!dec) return [{ nome: 'setup: Decadron cadastrado às 18:00', ok: false, detalhe: 'sem medicamento' }];

            let r = await turno(ctx, user, 'não é esse horário, é 18:30');
            checagensDeForma(checks, '"é 18:30"', r);
            if (/Confirmar\?/.test(r)) r = await turno(ctx, user, 'Sim');
            const { data: scheds } = await ctx.db.from('schedules').select('horario, ativo').eq('medication_id', dec.id);
            const ativos = (scheds || []).filter(s => s.ativo).map(s => String(s.horario).slice(0, 5));
            checks.push({ nome: 'o horário do Decadron passa a 18:30 (e só ele)', ok: ativos.length === 1 && ativos[0] === '18:30', detalhe: JSON.stringify(scheds) });
            const meds = await medicamentos(ctx.db, user.id, { nomeIlike: 'Decadron%' });
            checks.push({ nome: 'nenhum Decadron duplicado', ok: meds.length === 1, detalhe: `${meds.length} registro(s)` });
            return checks;
        }
    },

    // --------------------------------------------------------
    // v47 ONDA 1 — casos SEM LLM (decisão de 29/09: o portão da onda roda sem
    // custo; nenhum destes casos chama routeMessage — só funções puras e
    // escritas diretas pelas funções de produção).
    // --------------------------------------------------------
    {
        id: 'A61',
        marco: 'M4',
        titulo: 'v47 §6.1 caso-ouro 29/09 — "tomei" citando a cobrança encerrada: o ASSUNTO devolve a dose citada como candidata única; envio legado cai no fallback',
        async executar({ ctx, seeds }) {
            const checks = [];
            const { getAssuntoDoEnvio, getDosesDoEnvio, registrarAssuntosDoEnvio, getDosesJanelaPrincipal }
                = await import('../src/database.js');
            const { avaliarAtalhoExato, executarAtalho } = await import('../src/dosesDoTurno.js');

            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'idle' });
            const { med: creatina, schedules: sC } = await seeds.criarMedicamento({ userId: user.id, nome: 'Creatina', estoque: null, horarios: ['08:30'] });
            const { med: omega, schedules: sO } = await seeds.criarMedicamento({ userId: user.id, nome: 'Ômega 3', estoque: 30, horarios: ['09:00'] });

            // Cobrança encerrada da Creatina (as 3 tentativas se esgotaram) — envio COM assunto.
            const { envio } = await seeds.criarEnvioFunil({
                user, minutosAtras: 60, origem: 'proativo:cobranca_encerrada',
                texto: '⚠️ Guilherme, não recebi confirmação da sua dose do *Creatina*.\n\nQuando puder, me avise se tomou! 💊'
            });
            const doseCreatina = await seeds.criarDose({ medicationId: creatina.id, scheduleId: sC[0].id, horario: '08:30', minutosAtras: 90, status: 'nao_informado', tentativas: 3 });
            await registrarAssuntosDoEnvio(envio.id, [{ fato: 'cobranca_encerrada', doseLogId: doseCreatina.id, medicationId: creatina.id }]);

            // A dose aberta MAIS RECENTE é de outro remédio — sem a citação, a pista seria ela (o BUG-114).
            const doseOmega = await seeds.criarDose({ medicationId: omega.id, scheduleId: sO[0].id, horario: '09:00', minutosAtras: 10 });

            const assunto = await getAssuntoDoEnvio(envio.id);
            checks.push({
                nome: 'assunto resolvido: fato cobranca_encerrada + a dose da Creatina',
                ok: assunto?.assuntos?.length === 1 && assunto.assuntos[0].fato === 'cobranca_encerrada'
                    && assunto?.doses?.length === 1 && assunto.doses[0].id === doseCreatina.id,
                detalhe: JSON.stringify(assunto?.assuntos || null)
            });

            const doses = await getDosesJanelaPrincipal(user.id);
            const atalho = avaliarAtalhoExato({ message: 'tomei', state: { state: 'idle' }, doses, dosesCitadas: assunto?.doses || [] });
            checks.push({
                nome: 'avaliarAtalhoExato: candidata ÚNICA = a dose do assunto (Creatina), não a mais recente',
                ok: !!atalho.doses && atalho.doses.length === 1 && atalho.doses[0].id === doseCreatina.id,
                detalhe: atalho.doses ? atalho.doses.map(d => d.medications?.nome).join(',') : `motivo: ${atalho.motivo}`
            });

            // Execução do atalho (sem LLM): retroativa confirmada + status_pre_confirmacao gravado.
            const exec = await executarAtalho({ user, doses: atalho.doses || [] });
            const dCreatinaDepois = (await doseLogs(ctx.db, creatina.id)).find(d => d.id === doseCreatina.id);
            checks.push({
                nome: 'atalho confirma a dose citada (retroativa) e grava status_pre_confirmacao',
                ok: exec.ok && dCreatinaDepois?.status === 'confirmado' && dCreatinaDepois?.status_pre_confirmacao === 'nao_informado',
                detalhe: `status: ${dCreatinaDepois?.status}, pre: ${dCreatinaDepois?.status_pre_confirmacao}`
            });
            const dOmegaDepois = (await doseLogs(ctx.db, omega.id)).find(d => d.id === doseOmega.id);
            checks.push({ nome: 'a dose do Ômega 3 (não citada) segue pendente', ok: dOmegaDepois?.status === 'pendente', detalhe: `status: ${dOmegaDepois?.status}` });

            // LEGADO: envio SEM linhas de assunto → getAssuntoDoEnvio nulo, fallback
            // por funil_envio_id preserva o comportamento atual.
            const { envio: envioLegado } = await seeds.criarEnvioFunil({
                user, minutosAtras: 5, origem: 'proativo:lembrete',
                texto: '⏰ Olá, Guilherme!\n\nHora do seu *Ômega 3*.\n\nJá tomou? Responda *SIM* ou *NÃO* 💊'
            });
            await ctx.db.from('dose_logs').update({ funil_envio_id: envioLegado.id }).eq('id', doseOmega.id);
            const assuntoLegado = await getAssuntoDoEnvio(envioLegado.id);
            checks.push({ nome: 'envio legado (sem assunto): getAssuntoDoEnvio devolve nulo', ok: assuntoLegado === null, detalhe: JSON.stringify(assuntoLegado) });
            const dosesLegado = await getDosesDoEnvio(envioLegado.id);
            const atalhoLegado = avaliarAtalhoExato({ message: 'tomei', state: { state: 'idle' }, doses: await getDosesJanelaPrincipal(user.id), dosesCitadas: dosesLegado });
            checks.push({
                nome: 'fallback legado: a citação resolve pelo funil_envio_id como hoje',
                ok: dosesLegado.length === 1 && dosesLegado[0].id === doseOmega.id
                    && !!atalhoLegado.doses && atalhoLegado.doses.length === 1 && atalhoLegado.doses[0].id === doseOmega.id,
                detalhe: `dosesLegado: ${dosesLegado.length}, atalho: ${atalhoLegado.doses ? 'candidata única' : atalhoLegado.motivo}`
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A62',
        marco: 'M4',
        titulo: 'v47 §6.2 (BUG-115) — desfazer devolve a dose ao status ANTERIOR à confirmação; heurística legada nunca mais devolve nao_tomado; trilha presente',
        async executar({ ctx, seeds }) {
            const checks = [];
            const { confirmDoseByLogId, confirmarDoseRetroativa, confirmarDoseSemEstoque, reverterConfirmacao }
                = await import('../src/database.js');

            const user = await seeds.criarUsuario({ nome: 'Fran', onboarded: true, estado: 'idle' });
            // Estoque nulo de propósito: nenhum movimento de estoque entra no caso (P49 intocado).
            const { med, schedules } = await seeds.criarMedicamento({ userId: user.id, nome: 'Puran T4', estoque: null, horarios: ['08:00'] });
            const doseDepois = async (id) => (await doseLogs(ctx.db, med.id)).find(d => d.id === id);

            // 1. pendente → confirmada → desfeita → PENDENTE (cobranças ainda valiam).
            const d1 = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '08:00', minutosAtras: 30, status: 'pendente', tentativas: 1 });
            await confirmDoseByLogId(d1.id);
            checks.push({ nome: 'confirmDoseByLogId grava status_pre_confirmacao=pendente', ok: (await doseDepois(d1.id))?.status_pre_confirmacao === 'pendente', detalhe: `pre: ${(await doseDepois(d1.id))?.status_pre_confirmacao}` });
            const r1 = await reverterConfirmacao(d1.id, 'teste do arnês (§6.2)');
            checks.push({ nome: 'desfazer devolve pendente', ok: r1.novoStatus === 'pendente' && (await doseDepois(d1.id))?.status === 'pendente', detalhe: `novoStatus: ${r1.novoStatus}` });

            // 2. nao_informado (cobranças esgotadas) → retroativa → desfeita → NAO_INFORMADO.
            const d2 = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '08:00', minutosAtras: 200, status: 'nao_informado', tentativas: 3 });
            await confirmarDoseRetroativa(d2.id, 'teste do arnês');
            checks.push({ nome: 'confirmarDoseRetroativa grava status_pre_confirmacao=nao_informado', ok: (await doseDepois(d2.id))?.status_pre_confirmacao === 'nao_informado', detalhe: `pre: ${(await doseDepois(d2.id))?.status_pre_confirmacao}` });
            const r2 = await reverterConfirmacao(d2.id, 'teste do arnês (§6.2)');
            checks.push({ nome: 'desfazer devolve nao_informado', ok: r2.novoStatus === 'nao_informado' && (await doseDepois(d2.id))?.status === 'nao_informado', detalhe: `novoStatus: ${r2.novoStatus}` });

            // 3. sem_estoque → confirmada → desfeita → SEM_ESTOQUE (P49: nada re-incrementa).
            const d3 = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '08:00', minutosAtras: 100, status: 'sem_estoque', tentativas: 1 });
            await confirmarDoseSemEstoque(d3.id);
            checks.push({ nome: 'confirmarDoseSemEstoque grava status_pre_confirmacao=sem_estoque', ok: (await doseDepois(d3.id))?.status_pre_confirmacao === 'sem_estoque', detalhe: `pre: ${(await doseDepois(d3.id))?.status_pre_confirmacao}` });
            const r3 = await reverterConfirmacao(d3.id, 'teste do arnês (§6.2)');
            checks.push({ nome: 'desfazer devolve sem_estoque', ok: r3.novoStatus === 'sem_estoque' && (await doseDepois(d3.id))?.status === 'sem_estoque', detalhe: `novoStatus: ${r3.novoStatus}` });
            const { data: movs } = await ctx.db.from('stock_movements').select('tipo').eq('medication_id', med.id);
            checks.push({ nome: 'nenhum movimento de estoque no caso inteiro (estoque nulo, P49)', ok: (movs || []).length === 0, detalhe: JSON.stringify(movs) });

            // 4. LEGADO: confirmada ANTES da coluna (nula) + tentativas esgotadas →
            // heurística corrigida devolve NAO_INFORMADO (nunca mais nao_tomado).
            const d4 = await seeds.criarDose({ medicationId: med.id, scheduleId: schedules[0].id, horario: '08:00', minutosAtras: 300, status: 'confirmado', tentativas: 3 });
            const r4 = await reverterConfirmacao(d4.id, 'teste do arnês (§6.2 legado)');
            checks.push({ nome: 'coluna nula + tentativas esgotadas → nao_informado (não nao_tomado)', ok: r4.novoStatus === 'nao_informado' && (await doseDepois(d4.id))?.status === 'nao_informado', detalhe: `novoStatus: ${r4.novoStatus}` });

            // 5. Trilha (§4.4): cada reversão registrou a transição completa em
            // evento de observabilidade (tipo trilha_auditoria, arquivado).
            const { data: eventos } = await ctx.db.from('system_events')
                .select('payload, status_triagem')
                .eq('tipo', 'trilha_auditoria')
                .eq('user_id', user.id);
            const porDose = new Map((eventos || []).map(e => [e.payload?.dose_log_id, e]));
            const trilhaOk = [
                [d1.id, 'pendente', 'status_pre_confirmacao'],
                [d2.id, 'nao_informado', 'status_pre_confirmacao'],
                [d3.id, 'sem_estoque', 'status_pre_confirmacao'],
                [d4.id, 'nao_informado', 'heuristica']
            ].every(([id, devolvido, fonte]) => {
                const ev = porDose.get(id);
                return ev && ev.payload?.status_devolvido === devolvido && ev.payload?.fonte === fonte
                    && typeof ev.payload?.motivo === 'string' && ev.status_triagem === 'arquivado';
            });
            checks.push({ nome: 'trilha de observabilidade: 4 transições completas (status devolvido + fonte + motivo)', ok: trilhaOk, detalhe: `${(eventos || []).length} evento(s)` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A63',
        marco: 'M4',
        titulo: 'v47 §6.3 — equivalência estrita: texto da cobrança encerrada byte-idêntico ao anterior nos dois ramos',
        async executar() {
            const checks = [];
            const { buildCobrancaEncerrada } = await import('../src/templates/estoqueTemplates.js');

            // Snapshots capturados de buildAlertaEstoqueNaoInformado ANTES do rename
            // (30/09/2026, staging) — a saída da função renomeada tem que sair
            // byte-idêntica. Mover/alterar o template é onda 3, nunca esta.
            const esperados = [
                {
                    rotulo: 'ramo estoqueDesconhecido',
                    entrada: ['Guilherme', { medNome: 'Creatina', medForma: 'comprimido', estoqueDesconhecido: true }],
                    texto: '⚠️ Guilherme, não recebi confirmação da sua dose do *Creatina*.\n\nQuando puder, me avise se tomou! 💊'
                },
                {
                    rotulo: 'ramo com estoque (nível ok)',
                    entrada: ['Guilherme', { medNome: 'Creatina', medForma: 'comprimido', novoEstoque: 12, diasRestantes: 12, estoqueDesconhecido: false }],
                    texto: '⚠️ Guilherme, não recebi confirmação da sua dose do *Creatina*.\n\nSeu estoque atual é de *12* unidades — dura mais 12 dias.\nQuando puder, me avise se tomou, e não esqueça de providenciar a recompra! 💊'
                },
                {
                    rotulo: 'ramo com estoque (1 unidade, 1 dia, forma gota)',
                    entrada: ['Ana', { medNome: 'Gotas X', medForma: 'gota', novoEstoque: 1, diasRestantes: 1, estoqueDesconhecido: false }],
                    texto: '⚠️ Ana, não recebi confirmação da sua dose do *Gotas X*.\n\nSeu estoque atual é de *1* unidade — dura mais 1 dia.\nQuando puder, me avise se tomou ou usou, e não esqueça de providenciar a recompra! 💊'
                },
                {
                    rotulo: 'ramo com estoque (zerado)',
                    entrada: ['Ana', { medNome: 'Gotas X', medForma: 'gota', novoEstoque: 0, diasRestantes: 0, estoqueDesconhecido: false }],
                    texto: '⚠️ Ana, não recebi confirmação da sua dose do *Gotas X*.\n\nSeu estoque atual é de *0* unidades — está esgotado.\nQuando puder, me avise se tomou ou usou, e não esqueça de providenciar a recompra! 💊'
                }
            ];
            for (const { rotulo, entrada, texto } of esperados) {
                const saida = buildCobrancaEncerrada(...entrada);
                checks.push({
                    nome: `byte-idêntico: ${rotulo}`,
                    ok: saida === texto,
                    detalhe: saida === texto ? 'igual' : `diferente — atual: ${JSON.stringify(saida)}`
                });
            }
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A64',
        marco: 'M4',
        titulo: 'v47 §6.4 (grep-guard §8.2 estendido) — todo envio proativo registra assunto; rótulo antigo morto por construção',
        async executar() {
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

            // Todo envio com origem 'proativo:*' registra assunto: ou o funil o
            // recebe no ato (`assuntos:` na chamada), ou o chamador registra logo
            // depois de criar as doses (registrarAssuntosDoEnvio na vizinhança).
            const JANELA = 30;
            const violadores = [];
            for (const [arquivo, c] of conteudo.entries()) {
                const linhas = c.split('\n');
                linhas.forEach((linha, i) => {
                    if (!/origem: 'proativo:/.test(linha)) return;
                    const vizinhanca = linhas.slice(Math.max(0, i - JANELA), i + JANELA + 1).join('\n');
                    if (!/assuntos|registrarAssuntosDoEnvio/.test(vizinhanca)) {
                        violadores.push(`${arquivo}:${i + 1} (${linha.trim().slice(0, 60)})`);
                    }
                });
            }
            checks.push({ nome: 'grep: todo envio proativo tem assunto na vizinhança do envio', ok: violadores.length === 0, detalhe: violadores.join(' | ') || 'limpo' });

            // §2.4: o rótulo antigo não nasce mais — nem como origem, nem como
            // evento proativo novo, nem como nome de builder (rename completo).
            const origemVelha = [...conteudo.entries()].filter(([, c]) => /proativo:alerta_estoque_nao_informado/.test(c)).map(([f]) => f);
            checks.push({ nome: "grep: origem 'proativo:alerta_estoque_nao_informado' morta", ok: origemVelha.length === 0, detalhe: origemVelha.join(', ') || 'limpo' });
            const tipoVelho = [...conteudo.entries()].filter(([, c]) => /tipo: 'alerta_estoque_nao_informado'/.test(c)).map(([f]) => f);
            checks.push({ nome: 'grep: nenhum evento proativo NOVO com o tipo antigo', ok: tipoVelho.length === 0, detalhe: tipoVelho.join(', ') || 'limpo' });
            const builderVelho = [...conteudo.entries()].filter(([, c]) => /buildAlertaEstoqueNaoInformado/.test(c)).map(([f]) => f);
            checks.push({ nome: 'grep: buildAlertaEstoqueNaoInformado não existe mais (rename → buildCobrancaEncerrada)', ok: builderVelho.length === 0, detalhe: builderVelho.join(', ') || 'limpo' });
            return checks;
        }
    },

    // --------------------------------------------------------
    // v47 ONDA 1 (compositor, MH-100 B) — casos SEM LLM: âncora e natureza são
    // funções puras; a produção de fatos e o canônico saem das funções de
    // escrita reais (banco), nunca de routeMessage.
    // --------------------------------------------------------
    {
        id: 'A65',
        marco: 'M4',
        titulo: 'v47 compositor §6.1 caso-ouro 17:24 — fatos tipados pós-escrita, natureza correcao, âncora aprova/reprova, fallback canônico = montagem atual',
        async executar({ ctx, seeds }) {
            const checks = [];
            const { executarFatosDeDose } = await import('../src/dosesDoTurno.js');
            const { textoDeConfirmacao } = await import('../src/templates/dose.js');
            const { verificarComposicao, derivarNatureza } = await import('../src/compositor.js');

            const user = await seeds.criarUsuario({ nome: 'Guilherme', onboarded: true, estado: 'idle' });
            const { med: creatina, schedules: sC } = await seeds.criarMedicamento({ userId: user.id, nome: 'Creatina', estoque: null, horarios: ['08:30'] });
            const { med: omega, schedules: sO } = await seeds.criarMedicamento({ userId: user.id, nome: 'Ômega 3', estoque: null, horarios: ['09:00'] });
            // Creatina registrada como NÃO tomada (a pessoa vai corrigir: "tomei sim");
            // Ômega 3 confirmado por engano (a pessoa vai desfazer) — cobranças esgotadas.
            const doseCreatina = await seeds.criarDose({ medicationId: creatina.id, scheduleId: sC[0].id, horario: '08:30', quando: hojeHaMinutos(90), status: 'nao_tomado', tentativas: 3 });
            const doseOmega = await seeds.criarDose({ medicationId: omega.id, scheduleId: sO[0].id, horario: '09:00', quando: hojeHaMinutos(60), status: 'confirmado', tentativas: 3 });

            const mapa = new Map([
                ['D1', { id: doseCreatina.id, status: 'nao_tomada', statusBanco: 'nao_tomado', medicationId: creatina.id, nome: 'Creatina' }],
                ['D2', { id: doseOmega.id, status: 'confirmada', statusBanco: 'confirmado', medicationId: omega.id, nome: 'Ômega 3' }]
            ]);
            const r = await executarFatosDeDose({ user, fatos: [{ ref: 'D1', fato: 'tomou' }, { ref: 'D2', fato: 'desfazer' }], mapa });
            if (!r.ok) return [{ nome: 'setup: execução dos fatos do caso-ouro', ok: false, detalhe: r.motivo }];

            // Fatos tipados pós-escrita (§1 do briefing do compositor).
            const tipos = r.fatosDoTurno.map(f => f.tipo).sort();
            const fConf = r.fatosDoTurno.find(f => f.tipo === 'dose_confirmada');
            const fRev = r.fatosDoTurno.find(f => f.tipo === 'dose_revertida');
            const fConv = r.fatosDoTurno.find(f => f.tipo === 'convite_estoque');
            checks.push({
                nome: 'fatos tipados: dose_confirmada (corrigida) + dose_revertida + convite_estoque',
                ok: tipos.join(',') === 'convite_estoque,dose_confirmada,dose_revertida'
                    && fConf?.corrigida === true && fConf?.medicamento === 'Creatina'
                    && fRev?.statusDevolvido === 'nao_informado' && fRev?.medicamento === 'Ômega 3'
                    && fConv?.motivo === 'estoque_nao_informado',
                detalhe: JSON.stringify(r.fatosDoTurno.map(f => ({ tipo: f.tipo, med: f.medicamento })))
            });
            checks.push({ nome: 'natureza derivada por código: correcao', ok: derivarNatureza(r.fatosDoTurno) === 'correcao', detalhe: derivarNatureza(r.fatosDoTurno) });

            // (c) Fallback canônico = a montagem atual (dosesDoTurno + templates).
            const RE_CANONICO = /^(Boa|Perfeito|Isso aí|Que bom|Tudo certo|Show)(, Guilherme)?! ✅ \*Creatina\* de hoje \(08:30\) confirmada 💊\n\nDesfiz a confirmação: \*Ômega 3\* de hoje \(09:00\)\. 🌿\n\n📦 Ainda não tenho o estoque do \*Creatina\* cadastrado\./;
            checks.push({ nome: 'canônico dos mesmos fatos = montagem atual (confirmação, desfiz, convite)', ...contem(r.texto, RE_CANONICO, 'formato canônico') });
            const doseLida = (await doseLogs(ctx.db, creatina.id)).find(d => d.id === doseCreatina.id);
            const doseParaTexto = { ...doseLida, medications: { nome: 'Creatina' } };
            const t1 = textoDeConfirmacao({ abertura: 'Boa!', confirmadas: [doseParaTexto] });
            const t2 = textoDeConfirmacao({ abertura: 'Boa!', confirmadas: [doseParaTexto] });
            checks.push({ nome: 'renderização canônica determinística (mesma entrada, mesmo byte)', ok: t1 === t2 && t1.length > 0, detalhe: JSON.stringify(t1) });
            checks.push({ nome: 'a âncora APROVA o próprio canônico', ok: verificarComposicao(r.fatosDoTurno, r.texto, { medicamentosDoUsuario: ['Creatina', 'Ômega 3'] }).ok === true, detalhe: JSON.stringify(verificarComposicao(r.fatosDoTurno, r.texto, { medicamentosDoUsuario: ['Creatina', 'Ômega 3'] })) });

            // (a) A âncora aprova um texto-fixture bem composto destes fatos.
            const bemComposto = 'Prontinho, Guilherme — corrigi aqui: a *Creatina* de hoje (08:30) está registrada como tomada, e desfiz a confirmação do *Ômega 3* de hoje (09:00), que voltou a aguardar sua resposta. 🌿\n\nSe souber quantos comprimidos de Creatina você tem em casa, me conta que eu anoto e te aviso quando estiver acabando.';
            checks.push({ nome: 'âncora aprova o fixture bem composto', ok: verificarComposicao(r.fatosDoTurno, bemComposto, { medicamentosDoUsuario: ['Creatina', 'Ômega 3'] }).ok === true, detalhe: JSON.stringify(verificarComposicao(r.fatosDoTurno, bemComposto, { medicamentosDoUsuario: ['Creatina', 'Ômega 3'] })) });

            // (b) A âncora REPROVA as três violações do briefing (+ horário inventado).
            const reprovas = [
                ['número inventado', `${bemComposto}\n\nVocê ainda tem 12 comprimidos.`, /^numero_inventado/],
                ['medicamento do fato ausente', 'Prontinho, Guilherme — corrigi aqui: a *Creatina* de hoje (08:30) está registrada como tomada. 🌿', /^fato_ausente:medicamento/],
                ['medicamento estranho aos fatos', `${bemComposto.replace(' 🌿', '')} A Dipirona segue como estava. 🌿`, /^medicamento_fora_dos_fatos/],
                ['horário inventado', `${bemComposto.replace('(09:00)', '(10:15)')}`, /^(horario_inventado|fato_ausente:horario)/]
            ];
            for (const [rotulo, textoRuim, reMotivo] of reprovas) {
                const v = verificarComposicao(r.fatosDoTurno, textoRuim, { medicamentosDoUsuario: ['Creatina', 'Ômega 3', 'Dipirona'] });
                checks.push({ nome: `âncora reprova: ${rotulo}`, ok: v.ok === false && reMotivo.test(v.motivo || ''), detalhe: v.motivo || 'aprovou (errado)' });
            }

            // Limite documentado da heurística (§2.2): palavras numéricas ("duas")
            // não são checadas — só dígitos. O lado seguro escolhido é reprovar na
            // dúvida de DÍGITO; palavra numérica passa (registrado aqui de propósito).
            const comPalavraNumerica = bemComposto.replace('está registrada como tomada', 'está registrada como tomada (suas duas doses do dia em ordem)');
            checks.push({ nome: 'limite documentado: palavra numérica não reprova (só dígitos contam)', ok: verificarComposicao(r.fatosDoTurno, comPalavraNumerica, { medicamentosDoUsuario: ['Creatina', 'Ômega 3'] }).ok === true, detalhe: 'heurística é sobre dígitos' });

            // Estado do banco coerente com o caso-ouro (a execução é a real).
            const stC = (await doseLogs(ctx.db, creatina.id)).find(d => d.id === doseCreatina.id)?.status;
            const stO = (await doseLogs(ctx.db, omega.id)).find(d => d.id === doseOmega.id)?.status;
            checks.push({ nome: 'banco: Creatina corrigida para confirmada; Ômega 3 devolvido a nao_informado', ok: stC === 'confirmado' && stO === 'nao_informado', detalhe: `Creatina: ${stC}, Ômega 3: ${stO}` });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A66',
        marco: 'M4',
        titulo: 'v47 compositor §6.3–6.5 — escopo por construção: compositor só no turno com fatos; atalho e proativos isentos; message do principal nunca concatenada após fatos',
        async executar() {
            const checks = [];
            const fs = await import('node:fs');
            const path = await import('node:path');
            const url = await import('node:url');
            const raizSrc = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../src');
            const ler = (rel) => fs.readFileSync(path.join(raizSrc, rel), 'utf8');
            const router = ler('router.js');
            const linhasRouter = router.split('\n');

            // §6.3 — uma única chamada ao compositor, dentro do guard de fatos.
            const chamadas = linhasRouter.map((l, i) => ({ l, i })).filter(({ l }) => /comporComAncora\(/.test(l) && !/import/.test(l));
            checks.push({ nome: 'compositor chamado UMA vez no router', ok: chamadas.length === 1, detalhe: `${chamadas.length} chamada(s)` });
            const guardOk = chamadas.length === 1
                && linhasRouter.slice(Math.max(0, chamadas[0].i - 12), chamadas[0].i).join('\n').includes('if (resultadoDoses)');
            checks.push({ nome: 'chamada guardada por "if (resultadoDoses)" — turno sem fatos não compõe', ok: guardOk, detalhe: guardOk ? 'guard presente' : 'guard ausente na vizinhança' });

            // §6.4 — isenções por construção: atalho, proativas e o próprio dono
            // do canônico não conhecem o compositor.
            const isentos = ['scheduler.js', path.join('agentes', 'lembrete.js'), path.join('agentes', 'relatorios.js'), 'dosesDoTurno.js', 'agent.js', 'funil.js'];
            const violadores = isentos.filter(f => /comporComAncora|comporMensagemDoTurno|from '[^']*compositor\.js'/.test(ler(f)));
            checks.push({ nome: 'grep: atalho/proativos/canônico não importam o compositor', ok: violadores.length === 0, detalhe: violadores.join(', ') || 'limpo' });
            const atalhoLinhas = linhasRouter.map((l, i) => ({ l, i })).filter(({ l }) => /executarAtalho\(/.test(l) && !/import/.test(l));
            const atalhoLimpo = atalhoLinhas.every(({ i }) => !linhasRouter.slice(Math.max(0, i - 10), i + 10).join('\n').includes('comporComAncora'));
            checks.push({ nome: 'atalho exato responde pelo canônico direto (sem compositor na vizinhança)', ok: atalhoLinhas.length > 0 && atalhoLimpo, detalhe: `${atalhoLinhas.length} uso(s) de executarAtalho` });

            // §6.5 — a montagem antiga não sobrevive como segundo caminho: a
            // `message` do principal só é concatenada no ramo SEM fatos.
            const pushes = linhasRouter.map((l, i) => ({ l, i })).filter(({ l }) => /partes\.push\(decisao\.message\)/.test(l));
            checks.push({ nome: 'UM único ponto concatena decisao.message', ok: pushes.length === 1, detalhe: `${pushes.length} ponto(s)` });
            const noRamoSemFatos = pushes.length === 1
                && linhasRouter.slice(Math.max(0, pushes[0].i - 12), pushes[0].i).join('\n').includes('SEM fato de dose executado');
            checks.push({ nome: 'e ele vive no ramo "SEM fato de dose executado" (grep-guard §6.5)', ok: noRamoSemFatos, detalhe: noRamoSemFatos ? 'no ramo certo' : 'fora do ramo marcado' });

            // Fonte única do guia (§1): o compositor herda GUIA_COMPOSICAO +
            // seção de turno de templates/composicao.js — nenhum segundo guia.
            const compositor = ler('compositor.js');
            checks.push({
                nome: 'guia único: compositor importa GUIA_COMPOSICAO/GUIA_COMPOSICAO_TURNO de templates/composicao.js',
                ok: /GUIA_COMPOSICAO, GUIA_COMPOSICAO_TURNO.*templates\/composicao\.js/s.test(compositor) && !/COMPOSIÇÃO DA MENSAGEM — vale para toda mensagem/.test(compositor),
                detalhe: 'fonte única'
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    // v47 ONDA 2 (proativas por equivalência, MH-100 C) — 100% determinístico.
    // --------------------------------------------------------
    {
        id: 'A67',
        marco: 'M4',
        titulo: 'v47 Onda 2 §2 — equivalência estrita: cada builder movido reproduz byte a byte a fotografia de 30/09 pela rota do catálogo',
        async executar() {
            const checks = [];
            const { renderizarCanonico } = await import('../src/templates/catalogo.js');
            const { linhaQuantidadeDose } = await import('../src/templates/dose.js');

            // Fotografias capturadas ANTES da movimentação (30/09/2026, builders
            // originais de scheduler.js/agentes/lembrete.js com entradas fixas),
            // ATUALIZADAS em 30/09 para as 5 melhorias de copy aprovadas pelo
            // Guilherme (relatório da Onda 2, item 3) — estas fixtures congelam
            // o texto NOVO; qualquer mudança futura é decisão, nunca acidente.
            const remComp = { user_name: 'Fran Silva', med_nome: 'Puran T4', med_dosagem: '75mcg', quantidade_por_dose: 1, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido', horario: '06:30:00' };
            const remGota = { user_name: 'Ana', med_nome: 'Dramin', med_dosagem: null, quantidade_por_dose: 20, unidade_dose: 'gota', forma_farmaceutica: 'gotas', horario: '20:00:00' };
            const g2 = [
                { med_nome: 'Creatina', med_dosagem: null, quantidade_por_dose: 2, unidade_dose: 'unidade', forma_farmaceutica: 'capsula' },
                { med_nome: 'Ômega 3', med_dosagem: '1000mg', quantidade_por_dose: 1, unidade_dose: 'unidade', forma_farmaceutica: 'capsula' }
            ];
            const g3 = [...g2, { med_nome: 'Dramin', med_dosagem: '30ml', quantidade_por_dose: 20, unidade_dose: 'gota', forma_farmaceutica: 'gotas' }];
            const remF = { user_name: 'Fran Silva', med_nome: 'Puran T4', med_forma: 'comprimido' };
            const qF = linhaQuantidadeDose({ quantidade: 1, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' });
            const fg2 = [{ id: 'a', med_nome: 'Creatina', med_forma: 'capsula' }, { id: 'b', med_nome: 'Ômega 3', med_forma: 'capsula' }];
            const fg3 = [...fg2, { id: 'c', med_nome: 'Dramin', med_forma: 'gotas' }];
            const qtdParcial = new Map([
                ['a', linhaQuantidadeDose({ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: 'capsula' }, { indentacao: '  ' })],
                ['c', linhaQuantidadeDose({ quantidade: 20, unidade_dose: 'gota', forma_farmaceutica: 'gotas' }, { indentacao: '  ' })]
            ]);

            const fixtures = [
                ['lembrete individual (comprimido, com dosagem)', 'lembrete', { firstName: 'Fran', reminder: remComp },
                    '⏰ Olá, Fran!\n\nHora do seu *Puran T4* — 75mcg.\nQuantidade: 1 comprimido\n\nJá tomou? Responda *SIM* ou *NÃO* 💊'],
                ['lembrete individual (gotas, sem dosagem)', 'lembrete', { firstName: 'Ana', reminder: remGota },
                    '⏰ Olá, Ana!\n\nHora do seu *Dramin*.\nQuantidade: 20 gotas\n\nJá tomou? Responda *SIM* ou *NÃO* 💊'],
                ['lembrete agrupado (2 itens)', 'lembrete', { firstName: 'Gui', horario: '08:30', grupo: g2 },
                    '⏰ Gui, hora dos seus remédios das *08:30*! 💊\n\n• *Creatina*\n  Quantidade: 2 cápsulas\n• *Ômega 3* — 1000mg\n  Quantidade: 1 cápsula\n\n✅ Já tomou ou usou todos? Responda *SIM*\n💬 Tomou ou usou só alguns? Me diga quais (ex: "só Creatina")'],
                ['lembrete agrupado (3 itens, formas mistas)', 'lembrete', { firstName: 'Gui', horario: '08:30', grupo: g3 },
                    '⏰ Gui, hora dos seus remédios das *08:30*! 💊\n\n• *Creatina*\n  Quantidade: 2 cápsulas\n• *Ômega 3* — 1000mg\n  Quantidade: 1 cápsula\n• *Dramin* — 30ml\n  Quantidade: 20 gotas\n\n✅ Já tomou ou usou todos? Responda *SIM*\n💬 Tomou ou usou só alguns? Me diga quais (ex: "só Creatina")'],
                ['follow-up individual t2 (com quantidade)', 'follow_up', { tentativa: 2, reminder: remF, quantidade: qF },
                    '⏰ Fran, só passando para lembrar!\n\nAinda não vi sua confirmação do *Puran T4*.\nQuantidade: 1 comprimido\nJá tomou? Responda *SIM* ou *NÃO* 💊'],
                ['follow-up individual t3 (com quantidade)', 'follow_up', { tentativa: 3, reminder: remF, quantidade: qF },
                    '💊 Fran, último aviso de hoje!\n\nSeu *Puran T4* ainda está aguardando confirmação.\nQuantidade: 1 comprimido\nTomou? É só responder *SIM* ou *NÃO* 🌿'],
                ['follow-up individual t2 (sem nome, sem remédio, sem quantidade)', 'follow_up', { tentativa: 2, reminder: { user_name: null, med_nome: null, med_forma: 'gotas' }, quantidade: '' },
                    '⏰ você, só passando para lembrar!\n\nAinda não vi sua confirmação do seu remédio.\nJá tomou? Responda *SIM* ou *NÃO* 💊'],
                ['follow-up individual t3 (sem nome de remédio)', 'follow_up', { tentativa: 3, reminder: { user_name: null, med_nome: null, med_forma: 'comprimido' }, quantidade: '' },
                    '💊 você, último aviso de hoje!\n\nSeu remédio ainda está aguardando confirmação.\nTomou? É só responder *SIM* ou *NÃO* 🌿'],
                ['follow-up individual fallback (tentativa fora de 2/3)', 'follow_up', { tentativa: 4, reminder: remF, quantidade: qF },
                    '💊 Fran, lembrete do *Puran T4*.\nQuantidade: 1 comprimido\nJá tomou? Responda *SIM* ou *NÃO*'],
                ['follow-up agrupado t2 (2 itens, sem quantidade)', 'follow_up', { tentativa: 2, firstName: 'Gui', horario: '08:30', grupo: fg2, quantidadePorItem: new Map() },
                    '⏰ Gui, só passando para lembrar!\n\nAinda não vi sua confirmação dos remédios das *08:30*:\n• *Creatina*\n• *Ômega 3*\n\n✅ Já tomou ou usou todos? Responda *SIM*\n💬 Tomou ou usou só alguns? Me diga quais 🌿'],
                ['follow-up agrupado t3 (3 itens, quantidade parcial)', 'follow_up', { tentativa: 3, firstName: 'Gui', horario: '08:30', grupo: fg3, quantidadePorItem: qtdParcial },
                    '💊 Gui, último aviso de hoje!\n\nAinda não vi sua confirmação dos remédios das *08:30*:\n• *Creatina*\n  Quantidade: 2 cápsulas\n• *Ômega 3*\n• *Dramin*\n  Quantidade: 20 gotas\n\n✅ Já tomou ou usou todos? Responda *SIM*\n💬 Tomou ou usou só alguns? Me diga quais 🌿'],
                ['alerta de estoque zerado', 'alerta_estoque_zerado', { firstName: 'Eloísa', reminder: { med_nome: 'Desogestrel' } },
                    '⏰ Eloísa, está na hora do seu *Desogestrel*!\n\nPelas minhas contas o estoque acabou — mas se você ainda tem e já tomou, é só responder SIM que eu registro. 💊\n\nSe comprou mais, me conta quantos: *"Comprei 30 comprimidos de Desogestrel"*'],
                ['conclusão de tratamento (1 dia)', 'conclusao_tratamento', { firstName: 'Isaque', med: { nome: 'Amoxicilina', tratamento_dias: 1 } },
                    '🎉 Isaque, o tratamento com *Amoxicilina* chegou ao fim — 1 dia completinho!\n\nJá desliguei os lembretes dele pra você.\n\nSe o médico estender o tratamento, é só me pedir pra cadastrar de novo. 🌿'],
                ['conclusão de tratamento (7 dias)', 'conclusao_tratamento', { firstName: 'Isaque', med: { nome: 'Amoxicilina', tratamento_dias: 7 } },
                    '🎉 Isaque, o tratamento com *Amoxicilina* chegou ao fim — 7 dias completinhos!\n\nJá desliguei os lembretes dele pra você.\n\nSe o médico estender o tratamento, é só me pedir pra cadastrar de novo. 🌿'],
                ['conclusão de tratamento (sem duração)', 'conclusao_tratamento', { firstName: 'Isaque', med: { nome: 'Amoxicilina', tratamento_dias: null } },
                    '🎉 Isaque, o tratamento com *Amoxicilina* chegou ao fim!\n\nJá desliguei os lembretes dele pra você.\n\nSe o médico estender o tratamento, é só me pedir pra cadastrar de novo. 🌿'],
                ['aviso ao cuidador (follow-up esgotado)', 'cuidador_follow_up_esgotado', { nomePaciente: 'Fran Silva', remedio: 'Puran T4', horario: '06:30' },
                    '⚠️ Atenção!\n\n*Fran Silva* não confirmou a dose do *Puran T4* que estava agendada para 06:30.\n\nAs tentativas de hoje se esgotaram sem resposta.'],
                ['cobrança encerrada (ramo estoque desconhecido) — mesma fotografia do A63', 'cobranca_encerrada', { firstName: 'Guilherme', estoqueInfo: { medNome: 'Creatina', medForma: 'comprimido', estoqueDesconhecido: true } },
                    '⚠️ Guilherme, não recebi confirmação da sua dose do *Creatina*.\n\nQuando puder, me avise se tomou! 💊'],
                ['mensagem direcionada (pass-through — o catálogo não redige)', 'mensagem_direcionada', { texto: 'Oi! Texto pronto do Guilherme 🌿' },
                    'Oi! Texto pronto do Guilherme 🌿']
            ];
            for (const [rotulo, tipo, fato, esperado] of fixtures) {
                const saida = renderizarCanonico(tipo, fato);
                checks.push({ nome: `byte-idêntico: ${rotulo}`, ok: saida === esperado, detalhe: saida === esperado ? 'igual' : `diferente — atual: ${JSON.stringify(saida)}` });
            }

            // Resumo semanal/mensal: os blocos usam sorteio — a equivalência da
            // MONTAGEM é provada com Math.random controlado: primitivas na ordem
            // atual vs montarResumoAdesao, mesma sequência → mesmo byte.
            const adesao = await import('../src/templates/adesaoTemplates.js');
            const sequencia = [0.11, 0.37, 0.53, 0.71, 0.89, 0.23, 0.47, 0.61, 0.79, 0.97, 0.05, 0.31];
            const comRandomControlado = (fn) => {
                const original = Math.random;
                let i = 0;
                Math.random = () => sequencia[i++ % sequencia.length];
                try { return fn(); } finally { Math.random = original; }
            };
            const cenarios = [
                ['semanal simples', { nome: 'Fran', taxa: 85, faixa: '80_99', semana: 2, isMensal: false },
                    () => adesao.montarMensagemSemanal({ nome: 'Fran', taxa: 85, faixa: '80_99', semana: 2 })],
                ['semanal + motivo + tendência (subiu) + marco', { nome: 'Fran', taxa: 100, faixa: '100', semana: 1, isMensal: false, motivoDominante: 'nao_tomado', tendencia: { tipo: 'subiu', taxaAnterior: 80, taxaAtual: 100 }, marco: true },
                    () => adesao.montarMensagemSemanal({ nome: 'Fran', taxa: 100, faixa: '100', semana: 1 })
                        + `\n\n${adesao.montarBlocoMotivo('nao_tomado')}`
                        + `\n\n${adesao.montarBlocoTendencia('subiu', { taxaAnterior: 80, taxaAtual: 100 })}`
                        + `\n\n${adesao.montarBlocoMarco()}`],
                ['mensal + motivo + diagnóstico por turno', { nome: 'Gui', taxa: 60, faixa: '50_79', semana: 3, isMensal: true, motivoDominante: 'nao_informado', turnoDiagnostico: 'manha' },
                    () => adesao.montarMensagemMensal({ nome: 'Gui', taxa: 60, faixa: '50_79' })
                        + `\n\n${adesao.montarBlocoMotivo('nao_informado')}`
                        + `\n\n${adesao.montarBlocoTurno('manha')}`],
                ['mensal + motivo sem_estoque (sem turno) + tendência (caiu)', { nome: 'Gui', taxa: 40, faixa: 'abaixo_50', semana: 1, isMensal: true, motivoDominante: 'sem_estoque', tendencia: { tipo: 'caiu', taxaAnterior: 70, taxaAtual: 40 } },
                    () => adesao.montarMensagemMensal({ nome: 'Gui', taxa: 40, faixa: 'abaixo_50' })
                        + `\n\n${adesao.montarBlocoMotivo('sem_estoque')}`
                        + `\n\n${adesao.montarBlocoTendencia('caiu', { taxaAnterior: 70, taxaAtual: 40 })}`],
                ['semanal + tendência estável, sem motivo', { nome: 'Ana', taxa: 90, faixa: '80_99', semana: 4, isMensal: false, tendencia: { tipo: 'estavel', taxaAnterior: 88, taxaAtual: 90 } },
                    () => adesao.montarMensagemSemanal({ nome: 'Ana', taxa: 90, faixa: '80_99', semana: 4 })
                        + `\n\n${adesao.montarBlocoTendencia('estavel', { taxaAnterior: 88, taxaAtual: 90 })}`]
            ];
            for (const [rotulo, fato, montarEsperado] of cenarios) {
                const esperado = comRandomControlado(montarEsperado);
                const saida = comRandomControlado(() => renderizarCanonico('resumo_semanal', fato));
                checks.push({ nome: `resumo (montagem) byte-idêntico: ${rotulo}`, ok: saida === esperado, detalhe: saida === esperado ? 'igual' : `esperado: ${JSON.stringify(esperado)} — atual: ${JSON.stringify(saida)}` });
            }
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A68',
        marco: 'M4',
        titulo: 'v47 Onda 2 §3 — grep-guards: nenhum texto proativo fora de templates/; lookup canônico só pelo catálogo',
        async executar() {
            const checks = [];
            const fs = await import('node:fs');
            const path = await import('node:path');
            const url = await import('node:url');
            const raizSrc = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../src');
            const ler = (rel) => fs.readFileSync(path.join(raizSrc, rel), 'utf8');

            // §3.1 — nenhum template literal de mensagem ao usuário nas casas de
            // orquestração: fora de comentário e de console.*, nenhuma string com
            // emoji de mensagem sobrevive em scheduler/lembrete (e no caminho
            // proativo de relatorios — o resumo semanal).
            const EMOJI_MENSAGEM = /[⏰💊✅⚠️📦🎉🔔🌿😊❌📣🚨]/u;
            const codigoSemLogsEComentarios = (c) => c.split('\n')
                .filter(l => !/^\s*\/\//.test(l) && !/console\.(log|error|warn)/.test(l) && !/^\s*\*/.test(l))
                .join('\n');
            for (const arquivo of ['scheduler.js', path.join('agentes', 'lembrete.js')]) {
                const resto = codigoSemLogsEComentarios(ler(arquivo));
                const m = resto.match(EMOJI_MENSAGEM);
                checks.push({ nome: `grep (§3.1): nenhum texto de mensagem em ${arquivo}`, ok: !m, detalhe: m ? `emoji "${m[0]}" fora de log/comentário` : 'limpo' });
            }
            const relatorios = ler(path.join('agentes', 'relatorios.js'));
            const idxResumo = relatorios.indexOf('async function enviarResumoSemanal');
            const corpoResumo = idxResumo >= 0 ? relatorios.slice(idxResumo) : '';
            const mResumo = codigoSemLogsEComentarios(corpoResumo).match(EMOJI_MENSAGEM);
            checks.push({ nome: 'grep (§3.1): caminho proativo de relatorios (enviarResumoSemanal) sem texto de mensagem', ok: idxResumo >= 0 && !mResumo, detalhe: mResumo ? `emoji "${mResumo[0]}"` : 'limpo' });
            const montadoresDeResumo = /montarMensagemSemanal|montarMensagemMensal|montarBlocoMotivo|montarBlocoTurno|montarBlocoTendencia|montarBlocoMarco|montarResumoAdesao/;
            checks.push({ nome: 'grep (§3.1): relatorios não monta o resumo peça a peça (só o fato + catálogo)', ok: !montadoresDeResumo.test(relatorios), detalhe: 'montagem no catálogo' });

            // §3.2 — o lookup fato → texto acontece só via templates/catalogo.js:
            // fora de templates/, nenhum módulo referencia os renderizadores
            // canônicos diretamente (atalho, âncora e proativas inclusos).
            const RENDERIZADORES = /buildReminderMessage|buildGroupedReminderMessage|buildFollowUpMessage|buildGroupedFollowUpMessage|buildEstoqueZeradoMessage|buildConclusaoTratamentoMessage|buildCuidadorFollowUpEsgotado|buildCobrancaEncerrada|buildConviteEstoqueNaoCadastrado|buildConviteEstoqueContestado|buildAlertaEstoquePosConfirmacao|buildAlertaEstoquePosAjuste|buildEstoqueAtualizadoMessage|textoDeConfirmacao|linhaNaoTomada|linhaDosesRevertidas|montarResumoAdesao/;
            const arquivos = [];
            (function varrer(dir) {
                for (const nome of fs.readdirSync(dir)) {
                    const p = path.join(dir, nome);
                    if (fs.statSync(p).isDirectory()) { if (path.basename(p) !== 'templates') varrer(p); }
                    else if (p.endsWith('.js') && !p.includes(`${path.sep}templates${path.sep}`)) arquivos.push(p);
                }
            })(raizSrc);
            const violadores = arquivos
                .filter(p => RENDERIZADORES.test(fs.readFileSync(p, 'utf8')))
                .map(p => path.relative(raizSrc, p));
            checks.push({ nome: 'grep (§3.2): nenhuma renderização canônica fora do catálogo (src/ fora de templates/)', ok: violadores.length === 0, detalhe: violadores.join(', ') || 'limpo' });

            // O catálogo cobre todas as entradas da onda (§1).
            const { FATOS_CATALOGADOS } = await import('../src/templates/catalogo.js');
            const exigidos = ['lembrete', 'follow_up', 'cobranca_encerrada', 'alerta_estoque_zerado', 'conclusao_tratamento',
                'resumo_semanal', 'mensagem_direcionada', 'cuidador_follow_up_esgotado',
                'dose_confirmada', 'dose_nao_tomada', 'dose_revertida', 'estoque_atualizado', 'alerta_estoque', 'convite_estoque'];
            const faltando = exigidos.filter(t => !FATOS_CATALOGADOS.includes(t));
            checks.push({ nome: 'catálogo cobre as entradas do §1 (proativas + fatos do turno da Onda 1)', ok: faltando.length === 0, detalhe: faltando.join(', ') || `${FATOS_CATALOGADOS.length} entradas` });
            return checks;
        }
    },

    // --------------------------------------------------------
    // v47 ONDA 3 (jornada catalogada, MH-100 D) — fecho da Etapa 1.
    // --------------------------------------------------------
    {
        id: 'A69',
        marco: 'M4',
        titulo: 'v47 Onda 3 — guard de cobertura total (casas fechadas de texto), índice da jornada, assunto da jornada e fixtures dos textos de sistema movidos',
        async executar({ ctx, seeds }) {
            const checks = [];
            const fs = await import('node:fs');
            const path = await import('node:path');
            const url = await import('node:url');
            const raizSrc = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../src');

            // ---- §3: LISTA FECHADA de casas autorizadas a conter texto de
            // mensagem ao usuário. Casa nova de texto = regressão vermelha.
            // LIMITES DA HEURÍSTICA (documentados de propósito): detecta emoji
            // de mensagem em linha de código (fora de comentário // ou * e de
            // linhas com console.*); fragmentos sem emoji (ex.: aberturas
            // "Boa", "Perfeito") ficam fora dela — o A31/A47 os cobrem.
            const CASAS_DE_MENSAGEM = new Set([
                'inventario.js',        // textos de sistema (ainda não / nunca / recusa / erro)
                'dataNascimento.js',    // diálogo do nascimento (parsing + textos)
                'router.js',            // reperguntaSegura + retomadas de coleta (§1.3: aponta, não move)
                'runner.js',            // conectivos do motor de coleta
                path.join('agentes', 'exclusaoConta.js'),
                path.join('agentes', 'relatorios.js'),   // relatórios reativos — casa própria
                path.join('agentes', 'configuracao.js')  // DÍVIDA ETAPA 3: fora do catálogo até runner+schema
            ]);
            const EXCECOES_NAO_MENSAGEM = {
                'prompts.js': 'prompt de sistema (instrução ao LLM, não mensagem pronta)',
                'index.js': 'banner de terminal (console multilinha)',
                'juizOffline.js': 'títulos de observabilidade (system_events)',
                'dosesDoTurno.js': 'regex de detecção da abertura de confirmação'
            };
            const EMOJI_MENSAGEM = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|⏰|✅|⚠️/u;
            const arquivos = [];
            (function varrer(dir) {
                for (const nome of fs.readdirSync(dir)) {
                    const p = path.join(dir, nome);
                    if (fs.statSync(p).isDirectory()) varrer(p);
                    else if (p.endsWith('.js')) arquivos.push(p);
                }
            })(raizSrc);
            const violacoes = [];
            for (const p of arquivos) {
                const rel = path.relative(raizSrc, p);
                if (rel.startsWith(`templates${path.sep}`) || rel.startsWith(`schemas${path.sep}`)) continue;
                if (CASAS_DE_MENSAGEM.has(rel) || EXCECOES_NAO_MENSAGEM[rel]) continue;
                fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
                    if (/^\s*\/\//.test(l) || /^\s*\*/.test(l) || /console\.(log|error|warn)/.test(l)) return;
                    if (EMOJI_MENSAGEM.test(l)) violacoes.push(`${rel}:${i + 1}`);
                });
            }
            checks.push({ nome: 'guard §3: nenhuma casa NOVA de texto de mensagem fora da lista fechada (dívida da Etapa 3: agentes/configuracao.js)', ok: violacoes.length === 0, detalhe: violacoes.join(' | ') || 'limpo' });

            // ---- §1: o índice da jornada cobre as entradas do briefing e as
            // entradas "canonico" existem de fato no catálogo.
            const { INDICE_DA_JORNADA, FATOS_CATALOGADOS, renderizarCanonico } = await import('../src/templates/catalogo.js');
            const exigidos = ['pergunta_coleta', 'pergunta_onboarding', 'pergunta_nascimento', 'boas_vindas',
                'dialogo_exclusao', 'nao_suportado', 'nunca', 'recusa_audio', 'erro_global', 'degradado', 'configuracao'];
            const semIndice = exigidos.filter(t => !INDICE_DA_JORNADA[t]);
            checks.push({ nome: 'índice da jornada cobre as entradas do §1.2 (+ dívida da configuração explícita)', ok: semIndice.length === 0 && INDICE_DA_JORNADA.configuracao?.entrada === 'DIVIDA_ETAPA_3', detalhe: semIndice.join(', ') || `${Object.keys(INDICE_DA_JORNADA).length} entradas` });
            const canonicosSemFn = Object.entries(INDICE_DA_JORNADA)
                .filter(([, v]) => v.entrada === 'canonico').map(([k]) => k)
                .filter(k => !FATOS_CATALOGADOS.includes(k));
            checks.push({ nome: 'toda entrada "canonico" do índice existe no catálogo', ok: canonicosSemFn.length === 0, detalhe: canonicosSemFn.join(', ') || 'todas' });
            checks.push({ nome: 'boas_vindas marcada como redação-LLM (sem canônico fixo)', ok: /redação-LLM/.test(INDICE_DA_JORNADA.boas_vindas?.nota || ''), detalhe: INDICE_DA_JORNADA.boas_vindas?.nota });

            // ---- §1.3/§4: fixtures dos textos de sistema movidos de agent.js
            // (fotografia = a composição literal que agent.js fazia em 30/09).
            const { respostaRecusaAudio, respostaErroTecnico, respostaHonestaAindaNao } = await import('../src/inventario.js');
            const recusaEsperada = `${respostaHonestaAindaNao('audio')}\n\nPode me escrever o que você disse?`;
            checks.push({ nome: 'byte-idêntico: recusa de áudio (ex-agent.js)', ok: respostaRecusaAudio() === recusaEsperada && renderizarCanonico('recusa_audio', {}) === recusaEsperada, detalhe: JSON.stringify(respostaRecusaAudio()) });
            const erroEsperado = 'Desculpe, tive um probleminha aqui. Pode repetir o que você disse? 🌿';
            checks.push({ nome: 'byte-idêntico: fallback do catch global (ex-agent.js)', ok: respostaErroTecnico() === erroEsperado && renderizarCanonico('erro_global', {}) === erroEsperado, detalhe: JSON.stringify(respostaErroTecnico()) });

            // ---- §1.3: reperguntaSegura fica no router e chega ao catálogo por
            // registro tardio (importar o router dispara o registro).
            const { derivarAssuntoDaJornada } = await import('../src/router.js');
            const degradadoComNome = renderizarCanonico('degradado', { user: { name: 'Fran Silva' } });
            const degradadoSemNome = renderizarCanonico('degradado', { user: null });
            checks.push({
                nome: 'entrada "degradado" rende a reperguntaSegura do router (com e sem nome)',
                ok: degradadoComNome === 'Fran, desculpa, não consegui te entender direito. 🌿\n\nPode me dizer de outro jeito o que você precisa?'
                    && degradadoSemNome === 'Desculpa, não consegui te entender direito. 🌿\n\nPode me dizer de outro jeito o que você precisa?',
                detalhe: JSON.stringify(degradadoComNome)
            });

            // ---- §2: derivação do assunto da jornada (pura) — agente + estado
            // pós-turno; configuração fica fora de propósito (§1.4).
            const cenarios = [
                ['onboarding em curso (nascimento)', { agente: 'onboarding', estadoPos: { state: 'onboarding', context: { etapa: 'onb_nascimento' } } }, { fato: 'pergunta_nascimento' }],
                ['onboarding em curso (outra etapa)', { agente: 'onboarding', estadoPos: { state: 'onboarding', context: { etapa: 'onb_lgpd' } } }, { fato: 'pergunta_onboarding', detalhe: 'onb_lgpd' }],
                ['onboarding encerrou o turno', { agente: 'onboarding', estadoPos: { state: 'post_onboarding', context: {} } }, { fato: 'boas_vindas' }],
                ['coleta do cadastro aberta', { agente: 'cadastro', estadoPos: { state: 'adding_med', context: { etapa: 'cad_posologia', medication_id: 'm1' } } }, { fato: 'pergunta_coleta', detalhe: 'cad_posologia', medicationId: 'm1' }],
                ['cadastro concluído (sem pergunta aberta)', { agente: 'cadastro', estadoPos: { state: 'idle', context: {} } }, null],
                ['exclusão de conta', { agente: 'exclusao_conta', estadoPos: { state: 'aguardando_confirmacao_exclusao', context: {} } }, { fato: 'dialogo_exclusao' }],
                ['degradado', { agente: 'principal_degradado', estadoPos: { state: 'idle', context: {} } }, { fato: 'degradado' }],
                ['ainda não (com chave)', { agente: 'principal', estadoPos: { state: 'idle', context: {} }, naoSuportado: { chave: 'audio' } }, { fato: 'nao_suportado', detalhe: 'audio' }],
                ['configuração fica fora (dívida Etapa 3)', { agente: 'configuracao', estadoPos: { state: 'configurando', context: { etapa: 'identif_intencao' } } }, null],
                ['atalho exato não é jornada', { agente: 'atalho_dose_exato', estadoPos: { state: 'idle', context: {} } }, null]
            ];
            const divergentes = cenarios.filter(([, entrada, esperado]) =>
                JSON.stringify(derivarAssuntoDaJornada(entrada) ?? null) !== JSON.stringify(esperado ?? null))
                .map(([rotulo, entrada]) => `${rotulo}: ${JSON.stringify(derivarAssuntoDaJornada(entrada))}`);
            checks.push({ nome: `assunto da jornada: ${cenarios.length} cenários mapeados (onboarding/nascimento/boas-vindas/coleta/exclusão/degradado/ainda-não; configuração e atalho fora)`, ok: divergentes.length === 0, detalhe: divergentes.join(' | ') || 'todos conforme' });

            // ---- §2: round-trip no banco — o detalhe do assunto persiste.
            const { registrarAssuntosDoEnvio, getAssuntoDoEnvio } = await import('../src/database.js');
            const user = await seeds.criarUsuario({ nome: 'Fran', onboarded: true, estado: 'adding_med' });
            const { med } = await seeds.criarMedicamento({ userId: user.id, nome: 'Puran T4', estoque: null, horarios: ['06:30'] });
            const { envio } = await seeds.criarEnvioFunil({ user, minutosAtras: 3, origem: 'agente:cadastro', texto: 'Quantos comprimidos de Puran T4 você tem em casa?' });
            await registrarAssuntosDoEnvio(envio.id, [{ fato: 'pergunta_coleta', detalhe: 'cad_estoque', medicationId: med.id }]);
            const assunto = await getAssuntoDoEnvio(envio.id);
            checks.push({
                nome: 'assunto da jornada persistido e resolvível pela mecânica da Onda 0 (citação dias depois)',
                ok: assunto?.assuntos?.length === 1 && assunto.assuntos[0].fato === 'pergunta_coleta'
                    && assunto.assuntos[0].detalhe === 'cad_estoque' && assunto.assuntos[0].medication_id === med.id
                    && assunto.doses.length === 0,
                detalhe: JSON.stringify(assunto?.assuntos)
            });
            return checks;
        }
    },

    // --------------------------------------------------------
    {
        id: 'A70',
        marco: 'M4',
        titulo: 'v47 ajustes pós-validação Etapa 1 (30/09) — recorrência por extenso no relatório; instrução de estoque neutralizado sem "sistema" e apontando a delegação',
        async executar() {
            const checks = [];
            const fs = await import('node:fs');
            const path = await import('node:path');
            const url = await import('node:url');
            const raizSrc = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../src');
            const ler = (rel) => fs.readFileSync(path.join(raizSrc, rel), 'utf8');

            // Copy: recorrência não-diária por extenso (caso Farmix, "(ter)" tímido).
            const { rotuloDiasPorExtenso } = await import('../src/validadores/recorrencia.js');
            const cenarios = [
                [['ter'], 'toda terça'],
                [['sab'], 'todo sábado'],
                [['ter', 'qui'], 'toda terça e toda quinta'],
                [['seg', 'ter', 'qua', 'qui', 'sex'], 'de segunda a sexta'],
                [['sab', 'dom'], 'todo sábado e todo domingo'],
                [[], null],
                [['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'], null]
            ];
            const errados = cenarios.filter(([dias, esperado]) => rotuloDiasPorExtenso(dias) !== esperado)
                .map(([dias]) => `${JSON.stringify(dias)} → ${JSON.stringify(rotuloDiasPorExtenso(dias))}`);
            checks.push({ nome: `rotuloDiasPorExtenso: ${cenarios.length} cenários (dia único, gênero, lista, faixa, diário=null)`, ok: errados.length === 0, detalhe: errados.join(' | ') || 'todos conforme' });

            const relatorios = ler(path.join('agentes', 'relatorios.js'));
            checks.push({ nome: 'relatório de remédios usa o rótulo POR EXTENSO (sigla "(ter)" morta no relatório)', ok: /rotuloDiasPorExtenso/.test(relatorios) && !/[^o]rotuloDias\(/.test(relatorios), detalhe: 'listagem + visão do medicamento' });

            // Caso Rivotril: a instrução de neutralização não fala em "sistema" e
            // manda a ação certa (REGRA ABSOLUTA: não existe outra entidade).
            const violadoresSistema = [];
            (function varrer(dir) {
                for (const nome of fs.readdirSync(dir)) {
                    const p = path.join(dir, nome);
                    if (fs.statSync(p).isDirectory()) varrer(p);
                    else if (p.endsWith('.js') && /comunicado pelo sistema/.test(fs.readFileSync(p, 'utf8'))) violadoresSistema.push(path.relative(raizSrc, p));
                }
            })(raizSrc);
            checks.push({ nome: 'grep: "comunicado pelo sistema" morto em src/', ok: violadoresSistema.length === 0, detalhe: violadoresSistema.join(', ') || 'limpo' });
            const principal = ler(path.join('agentes', 'principal.js'));
            checks.push({
                nome: 'estoque neutralizado (dose em aberto) instrui: pedido de estoque → delegar relatorios/estoque',
                ok: /não cite um número de memória[\s\S]{0,80}delegue a relatorios com subtipo "estoque"/.test(principal),
                detalhe: 'instrução acionável no contexto'
            });
            return checks;
        }
    }
];
