# BRIEFING — v26 #1: robustez e agrupamento da camada de captação

**Sessão:** v26 (30/07/2026)
**Escopo:** 4 mudanças pequenas, todas na camada de observabilidade. Nenhuma toca caminho de
usuário. Nenhuma altera o prompt do juiz (portanto **não exige recalibração** dos 8 episódios).

| # | O quê | Arquivo |
|---|---|---|
| 1 | Isolamento de falha por episódio + retry | `src/juizOffline.js` |
| 2 | `temperature: 0` no juiz | `src/juizOffline.js` |
| 3 | Títulos estáveis para fingerprint | `src/juizOffline.js`, `src/agent.js` |
| 4 | Valor `nao_valida` no `status_triagem` | migration nova |

**Contexto de decisão (v26):** a partir desta sessão vale um critério explícito para a fase de
beta — **falso positivo é barato, falso negativo é caro.** O juiz deve capturar demais e a triagem
descarta. Toda decisão abaixo segue disso.

---

## 1. Isolamento de falha por episódio + retry

### O problema (evidência)

Execução de 30/07 06:00 UTC (`juiz_offline_execucoes` id=1): `turnos_totais` 96,
`episodios_totais` 11, `episodios_avaliados` **3**, `status` `falha_parcial`, `erro_resumo`
`500 ... api_error`. Cobertura real: **3,1% dos turnos**.

Stack trace capturado em `system_events` (`e6ef411e`):
```
at async julgarEpisodio (juizOffline.js:244)
at async executarJuizOffline (juizOffline.js:335)
```

Causa raiz: o `try` de `executarJuizOffline` envolve **o loop inteiro**. Uma exceção em qualquer
episódio escapa do `for` e aborta a varredura. `episodios_falha_julgamento = 0` confirma — a
exceção não foi contabilizada como falha de episódio, ela saiu por cima.

Uma 500 da API é transitória. Perder 8 de 11 episódios por causa dela é desproporcional.

### A correção

**(a) `try/catch` dentro do loop.** Localizar, em `executarJuizOffline`:

```js
            const enriquecido = await enriquecerEpisodio(episodio);
            const julgamento = await julgarEpisodio(enriquecido);
            await sleep(PAUSA_ENTRE_JULGAMENTOS_MS);

            if (julgamento === null) {
                episodiosFalhaJulgamento++;
                continue;
            }
```

Substituir por:

```js
            let julgamento;
            try {
                const enriquecido = await enriquecerEpisodio(episodio);
                julgamento = await julgarEpisodioComRetry(enriquecido);
            } catch (erroEpisodio) {
                episodiosFalhaJulgamento++;
                console.error(
                    `⚖️ Episódio ${episodio.primeiroLogId} falhou após retries: ${erroEpisodio.message}`
                );
                await registrarEvento({
                    tipo: 'erro_tecnico',
                    severidade: 'media',
                    userId: episodio.userId,
                    agent: 'juiz_offline',
                    origem: 'scheduler',
                    agentLogId: episodio.primeiroLogId,
                    titulo: tituloEstavel(erroEpisodio, 'Falha ao julgar episódio (juiz offline)'),
                    payload: {
                        message: erroEpisodio.message,
                        n_turnos: episodio.turnos.length,
                        funcao: 'julgarEpisodioComRetry'
                    }
                });
                await sleep(PAUSA_ENTRE_JULGAMENTOS_MS);
                continue;   // ← o episódio seguinte SEMPRE é tentado
            }
            await sleep(PAUSA_ENTRE_JULGAMENTOS_MS);

            if (julgamento === null) {
                episodiosFalhaJulgamento++;
                continue;
            }
```

Severidade `media` de propósito: um episódio perdido não é o mesmo que a varredura inteira perdida
(que continua `alta`).

**(b) Retry.** Função nova, acima de `executarJuizOffline`:

```js
const TENTATIVAS_JULGAMENTO = 3;
const BACKOFF_MS = [1000, 4000];   // espera ANTES da 2ª e da 3ª tentativa

async function julgarEpisodioComRetry(episodio) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= TENTATIVAS_JULGAMENTO; tentativa++) {
        try {
            return await julgarEpisodio(episodio);
        } catch (e) {
            ultimoErro = e;
            const status = e?.status ?? e?.response?.status ?? null;
            // 4xx (exceto 429) é erro nosso — retry não resolve, falha na hora.
            if (status && status >= 400 && status < 500 && status !== 429) throw e;
            if (tentativa < TENTATIVAS_JULGAMENTO) {
                console.warn(`⚖️ Tentativa ${tentativa} falhou (${e.message}) — nova tentativa`);
                await sleep(BACKOFF_MS[tentativa - 1]);
            }
        }
    }
    throw ultimoErro;
}
```

