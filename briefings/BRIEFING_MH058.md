# BRIEFING — MH-58: Telemetria de execução diária do Juiz Offline

**Sessão:** v25 (29/07/2026)
**Origem:** conversa de planejamento — Guilherme notou que o Juiz Offline (MH-054, v24) só deixa
rastro no banco quando encontra um desvio. Um dia sem desvios (esperado, na maioria dos dias) é
hoje indistinguível de "o cron nunca rodou". Precisamos de prova de vida independente de haver
achado algo ou não.

**Escopo desta implementação:** só a tabela de telemetria + instrumentação de
`executarJuizOffline`. NÃO inclui o dashboard (MH-9, já mapeado separadamente) nem o monitor
externo de "silêncio total" (cenário decidido nesta sessão: uma query manual/futura no dashboard
verificando se existe linha para o dia anterior — sem mudança de código agora).

---

## 1. Migration — nova tabela `juiz_offline_execucoes`

Criar arquivo `supabase/migrations/20260729000000_juiz_offline_execucoes.sql`:

```sql
-- MH-58: telemetria de execução do Juiz Offline (prova de vida diária, independente de desvio encontrado)
CREATE TABLE juiz_offline_execucoes (
    id BIGSERIAL PRIMARY KEY,
    data_avaliada DATE NOT NULL,               -- dia sendo avaliado (janela UTC do dia anterior), NÃO a data de execução
    turnos_totais INTEGER,                     -- total de agent_logs na janela; NULL se quebrou antes de coletar
    episodios_totais INTEGER,                  -- total de episódios formados; NULL se quebrou antes de coletar
    episodios_pulados_idempotencia INTEGER NOT NULL DEFAULT 0, -- já julgados com desvio em execução anterior (ver seção 4)
    episodios_avaliados INTEGER NOT NULL DEFAULT 0,            -- enviados ao LLM E com veredito interpretável (parse ok)
    episodios_falha_julgamento INTEGER NOT NULL DEFAULT 0,     -- enviados ao LLM, retorno não interpretável (JSON/categoria inválida)
    turnos_avaliados INTEGER NOT NULL DEFAULT 0,               -- soma de turnos só dos episódios em episodios_avaliados
    eventos_registrados INTEGER NOT NULL DEFAULT 0,            -- quantos system_events (desvios) esta execução gerou
    status TEXT NOT NULL CHECK (status IN ('sucesso', 'falha_parcial', 'falha_total')),
    erro_resumo TEXT,                          -- resumo curto do erro quando status <> 'sucesso'; detalhe completo já mora em system_events
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()  -- quando esta linha foi de fato gravada (= quando a execução rodou)
);

CREATE INDEX idx_juiz_offline_execucoes_data ON juiz_offline_execucoes (data_avaliada);
```

**Nota:** tabela append-only, mesmo padrão de `system_events`/`feedbacks` — nunca UPDATE. Se o
mesmo `data_avaliada` for reprocessado manualmente, gera uma segunda linha (histórico preservado,
não sobrescreve).

⚠️ Lembrete operacional: esta migration precisa ser aplicada **manualmente** no SQL Editor do
Supabase antes do deploy do código abaixo (padrão do projeto — migrations não são automáticas).

---

## 2. Nova função em `src/observabilidade.js`

Adicionar ao final do arquivo, seguindo o mesmo padrão defensivo de `registrarEvento`/
`registrarFeedback` (nunca lança exceção):

```javascript
// status: 'sucesso' | 'falha_parcial' | 'falha_total'
// Ponto ÚNICO de escrita em juiz_offline_execucoes (MH-58) — nunca insert direto em outro lugar.
export async function registrarExecucaoJuizOffline({
    dataAvaliada, turnosTotais = null, episodiosTotais = null,
    episodiosPuladosIdempotencia = 0, episodiosAvaliados = 0,
    episodiosFalhaJulgamento = 0, turnosAvaliados = 0, eventosRegistrados = 0,
    status, erroResumo = null
}) {
    try {
        const { error } = await supabase.from('juiz_offline_execucoes').insert({
            data_avaliada: dataAvaliada,
            turnos_totais: turnosTotais,
            episodios_totais: episodiosTotais,
            episodios_pulados_idempotencia: episodiosPuladosIdempotencia,
            episodios_avaliados: episodiosAvaliados,
            episodios_falha_julgamento: episodiosFalhaJulgamento,
            turnos_avaliados: turnosAvaliados,
            eventos_registrados: eventosRegistrados,
            status,
            erro_resumo: erroResumo
        });
        if (error) console.error(`[observabilidade] Falha ao registrar execução do juiz offline: ${error.message}`);
    } catch (e) {
        console.error(`[observabilidade] Exceção ao registrar execução do juiz offline: ${e.message}`);
    }
}
```

