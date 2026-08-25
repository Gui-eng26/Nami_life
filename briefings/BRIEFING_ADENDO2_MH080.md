# ADENDO 2 — MH-073 Parte B.3: `cad_confirmacao` sem resumo e transições fora do ponto único

**Sessão:** v34 · **Data:** 25/08/2026
**Complementa:** `BRIEFING_MH080_CORRECAO.md` e `ADENDO_MH080.md` (ambos implementados)
**Item:** MH-80 (`em_validacao`)
**Arquivos:** `src/agentes/cadastro.js`, `src/observabilidade.js`
**Migration:** nenhuma.

---

## 1. O que os testes de 25/08 mostraram

⚠️ **Os dados estão corretos. A conversa quebrou.** Essa distinção é o diagnóstico inteiro —
nenhuma correção abaixo pode mexer na extração ou na persistência.

Gravado no banco a partir de *"Quero cadastrar o xarope polaramine, vou tomar 5ml de 12/12 hrs
por 6 dias. Tenho 1 vidro de 100ml"*:

| Campo | Valor gravado |
|---|---|
| dosagem | `2mg` |
| forma / unidades | `xarope` · `ml`/`ml` |
| posologia | 08:00 → 5ml · 20:00 → 5ml |
| tratamento | `temporario`, 6 dias |
| estoque | `100` ml |

Idem no Levoid: 07:00 → 2 comprimidos, estoque 30, contínuo. **O MH-80 funciona.**

O que o usuário viveu, porém, foi um laço:

> "Desculpe, não peguei direito 😊 Pode me dizer qual informação está errada..."

3 turnos no Polaramine, 4 no Levoid (que terminou em "Cancelar"). E no Polaramine o cadastro foi
**salvo sem que o resumo jamais tivesse sido exibido** — dado de saúde persistido sem revisão do
usuário, que é precisamente o que a etapa de confirmação existe para impedir.

---

## 2. DEFEITO 1 — `cad_confirmacao` alcançável sem `resumoRenderizado`

### Causa raiz (confirmada por leitura de código + logs)

`resumoRenderizado` nasce em **três** lugares apenas: `cadastro.js:396` (dentro de
`processarEstoque`), `1018` (correção em `cad_confirmacao`) e `1693` (caminho completo de
`montarSaltoCadastroCompleto`).

Antes do ADENDO 1, `decidirCadTipoTratamento` ia **sempre** para `cad_estoque`, e o resumo nascia
no `finalizarComEstoque`. Agora, quando o estoque já foi resolvido pelo MH-80,
`primeiraEtapaFaltante` salta direto para `cad_confirmacao` — **por fora do único ponto que
renderiza o resumo**.

Log do Railway confirma o salto sem passar pelo estoque:

```
17:09:42  Cadastro — etapa: cad_tipo_tratamento
17:10:02  Cadastro — etapa: cad_confirmacao      ← nunca passou por cad_estoque
```

Sem `resumoRenderizado` no contexto, o bloco do prompt (linha 1933) cai no ramo `else` — que é a
mensagem de **correção não compreendida**. O usuário nunca pediu correção nenhuma; ele estava
sendo apresentado ao resumo pela primeira vez.

⚠️ **Regressão introduzida pelo ADENDO 1.** Eu especifiquei o roteamento novo e não especifiquei
que `cad_confirmacao` tem uma pré-condição. Registrar como tal.

### Correção — renderizar no ponto de ENTRADA da etapa, não nas transições

Espalhar `renderizarResumo` pelas três transições novas repetiria o erro em escala. A etapa tem
uma pré-condição; quem a satisfaz é o despacho, uma vez só.

Em `decidirEtapa`, **depois** de obter `proximaEtapa` e `contextUpdates` de qualquer ramo e
**antes** do `return`, garantir a pré-condição:

```js
// PRÉ-CONDIÇÃO DE cad_confirmacao: a etapa não pode ser alcançada sem o resumo
// montado. Renderizar aqui — no ponto de entrada — em vez de em cada transição
// que leva até ela: era a ausência disso que fazia o prompt cair no ramo de
// "correção não compreendida" e produzir o laço observado em 25/08.
function garantirResumo(proximaEtapa, contextCompleto, contextParaPrompt) {
    if (proximaEtapa !== 'cad_confirmacao') return contextParaPrompt;
    if (contextParaPrompt?.resumoRenderizado) return contextParaPrompt;

    const estoque = contextCompleto?.estoque_resolvido;
    if (estoque === null || estoque === undefined || !contextCompleto?.pares_posologia?.length) {
        // Estado incompleto chegando na confirmação — ver DEFEITO 3.
        return contextParaPrompt;
    }
    return {
        ...contextParaPrompt,
        resumoRenderizado: renderizarResumo(contextCompleto, estoque)
    };
}
```

