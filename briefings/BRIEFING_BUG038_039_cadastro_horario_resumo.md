# BRIEFING: BUG-038 + BUG-039 — Fluxo de cadastro: horário assumido sem perguntar e resumo não exibido automaticamente

**Data:** 19/06/2026  
**Sessão:** v9  
**Prioridade:** Alta — afeta diretamente a qualidade e confiabilidade do cadastro  
**Arquivo afetado:** `src/agentes/cadastro.js` — apenas o prompt (função `buildSystemPrompt`)  
**Sem alteração de banco de dados. Sem alteração de router.**

---

## BUG-038 — Horário assumido sem perguntar ao usuário

### Sintoma
Usuário enviou "Nimesulida 12/12 hrs". O agente_cadastro interpretou "12/12 hrs" como frequência (2x ao dia), assumiu os horários `08:00` e `20:00` por conta própria, e avançou para `cad_estoque` sem perguntar em que horários o usuário toma o medicamento. O usuário só percebeu o erro na etapa de confirmação.

### Causa raiz
O prompt da etapa `cad_horarios` instrui o Claude a interpretar linguagem natural e salvar como array de horários. A instrução atual é:

```
cad_horarios:
  Pergunta os horários de uso.
  Salve sempre como array de strings ["HH:MM"].
  Interprete linguagem natural: "de manhã e à noite" → ["07:00", "21:00"], "só de manhã" → ["07:00"].
```

O problema: o prompt instrui a **interpretar** linguagem natural, mas não faz distinção entre expressões que já indicam horários específicos ("de manhã e à noite") e expressões que indicam apenas frequência ("12/12 hrs", "duas vezes ao dia", "de 8 em 8 horas"). Para frequência, o Claude não tem os horários — só sabe quantas vezes por dia. Mas o prompt não instrui explicitamente a **perguntar o horário de início** nesses casos. O Claude tenta resolver sozinho e assume valores padrão.

### Correção

**Localizar no prompt:**
```
cad_horarios:
  Pergunta os horários de uso.
  Salve sempre como array de strings ["HH:MM"].
  Interprete linguagem natural: "de manhã e à noite" → ["07:00", "21:00"], "só de manhã" → ["07:00"].
```

**Substituir por:**
```
cad_horarios:
  Pergunta os horários de uso.
  Salve sempre como array de strings ["HH:MM"].

  DISTINÇÃO OBRIGATÓRIA entre dois tipos de resposta:

  1. Horários específicos → interprete e salve diretamente, sem perguntar:
     "de manhã e à noite" → ["07:00", "21:00"]
     "às 8 e às 20" → ["08:00", "20:00"]
     "só de manhã" → ["07:00"]
     "9h da manhã e 9h da noite" → ["09:00", "21:00"]

  2. Frequência sem horário → NUNCA assuma horários. Pergunte o horário de início:
     "12/12 hrs" → pergunte: "Entendido, 2x ao dia! Em que horário você toma a primeira dose?"
     "de 8 em 8 horas" → pergunte: "Ótimo, 3x ao dia! Qual o horário da primeira dose?"
     "duas vezes ao dia" → pergunte: "Às que horas você costuma tomar?"
     "três vezes ao dia" → pergunte: "Qual o horário da primeira dose do dia?"

  Quando o usuário informar o horário de início após a pergunta, calcule os demais horários automaticamente:
  Exemplo: primeira dose às 05:00, 12/12hrs → ["05:00", "17:00"]
  Exemplo: primeira dose às 08:00, de 8 em 8hrs → ["08:00", "16:00", "00:00"]
```

---

## BUG-039 — Resumo de confirmação não exibido automaticamente após estoque

### Sintoma
Após o usuário informar a quantidade em estoque, o agente_cadastro enviou a mensagem de aviso de estoque ("Anotado! Só um aviso: com 12 comprimidos e 2x ao dia...") e avançou internamente para `cad_confirmacao`. Mas o resumo completo **não foi exibido** — o fluxo ficou parado aguardando uma nova mensagem do usuário para renderizar o resumo. O usuário precisou perguntar "Deu certo?" para o resumo aparecer.

### Causa raiz
O prompt instrui o Claude a, na etapa `cad_estoque`, registrar a quantidade e incluir o aviso de estoque se necessário — e então definir `proximaEtapa: "cad_confirmacao"`. O problema é que a mensagem de aviso de estoque **é a resposta da etapa `cad_estoque`**, não da etapa `cad_confirmacao`. O resumo só é gerado quando o agente é chamado novamente com `etapa = cad_confirmacao`.

