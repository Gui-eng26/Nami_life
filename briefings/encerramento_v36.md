# Encerramento da sessão v36 — MH-073 Parte C + correção da geração de perguntas fora da etapa

Execute as quatro tarefas abaixo, na ordem. Nenhuma migration de schema de produto é necessária;
a única alteração de banco é o índice de housekeeping da tarefa 4.

---

## Tarefa 1 — Atualizar o cabeçalho do `CONTEXT.md`

Trocar a linha 1:

```
# 🌿 NAMI — Contexto do Projeto (v35 — FECHADA: MH-073 Parte B.1 + BUG-101 — modelo canônico de escalada)
```

por:

```
# 🌿 NAMI — Contexto do Projeto (v36 — FECHADA: MH-073 Partes C e C.1 + perguntas de estoque renderizadas em código)
```

---

## Tarefa 2 — Inserir a seção da sessão v36 no `CONTEXT.md`

Inserir o bloco abaixo **imediatamente antes** da linha `## Backlog (BUG/FIX/MH/ACH)`, logo após
o fim da seção da v35.

```markdown
## Sessão v36 (26-28/08/2026) — MH-073 Partes C e C.1, e a descoberta de perguntas fora da etapa

Fecha a última parte funcional do cadastro de líquidos e, no caminho, expõe uma classe de
defeito que o projeto não conhecia: **o LLM gerador pode fazer a pergunta de outra etapa, e o
extrator determinístico grava a resposta como se fosse do campo certo.**

### MH-073 Parte C — estoque aproximado de frasco já aberto

A Parte B cobria o frasco lacrado (conta frascos, lê o volume do rótulo, multiplica). O próprio
texto da etapa marcava a fronteira, exigindo a palavra "fechados" na pergunta, com o comentário
`frasco aberto não é tratado como cheio`. A lacuna era conhecida desde a Parte B e adiada de
propósito.

Quem começa a usar a Nami no meio de um tratamento líquido normalmente já tem um frasco em uso,
e ninguém mede ml a olho nu. **Esta é a primeira parte do projeto em que um valor de estoque
nasce como estimativa, não como contagem exata** — por isso foi isolada desde a v33 como o item
de maior risco de UX do MH-073.

Fluxo em três etapas, com a ordem redesenhada nesta sessão para acompanhar a conversa natural:
status do frasco → quantidade ou fração → volume. A reordenação exigiu mudança em um único
lugar, `primeiraEtapaFaltante` (Princípio 50 absorvendo a mudança como projetado).

| Caminho | `estoque_atual` | `estimado` | `estoque_motivo` |
|---|---|---|---|
| Frascos fechados contados | `frascos × volume` | `false` | `frascos_fechados` |
| Aberto + valor exato em ml | valor informado | `true` | `aberto_valor_exato` |
| Aberto + fração informada | `volume × FRACOES_ESTOQUE[bucket]` | `true` | `aberto_fracao:<bucket>` |
| Aberto + "não sei" | `volume × 0.10` | `true` | `aberto_fracao_nao_informada` |

Escala fechada de cinco degraus: `recem_aberto` 1.00, `tres_quartos` 0.75, `metade` 0.50,
`um_quarto` 0.25, `quase_acabando` 0.10. **O piso nunca é zero** — zero é estoque legítimo
(Princípio 49).

Duas colunas booleanas novas registram a proveniência como **dimensão ortogonal**, em vez de
multiplicar valores de `stock_movements.tipo`: `stock_movements.estimado` e
`medications.estoque_estimado` (migration `20260826000000_mh073_parteC_estoque_estimado.sql`).
A segunda é o sinal que a Parte E vai consumir para decidir limiar de alerta e resetar na
recompra com frasco lacrado.

**Decisões de produto:**
- `"não sei"` é aceito de imediato, sem repetir a pergunta. Se a pessoa disse que não sabe, é
  porque não sabe. A Nami avisa que vai cadastrar com quantidade baixa e convida a atualizar
  depois — sem citar o percentual.
- **Três variantes de resumo**, escolhidas em código a partir de `estoque_motivo`. Frascos
  fechados e valor exato informado não recebem nenhuma menção a estimativa: são números que a
  pessoa afirmou com confiança. Fração e piso de segurança recebem.
- Cenário combinado (um frasco fechado E um aberto ao mesmo tempo) adiado deliberadamente —
  tratar só se aparecer em produção, mesmo critério do MH-046/v17.

### MH-073 Parte C.1 — aproveitar o que veio na mesma mensagem

O ramo de status devolvia imediatamente com apenas `status_frasco`, descartando o resto.
Evidências: `"Ta aberto, deve ter uns 60ml"`, `"1 frasco fechado de 100ml"`, `"1 vidro de 100ml
fechado"` — em todos, o usuário informou tudo e a Nami reperguntou. Corrigido para rodar
`extrairFrascosEVolume` (ramo fechado) ou `extrairValorExatoEstoque` (ramo aberto) na mesma
mensagem, podendo pular até duas etapas.

