# BRIEFING — BUG-101

**Escalada saída do cadastro classifica a mesma mensagem duas vezes (2 chamadas de LLM)**

Sessão v35 · 26/08/2026 · Prioridade: média · Relacionado: MH-073 Parte B.1

---

## ⚠️ AÇÕES BLOQUEANTES

**Nenhuma.** Sem migration, sem alteração de schema, sem ação manual antes do deploy.

---

## 1. EVIDÊNCIA

Logs do Railway, 26/08/2026, teste de produção da MH-073 Parte B.1:

```
09:38:08 💊 Cadastro — etapa: cad_estoque — +5511941065858
09:38:08 💊 [CADASTRO] Classificador de falha (etapa cad_estoque): "Quero pausar os lembretes da dipirona" -> nova_intencao
09:38:08 💊 [CADASTRO] Nova intenção fora do cadastro — escalando ao roteador — +5511941065858
09:38:09 🧠 [CLASSIFICADOR] Intenção classificada como: configuracao — mensagem: "Quero pausar os lembretes da dipirona"
09:38:11 🧠 [CLASSIFICADOR] Intenção classificada como: configuracao — mensagem: "Quero pausar os lembretes da dipirona"
09:38:11 ⚙️ [ESCALADA] Ainda é configuração — reentra preservando medicamento — +5511941065858
```

Duas chamadas idênticas ao classificador central, com ~2s entre elas. O resultado final foi
correto (dipirona pausada às 09:38:22), mas ao custo de uma chamada de LLM desperdiçada e
~2s de latência adicional em **toda** escalada saída do cadastro.

## 2. CAUSA RAIZ (confirmada em código, não hipótese)

`despacharCadastro` (router.js:528) chama `classificarIntencaoComContexto` para aplicar a
regra de reentrada da Parte B.1 (seção 3.3 — se o destino for `cadastro`, não reinicia).
Quando o destino **não** é cadastro, delega a `despacharEscalada` — cuja primeira instrução
é reclassificar a mensagem do zero:

```javascript
async function despacharEscalada({ user, message, image, contextoPreservado, historicoConversa, contextoProativo = null }) {
    const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
        message, currentState: 'configurando', historicoConversa, contextoProativo
    });
```

`despacharEscalada` não tem como saber que a mensagem já foi classificada. **Origem: a seção
4.6 do BRIEFING_MH073_B1.md**, que especificou a delegação sem prever que o destino
reclassificaria. Defeito de especificação, não de implementação — o Claude Code implementou
fielmente o que estava escrito (mesmo padrão de atribuição do BUG-97, v34).

**Efeito colateral de diagnóstico:** a segunda classificação usa o `currentState:
'configurando'` fixo de `despacharEscalada` (ver ACH da v35), e o log sai como *"Ainda é
configuração — reentra preservando medicamento"* quando o usuário nunca esteve em
configuração — estava em `cad_estoque`. Mensagem enganosa para diagnóstico futuro.

## 3. ⚠️ CORREÇÃO ÓBVIA QUE ESTÁ ERRADA — LER ANTES DE IMPLEMENTAR

A correção intuitiva é passar o `agenteSelecionado` já resolvido. **Isso introduziria um bug
silencioso.** `despacharEscalada` consome QUATRO campos da classificação, não um:

| Campo | Onde é usado |
|---|---|
| `agente` | escolha do branch |
| `subtipoRelatorio` | `despacharRelatorio({ subtipo: subtipoRelatorio, ... })` |
| `params` | `despacharRelatorio({ params, ... })` |
| `feedback` | devolvido no retorno da função |

Passar só o agente faria uma escalada `cadastro → relatorios` chegar com
`subtipoRelatorio: undefined` e `params: undefined` — relatório errado ou vazio — e o
`feedback` sumiria do retorno. A classificação precisa ser propagada **inteira**.

## 4. IMPLEMENTAÇÃO

### 4.1 `despacharEscalada` — aceitar classificação pré-resolvida (router.js:~570)

Substituir a assinatura e o bloco de classificação:

