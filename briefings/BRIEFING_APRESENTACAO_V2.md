# BRIEFING — Adesão ao Tratamento: Apresentação v2 (tom, formatação, saudação condicional)

**Data:** 07/07/2026
**Origem:** Revisão de design solicitada por Guilherme após validação em produção — templates
sentiam "mecânicos", pouco espaçamento, saudação repetitiva em sequências de pergunta rápida.
Conteúdo revisado com apoio do Gemini (tom/formatação) e ajustado nesta conversa.
**Escopo:** `src/templates/adesaoTemplates.js` (texto + estrutura). Nenhuma mudança em cálculo
(`database.js`) ou roteamento (`router.js`) — só apresentação.
**Regra geral, sem exceção:** todo texto abaixo é literal, aprovado por Guilherme — não parafrasear.

---

## 1. Saudação condicional — só nos templates **sob demanda**

**Onde se aplica:** relatório de adesão sob demanda (pergunta de período, recusa de período,
resposta direta) e progresso do tratamento (todas as fases + fallback contínuo + resumo compacto).
**Onde NÃO se aplica:** templates semanais e de fechamento mensal (envio automático) — mantêm
"Olá, [Nome]!" fixo, sem mudança, pois são sempre espaçados por dias.

**Mecanismo:**
```js
// Nova função em adesaoTemplates.js (ou database.js, onde fizer mais sentido no código):
async function precisaSaudacao(userId) {
    const ultimaInteracao = await getUltimaInteracao(userId); // created_at do último agent_logs
    if (!ultimaInteracao) return true;
    const minutosDesdeUltima = (Date.now() - new Date(ultimaInteracao).getTime()) / 60000;
    return minutosDesdeUltima > 10;
}
```

Todos os templates "sob demanda" (seções 3 e 4 abaixo) são escritos **sem** "Olá, [Nome]!" embutido
— a saudação é concatenada na frente do texto, condicionalmente, no momento de montar a resposta:

```js
const saudacao = await precisaSaudacao(user.id) ? `Olá, ${nome}! ` : '';
return saudacao + corpoDoTemplate;
```

---

## 2. Templates de fechamento mensal + blocos aditivos (Gemini, texto literal)

**Estes templates mantêm "Olá, [Nome]!" fixo — não entram na saudação condicional da seção 1**
(são parte do envio automático, sempre espaçado por dias).

### 2.1 — Espinha do fechamento mensal (4 faixas × 3 variações)

**Faixa 100%**

> V1: Olá, [Nome]! ❤️
> Passando para contar que fechamos o nosso mês!
> A sua taxa de adesão foi de 100%! 🎉
> Que orgulho ver o seu compromisso com você. Um mês inteirinho cuidando da saúde com tanta
> dedicação é uma vitória gigante!

> V2: [Nome], você completou o mês com 100% de sucesso! 🚀
> Esse resultado maravilhoso mostra que tomar seus medicamentos já virou uma parte natural do seu
> dia a dia.
> Parabéns por esse cuidado tão bonito com a sua vida! ✨

> V3: Que notícia linda para fechar o mês, [Nome]! 😍
> Tivemos 100% das suas doses confirmadas! 💎
> Você protegeu a sua saúde todos os dias deste mês. Parabéns por esse carinho constante com você!

**Faixa 80-99%**

> V1: Olá, [Nome]! 🌟
> Olhando para os últimos 30 dias, sua taxa de adesão foi de [Taxa]%.
> Que resultado excelente! 👏
> Você esteve super perto de acertar todas as doses. No próximo mês, vamos continuar de mãos dadas
> para manter esse ritmo ótimo!

> V2: [Nome], fechamos o mês com [Taxa]% de adesão! Muito bom mesmo! 🌸
> Para facilitar ainda mais no mês que vem, que tal deixar a cartela bem visível ao lado de algo
> que você já usa todo dia de manhã?
> Pode ser do lado da escova de dentes ou da garrafa de água! 💧

