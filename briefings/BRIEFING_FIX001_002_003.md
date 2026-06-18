# BRIEFING — FIX-001 + FIX-002 + FIX-003
## Word-boundary no router + Alerta agudo no cadastro + Doses restantes no contexto

**Data:** 18/06/2026  
**Escopo:** `src/router.js`, `src/agentes/cadastro.js`, `src/agentes/principal.js`  
**Complexidade:** Baixa — três mudanças independentes, sem alteração de banco

---

## FIX-001 — Word-boundary em `detectarIntencaoConfiguracao` (`router.js`)

### Problema
`"voltaren".includes("voltar")` → `true`. Qualquer mensagem que mencione o Voltaren E contenha a palavra "tratamento" é incorretamente roteada para o agente de configuração.

### Mudança

**Adicionar função auxiliar** logo antes de `detectarIntencaoConfiguracao`:

```js
// Verifica se uma palavra aparece de forma independente no texto
// (não como parte de outra palavra — ex: "voltar" não deve bater em "voltaren")
function contemPalavraLivre(texto, palavra) {
    if (palavra.includes(' ')) return texto.includes(palavra); // frases: match direto
    return new RegExp(`(^|\\s)${palavra}(\\s|$|[.,!?])`).test(texto);
}
```

**Substituir as duas linhas de verificação** dentro de `detectarIntencaoConfiguracao`:

```js
// ANTES
const temAcao = palavrasAcao.some(p => msg.includes(p));
const temObjeto = palavrasObjeto.some(p => msg.includes(p));

// DEPOIS
const temAcao = palavrasAcao.some(p => contemPalavraLivre(msg, p));
const temObjeto = palavrasObjeto.some(p => contemPalavraLivre(msg, p));
```

Não alterar mais nada em `detectarIntencaoConfiguracao`.

---

## FIX-002 — Alerta de estoque no `cad_estoque` para tratamento agudo (`cadastro.js`)

### Problema
O pre-check do `cad_estoque` usa `diasRestantes <= 5` como threshold fixo, sem considerar `context.tratamento_dias`. Para um tratamento de 5 dias com 10 comprimidos (2x/dia), `diasRestantes = 5`, que satisfaz `<= 5` → alerta dispara. Mas o estoque cobre exatamente o tratamento — nenhum alerta necessário.

### Mudança 1 — pre-check em `handleCadastro`

Localizar o bloco do `cad_estoque` e substituir:

```js
// ANTES
if (etapaAtual === 'cad_estoque') {
    const estoque = parseInt(message) || 0;
    const horarios = context?.horarios || [];
    const dosesPerDia = horarios.length || 1;
    const diasRestantes = Math.floor(estoque / dosesPerDia);
    contextParaClaude = {
        ...contextParaClaude,
        alerta_estoque_baixo: diasRestantes <= 5 ? {
            dias_restantes: diasRestantes,
            estoque,
            doses_por_dia: dosesPerDia
        } : null
    };
}

// DEPOIS
if (etapaAtual === 'cad_estoque') {
    const estoque = parseInt(message) || 0;
    const horarios = context?.horarios || [];
    const dosesPerDia = horarios.length || 1;
    const diasRestantes = Math.floor(estoque / dosesPerDia);
    const tratamentoDias = context?.tratamento_dias || null;

    // Tratamento com duração definida (agudo): alerta só se estoque não cobre o tratamento
    // Tratamento contínuo: alerta quando <= 5 dias de estoque
    const deveAlertar = tratamentoDias !== null
        ? diasRestantes < tratamentoDias
        : diasRestantes <= 5;

    contextParaClaude = {
        ...contextParaClaude,
        alerta_estoque_baixo: deveAlertar ? {
            dias_restantes: diasRestantes,
            estoque,
            doses_por_dia: dosesPerDia,
            tipo_tratamento: tratamentoDias ? 'temporario' : 'continuo',
            tratamento_dias: tratamentoDias
        } : null
    };
}
```

### Mudança 2 — instrução no prompt do `cad_estoque`

Localizar a seção do prompt:
```
SE etapa = 'cad_estoque' E context.alerta_estoque_baixo existe:
```

E substituir o bloco completo por:

```
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

---

## FIX-003 — Doses restantes no contexto do `agente_principal` (`principal.js`)

### Problema
O `buildUserMessage` injeta `diasRestantes` mas não `dosesRestantesEstimadas`. Quando o usuário faz perguntas sobre quantas doses ainda faltam, Claude recalcula por conta própria e pode errar (ex: confundir "doses totais do tratamento" com "doses ainda necessárias").

### Mudança

Localizar o bloco dentro do `map` de medicamentos em `buildUserMessage`:

```js
// ANTES
if (m.tratamento_dias) {
    const inicio = new Date(m.created_at);
    const agora = new Date();
    const diasDecorridos = Math.floor((agora - inicio) / (1000 * 60 * 60 * 24));
    const diasRestantes = Math.max(0, m.tratamento_dias - diasDecorridos);
    tratamentoInfo += `, duração total: ${m.tratamento_dias} dias, dias decorridos desde o início: ${diasDecorridos}, dias restantes: ${diasRestantes}`;
}

// DEPOIS
if (m.tratamento_dias) {
    const inicio = new Date(m.created_at);
    const agora = new Date();
    const diasDecorridos = Math.floor((agora - inicio) / (1000 * 60 * 60 * 24));
    const diasRestantes = Math.max(0, m.tratamento_dias - diasDecorridos);
    const dosesPerDia = (m.schedules || []).filter(s => s.ativo).length || 1;
    const dosesTotais = m.tratamento_dias * dosesPerDia;
    const dosesRestantesEstimadas = diasRestantes * dosesPerDia;
    tratamentoInfo += `, duração total: ${m.tratamento_dias} dias, doses totais do tratamento: ${dosesTotais}, dias decorridos desde o início: ${diasDecorridos}, dias restantes: ${diasRestantes}, doses restantes estimadas: ${dosesRestantesEstimadas}`;
}
```

**Atenção:** `dosesRestantesEstimadas` é uma estimativa baseada em dias decorridos — não desconta doses já confirmadas no `dose_log`. É suficiente para o caso de uso atual. Uma versão mais precisa (MH-024) exigiria query nos dose_logs.

---

## Ordem de execução

1. `src/router.js` — adicionar `contemPalavraLivre` + substituir as duas linhas de verificação
2. `src/agentes/cadastro.js` — atualizar pre-check do `cad_estoque` + atualizar prompt do alerta
3. `src/agentes/principal.js` — atualizar bloco `tratamentoInfo` no `buildUserMessage`
4. Deploy

---

## Validação pós-deploy

### FIX-001
Enviar: "São quantos dias de tratamento do Voltaren"  
**Esperado:** roteado para `principal` (não para configuração)  
**Log esperado:** `🤖 Roteando para principal` (não `⚙️ Roteando para configuração`)

### FIX-002
Cadastrar medicamento agudo com estoque exatamente suficiente para o tratamento  
(ex: 5 dias, 2x/dia, 10 comprimidos)  
**Esperado:** nenhum alerta de recompra ao informar estoque  
**Se estoque insuficiente** (ex: 8 comprimidos para 5 dias): alerta com mensagem correta sobre insuficiência (sem mencionar "recompra")

### FIX-003
Após cadastrar medicamento com `tratamento_dias`, perguntar:  
"Mais quantas doses eu tenho que tomar pra fechar meu tratamento?"  
Depois afirmar: "Tenho X comprimidos e preciso de Y doses, não precisarei comprar mais né?"  
**Esperado:** Nami confirma sem recalcular, usando `dosesRestantesEstimadas` diretamente