# BRIEFING v36 #2 — perguntas de estoque renderizadas em código + correções de fluxo do cadastro

**Sessão:** v36 · **Arquivo único:** `src/agentes/cadastro.js` · **Sem migration.**
**Vem depois do Briefing v36 #1** (posologia), já implementado e validado em produção.

Contém 6 correções. A #1 é nova, descoberta na bateria de testes de 27/08 cruzando código +
Railway + `agent_logs` + transcript do WhatsApp; as demais já estavam desenhadas.

---

## 0. Contexto — a causa raiz que unifica quase tudo

Na bateria de 27/08, **6 respostas da Nami divergiram da instrução que o código deu**:

| Hora | Etapa no código | Instrução do código | O que a Nami perguntou |
|---|---|---|---|
| 14:57:17 | `cad_estoque` (fechado) | "Quantos **FRASCOS** você tem?" | "Qual é o **VOLUME** de cada frasco?" |
| 14:57:33 | `cad_estoque_volume` | "Qual o **VOLUME** desse frasco, em ml?" | "Qual é a **DOSAGEM** de cada dose?" |
| 14:59:33 | `cad_horarios` (`frequencia_sem_inicio`) | "Qual o horário da primeira dose do dia?" | "Quantas **doses por dia**?" |
| 15:03:01 | `cad_estoque` (fechado) | "Quantos **FRASCOS** você tem?" | "Qual o **VOLUME** total do frasco?" |
| 15:03:14 | `cad_estoque_volume` | "Qual o **VOLUME** desse frasco?" | "Qual é a **DOSAGEM** de cada vez que usa?" |
| 15:05:07 | `cad_estoque_volume` | "Qual o **VOLUME** desse frasco?" | "Estoque registrado com **sucesso**." |

`buildSystemPrompt` monta um bloco único com as instruções de TODOS os estágios
simultaneamente; a etapa ativa é apenas sinalizada, não isola nada (Princípio 44). Quando o
histórico da conversa sugere outra coisa, o LLM segue o histórico e não a etapa.

**Por que isso quebra líquido e não sólido:** o ramo sólido tem UMA etapa de estoque — não há
pergunta vizinha para trocar. O ramo líquido tem três a quatro etapas encadeadas com semântica
vizinha (frascos / volume / fração), e ainda a quantidade-por-dose da posologia por perto.

**Como isso corrompeu dado de saúde** (cadeia completa, 15:03):
1. LLM perguntou "qual a dosagem de cada vez que você usa?" estando em `cad_estoque_volume`.
2. Usuário respondeu "5ml" — resposta correta para a pergunta que foi feita.
3. Código rodou `extrairNumero("5ml")` → `volume_frasco = 5`; `frascos (null) || 1 = 1` →
   **estoque = 5 ml**. Resumo exibiu `📦 Estoque: 5 ml` e "restam aproximadamente 0 dias".