Ou seja: o fluxo exige duas mensagens do usuário para sair de `cad_estoque` e exibir o resumo:
1. Usuário informa o estoque → Nami avisa sobre estoque → estado vai para `cad_confirmacao`
2. Usuário envia qualquer coisa → Nami exibe o resumo

Isso cria um buraco na experiência — o usuário não sabe que precisa responder para ver o resumo.

### Correção

A solução é fazer com que a mensagem da etapa `cad_estoque`, quando não há alerta de estoque ou quando o estoque é suficiente, **já exiba o resumo completo** em vez de apenas confirmar o estoque e aguardar. O resumo faz parte da mesma mensagem de encerramento da coleta de dados.

**Localizar no prompt:**
```
cad_estoque:
  Pergunta a quantidade em estoque. Adapte à forma:
  - comprimido/cápsula → "Quantos comprimidos você tem agora?"
  - colírio/gotas → "Quantos frascos você tem agora?"
  - pomada → "Quantos tubos você tem agora?"
  - outros → "Qual a quantidade em estoque?"

SE etapa = 'cad_estoque' E context.alerta_estoque_baixo existe:
  Após registrar a quantidade informada, inclua um aviso antes de avançar.
  Use os valores: dias_restantes, estoque, doses_por_dia, tipo_tratamento, tratamento_dias.

  SE context.alerta_estoque_baixo.tipo_tratamento = 'temporario':
    O tratamento tem duração definida e o estoque não cobre o período completo.
    Use esta mensagem:
    "Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia, seu estoque
     cobre apenas {dias_restantes} dias — mas seu tratamento é de {tratamento_dias} dias.
     Pode ser bom providenciar mais antes de começar o tratamento! 💊"

  SE context.alerta_estoque_baixo.tipo_tratamento = 'continuo' (ou não definido):
    Exemplo (dias_restantes = 0):
    "Entendi! Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia,
     você já está sem estoque suficiente para hoje mesmo. Quer cadastrar assim mesmo
     e comprar mais em breve, ou prefere registrar a quantidade depois da compra?"

    Exemplo (dias_restantes <= 5):
    "Anotado! Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia,
     seu estoque dura apenas {dias_restantes} dias. Não se esqueça de fazer a
     recompra em breve! Vou te lembrar quando estiver acabando. 💊"

  Se context.alerta_estoque_baixo não existe: seguir normalmente para confirmação.
```

**Substituir por:**
```
cad_estoque:
  Pergunta a quantidade em estoque. Adapte à forma:
  - comprimido/cápsula → "Quantos comprimidos você tem agora?"
  - colírio/gotas → "Quantos frascos você tem agora?"
  - pomada → "Quantos tubos você tem agora?"
  - outros → "Qual a quantidade em estoque?"

  QUANDO O USUÁRIO RESPONDER COM A QUANTIDADE, siga estas regras:

  CASO 1 — context.alerta_estoque_baixo existe E tipo_tratamento = 'temporario' E estoque NÃO cobre o tratamento:
    Exiba o aviso de estoque insuficiente E em seguida já exiba o resumo completo para confirmação:
    "Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia, seu estoque
     cobre apenas {dias_restantes} dias — mas seu tratamento é de {tratamento_dias} dias.
     Pode ser bom providenciar mais! 💊

     Mas já deixa eu confirmar o que coletei antes de salvar:

     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: {tratamento_dias} dias
     ⏰ Horários: {horarios}
     📦 Estoque: {estoque}

     Está tudo certinho?"

  CASO 2 — context.alerta_estoque_baixo existe E tipo_tratamento = 'temporario' E estoque cobre o tratamento:
    Confirme que o estoque é suficiente E já exiba o resumo completo:
    "Ótimo! Seu estoque é suficiente para o tratamento completo. 😊

     Deixa eu confirmar tudo antes de salvar:

     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: {tratamento_dias} dias
     ⏰ Horários: {horarios}
     📦 Estoque: {estoque}

     Está tudo certinho?"

  CASO 3 — context.alerta_estoque_baixo existe E tipo_tratamento = 'continuo' E dias_restantes = 0:
    "Entendi! Só um aviso: com {estoque} comprimido(s) e {doses_por_dia}x ao dia,
     você já está sem estoque suficiente para hoje mesmo. Quer cadastrar assim mesmo
     e comprar mais em breve, ou prefere registrar a quantidade depois da compra?"
    (Neste caso aguardar resposta do usuário antes de exibir o resumo.)

  CASO 4 — context.alerta_estoque_baixo existe E tipo_tratamento = 'continuo' E dias_restantes <= 5:
    Exiba o aviso E em seguida já exiba o resumo completo:
    "Anotado! Só um aviso: seu estoque dura apenas {dias_restantes} dias. Não esqueça
     de fazer a recompra em breve! 💊

     Deixa eu confirmar tudo antes de salvar:

     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: contínuo
     ⏰ Horários: {horarios}
     📦 Estoque: {estoque}

     Está tudo certinho?"

  CASO 5 — context.alerta_estoque_baixo NÃO existe (estoque normal):
    Não comente sobre estoque. Exiba diretamente o resumo completo:
    "Deixa eu confirmar tudo antes de salvar:

     💊 Remédio: {nome}
     💉 Forma: {forma}
     📏 Dosagem: {dosagem}
     🔄 Tratamento: {contínuo | X dias}
     ⏰ Horários: {horarios}
     📦 Estoque: {estoque}

     Está tudo certinho?"

  Em todos os casos acima (exceto CASO 3), defina proximaEtapa: "cad_confirmacao".
  O resumo já está sendo exibido nesta mensagem — na próxima etapa o Claude só precisa
  processar a confirmação ou correção do usuário, não exibir o resumo novamente.
```

