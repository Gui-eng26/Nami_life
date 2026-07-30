# BRIEFING — v26 #3: MH-064 T1 — `degradar()` e os 5 pontos de degradação silenciosa

**Sessão:** v26 (30/07/2026)
**Escopo:** 1 função nova em `src/observabilidade.js` + instrumentação de 5 pontos.
**Nenhum fluxo muda. Nenhuma mensagem ao usuário muda.** Cada ponto continua devolvendo
exatamente o mesmo valor que devolve hoje — a diferença é que passa a existir registro.

---

## Evidência

Query de sombra rodada em 30/07 contra todo o histórico de `agent_logs`, procurando as assinaturas
literais dos fallbacks conhecidos e cruzando com `system_events` em ±60s:

> **5 degradações conhecidas desde 15/06/2026. 5 de 5 sem nenhum evento correspondente.**

A mais recente é rastreável até a consequência: 29/07 10:09:43 BRT (`agent_log 0af1a7bf`), usuário
em `confirming` disse *"Ah tomei ontem sim"* e recebeu *"Desculpe, não entendi bem. Pode repetir?
🌿"*. Grep no código: essa string existe em **exatamente um lugar**, `principal.js:309` — o
fallback de falha de parse. O retorno traz `action: null` e `newState: 'idle'`: a confirmação
retroativa foi **descartada** e o contexto pendente **apagado**. O usuário refez na mão. Um idoso
não refaz.

Diagnóstico de fundo (princípio 29): dos 15 pontos de `registrarEvento` no código, **um só é
genérico** (o `catch_global` do `agent.js`), e ele cobre apenas exceção NÃO tratada. Todo `catch`
local que devolve fallback é invisível por construção — o código não quebra, ele piora.

---

## Os dois invariantes

Não é "todo `catch` registra evento" — o problema não é o `catch`, é o que sai dele.

1. **Todo caminho que entrega ao usuário um texto que não é a resposta pretendida registra
   evento.** Verificável por construção: todo fallback desses é uma string literal no código.
2. **Todo caminho que devolve um valor default assumido no lugar de um resultado real registra
   evento** — decisão, classificação ou booleano. Este é o mais perigoso dos dois, porque não
   deixa nem assinatura de texto para procurar depois.

---

## PARTE 1 — o helper

Acrescentar em `src/observabilidade.js`, exportado.

```js
// ============================================================
// DEGRADAÇÃO CONTROLADA (MH-064, v26)
//
// Une "devolver fallback" e "registrar que degradou" numa expressão só. A regra NÃO é que esta
// função seja dona do texto — é que o valor de fallback só existe como RETORNO dela. Assim fica
// estruturalmente impossível ter um sem o outro, porque quem quer o fallback passa por quem
// registra. Mesma forma do princípio 30 (ponto único de despacho), aplicada à degradação.
//
// A chave é `origem:motivo` — origem é o local no código (fixo por call site, não é julgamento)
// e motivo é sintoma observável (princípio 26), nunca causa inferida. Severidade e título vêm
// da tabela, NUNCA do call site: dois pontos equivalentes escolhendo severidades diferentes
// desordenam a fila de triagem. O título é templatizado porque alimenta o fingerprint
// (princípio 25) — o detalhe volátil vive no `detalhe`, fora do hash.
// ============================================================

const DEGRADACOES = {
    'principal:parse_json_falhou': {
        severidade: 'alta',
        titulo: 'Resposta do principal não pôde ser interpretada — ação descartada'
    },
    'cadastro:parse_json_falhou': {
        severidade: 'media',
        titulo: 'Resposta do cadastro não pôde ser interpretada — etapa mantida'
    },
    'configuracao:classificacao_falhou': {
        severidade: 'alta',
        titulo: 'Classificação de intenção da configuração caiu no default'
    },
    'exclusao_conta:deteccao_llm_falhou': {
        severidade: 'alta',
        titulo: 'Detecção de pedido de exclusão falhou — assumido NÃO'
    },
    'exclusao_conta:exclusao_falhou': {
        severidade: 'critica',
        titulo: 'Falha ao executar exclusão de conta (LGPD)'
    }
};

const DEGRADACAO_NAO_CATALOGADA = {
    severidade: 'media',
    titulo: 'Degradação controlada não catalogada'
};

/**
 * Registra uma degradação controlada e devolve o fallback recebido.
 *
 * @param {string}   origem   - local no código: 'principal', 'cadastro', 'configuracao', 'exclusao_conta'
 * @param {string}   motivo   - sintoma observável: 'parse_json_falhou', 'classificacao_falhou',
 *                              'deteccao_llm_falhou', 'exclusao_falhou'
 * @param {string}   agent    - agente para o campo `agent` de system_events
 * @param {string?}  userId
 * @param {object?}  detalhe  - APENAS estrutura. Nunca texto de usuário nem saída de LLM.
 * @param {*}        fallback - o valor devolvido ao chamador, tal e qual
 * @returns {Promise<*>} o próprio `fallback`
 */
export async function degradar({ origem, motivo, agent, userId = null, detalhe = null, fallback }) {
    const chave = `${origem}:${motivo}`;
    const cat = DEGRADACOES[chave] || DEGRADACAO_NAO_CATALOGADA;

    console.error(`⚠️ [DEGRADACAO] ${chave}${detalhe ? ` — ${JSON.stringify(detalhe)}` : ''}`);

    await registrarEvento({
        tipo: 'erro_tecnico',
        severidade: cat.severidade,
        userId,
        agent,
        origem: 'outro',
        titulo: cat.titulo,
        payload: { origem, motivo, catalogado: !!DEGRADACOES[chave], ...(detalhe || {}) }
    });

    return fallback;
}
```