### O achado central — perguntas fora da etapa

Na bateria de 27/08, **seis respostas da Nami divergiram da instrução que o código deu**:

| Etapa no código | Instrução dada | O que a Nami perguntou |
|---|---|---|
| `cad_estoque` (fechado) | "Quantos FRASCOS você tem?" | "Qual o VOLUME de cada frasco?" |
| `cad_estoque_volume` | "Qual o VOLUME desse frasco?" | "Qual a DOSAGEM de cada dose?" |
| `cad_horarios` | "Qual o horário da primeira dose?" | "Quantas doses por dia?" |
| `cad_estoque_volume` | "Qual o VOLUME desse frasco?" | "Estoque registrado com sucesso." |

`buildSystemPrompt` monta um bloco único com as instruções de **todos** os estágios
simultaneamente; a etapa ativa é apenas sinalizada, não isola nada (Princípio 44, registrado
desde a v34 mas nunca dimensionado). Quando o histórico da conversa sugere outra coisa, o LLM
segue o histórico.

**Como isso corrompeu dado de saúde** (cadeia completa, 15:03 de 27/08):
1. LLM perguntou "qual a dosagem de cada vez que você usa?" estando em `cad_estoque_volume`.
2. Usuário respondeu `"5ml"` — resposta **correta** para a pergunta que foi feita.
3. Código rodou `extrairNumero("5ml")` → `volume_frasco = 5`; `frascos (null) || 1 = 1`.
4. Estoque = **5 ml**. Resumo exibiu "restam aproximadamente 0 dias".

Um frasco de 100ml virou 5ml. **A extração não falhou** — leu corretamente a resposta de uma
pergunta errada. Blindar só o extrator não resolveria.

**Por que líquido quebrava e sólido não:** não é qualidade de classificador, é quantas perguntas
parecidas o LLM tem disponíveis para trocar. O ramo sólido tem UMA etapa de estoque. O líquido
tem três a quatro encadeadas com semântica vizinha (frascos / volume / fração), e ainda a
quantidade-por-dose da posologia por perto.

**Correção:** `renderizarPerguntaEstoque` — as perguntas das três etapas de estoque passaram a
ser renderizadas em código, com o LLM autorizado apenas a acrescentar uma saudação curta antes
do texto e proibido explicitamente de confirmar algo como registrado. Mesmo padrão que
`renderizarResumo` já usava em `cad_confirmacao` desde a v34.

### Briefing #1 — `classificarPosologia`: intervalo e início na mesma mensagem

Três mensagens com o mesmo conteúdo semântico produziam três resultados diferentes:

| Mensagem | Resultado antes |
|---|---|
| "5ml de 12/12 hrs. Comecei as 17hrs" | 2 horários corretos |
| "5ml 8/8hrs. Tomo as 20hrs agora" | 1 horário só — intervalo perdido |
| "5ml de 8 em 8hrs comecei as 17hrs" | reperguntou o horário |

**Causa raiz dupla.** No prompt, `posologia_completa` exigia "horário E quantidade" e
`frequencia_intervalo` exigia "sem horários explícitos" — uma mensagem com os três elementos
satisfazia a primeira e era **explicitamente excluída** pela segunda. E os campos
`intervalo_horas`/`horario_inicio` existiam no JSON de saída sem nenhuma regra dizendo quando
preenchê-los. No código, **quatro pontos** liam apenas `classificacao.pares` e nunca
`classificacao.intervaloHoras` — corrigir só o prompt não teria efeito nenhum.

Corrigido com a REGRA 7 no prompt (os dois campos são independentes da categoria, e o LLM nunca
calcula a grade — só devolve o início) e com `expandirParesPorIntervalo`, função compartilhada
usada nos quatro pontos.

### Briefing #3 — forma farmacêutica divergente entre resumo e banco

O usuário corrigiu `"Não é cápsula é comprimido"`, viu o resumo atualizado com "comprimido",
confirmou — e o banco guardou `"cápsula"`. Divergência silenciosa, sem sinal para o usuário.

**Três defeitos encadeados:**
1. O conjunto fechado de `campoAlvo` não continha `forma`, embora o resumo **exiba** a forma. O
   classificador foi obrigado a escolher o vizinho mais próximo e devolveu `dosagem`.
2. A correção foi roteada para `cad_dosagem` com `contextUpdates: {}` — nada gravado. A resposta
   "Anotado, comprimido!" era invenção do LLM.
3. A instrução de proteção do resumo dizia "nunca reescreva **os números**" — protegia os
   números, não as demais linhas. O LLM editou a linha da forma por conta própria.

