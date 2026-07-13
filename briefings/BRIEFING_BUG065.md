# BRIEFING_BUG065 — Alerta de estoque pós-confirmação afirma "zerado" quando ainda há unidades

**Data:** 11/07/2026
**Tipo:** BUG (mensagem afirma um fato de saúde falso ao usuário — diverge do estoque real gravado no banco)
**Prioridade:** A definir por Guilherme na priorização do backlog geral (ver CONTEXT.md)
**Absorve:** nada — item novo. MH-029 ("Alerta de estoque incorreto para tratamento de tempo determinado") permanece separado, sem descrição/causa_raiz até hoje, e não deve ser fundido a este item sem confirmação futura de que trata do mesmo problema.

---

## 1. Sintoma / demanda original

Guilherme relatou (com print de conversa real): ao confirmar retroativamente uma dose de Dipirona, o primeiro alerta de estoque, minutos antes, informava 2 unidades. Após confirmar mais 1 dose retroativa daquele medicamento, a Nami deveria informar estoque atual = 1, mas informou estoque zerado ("você acabou de tomar o último comprimido do Dipirona disponível").

## 2. Causa raiz confirmada (evidência real, não hipótese)

**Estoque real do medicamento (Dipirona, user Guilherme, medication_id `cabf0bec-5714-431c-aaa4-ebd61a6cad26`):** `estoque_atual = 1` — consultado diretamente na tabela `medications`. O banco está correto.

**Trilha em `stock_movements` (mesmo medication_id), confirmando que o próprio registro de estoque nunca errou:**

| Horário (UTC) | Tipo | Antes → Depois |
|---|---|---|
| 2026-07-11 14:59:11 | `dose_confirmada` | 3 → 2 |
| 2026-07-11 15:00:31 | `dose_retroativa` (a dose do print) | 2 → 1 |

**`schedules` do mesmo medicamento:** 2 horários ativos (12:00 e 20:00) → `dosesPerDia = 2`.

**O bug está na camada de composição de texto, não na de cálculo ou gravação.** Em `database.js` (`getEstoqueInfoParaAlerta`, linha 1258):
```js
const diasRestantes = Math.floor(med.estoque_atual / dosesPerDia);
// floor(1 / 2) = 0
```
Esse cálculo está certo — `diasRestantes` é uma métrica de "quantos dias o estoque cobre", não de "quantas unidades restam". O problema é que **3 funções de texto, em 3 arquivos diferentes, tratam `diasRestantes === 0` como sinônimo de "estoque físico = 0"**, o que só é verdade quando `dosesPerDia === 1`:

- `router.js:17-37` (`buildAlertaEstoqueMessage`)
- `agentes/principal.js:28-48` (`buildAlertaEstoqueMessage`, cópia idêntica)
- `agentes/lembrete.js:46-60` (`buildAlertaEstoqueNaoInformadoMessage`, mesma lógica com nome diferente — aqui o efeito é ainda mais visível, produzindo frases contraditórias como *"Seu estoque atual é de 1 unidades — está esgotado."*)

Confirmado por `git log`: as três nasceram no mesmo commit (`f967a0c`, 15/06, MH-026), copiadas em vez de compartilhadas — na época o projeto ainda não tinha adotado o padrão de módulo de templates (`templates/adesaoTemplates.js` só apareceu na v15, 07/07, três semanas depois).

**Isso é sistêmico:** qualquer medicamento com `dosesPerDia >= 2` dispara a mensagem falsa de "estoque zerado" sempre que o estoque real for um número positivo menor que `dosesPerDia`. Com 3x/dia, isso ocorre até com 1 ou 2 unidades sobrando.