```javascript
// ANTES
async function despacharEscalada({ user, message, image, contextoPreservado, historicoConversa, contextoProativo = null }) {
    // MH-065: recebe o contextoProativo JÁ BUSCADO pelo roteador — nenhuma query nova
    // (princípio 6: buscar uma vez, propagar).
    const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } = await classificarIntencaoComContexto({
        message, currentState: 'configurando', historicoConversa, contextoProativo
    });

// DEPOIS
async function despacharEscalada({ user, message, image, contextoPreservado, historicoConversa,
                                   contextoProativo = null, classificacaoPreResolvida = null }) {
    // MH-065: recebe o contextoProativo JÁ BUSCADO pelo roteador — nenhuma query nova
    // (princípio 6: buscar uma vez, propagar).
    //
    // BUG-101: quem já classificou a mensagem passa o resultado INTEIRO aqui e evita a
    // segunda chamada de LLM. Propagar o objeto completo, nunca só o agente — subtipoRelatorio,
    // params e feedback são consumidos abaixo (ver seção 3 do briefing). Quando o parâmetro
    // é null, o comportamento é byte a byte idêntico ao anterior (mitigação MH-065).
    const { agente: agenteSelecionado, subtipoRelatorio, params, feedback } =
        classificacaoPreResolvida ?? await classificarIntencaoComContexto({
            message, currentState: 'configurando', historicoConversa, contextoProativo
        });
```

⚠️ Usar `??` e **não** `||`: um objeto de classificação nunca é falsy, mas `||` esconderia um
`classificacaoPreResolvida` malformado. Disciplina de falsy da v34.

⚠️ **Nenhum dos 6 call sites existentes** de `despacharEscalada` (configuracao e
data_nascimento) passa o novo parâmetro. Eles continuam classificando exatamente como hoje.
Não alterar nenhum deles.

### 4.2 `despacharCadastro` — capturar a classificação inteira e propagar

```javascript
// ANTES
    const { agente: agenteSelecionado } = await classificarIntencaoComContexto({
        message,
        currentState: state?.state || 'adding_med',
        historicoConversa,
        contextoProativo
    });

// DEPOIS
    // BUG-101: guarda o objeto INTEIRO — subtipoRelatorio/params/feedback são consumidos
    // por despacharEscalada e se perderiam se só o agente fosse propagado.
    const classificacao = await classificarIntencaoComContexto({
        message,
        currentState: state?.state || 'adding_med',
        historicoConversa,
        contextoProativo
    });
    const agenteSelecionado = classificacao.agente;
```

E na delegação ao final da função:

```javascript
// ANTES
    const escalada = await despacharEscalada({
        user, message, image, historicoConversa, contextoProativo,
        contextoPreservado: null
    });

// DEPOIS
    const escalada = await despacharEscalada({
        user, message, image, historicoConversa, contextoProativo,
        contextoPreservado: null,
        classificacaoPreResolvida: classificacao
    });
```

### 4.3 Corrigir o log enganoso do branch de configuração

O branch assume que a origem era configuração, o que deixou de ser verdade quando o cadastro
passou a escalar (Parte B.1). Substituir a linha:

```javascript
// ANTES
        console.log(`⚙️ [ESCALADA] Ainda é configuração — reentra preservando medicamento — ${user.phone}`);

// DEPOIS
        console.log(`⚙️ [ESCALADA] Destino: configuração — reentra em identif_intencao${contextoPreservado?.medicationNome ? ` preservando ${contextoPreservado.medicationNome}` : ' sem medicamento preservado'} — ${user.phone}`);
```

Só log — zero impacto comportamental. Torna visível a diferença entre escalada vinda de
configuração (com medicamento preservado) e vinda de cadastro (`contextoPreservado: null`),
que hoje o log unifica e confunde.

## 5. FORA DE ESCOPO

