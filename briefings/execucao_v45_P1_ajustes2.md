# BRIEFING DE EXECUÇÃO — v45 · P1-ajustes 2: um autor por fato (últimos ajustes antes da promoção)

**Pré-requisito:** `staging` em `f3fd884` (P1 + copy + ajustes).
**Branch:** `staging`. Depois deste briefing: validação manual → migração do §8 do P1 em produção → merge `staging` → `main`.
**Governança:** nenhuma escrita em `backlog_items`.
**Diretriz de custo:** casos afetados por commit; suíte completa uma vez, no portão.
**Numeração do arnês:** novos casos a partir de **A56**.

**Princípio (Guilherme, 28/09):** o que orienta uma correção é a motivação por trás da interação, nunca uma frase ou palavra isolada. Nenhum texto é acionado por padrão de palavra, nem filtrado por regex. Quando o fato é do código, o texto também é.

---

## 1. "Ainda não": o texto é sempre do código

**Evidência (staging, 28/09):** duas perguntas de mesmo teor sobre mudar o Rivotril para dias alternados.
- 18:19 — o principal escreveu o texto: parte médica + "ainda não" + a oferta "cadastrar o Rivotril como um remédio novo com essa frequência". A oferta era falsa: às 18:20 o cadastro recusou, porque o Rivotril já estava ativo.
- 18:21 — o principal não escreveu, e `textoAindaNao` (`router.js`) usou o texto fixo do inventário.

**Causa (confirmada no código):** dois autores possíveis para a mesma resposta (`if (decisao?.message) return decisao.message`), e a regra do P1-ajustes §5.1 "se houver algo próximo que a Nami faz, pode oferecer" — que o principal seguiu sem saber que o cadastro recusa remédio já ativo.

**Mudança:**
- `textoAindaNao` **ignora** `decisao.message`. Com `chaveAindaNao` → `respostaHonestaAindaNao(chave)` + "Posso te ajudar com outra coisa? 🌿". Sem chave → `respostaAindaNaoPadrao({ nome, pedido })`.
- `respostaAindaNaoPadrao` deixa de mudar o texto por `mistoComNunca`. O indicador continua **só** no payload do evento `intencao_nao_suportada`.
- Prompt do principal: sai a regra de oferecer alternativa; sai a exigência de `message` no `nao_suportado`. Entra: identificar a **motivação principal** do pedido — capacidade (a Nami fazer algo) → `nao_suportado`; orientação sobre o tratamento (se pode mudar dose, parar, trocar) → postura do NUNCA, como hoje. Sem linha fixa acrescentada por palavra ("posso" ou qualquer outra).
- O registro do evento continua como está (pedido, chave, especialista, `misto_com_nunca`).

## 2. Estoque: sai o filtro por regex, entra texto do código

**Evidência (código do staging):** `limparTextoDoFatoDeEstoque` + `RE_NARRA_GRAVACAO` cortam o texto do principal em frases e apagam as que contêm o número do estoque ou palavras como "anotei", "atualizado", "registrado". Testado com três textos possíveis: o filtro apaga também informação sem relação com estoque ("seu lembrete do Losartana já está atualizado pras 21h") e perde o emoji. É regex sobre linguagem natural, contra a direção do projeto.

**Mudança:**
- Remover `limparTextoDoFatoDeEstoque` e `RE_NARRA_GRAVACAO` (grep-guard no A0).
- Turno em que o principal executa `UPDATE_STOCK`: a `message` do principal **não é usada**. A resposta é montada pelo código, no mesmo formato da confirmação de dose (copy §2.1):

```
{abertura} 📦 Estoque do *{remédio}* atualizado: *{N}* {rótulo}.
```

  - `{abertura}`: a mesma lista de seis aberturas da confirmação de dose ("Boa, {nome}!", "Perfeito, {nome}!", "Isso aí, {nome}!", "Que bom, {nome}!", "Tudo certo, {nome}!", "Show, {nome}!"), escolhida diferente da última usada com a pessoa.
  - `{rótulo}`: o da forma do remédio (comprimidos, cápsulas, gotas…), com a concordância do P1-ajustes §3 — nunca "unidades" para comprimido.
  - Mais de um remédio: uma linha `📦` por remédio, abertura uma vez só.
