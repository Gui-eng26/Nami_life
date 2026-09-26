# Encerramento v45 — 26/09/2026

**Sessão de documentação e padrão.** Nenhuma linha de código de produção foi alterada.
Não há merge de `staging` nesta sessão. Tudo abaixo é edição em `main`.

Escopo: entregáveis da etapa Traction (Mescla), definições de métrica de base e
legitimação da cor creme no guidance de identidade visual.

---

## 1. `CONTEXT.md` — nova seção 13

Acrescentar ao final, antes de qualquer apêndice:

```markdown
## 13. v45 — Definições de métrica de base (26/09/2026)

Fechadas por Guilherme durante a preparação dos entregáveis Traction. Valem para
dashboard, consultas ad hoc e qualquer material externo. Antes disso cada análise
inventava o próprio critério, e dois números da mesma semana se contradiziam.

### 13.1 As quatro definições

| Métrica | Definição | Fonte |
|---|---|---|
| **Usuário ativo** | Tem ao menos um medicamento com lembrete ativo | `medications.ativo = true` |
| **Usuário engajado** | Ativo que enviou ao menos UMA mensagem de qualquer tipo à Nami nos últimos 7 dias | `agent_logs` |
| **Abandono** | Ativo com ZERO mensagens em 7 dias | `agent_logs` |
| **Adesão** | Doses confirmadas ÷ doses agendadas e vencidas, apurada SÓ sobre os engajados | `dose_logs` |

### 13.2 Regras que decorrem delas

- **[REGRA] Engajamento e adesão saem de tabelas diferentes.** Engajamento vive em
  `agent_logs`; adesão vive em `dose_logs`. Medir engajamento por status de dose
  subestima a base, porque ignora quem conversa com a Nami sobre outro assunto —
  responder sobre estoque, corrigir um horário, perguntar algo. Tudo isso é
  engajamento pleno.
- **[REGRA] Não existe "adesão bruta".** Quem está em abandono não tem adesão
  mensurável; incluí-lo no denominador mistura duas populações e produz uma média
  entre quem usa e quem foi embora. Abandono é acompanhado como métrica própria.
- **[REGRA] `sem_estoque` conta como falha de adesão.** A dose não foi tomada — isso
  é não adesão. O rótulo não desculpa a falha: ele registra a CAUSA. É métrica de
  diagnóstico, não de exclusão, e é argumento comercial direto com rede de farmácia.

### 13.3 `sem_estoque` é marcado pelo sistema

Verificado em 26/09: `dose_logs.status = 'sem_estoque'` é gravado pelo scheduler
quando `medications.estoque_atual = 0`. Não tem `taken_at`, não tem resposta do
usuário, e ocorre sem que ele mande qualquer mensagem — confirmado em um usuário com
14 doses `sem_estoque` na janela e última mensagem 7 dias antes.

**Consequência:** o status de dose nunca serve como proxy de interação do usuário.
Para engajamento, consultar `agent_logs` com `agent NOT IN ('lembrete','scheduler')`.

### 13.4 Ciclo 1 entra nas contagens

Supersede a regra anterior de tratar o Ciclo 1 (junho, 6 usuários) apenas como fato
histórico. São usuários reais em uso e entram em TODAS as contagens de base e de
métrica. A separação por ciclo permanece só nas comparações de coorte — por exemplo
turnos até o primeiro medicamento — onde a versão do produto era diferente e misturar
coortes invalidaria a comparação.

### 13.5 Estado medido em 25/09/2026 (janela 19 a 25/09)

| Indicador | Valor |
|---|---|
| Base total | 37 pessoas iniciaram conversa |
| Ativos | 18 |
| Engajados | 15 (83% dos ativos) |
| Abandono | 3 (17%) |
| Adesão dos engajados | 70,8% — 85 de 120 doses |
| Doses perdidas por falta de estoque | 24 (20,0% do agendado) |

Das 35 doses não confirmadas, 24 foram por falta de medicamento e 11 por não resposta.
```

---

## 2. `docs/GUIDANCE_IDENTIDADE_VISUAL.md` — cor creme

Decisão de Guilherme (26/09): o creme usado nas peças do CIW **não foi desvio** — foi
escolha dele, e passa a ser token oficial. O `off_white` sai dos materiais novos.

### 2.1 Seção 1.2 (Cores oficiais do kit)

Acrescentar linha na tabela:

| Creme Nami (fundo) | `#FDE7DA` | 253, 231, 218 | — |

E marcar a linha do off-white:

| Off-white Nami (legado) | `#F6FFFF` | 246, 255, 255 | 3, 0, 0, 0 |

### 2.2 Seção 2.1 (Núcleo)

Substituir a linha do `off_white` por duas:

| Token | HEX | Uso |
|---|---|---|
| `creme` | `#FDE7DA` | fundo de peça gráfica e de slide |
| `off_white` | `#F6FFFF` | **legado** — não usar em material novo |

Hex extraído da peça impressa `Nami_Bula_A6_frente-verso_v2.pdf`: ocupa 90,84% da
página e é idêntico nos quatro cantos.

