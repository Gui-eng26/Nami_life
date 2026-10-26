# Encerramento v48 — 26/10/2026

**Sessão operacional.** Guilherme trouxe três interações reais observadas em produção
(Carla, Dri, Fran). Cada uma teve causa raiz confirmada por banco + logs do Railway +
leitura do `main` (`a44be9d`), correção manual de dados quando necessário e registro no
backlog. **Nenhuma linha de código mudou. Nada vai para `staging` além do merge de
documentação.**

**Governança — leia antes de executar:** nesta sessão, por pedido explícito de Guilherme
e urgência operacional, o chat de planejamento escreveu **direto** no banco de produção
(correções de dados e `backlog_items`). Por isso o §2 abaixo é **somente leitura**:
você confere que os registros existem; **não insere, não atualiza, não flipa nada** em
`backlog_items` nem em qualquer outra tabela.

**Diretriz de custo:** nada aqui envolve LLM. Não rode arnês, turnos simulados nem webhook.

---

## 1. `CONTEXT.md` — edições em `main` (quatro, nesta ordem)

O `CONTEXT.md` é editado **só em `main`** (§7). Aplique as quatro substituições abaixo
exatamente; cada `ANTES` ocorre uma única vez no arquivo atual (`a44be9d`). Se algum
`ANTES` não for encontrado, **pare e reporte** — não improvise.

### 1.1 Cabeçalho (linha 7)

ANTES:
```
**Última atualização:** 09/10/2026 (v47 — Etapa 1 completa: saída única em produção; §14.7 substituída pelo mapa de Etapas na §15.1)
```
DEPOIS:
```
**Última atualização:** 26/10/2026 (v48 — sessão operacional: casos Carla, Dri e Fran em produção; BUG-122, BUG-123, MH-107; §16)
```

### 1.2 Mapa de Etapas — linha da Etapa 2 (§15.1)

ANTES:
```
| 2 — Entrada estruturada | Recorrência no plural, lote, correção antes de gravar (BUG-111/112/113/119/121, MH-105/106) | próxima (v48) |
```
DEPOIS:
```
| 2 — Entrada estruturada | Recorrência no plural, lote, correção antes de gravar, turno misto na resposta ao convite de estoque (BUG-111/112/113/119/121/122, MH-105/106) | próxima (v49) |
```

### 1.3 Referências rápidas (§8) — Railway

Inserir **logo depois** do bloco que termina em ``git dedicada: `staging`.`` (fim do
item "Staging (v40)"), como novo item da mesma lista:

```markdown
- **Railway (v48):** projeto `extraordinary-consideration`
  (`5de552ad-be65-45d2-b494-b067c193d15b`), serviço `Nami_life`
  (`cc9373a6-986f-41fe-af5d-5a87bb0ba3e6`); environments `production`
  (`50cbfd84-ede6-41f9-9ba1-1d71ad22d22a`) e `staging`
  (`a41b8087-a501-49a3-95b3-3cb53ee0f9fa`). O MCP do Railway está conectado ao chat de
  planejamento (`get-logs` por janela de tempo). O id citado de cada turno também fica em
  `agent_logs.reference_message_id` — citação rastreável pelo banco sem abrir o Railway.
```

### 1.4 Nova seção 16 — acrescentar ao FINAL do arquivo

Uma linha em branco depois do último parágrafo da §15.5, depois `---`, depois o bloco:

