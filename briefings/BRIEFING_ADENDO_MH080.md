# ADENDO — MH-073 Parte B.3: fechar o MH-80

**Sessão:** v34 · **Data:** 25/08/2026
**Complementa:** `BRIEFING_MH080_CORRECAO.md` (já implementado)
**Item:** MH-80 (`em_validacao`)
**Arquivos:** `src/agentes/cadastro.js`
**Migration:** nenhuma.

---

## 1. Por que este adendo existe

A correção anterior desacoplou a **extração**. Faltam duas coisas na **montagem** e no
**roteamento**, sem as quais o cenário 1 do briefing (reprodução do Polaramine) não passa: a Nami
ainda repergunta "por quanto tempo?" depois de o usuário já ter dito "por 6 dias".

⚠️ Uma das duas foi encontrada pelo Claude Code durante a implementação e reportada em vez de
corrigida em silêncio — comportamento correto. A outra apareceu na verificação do código.

---

## 2. DEFEITO 1 — `estoqueResolvido` é descartado nos returns antecipados

### Evidência (leitura de código)

```js
} else if (completo.estoqueQuantidade !== null) {
    estoqueResolvido = completo.estoqueQuantidade;   // variável LOCAL
}

// ── quatro returns antecipados acontecem aqui ──
if (!completo.dosagem)          return { proximaEtapa: 'cad_dosagem', contextUpdates };
if (completo.pares.length === 0) return { proximaEtapa: 'cad_horarios', contextUpdates };
if (!completo.formaExplicita)   return { proximaEtapa: 'cad_confirma_forma', contextUpdates };
if (!contextUpdates.tipo_tratamento) return { proximaEtapa: 'cad_tipo_tratamento', contextUpdates };

contextUpdates.estoque_resolvido = estoqueResolvido;   // só é alcançado no caminho completo
```

`estoqueResolvido` só entra em `contextUpdates` no `return` final. **Em qualquer saída antecipada
o valor é perdido.**

Para líquido o dano é parcial — `frascos` e `volume_frasco` já estão no contexto e o estoque pode
ser reconstruído. Para sólido é perda total: *"Cadastrar Losartana, tomo 1 comprimido, tenho 30"*
extrai `estoqueQuantidade: 30`, retorna em `cad_horarios`, e o 30 desaparece.

⚠️ Mesma família do defeito que este briefing já corrigiu: **dado extraído corretamente e
descartado na montagem**.

### Correção

Gravar assim que resolvido, antes de qualquer `return`:

```js
} else if (completo.estoqueQuantidade !== null) {
    estoqueResolvido = completo.estoqueQuantidade;
}

// O estoque precisa entrar no contexto AGORA, não no return final: qualquer
// saída antecipada (dosagem, horários, forma, tipo de tratamento) descartaria
// um valor já extraído corretamente.
if (estoqueResolvido !== null) {
    contextUpdates.estoque_resolvido = estoqueResolvido;
}
```

E no `return` final, substituir a atribuição pela leitura do que já está gravado — não recalcular.

⚠️ `estoqueResolvido !== null` (nunca `truthy`): **zero é estoque legítimo** (BUG-97).

⚠️ `alerta_estoque_baixo` continua sendo calculado **apenas no caminho completo**, onde a
posologia já existe. Calcular alerta sem posologia produziria dias-restantes errado — o defeito
original do `cadastro.js:409` corrigido na Parte B.

---

## 3. DEFEITO 2 — transições de avanço com destino fixo

### Evidência (leitura de código)

`montarSaltoCadastroCompleto` devolve a primeira etapa faltante corretamente. Mas a partir dali o
fluxo passo a passo segue uma trilha cravada, que nunca consulta o contexto:

| Função | Linha | Destino | Consulta o contexto? |
|---|---|---|---|
| `decidirCadDosagem` | 1629 | sempre `cad_horarios` | não |
| `decidirCadConfirmaForma` | 1470 e 1477 | sempre `cad_tipo_tratamento` | não |
| `decidirCadTipoTratamento` | 851 e 857 | sempre `cad_estoque` | não |

