# ADENDO AO ENCERRAMENTO v45 — o norte da Nami no CONTEXT.md

**Execução:** "Leia o `briefings/encerramento_v45_adendo_norte.md` e execute."
**Onde:** `main` (o `CONTEXT.md` só é editado em `main`); ao final, merge `main` → `staging`.
**Escopo:** só documentação. Nenhuma linha de código, nenhuma escrita em `backlog_items`.

**Por quê:** ao fim da v45, o Guilherme consolidou os pedidos que orientaram a sessão. Três deles não existiam no repositório como requisito permanente: a confirmação de dose como inegociável (estava só na §14.3, como decisão da sessão), a arquitetura de entrada e saída únicas (a §14.7 a trata como próximo passo) e a barra de qualidade (fora do repositório, invisível para o Claude Code). O texto entra no `CONTEXT.md`, e não num documento separado, pelo P30: texto repetido em N lugares diverge no N+1.

---

## 1. §5.1 — Fundamentos de produto

Substituir o título "### 5.1 Fundamentos de produto (não negociáveis)" e a lista atual (itens 1 a 4) por:

```markdown
### 5.1 Fundamentos de produto (não negociáveis)

**Propósito.** A Nami é uma assistente virtual de saúde que ajuda a pessoa a tomar os
remédios na hora certa. Ela conversa de forma fluida — como alguém da família — e entrega
o que promete.

1. Nunca ignorar o que o usuário diz — toda mensagem merece resposta.
2. O fluxo serve o usuário, não o contrário.
3. Toda correção de bug exige causa raiz confirmada por evidência (log, código, dado).
   Hipótese apresentada como hipótese, nunca como fato.
4. Briefings são o contrato entre o chat de planejamento e o Claude Code.
5. **Confirmação de dose correta e confiável, inclusive retroativa, é inegociável.**
   Nenhuma mudança de arquitetura pode degradá-la. Quando uma capacidade que funcionava
   piora, a primeira verificação é comparar com a versão anterior do código (v45: a
   regressão veio do M1, quando a lista de palavras deixou de rotear e passou a decidir).
6. **Barra de qualidade:** sem remendos, sem over-engineering, sem becos sem saída, sem
   tom de robô. Arquitetura de nível sênior; código limpo, fácil de manter e de escalar.
   Remendo é tratar o sintoma em vez da causa (ex.: dois autores para o mesmo fato
   "resolvidos" por um filtro que apaga frases). Contenção é aceitável só quando
   declarada como contenção, com a correção estrutural registrada e agendada.
7. **Base antes de produto.** Formas farmacêuticas, áudio, foto e cuidador só são
   construídos sobre uma base em que a Nami entende as mensagens, age dentro das suas
   capacidades e contorna com honestidade o que está fora delas, sem travar em
   interações básicas.
```

## 2. Nova §5.3 — Arquitetura-alvo (requisito permanente)

Acrescentar depois da §5.2 (depois do último item da lista de princípios):

```markdown
### 5.3 Arquitetura-alvo de conversa (requisito permanente desde a v44)

Um autor conversacional, uma entrada, uma saída:

- **Entrada única.** O principal (LLM) recebe toda mensagem, interpreta, filtra, extrai
  os dados necessários com base nas capacidades da Nami (inventário) e direciona ao
  especialista. Nada determinístico interpreta linguagem antes dele (P59); a única
  exceção é o atalho do "sim" exato sob guardas de estado (§14.2).
- **Especialistas.** Recebem os dados já extraídos — não relêem o texto da pessoa —,
  agem e devolvem **fatos**, lidos do banco depois da escrita (P56).
- **Saída única.** A mensagem ao usuário é escrita pelo LLM, ancorada nos fatos do
  código, com o tom homogêneo da Nami. Fato do código nunca é reescrito ou filtrado
  (P61); se a escrita falhar na verificação, sai o texto determinístico daquele fato.
- **Correção guiada pela motivação** por trás da interação, nunca por palavra ou frase
  isolada (P60).
- **Divergência entre o desenho aprovado e o implementado é sinalizada ao Guilherme**
  no momento em que é percebida. Na v44, a decisão escrita ("portões determinísticos
  ficam antes da porta") contradisse o diagrama aprovado e não foi apontada; a v45
  existiu para desfazer isso.

Estado em 29/09/2026: entrada única entregue (§14). Especialistas ainda relêem o texto
(cadastro e configuração) e a saída ainda tem vários autores (templates e prompts) —
ver §14.6 e §14.7.
```

## 3. Referências cruzadas

- **§12.1**, na nota do topo acrescentada no encerramento da v45: ao final, acrescentar "A arquitetura-alvo permanente está na §5.3."
- **§14.7**, na primeira linha da lista: acrescentar "(requisito da §5.3)" depois de "ponto único de saída".
- **§14.3**, no primeiro item ("Confirmação de dose… inegociável"): acrescentar "(fundamento 5, §5.1)".

## 4. Cabeçalho

`**Última atualização:** 29/09/2026 (v45 — adendo: norte da Nami na §5.1 e arquitetura-alvo permanente na §5.3)`

## 5. Commit

`docs(v45): adendo — norte da Nami nos fundamentos (§5.1) e arquitetura-alvo permanente (§5.3)`
Depois: merge `main` → `staging`.