> V3: Oi, [Nome]! Passando para contar que sua adesão deste mês ficou em [Taxa]%. 🎉
> Parabéns pela regularidade!
> Deixar o ambiente preparado e os remédios fáceis de pegar ajuda muito a não pular nenhuma dose
> nos dias mais corridos. Conte sempre comigo! 🥰

**Faixa 50-79%**

> V1: Olá, [Nome]! 😊
> Analisei o nosso último mês e sua taxa de adesão ficou em [Taxa]%.
> Você se dedicou, mas sei bem que o dia a dia pode ser confuso.
> Para o próximo mês, uma dica simples é tirar os remédios do armário ou da gaveta e deixá-los bem
> à vista na mesa da cozinha ou na cabeceira da cama! 🛏️

> V2: Oi, [Nome]! Fechamos o mês com [Taxa]% de adesão. 🌻
> Estamos no caminho, mas podemos deixar essa rotina mais leve para você.
> Uma ideia que ajuda muito é usar aquelas caixinhas organizadoras divididas pelos dias da semana.
> Fica bem mais fácil de controlar e olhar! 📅

> V3: Olá, [Nome]! Sua adesão nos últimos 30 dias foi de [Taxa]%. 💕
> Para ajudar a lembrar com mais facilidade no próximo mês, tente combinar o remédio com algo que
> você já faz todo dia sem falta.
> Por exemplo: tomar logo após o café da manhã ou logo após o almoço! ☕

**Faixa <50%**

> V1: Olá, [Nome]! Estou aqui para apoiar você de pertinho. ❤️
> Olhando o nosso fechamento do mês, sua adesão ficou em [Taxa]%.
> Não desanime, criar uma nova rotina leva tempo e os primeiros passos são os mais desafiadores.
> Estou aqui para caminhar junto com você, um dia de cada vez! 🌱

> V2: Oi, [Nome]. Pensando no seu bem-estar e no seu carinho, vi que nossa taxa mensal ficou em
> [Taxa]%. 🩹
> Quero muito ajudar a deixar esse processo mais simples e tranquilo para a sua vida.
> Vamos recomeçar com calma no próximo mês, focando em dar um passo pequeno por dia para proteger
> a sua saúde! 🌤️

> V3: Olá, [Nome]! Fechamos o mês com [Taxa]% de adesão. 🤝
> Minha intenção por aqui é ser um suporte acolhedor na sua rotina, sem nenhuma cobrança.
> Vamos seguir em frente com otimismo e buscar formas bem fáceis de incluir esse cuidado no seu
> dia. Seu bem-estar é o mais importante! 🌿

### 2.2 — Bloco aditivo: motivo dominante

**Motivo "sem resposta" (nao_informado)**
> V1: 💬 Percebi que muitas das suas doses ficaram sem confirmação por aqui. Para facilitar,
> verifique se as notificações das minhas mensagens estão chegando para você! Estou aqui pra te
> ajudar! 😄

> V2: 📱 Notei que boa parte das doses ficou sem resposta no WhatsApp. Se você estiver tomando
> certinho e só não conseguir responder, tente deixar a nossa conversa fixada no topo da tela para
> facilitar!

**Motivo "não tomado" (nao_tomado)**
> V1: 💧 Vi que em alguns dias você acabou ficando sem tomar o medicamento. Uma dica amiga para
> ajudar é deixar um copo de água sempre pronto e abastecido bem do lado do seu remédio.

> V2: ☀️ Notei que algumas doses não foram tomadas no período. Não se preocupe se falhar um dia, o
> mais importante é focar a atenção para conseguir tomar o remédio certinho no dia seguinte e
> recuperar o ritmo!

**Motivo "sem estoque"**
> V1: 🛒 A maior parte das doses perdidas aconteceu porque o medicamento acabou. Eu vou sempre te
> enviar alertas de estoque antes dos seus remédios acabarem! Assim que receber a mensagem, já
> providencie a recompra!

> V2: 📦 Vi que o estoque do seu remédio acabou no período. Para não interromper o tratamento, uma
> alternativa prática é pedir para alguém buscar na farmácia ou pedir para te entregarem em casa
> um pouquinho antes do frasco esvaziar!

### 2.3 — Bloco aditivo: turno (só mensal, só nao_tomado/nao_informado)