Um frasco de 100ml virou 5ml. **A extração não falhou** — ela leu corretamente a resposta de
uma pergunta errada. Por isso blindar só o extrator (correção #4) não basta; a #1 ataca a causa.

---

## 1. Perguntas de estoque renderizadas em código (correção principal, nova)

Etapa determinística merece pergunta determinística. O projeto já faz exatamente isso em
`cad_confirmacao`, onde `renderizarResumo` produz o texto e o prompt instrui: *"Insira EXATAMENTE
este resumo (é dado de saúde renderizado em código, nunca reescreva os números)"*. Aplicar o
mesmo padrão às três etapas de estoque.

**Criar** `renderizarPerguntaEstoque(etapa, context)` — função pura, sem LLM, que devolve o texto
exato da pergunta. Cobre os casos:

| Etapa / estado | Texto |
|---|---|
| `cad_estoque`, sólido | "Quantas unidades de {nome} você tem agora?" |
| `cad_estoque`, líquido, sem `status_frasco` | "O frasco de {nome} já está *ABERTO* (você já está usando) ou ainda está *FECHADO* (nunca foi aberto)?" |
| `cad_estoque`, líquido, `status_frasco === 'fechado'` | "Quantos frascos de {nome} você tem?" |
| `cad_estoque_volume` | "E qual o *VOLUME* desse frasco, em ml? Geralmente está no rótulo — ex: 10ml, 100ml." |
| `cad_estoque_fracao` | "E hoje, quanto mais ou menos ainda sobra nesse frasco de {nome}? Pode ser algo como recém-aberto, 3/4, metade, 1/4, quase acabando — ou, se souber, me diz direto em ml." |

Mais as três variantes de reformulação já existentes (`estoque_indeterminado`,
`status_frasco_indeterminado`, `fracao_indeterminada`, `volume_indeterminado`), com os mesmos
textos que hoje estão no `buildSystemPrompt`.

**No `buildSystemPrompt`**, os `case 'cad_estoque'`, `case 'cad_estoque_volume'` e
`case 'cad_estoque_fracao'` passam a devolver, em vez do texto instrucional atual:

```
Faça EXATAMENTE esta pergunta, sem reescrever, sem acrescentar outra pergunta e sem
antecipar nenhuma etapa seguinte (é fluxo de dado de saúde renderizado em código):
"{pergunta}"
Você pode acrescentar no máximo uma saudação curta e calorosa ANTES da pergunta.
Não confirme nada como registrado ou salvo.
```

A última linha existe por causa do 15:05:07 ("Estoque registrado com sucesso"): a proibição
precisa ser explícita, não implícita.

O texto renderizado vai por `contextParaPrompt` (efêmero, descartado após uso — mesmo mecanismo
de `resumoRenderizado` e `blocoConfirmaForma`, ver comentário nas linhas ~2881-2884), NUNCA
persistido em `novoContext`.

⚠️ **Assunção que o Guilherme precisa confirmar na revisão:** mantive a liberdade do LLM para uma
saudação curta antes da pergunta, para não deixar a Nami robótica. É o que preserva o tom. Se
mesmo isso abrir espaço para desvio, a alternativa é devolver o texto puro sem passar pelo LLM —
mas aí o cadastro de estoque perde a variação natural de linguagem. Optei pelo meio-termo; os
testes vão dizer se foi suficiente.

**Cobertura:** aplicar também em `repetirPerguntaCadastro` (linha ~2889), que reconstrói a
pergunta da etapa atual — sem isso, a repetição volta a ser gerada livremente.

---

## 2. `forma_confirmada` persistido como null (BUG pré-existente)

`decidirCadConfirmaForma` (linha ~1834) persiste `forma_confirmada: context?.forma_sugerida ||
null`. Em líquidos, `forma_sugerida` é **sempre** null quando o nome não contém a forma, porque
`prepararContextoConfirmaForma` descarta o palpite incompatível com a unidade (logs de 26/08:
`palpite_forma_incompativel {"palpite":"comprimido","unidade_dose":"ml"}`, 3 ocorrências).

`primeiraEtapaFaltante` testa `!ctx?.forma_confirmada` → null é falsy → devolve
`cad_confirma_forma` de novo. O comentário nas linhas ~1829-1833 reconhece a armadilha e a corrige
só na chamada em memória (`?? 'generico'`); o valor persistido continua null.

**Confirmação por contraste (26/08):** o loop ocorreu em Liberaflux e Tiratoss (nomes sem forma) e
NÃO ocorreu em "Toss xarope" nem "xarope Guaco" (`forma_sugerida = 'xarope'`).

**Correção:** persistir o mesmo sentinela que já é usado na decisão em memória —
`forma_confirmada: context?.forma_sugerida || 'generico'` — para que o valor persistido seja
sempre truthy. Aplicar nos DOIS pontos de `decidirCadConfirmaForma` que gravam `forma_confirmada`
(o ramo `posologia_completa` e o ramo final), além de qualquer outro ramo que grave esse campo.

---

## 3. `cad_confirma_forma` alcançável sem `blocoConfirmaForma` (BUG pré-existente, Princípio 47)

`blocoConfirmaForma` só é preparado em 3 pontos de entrada (salto do `cad_nome`,
`cad_horarios`/`cad_quantidade_por_dose`, `repetirPerguntaCadastro`). Quando a etapa é alcançada
via `primeiraEtapaFaltante` (vindo de `cad_dosagem`, `cad_tipo_tratamento` ou do próprio
`decidirCadConfirmaForma`), o bloco não existe e o template renderiza literalmente:

> "Liberaflux, só confirmando: ?"

Reproduzido várias vezes em 26/08. É a mesma classe do defeito de `cad_confirmacao` corrigido na
v34 com `garantirResumo` — e a correção nunca foi estendida a esta etapa.

**Correção:** criar `garantirBlocoConfirmaForma(proximaEtapa, contextCompleto, contextParaPrompt)`
espelhando `garantirResumo` (linha ~2356): se `proximaEtapa === 'cad_confirma_forma'` e
`contextParaPrompt.blocoConfirmaForma` estiver ausente, prepará-lo ali. Chamar no **ponto único**
de saída de `decidirEtapa` (linha ~2422), junto do `garantirResumo` que já roda lá — não nos
call sites individuais.

---

## 4. Resposta não reconhecida em "quantos frascos" avança e vira estoque exato (BUG pré-existente)

No ramo fechado de `cad_estoque` (linha ~633), quando `extrairFrascosEVolume` não acha nada o
código devolve `{ acao: 'frascos_apenas', proximaEtapa: 'cad_estoque_volume', contextUpdates: {
frascos: frascos ?? null } }` — **avança com `frascos` nulo**, e `'frascos_apenas'` não está em
`ACOES_DE_FALHA`. Depois, `Number(context?.frascos) || 1` transforma o nulo em 1.

Evidência 26/08: "Jovem acabado de tanto sorrir" → Tiratoss gravado com `estoque_atual = 100`,
`estimado = false`, `motivo = 'frascos_fechados'`. Evidência 27/08: "Sim" (15:05:03) aceito como
contagem de frascos.

**Correção:** quando `frascos === null`, NÃO avançar — devolver
`{ acao: 'frascos_indeterminado', proximaEtapa: 'cad_estoque', contextUpdates: {} }` e acrescentar
`frascos_indeterminado` a `ACOES_DE_FALHA`. Texto de reformulação instrutiva (renderizado pela
função da correção #1): "Não peguei o número 😊 Me diz só quantos frascos de {nome} você tem em
casa — por exemplo: 1, 2, 3."

Quando `frascos !== null && volume === null`, o avanço para `cad_estoque_volume` continua correto.

---

## 5. MH-073 Parte C.1 — aproveitar valor/fração na mesma mensagem do status

O ramo de status em `cad_estoque` (linhas ~637-646) devolve imediatamente com apenas
`status_frasco`, descartando o resto da mensagem. Evidências: "Ta aberto, deve ter uns 60ml"
(26/08 17:58), "1 frasco fechado de 100ml" (27/08 15:02:44), "1 vidro de 100ml fechado" (27/08
15:04:46). Viola o Princípio 1 — a Nami ignora o que o usuário disse.

**Defeito de especificação do briefing da Parte C**, não da implementação: a seção 3 mandava
"aproveitar na mesma extração da mensagem inicial (ver seção 8)", mas a seção 8 trata apenas da
primeira mensagem do cadastro (MH-80).

**Correção:** após classificar o status (`aberto` ou `fechado`), rodar na MESMA mensagem:

- **Ramo `fechado`:** `extrairFrascosEVolume(message)`. Com frascos E volume → finaliza direto
  (`estoque_motivo: 'frascos_fechados'`), pulando duas etapas. Só com frascos → avança para
  `cad_estoque_volume`. Sem nada → segue para a pergunta de frascos como hoje.
- **Ramo `aberto`:** `extrairValorExatoEstoque(message)`. Se achar valor e o volume for conhecido
  → finaliza (`aberto_valor_exato`); se achar valor sem volume → `cad_estoque_volume` com
  `estoque_valor_exato_pendente`. Sem valor → `cad_estoque_fracao` como hoje.

Registrar como **MH-073 Parte C.1** (Parte, não número novo).

---

## 6. Quantidade descartada no bloco `frequencia_sem_inicio` de `decidirCadHorarios`

O bloco antes do `switch` (linha ~1712) — `if (context?.intervalo_horas &&
!context?.horario_inicio)` — procura só um horário. Não achando, devolve `frequencia_sem_inicio` e
**retorna**, sem alcançar o `case 'quantidade_apenas'` que guardaria `quantidade_pendente`.

Evidência 27/08: às 14:59:43 o usuário respondeu "5ml", classificado corretamente como
`quantidade_apenas` (log `CAD-CLASSIF`), e a quantidade foi descartada — teve que repetir "5m" às
15:01:41. Mesma classe da #5: ramo que retorna cedo sem aproveitar o que veio na mensagem.

**Correção:** dentro desse bloco, antes de devolver `frequencia_sem_inicio`, se a classificação
trouxer `quantidadeUnica`, persistir os mesmos campos que o `case 'quantidade_apenas'` já
persiste:

```js
contextUpdates: {
    intervalo_horas: context.intervalo_horas,
    ...(classificacao.quantidadeUnica ? {
        quantidade_pendente: classificacao.quantidadeUnica,
        unidade_dose_pendente: classificacao.unidadeDose,
        forma_explicita_pendente: classificacao.formaExplicita
    } : {})
}
```

Quando o horário de início chegar depois, `resolverComHorarios` já sabe consumir
`quantidade_pendente` e pular a repergunta.

---

## 7. Fora de escopo (explícito)

- **`cad_horarios` com pergunta renderizada em código** — mesmo tratamento da correção #1, adiado
  deliberadamente para não misturar posologia e estoque no mesmo ciclo de teste. É o PRÓXIMO item
  da fila, sequenciado após a validação deste briefing, não um item de prazo aberto.
- **Classificador unificado de estoque líquido** (status + frascos + volume + fração num só turno,
  espelhando `classificarEstoqueSolido`) — registrado como MH para sessão futura.
- Recorrência não-diária (MH-77), Partes D e E do MH-073, ACH-2.

---

## 8. Verificação após implementar

```bash
node --check src/agentes/cadastro.js
grep -n "renderizarPerguntaEstoque" src/agentes/cadastro.js      # 1 def + usos no buildSystemPrompt e repetirPerguntaCadastro
grep -n "garantirBlocoConfirmaForma" src/agentes/cadastro.js     # 1 def + 1 uso (ponto único em decidirEtapa)
grep -n "frascos_indeterminado" src/agentes/cadastro.js          # decisão + ACOES_DE_FALHA
grep -n "forma_confirmada:" src/agentes/cadastro.js              # nenhum ramo deve gravar `|| null`
```

---

## 9. Cenários de validação em produção

Todos com medicamento líquido, exceto o 1 e o 9.

1. **Sólido completo** ("30cps") — não-regressão: continua salvando em um turno.
2. **"1 frasco fechado de 100ml"** na pergunta de status → esperado: estoque 100ml resolvido em UM
   turno, sem perguntar frascos nem volume de novo (correção #5).
3. **"Ta aberto, deve ter uns 60ml"** → esperado: vai para volume com o valor já guardado, sem
   repetir os 60ml.
4. **"Fechado"** e depois uma frase sem sentido na pergunta de frascos → esperado: NÃO avança,
   reformula instrutivamente (correção #4). Era o caso que gravou 100ml de lixo em 26/08.
5. **Fluxo líquido completo, turno a turno** — conferir no transcript que cada pergunta da Nami
   corresponde à etapa do log `💊 Cadastro — etapa:` correspondente. Nenhuma pergunta de
   "DOSAGEM" durante etapas de estoque; nenhuma confirmação de "registrado com sucesso" fora de
   `cad_salvo` (correção #1 — este é o cenário central deste briefing).
6. **Medicamento líquido com nome SEM a forma no nome** (ex: "Liberaflux", não "xarope Guaco") →
   esperado: nenhuma reentrada em `cad_confirma_forma`, nenhuma pergunta "só confirmando: ?"
   (correções #2 e #3).
7. **"8 em 8hrs"** e depois **"5ml"** antes do horário de início → esperado: ao informar o horário,
   a grade fecha SEM repedir a quantidade (correção #6).
8. **Correção de estoque a partir do resumo** ("Meu estoque é 100ml") → esperado: refaz o
   sub-fluxo de estoque do início (status → …) sem estado velho vazando, e sem afirmar sucesso
   antes de `cad_salvo`.
9. **Sólido com nome sem forma** — não-regressão das correções #2/#3 fora do ramo líquido.