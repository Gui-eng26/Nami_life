# ENCERRAMENTO — Sessão v32

**Período:** 18/08/2026
**Entregas:** MH-076 (aviso de desenvolvimento, remoção de promessa de cuidador, contato do desenvolvedor)
**Executor:** Claude Code

---

## 1. Ações para o Claude Code

### 1.1 CONTEXT.md

**Atualizar a linha de cabeçalho** (primeira linha do arquivo). Está desatualizada desde a v31
(ficou apontando para o fechamento da v30 — a v31 não a atualizou; achado desta sessão, sem
necessidade de ação retroativa, só corrigir daqui para frente):

De:
```
# 🌿 NAMI — Contexto do Projeto (v30 — FECHADA: MH-072 coleta de data de nascimento
no onboarding, entregue em Partes A/A.1/A.2 com validação em produção a cada ciclo;
priorização de 4 frentes para o beta — MH-072, MH-040, MH-073, MH-009 — 12/08/2026)
```

Para:
```
# 🌿 NAMI — Contexto do Projeto (v32 — FECHADA: MH-076 aviso de desenvolvimento/testes
na abertura e nas capacidades, remoção de promessa de cuidador (funcionalidade sem
interface), orientação de contato do desenvolvedor — validado em produção — 18/08/2026)
```

Inserir a seção da seção 2 deste arquivo **imediatamente antes** de `## Backlog (BUG/FIX/MH/ACH)`,
ou seja, logo após o fim da seção `## Sessão v31`.

Acrescentar o princípio 44 (seção 3) ao fim da lista em `## Princípios de Engenharia`.

**Verificação obrigatória após editar:** `grep -c "^## Sessão" CONTEXT.md` deve ter aumentado em
exatamente 1. Relatar o número antes e depois.

### 1.2 Escritas no backlog

Via `src/backlog.js` (`atualizarStatusBacklogItem`), nunca SQL cru.

```
MH-076   em_validacao -> resolvido
```

Não alterar nenhum outro item — nenhum outro backlog foi tocado nesta sessão.

### 1.3 Git

Commit + push do `CONTEXT.md` atualizado e deste arquivo de encerramento em `briefings/`.
(O `BRIEFING_MH076_TEXTOS_DESENVOLVIMENTO_CUIDADORES.md` já foi commitado na execução anterior,
junto com o código — conferir e não duplicar.)

---

## 2. Seção a inserir no CONTEXT.md

