# BRIEFING — Adesão ao Tratamento (Cálculo + Apresentação + Chamadas)

**Data:** 07/07/2026
**Tipo:** Consolidação sistêmica (fecha BUG-031, item "unificação de tipos" sem ID próprio, MH-037,
BUG-037) + nova funcionalidade formal (progresso do tratamento)
**Prioridade:** Alta — BUG-031 é urgente (linguagem do relatório semanal), demais itens conectados
**Registra, mas NÃO implementa nesta rodada:** MH-043 (fim de tratamento), MH-044 (jornada 2 para
usuários estáveis fora do ciclo de 4 semanas)

⚠️ **Nota de numeração:** existe um `BRIEFING_BUG037.md` antigo (17/06) tratando de um assunto
diferente (mensagem de estoque duplicada). O CONTEXT.md aponta BUG-037 como próximo livre, então
usamos esse número aqui — mas há uma divergência de numeração a resolver separadamente, fora deste
briefing.

---

## 1. Itens de backlog fechados por este briefing

| Item | Descrição original | Como é resolvido aqui |
|---|---|---|
| BUG-031 | Linguagem inadequada no relatório semanal | Templates determinísticos eliminam geração livre do LLM |
| *(sem ID)* "unificação de tipos" | `getAdesaoPeriodo` retornando dados divergentes | `getAdesaoPeriodo` e `getAdesaoPorMedicamento` deprecadas, substituídas por `calcularAdesao` única |
| MH-037 | Cálculo de adesão via COUNT dose_logs, granularidade por horário | `calcularAdesao` usa `scheduled_at` real, com diagnóstico por turno via `horario_agendado` (MH-032) |
| BUG-037 | "Como estou no meu tratamento" e "Qual minha adesão" caem no `principal.js` com respostas incorretas/inconsistentes | Camada 3 rígida eliminada; 6º tipo de relatório formal criado; classificador semântico decide agente+subtipo numa só chamada |

Registrados para depois, fora de escopo:
- **MH-043** — fim de tratamento (lembretes pós-encerramento, alertas de recompra vencidos, prorrogação com rastreabilidade, relatório automático ao fim do tratamento)
- **MH-044** — jornada 2 para usuários estáveis 5+ semanas na mesma faixa (depende de dados reais antes do design)

---

## 2. Migrations necessárias (Supabase — executar manualmente antes do deploy)

### 2.1 — Popular `medications.tratamento_fim` (coluna já existe, nunca usada)

```sql
-- Popula tratamento_fim para tratamentos ativos com tratamento_dias definido,
-- calculado a partir de created_at. Novos cadastros passam a popular no momento
-- da criação (ver seção 4).
UPDATE public.medications
SET tratamento_fim = (created_at::date + (tratamento_dias || ' days')::interval)
WHERE tratamento_dias IS NOT NULL
  AND tipo_tratamento != 'continuo'
  AND tratamento_fim IS NULL;
```

### 2.2 — Nova tabela `adesao_estado` (estado por usuário, para jornada/tendência)

```sql
CREATE TABLE public.adesao_estado (
    user_id                     uuid PRIMARY KEY REFERENCES public.users(id),
    ultimo_fechamento_mensal_at timestamptz,
    faixa_atual                 text,   -- '100' | '80_99' | '50_79' | 'abaixo_50'
    percentual_ultimo_envio     numeric,
    semana_atual_na_faixa       int DEFAULT 1,
    melhor_faixa_atingida       text,   -- para não repetir celebração de marco
    updated_at                  timestamptz DEFAULT now()
);
```

Cohesão: mantém todo o estado de acompanhamento de adesão num único lugar, sem poluir `users`.

---

## 3. Pilar Cálculo

### 3.1 — `calcularAdesao(userId, dias)` — nova função única em `database.js`

**Substitui e deprecia:** `getAdesaoPeriodo` e `getAdesaoPorMedicamento` (remover as duas depois que
todos os call sites migrarem).