**Ajuste correspondente na etapa `cad_confirmacao`:**

A etapa `cad_confirmacao` atualmente instrui o Claude a exibir o resumo. Como o resumo agora já é exibido na etapa `cad_estoque`, a instrução deve ser ajustada para não repetir o resumo — apenas processar a resposta do usuário.

**Localizar:**
```
cad_confirmacao:
  Exibe o resumo completo UMA ÚNICA VEZ e pergunta se está tudo certo.
  Use exatamente este formato:
  "Deixa eu confirmar tudo antes de salvar:
  ...
  Está tudo certinho?"
```

**Substituir por:**
```
cad_confirmacao:
  O resumo já foi exibido na etapa anterior (cad_estoque). NÃO repita o resumo.
  Aguarde a resposta do usuário e processe:

  - Se o usuário CONFIRMAR → avance para cad_salvo
  - Se o usuário indicar CORREÇÃO → identifique o campo a corrigir e volte à etapa correspondente
    Exemplos:
    "o horário está errado" → volte para cad_horarios
    "a dosagem não é essa" → volte para cad_dosagem
    "é pra 5 dias, não 3" → volte para cad_tipo_tratamento

  EXPRESSÕES QUE CONTAM COMO CONFIRMAÇÃO (avance para cad_salvo):
  "sim", "é isso", "está", "tá", "tá bom", "ok", "pode", "salva", "salvar",
  "confirmar", "confirmo", "perfeito", "certo", "correto", "isso mesmo",
  "beleza", "pode salvar", "pode cadastrar", "isso", "está certo",
  "está certinho", "tudo certo", "certinho", "pode sim", "vai", "vamos",
  "agora sim", "deu certo", "está correto"

  EXPRESSÕES QUE INDICAM CORREÇÃO (mantenha em cad_confirmacao ou volte à etapa relevante):
  "não", "errado", "muda", "altera", "quero mudar", "não está certo",
  "não é isso", "corrige", "tem erro"
```

---

## Notas de implementação

- Todas as alterações estão **apenas no prompt** dentro de `buildSystemPrompt` em `src/agentes/cadastro.js`
- Nenhuma alteração em lógica JavaScript, banco de dados ou router
- O cálculo de `alerta_estoque_baixo` no código JavaScript permanece igual — apenas o que o Claude faz com esse contexto muda
- Adicionar "agora sim" e "deu certo" na lista de confirmações do `cad_confirmacao` — surgiram nos testes de hoje

---

## Verificação pós-implementação

**Teste BUG-038:**
1. Iniciar cadastro e enviar: "Nimesulida 12/12 hrs"
2. **Esperado:** Nami pergunta "Em que horário você toma a primeira dose?"
3. Responder: "às 5 da manhã"
4. **Esperado:** Nami salva ["05:00", "17:00"] e avança para cad_estoque

**Teste BUG-039:**
1. Percorrer o fluxo até cad_estoque
2. Informar quantidade de estoque
3. **Esperado:** Nami exibe o resumo completo na mesma mensagem, sem precisar de nova mensagem do usuário
4. Responder "sim" ou "agora sim"
5. **Esperado:** medicamento salvo com sucesso