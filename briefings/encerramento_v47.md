# Briefing de encerramento — v47 (Etapa 1: saída única — EM PRODUÇÃO)

Fluxo padrão de encerramento: as edições do CONTEXT.md são feitas **no `main`**, commit + push; depois **merge `main` → `staging`** (nunca cópia de arquivo). As atualizações de `backlog_items` saem pelo Supabase MCP do próprio Claude Code (funções de `src/backlog.js` quando aplicável). **Nenhuma validação com custo de LLM.**

A promoção já aconteceu e foi verificada pelo planejamento (deploy `16b81be` em produção às 19:25 BRT de 09/10; migrações conferidas por leitura; smoke real `composto` às 19:33; zero `erro_tecnico`). Este briefing só registra o encerramento.

---

## §A — Edições no CONTEXT.md (aplicar exatamente como abaixo)

### A.1 — Cabeçalho

Linha "Última atualização" passa a ser:

```
**Última atualização:** 09/10/2026 (v47 — Etapa 1 completa: saída única em produção; §14.7 substituída pelo mapa de Etapas na §15.1)
```

### A.2 — §3 (Estado atual), inserir no topo da seção

```
**09/10/2026 (v47, deploy `16b81be`):** Etapa 1 — saída única — EM PRODUÇÃO. Compositor
modo-turno (claude-sonnet-4-6, segunda chamada só em turnos com fatos executados, âncora por
código + fallback canônico), catálogo/índice único de autoria de texto, assunto N:N nos envios
(`funil_envio_assuntos`), regra do referente e fala da mensagem direcionada no contexto do
principal, desfazer devolvendo ao status pré-confirmação, mecanismo de mensagem direcionada com
preview. Cobrança encerrada (4ª mensagem pós-"último aviso") REMOVIDA. Detalhes na §15.
```

### A.3 — §5.2 (Princípios), acrescentar ao final

```
**P65 — Regra do referente.** Responder a uma fala da Nami — citando-a ou logo após ela — é
responder ÀQUELA fala. O código afirma qual foi a última fala e qual é o assunto dela (com ou
sem dose, lido da tabela de assuntos); o LLM interpreta a resposta livremente à luz disso, dentro
das capacidades. PROIBIDO materializar como par semântico, lista de palavras ou condição de
tamanho de mensagem — um par "Quero↔convite" é regex com outra roupa (v47, caso Quero/BUG-117).

**P66 — Um fato, um autor: também na cobrança.** Cobrar dose é papel exclusivo do funil proativo
(lembrete + follow-ups), e "último aviso" é último: depois dele, nenhum autor — proativo ou
conversacional — volta a cobrar aquela dose por iniciativa própria; ela permanece aberta para
retroativa. (v47: remoção da cobrança encerrada + contenção da re-cobrança do principal.)

**P67 — Migração por equivalência.** O que funciona muda de casa, não de comportamento: fixture
da saída atual ANTES de mover, byte-idêntico DEPOIS. Melhoria observada no caminho vira nota para
decisão do Guilherme — nunca entra de carona. (v47, Ondas 2–3.)

**P68 — O pior caso do compositor é a mensagem de hoje.** Toda composição por LLM tem âncora por
código (fatos presentes, nada inventado além de fatos+intenção) e fallback canônico determinístico
em falha, reprovação ou timeout. Beco sem saída: zero. Quedas viram `compositor_fallback:*` em
`system_events`. (v47, Onda 1.)
```

### A.4 — §5.3 (Arquitetura-alvo), acrescentar uma linha ao final

```
Realizada: a entrada única existe desde a v45 (P1) e a SAÍDA ÚNICA existe desde a v47 (compositor
+ catálogo + assunto do envio — §15). O requisito permanece como invariante a proteger.
```

### A.5 — §14.7: SUBSTITUIR a seção inteira pelo bloco abaixo