**`await` obrigatório** em todo call site: sem esperar, uma falha do insert some (o
`registrarEvento` engole a própria exceção). O custo é ~100ms num caminho que já está degradado.

---

## PARTE 2 — os 5 pontos

### 2.1 `src/agentes/principal.js` — falha de parse (o caso com evidência)

**Localizar:**

```js
        console.error('❌ Claude não retornou JSON válido:', rawText);

        const pareceJson = rawText.trim().startsWith('{');
        return {
            message: (!pareceJson && rawText.length > 10 && rawText.length < 500)
                ? rawText
                : 'Desculpe, não entendi bem. Pode repetir? 🌿',
            newState: 'idle',
            context: {},
            action: null
        };
```

**Substituir por:**

```js
        console.error('❌ Claude não retornou JSON válido:', rawText);

        const pareceJson = rawText.trim().startsWith('{');
        return await degradar({
            origem: 'principal',
            motivo: 'parse_json_falhou',
            agent: 'principal',
            userId: user?.id ?? null,
            detalhe: {
                // Estes campos existem para DISTINGUIR truncamento de cerca markdown, que
                // produzem o mesmo sintoma. stop_reason === 'max_tokens' é prova de truncamento.
                stop_reason: response?.stop_reason ?? null,
                tamanho_raw: rawText.length,
                comeca_com_chave: pareceJson,
                regex_casou: !!jsonMatch,
                max_tokens: 1024,
                texto_cru_devolvido: !pareceJson && rawText.length > 10 && rawText.length < 500
            },
            fallback: {
                message: (!pareceJson && rawText.length > 10 && rawText.length < 500)
                    ? rawText
                    : 'Desculpe, não entendi bem. Pode repetir? 🌿',
                newState: 'idle',
                context: {},
                action: null
            }
        });
```

⚠️ **Conferir escopo:** `jsonMatch`, `response` e `user` precisam estar visíveis nesse ponto. Se
`user` não estiver no escopo da função de parse, passar `null` e **não** alterar a assinatura da
função nesta rodada — o `agent_log_id` já ia ser nulo aqui de qualquer forma (a degradação ocorre
antes do `logAgentInteraction` do router, princípio 24), e a correlação na triagem é por janela de
tempo. Registrar sem `userId` é melhor que não registrar.

O campo `texto_cru_devolvido` marca o caso em que o texto bruto do LLM vai direto ao usuário, fora
do contrato JSON — colide com os princípios 13 e 28 e precisa ser distinguível na triagem.

### 2.2 `src/agentes/cadastro.js` — falha de parse

**Localizar:**

```js
        console.error('❌ cadastro: Claude não retornou JSON válido:', rawText);
        return {
            message: 'Desculpe, tive um probleminha. Pode repetir? 🌿',
            proximaEtapa: context?.etapa || 'cad_nome',
            novoContext: context || {},
            action: null
        };
```

**Substituir por:**

