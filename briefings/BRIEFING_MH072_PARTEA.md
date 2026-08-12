# BRIEFING — MH-072 Parte A: coleta de data de nascimento no onboarding

**Sessão:** v30
**Data:** 11/08/2026
**Executor:** Claude Code
**Item de backlog:** MH-072 (Parte A)

---

## 1. Objetivo

Coletar a data de nascimento de todo novo usuário durante o onboarding, logo após o
aceite da LGPD e antes do cadastro de medicamento, gravando o dado bruto em
`users.data_nascimento`.

Finalidade declarada: conhecer a idade média do público da Nami (estatística agregada).
**Não** há uso de personalização por faixa etária neste escopo.

---

## 2. Fora do escopo (não implementar)

- **Coleta retroativa**: usuários já `onboarded` na base não recebem a pergunta.
  Nenhum backfill, nenhum prompt de atualização.
- **Correção posterior da data**: não existe capacidade "alterar minha data de
  nascimento" após o onboarding. Ver risco documentado na seção 9.
- **`pareceNome()` e a pergunta dupla do recepcionista**: são a Parte B (junto com
  BUG-030 e MH-074). **Não tocar** em `pareceNome()` nesta parte.
- **Personalização de tom por idade**: não implementar.

---

## 3. Migration

Arquivo: `supabase/migrations/20260811000000_data_nascimento_users.sql`

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS data_nascimento date;

COMMENT ON COLUMN users.data_nascimento IS
  'Data de nascimento informada pelo usuário no onboarding (MH-072). Dado bruto —
   idade é sempre calculada em tempo de consulta, nunca armazenada.';