```
logs = dose_logs do user com scheduled_at em [agora - dias, agora]
esperado = logs.length
confirmado = COUNT(status='confirmado')
percentual = confirmado / esperado × 100

porStatus = { confirmado, nao_informado, nao_tomado, sem_estoque }
// sem_estoque conta no esperado como não-confirmada (decisão de produto confirmada)

porMedicamento = mesma quebra, agrupada por medication_id

se dias >= 28:
    diagnosticoPorTurno = para nao_tomado e nao_informado, separadamente:
        agrupar por turno (manhã/tarde/noite, derivado de horario_agendado)
        sinalizar turno com >= 60% das ocorrências daquele status, mínimo 3 casos
        // limiar como constante nomeada e comentada — ajustável após dados reais
        // sem_estoque NÃO cruza com turno (é logístico, não comportamental)
```

Aplica-se a qualquer medicamento (contínuo ou temporário). Usada tanto no envio semanal (`dias=7`,
sem diagnóstico de turno) quanto no fechamento mensal (`dias=30`, com diagnóstico) quanto sob
demanda (`dias` = 7, 15 ou 30, ver seção 5.3).

**Importante:** filtrar por `scheduled_at`, nunca por `taken_at` — isso resolve de graça a
atribuição correta de confirmações retroativas ao dia devido (não ao dia da confirmação) e a
exclusão automática de doses revertidas (já ficam com `confirmed:false` no reverso).

### 3.2 — `calcularProgressoTratamento(userId)` — nova função em `database.js`

```
aplica-se só a medicamentos com tipo_tratamento != 'continuo' E tratamento_dias preenchido
diasRestantes = max(0, tratamento_fim - hoje)
diasDecorridos = tratamento_dias - diasRestantes
dosesRestantes = diasRestantes × horários_ativos_por_dia   // estimativa, é prospectivo
percentualDecorrido = diasDecorridos / tratamento_dias × 100
```

`tratamento_fim` é sempre a fonte da verdade. Toda vez que `tratamento_dias` mudar (cadastro,
reativação, ou futura prorrogação via MH-043), `tratamento_fim` deve ser recalculada. A
rastreabilidade de *por que* mudou (histórico de prorrogações) fica para o MH-043 — aqui só
garantimos que o valor está sempre correto no presente.

---

## 4. Pilar Apresentação

### 4.1 — Regra geral

**Templates 100% determinísticos — elimina geração livre do LLM (raiz do BUG-031).** Estrutura:
espinha dorsal + blocos aditivos, para não multiplicar templates numa matriz gigante.

### 4.2 — Espinha dorsal semanal: jornada faixa × semana

4 faixas (100% / 80-99% / 50-79% / <50%) × 4 semanas de progressão dentro da faixa, conteúdo
baseado em Hábitos Atômicos. **Todos os templates deste briefing são texto literal, aprovado por
Guilherme — usar exatamente como está, sem parafrasear ou reescrever.** `[Nome]` e `[Taxa]` são
variáveis a substituir em tempo de execução.

---

🟢 **Faixa 100% de Adesão** (foco: Tornar Satisfatório — celebrar identidade e consistência)

**Semana 1 (Identidade)**
> Olá, [Nome]! Passando para te dar os parabéns! 🎉 Sua taxa de adesão nesta semana foi de 100%. Você está priorizando a sua saúde e agindo como alguém que realmente se cuida. Continue assim!

**Semana 2 (Não quebre a corrente)**
> Incrível, [Nome]! Mais uma semana com 100% de sucesso! 🚀 No mundo dos hábitos, o mais importante é não quebrar a corrente da consistência. Você está no caminho certo para o seu bem-estar!

**Semana 3 (Empilhamento de Sucesso)**
> 100% de novo, [Nome]? Que orgulho! 🌟 Seu cérebro adora essa previsibilidade. Que tal aproveitar que esse hábito já está consolidado e celebrar fazendo algo que você gosta hoje? Você merece!

