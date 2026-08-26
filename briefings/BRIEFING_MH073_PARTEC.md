# BRIEFING — MH-073 Parte C: estoque aproximado de frasco já aberto

**Sessão de origem:** v36 (planejamento) · **Relacionado:** MH-073 (Partes A/B/B.1/B.2/B.3 já
entregues e validadas) · **Fora de escopo, deliberadamente:** Parte D (unidade correta em ~34
pontos de texto), Parte E (revisão de limiar de alerta e reset no momento da recompra de frasco
lacrado), ACH-2 (portão do scheduler `estoque_atual <= 0`).

---

## ⚠️ AÇÃO BLOQUEANTE — aplicar ANTES do deploy do código desta Parte

Migration nova, duas colunas booleanas (dimensão ortogonal, não um novo valor de
`stock_movements.tipo` — ver seção 6):

```sql
ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS estimado boolean NOT NULL DEFAULT false;

ALTER TABLE medications
    ADD COLUMN IF NOT EXISTS estoque_estimado boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN stock_movements.estimado IS
  'true quando o valor não veio de contagem exata (fração de frasco aberto, piso de segurança
   por falta de resposta, ou valor exato autorrelatado num frasco já aberto). MH-073 Parte C.';
COMMENT ON COLUMN medications.estoque_estimado IS
  'Snapshot vivo — true enquanto o valor atual de estoque_atual não vier de contagem exata.
   Consumido pela Parte E (limiar de alerta) e resetado para false na recompra com frasco
   lacrado (Parte E). MH-073 Parte C.';
```

Sem essa migration aplicada primeiro, o código desta Parte quebra na primeira chamada de
`registrarMovimentoEstoque` que tentar gravar `estimado`.

---

## 1. Objetivo

A Parte B cobre bem o cadastro de líquido quando o usuário tem um frasco **lacrado** — conta
frascos, lê o volume do rótulo, multiplica. O texto atual da etapa já é explícito sobre essa
fronteira: exige a palavra "fechados" na pergunta, com o comentário no código *"frasco aberto não
é tratado como cheio"*. O projeto sabia, desde a Parte B, que existe um caso fora dessa cobertura
e decidiu adiá-lo — é exatamente o que esta Parte C resolve.

Quem começa a usar a Nami no meio de um tratamento líquido (colírio, xarope, gotas) normalmente
já tem um frasco **em uso**, não lacrado — e não há como medir ml restante a olho nu. Hoje, uma
resposta como "não tenho fechado, só um que já uso" cai em `estoque_indeterminado` e a Nami repete
a mesma pergunta indefinidamente.

Esta é a primeira parte do projeto em que um valor de estoque nasce como **estimativa**, não como
contagem exata — por isso foi isolada desde a v33 como o item de maior risco de UX do MH-073.

---

## 2. Fluxo — visão geral

```
cad_tipo_tratamento
        ↓
cad_estoque  (pergunta MUDA: status do frasco, não mais "quantos fechados")
        ↓
   ┌────┴────┐
 fechado    aberto
   │          ↓
   │    cad_estoque_fracao  (NOVA)
   │          │
   └────┬─────┘
        ↓
cad_estoque_volume  (REORDENADA — agora sempre por último)
        ↓
cad_confirmacao  (3 variantes de resumo, ver seção 7)
```

---

## 3. Etapa `cad_estoque` — pergunta e classificador novos

**Substituir a pergunta atual** ("Quantos FRASCOS fechados você tem agora?") por:

> "O frasco de {nome} já está aberto (você já está usando) ou ainda está fechado (nunca foi
> aberto)?"