E atualizar o import em `src/juizOffline.js`:

```javascript
import { registrarEvento, registrarExecucaoJuizOffline } from './observabilidade.js';
```

---

## 3. Instrumentação de `executarJuizOffline` em `src/juizOffline.js`

Esta é a única função que muda. **Substituir a função inteira** pela versão abaixo — ela
preserva 100% do comportamento atual (mesma lógica de coleta/enriquecimento/julgamento/registro
de desvio) e só adiciona os contadores e a chamada final de telemetria.

Pontos de atenção na leitura do código abaixo:
- Os contadores são incrementados **dentro do loop, a cada iteração** — nunca calculados só no
  fim — porque se uma exceção interromper o loop no meio, o catch precisa saber exatamente até
  onde chegamos (é isso que diferencia `falha_parcial` de `sucesso`).
- `turnosTotais`/`episodiosTotais` só recebem valor DEPOIS que `coletarEpisodios` retorna com
  sucesso. Se a exceção acontecer antes disso (ex: falha de conexão no `coletarEpisodios`), eles
  permanecem `null` — é o sinal de `falha_total`.
- `status` é decidido assim: loop termina sem exceção → `sucesso`. Exceção no meio do loop (já
  temos `episodiosTotais`) → `falha_parcial`. Exceção antes de coletar (`episodiosTotais` ainda
  `null`) → `falha_total`.

```javascript
export async function executarJuizOffline() {
    const { dataInicio, dataFim } = getJanelaDiaAnterior();
    const dataAvaliada = dataInicio.slice(0, 10); // YYYY-MM-DD, para a coluna data_avaliada

    let turnosTotais = null;
    let episodiosTotais = null;
    let episodiosPuladosIdempotencia = 0;
    let episodiosAvaliados = 0;
    let episodiosFalhaJulgamento = 0;
    let turnosAvaliados = 0;
    let eventosRegistrados = 0;

    try {
        console.log(`⚖️ Juiz offline — janela ${dataInicio} a ${dataFim}`);

        const episodios = await coletarEpisodios({ dataInicio, dataFim });
        episodiosTotais = episodios.length;
        turnosTotais = episodios.reduce((soma, ep) => soma + ep.turnos.length, 0);
        console.log(`⚖️ ${episodios.length} episódio(s) coletado(s)`);

        for (const episodio of episodios) {
            if (await episodioJaProcessado(episodio.primeiroLogId)) {
                episodiosPuladosIdempotencia++;
                continue;
            }

            const enriquecido = await enriquecerEpisodio(episodio);
            const julgamento = await julgarEpisodio(enriquecido);
            await sleep(PAUSA_ENTRE_JULGAMENTOS_MS);

            if (julgamento === null) {
                episodiosFalhaJulgamento++;
                continue;
            }

            episodiosAvaliados++;
            turnosAvaliados += episodio.turnos.length;

            if (!julgamento.desvio) continue;

            console.log(
                `⚖️ Desvio — categoria: ${julgamento.categoria} — ` +
                `titulo LLM: ${julgamento.tituloDescritivo} — evidencia: ${julgamento.evidencia}`
            );

            // payload guarda APENAS dados estruturais — titulo_descritivo/evidencia nunca são
            // persistidos (invariante de LGPD da v22, ver briefing v24 seção 6).
            await registrarEvento({
                tipo: 'desvio_comportamental',
                severidade: TAXONOMIA[julgamento.categoria].severidade,
                userId: episodio.userId,
                agent: episodio.agentePredominante,
                origem: 'juiz_offline',
                agentLogId: episodio.primeiroLogId,
                titulo: TAXONOMIA[julgamento.categoria].titulo,
                payload: {
                    categoria: julgamento.categoria,
                    n_turnos: episodio.turnos.length,
                    agent_log_ids: episodio.turnos.map(t => t.id)
                }
            });
            eventosRegistrados++;
        }

        await registrarExecucaoJuizOffline({
            dataAvaliada, turnosTotais, episodiosTotais,
            episodiosPuladosIdempotencia, episodiosAvaliados,
            episodiosFalhaJulgamento, turnosAvaliados, eventosRegistrados,
            status: 'sucesso'
        });
    } catch (error) {
        console.error('❌ Erro no juiz offline:', error.message);

        await registrarEvento({
            tipo: 'erro_tecnico',
            severidade: 'alta',
            origem: 'scheduler',
            agent: 'juiz_offline',
            titulo: `Erro no juiz offline: ${error.message?.split('\n')[0] ?? ''}`.slice(0, 200),
            payload: { message: error.message, stack: error.stack, funcao: 'executarJuizOffline' }
        });

        await registrarExecucaoJuizOffline({
            dataAvaliada, turnosTotais, episodiosTotais,
            episodiosPuladosIdempotencia, episodiosAvaliados,
            episodiosFalhaJulgamento, turnosAvaliados, eventosRegistrados,
            status: episodiosTotais === null ? 'falha_total' : 'falha_parcial',
            erroResumo: error.message?.split('\n')[0]?.slice(0, 200) ?? null
        });
    }
}
```