```
### 14.7 Próximos passos (acordados em 29/09) — SUBSTITUÍDA na v47

A sequência desta seção foi reorganizada no mapa de Etapas da §15.1, que é a referência vigente.
De-para das siglas aposentadas: P0/P1 → Etapa 0 · R1/passo 1 → Etapa 1 (ondas 0–3) ·
R2/P2+P3/passo 2 → Etapa 2 · R3/P4/passo 3 → Etapa 3 · R4/passo 4 → Etapa 4 · passo 5 → Etapa 5 ·
R5 ("quem fala, sobre quem") → regra de desenho embutida desde a Etapa 1 · R6 (verificação do
LLM) → portão sem LLM a cada commit + corpus mínimo de casos-ouro por fechamento de etapa
(MH-106), rodado SOMENTE pelo Guilherme, com teto definido antes.
```

### A.6 — Nova seção §15, ao final do arquivo

```
## 15. v47 — Etapa 1: saída única — EM PRODUÇÃO (09/10/2026)

Sessão de 29/09 a 09/10/2026. Continuação da v45. Regra da sessão: a v47 só fecha com a Etapa 1
inteira (desenho → 4 ondas → validação → promoção). Fechou.

### 15.1 O mapa de Etapas (substitui P2–P5 e R1–R6; única nomenclatura vigente)

| Etapa | Conteúdo | Status |
|---|---|---|
| 0 — Fundamento | Arnês/portão + principal como porta única | ✅ produção (29/09, v45) |
| 1 — Saída única | Catálogo de fatos + compositor + funil com assunto | ✅ produção (09/10, v47) |
| 2 — Entrada estruturada | Recorrência no plural, lote, correção antes de gravar (BUG-111/112/113/119/121, MH-105/106) | próxima (v48) |
| 3 — Configuração no runner | Edição como cadastro; frequência como campo; textos nascem no schema; pausar/encerrar por conversa (BUG-116/120, MH-101) | futura |
| 4 — Catálogo de formas | Pó e líquido primeiro (MH-102) | futura |
| 5 — Produto | Foto, áudio, cuidador | futura |

Dentro da Etapa 1, as ondas executadas: **Onda 0** dados e identidade (assunto N:N
`funil_envio_assuntos`, trilha de auditoria do desfazer, mecanismo de mensagem direcionada com
preview) · **Onda 1** compositor modo-turno · **Onda 2** proativas por equivalência (catálogo
único `templates/catalogo.js`) · **Onda 3** jornada catalogada (índice de autoria completo +
guard de cobertura total) · **ajuste-referente** (caso Quero/BUG-117).

### 15.2 Arquitetura entregue

- **Compositor (um autor, dois modos):** turnos com fatos executados → segunda chamada LLM
  (claude-sonnet-4-6) compõe UMA mensagem a partir dos fatos pós-escrita + intenção do principal
  + natureza do turno (normal | correção | chegada), sob o GUIA_COMPOSICAO; turnos sem fatos,
  atalho exato e todos os proativos seguem sem LLM. Caminho registrado em
  `agent_logs.contexto_conversa.composicao` (composto | fallback_ancora | fallback_chamada |
  canonico_direto).
- **Âncora + fallback (P68):** verificação por código; limites documentados em teste (números em
  nomes de remédio permitidos; intenção é entrada permitida — risco residual registrado no ACH-16).
- **Catálogo/índice de autoria:** `templates/catalogo.js` é o lookup único fato → renderização
  canônica; o schema segue dono das perguntas de coleta (índice aponta, não move); guard de
  cobertura total com lista fechada de casas (configuracao.js marcado como dívida da Etapa 3;
  porta.js legado sai na Etapa 2).
- **Assunto do envio (N:N):** todo envio registra do que fala; citação resolve por assunto (com
  fallback ao `funil_envio_id` legado para envios antigos); a mensagem direcionada entra como fala
  na CONVERSA RECENTE quando é o último evento desde o último turno, com texto integral e ordem
  afirmada por código.
- **Desfazer (BUG-115):** devolve ao status pré-confirmação (`dose_logs.status_pre_confirmacao`),
  com trilha `trilha_auditoria` em `system_events`; heurística de fallback corrigida (esgotadas →
  nao_informado, nunca nao_tomado).
- **Vocabulário:** o fato de reversão chama-se `dose_desfeita` (o desenho dizia `dose_revertida`;
  o código é a fonte). `cobranca_encerrada` e `alerta_estoque_nao_informado` estão mortos por
  construção (grep-guard).

### 15.3 Decisões de produto (Guilherme, 29/09–09/10)

1. Segunda chamada de LLM por turno com fatos: aceita; mesmo modelo do principal.
2. Desfazer devolve a dose ao status anterior à confirmação errada.
3. Cobrança pós-"último aviso" removida; re-cobrança espontânea do principal contida (P66).
4. Veto a pares semânticos/listas na interpretação (P65).
5. Mensagem direcionada é sempre autocontida, nunca teaser; honestidade P64 sobre conteúdo além
   da mensagem, sem super-proteção.
6. Detecção de silêncio (MH-104): recuperação no 5º dia oferecendo auto-encerramento; encerramento
   automático no 7º com mensagem final.
7. Corpus LLM fora do caminho crítico de promoção: substituído pelo corpus mínimo de casos-ouro
   por fechamento de etapa (MH-106), rodado só pelo Guilherme, com teto. Casos pré-compositor
   aposentados (`aposentado: 'MH-106'`).
8. Resgate: mecanismo pronto em produção; disparo é decisão do Guilherme (possivelmente pós-Etapa 4).

### 15.4 Casos reais da sessão (causas raiz no backlog)

Caso Quero (BUG-117, corrigido) · Sid — "Sair" travado + 67 proativas sem alarme (BUG-116,
MH-104; lembretes encerrados manualmente 05/10) · Flávia — encerramento multi-tratamento falhou
(BUG-120; encerrada manualmente 09/10) · Samanta — ciclo 21/7 respondido com "ainda não" honesto
(MH-105; P64 funcionando em produção) · Farmix — recorrência na próxima dose (BUG-118, corrigido) ·
ZARVIRON — promessa de aviso em tratamento coberto (BUG-121, Etapa 2).

### 15.5 Política de testes (vigente)

Portão do arnês 100% sem LLM a cada entrega (A0 + A61–A73 e acumulados). O Claude Code NUNCA
executa validação com custo de LLM — nem arnês, nem turnos simulados, nem webhook de teste.
Comportamento de LLM: validação manual do Guilherme em staging + corpus mínimo (MH-106) por
fechamento de etapa, disparado por ele.
```

