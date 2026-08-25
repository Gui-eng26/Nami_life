# BRIEFING — MH-073 Parte B.3 (correção): MH-80 descarta dados da primeira mensagem

**Sessão:** v34 · **Data:** 21/08/2026
**Item:** MH-80 (`em_validacao`) — correção antes do encerramento da Parte B.3
**Arquivos:** `src/agentes/cadastro.js`
**Migration:** nenhuma.

---

## 1. O que foi observado

Teste de 21/08 às 12:13:51. Mensagem única de abertura do cadastro:

> "Quero cadastrar o xarope polaramine, vou tomar 5ml de 12/12 hrs, por 6 dias. Tenho 1 vidro de 100ml"

**Só o nome foi aproveitado.** A Nami reperguntou horários, quantidade, tipo de tratamento e
estoque — tudo já informado.

⚠️ Nenhum `extracao_cadastro_completo_falhou` foi registrado nos logs. O classificador **rodou e
devolveu JSON válido**. A perda aconteceu depois, no contrato de extração e na montagem do salto.

---

## 2. Causa raiz — quatro perdas independentes

### 2.1 Não existe campo para frequência/intervalo

O contrato só tem `pares: [{horario, quantidade}]`, e o filtro exige `horarioValido(p.horario)`.
"de 12/12 hrs" não produz horário nenhum → `pares` vazio.

⚠️ `classificarPosologia` **já sabe** tratar isso desde a Parte B (categoria
`frequencia_intervalo` + `calcularHorariosPorIntervalo`, BUG-041). A capacidade existe no projeto
e não foi espelhada aqui.

### 2.2 Não existe campo para quantidade sem horário

`pares` exige horário **e** quantidade juntos para o mesmo horário. "5ml" sozinho não tem onde
ser guardado. `classificarPosologia` tem `quantidadeUnica` exatamente para isso — também não
espelhado.

### 2.3 Estoque líquido acoplado a `pares` ⚠️ o mais grave

```js
let unidades = null;
if (completo.pares.length > 0) {
    unidades = derivarUnidades(...);
    ...
}
...
if (unidades?.unidade_estoque === 'ml') {
    if (completo.frascos && completo.volumeFrasco) { ... }
    else if (completo.frascos) { contextUpdates.frascos = completo.frascos; }
}
```

Com `pares` vazio, `unidades` é `null` → o ramo `ml` nunca executa → **`frascos` e
`volumeFrasco` são descartados mesmo tendo sido extraídos corretamente**.

O acoplamento é indevido: a unidade de estoque pode ser conhecida pela `unidadeDose` ou pela
`formaExplicita`, sem depender de haver horário.

### 2.4 "por N dias" não mapeia para tratamento temporário

O prompt lista `tipoTratamento` e `tratamentoDias` como campos, mas **não instrui** que uma
expressão de duração ("por 6 dias", "durante 5 dias", "por uma semana") já determina
`temporario` + o número de dias. Sem regra explícita, o classificador deixou `null`.

### 2.5 O padrão comum

Três das quatro perdas têm a mesma forma: **campos independentes acoplados a `pares`**. É a
mesma família do Tema 2 da Parte B.3 — decisão que descarta informação do usuário em silêncio por
não cobrir uma categoria que o próprio sistema já sabe tratar em outro lugar.

---

## 3. Correção

### 3.1 Contrato de extração — três campos novos

Acrescentar a `extrairCadastroCompleto` e ao `fallbackCadastroCompleto`:

```
intervaloHoras: <number|null>     // "de 12/12 hrs" -> 12; "3 vezes ao dia" -> 8
horarioInicio:  "HH:MM"|null      // só quando a primeira dose foi dita explicitamente
quantidadeUnica: <number|null>    // quantidade por dose sem horário associado
```

Regras a acrescentar no prompt (texto literal):