**Semana 4 (Consolidação do Hábito)**
> Fechamos o mês com chave de ouro, [Nome]: 100% de adesão! 💎 Tomar sua medicação já está se tornando parte automática do seu dia. Parabéns pela disciplina e pelo carinho com você mesmo.

---

🟡 **Faixa 80% a 99%** (foco: Ajustes Finos — otimizar o ambiente para capturar as poucas doses que falharam)

**Semana 1 (Tornar Fácil — o Ambiente)**
> Parabéns pelo resultado, [Nome]! Sua adesão foi de [Taxa]%. Muito perto da meta! 👏 Para te ajudar a fechar os 100% na próxima, que tal deixar a cartela/frasco em um lugar bem visível, do lado de algo que você usa todo dia (como a escova de dentes)?

**Semana 2 (Empilhamento de Hábitos)**
> Olá, [Nome]! Sua taxa foi de [Taxa]% esta semana. Ótimo trabalho! Para não esquecer os detalhes, tente a técnica do empilhamento: diga para si mesmo "Logo após [Hábito Atual, ex: tomar café], eu vou tomar meu medicamento". Funciona muito!

**Semana 3 (Preparando o Terreno)**
> Muito bem, [Nome]! Você alcançou [Taxa]% de adesão. Para facilitar o seu "eu do futuro", que tal separar as doses da semana em uma caixinha organizadora de remédios hoje? Reduzir esse pequeno esforço ajuda muito!

**Semana 4 (A Regra dos Dois Dias)**
> Boa semana, [Nome]! Sua adesão ficou em [Taxa]%. Excelente! Lembre-se de uma regra de ouro dos hábitos: falhar uma vez é um acidente, falhar duas vezes seguidas é o começo de um novo mau hábito. Se perder uma dose, foque tudo para não perder a próxima!

---

🟠 **Faixa 50% a 79%** (foco: Reduzir a Fricção e Redesenhar o Ambiente)

**Semana 1 (Tornar Claro / Atrito Visual)**
> Olá, [Nome]! Analisei sua taxa e ficamos em [Taxa]% esta semana. Vamos ajustar essa rotina juntos? Se o remédio fica guardado na gaveta, o cérebro esquece. Que tal tirá-lo do armário e deixá-lo em cima da mesa de cabeceira ou da mesa de jantar hoje mesmo?

**Semana 2 (Simplificação / Caixas Organizadoras)**
> Oi, [Nome]! Sua adesão foi de [Taxa]%. Está na média, mas podemos melhorar para garantir seu bem-estar. Uma dica de ouro: use uma caixinha organizadora dividida por dias da semana (Seg a Dom). Só de olhar para ela, você já sabe visualmente se tomou ou não. Bora testar?

**Semana 3 (Ancoragem na Rotina Comercial)**
> Olá, [Nome]! Tivemos [Taxa]% de adesão. Percebeu se as falhas acontecem mais no meio da correria ou no fim de semana? Tente ancorar o remédio a um hábito que nunca muda, como almoçar ou ligar o computador para trabalhar. Me conta se deu certo!

**Semana 4 (Reduzindo a Fricção)**
> Oi, [Nome]! Fechamos a semana com [Taxa]%. Para facilitar o processo, tente deixar um copo d'água sempre pronto no local onde você costuma tomar o remédio. Quanto menos passos você precisar dar na hora de tomar, mais fácil fica o hábito!

---

🔴 **Faixa menos de 50%** (foco: Investigação, Empatia e Redefinição do Sistema)

**Semana 1 (Verificação de Alinhamento e Horários)**
> Olá, [Nome], estou aqui para cuidar de você. Notei que sua adesão ficou em [Taxa]% esta semana. Vamos conversar? Os horários atuais estão muito difíceis para a sua rotina? Se precisar, fale com seu médico para ajustar os horários, e depois me avise aqui para mudarmos o nosso plano!

**Semana 2 (Fricção do Sistema de Confirmação)**
> Oi, [Nome]! Sua adesão ficou em [Taxa]%. Quero entender melhor: você acabou não tomando o medicamento ou tomou mas achou difícil entrar aqui no WhatsApp para confirmar? Me conta, seu feedback me ajuda a deixar nosso espaço mais simples para você.