---

## §B — Atualizações no `backlog_items`

Flipar para `resolvido` (sessão v47, 09/10/2026), com nota curta de resolução:

| Item | Nota de resolução |
|---|---|
| BUG-114 | Onda 0: assunto N:N + identidade/vínculo; precedência da citação; validado 09/10, produção `16b81be`. |
| BUG-115 | Onda 0: `status_pre_confirmacao` + trilha de auditoria; heurística corrigida; validado ao vivo 30/09 (trilha `pendente→confirmado→pendente`). |
| BUG-117 | Ajuste-referente: regra do referente (P65), fala da direcionada, assunto sem dose explícito; validado 09/10 (Quero com/sem citação engaja cadastro). |
| BUG-118 | `calcularProximaDose` via `scheduleCobreDia` (MH-77); validado 09/10 (Farmix fora da lista numa sexta). |
| MH-100 | Etapa 1 completa: ondas 0–3 + ajuste, em produção. Critério de aceite (caso 17:24) cumprido ao vivo em 30/09. |
| MH-103 | "Quem fala, sobre quem" embutido: sujeito no fato tipado (Onda 1) + assunto no envio (Onda 0). A aplicação plena chega com o cuidador (Etapa 5). |

Permanecem abertos (destino anotado na §15.1): BUG-111/112/113/119/121 e MH-105/106 (Etapa 2);
BUG-116/120 e MH-101/104 (Etapa 3); MH-102 (Etapa 4); ACH-15/16 (trazer à pauta na abertura da v48).
Itens novos da v47 já estão todos inseridos no banco — nenhum insert neste encerramento.

## §C — Fechamento

1. Commit no `main`: `docs(v47): encerramento — Etapa 1 saída única em produção; mapa de Etapas na §15; P65–P68`.
2. Merge `main` → `staging`.
3. Relatório curto no chat: diff do CONTEXT.md aplicado, lista dos flips confirmados por leitura.