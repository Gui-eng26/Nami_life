# BRIEFING DE EXECUÇÃO — v45 · E0: corpus de extração (a régua)

**Pré-requisito:** nenhum. Não depende da micro-entrega dos estados legados e pode rodar em paralelo.
**Branch:** `staging`.
**Governança:** nenhuma escrita em `backlog_items`. Nenhuma escrita em banco de produção — leitura apenas.
**Diretriz de custo:** o corpus é executado **sob demanda**, nunca no portão de merge do dia a dia. Uma execução = uma chamada de LLM por item.

---

## 0. Objetivo

Criar a régua que vai dizer se a porta consegue assumir a extração. Sem ela, qualquer decisão sobre tirar regex é opinião.

O corpus é um conjunto de mensagens **reais** de `agent_logs`, cada uma com o contexto em que chegou e com a extração esperada. Ele roda contra a porta atual e produz um baseline por categoria. Nos marcos seguintes (E1 a E3), o mesmo corpus mede se a porta nova sustenta cada domínio. **Domínio em que a porta não sustentar não migra, e a regex dele fica.**

**O que este marco NÃO faz:** não altera a porta, nenhum schema, nenhum comportamento em produção. É teste e medição.

### 0.1 Fronteira com o arnês (`arnes/casos.js`) — ler antes de começar

As duas coisas convivem e **não** se substituem. O corpus não nasce dentro de `casos.js`, e nenhum caso existente é movido, reescrito ou convertido em item de corpus.

| | `arnes/casos.js` (existe) | `arnes/corpus/` (este marco) |
|---|---|---|
| O que testa | **comportamento**, conversa inteira, turno a turno | **extração**, uma chamada da porta |
| Alcance | porta → runner → validadores → funil → banco | só `interpretarTurno` |
| Dependências | Supabase de staging, seeds, mock do funil, limpeza | nenhuma além da `ANTHROPIC_API_KEY` |
| Asserção | determinística sobre texto final e estado do banco | comparação campo a campo com o gabarito |
| Veredito | binário: verde ou vermelho | taxa de acerto por categoria e por campo |
| Cadência | uma vez, no portão de merge | sob demanda, quando a porta ou o modelo mudam |
| Tamanho por item | ~56 linhas (36 casos em 2.022) | ~10 linhas de JSON |

Três consequências práticas:

1. **O corpus nunca entra no portão de merge.** Vários campos dão zero no baseline por construção (§5). Dentro de `casos.js` isso ficaria vermelho sem haver regressão, e a regra vigente é que a suíte não tem mais expected-fail.
2. **A conversa da Fran entra nos dois, e isso não é duplicação.** No corpus, as três mensagens dela medem extração. No `casos.js`, a conversa inteira trava o comportamento — e é esse caso, não o corpus, que serve de portão no E2.
3. **Quando um item do corpus revelar defeito de comportamento**, ele vira também um caso do arnês. O caminho é sempre esse, nunca o contrário.

## 1. Entregáveis

```
arnes/corpus/itens.json      # os casos: mensagem + contexto + esperado
arnes/corpus/run.js          # executor: chama a porta atual e compara
arnes/corpus/BASELINE.md     # resultado da primeira execução, por categoria
package.json                 # script "corpus": "node arnes/corpus/run.js"
```

O executor chama `interpretarTurno` de `src/porta.js` diretamente. **Não precisa de banco**: a porta só depende de `ANTHROPIC_API_KEY` e do inventário. Mesma guarda de sempre — nada toca produção.

## 2. Formato de cada item

```json
{
  "id": "H-07",
  "categoria": "horario",
  "fonte": { "data": "2026-09-22", "origem": "producao" },
  "contexto": { "estado": "post_onboarding", "etapa_pendente": null, "medicamentos_cadastrados": [] },
  "mensagem": "Puran T4 75mcg às 6:30h\nVitamina b12 2 comprimidos 1000 mcg toda segunda, as 7h",
  "esperado": {
    "intencao": "cadastro",
    "medicamentos": [
      { "nome": "Puran T4", "dosagem": "75mcg", "quantidade": null, "horarios": ["06:30"], "dias_semana": null },
      { "nome": "Vitamina b12", "dosagem": "1000 mcg", "quantidade": 2, "horarios": ["07:00"], "dias_semana": ["seg"] }
    ],
    "correcoes": [],
    "responde_pendencia": false
  },
  "revisar": false
}
```

Regras de normalização do gabarito, para não haver dúvida na comparação:

- horário em `HH:MM` 24h; `6:30h`, `6h30`, `06:30`, `6:30hs` são todos `06:30`;
- dias em `seg ter qua qui sex sab dom`; ausência de recorrência é `null`, nunca a lista dos sete dias;
- `nome` **sem** a concentração; a concentração vai em `dosagem`, como escrita;
- quantidade é número; o que a pessoa não disse é `null`, nunca um valor padrão;
- correção aponta para um medicamento **existente** no contexto, com campo e valor novo.

## 3. Composição (alvo: ~60 itens)