**Confirmado como não afetado (auditoria completa de todos os pontos de comunicação de estoque do programa):**
- `calcularAlertaEstoque` (`database.js:1310`) — decide SE alerta, não o texto; sem mudança.
- `agentes/principal.js` `buildAlertaEstoqueAjusteMessage` (MH-042) — usa `getEstoqueStatusSimples`, checagem literal `estoque_atual <= 0`, mecanismo diferente (baseado em `estoque_minimo`, não em doses/dia). Correto, sem mudança.
- `relatorios.js` `relatorioEstoque` — mesmo mecanismo literal acima. Correto, sem mudança.
- `cadastro.js` (prompt `cad_estoque`, casos 1-5, linhas 152-215) — cálculo e fraseado já corretos (sempre mencionam a unidade real na mesma frase que os dias). Sem mudança.

---

## 3. Inventário dos pontos afetados

| # | Arquivo:linha | Função | Call sites |
|---|---|---|---|
| 1 | `router.js:17-37` | `buildAlertaEstoqueMessage` | linha 129 (`+=`), linha 451 (`=`) |
| 2 | `agentes/principal.js:28-48` | `buildAlertaEstoqueMessage` | linha 367 (`CONFIRM_DOSE`), linha 402 (`CONFIRM_RETROATIVA` — este é o call site exato do print) |
| 3 | `agentes/lembrete.js:46-60` | `buildAlertaEstoqueNaoInformadoMessage` | linha 151 |

---

## 4. Desenho da solução

### 4.1 — Nova função de classificação (`database.js`, ao lado de `calcularAlertaEstoque`)

```js
// Classifica o nível de urgência do estoque com base em unidades reais E dias de
// cobertura — nunca infere "zerado" a partir de diasRestantes sozinho (BUG-065).
export function classificarNivelEstoquePorDias({ novoEstoque, diasRestantes }) {
    if (novoEstoque <= 0) return 'zerado';       // literalmente sem unidades
    if (diasRestantes === 0) return 'urgente';   // sobra estoque, mas não fecha 1 dia
    return 'ok';                                  // diasRestantes >= 1
}
```

Nome escolhido deliberadamente distinto de `getEstoqueStatusSimples` (que já existe e usa `estoque_minimo`, mecanismo não relacionado) — evitar colisão conceitual, já que `diasRestantes` como nome já é usado com dois significados diferentes em outras partes do código (`calcularProgressoTratamento` usa "dias restantes até o fim do tratamento"; aqui é "dias restantes de cobertura de estoque"). Não renomear os usos existentes — fora de escopo deste briefing.

### 4.2 — Novo módulo `src/templates/estoqueTemplates.js`

```js
import { classificarNivelEstoquePorDias } from '../database.js';

export function buildAlertaEstoquePosConfirmacao(info) {
    const { medNome, novoEstoque, diasRestantes } = info;
    const nivel = classificarNivelEstoquePorDias({ novoEstoque, diasRestantes });
    const unidade = novoEstoque === 1 ? 'unidade' : 'unidades';

    if (nivel === 'zerado') {
        return (
            `\n\n⚠️ *Atenção:* você acabou de tomar o último comprimido do *${medNome}* disponível. ` +
            `Não esqueça de providenciar a recompra!\n` +
            `Quando comprar, me avise: *"Comprei 30 comprimidos de ${medNome}"* 💊`
        );
    }

    if (nivel === 'urgente') {
        return (
            `\n\n🚨 *Atenção:* você tem mais *${novoEstoque}* ${unidade} do *${medNome}*, e com esse estoque ` +
            `você NÃO consegue fechar mais um dia completo de tratamento. Como a recompra é urgente, que tal ` +
            `reservar alguns minutos pra ir até a farmácia mais próxima ou pedir entrega ainda hoje? ` +
            `Não podemos descuidar da sua saúde! 💊`
        );
    }

    const prazo = diasRestantes === 1 ? 'apenas mais *1 dia*' : `mais *${diasRestantes} dias*`;
    return (
        `\n\n⚠️ *Lembrete de estoque:* você tem *${novoEstoque}* ${unidade} do *${medNome}*, o que te garante ` +
        `${prazo} de tratamento. Assim que fizer a recompra, me avise aqui com a quantidade para eu atualizar ` +
        `seu estoque! 💊`
    );
}

export function buildAlertaEstoqueNaoInformado(firstName, info) {
    const { medNome, novoEstoque, diasRestantes } = info;
    const nivel = classificarNivelEstoquePorDias({ novoEstoque, diasRestantes });
    const unidade = novoEstoque === 1 ? 'unidade' : 'unidades';

    const prazo = nivel === 'zerado'
        ? 'está esgotado'
        : nivel === 'urgente'
            ? 'não é suficiente para fechar mais um dia de tratamento'
            : (diasRestantes === 1 ? 'dura mais 1 dia' : `dura mais ${diasRestantes} dias`);

    return (
        `⚠️ ${firstName}, não recebi confirmação da sua dose do *${medNome}*.\n\n` +
        `Seu estoque atual é de *${novoEstoque}* ${unidade} — ${prazo}.\n` +
        `Quando puder, me avise se tomou, e não esqueça de providenciar a recompra! 💊`
    );
}
```