Não fazer retry em 4xx é deliberado: 400/401/403 significam requisição malformada ou credencial
errada — repetir só gasta tempo e dinheiro. 429 e 5xx são transitórios e valem repetir.

### ⚠️ (c) A armadilha: o `status` da telemetria passa a mentir

**Esta parte não pode ser esquecida.** Hoje `status = 'falha_parcial'` só acontece porque a exceção
escapa e cai no `catch` externo. Com o isolamento, o loop **termina normalmente** mesmo que 8
episódios falhem — e a linha final gravaria `status: 'sucesso'`. A telemetria passaria a declarar
sucesso numa varredura incompleta, que é exatamente o oposto do que o MH-058 existe para fazer.

Localizar, ao fim do bloco `try`:

```js
        await registrarExecucaoJuizOffline({
            dataAvaliada, turnosTotais, episodiosTotais,
            episodiosPuladosIdempotencia, episodiosAvaliados,
            episodiosFalhaJulgamento, turnosAvaliados, eventosRegistrados,
            status: 'sucesso'
        });
```

Substituir por:

```js
        // O status reflete o RESULTADO da varredura, não a ausência de exceção. Com isolamento
        // por episódio o loop termina mesmo com falhas — sem isto, a telemetria declararia
        // 'sucesso' numa varredura incompleta (o oposto do propósito do MH-058).
        await registrarExecucaoJuizOffline({
            dataAvaliada, turnosTotais, episodiosTotais,
            episodiosPuladosIdempotencia, episodiosAvaliados,
            episodiosFalhaJulgamento, turnosAvaliados, eventosRegistrados,
            status: episodiosFalhaJulgamento > 0 ? 'falha_parcial' : 'sucesso',
            erroResumo: episodiosFalhaJulgamento > 0
                ? `${episodiosFalhaJulgamento} de ${episodiosTotais} episódio(s) não julgado(s)`
                : null
        });
```

Isso mantém válida a coluna `cobertura_turnos_pct` da Q5 do query pack de observabilidade.

---

## 2. `temperature: 0` no juiz

### Evidência

O diagnóstico do falso positivo rodou o **mesmo episódio, mesmo prompt, mesma nota**, 3 vezes na
variante B: os vereditos saíram `false`, `true`, `false` — e quando saiu `true`, veio com categoria
diferente da do incidente real de produção. Nenhuma chamada de LLM do projeto define `temperature`;
todas herdam o default da API (`1`), por omissão e não por decisão.

### Por que importa aqui

Cada episódio é julgado **uma única vez** (idempotência por `agent_log_id`). Com sorteio, um desvio
real pode cair no lado `false` na única chance que teve e sumir sem deixar rastro de que foi
avaliado — falso negativo silencioso, o modo de falha que esta sessão existe para eliminar.
Além disso, instrumento que varia não pode ser calibrado: o 8/8 da v24 é uma amostra de uma
execução.

### A correção

Em `julgarEpisodio`, localizar:

```js
    const response = await anthropic.messages.create({
        model: MODELO_JUIZ,
        max_tokens: 1024,
        system: PROMPT_JUIZ,
        messages: [{ role: 'user', content: texto }]
    });
```

Substituir por:

```js
    const response = await anthropic.messages.create({
        model: MODELO_JUIZ,
        max_tokens: 1024,
        // temperature 0 (v26): o juiz CLASSIFICA, não redige — variedade aqui é ruído, não
        // qualidade. Cada episódio é julgado uma única vez (idempotência), então oscilação
        // produz falso negativo silencioso. Não elimina 100% da variação (batching/ponto
        // flutuante em GPU), mas reduz drasticamente.
        temperature: 0,
        system: PROMPT_JUIZ,
        messages: [{ role: 'user', content: texto }]
    });
```

**Não alterar nenhuma outra chamada de LLM nesta rodada.** Classificador central, principal,
cadastro e configuração são caminho quente do usuário; `gerarMoldura` *deve* manter variedade (ela
redige, e é proibida de citar dado factual). Mexer nelas junto impediria atribuir efeito a causa.

---

## 3. Títulos estáveis para o fingerprint

### O problema

`registrarEvento` calcula `fingerprint = sha1(tipo|titulo|agent)`, e o comentário do próprio
`observabilidade.js:16` define o contrato: *"titulo: resumo ESTÁVEL/templatizado (o fingerprint
agrupa por ele) — NUNCA a mensagem crua."*