| Categoria | Alvo | O que precisa estar coberto |
|---|---|---|
| `horario` | 20 | todas as variações que apareceram em produção: `7h`, `7hrs`, `7hs`, `7 horas`, `07h`, `7:00`, `6:30h`, `6h30`, `17hs`, `12/12 hrs`, `meio-dia`, `de manhã` (que deve dar `null`, não um horário inventado) |
| `multi_med` | 10 | vários medicamentos numa mensagem, com e sem linha por item, horário em linha solta, nome composto por "e" |
| `recorrencia` | 8 | dias da semana, faixas (seg a sex), fim de semana, 1x por semana com dia, dia sim/dia não, e **um não representável** (a cada 3 semanas), que deve vir marcado como não representável |
| `correcao` | 8 | a pessoa aponta o erro depois: "a B12 é só segunda", "na verdade é por 7 dias", "o nome é Keppra" |
| `estoque` | 8 | número seco, forma nomeada ("Marevan 30, Kepra 29"), fração, frasco lacrado, e **os dois casos de dígito no nome**: "b12" e "Puran T4 30" |
| `quantidade_forma` | 6 | comprimido, cápsula, gotas, ml, sachê/scoop, gramas |

**Itens obrigatórios** (os nove resgates históricos mapeados no diagnóstico, mais o caso Fran): Nimesulida `12/12 hrs`; Evandro `17hs`; Priscila gramas; Predsin `2mg 2mg`; Thaielly horário em linha solta; Keppra (grafia); "na verdade é por 7 dias" na etapa de estoque; Marevan 30/Kepra 29; BUG-083/085 (dois números na mesma mensagem); e as três mensagens da Fran de 22/09.

## 4. Coleta (somente leitura em produção)

Consultas de partida em `agent_logs`, filtrando `is_teste = false` e excluindo o usuário do Guilherme:

- horário: `user_message ~* '\d\s*(:|h)'`
- recorrência: `user_message ~* '(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|dia sim|por semana|semanal)'`
- correção: `user_message ~* '(na verdade|errad|corrig|n[ãa]o [ée]|apenas|s[óo] )'`
- estoque: `contexto_conversa->>'etapa' IN ('cad_estoque','cad_estoque_lote')`
- multi-medicamento: `user_message LIKE '%' || chr(10) || '%' AND agent IN ('cadastro','principal')`

Selecionar por **diversidade de forma**, não por volume: duas mensagens que dizem a mesma coisa do mesmo jeito contam como uma.

**Privacidade.** O corpus vai para o repositório público. Cada item guarda só o trecho necessário à extração. Nada de nome de pessoa, telefone, data de nascimento ou qualquer identificador; `fonte` guarda data e origem, nunca `user_id`. Nome de medicamento e posologia permanecem, porque são o objeto do teste.

## 5. Execução e relatório

`npm run corpus` percorre os itens, chama a porta com `{ message, currentState, historicoConversa: [] }` e compara campo a campo com o esperado. O relatório sai por categoria e por campo:

```
horario        20 itens — intenção 20/20 · horários 11/20 · dias 0/20
multi_med      10 itens — ...
```

**Leitura correta do baseline:** a porta atual não tem campo para quantidade, dias da semana, duração nem correção. Esses campos vão dar zero **por construção**, e isso não é defeito novo: é a medida do buraco que o E1 vai fechar. O que interessa de verdade no baseline é o que a porta já entrega hoje: intenção, nomes e horários como texto.

Para os campos que a porta atual não representa, o executor registra `nao_suportado_pela_porta_atual` em vez de "erro", para o BASELINE não misturar as duas coisas.

## 6. Critérios de aceite

- `npm run corpus` roda de ponta a ponta, sem banco, e gera o relatório;
- ~60 itens, com todos os obrigatórios do §3 presentes;
- `arnes/corpus/BASELINE.md` com a data, o modelo usado (`claude-sonnet-4-6`) e o resultado por categoria e por campo;
- nenhuma linha de `src/` alterada;
- `arnes/casos.js`, `arnes/run.js`, `arnes/seeds.js` e `arnes/contexto.js` intocados — nenhum caso movido, convertido ou removido (§0.1);
- o script `corpus` é novo e separado: `npm run arnes` continua se comportando exatamente como hoje;
- nenhum dado pessoal no arquivo de itens.

## 7. Revisão do gabarito

O Claude Code preenche o `esperado` seguindo as regras do §2 e marca `revisar: true` em todo item cuja mensagem admita mais de uma leitura — por exemplo, a linha da Manô onde não está claro se "seg–sex às 19h30" vale para os dois medicamentos. Guilherme revisa **apenas os marcados**; a conversa de planejamento confere uma amostra de 10 itens não marcados. Gabarito errado contamina todas as medições seguintes, então essa revisão é parte do aceite.

## 8. Fora de escopo

Mudar a porta (E1), trocar consumidores (E2 e E3), comparar modelos. A comparação de modelo acontece no E1, sobre este corpus.