No Polaramine, o salto leva a `cad_dosagem` (era o único campo faltante antes dos horários). Dali
em diante o fluxo percorre a trilha fixa e repergunta duração e estoque — ambos já informados.

### Correção — ponto único (Princípio 30)

A cascata das linhas 1568-1594 **já é** a função "qual a primeira etapa faltante". Está inline e
operando sobre `completo`. Extrair como função que opera sobre o **contexto** e usá-la nos dois
lugares.

```js
// Ordem canônica do cadastro. Ponto ÚNICO de decisão de avanço: tanto o salto
// do MH-80 quanto as transições passo a passo consultam esta função, para que
// nenhuma etapa já resolvida seja perguntada de novo.
function primeiraEtapaFaltante(ctx) {
    if (!ctx?.nome)                                   return 'cad_nome';
    if (!ctx?.dosagem)                                return 'cad_dosagem';
    if (!ctx?.pares_posologia?.length)                return 'cad_horarios';
    if (!ctx?.forma_explicita && !ctx?.forma_confirmada) return 'cad_confirma_forma';
    if (!ctx?.tipo_tratamento || ctx?.tipo_tratamento_pendente) return 'cad_tipo_tratamento';
    if (ctx?.estoque_resolvido === null || ctx?.estoque_resolvido === undefined) {
        if (ctx?.unidade_estoque === 'ml' && ctx?.frascos && !ctx?.volume_frasco) return 'cad_estoque_volume';
        return 'cad_estoque';
    }
    return 'cad_confirmacao';
}
```

⚠️ `estoque_resolvido === null || === undefined` — **jamais `!ctx.estoque_resolvido`**. Zero é
estoque legítimo e `!0` é `true`, o que faria o fluxo reperguntar eternamente um estoque zerado
válido. Este é o erro que produziria uma reincidência do BUG-97 por outra porta.

⚠️ `tipo_tratamento_pendente` no teste: o usuário disse "temporário" sem os dias. O campo existe
justamente para isso e precisa manter o fluxo em `cad_tipo_tratamento`.

### Aplicação nas três funções

Substituir o destino fixo **apenas nas transições de avanço**:

```js
// decidirCadDosagem (1629)
return { proximaEtapa: primeiraEtapaFaltante({ ...context, dosagem: c.valor }), contextUpdates: { dosagem: c.valor } };
```

```js
// decidirCadConfirmaForma (1470) — forma corrigida
const upd = { forma_confirmada: classificacao.formaExplicita };
return { acao: 'forma_corrigida', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
```

```js
// decidirCadConfirmaForma (1477) — confirmação ou avanço sem confirmação clara
const upd = { forma_confirmada: context?.forma_sugerida || null };
return {
    acao: respostaConfirmaSimples(message) ? 'confirmado' : 'avanca_sem_confirmacao_clara',
    proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd, forma_confirmada: upd.forma_confirmada ?? '' }),
    contextUpdates: upd
};
```

⚠️ Nesse último caso `forma_confirmada` pode legitimamente ser `null` (rótulo genérico) — usar
`?? ''` no objeto passado à função para que a etapa conte como resolvida e o fluxo **não trave**.
`cad_confirma_forma` nunca bloqueia (Parte B, seção 6.3).

```js
// decidirCadTipoTratamento (851 e 857)
// A função passa a receber o contexto para poder consultar o que já foi resolvido.
function decidirCadTipoTratamento(classificacao, context) { ... }
// case 'continuo' e case 'dias':
const upd = { tipo_tratamento: ..., tratamento_dias: ..., tipo_tratamento_pendente: false };
return { acao: ..., proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
```

⚠️ Atualizar o **chamador** de `decidirCadTipoTratamento` para passar `context`.

### O que NÃO muda