⚠️ `estoque === null || === undefined`, **nunca** `!estoque`: zero é estoque legítimo (BUG-97).

⚠️ `contextCompleto` é `{ ...context, ...contextUpdates }` — o contexto **já com** as atualizações
do turno. Renderizar sobre o `context` antigo exibiria dados desatualizados.

⚠️ `alerta_estoque_baixo` **não** é calculado aqui. Ele já é calculado nos caminhos que resolvem
o estoque (`processarEstoque` e o caminho completo do salto). Recalculá-lo no despacho arriscaria
produzi-lo sem posologia — o defeito original do `cadastro.js:409`.

---

## 3. DEFEITO 2 — transições de avanço fora do ponto único

### Causa raiz (confirmada)

O ADENDO 1 deixou `decidirCadHorarios` e `decidirCadQuantidade` explicitamente fora de escopo. A
justificativa era conter risco — mas essas funções são atravessadas por **todo** cadastro,
inclusive os que vêm do salto do MH-80. O resultado é que metade das transições consulta o
contexto e metade não.

Quatro pontos com destino cravado, todos com a mesma expressão:

```js
proximaEtapa: formaExplicita ? 'cad_tipo_tratamento' : 'cad_confirma_forma'
```

| Linha | Função | Caso |
|---|---|---|
| 1312 | `decidirCadHorarios` | `horarios_completados_com_quantidade_pendente` |
| 1357 | `decidirCadHorarios` | `posologia_completa` |
| 1410 | `decidirCadQuantidade` | `quantidade_apenas` |
| 1424 | `decidirCadQuantidade` | `posologia_completa` |

**Efeito observado:** no Polaramine, `cad_horarios` viu `forma_explicita = 'xarope'`, pulou a
confirmação de forma e foi direto para `cad_tipo_tratamento` — **ignorando que o contexto já tinha
`tipo_tratamento: 'temporario'` e `tratamento_dias: 6`**, extraídos da primeira mensagem. A Nami
perguntou "CONTÍNUO ou TEMPORÁRIO?" para algo que o usuário já havia dito.

⚠️ Note que o ternário acima **é a ordem canônica reescrita à mão** — forma antes de tratamento.
Substituí-lo por `primeiraEtapaFaltante` não só corrige o pulo, como elimina uma terceira cópia
da ordem do fluxo (Princípio 30).

### Correção

Nos quatro pontos, trocar o ternário por:

```js
proximaEtapa: primeiraEtapaFaltante({ ...context, ...contextUpdatesDesteRetorno }),
```

Como o objeto `contextUpdates` é montado no mesmo literal do `return`, extraí-lo para uma const
antes:

```js
// exemplo — linha 1357, decidirCadHorarios / posologia_completa
const upd = {
    horarios: classificacao.pares.map(p => p.horario),
    pares_posologia: classificacao.pares,
    unidade_dose: unidades.unidade_dose,
    unidade_estoque: unidades.unidade_estoque,
    gotas_por_ml: unidades.gotas_por_ml,
    forma_explicita: classificacao.formaExplicita || null
};
return { acao: 'posologia_completa', proximaEtapa: primeiraEtapaFaltante({ ...context, ...upd }), contextUpdates: upd };
```

⚠️ `decidirCadQuantidade` precisa receber `context` se ainda não recebe — verificar a assinatura e
**atualizar o chamador**.

### O que NÃO muda

⚠️ Caminhos de `indeterminado`, `frequencia_sem_inicio`, `horarios_apenas` e demais **rearranjos
dentro do próprio fluxo de posologia** permanecem exatamente como estão. Eles devolvem a própria
etapa ou uma etapa anterior de propósito.

⚠️ Os **três ramos de correção** de `decidirCadConfirmaForma` (linhas 1463, 1481, 1505) continuam
fora de escopo — são a correção do BUG-95, validada na B.3. Eles vão para `cad_tipo_tratamento`
por decisão própria, e trocá-los agora sem defeito observado repetiria o erro de escopo que este
adendo está corrigindo. **Registrar como pendência conhecida** (ver seção 6).

⚠️ `processarEstoque` e `decidirCadConfirmacao` **não são tocados**.

---

## 4. DEFEITO 3 — laço silencioso, sem sinal em `system_events`

O laço rodou 7 turnos entre os dois cadastros e **nada** foi registrado. Do ponto de vista de
`agent_logs`, a conversa parecia saudável — Princípio 24 mais uma vez.