**Semana 3 (Co-criação de Soluções / Escuta Ativa)**
> Olá, [Nome]. Preocupado com a sua saúde, vi que nossa taxa ficou em [Taxa]%. Para melhorarmos juntos na próxima semana, o que você acha que mais ajudaria? Mudar o horário das minhas mensagens? Deixar o remédio em um lugar mais visível na sua casa? Me diz o que prefere ou me dê sua sugestão!

**Semana 4 (Reset de Hábito — Começar Pequeno)**
> Oi, [Nome], estou aqui com você. Tivemos [Taxa]% de adesão. Não desanime, construir novos hábitos leva tempo! Vamos recomeçar do básico? Hoje, o seu único objetivo é colocar o medicamento do lado do seu prato ou do seu café da manhã. Vamos focar em acertar o dia de amanhã, um passo de cada vez. Fechado?

---

**Regras de controle da jornada semanal:**
- **Reset categórico:** sempre que a faixa mudar (por limite fixo, qualquer cruzamento), o contador
  de semana volta pra 1, mesmo que a diferença percentual seja pequena.
- **5ª+ semana consecutiva na mesma faixa:** repete o conteúdo da Semana 4 indefinidamente
  (comportamento provisório — MH-044 vai revisar isso com dados reais).
- Contador vive em `adesao_estado.semana_atual_na_faixa`.

### 4.3 — Espinha dorsal mensal: fechamento de 30 dias (3 variações por faixa)

Usada só no fechamento mensal (dias=30). Tom de "fechamento de um mês inteiro", sem motivo
embutido — o motivo entra como bloco aditivo (seção 4.4).

🟢 **Faixa 100%**

> V1: Olá, [Nome]! Fechamos o nosso mês e a sua taxa de adesão foi de 100%! 🎉 Que orgulho ver o seu compromisso com você. Um mês inteirinho cuidando da saúde com tanta constância é uma vitória gigante!

> V2: [Nome], você completou o mês com 100% de sucesso! 🚀 Esse resultado mostra que tomar seus medicamentos já virou uma parte natural do seu dia. Parabéns por esse cuidado tão bonito!

> V3: Que notícia maravilhosa para fechar o mês, [Nome]: 100% das doses confirmadas! 💎 Você protegeu a sua saúde todos os dias deste mês. Parabéns por esse carinho constante com você!

🟡 **Faixa 80-99%**

> V1: Olá, [Nome]! Olhando para os últimos 30 dias, sua taxa de adesão foi de [Taxa]%. Que resultado excelente! 👏 Você esteve super perto de acertar todas as doses. No próximo mês, vamos continuar firmes para manter esse ótimo ritmo!

> V2: [Nome], fechamos o mês com [Taxa]% de adesão! Muito bom mesmo! Para facilitar ainda mais no mês que vem, que tal deixar a cartela bem visível ao lado de algo que você já usa todo dia de manhã, como a escova de dentes ou a garrafa de água?

> V3: Oi, [Nome]! Passando para contar que sua adesão deste mês ficou em [Taxa]%. Parabéns pela regularidade! Deixar o ambiente preparado e os remédios fáceis de pegar ajuda muito a não pular nenhuma dose na correria. Conte comigo!

🟠 **Faixa 50-79%**

> V1: Olá, [Nome]! Analisei o nosso último mês e sua taxa de adesão ficou em [Taxa]%. Você se dedicou, mas sei que o dia a dia pode ser corrido. Para o próximo mês, uma dica simples é tirar os remédios do armário ou da gaveta e deixá-los bem à vista na mesa da cozinha ou na cabeceira.

> V2: Oi, [Nome]! Fechamos o mês com [Taxa]% de adesão. Estamos no caminho, mas podemos deixar essa rotina mais leve. Uma ideia que ajuda muito é usar aquelas caixinhas organizadoras divididas pelos dias da semana. Fica bem mais fácil de controlar!