- **`currentState: 'configurando'` fixo em `despacharEscalada`** — permanece como está (ACH
  da v35). Este BUG **reduz** a exposição a ele: escaladas vindas do cadastro deixam de
  passar pela classificação com estado falso, porque não reclassificam mais. As escaladas de
  `configuracao` e `data_nascimento` seguem inalteradas.
- **Regra de reentrada da Parte B.1** — não muda. `despacharCadastro` continua decidindo
  sozinho o caso `cadastro → cadastro` antes de delegar.

## 6. CRITÉRIO DE CONCLUSÃO — COMANDO DE VARREDURA

```bash
# 1. Só UMA chamada a classificarIntencaoComContexto dentro de despacharEscalada,
#    e ela é condicionada. Esperado: a linha com '??' presente.
sed -n '/^async function despacharEscalada/,/^}/p' src/router.js | grep -n "classificacaoPreResolvida ??"

# 2. despacharCadastro propaga o objeto inteiro, não só o agente.
#    Esperado: 1 ocorrência; e NENHUMA linha passando 'agente:' solto para despacharEscalada.
grep -n "classificacaoPreResolvida: classificacao" src/router.js

# 3. Os 6 call sites antigos NÃO passam o parâmetro novo.
#    Esperado: exatamente 1 (o de despacharCadastro).
grep -c "classificacaoPreResolvida:" src/router.js

# 4. Sintaxe.
node --check src/router.js
```

## 7. VALIDAÇÃO EM PRODUÇÃO

| # | Cenário | Esperado |
|---|---|---|
| 1 | Em `cad_estoque`, dizer "quero pausar os lembretes da dipirona" | **UMA** linha `🧠 [CLASSIFICADOR]` no log (hoje são duas); pausa funciona igual |
| 2 | Em `cad_horarios`, dizer "quero ver meus remédios" | Uma classificação; relatório correto — valida que `subtipoRelatorio`/`params` sobreviveram |
| 3 | Em `cad_dosagem`, dizer "tomei o remédio das 8" | Uma classificação; roteia para principal |
| 4 | Escalada a partir de **configuração** (ex.: em `obter_horario`, dizer "quero cadastrar dipirona") | Comportamento idêntico ao de hoje — não-regressão do caminho antigo |
| 5 | Escalada a partir de **data de nascimento** (dizer "quero cadastrar meu remédio" durante a coleta) | Comportamento idêntico ao de hoje — não-regressão |
| 6 | Log do branch de configuração | Mostra `sem medicamento preservado` quando vem do cadastro; nome do medicamento quando vem de configuração |

Cenários 4 e 5 são os críticos: provam que os 6 call sites antigos não regrediram.

## 8. REGISTRO EM `backlog_items`

Este chat é read-only. Escrita é responsabilidade do Claude Code no encerramento da v35.

**INSERT — BUG-101**
- `tipo`: `BUG` · `numero`: `101`
- `titulo`: `Escalada saída do cadastro classifica a mesma mensagem duas vezes`
- `status`: `em_validacao` (após deploy) · `prioridade`: `media` · `relacionado`: `MH-073`
- `causa_raiz`: `despacharCadastro (router.js:528) chama classificarIntencaoComContexto para aplicar a regra de reentrada da Parte B.1 e, quando o destino não é cadastro, delega a despacharEscalada — cuja primeira instrução é reclassificar a mensagem do zero. Duas chamadas de LLM idênticas e ~2s de latência extra em toda escalada saída do cadastro. Confirmado nos logs do Railway de 26/08/2026 (09:38:09 e 09:38:11, mesma mensagem). ORIGEM: seção 4.6 do BRIEFING_MH073_B1.md, que especificou a delegação sem prever a reclassificação no destino — defeito de especificação, não de implementação (mesmo padrão de atribuição do BUG-97). Efeito colateral: a segunda classificação usava o currentState 'configurando' fixo, e o log saía como "Ainda é configuração" para um usuário que estava em cad_estoque. Correção: parâmetro opcional classificacaoPreResolvida em despacharEscalada, propagando o objeto INTEIRO (agente + subtipoRelatorio + params + feedback — propagar só o agente quebraria escaladas para relatórios).`