# BRIEFING DE EXECUÇÃO — v45 · P1-ajustes: correções antes da promoção

**Pré-requisito:** P1 + P1-copy no `staging` (`1d51639`). O hotfix do encerramento (`execucao_v45_hotfix_encerramento.md`) segue separado, direto na `main`.
**Branch:** `staging`.
**Promoção:** P1 + copy + estes ajustes → validação manual do Guilherme no staging → migração do §8 do P1 em produção → merge `staging` → `main`.
**Governança:** nenhuma escrita em `backlog_items` (§8 depende do "sim, registra").
**Diretriz de custo:** casos afetados por commit; suíte completa uma vez, no portão.
**Numeração do arnês:** A36–A47 estão no `staging`, A48 é do hotfix; os casos novos daqui começam em **A49**.

---

## 1. Estoque gravado duas vezes, e dois autores para o mesmo fato

**Evidência (staging, 26/09 23:15, logs do Railway):** "Juvix 10, Sonex 30" com o convite de estoque do lote aberto. O principal devolveu `delegar: cadastro/responde` **e** `ações: UPDATE_STOCK, UPDATE_STOCK`. As ações gravaram (`correcao_set` 0→10 e 0→30); o runner gravou de novo (`cadastro_inicial` 10→10 e 30→30). Resultado: quatro movimentos para dois fatos, e três blocos de texto dizendo o mesmo número.

**Mesma família em produção (código anterior ao P1):** Fran 26/09 22:27 e Evandro 26/09 18:14 — o principal escreveu "Anotado! Vou registrar…" e o sistema acrescentou "📦 Estoque atualizado! Seu novo estoque de *X* é *N*".

**Regra: um fato, um autor.**
- Quando o principal delega `cadastro` (ou `configuracao`) com `relacao_pendencia: responde` e a pendência aberta é um convite de estoque, as ações de estoque (`UPDATE_STOCK`) do mesmo turno são **descartadas pelo código** (com log). Quem grava e escreve é o especialista.
- Quando o principal executa `UPDATE_STOCK` por conta própria, o texto do fato é o do código. A `message` do principal não repete o número nem narra a gravação ("vou registrar…"); pode acolher, sem o fato.

**Aceite:** em qualquer turno, o número do estoque aparece **uma vez** na resposta, e há **um** movimento de estoque por medicamento.

## 2. Ponte no fim do onboarding

Na copy do P1, a abertura ficou só "Prontinho, {nome}, tudo guardado! 📝" e a frase de ligação com o cadastro se perdeu. Texto do fim do onboarding (`renderizarConviteAoPrimeiroCadastro`):

```
Prontinho, {nome}, tudo guardado! 📝

Agora, pra seguirmos com o cadastro dos seus remédios, pode me mandar tudo de uma vez, se quiser:
• o nome do remédio
• quanto você toma por vez
• os horários

Por exemplo: Losartana 50mg, 1 comprimido, 8h e 20h
```

Sem data de nascimento, a abertura continua "Tudo bem, {nome}! 🌿", com a mesma ponte. Os outros pontos de uso do convite único (cadastro novo, item 10, falha de identificação) **não mudam**.

## 3. "quantos unidades"

Evidência (staging, 26/09): "Se souber quantos unidades você tem…" (Topiramato, 23:00) e "quantos unidades tem em casa" (Resilex, 23:34). Os dois textos montam `quantos ${rotulo}` sem concordância: `schemas/cadastro.js` (~l.339) e `templates/estoqueTemplates.js` (~l.119).

O pronome passa a concordar com o rótulo, a partir de um mapa único ao lado de onde o rótulo é definido: *quantos* comprimidos, frascos, sachês, ml · *quantas* unidades, cápsulas, gotas.

## 4. Convite de estoque repetido depois da confirmação de dose

Evidência (staging, 26/09 23:00): a confirmação do Topiramato trouxe o convite ("📦 Ainda não tenho o estoque do *Topiramato* cadastrado…") **e**, logo abaixo, a retomada da coleta ("E quando quiser me falar do estoque, tô aqui 🌿") — o mesmo convite duas vezes.

Regra: quando o alerta pós-confirmação já traz o convite de estoque do mesmo medicamento cuja pendência é o convite de estoque, a linha de retomada é omitida.

## 5. "Ainda não" por padrão (decisão de 26/09)

**Evidência (produção, Evandro, 27/09 17:00, logs do Railway):** "Posso alterar a dose do Marevan para dias alternados?" → porta: `configuracao` → configuração: `nao_suportado` (classificação **certa**) → devolveu o turno → porta: `configuracao` de novo → `nao_suportado` de novo → "Escalada dupla — repergunta segura" → "desculpa, não consegui te entender direito". Um pedido claro virou "não entendi".

**Causa:** só é "ainda não" o que está escrito na lista `AINDA_NAO`; o resto cai no vazio entre as listas. E o especialista que não executa devolve o turno em vez de dizer que não faz.