⚠️ **Caminhos de `indeterminado` e de repergunta permanecem exatamente como estão.** Eles
retornam a própria etapa de propósito, e trocá-los por `primeiraEtapaFaltante` faria o fluxo
avançar sem ter coletado o dado.

⚠️ `decidirCadHorarios`, `decidirCadQuantidade`, `processarEstoque` e `decidirCadConfirmacao`
**não são tocados**. Suas transições já dependem do que foi extraído no turno e foram
estabilizadas na Parte B.2 — mexer nelas sem defeito observado é risco sem retorno.

⚠️ `montarSaltoCadastroCompleto` passa a terminar com `primeiraEtapaFaltante(contextUpdates)` em
vez da cascata inline. **Remover a cascata** — duas cópias da mesma ordem canônica é o defeito
que o Princípio 30 existe para evitar.

---

## 4. Checklist de verificação

```bash
# 1. Ponto único: a ordem canônica existe UMA vez
grep -n "cad_confirma_forma'" src/agentes/cadastro.js
# esperado: nenhuma cascata duplicada; só primeiraEtapaFaltante decide avanço

# 2. Zero de estoque nunca é tratado como ausente
grep -n "estoque_resolvido" src/agentes/cadastro.js
# esperado: comparações com === null / === undefined; nenhum !ctx.estoque_resolvido

# 3. Destinos fixos removidos apenas nas transições de avanço
grep -n "proximaEtapa: 'cad_tipo_tratamento'\|proximaEtapa: 'cad_estoque'\|proximaEtapa: 'cad_horarios'" src/agentes/cadastro.js
# esperado: remanescentes apenas em caminhos de repergunta/indeterminado

# 4. Sintaxe
node --check src/agentes/cadastro.js
```

---

## 5. Cenários de validação

### O que este adendo precisa provar

1. **Reprodução do Polaramine:** *"Quero cadastrar o xarope polaramine, vou tomar 5ml de 12/12
   hrs, por 6 dias. Tenho 1 vidro de 100ml"* →
   ✅ pergunta **apenas** dosagem e horário da primeira dose;
   ✅ **não** repergunta duração nem estoque;
   ✅ resumo: 2 horários × 5ml, 6 dias, 100ml (1 frasco de 100ml).
2. **Estoque sólido extraído cedo:** *"Cadastrar Losartana, tomo 1 comprimido, tenho 30"* →
   ✅ pergunta dosagem e horários; ✅ **não** repergunta estoque; ✅ grava 30 (DEFEITO 1).
3. **Temporário sem dias:** *"Cadastrar Amoxicilina 500mg, 1 cápsula às 8h, é temporário, tenho
   21"* → ✅ pergunta **quantos dias**; ✅ não repergunta estoque.
4. **Estoque zero na primeira mensagem:** *"Cadastrar Dipirona 500mg, 1 cp às 8h, contínuo, não
   tenho nenhum"* → ✅ grava `0`, vai ao resumo, **não repergunta estoque** (armadilha do `!0`).

### Não-regressão (executar antes)

5. *"Claritin"* (só o nome) → fluxo passo a passo idêntico ao de hoje.
6. Cadastro completo passo a passo, comprimido e colírio → sem mudança.
7. Correção de horário no resumo com quantidade já coletada → quantidade preservada (BUG-91).
8. Correção por intervalo no resumo → grade recalculada (BUG-96/98).
9. Medicamento já cadastrado e ativo → duplicata dispara antes de qualquer salto.
10. `cad_confirma_forma` com resposta inútil ("sei lá") → ✅ **avança**, não trava.

### Transversal

11. `SELECT * FROM system_events WHERE tipo LIKE 'cadastro:%'` durante a bateria →
    ✅ nenhum `salvamento_com_estado_incompleto`.

---

## 6. Escritas em `backlog_items`

- `MH-80` permanece `em_validacao` até a validação em produção deste adendo.
- Nenhum item novo. Os dois defeitos são do próprio MH-80, não itens separados.