> V3: Olá, [Nome]! Sua adesão nos últimos 30 dias foi de [Taxa]%. Para ajudar a lembrar com mais facilidade no próximo mês, tente combinar o remédio com algo que você já faz todo dia sem falta, como logo após tomar o café da manhã ou logo após almoçar.

🔴 **Faixa <50%**

> V1: Olá, [Nome], estou aqui para apoiar você. Olhando o nosso fechamento do mês, sua adesão ficou em [Taxa]%. Não desanime, criar uma nova rotina leva tempo e os primeiros passos são os mais desafiadores. Estou aqui para caminhar junto com você, um dia de cada vez.

> V2: Oi, [Nome]. Pensando no seu bem-estar, vi que nossa taxa mensal ficou em [Taxa]%. Quero muito ajudar a deixar esse processo mais simples e tranquilo. Vamos recomeçar com calma no próximo mês, focando em dar um passo pequeno por dia para proteger a sua saúde.

> V3: Olá, [Nome]! Fechamos o mês com [Taxa]% de adesão. Minha intenção por aqui é ser um suporte acolhedor na sua rotina, sem cobranças. Vamos seguir em frente com otimismo e buscar formas mais fáceis de incluir esse cuidado no seu dia. Seu bem-estar é o mais importante.

### 4.4 — Blocos aditivos

**1. Motivo dominante** (semanal e mensal — 2 variações por motivo, escolhidas de forma alternada)

*Motivo "sem resposta" (nao_informado):*
> V1: Percebi que muitas das suas doses ficaram sem confirmação por aqui. Para facilitar, verifique se está recebendo as minhas notificações no seu WhatsApp corretamente. Assim consigo te ajudar nas confirmações!

> V2: Notei que boa parte das doses ficou sem resposta no WhatsApp. Se você estiver tomando certinho e só não estiver conseguindo confirmar na mensagem, tente deixar a nossa conversa fixada na tela para facilitar.

*Motivo "não tomado" (nao_tomado):*
> V1: Vi que em alguns dias você acabou ficando sem tomar o medicamento. Uma dica para ajudar é deixar um copo de água sempre pronto e abastecido bem do lado do seu remédio.

> V2: Notei que algumas doses não foram tomadas no período. Não se preocupe se falhar um dia, o mais importante é focar toda a atenção para conseguir tomar o remédio certinho no dia seguinte e recuperar o ritmo.

*Motivo "sem estoque":*
> V1: A maior parte das doses perdidas aconteceu porque o medicamento acabou. Aqui na nossa conversa eu sempre aviso quando seu remédio vai acabar com antecedência para você garantir a recompra!

> V2: Vi que o estoque do seu remédio acabou durante o período. Para não interromper o tratamento no mês que vem, uma alternativa prática é programar a compra ou pedir para alguém buscar na farmácia um pouquinho antes do frasco esvaziar.

**2. Turno** (só no fechamento mensal, só para "sem resposta" e "não tomado" — 2 variações por turno)

*Manhã:*
> V1: Reparei que o período da manhã, no comecinho do dia, é o momento em que você encontra mais dificuldades com o medicamento.

> V2: Notei que as primeiras horas da manhã estão sendo o horário mais desafiador para conseguir tomar as doses.

*Tarde:*
> V1: Percebi que o turno da tarde é o momento em que fica um pouco mais difícil de acompanhar e confirmar as doses.

> V2: O período da tarde tem sido o horário em que os compromissos do meio do dia mais atrapalham as suas confirmações.

*Noite:*
> V1: Notei que o período da noite é onde está acontecendo a maior parte das doses não confirmadas.

> V2: Parece que o turno da noite, no cansaço do fim do dia, está sendo o momento em que fica mais difícil manter a regularidade.

**3. Tendência** (semanal e mensal — comparação com o período anterior)

*Adesão subiu:*
> V1: E olha que conquista: sua adesão subiu de [TaxaAnterior]% para [TaxaAtual]%! Você está melhorando muito a cada dia!