**Regra nova do inventário:** FAZ e NUNCA são listas **fechadas**. Todo pedido de capacidade que não mapeia para o FAZ (dentro do limite) nem para o NUNCA é **"ainda não" por padrão**. A lista `AINDA_NAO` deixa de ser a fronteira e passa a ser o registro dos casos já conhecidos (rótulo para o texto e para o dashboard). Atualizar o cabeçalho de `inventario.js` com a postura.

**5.1 Principal.** A seção "O QUE A NAMI AINDA NÃO FAZ" do prompt passa a enunciar a regra acima, com a lista como exemplos. Ao delegar `nao_suportado`, o principal devolve também `pedido`: uma paráfrase curta do que a pessoa pediu, com as palavras dela (e, quando houver, `chave_ainda_nao`, como no §8 da copy). A `message` segue a referência de tom abaixo, com variação, sem prometer prazo (regra 6):

> Entendi, {nome} — você quer {pedido}. Isso eu ainda não consigo fazer: ainda estou em desenvolvimento e aprendendo coisas novas. 🌿

Se houver algo próximo que a Nami faz, pode oferecer em uma frase.

**5.2 Especialista que não executa.** Quando um especialista classifica `nao_suportado` (hoje: a configuração), ele **não devolve o turno**. Retorna `{ naoSuportado: true }`, e o turno volta ao principal **uma única vez** com a marca "especialista entendeu e não executa"; o principal escreve a resposta do §5.1. Se o principal falhar, a reserva é `respostaHonestaAindaNao(chave)` ou, sem chave, o texto do §5.1 com o `pedido`. Procurar outros especialistas com a mesma devolução de `nao_suportado` e aplicar igual.

**5.3 "Não entendi"** (pergunta segura) fica **só** para quando a Nami realmente não entendeu ou a interpretação falhou. A escalada dupla continua como rede contra laço real, mas quando a segunda classificação é `nao_suportado` a resposta é a do §5.1.

**5.4 Pedido misto NUNCA + ainda não** (ex.: "Posso alterar a dose…?"): a parte médica recebe a postura do NUNCA, sem "ainda" (a decisão sobre a dose é do médico); a parte do lembrete recebe o "ainda não". Uma mensagem só.

**5.5 Registro dos pedidos (aprovado em 26/09).** Todo "ainda não" grava um evento em `system_events` — o tipo `intencao_nao_suportada` já existe no CHECK, e hoje só é gravado quando o principal classifica direto (2 eventos em produção, ambos de 27/07, com título genérico). Passa a gravar em **todos** os caminhos, com:
- `origem: 'porta'`, `severidade: 'baixa'`, `status_triagem: 'novo'`;
- `titulo`: "Ainda não: {pedido}" (truncado);
- `payload`: `{ pedido, especialista, chave_ainda_nao | null, misto_com_nunca: bool }`;
- `agent_log_id` do turno.

É a lista de demanda para o roadmap. Nenhuma migração necessária.

## 6. Caso conhecido novo no inventário

Acrescentar a `AINDA_NAO`:

```
{ chave: 'alterar_frequencia', rotulo: 'mudar a frequência (dias da semana ou dia sim, dia não) de um remédio já cadastrado', escopo: 'configuracao' }
```

E o `limites` da capacidade de configuração passa a dizer isso. A capacidade em si vai para o P4 — **o cadastro de um remédio novo com dias da semana ou dia sim, dia não já funciona** (caminho unitário) e não muda.

## 7. Arnês

| Caso | Entrada | Asserção central |
|---|---|---|
| A49 | "Juvix 10, Sonex 30" com convite de estoque do lote aberto | um movimento por medicamento; cada número uma vez na resposta |
| A50 | "120" respondendo a pergunta de estoque fora de coleta (principal com `UPDATE_STOCK`) | número uma vez; nada de "vou registrar" |
| A51 | fim do onboarding com data | texto do §2, com a ponte |
| A52 | convite de estoque para comprimido e para unidade | "quantos comprimidos" / "quantas unidades" |
| A53 | "Yes" com dose pendente durante convite de estoque aberto do mesmo remédio | convite aparece uma vez só |
| A54 | "Posso alterar a dose do Marevan para dias alternados?" (Evandro) | nenhuma pergunta segura; resposta nomeia o pedido; parte médica sem "ainda"; um evento `intencao_nao_suportada` com `pedido` no payload |
| A55 | pedido fora de todas as listas (ex.: "consegue me lembrar de beber água?") | "ainda não" por padrão; evento gravado |

Suíte completa uma vez, no portão.

## 8. Registros propostos (só com "sim, registra")

- BUG — estoque gravado duas vezes quando o principal age e delega sobre o mesmo convite (staging, 26/09).
- BUG — pedido claro fora das listas vira "não entendi" (Evandro, 27/09).
- MH — alterar a frequência de um remédio já cadastrado (P4).

## 9. Fora de escopo

A capacidade de alterar frequência (P4); correção de proposta pendente e recorrência no lote (P3); frente do tom dos templates; dashboard da lista de demanda.