```
- intervaloHoras: quando a pessoa disser frequência regular sem horários explícitos.
  "de 12 em 12 horas" / "12/12 hrs" -> 12    "de 8 em 8h" -> 8
  "3 vezes ao dia" -> 8                      "2x ao dia" -> 12
  "uma vez ao dia" -> 24
- horarioInicio: só quando a pessoa disser onde a grade começa ("começando às 8h",
  "a primeira às 7"). Se ela não disser, deixe null — NUNCA invente o início.
- quantidadeUnica: a quantidade por dose quando ela NÃO estiver amarrada a um horário
  específico. "vou tomar 5ml de 12/12 hrs" -> quantidadeUnica: 5, unidadeDose: "ml".
  Se a quantidade já estiver em `pares`, deixe quantidadeUnica null.
- tipoTratamento: expressão de duração JÁ determina o tipo.
  "por 6 dias" / "durante 6 dias" / "por 6 dias seguidos" -> temporario, tratamentoDias 6
  "por uma semana" -> temporario, 7      "por 15 dias" -> temporario, 15
  "todo dia" / "de uso contínuo" / "sempre" / "pra sempre" -> continuo, tratamentoDias null
  Sem indicação de duração -> null.
```

⚠️ **Não relaxar a regra de extração literal.** `horarioInicio` continua sendo `null` quando não
dito — a grade de horários nunca é inventada (Princípio 4).

Validação determinística após o parse, no mesmo padrão dos demais campos:
- `intervaloHoras`: número finito, `> 0` e `<= 24`, senão `null`.
- `horarioInicio`: passa por `horarioValido`, senão `null`.
- `quantidadeUnica`: número finito `> 0`, senão `null`. ⚠️ **Zero não é quantidade de dose
  válida** — diferente do estoque, onde zero é legítimo (BUG-97).

### 3.2 `montarSaltoCadastroCompleto` — desacoplar de `pares`

**(a) A unidade passa a ser resolvida independentemente de haver horário:**

```js
// A unidade de dose é conhecida sempre que a pessoa disser QUANTO ("5ml"),
// mesmo sem horário. Amarrar isso a `pares` descartava estoque líquido já
// extraído — foi o que perdeu "1 vidro de 100ml" no teste de 21/08.
const temInfoDose = completo.pares.length > 0 || completo.quantidadeUnica !== null
    || completo.unidadeDose !== null;
const unidades = temInfoDose ? derivarUnidades(completo.unidadeDose || 'unidade') : null;

if (unidades) {
    contextUpdates.unidade_dose = unidades.unidade_dose;
    contextUpdates.unidade_estoque = unidades.unidade_estoque;
    contextUpdates.gotas_por_ml = unidades.gotas_por_ml;
    contextUpdates.forma_explicita = completo.formaExplicita || null;
}
```

**(b) Horários resolvidos a partir do intervalo, quando possível:**

```js
// Reaproveita a função determinística do BUG-041 — nunca recalcular a grade aqui.
let pares = completo.pares;
if (pares.length === 0 && completo.intervaloHoras && completo.horarioInicio) {
    const horarios = calcularHorariosPorIntervalo(completo.horarioInicio, completo.intervaloHoras);
    if (completo.quantidadeUnica !== null) {
        pares = horarios.map(h => ({ horario: h, quantidade: completo.quantidadeUnica }));
    } else {
        contextUpdates.horarios = horarios;   // falta só a quantidade
    }
}
if (pares.length > 0) {
    contextUpdates.horarios = pares.map(p => p.horario);
    contextUpdates.pares_posologia = pares;
}
```

**(c) Guardar o que ficou pendente, para não reperguntar:**

```js
// Sem horário de início, a grade não pode ser montada — mas o intervalo e a
// quantidade já ditos precisam sobreviver, senão cad_horarios repergunta tudo.
if (completo.intervaloHoras && !completo.horarioInicio) {
    contextUpdates.intervalo_horas = completo.intervaloHoras;
}
if (pares.length === 0 && completo.quantidadeUnica !== null) {
    contextUpdates.quantidade_pendente = completo.quantidadeUnica;
}
```

⚠️ `cad_horarios` **já sabe** usar `context.intervalo_horas` para perguntar só o horário da
primeira dose (comportamento verificado em produção às 12:14:47). Gravar o campo é o suficiente —
não mexer naquele caminho.

⚠️ `decidirCadHorarios` precisa consumir `quantidade_pendente`: quando os horários forem
resolvidos e houver quantidade pendente, montar os pares e **pular** `cad_quantidade_por_dose`.
Este comportamento já existe para o caso `quantidade_apenas` (Parte B, seção 6.1) — reaproveitar,
não duplicar.

**(d) Estoque desacoplado:**

