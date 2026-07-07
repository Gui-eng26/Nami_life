# BRIEFING — ADESÃO AO TRATAMENTO (COMPLEMENTO)
## `calcularProgressoTratamento` deve excluir tratamentos já finalizados

**Data:** 07/07/2026
**Origem:** Validação em produção do `BRIEFING_BUG056_COMPLEMENTO.md`. Cataflam e Dipirona já
concluíram o tratamento (0 dias restantes), mas continuam aparecendo no relatório de progresso com
o template de "reta final" ("Faltam só 0 dias e 0 doses pra terminar"), o que soa incorreto —
tratamento concluído não deveria aparecer como "quase terminando".
**Prioridade:** Baixa — cosmético, sem urgência.
**Fora de escopo aqui (fica para o MH-043):** qualquer refinamento de precisão de doses dentro do
último dia de tratamento, e a experiência completa de fim de tratamento (lembretes pós-encerramento,
alertas de recompra vencidos, relatório automático ao concluir).

---

## 1. Decisão de produto (confirmada em conversa)

Tratamentos com o dia final já passado devem sair da lista retornada por
`calcularProgressoTratamento` — não é um ajuste de template, é uma exclusão na fonte, para não
antecipar decisão de apresentação que já tem dono (MH-043).

## 2. Cuidado técnico identificado — não usar `diasRestantes` nem `dosesRestantes` como critério

`dosesRestantes` é derivada diretamente de `diasRestantes` (`dosesRestantes = diasRestantes ×
dosesPorDia`) — no último dia de tratamento, os dois já chegam a 0 juntos, mesmo que ainda reste
uma dose agendada pra hoje (ex: última dose às 21h). Se a exclusão checasse `diasRestantes <= 0` ou
`dosesRestantes <= 0`, o tratamento sumiria do relatório no próprio dia em que a última dose ainda
está para acontecer — errado.

## 3. Critério correto — comparação de datas, não de contagem derivada

```js
// Em calcularProgressoTratamento, no filtro de elegibilidade:
const hoje = new Date();
const tratamentoAindaVale = (med) => new Date(med.tratamento_fim) >= startOfDay(hoje);
```

Comparar `tratamento_fim` (data) contra o dia de hoje — não contra a contagem de dias/doses
derivada. Isso garante que, no próprio dia em que `tratamento_fim` acontece, o tratamento ainda
aparece (a dose daquele dia ainda pode estar pendente); só deixa de aparecer a partir do dia
seguinte.

**Limitação aceita, deixada para o MH-043:** o número de "doses restantes" mostrado no último dia
pode ficar impreciso (não distingue se a dose do dia já passou ou não) — é uma imprecisão cosmética
menor, não um bug de exclusão. Não resolver agora.

## 4. Ordem de execução

1. Ajustar o filtro de elegibilidade em `calcularProgressoTratamento` (`src/database.js`) conforme
   seção 3, substituindo qualquer exclusão por dias/doses restantes.
2. Deploy.

## 5. Validação pós-deploy

1. Um tratamento com `tratamento_fim` = hoje → ainda deve aparecer no relatório de progresso.
2. Um tratamento com `tratamento_fim` = ontem ou antes (ex: Cataflam, Dipirona) → não deve mais
   aparecer.
3. Conferir que tratamentos com dias restantes > 0 continuam aparecendo normalmente, sem regressão.