**Classificador novo `classificarStatusFrasco(message)`** — LLM, categorias fechadas:
`aberto | fechado | indeterminado`. **Não implementar como lista de palavras/regex** — é
exatamente o antipadrão que já custou caro no projeto (BUG-030, BUG-088, BUG-036, todos listas de
exclusão de palavras que uma variação de linguagem real furava). Segue o mesmo padrão já usado em
`classificarPosologia`/`classificarEstoqueSolido`: chamada pequena, `max_tokens` baixo,
`temperature: 0` (é classificação, não redação — mesmo motivo do juiz offline, v26), com `degradar()`
no catch (nunca falha em silêncio — Princípio 29/31). Fallback nunca em `aberto` nem `fechado` —
sempre `indeterminado` quando o parse falhar.

Se a mesma mensagem já trouxer a fração ou o valor de estoque (ex: "já uso, tá acabando, é de
60ml"), aproveitar na mesma extração da mensagem inicial (ver seção 8) — não reperguntar o que já
foi dito (Princípio 1).

**Ramo `fechado`:** segue para a etapa de contagem de frascos, **sem mais exigir a palavra
"fechados"** — a ambiguidade que motivava essa exigência já foi resolvida por esta etapa. Nova
pergunta:

> "Quantos frascos de {nome} você tem?"

Extração e cálculo (frascos × volume) permanecem exatamente como já existem — sem mudança de
lógica, só de texto.

**Ramo `aberto`:** vai para a etapa nova `cad_estoque_fracao` (seção 4).

**`indeterminado`:** reformula de forma instrutiva, nunca repete a pergunta idêntica:

> "Desculpe, não entendi 😊 Me diz assim: ele já está aberto, você já usou alguma coisa dele, ou
> ainda está lacrado, sem ter usado nada ainda?"

Fuga de assunto → modelo canônico da Parte B.1 (`ACOES_DE_FALHA` → `decidirEtapa` →
`despacharCadastro`), sem mecanismo novo. Adicionar `status_frasco_indeterminado` ao conjunto
`ACOES_DE_FALHA` existente.

---

## 4. Etapa nova `cad_estoque_fracao`

**Pergunta:**

> "E hoje, quanto mais ou menos ainda sobra nesse frasco? Pode ser algo como recém-aberto, 3/4,
> metade, 1/4, quase acabando — ou, se souber, me diz direto em ml."

**Extração — duas camadas, nesta ordem:**

1. **Determinística primeiro:** `extrairNumero(message)` (já existe, reaproveitado). Se achar um
   número, usa DIRETO como valor de estoque — sem passar pelo classificador de fração. Informação
   melhor que o usuário já deu nunca é substituída por uma aproximação (Princípio 1).
2. **Só se (1) não achou número:** classificador LLM `classificarFracaoEstoque(message)`,
   categorias fechadas: `recem_aberto | tres_quartos | metade | um_quarto | quase_acabando |
   nao_sei | indeterminado`. Mesmo padrão do `classificarStatusFrasco` — sem vocabulário fixo,
   `temperature: 0`, `degradar()` no catch.

**Tabela de conversão fração → número, em código, nunca no LLM (Princípio 4):**

```js
const FRACOES_ESTOQUE = {
    recem_aberto:   1.00,
    tres_quartos:   0.75,
    metade:         0.50,
    um_quarto:      0.25,
    quase_acabando: 0.10,
};
```

**`nao_sei` → aceita imediatamente, NÃO repete a pergunta, segue o cadastro.**

> "Sem problema! Vou cadastrar por enquanto com uma quantidade bem baixa, só pra não perder o
> controle do seu estoque — assim que você souber me dizer mais ou menos quanto ainda sobra (tipo
> 'metade' ou 'quase acabando'), me conta que eu já atualizo certinho 😊"

Tecnicamente: marca `contextUpdates.fracaoNaoInformada = true` e segue para `cad_estoque_volume`
normalmente (o cálculo do piso de segurança só acontece quando o volume for conhecido — ver seção
6). **Não mencionar o percentual ao usuário** (decisão explícita do Guilherme) — o piso de 10% é
detalhe interno.

**`indeterminado`** (resposta que não responde à pergunta, ex: "uso há duas semanas") — reformula
com exemplo, nunca repete igual:

> "Não peguei bem quanto ainda sobra 😊 Pode ser algo como 'metade', '1/4', 'quase acabando' — ou
> um número em ml, tipo 30ml."

Adicionar `fracao_indeterminada` ao `ACOES_DE_FALHA`. Fuga de assunto → mesmo modelo canônico da
B.1.

---

## 5. Etapa `cad_estoque_volume` — reordenada, texto corrigido

**Reordenação:** esta etapa passa a vir **sempre por último**, tanto no ramo `fechado` (quando o
número de frascos foi dado sem volume) quanto no ramo `aberto` (depois da fração/valor exato).
Texto da pergunta não muda:

> "E qual o volume desse frasco, em ml? Geralmente está no rótulo — ex: 10ml, 100ml."

**Correção de achado** (revisão de código para este briefing, não pedido original): o texto atual
da etapa, no ramo `volume_indeterminado`, instrui o LLM com *"Repita, sem citar números"* enquanto
entrega, na mesma frase, um exemplo com números ("ex: 10ml, 100ml") — instrução contraditória.
Corrigir para:

```
case 'cad_estoque_volume':
    if (context?.acaoEstoque === 'volume_indeterminado') {
        return `Desculpe, não peguei direito 😊 Repita: "Qual o VOLUME de cada frasco, em ml?
(está no rótulo — ex: 10ml, 100ml)" Não mencione posologia nem horários.`;
    }