- Turno com dose **e** estoque (ex.: "Comprei 60 comprimidos / Sim"): uma abertura, a linha da dose, a linha do estoque.
- A regra do P1-ajustes §1 continua: quando a delegação responde a um convite de estoque, as ações de estoque do principal são descartadas e o especialista é o autor.

## 3. Correção: o gatilho é a intenção, não a palavra "erro"

**Origem:** a regra do prompt do principal escrita no P1-copy §6 está redigida em torno de palavras (`prompts.js`, ~l.164: `"ERRO" SEM DIZER O QUÊ: "Erro", "tá errado", "errou" sem apontar o quê → "perguntar"`). A Fran usou "Erro" numa situação em que algo não estava como ela queria; outra pessoa dirá "não era isso", "tá diferente do que te falei", "hmm, não", ou vai direto ao valor certo ("é 18:30"). A regra por palavra reconhece uma forma e perde as outras — o mesmo problema da regex, dentro do prompt.

**Mudança:** substituir o bloco `"ERRO" SEM DIZER O QUÊ` por uma regra de **intenção**:

> INTENÇÃO DE CORRIGIR: quando a pessoa mostra que algo que a Nami fez ou registrou não ficou como ela queria — um dado de um remédio, um horário, uma dose confirmada ou não —, o que conta é a intenção de mudança, nunca as palavras usadas.
> - Se ela já disse o que mudar (nesta mensagem ou numa anterior do histórico) → encaminhe para quem é dono do dado: remédio já cadastrado → `delegar configuracao` (relação "novo" se não responde à pergunta aberta); cadastro ainda em andamento → `delegar cadastro, responde`; dose → `doses[].fato` no bloco de doses (ex.: `desfazer`).
> - Se ela não disse o quê → `perguntar` o que ela quer mudar, referindo-se ao que acabou de ser feito, sem supor o campo. Referência de tom (aprovada em 26/09), não texto fixo: "Poxa, me desculpa! O que ficou errado — o nome, o horário, a quantidade ou outra coisa?"

Nenhuma lista de palavras de gatilho no bloco; exemplos, se houver, aparecem como ilustração de intenções diferentes, nunca como condição.

## 4. Arnês

| Caso | Entrada | Asserção central |
|---|---|---|
| A56 | "Posso alterar a dose do X para dias alternados?" e, em seguida, "Quero atualizar os dias, tomo em dias alternados" (X já ativo) | as duas respostas são o texto do código do "ainda não"; nenhuma oferece cadastrar de novo; um evento por turno |
| A57 | "Comprei 20 comprimidos do X" fora de coleta | resposta = abertura + "📦 Estoque do *X* atualizado: *20* comprimidos."; número uma vez; nenhum texto do principal |
| A58 | "Comprei 60 comprimidos / Sim" com dose aberta | uma abertura, linha da dose, linha do estoque |
| A59 | logo após cadastrar um remédio: "hmm, não foi isso que eu te falei" (sem a palavra "erro") | pergunta o que mudar; não repete o convite; nada é gravado |
| A60 | logo após cadastrar um remédio às 18:00: "não é esse horário, é 18:30" | vai à configuração e o horário passa a 18:30 (referência: teste do Guilherme em 28/09 18:30, Decadron) |

Ajustar A50, A54 e A55 ao texto do código, e A45 ("Erro" da Fran) ao bloco novo — continua verde, agora pela intenção.

## 5. Critérios de aceite

- `limparTextoDoFatoDeEstoque` e `RE_NARRA_GRAVACAO` não existem (grep-guard).
- `textoAindaNao` não lê `decisao.message`.
- O bloco `"ERRO" SEM DIZER O QUÊ` não existe mais no prompt; a regra de intenção do §3 está no lugar.
- A56–A60 verdes; suíte completa verde no portão.

## 6. Fora de escopo

O autor único de entrada e saída para toda a conversa (discussão de arquitetura seguinte, decidida pelo Guilherme em 28/09); a frente do tom dos templates; a rede de segurança do F7 ou a recorrência do P3.