Corrigido com `forma` no inventário de campos corrigíveis, `extrairFormaDaMensagem` para
aproveitar a forma dita na própria mensagem de correção (resolve em um turno), e blindagem do
resumo inteiro.

**Decisão de arquitetura:** a correção de forma grava **só** a forma, sem recalcular
`unidade_dose` nem `unidade_estoque`. `forma_farmaceutica` é puramente descritiva (v33); as
unidades são as chaves comportamentais. Uma correção de rótulo não pode recalcular posologia nem
estoque em silêncio.

### Observabilidade — a mudança de método

Dois dos cinco pontos reportados na primeira bateria **não puderam ser fechados**: nenhum dos
classificadores de campo do `cadastro.js` registrava a categoria devolvida. O diagnóstico
dependia de inferência a partir do efeito.

Dez classificadores passaram a emitir `🔎 [CAD-CLASSIF]` com a categoria e os campos relevantes,
**sem jamais registrar o conteúdo da mensagem do usuário nem valores de saúde**. O ganho foi
imediato: na bateria seguinte, o comportamento do classificador de posologia foi lido direto do
log.

**Lacuna que permanece:** as mensagens **enviadas** pela Nami não são registradas nos logs do
Railway, só o `msgId`. Foi preciso o export do WhatsApp para fechar o diagnóstico.

### Lição de processo

⚠️ **Quinto e sexto ciclos consecutivos em que o defeito nasceu da especificação, não da
implementação.** Na Parte C, o briefing mandou "aproveitar na mesma extração da mensagem
inicial" apontando para uma seção que tratava só da primeira mensagem do cadastro — o valor na
mensagem de status foi descartado. No Briefing #3, o `case 'forma'` foi roteado para
`cad_confirma_forma` sem sinalizar o propósito, e essa etapa chamou `classificarPosologia`,
descartando a resposta e custando um turno. O Claude Code implementou exatamente o que estava
escrito nos dois casos, e em outros momentos encontrou e corrigiu defeitos do briefing antes de
implementar — comportamento a ser mantido.

⚠️ **Lição de método de diagnóstico (nova):** durante quatro baterias o diagnóstico foi feito
cruzando código, logs do Railway e banco — **sem as respostas da Nami**. Isso produziu
conclusões parciais (dois pontos impossíveis de fechar) e uma atribuição incorreta de intenção
ao usuário. A partir da quinta bateria o transcript do WhatsApp passou a ser fonte obrigatória.
Saber o que o código manda fazer e o que o usuário responde **não basta** — é preciso ver o que
foi entregue.
```

---

## Tarefa 3 — Acrescentar os princípios 54 a 56 ao `CONTEXT.md`

Inserir ao final da lista numerada da seção `## Princípios de Engenharia`, logo após o
princípio 53:

```markdown
54. **A pergunta de uma etapa determinística nasce em código, não em instrução ao LLM.** Um
    prompt de sistema que descreve o que perguntar é sugestão, não restrição: com todos os
    blocos de etapa montados juntos (Princípio 44), o LLM escolhe pelo histórico da conversa.
    Em campos vizinhos isso é invisível até a resposta certa da pergunta errada ser gravada no
    campo errado — foi como um frasco de 100ml virou 5ml. **O extrator não falhou; ele leu
    corretamente a resposta de outra pergunta.** Por isso blindar o extrator não resolve: só a
    pergunta renderizada em código resolve. Regra prática: quanto mais etapas de semântica
    vizinha um fluxo encadeia, maior a superfície — o ramo sólido, com uma única etapa de
    estoque, nunca apresentou o defeito; o líquido, com três a quatro, apresentou seis vezes na
    mesma bateria.

55. **Todo campo exibido ao usuário precisa existir no inventário de campos corrigíveis.** O
    resumo do cadastro exibia `💉 Forma:` enquanto o conjunto fechado de `campoAlvo` não
    continha `forma`. O classificador não tinha como acertar: foi obrigado a escolher o vizinho
    mais próximo (`dosagem`), a correção foi roteada para a etapa errada e nada foi gravado —
    mas o resumo passou a exibir o valor corrigido, porque o LLM editou o texto por conta
    própria. Resultado: divergência silenciosa entre o que o usuário confirmou e o que foi
    persistido. Corolário do Princípio 5, aplicado ao inventário de correção: exibir e permitir
    corrigir são o mesmo contrato.

56. **Texto renderizado em código é protegido por inteiro, nunca por categoria de conteúdo.** A
    instrução do resumo dizia "nunca reescreva os números" — e o LLM reescreveu a linha da
    forma, que não é número. Proteção parcial de artefato determinístico é proteção nenhuma: o
    modelo respeita exatamente o que foi delimitado. A instrução precisa proibir alteração de
    qualquer linha e declarar explicitamente que o artefato **já reflete** a correção que o
    usuário acabou de pedir — foi esse o gatilho da edição.
```