```markdown
## 16. v48 — Sessão operacional: casos reais em produção (26/10/2026)

Sessão curta, sem código. Guilherme trouxe três interações observadas em produção; cada
uma teve causa raiz confirmada por banco, logs do Railway e leitura do `main` (`a44be9d`),
correção manual de dados e registro no backlog. A Etapa 2 passa a abrir na v49.

### 16.1 Os três casos

| Caso | O que aconteceu | Causa raiz (confirmada) | Registro |
|---|---|---|---|
| **Carla** (16/10) | "Quero finalizar o uso do chat" → o principal respondeu "Fico por aqui 🌿" sem encerrar nada; seguiram 11 lembretes / 31 tentativas em 10 dias, com indício de bloqueio da Nami | Não existe encerrar por conversa (camada 1 do BUG-116). Agravante novo: a despedida AFIRMA um encerramento que não aconteceu — fere o P64 | BUG-116, reprodução 2 |
| **Dri** (22/10) | "Tenho mais quatro unidades, no final dessas unidades termina o tratamento" → estoque gravado e recompra PROMETIDA; o fim do tratamento foi descartado em silêncio | A resposta a um convite de estoque é delegada ao especialista (`router.js` §1), que grava e fecha com template determinístico (`renderizarFechamentoEstoque`) sem ler o resto do turno. A capacidade de destino JÁ existe (configuração contínuo→temporário, `runner.js`; conclusão automática MH-30) — a lacuna é de entrada | BUG-122 (Etapa 2) |
| **Fran** (26/10) | "Sim" citando o último aviso da Vitamina B12 confirmou a dose do Ferro quelato | (1) A citação foi resolvida certa (`proativo:follow_up, 1 dose(s), via assunto`) e o bloco dizia "Mensagem citada → grupo D8", mas o principal relatou `D9:tomou` — a precedência da citação existe só no prompt; o atalho restringe por código ao grupo citado, o principal não. (2) `conversation_state` preso em `configurando` (reativação do Ferro) desde 24/10 bloqueou o atalho, que teria acertado | BUG-123 + MH-107 |

Por que o LLM preferiu o Ferro no caso Fran é **hipótese** (o raciocínio não fica
registrado): três sinais concorrentes — último lembrete era o Ferro; a regra 1
("confirmação vence coleta") favorece dose aguardando resposta; o fluxo aberto falava do
Ferro.

### 16.2 Correções manuais em produção (decisão explícita de Guilherme, 26/10)

- **Carla:** Vitamina encerrada espelhando `encerrarTratamento` (medicamento
  `encerrado`/inativo, schedule desativado, dose pendente → `nao_informado`), 13:52.
- **Dri:** Vitamina D → `temporario`, `tratamento_dias = 28`, `tratamento_fim = 2026-11-19`.
  A RPC `get_pending_reminders` inclui o próprio dia do fim (`>= hoje`), então a dose de
  19/11 sai; o MH-30 conclui em 20/11 às 09:00 com a mensagem de conclusão.
- **Fran:** dose do Ferro de 26/10 12:20 revertida para `nao_informado` (campos
  `revertido_*`); dose da B12 de 07:00 confirmada retroativa (`status_pre_confirmacao =
  nao_informado`) + `stock_movements` `dose_retroativa` −2 (23 → 21);
  `conversation_state` → `idle`.

### 16.3 Achados — não re-derivar

- `agent_logs.reference_message_id` guarda o id citado de cada turno.
- O log `💾 [CACHE] <motivo>` é métrica de cache por chamada de LLM; o `<motivo>` é o
  rótulo da chamada (ex.: `principal_decisao_invalida`), NÃO indica retentativa.
- Fotografia de `conversation_state ≠ idle` em 26/10: 17 linhas — estados abertos há até
  56 dias, incluindo 11 `onboarding` com `updated_at` idêntico (22/09 14:09:37, provável
  escrita em lote, a investigar). Detalhe no MH-107.
- Expiração de estado aberto deixa de ser só a "C-c" adiada em 09/10: o caso Fran é o
  primeiro dano real em dado de dose. Virou o MH-107, com desenho em aberto — decisão de
  Guilherme, que quer pensar os impactos com cuidado.

### 16.4 Desvio de ritual registrado

Nesta sessão o chat de planejamento escreveu direto em produção — correções de dados e
`backlog_items` — a pedido explícito de Guilherme, por urgência operacional (§7 diz que o
planejamento só lê). O encerramento apenas verificou os registros. Se isso vira regra
(ex.: "correção operacional urgente pode ser feita pelo planejamento com autorização
explícita"), é decisão pendente de Guilherme.

### 16.5 Estado medido em 26/10/2026 (definições da §13)

| Indicador | Valor |
|---|---|
| Base real (`is_teste = false`) | 40 |
| Ativos | 14 |
| Engajados (mensagem nos últimos 7 dias) | 10 |
| Abandono | 4 |

### 16.6 Próximo

**v49 = abertura da Etapa 2** (entrada estruturada), começando pelo MH-106 (corpus mínimo).
BUG-122 entra na pauta da Etapa 2. Destino de BUG-123 e MH-107: decisão de Guilherme.
Decisões pendentes dele saídas desta sessão: contenção pré-Etapa 3 da despedida do
principal (BUG-116); caminho de correção do BUG-123 (citação de grupo de dose restringir
por código os refs elegíveis do principal, salvo referente explícito na mensagem); desenho
do MH-107; regra para correções operacionais pelo planejamento (§16.4).
```

---

## 2. Verificação do backlog — SOMENTE LEITURA

Rode e confira. **Não escreva nada.**

```sql
SELECT tipo, numero, status, prioridade, sessao_criacao, relacionado,
       left(titulo, 70) AS titulo, (notas IS NOT NULL) AS tem_notas
FROM backlog_items
WHERE (tipo = 'BUG' AND numero IN (116, 122, 123)) OR (tipo = 'MH' AND numero = 107)
ORDER BY tipo, numero;
```

Esperado (4 linhas):

| tipo | numero | status | prioridade | sessao_criacao | relacionado |
|---|---|---|---|---|---|
| BUG | 116 | aberto | alta | v47 | MH-104, BUG-120 |
| BUG | 122 | aberto | alta | v48 | BUG-121, MH-101 |
| BUG | 123 | aberto | alta | v48 | BUG-117, BUG-116, MH-107 |
| MH | 107 | aberto | alta | v48 | BUG-123, BUG-116 |

`tem_notas = true` nas quatro (BUG-116: reprodução 2 — Carla). Divergência → reporte, não corrija.

---

## 3. Commit, push e merge para `staging`

```bash
git checkout main && git pull
# aplicar §1 no CONTEXT.md e salvar este arquivo em briefings/encerramento_v48.md
git add CONTEXT.md briefings/encerramento_v48.md
git commit -m "docs(v48): encerramento — sessão operacional (Carla, Dri, Fran); BUG-122, BUG-123, MH-107; §16"
git push origin main
git checkout staging && git pull && git merge main --no-edit && git push origin staging
git checkout main
```

O `staging` recebe o `CONTEXT.md` **por merge**, nunca por cópia (§7).

---

## 4. Responder com

1. Hash do commit em `main` e hash do merge em `staging`.
2. Saída da query do §2.
3. `grep -n "^## 16\.\|próxima (v49)\|Railway (v48)\|Última atualização" CONTEXT.md` — quatro ocorrências esperadas.