Dois produtores violam o próprio contrato, interpolando a mensagem de erro no título:
- `juizOffline.js` → `Erro no juiz offline: ${error.message}` — e a mensagem carrega o
  `request_id` (`req_011CdXjPtcMHFKeMmZEwKSev`). **Cada 500 gera fingerprint único.**
- `agent.js:45` → `Exceção não tratada: ${error.message}` — mesmo problema com qualquer detalhe
  volátil (status, id, telefone).

Consequência prática, dado o critério desta sessão: se o juiz vai capturar demais e você vai
descartar, o descarte só escala se o agrupamento funcionar. Com fingerprint instável, o mesmo
falso positivo recorrente precisa ser descartado **toda vez**, um a um.

### A correção — nem cru, nem genérico demais

Título totalmente genérico erra para o outro lado: colapsaria toda exceção global num balde só.
A saída é derivar uma **classe estável** do erro, deterministicamente. Acrescentar em
`src/observabilidade.js` e exportar:

```js
// Deriva um título ESTÁVEL a partir de um erro, para alimentar o fingerprint.
// Estável entre ocorrências do MESMO defeito; ainda distingue defeitos diferentes.
// O detalhe volátil (mensagem, request_id, stack) vive no payload, nunca aqui.
export function tituloEstavel(error, prefixo) {
    const nome = error?.name || 'Error';
    const status = error?.status ?? error?.response?.status ?? null;
    return `${prefixo}: ${nome}${status ? ` ${status}` : ''}`.slice(0, 200);
}
```

Exemplos do que passa a ser gravado:
- `Erro no juiz offline: APIError 500` — agrupa todas as 500 da Anthropic num fingerprint só.
- `Exceção não tratada (agent): AxiosError 400` — agrupa as falhas de envio Z-API, e continua
  distinguindo de um `TypeError`.

**Aplicar em dois lugares.**

Em `src/juizOffline.js`, no `catch` externo de `executarJuizOffline`, localizar:
```js
            titulo: `Erro no juiz offline: ${error.message?.split('\n')[0] ?? ''}`.slice(0, 200),
```
Substituir por:
```js
            titulo: tituloEstavel(error, 'Erro no juiz offline'),
```
(o `payload` já guarda `message` e `stack` — o detalhe não se perde, só sai do título.)

Em `src/agent.js`, localizar:
```js
                titulo: `Exceção não tratada: ${error.message?.split('\n')[0] ?? 'desconhecida'}`.slice(0, 200),
```
Substituir por:
```js
                titulo: tituloEstavel(error, 'Exceção não tratada (agent)'),
```

Acrescentar `tituloEstavel` aos imports de `observabilidade.js` em ambos os arquivos.

⚠️ **Os fingerprints antigos não são recalculados.** Os 5 eventos já gravados mantêm o hash
antigo. Não há retroatividade e não deve haver — reescrever registro histórico contradiz a regra do
projeto de nunca reescrever registro de época. O agrupamento vale a partir de agora.

---

## 4. Migration — valor `nao_valida` no `status_triagem`

Decorre direto do critério da sessão: capturar demais só funciona se existir o gesto de descartar,
e `arquivado` não serve — ele confunde *"vi, não era nada"* com *"é real, não vou tratar agora"*.
Essa distinção é o eixo do fluxo de triagem e do futuro dash.

Hoje ambas as tabelas aceitam apenas `novo`, `lido`, `arquivado`, `virou_backlog` (verificado por
leitura das constraints em 30/07).

Criar `supabase/migrations/20260730000000_status_triagem_nao_valida.sql`:

```sql
-- v26: acrescenta 'nao_valida' ao status_triagem de system_events e feedbacks.
-- Motivo: a partir da v26 o juiz opera com tolerância deliberada a falso positivo
-- (falso positivo é barato, falso negativo é caro). O fluxo de triagem precisa
-- distinguir "avaliei e não era defeito" de "é defeito real, arquivado por ora".
-- Sem essa distinção, 'arquivado' vira balde único e o dash não consegue medir
-- a taxa de falso positivo do juiz.

ALTER TABLE system_events DROP CONSTRAINT system_events_status_triagem_check;
ALTER TABLE system_events ADD CONSTRAINT system_events_status_triagem_check
    CHECK (status_triagem IN ('novo','lido','arquivado','virou_backlog','nao_valida'));

ALTER TABLE feedbacks DROP CONSTRAINT feedbacks_status_triagem_check;
ALTER TABLE feedbacks ADD CONSTRAINT feedbacks_status_triagem_check
    CHECK (status_triagem IN ('novo','lido','arquivado','virou_backlog','nao_valida'));
```