---

## Tarefa 4 — Housekeeping do backlog + índice de proteção

Executar via Supabase MCP no projeto `nputymewnwmnhrtpizzs`.

**4.1 — Índice novo.** O índice existente (`backlog_items_tipo_numero_parte_ativo`) protege
contra reuso de número, mas não contra a mesma descoberta virar dois números diferentes na
mesma sessão. Foi assim que MH-83/84 e ACH-5/6 nasceram duplicados.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS backlog_items_tipo_titulo_ativo
    ON backlog_items (tipo, titulo)
    WHERE status <> 'historico_substituido';
```

**4.2 — Consolidar as duplicatas.** Manter o número menor, aposentar o maior. Os registros de
número maior (MH-84, ACH-6) foram criados ~17h depois, na mesma sessão v35, com evidência
adicional — **incorporar essa evidência no registro que fica** antes de aposentar o outro.

```sql
-- MH-83 recebe o texto mais completo de MH-84
UPDATE backlog_items
SET descricao = (SELECT descricao FROM backlog_items WHERE tipo='MH' AND numero=84)
WHERE tipo='MH' AND numero=83;

UPDATE backlog_items
SET status='historico_substituido',
    notas = COALESCE(notas,'') || ' | Duplicata de MH-83 (mesma sessão v35, registrada ~17h depois com evidência adicional, já incorporada em MH-83). Consolidado na v36.'
WHERE tipo='MH' AND numero=84;

-- ACH-5 recebe o texto mais completo de ACH-6
UPDATE backlog_items
SET descricao = (SELECT descricao FROM backlog_items WHERE tipo='ACH' AND numero=6)
WHERE tipo='ACH' AND numero=5;

UPDATE backlog_items
SET status='historico_substituido',
    notas = COALESCE(notas,'') || ' | Duplicata de ACH-5 (mesma sessão v35). Consolidado na v36.'
WHERE tipo='ACH' AND numero=6;
```

⚠️ Rodar 4.2 **antes** de 4.1 se o índice falhar por conflito — as duplicatas existentes
impedem a criação do índice.

**4.3 — Fechar os itens entregues na v36.**

```sql
UPDATE backlog_items SET status='em_validacao'
WHERE tipo='MH' AND numero=73 AND parte='C';
```

Registrar também a Parte C.1 como entregue (ver 4.4).

**4.4 — Itens novos.** Registrar via `registrarItemBacklog` (`src/backlog.js`), nunca SQL cru.
Numeração: continuar a partir do maior número existente de cada tipo.

| Tipo | Título | Prioridade | Relacionado |
|---|---|---|---|
| MH (73, parte `C.1`) | Aproveitar frascos, volume ou valor exato presentes na mesma mensagem do status do frasco | alta | MH-073 |
| MH (73, parte `C.2`) | Ramo `indeterminado` do status de frasco descarta dados presentes na mensagem | media | MH-073 |
| BUG | `cad_confirma_forma` alcançada pela correção de forma chama `classificarPosologia` e descarta a resposta | media | — |
| BUG | Correção pós-resumo descarta o conteúdo da própria mensagem nos campos estoque, nome e tipo_tratamento | media | — |
| MH | Perguntas de `cad_horarios` renderizadas em código — mesmo padrão do estoque (Princípio 54) | media | — |
| MH | Classificador unificado de estoque líquido — status, frascos, volume e fração em um turno | media | MH-073 |
| MH | Reformulação após falha não reconhece o que o usuário disse — repergunta seca | baixa | — |
| MH | Registrar em log a mensagem enviada pela Nami, não só o `msgId` | media | — |
| ACH | Ordem invertida entre `📩 Mensagem recebida` e `💊 Cadastro — etapa` no mesmo turno (10:04:20 de 28/08) — sem impacto observado | baixa | — |

A Parte C.1 já está implementada e validada; registrar diretamente com status `em_validacao`.
As demais entram como `aberto`.

---

## Tarefa 5 — Commit e push

```
docs: encerramento v36 — MH-073 Partes C e C.1, perguntas de estoque em código (princípios 54-56)
```

---

## Verificação final

```bash
grep -n "v36 — FECHADA" CONTEXT.md
grep -n "## Sessão v36" CONTEXT.md
grep -n "^56\." CONTEXT.md
```

E no banco:

```sql
SELECT tipo, numero, titulo, status FROM backlog_items
WHERE (tipo='MH' AND numero IN (83,84)) OR (tipo='ACH' AND numero IN (5,6));
SELECT indexname FROM pg_indexes WHERE tablename='backlog_items';
```