### 4.3 — Retrofit dos 3 arquivos consumidores

| Arquivo | Antes | Depois |
|---|---|---|
| `router.js` | Função local `buildAlertaEstoqueMessage` (linhas 17-37) | Remover. Importar `buildAlertaEstoquePosConfirmacao` de `./templates/estoqueTemplates.js`. Linha 129: `alertaSufixo += buildAlertaEstoqueMessage(estoqueInfo)` → `alertaSufixo += buildAlertaEstoquePosConfirmacao(estoqueInfo)`. Linha 451: mesma troca, com `=`. |
| `agentes/principal.js` | Função local `buildAlertaEstoqueMessage` (linhas 28-48) | Remover. Importar de `../templates/estoqueTemplates.js`. Linhas 367 e 402: `buildAlertaEstoqueMessage(estoqueInfo)` → `buildAlertaEstoquePosConfirmacao(estoqueInfo)`. |
| `agentes/lembrete.js` | Função local `buildAlertaEstoqueNaoInformadoMessage` (linhas 46-60) | Remover. Importar `buildAlertaEstoqueNaoInformado` de `../templates/estoqueTemplates.js`. Linha 151: `buildAlertaEstoqueNaoInformadoMessage(firstName, estoqueInfo)` → `buildAlertaEstoqueNaoInformado(firstName, estoqueInfo)` (mesma assinatura, 2 argumentos). |

Nenhuma mudança em `getEstoqueInfoParaAlerta`, `calcularAlertaEstoque`, `contarConfirmacoesHoje`, ou no formato de retorno de cada call site (`{ alertaEstoque: string }` em `principal.js`, string concatenada em `router.js`, envio direto em `lembrete.js`).

### 4.4 — Edge cases confirmados

- `novoEstoque` negativo (não deveria ocorrer, mas defensivo): cai em `'zerado'` (`<= 0`).
- `dosesPerDia = 0`: `getEstoqueInfoParaAlerta` já retorna `null` antes de chegar em qualquer função de texto (`database.js:1256`) — nunca alcança o novo código.
- Import circular: `estoqueTemplates.js` importa de `database.js`; `database.js` não importa de `templates/` — sem ciclo, mesmo padrão já usado por `adesaoTemplates.js`.

---

## 5. Cenários de teste (rodar antes de considerar concluído)