```

---

## 6. Cálculo do estoque — sempre em código (Princípio 4)

| Caminho | `estoque_atual` | `stock_movements.estimado` |
|---|---|---|
| Frascos fechados contados | `frascos × volume` | `false` |
| Aberto + valor exato em ml | valor informado diretamente | **`true`** ⚠️ ver nota abaixo |
| Aberto + fração dada | `volume × FRACOES_ESTOQUE[bucket]` | `true` |
| Aberto + "não sei" | `volume × 0.10` (mesmo piso de `quase_acabando`) | `true` |

⚠️ **Assunção que preciso que o Guilherme confirme na revisão deste briefing** (não foi coberta
explicitamente nas decisões da sessão): o caso "aberto + valor exato em ml" grava `estimado =
true` internamente, mesmo sendo um número preciso — porque é autorrelato de um recipiente que
ninguém mede com exatidão, e a Parte E vai precisar desse sinal para decidir limiar de alerta.
**Isso NÃO muda o texto mostrado ao usuário** (seção 7) — é só o dado interno de proveniência.

`medications.estoque_estimado` recebe o mesmo valor de `estimado` do movimento mais recente —
atualizado no mesmo ponto de escrita (`registrarMovimentoEstoque`), sem função nova.

**`motivo` em `stock_movements`** diferencia os subcasos, usado pela etapa de confirmação (seção
7) para escolher o texto certo — closed set, não texto livre solto:

```
'frascos_fechados'
'aberto_valor_exato'
'aberto_fracao:<bucket>'          -- ex: 'aberto_fracao:metade'
'aberto_fracao_nao_informada'     -- piso de segurança por "não sei"
```

---

## 7. `cad_confirmacao` — três variantes de resumo (renderizadas em código, Princípio 13/28)

O LLM nunca escreve o número nem decide qual variante usar — a decisão é feita a partir do
`motivo` gravado na etapa anterior.

**Variante 1 — frascos fechados OU valor exato informado (`frascos_fechados` /
`aberto_valor_exato`):** texto igual ao que já existe hoje, **sem qualquer menção a estimativa**:

> "Estoque: 60ml (1 frasco de 60ml)."

**Variante 2 — fração informada (`aberto_fracao:*`):**

> "Estoque: aproximadamente 6ml (frasco de 60ml, você disse que está quase acabando) — vou
> guardar como estimativa, você pode corrigir quando quiser."

**Variante 3 — "não sei" / piso de segurança (`aberto_fracao_nao_informada`):**

> "Estoque: comecei com uma quantidade baixa (frasco de 60ml), porque você ainda não sabia quanto
> tinha sobrando — é só me atualizar assim que souber."

---

## 8. `primeiraEtapaFaltante` e extração da mensagem inicial (MH-80, Princípio 50)

`primeiraEtapaFaltante(context)` é a única fonte da ordem canônica do cadastro (Princípio 50) —
atualizar **só nela** a sequência do ramo líquido: status do frasco → quantidade/fração → volume
(em vez de frascos → volume).

O extrator de "tudo de uma vez" da primeira mensagem (o mesmo que já reconhece `frascos` +
`volumeFrasco` juntos numa mensagem rica) ganha dois campos novos a reconhecer, se presentes na
mesma mensagem: status do frasco (aberto/fechado) e a fração/valor de estoque. Extensão da função
existente — não é mecanismo novo.

---

## 9. Escalada e observabilidade

- Etapa nova `cad_estoque_fracao` entra no modelo canônico já entregue na Parte B.1
  (`ACOES_DE_FALHA` → `decidirEtapa` → `despacharCadastro`) — sem inventar mecanismo.
- Adicionar ao `ACOES_DE_FALHA`: `status_frasco_indeterminado`, `fracao_indeterminada`.
- Falha de parse de `classificarStatusFrasco`/`classificarFracaoEstoque` passa por `degradar()`,
  nunca em silêncio (Princípio 29/31). Chave de origem:motivo distinta para cada um dos dois
  classificadores, para a triagem em `system_events` conseguir diferenciar qual está falhando.

---

## 10. Fora de escopo (explícito, não implementar aqui)

- Revisão de `calcularAlertaEstoque`/limiar para estoque fracionário → Parte E.
- Reset da imprecisão ao repor com frasco lacrado → Parte E.
- Portão do scheduler que só dispara em `estoque_atual <= 0` → ACH-2, escopo natural da Parte E.
- Unidade correta nos ~34 pontos de texto → Parte D.
- Cenário combinado "tenho um frasco fechado E um já aberto ao mesmo tempo" — adiado
  deliberadamente (decisão desta sessão v36); tratar somente se aparecer em produção, mesmo
  critério do MH-046/v17 (não implementar sem evidência real).

---

## 11. Comando de verificação (Princípio 31, corolário)

Após implementar, rodar para confirmar que nenhuma referência à exigência antiga de "fechados" na
pergunta sobrou órfã, e que os dois classificadores novos têm cobertura de `degradar()`:

```bash
grep -n "FRASCOS.*fechados" src/agentes/cadastro.js   # deve aparecer só no ramo pós-classificação
grep -n "classificarStatusFrasco\|classificarFracaoEstoque" src/agentes/cadastro.js
grep -c "degradar(" src/agentes/cadastro.js            # deve ter aumentado em pelo menos 2
```

---

## 12. Validação em produção — cenários mínimos antes de fechar a Parte C

1. Líquido, fechado, frascos + volume numa mensagem só (não-regressão do salto existente).
2. Líquido, aberto, fração dada em resposta separada (cada um dos 5 buckets, pelo menos uma vez).
3. Líquido, aberto, valor exato em ml direto ("tem uns 40ml").
4. Líquido, aberto, "não sei" — confirmar texto da variante 3 e valor gravado (10% do volume).
5. Resposta indeterminada em `cad_estoque` e em `cad_estoque_fracao` — confirmar reformulação
   instrutiva, não repetição idêntica.
6. Fuga de assunto durante `cad_estoque_fracao` — confirmar escalada via modelo canônico da B.1.
7. Tudo numa mensagem só, incluindo status do frasco ("já uso, tá acabando, é de 60ml") —
   confirmar que `primeiraEtapaFaltante` pula direto para `cad_confirmacao`.