```markdown
## Sessão v32 (18/08/2026) — MH-076: aviso de desenvolvimento, remoção de promessa de
cuidador, contato do desenvolvedor

### Origem da sessão

Fecha a pendência de texto de cuidadores registrada no encerramento da v31, e entrega uma
decisão nova de Guilherme: antes de abrir a Nami para desconhecidos, o produto precisa
comunicar — com transparência e no mesmo tom caloroso de sempre — que ainda está em
desenvolvimento, sem usar a expressão "teste beta" (decisão explícita: termo sem
significado claro para o público-alvo, majoritariamente idoso). Também: se perguntarem
quem criou a Nami, ela pode informar nome e telefone do Guilherme, sem tratar como
sigiloso — hoje essa orientação só existia indiretamente, amarrada a "funcionalidade que
não existe" (`prompts.js`, regra anti-alucinação), e só no `principal.js`.

### Diagnóstico prévio — a promessa de cuidador

`grep -rni "cuidador\|quem cuida\|familiar" src/` (conforme a própria v31 já pedia)
encontrou 3 menções em texto voltado ao usuário — todas prometendo, direta ou
condicionalmente, uma funcionalidade sem interface implementada. Causa raiz confirmada
pelo próprio comentário da migration: a tabela `care_network` está marcada como
"Estrutura preparada para Fase 3 — sem interface implementada ainda" — nenhum fluxo
conversacional grava linha nela.

- `recepcionista.js:256` (etapa `recep_apresentacao`) — afirmava a capacidade como ativa.
  A promessa mais direta.
- `prompts.js:86` (seção LGPD, `principal.js`) — condicional ("se ele cadastrou algum").
- `exclusaoConta.js:126` — mesma natureza condicional, no template de confirmação de
  exclusão de conta.

Decisão de Guilherme: remover as três, inclusive as condicionais — "ainda dão a entender
que existe algo que o usuário não está usando."

### O que foi entregue

1. Remoção das 3 menções a cuidador, nos três arquivos.
2. Aviso de desenvolvimento/testes, como instrução de geração livre (não template fixo —
   mesma arquitetura já usada em `recepcionista.js`/`principal.js` para todo o resto do
   texto conversacional; só dado de saúde segue template determinístico, princípios
   13/28), em três pontos:
   - Apresentação de abertura para usuário novo (`recep_boas_vindas`, branch padrão).
   - Resposta a "pra que você serve" antes do onboarding (`recep_apresentacao`).
   - Resposta a "o que você faz"/"pra que serve" depois do onboarding
     (`NAMI_SYSTEM_PROMPT`, nova seção `SOBRE VOCÊ MESMA`, usada por `principal.js`).
   - Regra fixa nos três pontos: nunca usar a expressão "teste beta".
3. Nova regra global de identidade do desenvolvedor (bloco compartilhado a toda etapa em
   `recepcionista.js`; seção nova em `prompts.js`): se perguntarem quem criou/desenvolveu/
   é responsável pela Nami, informar nome e telefone do Guilherme sem tratar como
   sigiloso.

### Validação em produção (evidência real, `agent_logs` cruzado com `system_events` e
`conversation_state`)

Zero eventos em `system_events` na janela dos testes — nenhuma falha de classificador ou
parse durante a validação. 4 de 4 cenários planejados confirmados:

| Cenário | Evidência |
|---|---|
| Abertura de usuário novo | `"Oi"` → `recep_boas_vindas` → aviso presente, sem "teste beta", sem cuidador |
| "Pra que você serve" — antes do onboarding | `"Pra que vc serve?"`, usuário novo → `classificarIntencaoInicial` = `descobrir` → `conversation_state.state = 'recep_apresentacao'` confirmado no banco → capacidades (sem cuidador) + aviso + convite |
| "Pra que você serve" — depois do onboarding | Usuário já onboarded → `principal.js` → capacidades + aviso, via seção nova `SOBRE VOCÊ MESMA` |
| "Quem te criou?" | `principal.js` → "Fui criada pelo Guilherme Silveira! ... (11) 94106-5858" |

**Achado não planejado:** em `recep_lgpd` — etapa sem instrução própria de aviso — a
pergunta "Como vc pode me ajudar?" também recebeu capacidades e aviso. Causa verificada em
código: `buildSystemPrompt` monta um único texto contendo os blocos de instrução de
*todas* as etapas; "etapa atual" só indica qual seção é a ativa, e o texto inteiro
permanece visível ao modelo em qualquer etapa. O resultado coincidiu com a intenção
original de Guilherme ("todas as vezes que perguntarem como pode ajudar"), então não foi
tratado como problema — mas é um comportamento emergente do formato de prompt único, não
uma instrução escrita linha a linha. Ver princípio novo (44).

### Status final

MH-076 resolvido — 4/4 cenários planejados com evidência real em produção, mais 1 achado
favorável não planejado.

### Pendências abertas ao fim da v32

- Texto de cuidadores (pendência da v31) — **fechada** nesta sessão.
- BUG-27 segue aberto, sem causa raiz confirmada (nenhuma investigação nesta sessão).
- MH-75 (edição de dados cadastrais pós-onboarding) segue relevante.
- Observação nova, não registrada como item de backlog (sem autorização explícita nesta
  sessão): duplicação do contato do Guilherme como string literal em `prompts.js` (2x) e
  como constante em `exclusaoConta.js` — oportunidade de consolidação, não bug.
- Achado de processo: o cabeçalho do CONTEXT.md não foi atualizado no fechamento da v31
  (ficou apontando para o fechamento da v30). Corrigido nesta sessão; sem necessidade de
  reescrever histórico.
- Restante das 4 frentes de beta: MH-040, MH-073, MH-009 — nenhuma iniciada.
```

---

## 3. Princípio a acrescentar

```markdown
44. **Um prompt de sistema montado como texto único (blocos de todas as etapas sempre
    presentes, "etapa atual" só sinaliza qual é a ativa) deixa instruções vazarem entre
    etapas — para o bem ou para o mal (v32, MH-076).** Uma regra escrita para uma etapa
    específica pode ser generalizada pelo modelo e aparecer em outra etapa que nunca a
    recebeu explicitamente, porque o texto inteiro do prompt — não só o bloco "ativo" —
    está sempre visível a ele. Isso pode ser desejável (aviso de desenvolvimento
    aparecendo numa etapa não instrumentada, mas dentro do espírito do pedido original) ou
    indesejável (repetição de uma restrição que devia valer só numa etapa). Ao adicionar
    uma instrução nova a um bloco de etapa neste arquivo, considerar que ela é visível ao
    modelo em qualquer etapa — se o efeito colateral for indesejável, a regra precisa de
    uma condição explícita de etapa dentro do próprio texto; a estrutura "SE etapa = X"
    sugere isolamento visualmente, mas não o impõe.
```

---

## 4. Arquivos gerados nesta sessão

- `briefings/BRIEFING_MH076_TEXTOS_DESENVOLVIMENTO_CUIDADORES.md` (já commitado)
- `briefings/encerramento_v32.md` (este arquivo)
- `Nami_Relatorio_v32.docx` (upload manual para o Drive por Guilherme)