**Manhã**
> V1: 🌅 Reparei que o período da manhã, no comecinho do dia, é o momento em que você encontra
> mais dificuldades com o medicamento.

> V2: ☀️ Notei que as primeiras horas da manhã estão sendo o horário mais desafiador para
> conseguir tomar as doses.

**Tarde**
> V1: 🌤️ Percebi que o turno da tarde é o momento em que fica um pouco mais difícil de acompanhar
> e confirmar as doses.

> V2: 🕒 O período da tarde tem sido o horário em que os compromissos do meio do dia mais
> atrapalham as suas confirmações.

**Noite**
> V1: 🌙 Notei que o período da noite é onde está acontecendo a maior parte das doses não
> confirmadas.

> V2: 🌌 Parece que o turno da noite, no cansaço do fim do dia, está sendo o momento em que fica
> mais difícil manter a regularidade.

### 2.4 — Bloco aditivo: tendência

**Adesão subiu**
> V1: 📈 E olha que conquista linda: sua adesão subiu de [TaxaAnterior]% para [TaxaAtual]%! Você
> está melhorando muito a cada dia!

> V2: ✨ Que evolução maravilhosa! Sua taxa subiu comparada ao período anterior (de [TaxaAnterior]%
> para [TaxaAtual]%). Parabéns por todo o esforço!

**Adesão caiu**
> V1: 📉 Sua taxa oscilou um pouquinho em relação ao período anterior, indo de [TaxaAnterior]% para
> [TaxaAtual]%. Fique em paz, essas variações são normais quando estamos nos acostumando com uma
> rotina nova!

> V2: 🍃 Tivemos uma leve queda comparado ao período passado, de [TaxaAnterior]% para [TaxaAtual]%.
> Vamos encarar isso como uma chance de deixar os remédios em um lugar ainda mais fácil nos
> próximos dias!

**Adesão ficou estável**
> V1: 🔍 Sua taxa se manteve firme e estável em [TaxaAtual]%, igualzinho ao período anterior.
> Manter a regularidade já é uma grande vitória!

> V2 (corrigida — emoji quebrado no original do Gemini, era `"="`): ⚖️ Você manteve a sua
> constância! Sua adesão continuou estável em [TaxaAtual]%. Seguimos no mesmo caminho firme
> cuidando da sua saúde!

**Marco especial**
> 🏆 E temos um marco histórico por aqui: esta é a sua primeira vez alcançando os 100%! O melhor
> resultado registrado desde que começamos!

## 3. Relatório de adesão sob demanda — textos atualizados (sem saudação embutida, sem numeração)

**Pergunta de período (período não especificado):**
> Posso gerar o seu relatório de adesão agora mesmo. 📝
> Para qual período você gostaria de olhar?
> Últimos 7 dias
> Últimos 15 dias
> Últimos 30 dias
> É só me dizer o período que você prefere! 👍

**Recusa gentil (período fora de 7/15/30) — remove a frase "se preferir deixar para depois":**
> Peço desculpas! 🌸
> Como ainda estou aprendendo e em constante desenvolvimento, hoje eu só consigo calcular a sua
> adesão nesses três períodos fechados: últimos 7, 15 ou 30 dias.
> Gostaria de escolher um desses três para darmos uma olhadinha hoje?

(A versão anterior desse template, ainda em produção, contém a frase "se preferir deixar para
depois, está tudo bem também" — remover definitivamente, ficou pendente de uma decisão anterior que
nunca virou código.)

**Resposta direta (`montarRespostaAdesaoDireta`) — sem mudança de conteúdo nesta rodada**, só passa
a receber a saudação condicional na frente, como todos os outros.

## 4. Progresso do tratamento — reescrito nas 3 fases + estoque + fallback + resumo compacto

**Fase Início** (percentualDecorrido < 33%):
> Vim te mostrar como está o começo do seu tratamento com [Medicamento]. 🌱
> Você está no dia [DiasDecorridos] de [TratamentoDias] — ainda bem no comecinho da jornada!
> Ao todo, restam [DiasRestantes] dias e [DosesRestantes] doses até o fim.
> [BlocoEstoque]