```

**Aplicação manual via SQL Editor do Supabase** (padrão do projeto — migrations não são
auto-aplicadas). Confirmar aplicação antes de considerar o item entregue.

Notas:
- `nullable` no banco por necessidade estrutural: o usuário pode recusar informar (ver
  seção 6.4), e usuários pré-existentes não têm o dado.
- Coluna na tabela `users` → já coberta pela cascata de `excluirContaUsuario`. **Nenhuma
  alteração necessária em `excluirContaUsuario`.** Verificar e confirmar, não alterar.
- Guardar **data**, nunca idade. Princípio 19: métrica derivada não substitui a bruta.

---

## 4. Novo módulo: `src/dataNascimento.js`

Módulo determinístico, sem chamada de LLM. Responsabilidade única: dizer **o que** uma
mensagem contém, não se ela "serve" para o campo esperado.

### 4.1 Função principal

```js
export function extrairComponenteData(mensagem, campoEsperado)
```

`campoEsperado` ∈ `'dia' | 'mes' | 'ano'`

Retorno:

```js
{ tipo: 'dia'|'mes'|'ano'|'data_completa'|'ambiguo'|'indeterminado', valor, candidatos }
```

- `dia` / `mes` / `ano` → `valor` é inteiro
- `data_completa` → `valor` é `{ dia, mes, ano }`
- `ambiguo` → `candidatos` é array de tipos possíveis (ex: `['dia','mes']`)
- `indeterminado` → `valor` é `null`

### 4.2 Regra de desempate (determinística, nesta ordem)

1. Se a mensagem casa com data completa (`dd/mm/aaaa`, `dd-mm-aaaa`, `dd.mm.aaaa`,
   `dd de <mês> de aaaa`) → `data_completa`.
2. Se o valor extraído **cabe no `campoEsperado`** → retorna `campoEsperado`.
   (Ex: "12" na etapa do dia → `dia: 12`. Não perguntar se ele quis dizer dezembro.)
3. Se **não cabe** no esperado mas cabe em exatamente um outro campo → retorna esse
   outro campo. (Ex: "novembro" na etapa do dia → `mes: 11`.)
4. Se não cabe no esperado e cabe em mais de um outro campo → `ambiguo`.
5. Caso contrário → `indeterminado`.

### 4.3 Normalização e tolerância linguística

Aplicar antes de qualquer match: `lowercase`, remoção de acentos, `trim`, colapso de
espaços múltiplos.

Reconhecer:
- **Numerais**: `7`, `07`, `dia 7`, `no dia 7`, `sou do dia 7`
- **Números por extenso (1–31)**: `um`, `dois`, `tres`, ... `trinta e um`
- **Ordinal**: `primeiro` → 1
- **Meses**: nome completo (`janeiro`…`dezembro`), abreviação (`jan`, `fev`, `mar`,
  `abr`, `mai`, `jun`, `jul`, `ago`, `set`, `out`, `nov`, `dez`), com e sem acento
- **Tolerância a erro de digitação em nome de mês**: distância de Levenshtein ≤ 1 contra
  a lista dos 12 nomes e das 12 abreviações. Cobre `nvembro`, `marco`, `fevereito`.
  Aplicar **apenas** a nomes de mês — nunca a números.

Faixas de validade:
- `dia`: 1–31
- `mes`: 1–12
- `ano`: 4 dígitos, entre `(ano atual − 110)` e `ano atual`

**Ano de 2 dígitos → `indeterminado`, nunca inferência.** "60" pode ser 1960; "25" é
ambíguo entre 1925 e 2025. Repergunta com exemplo explícito.

### 4.4 Validação de montagem

```js
export function montarDataNascimento({ dia, mes, ano })
```

Retorna `{ valida: true, iso: 'YYYY-MM-DD' }` ou `{ valida: false, campoARefazer: 'dia' }`.

Verificar:
- Data existe no calendário (31/02, 31/04, bissexto)
- Não está no futuro
- Idade resultante entre 0 e 110

Quando a combinação é inválida, **reperguntar o dia** — é o campo com maior chance de
erro; o mês é declarado com mais confiança (nome por extenso ou abreviação).

---

## 5. Novo estado conversacional: `coletando_nascimento`

### 5.1 Contexto

```js
{
  etapa: 'nasc_dia' | 'nasc_mes' | 'nasc_ano' | 'nasc_confirmacao',
  dia: null,
  mes: null,
  ano: null,
  mensagem_inicial: '<preservada do recepcionista>',
  tentativas_indeterminado: 0
}
```

### 5.2 `mensagem_inicial` é obrigatória e não pode se perder

O fechamento do fluxo precisa retomar o que o usuário pediu na chegada
("agora sim, {nome}, vamos cadastrar a losartana"). A `mensagem_inicial` deve ser
propagada do contexto do recepcionista para o contexto de `coletando_nascimento` e
sobreviver a todas as etapas.

Princípio: *nunca ignore o que o usuário disse na chegada*. Este estado novo é
exatamente o tipo de lugar onde esse contexto se perde.

---

## 6. Lógica de turno

Para cada mensagem recebida em `coletando_nascimento`, nesta ordem:

### 6.1 Extração

Chamar `extrairComponenteData(mensagem, campoEsperado)`.

### 6.2 Despacho por tipo

| Resultado | Ação |
|---|---|
| `data_completa` | Preenche `dia`/`mes`/`ano`, pula direto para `nasc_confirmacao` |
| tipo == campo esperado | Preenche, avança para a próxima etapa |
| tipo == campo **já preenchido** | **Correção implícita**: sobrescreve, confirma a correção e repete a pergunta da etapa atual |
| tipo == campo ainda não preenchido (futuro) | Preenche esse campo, permanece na etapa atual e repete a pergunta |
| `ambiguo` | LLM pergunta qual dos candidatos o usuário quis dizer |
| `indeterminado` | Vai para 6.4 |

**A correção implícita é o mecanismo único de correção.** Não criar lista de palavras
como "na verdade", "errei", "corrige" — isso reintroduziria o antipadrão do princípio 14.
Se o extrator devolve um tipo cujo campo já está preenchido, isso *é* a correção.

Exemplo: etapa do ano, `dia=12` já preenchido, usuário diz "na verdade o dia é 10" →
extrator devolve `dia: 10` → sobrescreve → *"Corrigi para dia 10! E em que ano você
nasceu?"*

### 6.3 Perguntas com exemplo explícito

Reduzir a variação na origem, não só absorvê-la depois. A LLM redige com o tom da Nami,
mas o exemplo de formato é obrigatório em todas as três:

- Dia: *"Em que dia do mês você nasceu? Pode mandar só o número — por exemplo: 7"*
- Mês: *"E de qual mês? Pode escrever o nome — por exemplo: março"*
- Ano: *"E em que ano? Os quatro números — por exemplo: 1958"*

### 6.4 Tratamento de `indeterminado`

Só neste ramo há chamada de LLM classificadora. Vocabulário de saída:

`recusa | duvida | nova_intencao | ruido`

| Classificação | Ação |
|---|---|
| `recusa` | Responder com acolhimento, **sem insistir e sem tentar convencer**. Encerrar a coleta sem o dado e seguir para o pós-onboarding (seção 7) |
| `duvida` | Explicar em uma frase que serve para personalizar melhor o atendimento, **e oferecer explicitamente a saída**. Se o usuário recusar depois disso, tratar como `recusa` |
| `nova_intencao` | Abandonar a coleta e escalar para o classificador central (`despacharEscalada`). A data fica sem preencher — não voltar depois |
| `ruido` | Repetir a pergunta com o exemplo. Incrementar `tentativas_indeterminado` |

**Saída de emergência obrigatória**: quando `tentativas_indeterminado >= 3`, oferecer
espontaneamente pular a etapa. O usuário nunca fica preso — é princípio não-negociável
do projeto.

### 6.5 Confirmação e gravação

Em `nasc_confirmacao`, ler a data montada de volta para o usuário. Uma resposta que o
extrator classifique como componente de data já preenchido nesse turno aciona a correção
implícita de 6.2 (mesmo código, sem ramo especial).

Gravação: `updateUser(user.id, { data_nascimento: iso })` — **ponto de escrita único**,
uma vez só, depois de `montarDataNascimento` retornar `valida: true`. Nunca gravar campo
a campo.

---

## 7. Saída do fluxo

Ao encerrar (com data gravada **ou** por recusa), reproduzir a decisão de roteamento que
hoje vive em `recepcionista.js` (linhas ~315-330):

- Se `mensagem_inicial` indica intenção de cadastro → `saveConversationState(user.id,
  { state: 'adding_med', context: { etapa: 'cad_nome' } })`
- Caso contrário → `saveConversationState(user.id, { state: 'post_onboarding', context: {} })`

**Extrair essa decisão para uma função própria** (ex:
`definirEstadoPosOnboarding(user, mensagemInicial)`).

Motivo — **não** é evitar duplicação: depois desta mudança o recepcionista deixa de fazer
esse roteamento (ele passa a mandar para `coletando_nascimento`), então existe um único
chamador, não dois.

O motivo real é que o `querCadastrar` embutido ali é **mais uma lista de palavras-chave**
— mesma família do `pareceNome()`, mesmo antipadrão do princípio 14. "Quero começar",
"vamos lá", "pode ser" não estão na lista e caem no `post_onboarding` errado. Isolar num
ponto nomeado tira a heurística de dentro do handler e deixa o alvo visível para a
Parte B, onde as listas de palavras do onboarding são substituídas por classificação
semântica. Embutido no meio do fluxo de data, sairia do radar.

**Alvo declarado da Parte B**, junto com `pareceNome()`.

Mensagem de fechamento retoma o pedido original:
*"Maravilha, {nome}! Anotei aqui 📝 Agora vamos ao que você me pediu — cadastrar a
losartana. Qual a dosagem?"*

---

## 8. Alterações em arquivos existentes

### 8.1 `src/agentes/recepcionista.js`

**a) Texto da LGPD** (etapas `recep_coleta_nome` e `recep_lgpd_reapresentacao`): incluir
a data de nascimento no que é consentido. Hoje diz "nome e telefone". Coletar um dado
fora do que foi consentido é falha de conformidade.

Sugestão: *"preciso guardar seu nome, telefone e data de nascimento"*.

**b) Ponte para a coleta** (etapa `recep_lgpd`, ramo de aceite): o prompt hoje instrui a
emendar direto no cadastro de medicamento. Passa a instruir a fazer a **primeira
pergunta da data (o dia)**, mantendo a referência ao pedido original do usuário.

Isso é necessário porque o turno do aceite já produz uma resposta — sem essa ponte,
seriam duas mensagens seguidas da Nami.

**c) Transição de estado** (bloco `if (lgpdAccepted)`): substituir a chamada a
`definirEstadoPosOnboarding` por:

```js
await saveConversationState(user.id, {
    state: 'coletando_nascimento',
    context: {
        etapa: 'nasc_dia',
        dia: null, mes: null, ano: null,
        mensagem_inicial: context.mensagem_inicial || '',
        tentativas_indeterminado: 0
    }
});
```

**`onboarded: true` e `lgpd_accepted: true` continuam sendo gravados neste momento, sem
alteração.** O consentimento é persistido no instante em que acontece. Se o usuário
abandonar a conversa no meio das três perguntas, ele volta já onboarded e a LGPD **não**
é pedida de novo.

**d) Não tocar em `pareceNome()`** — Parte B.

### 8.2 `src/router.js`

Novo ramo, posicionado **depois** do portão de exclusão de conta (bloco 3) e **antes** de
`post_onboarding` (bloco 4):

```js
} else if (currentState === 'coletando_nascimento') {
    agentName = 'data_nascimento';
    response = await handleDataNascimento({ user, message, state, historicoConversa });
```

Ordem justificada: o portão de exclusão de conta (MH-020) tem precedência sobre todos os
fluxos para usuário `onboarded`, e o usuário nesta etapa já está `onboarded`. Um pedido
de exclusão durante a coleta deve ser atendido.

**Inventário do classificador (`AGENTES E SUAS CAPACIDADES`, ~linha 355): não alterar
nesta parte.** Verificado: o inventário lista agentes invocáveis por intenção do usuário,
e a Parte A não cria nenhum. O escape por `nova_intencao` usa as categorias que já
existem.

---

## 9. Risco documentado (registrar, não resolver aqui)

Depois desta entrega, o usuário passa a ter uma data de nascimento gravada — e **não
existe capacidade de corrigi-la**. Uma mensagem como "minha data de nascimento está
errada" não tem categoria no classificador central e cairá em `principal` ou
`nao_suportado`.

Essa é exatamente a superfície do modo de falha confirmado do MH-020 (capacidade sem
entrada correspondente no inventário → LLM fabrica diálogo). Aqui o risco é menor porque
não estamos *adicionando* um agente sem registrá-lo — estamos deixando uma lacuna
conhecida.

Escopo da lacuna, com precisão:
- **Durante** a coleta, a correção funciona — é o mecanismo da seção 6.2, inclusive
  depois da leitura de conferência.
- **Depois** que o estado sai de `coletando_nascimento`, a janela fecha. Inclusive no
  turno imediatamente seguinte.

**Decisão (v30): não implementar janela de tolerância.** Uma regra especial de "aceita
correção por mais um turno" acopla o fluxo de data ao turno seguinte por um ganho
estreito. A lacuna é fechada corretamente por uma capacidade de **editar dados
cadastrais depois do onboarding** — item próprio, `MH-075`, fora do escopo desta parte.

`MH-075` deve, quando for implementado, incluir entrada no inventário do classificador do
`router.js` no mesmo commit (princípio da disciplina de inventário).

---

## 10. Critérios de aceite

Cada cenário deve ser validado em produção antes de mover o item para `resolvido`.

| # | Entrada | Esperado |
|---|---|---|
| 1 | Fluxo feliz: `7` → `março` → `1958` | Grava `1958-03-07`, fecha retomando o pedido original |
| 2 | `15/03/1960` na etapa do dia | Aceita a data inteira, pula direto para confirmação |
| 3 | `novembro` na etapa do dia | Reconhece como mês, anota, repergunta o dia |
| 4 | `dia dois` | Reconhece 2 |
| 5 | `nvembro` | Reconhece novembro (Levenshtein ≤ 1) |
| 6 | `60` na etapa do ano | `indeterminado` → repergunta com exemplo de 4 dígitos. **Não** grava 1960 |
| 7 | Etapa do ano, usuário diz `na verdade o dia é 10` | Sobrescreve dia, confirma, repergunta o ano |
| 8 | `31` + `fevereiro` + `1990` | Detecta combinação inválida, repergunta **o dia** |
| 9 | `nossa que chato, não quero mais` | Acolhe, encerra sem o dado, segue para cadastro |
| 10 | `pra que você precisa disso?` | Explica em uma frase e oferece a saída |
| 11 | `na verdade quero cadastrar meu remédio agora` | Escala para o classificador, abandona a coleta |
| 12 | 3 respostas ininteligíveis seguidas | Oferece pular espontaneamente |
| 13 | Abandona após aceitar LGPD, volta 2 dias depois | Volta já `onboarded`, LGPD **não** é pedida de novo |
| 14 | Usuário pré-existente na base manda mensagem | **Não** recebe a pergunta em momento nenhum |
| 15 | Primeira mensagem foi "quero cadastrar losartana" | Mensagem de fechamento cita a losartana |

---

## 11. Itens de backlog a escrever

Executar via `src/backlog.js` (`registrarItemBacklog` / `atualizarStatusBacklogItem`),
nunca SQL direto.

**Registrar:**
- `MH-072` Parte A — "Coleta de data de nascimento no onboarding" — prioridade `alta`,
  status `em_validacao` após deploy
- `MH-072` Parte B — "Recepcionista: separar classificação de geração" — prioridade
  `alta`, status `aberto`
- `MH-073` — "Gestão de medicamento em gotas" — prioridade `alta`, status `aberto`
- `MH-074` — "Pergunta funcional não exige nome nem LGPD" — prioridade `alta`, status
  `aberto`, relacionado a `MH-072` Parte B
- `MH-075` — "Editar dados cadastrais após o onboarding (nome e data de nascimento)" —
  prioridade `media`, status `aberto`, relacionado a `MH-072`. Exige entrada no
  inventário do classificador quando implementado. Também é o caminho de remediação para
  usuários gravados com nome incorreto pelo BUG-030

**Atualizar prioridade para `alta`:**
- `MH-009` (dashboard de gestão/monitoramento) — hoje `media`
- `MH-040` (mensagens fracionadas) — hoje sem prioridade

**Vincular:**
- `BUG-030` → relacionado a `MH-072` Parte B, prioridade `alta`. **Permanece `aberto`
  após esta entrega** — a Parte A não o resolve.

---

## 12. Ordem de execução sugerida

1. Migration + aplicação manual no SQL Editor + confirmação da coluna
2. `src/dataNascimento.js` (extrator + montagem) — puro, testável isoladamente
3. `src/agentes/data_nascimento.js` (máquina de turno + prompts)
4. Extração de `definirEstadoPosOnboarding` compartilhada
5. Alterações no `recepcionista.js` (LGPD, ponte, transição)
6. Ramo no `router.js`
7. Deploy + validação dos 15 cenários
8. Escritas de backlog da seção 11