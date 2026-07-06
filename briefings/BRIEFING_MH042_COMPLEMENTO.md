# BRIEFING COMPLEMENTAR — MH-042: mensagem de estoque deve refletir o valor real, nunca o calculado pelo LLM

> Correção encontrada durante a validação em produção do MH-042 (commit `55e25be`).
> Sessão v13 — 06/07/2026.

## Contexto (por que)

Teste real: usuário disse "Eu perdi 30 do dipirona" com estoque real em 27. A Nami perguntou
"tem certeza? isso deixaria o estoque negativo (-3)" — depois, ao confirmar, respondeu "o estoque
vai ficar em -3" seguido do alerta correto "🚨 estoque zerado". O banco gravou certo (`estoque_novo: 0`,
clamp funcionando). O problema é só na mensagem: dois números diferentes (-3 e zerado) para a mesma
pergunta, na mesma resposta.

## Causa raiz confirmada (código real)

Em `principal.js`, `handlePrincipal` (linhas ~85-99): o Claude gera `message` **e** decide as `actions`
numa única chamada, antes de qualquer ação ser executada. O texto "-3" não veio de nenhum cálculo do
sistema — foi o modelo fazendo a conta (27 − 30) sozinho, sem saber que o backend nunca deixa o estoque
negativo. Só depois `processAction` roda de fato, aplica o clamp real e o alerta (`buildAlertaEstoqueAjusteMessage`,
que lê `estoque_atual` fresco do banco) é anexado — corretamente, mas desconectado da frase anterior.

**Não é um bug introduzido pelo MH-042** — é uma fragilidade estrutural do fluxo (mensagem sempre escrita
antes da ação rodar), só ficou visível agora porque a linguagem de perda é nova e o modelo improvisou uma
conta e uma confirmação por conta própria, sem nenhuma instrução nesse sentido no prompt.

## Decisão de produto (validada com Guilherme)

- Manter a confirmação prévia quando a perda informada for maior que o estoque atual (é uma proteção
  válida contra erro de digitação/estimativa) — mas sem o modelo declarar nenhum resultado calculado.
- Sempre informar ao usuário o novo estoque real após a ação, no formato "Estoque atualizado! Seu novo
  estoque de [medicamento] é [Y] unidades." — mas esse número **nunca** vem do texto do LLM; vem de uma
  leitura determinística do banco, feita depois que a ação já rodou (mesmo padrão que o alerta já usa hoje).
- Quando o clamp for aplicado (perda pedida > estoque disponível), a mensagem deve deixar isso explícito
  e honesto — não apenas mostrar o resultado final sem explicar por que o número não bate com o que o
  usuário informou.

## Mudanças em `src/database.js`

### `registrarMovimentoEstoque` — retornar o antes/depois completo, não só o valor novo

```javascript
// Antes: return estoqueNovo;
// Depois:
return { estoqueAnterior, estoqueNovo, deltaAplicado };
```

Nenhum outro call site hoje usa o retorno dessa função (todos fazem `await registrarMovimentoEstoque(...)`
sem capturar valor) — mudança segura, não quebra os 8 pontos já retrofitados no MH-042 original.

## Mudanças em `src/agentes/principal.js`

### Nova função determinística — só o informativo, SEM decidir alerta (responsabilidade única)

**Importante:** esta função não deve saber nada sobre limiar de estoque baixo/zerado. Essa regra
continua 100% dentro de `buildAlertaEstoqueAjusteMessage` (inalterada) — que é justamente a função
que deve evoluir sozinha, no futuro, quando ganhar a oferta de recompra via parceiro. Não fundir as
duas responsabilidades numa função só.

```javascript
function buildEstoqueAtualizadoMessage({ medNome, estoqueAnterior, estoqueNovo, deltaAplicado, quantidadeSolicitada }) {
    let msg = `\n\n📦 Estoque atualizado! Seu novo estoque de *${medNome}* é *${estoqueNovo}* ${estoqueNovo === 1 ? 'unidade' : 'unidades'}.`;

    // Se o que foi de fato aplicado é menor (em módulo) do que o solicitado, o clamp em 0 entrou em ação —
    // isso só é detectável comparando o delta pedido com o delta realmente aplicado.
    if (quantidadeSolicitada != null && Math.abs(deltaAplicado) < quantidadeSolicitada) {
        msg += ` (Você tinha ${estoqueAnterior} — como o estoque não pode ficar negativo, o ajuste foi ` +
               `limitado a ${estoqueAnterior}, não aos ${quantidadeSolicitada} informados.)`;
    }

    return msg;
}
```