> V2: Que evolução linda! Sua taxa subiu comparada ao período anterior (de [TaxaAnterior]% para [TaxaAtual]%). Parabéns por todo o esforço!

*Adesão caiu:*
> V1: Sua taxa oscilou um pouquinho em relação ao período anterior, indo de [TaxaAnterior]% para [TaxaAtual]%. Fique em paz, essas variações são completamente normais quando estamos nos acostumando com uma rotina nova.

> V2: Tivemos uma leve queda comparado ao período passado, de [TaxaAnterior]% para [TaxaAtual]%. Vamos encarar isso como uma oportunidade para deixar os remédios em um lugar ainda mais fácil nos próximos dias.

*Adesão estável (±5pp):*
> V1: Sua taxa se manteve firme e estável em [TaxaAtual]%, igualzinho ao período anterior. Manter a regularidade já é uma grande vitória!

> V2: Você manteve a sua constância! Sua adesão continuou estável em [TaxaAtual]%. Seguimos no mesmo caminho firme cuidando da saúde.

*Marco especial (ex: primeira vez em 100%, ou melhor resultado já registrado — usa `adesao_estado.melhor_faixa_atingida` pra não repetir):*
> E temos um marco histórico por aqui: esta é a sua primeira vez alcançando os 100%! O melhor resultado registrado desde que começamos! 🏆

### 4.5 — Progresso do tratamento (Cálculo B)

**Espinha — 3 variações por fase do tratamento**, usando `percentualDecorrido` (já calculado em
`calcularProgressoTratamento`, nenhum dado novo):

*Início* (percentualDecorrido < 33%):
> Olá, [Nome]! Vim te mostrar como está o começo do seu tratamento com [Medicamento]. Você está no dia [DiasDecorridos] de [TratamentoDias] — ainda no início da jornada! Ao todo, restam [DiasRestantes] dias e [DosesRestantes] doses até o fim. [BlocoEstoque]

*Meio* (33-66%):
> Olá, [Nome]! Seu tratamento com [Medicamento] já está na metade do caminho: dia [DiasDecorridos] de [TratamentoDias]. Faltam [DiasRestantes] dias e [DosesRestantes] doses para concluir. [BlocoEstoque]

*Reta final* (> 66%):
> Olá, [Nome]! Estamos quase lá com o [Medicamento] — você já está no dia [DiasDecorridos] de [TratamentoDias]. Faltam só [DiasRestantes] dias e [DosesRestantes] doses pra terminar. Continue firme! 🥰 [BlocoEstoque]

**Bloco aditivo — estoque**, reaproveitando a mesma fórmula de suficiência já usada em
`cadastro.js` (etapa `cad_estoque`), recalculada com `diasRestantes` em vez de `tratamento_dias`
(parte do tratamento já foi consumida):

```
diasCobertosPeloEstoque = estoque_atual / doses_por_dia
se diasCobertosPeloEstoque >= diasRestantes → bloco "suficiente"
senão → bloco "insuficiente"
```

*Estoque suficiente:*
> Seu estoque atual, de [Estoque] unidades, é suficiente para terminar o tratamento tranquilamente.

*Estoque insuficiente:*
> Um aviso importante: com [Estoque] unidades no estoque, seu remédio cobre só mais alguns dias — mas ainda faltam [DiasRestantes] dias de tratamento. Vale a pena providenciar mais em breve, pra não interromper o cuidado! 💊

**Fallback — uso contínuo** (quando o usuário pede progresso de um medicamento sem `tratamento_dias`):

> Olá, [Nome]! Como o seu medicamento é de uso contínuo, ele não tem uma data de término ou um número de dias para acabar, sabe? Ele faz parte do seu cuidado diário com a saúde a longo prazo.
> Mas se você quiser, posso gerar agora um relatório para te mostrar a sua taxa de adesão e ver como está a sua regularidade nos últimos tempos. Deseja dar uma olhada?