1. Medicamento 1x/dia, estoque = 1 após confirmação → `nivel = 'zerado'` → mensagem "último comprimido" (comportamento já existente, deve continuar igual).
2. Medicamento 1x/dia, estoque = 0 → mesmo resultado do item 1 (não deve haver estoque negativo em produção, mas se ocorrer, ainda cai em `'zerado'`).
3. Medicamento 2x/dia, estoque = 1 (reprodução exata do bug do print, com Dipirona) → `nivel = 'urgente'` → mensagem nova, menciona "1 unidade" + urgência, nunca "zerado".
4. Medicamento 2x/dia, estoque = 4 → `diasRestantes = 2` → `nivel = 'ok'` → "mais 2 dias".
5. Medicamento 3x/dia, estoque = 2 → `diasRestantes = 0`, `novoEstoque > 0` → `nivel = 'urgente'`.
6. Medicamento 3x/dia, estoque = 4 → `diasRestantes = 1` → `nivel = 'ok'`, "apenas mais 1 dia".
7. Repetir os cenários 3 e 5 também via `lembrete.js` (dose não confirmada a tempo) — confirmar que a frase não fica contraditória ("Seu estoque atual é de 2 unidades — não é suficiente para fechar mais um dia de tratamento").
8. Confirmar que `buildAlertaEstoqueAjusteMessage` (MH-042) e `relatorioEstoque` continuam com o comportamento atual, inalterado.
9. Re-executar a consulta em `agent_logs`/`stock_movements` para o user_id de Guilherme após um teste real via WhatsApp, e confirmar que a mensagem recebida bate com o `estoque_novo` gravado no mesmo movimento.

---

## 6. Registro no backlog (via `src/backlog.js`, nunca SQL direto)

Ao concluir a implementação e os testes acima, registrar:

**Novo item — corrigido:**
- `tipo: 'BUG'`, `numero: 65`
- `titulo: 'Alerta de estoque pós-confirmação afirma "zerado" quando ainda há unidades'`
- `causa_raiz`: resumo da seção 2 acima (conflação de `diasRestantes === 0` com estoque físico zero, em 3 funções duplicadas)
- `status: 'em_validacao'` (aguardando confirmação real de Guilherme via WhatsApp — não marcar como concluído só pelos testes locais)
- `sessao_criacao`: sessão atual (conferir CONTEXT.md no momento da execução)

**Dois novos itens — apenas registro, sem implementação neste briefing:**
- `tipo: 'MH'`, próximo número livre (conferir `ls briefings/` + `MAX(numero)` antes de atribuir — no momento deste briefing seria MH-049, mas reconfirmar): `titulo: 'calcularAlertaEstoque não trata tipo_tratamento "temporario" no limiar de alerta (1 dia vs 5 dias)'`, `descricao`: Dipirona do print tem `tipo_tratamento = 'temporario'`, que cai no branch padrão (5 dias) de `calcularAlertaEstoque`, igual a `'continuo'` — não está claro se é intencional ou se deveria ter o limiar apertado de 1 dia como `'agudo'` curto. Hipótese em aberto, não investigada.
- `tipo: 'MH'`, próximo número livre (conferir de novo): `titulo: 'Bloco "insuficiente" do progresso de tratamento não exibe estoque real e fica com fraseado estranho quando diasCobertos=0'`, `descricao`: em `templates/adesaoTemplates.js`, `BLOCO_ESTOQUE.insuficiente` usa `{DiasCobertos}` e `{DiasRestantes}` mas nunca `{Estoque}` — quando `diasCobertos=0`, a frase "seu estoque atual dá pra mais 0 dias" fica estranha sem informar quantas unidades sobram. Não é o mesmo bug do BUG-065 (não afirma "zerado" quando não é), mas é uma inconsistência de formatação relacionada.

---

## 7. Fora de escopo deste briefing

- Investigar ou alterar `MH-029` (título antigo, sem causa_raiz preenchida) — permanece separado até decisão futura sobre se trata do mesmo tema.
- Implementar os dois MHs listados na seção 6 — apenas registrar para investigação futura.
- Qualquer mudança em `montarBlocoEstoque`/`adesaoTemplates.js` além do registro do item acima.
- Investigar por que `tratamento_fim` do Dipirona (2026-06-24) já passou 17 dias mas o medicamento segue `ativo=true` — achado colateral observado durante a investigação, possivelmente relacionado a MH-043, não incluído neste briefing.