### `case 'UPDATE_STOCK'` — capturar o retorno; informativo e alerta chamados como dois passos independentes

```javascript
case 'UPDATE_STOCK': {
    // ... (validação de medicationId e montagem de params — inalterado)

    const { estoqueAnterior, estoqueNovo, deltaAplicado } = await registrarMovimentoEstoque({
        medicationId: action.medicationId,
        origem: 'manual',
        motivo: action.motivo || null,
        ...params
    });

    let textoFinal = '';
    try {
        const statusInfo = await getEstoqueStatusSimples(action.medicationId);
        // Passo 1 — informativo do MH-042 (o que estamos corrigindo aqui)
        textoFinal += buildEstoqueAtualizadoMessage({
            medNome: statusInfo?.medNome,
            estoqueAnterior,
            estoqueNovo,
            deltaAplicado,
            quantidadeSolicitada: action.quantidade
        });
        // Passo 2 — alerta de estoque, função existente e intocada (não faz parte deste complemento;
        // é a mesma que vai ganhar a oferta de recompra via parceiro no futuro)
        textoFinal += buildAlertaEstoqueAjusteMessage(statusInfo);
    } catch (e) {
        console.error('⚠️ Erro ao montar mensagem de estoque atualizado:', e.message);
    }
    return textoFinal ? { alertaEstoque: textoFinal } : null;
}
```

`buildAlertaEstoqueAjusteMessage` permanece exatamente como está — este complemento não deve alterar
uma linha sequer dela. (Observação à parte, fora de escopo deste complemento: essa função e a
`buildAlertaEstoqueMessage`, usada em confirmação de dose, são duas regras de alerta genuinamente
diferentes — a segunda é mais sofisticada, ligada ao MH-029 ainda em aberto. Não devem ser unificadas
aqui; se fizer sentido consolidar no futuro, é decisão a tomar junto com o MH-029, não de raspão.)

## Mudanças em `src/prompts.js`

Adicionar ao bloco `ATUALIZAÇÃO DE ESTOQUE`:

```
REGRA ABSOLUTA — NUNCA declare um valor numérico de estoque resultante no seu texto
(nem em recompra, nem em correção, nem em perda) — nem durante a confirmação, nem
depois de registrar. O número real do estoque final é sempre comunicado por um
sistema separado, depois que a ação for aplicada de fato. Sua mensagem, nesses casos,
deve apenas confirmar a intenção: "Registrado! Vou atualizar o estoque de [medicamento]."

CONFIRMAÇÃO EM PERDA/CORREÇÃO PARA MENOS (modo "subtracao"):
Se a quantidade perdida informada for MAIOR OU IGUAL ao estoque atual do medicamento
(disponível no contexto), pergunte antes de agir:
"Você tem certeza que perdeu [X] unidades de [medicamento]? O estoque atual registrado
é de [Y]." — SEM calcular ou mencionar qual seria o resultado da subtração.
Aguarde confirmação (newState: "confirming").
```

## Cenários de teste

1. "perdi 30 do dipirona" com estoque real em 27 → mensagem de confirmação cita só "27" (estoque atual),
   nunca "-3" ou qualquer resultado calculado
2. Confirmar a perda → mensagem final: "Estoque atualizado! Seu novo estoque de Dipirona é 0 unidades.
   (Você tinha 27 — ... limitado a 27, não aos 30 informados.)" + alerta de zerado, sem contradição
3. "comprei 30 comprimidos" (recompra normal, sem clamp) → só "Estoque atualizado! Seu novo estoque de
   X é Y unidades." — sem a ressalva de clamp, sem alerta (se acima do mínimo)
4. Repetir cenário do Cataflam (correção "set", sem perda) → mensagem final inclui o número real, sem
   nenhuma menção de clamp (não se aplica a esse modo)
   