```js
        console.error('❌ cadastro: Claude não retornou JSON válido:', rawText);
        return await degradar({
            origem: 'cadastro',
            motivo: 'parse_json_falhou',
            agent: 'cadastro',
            userId: user?.id ?? null,
            detalhe: {
                stop_reason: response?.stop_reason ?? null,
                tamanho_raw: rawText.length,
                etapa: context?.etapa || 'cad_nome'
            },
            fallback: {
                message: 'Desculpe, tive um probleminha. Pode repetir? 🌿',
                proximaEtapa: context?.etapa || 'cad_nome',
                novoContext: context || {},
                action: null
            }
        });
```

`etapa` no detalhe importa: falha no onboarding é mais grave em algumas etapas que em outras, e é
isso que a triagem precisa ver. Se `user` não estiver no escopo, passar `null` (mesma regra do 2.1).

### 2.3 `src/agentes/configuracao.js` — classificação cai no default

Este é o invariante 2: não entrega texto de fallback, entrega **decisão** de fallback. Se o LLM
falha, o usuário recebe uma pergunta de esclarecimento indistinguível de "não entendi".

**Localizar:**

```js
    } catch (e) {
        console.error('⚠️ Erro ao classificar intenção:', e.message);
        return { acao: 'esclarecer_pausar_encerrar', medicamentoMencionado: null, novoHorario: null };
    }
```

**Substituir por:**

```js
    } catch (e) {
        console.error('⚠️ Erro ao classificar intenção:', e.message);
        return await degradar({
            origem: 'configuracao',
            motivo: 'classificacao_falhou',
            agent: 'configuracao',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: { acao: 'esclarecer_pausar_encerrar', medicamentoMencionado: null, novoHorario: null }
        });
    }
```

`detalhe` guarda `e.name` e o status HTTP, **não** `e.message` — a mensagem pode conter conteúdo
volátil e não pertence ao registro estruturado.

### 2.4 `src/agentes/exclusaoConta.js` — detecção assume NÃO (LGPD)

**Localizar:**

```js
    } catch (e) {
        // Falha do LLM: por segurança, NÃO trata como exclusão (evita apagar por engano).
        console.error(`❌ [EXCLUSAO-CONTA] Erro no estágio 2 (LLM): ${e.message} — assumindo NAO`);
        return false;
    }
```

**Substituir por:**

```js
    } catch (e) {
        // Falha do LLM: por segurança, NÃO trata como exclusão (evita apagar por engano).
        // A decisão segura continua a mesma; o que muda é que ela deixa de ser invisível —
        // um pedido de exclusão de conta que desaparece sem rastro é problema de LGPD.
        console.error(`❌ [EXCLUSAO-CONTA] Erro no estágio 2 (LLM): ${e.message} — assumindo NAO`);
        return await degradar({
            origem: 'exclusao_conta',
            motivo: 'deteccao_llm_falhou',
            agent: 'excluir_conta',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: false
        });
    }
```

⚠️ **Não alterar a decisão.** Continua devolvendo `false`. O retorno é idêntico ao de hoje.

### 2.5 `src/agentes/exclusaoConta.js` — exclusão falhou (LGPD, `critica`)

O comentário no próprio código diz que o monitoramento aqui é reativo via Railway. Este é o caso
que originou o MH-052.

**Localizar:**

```js
        console.error(`❌ [EXCLUSAO-CONTA] Falha ao excluir conta — ${user.phone} — ${e.message}`);
        console.error('Stack:', e.stack);

        const response =
`${firstName}, tive um probleminha técnico e não consegui concluir a exclusão agora. 😔 Pode ficar tranquilo(a): *nada foi apagado*, seus dados continuam seguros.

Tente de novo daqui a alguns minutos, por favor. Se ainda assim não der certo, fale diretamente com o ${CONTATO_GUILHERME} — ele resolve isso pra você manualmente. 🌿`;
        return { response, contaExcluida: false };
```

**Substituir por:**

```js
        console.error(`❌ [EXCLUSAO-CONTA] Falha ao excluir conta — ${user.phone} — ${e.message}`);
        console.error('Stack:', e.stack);

        const response =
`${firstName}, tive um probleminha técnico e não consegui concluir a exclusão agora. 😔 Pode ficar tranquilo(a): *nada foi apagado*, seus dados continuam seguros.

Tente de novo daqui a alguns minutos, por favor. Se ainda assim não der certo, fale diretamente com o ${CONTATO_GUILHERME} — ele resolve isso pra você manualmente. 🌿`;

        return await degradar({
            origem: 'exclusao_conta',
            motivo: 'exclusao_falhou',
            agent: 'excluir_conta',
            userId: user.id,
            detalhe: { erro: e.name, estado_preservado: 'aguardando_confirmacao_exclusao' },
            fallback: { response, contaExcluida: false }
        });
```