**Nada mais muda** — `coletarEpisodios`, `enriquecerEpisodio`, `julgarEpisodio`,
`parseJulgamento`, `episodioJaProcessado`, `getJanelaDiaAnterior`, `sleep`, `TAXONOMIA`,
`PROMPT_JUIZ` permanecem exatamente como estão hoje no repositório.

---

## 4. Nota de escopo — `episodios_pulados_idempotencia`

Confirmado com Guilherme: esta coluna reflete o significado **restrito** que o código já
implementa hoje via `episodioJaProcessado` — conta só episódios que **já tinham gerado um
`system_events` de desvio** em execução anterior do mesmo dia. Episódios julgados como limpos
(sem desvio) não deixam rastro hoje e, portanto, são reavaliados a cada nova execução do mesmo
dia — isso é esperado, não é bug, e fica fora do escopo desta implementação (registrado como
possível melhoria futura, não abrir novo item de backlog sem necessidade concreta).

---

## 5. Query de verificação (uso do Guilherme amanhã)

```sql
SELECT * FROM juiz_offline_execucoes
ORDER BY created_at DESC
LIMIT 5;
```

Se a linha de `data_avaliada` = ontem existir com `status = 'sucesso'`, o cron rodou
normalmente. Ausência de linha para o dia esperado = cron não disparou (cenário 3, discutido
nesta sessão — sem automação própria ainda; verificação manual por enquanto, entrará como escopo
do MH-9 quando o dashboard for construído).

---

## 6. Escritas em `backlog_items` (para Claude Code executar via `src/backlog.js`)

Inserir novo item (usar `registrarItemBacklog`, nunca SQL direto):
- `tipo`: 'MH'
- `numero`: 58
- `titulo`: 'Telemetria de execução diária do Juiz Offline (tabela juiz_offline_execucoes)'
- `status`: 'em_validacao' (implementado nesta sessão; falta confirmar em produção amanhã que a
  linha do dia é gravada corretamente)
- `prioridade`: 'media'
- `data_criacao`: '2026-07-29'

---

## 7. Checklist para o Claude Code

1. Aplicar a migration da seção 1 manualmente no SQL Editor do Supabase (projeto
   `nputymewnwmnhrtpizzs`).
2. Adicionar a função da seção 2 em `src/observabilidade.js` + atualizar o import em
   `src/juizOffline.js`.
3. Substituir a função `executarJuizOffline` inteira pela versão da seção 3 em
   `src/juizOffline.js`.
4. `node --check src/observabilidade.js` e `node --check src/juizOffline.js`.
5. Commit + push.
6. Inserir o item de backlog da seção 6 via `src/backlog.js`.
7. Não é necessário rodar manualmente — o cron do scheduler (03:00 BRT) executa amanhã de
   madrugada; a query da seção 5 confirma o resultado depois disso.