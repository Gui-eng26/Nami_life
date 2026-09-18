# BRIEFING — v43 Bloco B, Adendo 2: guia de composição visual

**Sessão:** v43 (18/09/2026)
**Branch:** `staging`
**Arquivos:** `src/templates/composicao.js` (novo), `src/agentes/recepcionista.js`,
`src/agentes/data_nascimento.js`, `src/agentes/cadastro.js`
**Depende de:** Bloco B e seu Adendo 1, ambos no `staging`

Auto-contido. Todo texto literal está embutido.

---

## 0. Evidência e causa raiz

As mensagens da jornada de chegada ficaram curtas e diretas, como decidido. Mas ficaram
**cruas**: texto linha a linha, sem hierarquia visual, com o dado importante no meio da frase.

Print real de staging, 18/09: `qual o **NOME** do medicamento` apareceu na tela do usuário com
os asteriscos visíveis em volta da palavra em negrito. No WhatsApp negrito é **um** asterisco
de cada lado; com dois, o cliente formata o par interno e desenha o externo.

**Causa raiz da inconsistência visual:** não existe regra de composição em lugar nenhum. Cada
agente monta o próprio `buildSystemPrompt` do zero, e a única orientação — "use emojis com
moderação" — está repetida solta em oito arquivos, significando coisa diferente em cada um.
É o mesmo problema que o P55 resolveu para o inventário de capacidades: **guia de composição é
dado, não texto espalhado por prompt.**

---

## 1. Novo módulo `src/templates/composicao.js`

Ponto único. Exporta uma constante de texto que os `buildSystemPrompt` importam e concatenam ao
bloco base comum a todas as etapas.

```js
// ============================================================
// GUIA DE COMPOSIÇÃO DA MENSAGEM — ponto único (mesmo padrão do P55)
// Toda mensagem escrita por LLM herda estas regras. Mensagens renderizadas em
// código (templates/) NÃO passam por aqui — ver seção 4 do briefing.
// ============================================================

export const GUIA_COMPOSICAO = `
COMPOSIÇÃO DA MENSAGEM — vale para toda mensagem que você escreve.

Curto não é cru. Uma parede de texto e uma linha seca são ruins pelo mesmo motivo: a
pessoa não acha o que importa. Mensagem curta pode e deve ser visualmente organizada.

1. Abertura, conteúdo e pergunta ficam separados por linha em branco.
2. Quando a mensagem apresenta DOIS OU MAIS itens (dados, campos, opções, etapas,
   remédios, horários), cada item fica em sua própria linha, começando por um emoji que
   represente aquele item especificamente. Nunca um emoji genérico repetido, nunca
   numeração.
3. Negrito do WhatsApp é UM asterisco de cada lado (*assim*). NUNCA use dois asteriscos:
   eles aparecem literalmente na tela do usuário. Negrito só na palavra que carrega o
   dado ou a decisão, no máximo duas por mensagem.
4. Fora da lista de itens, no máximo UM emoji na mensagem inteira, e ele marca o tom, não
   decora a frase. Nunca dois emojis seguidos. Nunca emoji no meio de uma frase.
5. A pergunta final fica sozinha na última linha.

Exemplo de mensagem bem composta:

Oi, Guilherme! 😊

Para continuar, preciso guardar algumas informações suas para personalizar seus lembretes:
✅ *nome* — já tenho aqui
☎️ *telefone* — uso esse mesmo número que está falando comigo
📅 *data de nascimento* — vou te pedir já já

Seus dados ficam protegidos e são usados só para isso. 🔒

Você concorda?
`;
```

**Dois ajustes em relação ao rascunho de Guilherme, ambos reversíveis:** `✅` no lugar de `1️⃣`
(os outros dois marcadores são ícones semânticos, um número destoa da série), e `🔒` fechado no
lugar de `🔓` aberto (cadeado aberto comunica o contrário de proteção).

---

## 2. Onde o guia entra

Importar e concatenar ao bloco base de `buildSystemPrompt`, no mesmo lugar onde hoje ficam as
instruções de tom, em **três** arquivos:

- `src/agentes/recepcionista.js`
- `src/agentes/data_nascimento.js`
- `src/agentes/cadastro.js`

```js
import { GUIA_COMPOSICAO } from '../templates/composicao.js';
```

O guia entra **uma vez** no bloco comum a todas as etapas de cada agente, nunca copiado dentro
dos blocos de etapa.

**Remover as instruções antigas que o guia substitui:** a linha "Use emojis com moderação" e
qualquer menção avulsa a negrito nesses três arquivos passam a ser redundantes. Deixar as duas
coisas convivendo é o começo da divergência que este módulo existe para evitar.

**Os outros cinco agentes ficam de fora nesta entrega** — `principal`, `configuracao`,
`relatorios`, `lembrete`, `exclusaoConta`. Não é esquecimento: aplicar em oito agentes na
véspera da feira é risco sem retorno, já que amanhã o público vive a jornada de chegada. Eles
entram na sessão seguinte, com o módulo já validado.

Consequência conhecida e aceita: até lá, o `principal` continua podendo emitir `**`.

---

## 3. Fechamento da data de nascimento — corrigir o texto longo

Evidência do mesmo teste: depois do "Anotei aqui 📝", a Nami **se reapresentou inteira**
("voltando ao começo — você veio conhecer a Nami... Basicamente, estou aqui para te ajudar a
não esquecer..."). O prompt da etapa `nasc_fechamento` manda retomar "o que a pessoa pediu
originalmente"; como o pedido original era conhecer a Nami, ele repetiu a apresentação que já
tinha sido feita dois turnos antes.

O bloco `nasc_fechamento` passa a ser:

```
  ${nome} acabou de confirmar a data de nascimento, que já foi salva. Agradeça em UMA
  expressão curta (ex: "Anotei aqui 📝") e emende DIRETO no primeiro medicamento.

  NÃO se reapresente. NÃO repita o que a Nami faz. NÃO retome a mensagem inicial —
  a pessoa já passou pela apresentação e pelo consentimento.

  Peça o primeiro remédio pedindo os três dados de uma vez, com exemplo:
  Exemplo: "Anotei aqui 📝

  Agora me conta: qual remédio você quer cadastrar? Se quiser, já manda tudo de uma vez —
  nome, quanto você toma por vez e os horários.

  Por exemplo: Losartana, 1 comprimido, 8h e 20h"
```

Isso é **copy**, não fluxo: a mensagem já pede os três campos, mas o `cadastro.js` ainda vai
perguntar campo a campo até a Fase 3 entrar (Bloco C). Pedir os três desde já não quebra nada —
o extrator do MH-80 aproveita o que conseguir — e passa a render turnos assim que o Bloco C
subir.

---

## 4. O que este adendo NÃO faz

- Não toca nas mensagens renderizadas em código (`src/templates/dose.js`,
  `estoqueTemplates.js`, `adesaoTemplates.js`, `balancoTemplates.js`). Lembrete, confirmação de
  dose, balanço do dia e estoque não passam por LLM e precisam de edição manual, uma a uma.
  Trabalho para depois da CIW.
- Não muda fluxo, estado nem persistência.
- Não cria tabela, coluna nem migração.

---

## 5. Validação em staging

| # | Teste | Esperado |
|---|---|---|
| 1 | Qualquer mensagem dos três agentes | nenhum `**` visível na tela |
| 2 | Pedido de consentimento LGPD | três itens em linhas próprias, cada um com seu emoji |
| 3 | Pergunta de nome do medicamento | negrito com um asterisco, pergunta sozinha na última linha |
| 4 | Confirmar a data de nascimento | "Anotei aqui" + pedido do primeiro remédio, **sem** reapresentação |
| 5 | Chegada completa, do QR ao primeiro remédio | nenhuma mensagem com parede de texto nem linha crua |
| 6 | Qualquer mensagem | nunca dois emojis seguidos, nunca emoji no meio de frase |

---

## 6. Backlog

Novo item a registrar, se Guilherme autorizar: **MH-095 — guia de composição visual como ponto
único, estendido aos cinco agentes restantes e às mensagens renderizadas em código.** Este
adendo entrega os três primeiros agentes; o restante é o item.