**Atualizar o comentário do bloco:** remover a frase *"console.error completo vai pros logs do
Railway (monitoramento reativo atual)"* — deixou de ser verdade. Substituir por: *"Registrado em
system_events com severidade critica (MH-064, v26). Nada foi apagado — a transação atômica fez
rollback. Estado mantido em aguardando_confirmacao_exclusao para permitir retry com CONFIRMAR."*

---

## Imports

Acrescentar `degradar` ao import de `../observabilidade.js` em `principal.js`, `cadastro.js`,
`configuracao.js` e `exclusaoConta.js`. **Atenção ao caminho relativo** — os agentes estão em
`src/agentes/`, então é `../observabilidade.js`. Se algum desses arquivos ainda não importa nada de
`observabilidade.js`, criar a linha de import.

---

## Riscos

1. **`await` novo em caminho de erro.** Acrescenta ~100ms a respostas que já estão degradadas.
   Irrelevante no volume atual.
2. **`registrarEvento` falhando dentro do `degradar`.** Ele engole a própria exceção
   (`observabilidade.js`), então o `return fallback` acontece de qualquer forma. Sem risco de
   transformar degradação em exceção.
3. **Variável fora de escopo.** O risco real desta rodada. `response`, `jsonMatch`, `user` e
   `context` precisam estar visíveis em cada ponto. Se algum não estiver, passar `null` naquele
   campo — **nunca** alterar assinatura de função para conseguir o dado.
4. **Volume de eventos.** Se algum desses pontos falhar com frequência que hoje não conhecemos, a
   fila de triagem enche. É o resultado desejado: é exatamente o que queremos descobrir.

---

## Checklist para o Claude Code

1. Acrescentar `degradar` + `DEGRADACOES` em `src/observabilidade.js`.
2. Aplicar os 5 pontos (2.1 a 2.5).
3. Ajustar imports nos 4 agentes.
4. `node --check` nos 5 arquivos.
5. **Verificação de completude** — critério real de conclusão, não a lista deste briefing:
   `grep -rn "Desculpe, não entendi bem\|Desculpe, tive um probleminha\. Pode repetir" src/`
   deve retornar apenas linhas **dentro** de um bloco `degradar({`. Se alguma assinatura de
   fallback aparecer solta, existe ponto não instrumentado.
6. `grep -c "degradar(" src/agentes/*.js` — total deve ser 5 chamadas + os imports.
7. `git add -A && git commit && git push`.
8. **Nenhuma escrita em `backlog_items`.**

---

## Validação

Nenhum desses caminhos é provocável sob demanda — todos dependem de falha real de LLM ou de banco.
A validação é por **ausência de regressão** agora e por **aparecimento de sinal** depois.

**Agora:** conversa normal pelo WhatsApp — cadastro, configuração e conversa com o principal. Se
tudo responde como antes, os pontos não estão disparando indevidamente.

**Continuada:** a partir de agora, a métrica de sombra deve convergir para zero. Rodar
periodicamente a Q6b do query pack de observabilidade:

```sql
-- Toda ocorrência nova de fallback conhecido deve ter evento correspondente.
-- sem_nenhum_evento parado no valor histórico (5) = instrumentação funcionando.
-- sem_nenhum_evento crescendo = existe ponto de fallback ainda não coberto.
```

**Primeira pergunta que os dados vão responder:** `payload->>'stop_reason'` nos eventos
`principal:parse_json_falhou`. Se vier `max_tokens`, o parse falha por **truncamento** e a correção
é aumentar o limite — hipótese levantada na v26 e até aqui não testável por falta de instrumento.
Se vier `end_turn`, o problema é de formato e a correção é outra.

---

## Registrado para o encerramento da v26

- **MH-064** → `em_validacao`, não `resolvido`. O T1 cobre 5 pontos; o T2 (`lembrete.js`, 4 catch
  que engolem tudo, incluindo falha de notificação a cuidador) e o T3 (auditoria do restante contra
  os dois invariantes) continuam abertos.
- **Princípio novo candidato:** *"o valor de fallback só existe como retorno da função que o
  registra"* — decidir no encerramento se vira princípio ou fica como nota do MH-064.