**Aplicação manual pelo Guilherme no editor SQL do Supabase**, como as anteriores. Nenhum default
muda; nenhuma linha existente é afetada (a constraint só amplia o conjunto aceito).

Atualizar também o comentário de inventário em `src/observabilidade.js` (bloco de linhas 13-17),
acrescentando o novo valor à lista de `status_triagem` se ele estiver documentado ali.

---

## Riscos e regressões

1. **Retry multiplica chamadas à API.** Pior caso: 3× o custo do juiz num dia de instabilidade.
   Volume atual ~11 episódios/dia — irrelevante. Reavaliar se o beta levar a ~100/dia.
2. **`temperature: 0` pode mudar a taxa de detecção.** Possível, e aceitável: dado o critério da
   sessão, mudança para qualquer lado é preferível a oscilação. Não requer recalibração porque o
   **prompt não muda** — a regra da v24 fala do texto do prompt.
3. **Fingerprints novos convivem com antigos.** Esperado e documentado acima.
4. **A migration é irreversível na prática** (constraint recriada). Baixo risco: só amplia.
5. **Erro dentro do próprio `catch` de episódio.** Se `registrarEvento` falhar ali, ele engole a
   exceção internamente (`observabilidade.js:32-34`) — o `continue` acontece de qualquer forma.
   Sem risco de re-abortar o loop.

---

## Checklist para o Claude Code

1. Aplicar as edições de `src/juizOffline.js` (itens 1a, 1b, 1c, 2, 3).
2. Aplicar as edições de `src/agent.js` (item 3).
3. Acrescentar `tituloEstavel` em `src/observabilidade.js` + exportar; ajustar imports nos dois
   arquivos consumidores.
4. Criar o arquivo de migration (item 4) — **não executar**, é aplicação manual.
5. `node --check` em `src/juizOffline.js`, `src/agent.js`, `src/observabilidade.js`.
6. Conferir por leitura que **não** existe mais nenhuma interpolação de `error.message` dentro de
   um campo `titulo:` no projeto: `grep -rn "titulo:" src/ | grep -i "error\|message"` deve voltar
   vazio.
7. Conferir que `temperature` só aparece em `src/juizOffline.js`:
   `grep -rn "temperature" src/` deve retornar exatamente 1 ocorrência.
8. `git add -A && git commit && git push`.
9. **Nenhuma escrita em `backlog_items` nesta rodada** — os itens novos entram no encerramento da
   v26.

---

## Validação (após o deploy, na execução de 31/07 03:00 BRT)

```sql
-- Cobertura da varredura: turnos_avaliados deve se aproximar de turnos_totais
SELECT data_avaliada, status, turnos_totais, turnos_avaliados, episodios_totais,
       episodios_avaliados, episodios_falha_julgamento, eventos_registrados, erro_resumo
FROM juiz_offline_execucoes ORDER BY data_avaliada DESC LIMIT 3;

-- Títulos estáveis: nenhum request_id/status volátil dentro de titulo
SELECT titulo, fingerprint, count(*) FROM system_events
WHERE created_at >= '2026-07-31' GROUP BY 1,2 ORDER BY 3 DESC;
```

Critério de sucesso do item 1: `episodios_avaliados + episodios_pulados_idempotencia =
episodios_totais`, **ou** `episodios_falha_julgamento > 0` com `status = 'falha_parcial'`. O que
não pode acontecer é a soma não fechar sem que ninguém tenha sido contabilizado — isso significaria
que ainda há caminho de saída silenciosa.

---

## Registrado para o encerramento da v26 (não executar aqui)

- **MH-058** → candidato a `resolvido`: a telemetria provou o próprio valor na primeira execução —
  detectou a varredura incompleta e forneceu o stack trace que deu a causa raiz. Fechar após a
  validação de 31/07.
- **Itens novos a registrar** (próximos números livres: BUG-080+, MH-065+): a falha de isolamento
  por episódio e a instabilidade de fingerprint, ambos já corrigidos nesta rodada — entram como
  registro histórico com `status = 'resolvido'`.
- **Observação aceita, sem item de backlog:** a nota `CONTEXTO: lembrete automático de <nome>` é
  gramaticalmente ambígua quando o medicamento tem nome que soa como nome de pessoa (caso "Elani").
  Decisão da v26: **não corrigir** — o falso positivo resultante é absorvido pela triagem
  (`nao_valida`), e a redação é problema de polimento, não de captação.