**Fase Meio** (33-66%):
> Seu tratamento com [Medicamento] já está na metade do caminho! 🌤️
> Você está no dia [DiasDecorridos] de [TratamentoDias].
> Faltam [DiasRestantes] dias e [DosesRestantes] doses para concluir.
> [BlocoEstoque]

**Fase Reta final** (> 66%):
> Estamos quase lá com o [Medicamento]! 🥰
> Você já está no dia [DiasDecorridos] de [TratamentoDias] — faltam só [DiasRestantes] dias e
> [DosesRestantes] doses pra terminar.
> Continue firme, você está mandando bem! 💪
> [BlocoEstoque]

**Bloco estoque — suficiente:**
> ✅ Seu estoque atual, de [Estoque] unidades, é suficiente pra terminar o tratamento
> tranquilamente.

**Bloco estoque — insuficiente (ajustado: número exato de dias cobertos, sem eufemismo):**
> ⚠️ Um aviso: seu estoque atual dá pra mais [DiasCobertos] dias — mas ainda faltam [DiasRestantes]
> dias de tratamento. Vale a pena providenciar mais em breve, pra não interromper o cuidado! 💊

**Mudança técnica exigida por este bloco:** `montarBlocoEstoque` (e quem a chama, em
`relatorioProgressoTratamento`) precisa passar a repassar `diasCobertosPeloEstoque` como variável
do template (`[DiasCobertos]`) — hoje esse valor já é calculado ali dentro (usado só pra decidir
suficiente/insuficiente), mas não é exposto no texto. Só passar o valor já calculado adiante.

**Fallback uso contínuo:**
> Como o seu medicamento é de uso contínuo, ele não tem uma data de término ou um número de dias
> pra acabar, sabe? ✨
> Ele faz parte do seu cuidado diário com a saúde a longo prazo.
> Mas se você quiser, posso te mostrar sua taxa de adesão e ver como está a sua regularidade nos
> últimos tempos. Quer dar uma olhada? 📊

**Resumo compacto (2+ tratamentos, pedido genérico):**
> Aqui está o progresso dos seus tratamentos: 💊
>
> 💊 *[Medicamento]* — dia [X] de [Y], [Z] dias restantes
> 💊 *[Medicamento]* — dia [X] de [Y], [Z] dias restantes
>
> Quer detalhes de algum específico? É só me dizer o nome! 😊

---

## 5. Ordem de execução

1. Criar/ajustar a checagem de saudação condicional (seção 1) — nova função, consulta simples em
   `agent_logs` (ou onde já exista acesso equivalente).
2. Atualizar `PERGUNTA_PERIODO`, `RECUSA_PERIODO`, `TEMPLATES_PROGRESSO`, `BLOCO_ESTOQUE`,
   `FALLBACK_CONTINUO`, resumo compacto em `adesaoTemplates.js` com os textos da seção 3/4, todos
   sem saudação embutida.
3. Ajustar `montarBlocoEstoque` pra receber e usar `diasCobertos`.
4. Ajustar os pontos em `relatorios.js` que chamam esses templates pra concatenar a saudação
   condicional na frente (seção 1), só nesses casos sob demanda.
5. Atualizar `TEMPLATES_MENSAL` e blocos de motivo/turno/tendência/marco com o conteúdo do Gemini
   (mantendo "Olá, [Nome]!" fixo), corrigindo o emoji da tendência estável (seção 2).
6. Deploy.

## 6. Validação pós-deploy

1. Pedir progresso/adesão sob demanda duas vezes seguidas, em menos de 10 min → segunda resposta
   sem "Olá, [Nome]!".
2. Esperar mais de 10 min (ou simular) e pedir de novo → volta a saudar normalmente.
3. Tratamento com estoque insuficiente → mostra o número exato de dias cobertos, não mais "alguns
   dias".
4. Período fora de 7/15/30 → recusa gentil sem a frase "se preferir deixar para depois".
5. Fechamento mensal (quando ocorrer) → continua com saudação fixa, sem mudança de comportamento.