Entrada nova no catálogo `DEGRADACOES` de `observabilidade.js`:

```
'cadastro:confirmacao_sem_resumo'   → severidade: critica
```

Disparada em `garantirResumo` quando `proximaEtapa === 'cad_confirmacao'` e o resumo não pôde ser
montado (estoque ausente ou posologia vazia). É o sinal de que o fluxo chegou à confirmação com
estado incompleto — a condição exata que produziu o laço.

⚠️ A degradação **registra e segue**; não bloqueia. O usuário ainda recebe uma mensagem, e o
DEFEITO 1 já torna a condição rara. O objetivo é que ela nunca mais passe despercebida.

---

## 5. Checklist de verificação

```bash
# 1. Nenhum destino cravado sobrou nas transições de avanço de posologia
grep -n "formaExplicita ? 'cad_tipo_tratamento' : 'cad_confirma_forma'" src/agentes/cadastro.js
# esperado: nenhuma linha

# 2. A ordem canônica existe UMA vez
grep -n "primeiraEtapaFaltante" src/agentes/cadastro.js
# esperado: 1 definição + chamadas; nenhuma cascata ou ternário replicando a ordem

# 3. Zero de estoque nunca tratado como ausente
grep -n "estoque_resolvido" src/agentes/cadastro.js
# esperado: comparações === null / === undefined; nenhum !estoque

# 4. A pré-condição da confirmação é garantida no despacho
grep -n "garantirResumo" src/agentes/cadastro.js
# esperado: aplicada a TODOS os returns de decidirEtapa, não a alguns

# 5. Sintaxe
node --check src/agentes/cadastro.js && node --check src/observabilidade.js
```

---

## 6. Cenários de validação

### O que este adendo precisa provar

1. **Reprodução exata do Polaramine:** *"Quero cadastrar o xarope polaramine, vou tomar 5ml de
   12/12 hrs por 6 dias. Tenho 1 vidro de 100ml"* →
   ✅ pergunta **apenas** dosagem e horário da primeira dose;
   ✅ **não** pergunta contínuo/temporário (já foi dito "por 6 dias");
   ✅ o **resumo aparece**, com 5ml em cada horário, 6 dias, 100ml;
   ✅ nenhum "Desculpe, não peguei direito".
2. **Reprodução exata do Levoid:** *"Cadastrar Levoid, tomo 1 comprimido, tenho 30"* → dosagem →
   horários → ✅ **resumo aparece imediatamente**, sem perguntar tratamento nem estoque.
3. **Nada é salvo sem o usuário ver o resumo:** em qualquer cadastro, conferir que a mensagem de
   sucesso só vem depois de um resumo exibido.

### Não-regressão (executar antes)

4. Cadastro passo a passo completo (comprimido) → resumo no fim, como hoje.
5. Cadastro passo a passo de líquido, frasco em dois turnos → resumo com "(1 frasco de 10ml)".
6. Correção de horário no resumo → quantidade preservada (BUG-91).
7. Correção por intervalo no resumo → grade recalculada (BUG-96/98).
8. `cad_confirma_forma` com resposta inútil ("sei lá") → ✅ avança, não trava.
9. Estoque zero na primeira mensagem: *"Cadastrar Dipirona 500mg, 1 cp às 8h, contínuo, não tenho
   nenhum"* → ✅ resumo com estoque 0 e alerta; **não repergunta**.
10. Medicamento já cadastrado e ativo → duplicata dispara antes de qualquer salto.

### Transversal

11. `SELECT * FROM system_events WHERE tipo LIKE 'cadastro:%'` durante a bateria →
    ✅ nenhum `confirmacao_sem_resumo`, nenhum `salvamento_com_estado_incompleto`.

---

## 7. Pendência conhecida (NÃO corrigir aqui)

⚠️ Os três ramos de correção de `decidirCadConfirmaForma` (1463, 1481, 1505) continuam com
destino cravado em `cad_tipo_tratamento`. Consequência: corrigir a posologia na confirmação de
forma, **num cadastro que veio do MH-80 com tratamento e estoque já resolvidos**, faz a Nami
perguntar a duração de novo.

Não é reproduzível pelos cenários acima (exige mensagem completa **e** correção na confirmação de
forma no mesmo cadastro). Fica registrado para ser tratado quando houver defeito observado —
mesma disciplina que este adendo aplica.

---

## 8. Escritas em `backlog_items`

- `MH-80` permanece `em_validacao`.
- Nenhum item novo: os três defeitos são do próprio MH-80 e dos adendos anteriores.