### 2.3 Regras novas de composição sobre creme

Acrescentar como bloco `[REGRA]` na seção 2:

```markdown
**[REGRA] Sobre fundo `creme`, cartão é branco.** `fundo_suave` (`#F3F6F8`) é um cinza
de base azulada; sobre fundo quente ele embaça e suja os dois. Cartão e bloco de
conteúdo sobre creme usam `#FFFFFF` com contorno fino em `linha`.

**[REGRA] Sobre fundo `creme`, bloco semântico usa CONTORNO, não preenchimento.**
Os tints quentes (`laranja_tint #FFEDE4`, `hipotese_tint #FDF3E0`,
`alerta_tint #FBECEC`) são próximos demais do creme e desaparecem no fundo. O bloco
fica branco e recebe contorno de 1,25 pt na cor do estado; o título do bloco mantém a
cor do estado. A cor continua comunicando o status — muda só onde ela mora.
Tints frios (`marinho_tint`, `decisao_tint`) sobrevivem ao creme, mas por uniformidade
seguem a mesma regra.
```

### 2.4 Seção 5.1 (Padrão de apresentação)

Trocar:

> **[PADRÃO]** Fundo `off_white` (`#F6FFFF`) ou branco.

Por:

> **[PADRÃO]** Fundo `creme` (`#FDE7DA`) ou branco. Fundo `marinho` reservado a slides
> de virada de seção e ao slide de encerramento.

---

## 3. `assets/templates/nami_slides_template.js`

- Acrescentar ao objeto `T`: `creme: "FDE7DA",`
- Manter `offWhite` no objeto, com comentário `// legado — não usar em material novo`
- Trocar `s.background = { color: T.offWhite }` por `{ color: T.creme }` no padrão 1 (abertura)
- Nos padrões 3, 4 e 5, trocar `s.background = { color: T.branco }` por `{ color: T.creme }`
- Nos mesmos padrões, trocar preenchimento `T.fundoSuave` de cartões por
  `fill: { color: T.branco }, line: { color: T.linha, width: 1 }`
- No padrão 5 (estados epistêmicos), trocar `fill: { color: e[3] }` por
  `fill: { color: T.branco }, line: { color: e[2], width: 1.25 }`

Referência de implementação já validada: o gerador do deck Traction desta sessão.

## 4. `assets/templates/nami_identidade.py`

**Nenhuma alteração.** Decisão de Guilherme: creme vale para slides e peças gráficas;
documento longo permanece em fundo branco.

---

## 5. `backlog_items` — inserts

Autorizados por Guilherme nesta sessão. Últimos números em uso: MH-97, ACH-11.

### MH-98 — Dashboard e consultas adotarem as definições de métrica da v45

```
tipo: MH
numero: 98
parte: ''
titulo: Dashboard e consultas adotarem as definições de métrica da v45
status: aberto
prioridade: media
descricao: Aplicar as definições da seção 13 do CONTEXT.md ao dashboard e a
  qualquer consulta de base. Engajamento passa a sair de agent_logs (mensagem do
  usuário em 7 dias), não de status de dose. Adesão apurada só sobre engajados.
  Abandono como métrica própria. Ciclo 1 incluído nas contagens. Expor também as
  doses perdidas por falta de estoque como indicador separado — é argumento
  comercial com rede de farmácia.
```

### ACH-12 — Engajamento e adesão não podem sair da mesma fonte

```
tipo: ACH
numero: 12
parte: ''
titulo: Engajamento e adesão não podem sair da mesma fonte de dados
status: aberto
prioridade: media
descricao: Achado de 26/09. Medir engajamento por status de dose subestima a base:
  quem responde à Nami sobre estoque, horário ou qualquer outro assunto está
  engajado, e isso não aparece em dose_logs. Além disso, dose_logs.status =
  'sem_estoque' é gravado pelo scheduler quando estoque_atual = 0, sem qualquer
  ação do usuário — usá-lo como sinal de interação classifica como engajado quem
  não mandou mensagem nenhuma. Engajamento = agent_logs; adesão = dose_logs.
  Registrado como achado porque afeta toda análise futura de base, não um bug
  isolado.
```

**Nenhum outro item.** Guilherme decidiu explicitamente NÃO abrir item para aplicar a
cor nova a materiais anteriores — eles ficam como estão.

---

## 6. Git

Branch `main`. Commit único:

```
docs(v45): definições de métrica de base e cor creme no guidance

- CONTEXT.md §13: ativo, engajado, abandono e adesão; engajamento em agent_logs
  e adesão em dose_logs; sem_estoque é marcado pelo sistema e conta como falha
  de adesão; Ciclo 1 entra nas contagens
- GUIDANCE_IDENTIDADE_VISUAL.md: token creme #FDE7DA oficializado, off_white
  marcado como legado, regras de cartão branco e bloco por contorno sobre creme
- nami_slides_template.js: token creme e fundos dos padrões 1, 3, 4 e 5
```

Depois do push em `main`, fazer o merge `main` → `staging` conforme o fluxo de
promoção, para o `CONTEXT.md` não divergir entre as branches.