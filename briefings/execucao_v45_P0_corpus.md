# BRIEFING DE EXECUÇÃO — v45 · P0: corpus (a régua do principal como porta)

**Substitui** `execucao_v45_e0_corpus.md`. O trabalho do E0 que está parado sem commit deve ser **ajustado a este formato antes do commit** — o formato do item mudou (§2) e entraram as categorias de dose e de delegação (§3).
**Pré-requisito:** nenhum. Independe da micro-entrega dos estados legados.
**Branch:** `staging`. **Banco:** só leitura em produção; nada é escrito.
**Governança:** nenhuma escrita em `backlog_items`.
**Diretriz de custo:** o baseline deste marco é medido **sem chamadas de API** para as categorias de dose e delegação (§5). Só a categoria de extração chama a porta atual — uma chamada por item, sob demanda.

---

## 0. Objetivo

Construir a régua que vai dizer se o principal, como porta única (P1), acerta mais do que o sistema de hoje. Cada item é uma mensagem **real** de `agent_logs`, com o contexto estruturado em que chegou, o que o sistema **fez de fato** em produção e o que **deveria** ter feito.

Este marco não altera `src/`, nem schema, nem comportamento em produção.

### 0.1 Fronteira com o arnês (`arnes/casos.js`) — ler antes de começar

As duas coisas convivem e **não** se substituem. O corpus não nasce dentro de `casos.js`, e nenhum caso existente é movido, reescrito ou convertido.

| | `arnes/casos.js` (existe) | `arnes/corpus/` (este marco) |
|---|---|---|
| O que testa | comportamento, conversa inteira, turno a turno | interpretação de UM turno |
| Dependências | Supabase de staging, seeds, mock do funil | nenhuma além da `ANTHROPIC_API_KEY` (e só em P1+) |
| Veredito | binário, é o portão de merge | taxa de acerto por categoria e por campo |
| Cadência | uma vez, no portão | sob demanda |

O corpus **nunca** entra no portão de merge. Item do corpus que revelar defeito de comportamento vira também caso do arnês, nunca o contrário.

## 1. Entregáveis

```
arnes/corpus/itens.json      # os itens (§2)
arnes/corpus/run.js          # executor com adaptadores (§5)
arnes/corpus/BASELINE.md     # resultado por categoria e por campo
package.json                 # script "corpus": "node arnes/corpus/run.js"
```

## 2. Formato do item

```json
{
  "id": "D-04",
  "categoria": "dose",
  "fonte": { "data": "2026-09-26", "origem": "producao" },
  "contexto": {
    "agora": "2026-09-26T12:01:00-03:00",
    "estado": "idle",
    "pendencia": null,
    "ultimo_lembrete": { "quando": "hoje 08:00", "tentativa": 3, "grupo": "D1" },
    "mensagem_citada": null,
    "doses": [
      { "ref": "D1", "dia": "hoje", "data": "26/09", "hora": "06:28", "medicamento": "Roacutan", "quantidade": "1 comprimido", "status": "sem_resposta" },
      { "ref": "D2", "dia": "ontem", "data": "25/09", "hora": "06:28", "medicamento": "Roacutan", "quantidade": "1 comprimido", "status": "sem_resposta" },
      { "ref": "D3", "dia": "anteontem", "data": "24/09", "hora": "06:28", "medicamento": "Roacutan", "quantidade": "1 comprimido", "status": "sem_resposta" }
    ],
    "medicamentos": ["Roacutan"]
  },
  "mensagem": "Ontem eu tomei",
  "esperado": { "tipo": "dose", "doses": [{ "ref": "D2", "fato": "tomou" }] },
  "observado_producao": { "resumo": "fast_path_resposta_tardia confirmou D1 (hoje)", "correto": false },
  "revisar": false
}
```

- `contexto.doses` segue exatamente a estrutura que o principal receberá no P1: referências curtas por turno, rótulo de dia calculado, status em linguagem de negócio (`aguardando_resposta`, `sem_resposta`, `confirmada`, `nao_tomada`, `sem_estoque`).
- `contexto.pendencia` descreve a pergunta aberta, quando houver: `{ "fluxo": "cadastro", "etapa": "cad_estoque", "pergunta": "quantas unidades de Aerolin spray você tem?", "obrigatoria": false }`.
- `esperado.tipo` é um de: `dose`, `delegar`, `perguntar`, `responder`.
  - `dose`: lista de `{ ref, fato }`, com `fato` ∈ `tomou | nao_tomou | desfazer`.
  - `delegar`: `{ especialista, relacao_pendencia }`, com `relacao_pendencia` ∈ `responde | novo | sem_pendencia`, mais os campos extraídos quando a categoria for de extração.
  - `perguntar`: as referências candidatas, quando não dá para saber a qual dose a pessoa se refere.
- Um turno pode ter dose **e** outra coisa (ex.: "Comprei 60 comprimidos / Sim"): nesse caso `esperado` traz as duas partes.
- `observado_producao` registra o que o sistema de hoje fez, tirado de `agent_logs`, `dose_logs` e dos logs do Railway já analisados. Serve de baseline sem custo de API.