### 4.6 — Fluxo de escolha de período (relatório de adesão sob demanda)

**Pergunta quando o período não foi especificado:**
> Claro, [Nome]! Posso gerar o seu relatório de adesão agora mesmo. Para qual período você gostaria de olhar?
> Últimos 7 dias
> Últimos 15 dias
> Últimos 30 dias
> É só me dizer o período que você prefere!

**Recusa gentil quando o período pedido não é 7, 15 ou 30** (aciona `registrarIntencaoNaoSuportada`
antes de responder):
> Ah, [Nome], peço desculpas! Como ainda estou aprendendo e em constante desenvolvimento, hoje eu só consigo calcular a sua adesão nesses três períodos fechados: últimos 7, 15 ou 30 dias.
> Gostaria de escolher um desses três para darmos uma olhadinha hoje? Se preferir deixar para depois, está tudo bem também, é só me avisar!

### 4.7 — Sob demanda: versão direta

Mostra os números atuais (percentual, breakdown por status, tendência desde o último envio
automático) **sem avançar nem repetir o texto da jornada de semana**. Não é a mesma mensagem
narrativa do envio automático — é uma versão mais objetiva/numérica.

---



## 5. Pilar Chamadas

### 5.1 — Elimina a Camada 3 rígida (causa raiz do BUG-037)

**Confirmado via grep:** `classificarIntencaoRelatorio` e `handleRelatorios` só são chamados em
`router.js` (linhas ~498/501 e ~517/530) e definidos em `relatorios.js`. Sem outro ponto de uso —
sem risco de regressão em outro arquivo.

- **Camada 1 (mantida):** fast-path por palavra-chave, `router.js` linha 498, atalho barato para os
  casos óbvios.
- **Camada 2 (ganha responsabilidade):** `classificarIntencaoComContexto` passa a retornar
  **agente + subtipo do relatório** na mesma chamada (extensão do prompt/schema JSON).
- **Camada 3 (eliminada):** `handleRelatorios` deixa de reclassificar internamente. Nova
  assinatura: `handleRelatorios({ user, message, historicoConversa, subtipo })` — subtipo sempre
  fornecido por quem chama (Camada 1 ou Camada 2), nunca recalculado dentro da função.

### 5.2 — 6 tipos formais de relatório

Adiciona `progresso_tratamento` aos 5 já existentes (`tomei_hoje`, `meus_remedios`, `estoque`,
`proximo_remedio`, `adesao`). Lista de Camada 1 para o novo tipo:

```javascript
progresso_tratamento: [
    'como estou no meu tratamento',
    'como está meu tratamento',
    'quanto falta pro tratamento acabar',
    'quantos dias faltam de tratamento',
    'em que dia do tratamento eu estou',
    'já estou terminando o tratamento',
    'quanto tempo ainda vou tomar esse remédio',
    'meu tratamento já acabou?'
]
```

**Limpeza correlata:** `principal.js` (linhas ~205-217) hoje monta um contexto ad-hoc de
dias/doses restantes para qualquer conversa — essa era a origem da resposta improvisada do BUG-037.
Como `progresso_tratamento` agora é um relatório formal e dedicado, esse bloco de contexto em
`principal.js` deve ser **removido**, evitando reabrir a mesma duplicação que motivou este trabalho
inteiro.

**Origem confirmada (git log):** esse bloco veio do commit `fe2571a` (MH-028, 17/06/2026) — um
patch pontual pra uma pergunta específica ("quantos dias de tratamento do Voltaren?"), nunca
desenhado como relatório formal. **Sem risco de regressão na continuidade conversacional:** o
mecanismo de continuidade (bloco `DOSES AGUARDANDO CONFIRMAÇÃO`, `CONVERSA RECENTE`, e a instrução
de precedência dose-vs-encerramento-social) vive nas linhas 221-257, introduzido por commits
diferentes e posteriores (`f6cbde7`, `a7ee945`), sem nenhuma leitura ou dependência do bloco de
`tratamentoInfo`. Os dois blocos não se tocam — confirmado linha a linha, não por suposição.

