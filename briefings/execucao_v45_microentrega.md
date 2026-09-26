# BRIEFING DE EXECUÇÃO — v45 · Micro-entrega: estados legados do onboarding

**Pré-requisito:** M4 em produção (arquitetura-alvo M0–M4 fechada).
**Branch:** `staging`; promoção isolada (MH-89 C).
**Governança:** nenhuma escrita em `backlog_items` a partir deste briefing (§6 depende do "sim, registra" do Guilherme).
**Fonte de verdade:** CONTEXT.md §12.9 + este briefing.
**Diretriz de custo:** rodar só os casos afetados durante o desenvolvimento; suíte completa UMA vez no portão de merge. A guarda nova é um caso de 1 turno.

---

## 0. Objetivo

Pessoas que pararam a jornada em estados que o M4 eliminou (`recep_*`) voltam hoje e são tratadas como se fosse a primeira mensagem: a resposta que elas deram à pergunta pendente é ignorada e a Nami pergunta de novo. Esta entrega faz essas conversas retomarem na etapa equivalente do onboarding novo, com a pergunta pendente preservada.

**Evidência (caso Fran, produção, 22/09):** estado `recep_boas_vindas` desde 31/08; às 07:38 ela responde "Fran" e o log registra `etapa de entrada: primeira mensagem` e `Intenção inicial: "Fran" -> neutro`; a Nami manda as boas-vindas e pergunta "Como posso te chamar?". Ela teve que repetir "Fran" 14 minutos depois. Fere as regras 3 e 4 da Constituição.

**Causa raiz (confirmada em `src/runner.js`, entrada de `executarOnboarding`):** qualquer `context.etapa` que não comece com `onb_` é descartada e o fluxo reinicia do zero. O M4 previu só um caso legado, `lgpd_recusado`.

## 1. Decisão: migração de dados, não código

O mapeamento **não** vai para o código. O A0 tem um grep-guard que proíbe o token `recep_` em `src/` ("estados legados do onboarding ausentes de src/"): escrever o mapeamento em código derruba a guarda que o M4 conquistou. E nenhum caminho de código escreve `recep_*` desde o M4, então o conjunto é finito e fechado — é dado, não comportamento.

## 2. Escopo dos dados

Produção (`nputymewnwmnhrtpizzs`), 12 linhas em `conversation_state`, todas de usuários com `onboarded = false` e `users.name` nulo. Staging (`pibzuwoyznywajyxeulj`) não tem nenhuma linha legada — verificado, só existe uma linha em `onb_declinado`.

| Estado legado | Linhas | Pergunta que ficou pendente | Etapa destino |
|---|---|---|---|
| `recep_boas_vindas` (sem `nome_coletado`) | 7 | nome | `onb_nome` |
| `recep_apresentacao` | 3 | apresentação, chegada pelo folheto | `onb_apresentacao` |
| `recep_coleta_nome` (com `nome_coletado`) | 1 | consentimento LGPD | `onb_lgpd` |
| `recep_boas_vindas` (com `nome_coletado`) | 1 | consentimento LGPD | `onb_lgpd` |

O restante do `context` já usa o vocabulário novo (`nome_coletado`, `tentativas_nome`, `intencao_inicial`, `mensagem_inicial`, `rodadas_duvida`, `tentativas_ruido`) e é **preservado como está**. `state` passa a `onboarding` (valor de `SCHEMA_ONBOARDING.estadoConversa`).

Regra para as duas últimas linhas da tabela: o destino é decidido pelo conteúdo (`nome_coletado` preenchido → `onb_lgpd`), nunca pelo nome do estado antigo.

## 3. Migração (executar em produção; staging não tem linhas)

```sql
-- 3.1 apresentação (folheto)
UPDATE conversation_state
   SET state = 'onboarding',
       context = jsonb_set(context, '{etapa}', '"onb_apresentacao"'),
       updated_at = now()
 WHERE state = 'recep_apresentacao';

-- 3.2 nome pendente
UPDATE conversation_state
   SET state = 'onboarding',
       context = jsonb_set(context, '{etapa}', '"onb_nome"'),
       updated_at = now()
 WHERE state IN ('recep_boas_vindas', 'recep_coleta_nome')
   AND (context->>'nome_coletado') IS NULL;

-- 3.3 nome já coletado → pendência é a LGPD
UPDATE conversation_state
   SET state = 'onboarding',
       context = jsonb_set(context, '{etapa}', '"onb_lgpd"'),
       updated_at = now()
 WHERE state IN ('recep_boas_vindas', 'recep_coleta_nome')
   AND (context->>'nome_coletado') IS NOT NULL;
```

**Verificação obrigatória depois (o resultado vai no relato do encerramento):**

```sql
SELECT state, context->>'etapa' AS etapa, count(*)
  FROM conversation_state GROUP BY 1, 2 ORDER BY 1;
```

Nenhuma linha pode restar com `state` começando em `recep` ou com `coletando_nascimento`. O total migrado deve ser 12: 3 em `onb_apresentacao`, 7 em `onb_nome`, 2 em `onb_lgpd`.

## 4. Arnês — caso novo A36

**A36 — retomada depois de semanas na etapa do nome.** Semeia um usuário `onboarded = false` com `state = 'onboarding'`, `context = { etapa: 'onb_nome', tentativas_nome: 0, intencao_inicial: 'cadastrar', mensagem_inicial: 'Oi Nami! Quero sua ajuda pra cuidar da minha saúde.' }` — exatamente o formato das linhas migradas — e envia **um** turno: `"Fran"`.

Asserções:
1. o nome é reconhecido e persiste no contexto (`nome_coletado`);
2. a resposta **não** contém a pergunta de nome (nenhuma variação de "como posso te chamar");
3. a resposta pede o consentimento LGPD (etapa `onb_lgpd` no estado salvo);
4. nenhuma boas-vindas de primeira mensagem.

Um turno só, para manter o custo baixo. O grep-guard do M4 no A0 continua como está e é o que impede a volta do mapeamento para dentro de `src/`.

## 5. Critérios de aceite

- A36 verde; nenhum caso já-verde regredido (suíte completa uma vez, no portão).
- Migração aplicada em produção com a verificação do §3 anexada.
- `src/` segue sem o token `recep_` (A0).
- Nenhuma linha de código de produto alterada: esta entrega é dado + teste.

## 6. Registros para o encerramento (dependem do "sim, registra")

- **BUG novo** — "Estados legados do onboarding (`recep_*`) são zerados pelo M4: a resposta à pergunta pendente é ignorada e a jornada reinicia" — resolvido por esta entrega (migração + A36). Evidência: Fran, 22/09, logs 07:38.

## 7. Fora de escopo

Os outros quatro defeitos do caso Fran (horário "6:30h", recorrência perdida no lote, dígito do nome virando estoque, "Erro" ignorado). Eles pertencem à frente de extração — briefing do E0 e, depois, E1 a E3.