```js
let estoqueResolvido = null;
if (completo.frascos && completo.volumeFrasco) {
    estoqueResolvido = completo.frascos * completo.volumeFrasco;
    contextUpdates.frascos = completo.frascos;
    contextUpdates.volume_frasco = completo.volumeFrasco;
} else if (completo.frascos) {
    contextUpdates.frascos = completo.frascos;
} else if (completo.estoqueQuantidade !== null) {
    estoqueResolvido = completo.estoqueQuantidade;
}
```

⚠️ A checagem de `unidade_estoque === 'ml'` sai daqui. Quem diz "1 vidro de 100ml" já indicou o
formato do estoque; não faz sentido exigir que a unidade tenha sido resolvida antes.

⚠️ Manter `estoqueQuantidade !== null` (nunca `truthy`) — zero é estoque legítimo (BUG-97).

**(e) Cascata da primeira etapa faltante** — acrescentar `cad_estoque_volume` ao caso em que há
`frascos` mas falta o volume, e manter a ordem canônica. Nenhuma outra mudança.

---

## 4. Checklist de verificação

```bash
# 1. Nenhum campo independente continua amarrado a pares
grep -n "pares.length > 0" src/agentes/cadastro.js
# esperado: apenas na montagem dos horários/pares, nunca em estoque ou unidades

# 2. A grade por intervalo não foi reimplementada
grep -n "calcularHorariosPorIntervalo" src/agentes/cadastro.js
# esperado: chamadas à função existente; nenhuma aritmética de horário nova

# 3. Zero preservado no estoque, rejeitado na dose
grep -n "estoqueQuantidade !== null\|quantidadeUnica" src/agentes/cadastro.js

# 4. Sintaxe
node --check src/agentes/cadastro.js
```

---

## 5. Cenários de validação

### Reprodução exata do teste que falhou

1. *"Quero cadastrar o xarope polaramine, vou tomar 5ml de 12/12 hrs, por 6 dias. Tenho 1 vidro
   de 100ml"* →
   ✅ a Nami pergunta **apenas** a dosagem e o **horário da primeira dose**.
   ✅ Não repergunta quantidade, duração nem estoque.
   ✅ No resumo: 2 horários × 5ml, tratamento 6 dias, estoque 100ml (1 frasco de 100ml).

### Variações

2. Mensagem completa **com horários explícitos**: *"Cadastrar Dorflex 300mg, 1 comprimido às 12h
   e 2 às 22h, uso contínuo, tenho 1 caixa com 30"* → ✅ vai direto ao resumo, sem perguntas.
3. Mensagem com intervalo **e** início: *"Amoxicilina 500mg, 1 cápsula de 8 em 8 horas começando
   às 7h, por 7 dias, tenho 21 cápsulas"* → ✅ direto ao resumo, horários 07:00/15:00/23:00.
4. Mensagem com quantidade mas **sem** horário nem intervalo: *"Cadastrar Losartana 50mg, tomo 1
   comprimido, tenho 30"* → ✅ pergunta só os horários; não repergunta quantidade nem estoque.
5. Estoque zerado na primeira mensagem: *"Cadastrar Dipirona 500mg, 1 cp às 8h, contínuo, não
   tenho nenhum ainda"* → ✅ grava estoque `0`, exibe alerta, **não repergunta**.

### Não-regressão

6. *"Claritin"* (só o nome) → ✅ fluxo idêntico ao de hoje, sem chamada extra de extração.
7. *"Quero cadastrar o Rivotril"* (nome já cadastrado e ativo) → ✅ detecção de duplicata dispara
   antes de qualquer salto.
8. Cadastro passo a passo completo (comprimido e colírio) → ✅ sem mudança de comportamento.
9. Correção de horário no resumo com quantidade já coletada → ✅ quantidade preservada (BUG-91).

---

## 6. Escritas em `backlog_items`

Via `src/backlog.js`:

- `MH-80` permanece `em_validacao` até a validação em produção desta correção.
- ⚠️ **MH-78** (dose por sítio de aplicação, "2 gotas em cada olho") permanece `aberto` e
  **FORA** desta parte, por decisão de Guilherme em 21/08.
- ⚠️ **MH-81** — *"Exibir a quantidade da dose nos lembretes e follow-ups"* — registrar como
  `aberto`, `prioridade: alta`, `relacionado: 'MH-073'`. Também **fora** desta parte.