### 5.3 — Sob demanda de adesão: seleção de período em duas etapas

```
Usuário pede adesão sem período → Nami pergunta: "últimos 7, 15 ou 30 dias?"
Usuário responde um dos 3 → segue calcularAdesao(userId, dias) normalmente
Usuário sugere período fora da lista → explica períodos disponíveis, menciona que
  está em desenvolvimento, chama registrarIntencaoNaoSuportada (já existe, reusar),
  pergunta se quer escolher um dos 3
Usuário desiste em qualquer ponto → reconhece e sai do fluxo sem insistir
```

**Detecção de desistência:** `configuracao.js` já tem `isCancelamento(message)` (regex de
não/cancela/desiste/para/esquece), hoje local e não-exportada. Propõe-se **extrair para um módulo
compartilhado** (ex: `src/nlp_helpers.js`) e reusar aqui — evita duplicar a mesma lição já aprendida
no BUG-036 (listas de termos divergentes espalhadas pelo código).

Novo estado de conversa: `aguardando_periodo_adesao` (mesmo padrão de estado já usado em
cadastro/configuração).

### 5.4 — Cadência automática

**Novo horário:** `scheduler.js`, mudar cron de `'0 8 * * 1'` (segunda 08:00) para `'0 16 * * 0'`
(domingo 16:00). Timezone já configurado explicitamente (`America/Sao_Paulo`) — sem risco de fuso
na troca.

**Semanal vs. fechamento mensal:** decidido por `adesao_estado.ultimo_fechamento_mensal_at`:

```
se (agora - ultimo_fechamento_mensal_at) >= 28 dias (ou nunca fechou):
    dispara fechamento mensal (dias=30, com diagnóstico de turno)
    ultimo_fechamento_mensal_at = agora   // reset — sem isso, todo envio seguinte
                                          // seria classificado como mensal de novo
senão:
    dispara semanal normal (dias=7, sem diagnóstico de turno)
```

Cada envio automático (semanal ou mensal) também atualiza `adesao_estado.faixa_atual`,
`percentual_ultimo_envio` e `semana_atual_na_faixa`, alimentando a espinha dorsal e o bloco de
tendência do próximo envio.

---

## 6. Fora de escopo (registrado, não implementar agora)

- **MH-043** — fim de tratamento (lembretes pós-encerramento, alertas de recompra vencidos,
  prorrogação com rastreabilidade de `tratamento_fim`, relatório automático ao encerrar)
- **MH-044** — jornada 2 para usuários 5+ semanas na mesma faixa. Medir primeiro via query simples
  em `adesao_estado.semana_atual_na_faixa > 4`, sem tabela nova — decidir depois com dados reais
- Calibração dos limiares (60%/mín. 3 no turno, ±5pp na tendência) — ajustáveis, calibrar com uso
  real dos testers (Gil, Ivete, Julia, Vitor)
- Divergência de numeração do BUG-037 (arquivo antigo de 17/06 com mesmo ID, assunto diferente)

---

## 7. Critérios de validação (WhatsApp + Supabase lado a lado)

- [ ] "Como estou no meu tratamento?" e variações → cai em `progresso_tratamento`, não mais em `principal`
- [ ] "Qual minha adesão?" e variações → cai em `adesao`, pergunta período se não especificado
- [ ] Período fora de 7/15/30 → registra em `intencoes_nao_suportadas`, oferece escolha, permite desistência
- [ ] Confirmação retroativa conta no dia devido (scheduled_at), não no dia da confirmação
- [ ] Dose revertida não conta como confirmada
- [ ] Mudança de faixa reseta jornada pra Semana 1
- [ ] Envio automático de domingo 16h, com fechamento mensal disparando na 4ª semana e resetando o contador
- [ ] Diagnóstico de turno aparece só no mensal, nunca no semanal
- [ ] Progresso de tratamento contínuo → mensagem explicativa, oferece adesão como alternativa