## 3. Composição (alvo: ~75 itens)

| Categoria | Alvo | Itens obrigatórios |
|---|---|---|
| `dose` | 25 | "Yes" com dose esgotada (João 24/09) · "Ontem eu tomei" com três esgotadas (João 26/09) · "Yes" com dose pendente durante `cad_estoque` (Guilherme 26/09 13:21) · "Yes" **citando** o lembrete (Guilherme 26/09 13:25) · "Simmm"/"Simm"/"Sim" com dose `sem_estoque` (Eloísa 22–26/09) · "Comprei 60 comprimidos / Sim" (Flávia 24/09) · "já tomei o Elani e já providenciei mais" (Julia 11/07) · "Não" com o sentido de "ainda não" (Fran 26/09 12:50) · "Ontem eu tomei também" (João 22/09) · as mensagens de teste do Guilherme com "ontem" (27/06–11/08: "tomei todos de hoje e de ontem", "de ontem e de sábado", "tomei a dipirona ontem", "na vdd não tomei o dipirona") · "sim" simples com um único grupo pendente (caso do atalho) |
| `delegacao` | 15 | "Quero cadastrar mais um!" e "Cadastrar medicamento semanal" em `cad_estoque` (Fran 24/09) → `delegar cadastro, novo` · "Erro" logo após cadastro (Fran 22/09) → `perguntar` · "A vitamina b12 é uma vez por semana apenas, toda segunda-feira" em `cad_estoque_lote` (Fran 22/09) → `delegar configuracao` · "30" / "Marevan 30, Kepra 29" em convite de estoque → `delegar cadastro, responde` · pedido de lista durante coleta aberta (Fran 24/09 19:54) → `delegar relatorios` |
| `horario` | 12 | `7h`, `7hrs`, `7hs`, `7 horas`, `07h`, `7:00`, `6:30h`, `6h30`, `17hs`, `12/12 hrs`, `meio-dia`, `de manhã` (este deve dar `null`) |
| `recorrencia` | 8 | "toda segunda" (Fran 22/09), "as segundas-feiras" (Fran 24/09, plural), seg a sex, fim de semana, 1x por semana com dia, dia sim/dia não, e um não representável (a cada 3 semanas) |
| `multi_med` | 6 | as mensagens multi-medicamento reais (Fran 22/09, Thaielly, Aline) |
| `estoque` | 5 | "b12" e "Puran T4 30" (dígito no nome), número seco, frasco, fração |

Regras de normalização do gabarito para as categorias de extração: horário `HH:MM` 24h; dias `seg ter qua qui sex sab dom`; ausência de recorrência é `null`, nunca a lista dos sete dias; `nome` sem a concentração; o que a pessoa não disse é `null`.

## 4. Coleta e privacidade

Coleta por consultas somente leitura em `agent_logs`, `dose_logs` e `funil_envios`. Para os itens de dose, o contexto é reconstruído a partir de `dose_logs` no instante da mensagem. **Incluir o usuário de teste do Guilherme** (`e3e838c3-…`) na categoria de dose: as confirmações dele com "ontem" são a melhor fonte de gabarito para retroativas.

O corpus vai para o repositório. Cada item guarda só o necessário: sem nome de pessoa, telefone, data de nascimento ou `user_id`. Nome de medicamento e posologia permanecem, porque são o objeto do teste.

## 5. Executor e baseline

`run.js` tem **adaptadores**, um por sistema medido:

- `producao_observada` — não chama nada. Compara `observado_producao` com `esperado`. É o baseline de `dose` e `delegacao`, com custo zero.
- `porta_atual` — chama `interpretarTurno` (a porta de hoje) para `horario`, `recorrencia`, `multi_med` e `estoque`, e compara os campos. Uma chamada por item.
- `principal_p1` — criado vazio agora. Será ligado no P1.

O relatório sai por categoria e por campo. Campos que a porta atual não representa (quantidade, dias da semana, correção) são marcados `nao_suportado_pela_porta_atual`, nunca "erro".

## 6. Revisão do gabarito

O Claude Code preenche `esperado` e marca `revisar: true` em todo item que admita mais de uma leitura. Guilherme revisa **apenas os marcados**; a conversa de planejamento confere uma amostra de 10 não marcados. Faz parte do aceite.

## 7. Critérios de aceite

- `npm run corpus -- --adaptador=producao_observada` e `--adaptador=porta_atual` rodam de ponta a ponta;
- ~75 itens, com todos os obrigatórios do §3;
- `BASELINE.md` com a data, o modelo (`claude-sonnet-4-6`) e o resultado por categoria e por campo;
- nenhuma linha de `src/` alterada; `arnes/casos.js`, `run.js`, `seeds.js`, `contexto.js` intocados; `npm run arnes` inalterado;
- nenhum dado pessoal no arquivo de itens.