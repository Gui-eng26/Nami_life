# BRIEFING DE EXECUÇÃO — v44 · Micro-entrega: casos A16–A20 + copy do recepcionista

**Branch:** `staging`. Entrega pequena e independente, para rodar ANTES do M2.
**Governança:** nenhuma escrita em `backlog_items` (fica para o encerramento da v44).

## 1. Cinco casos novos em `arnes/casos.js`

Fonte: transcrições reais de `agent_logs` de produção (30/08–02/09), analisadas na sessão v44. Mesmo padrão dos A1–A15: asserções determinísticas sobre texto final e banco; tags de marco com expected-fail (🟡 CONHECIDO) para marcos acima do alvo.

### A16 — Aline 31/08 09:05 (produção) — lista nome+horário ×4, "Sim", e a verdade
O caso original do BUG-104 na forma de dano máximo: usuária real saiu acreditando em 4 medicamentos cadastrados, com zero linhas no banco, e nunca voltou.
- **Setup:** usuária onboarded, estado `post_onboarding`, zero medicamentos.
- **Turno 1:** `"Suplemento Bariatron 12:00\nImecap Hair : 08:00\nFluxetina 08:00\nTopiramato 21:00"`
- **Turno 2:** `"Sim"`
- **Asserções M1 (devem estar verdes hoje):** nenhum conteúdo ignorado (os quatro nomes reconhecidos na resposta); nenhuma promessa sem executor; NUNCA a string "cadastrado"/"Tudo cadastrado" sem linha correspondente em `medications` (regra 2 da constituição — asserção de verdade lê o banco após cada turno).
- **Asserções M2 (expected-fail até o M2):** ao final, **4 medicamentos no banco**, cada um com seu horário da mensagem (12:00 / 08:00 / 08:00 / 21:00); nenhum campo presente na mensagem reperguntado.

### A17 — Priscila 30/08 23:35 (produção) — intenção pura → lista só-nomes → "Pó"
- **Setup:** usuária onboarded, estado `post_onboarding`, zero medicamentos.
- **Turno 1:** `"Lembrar de tomar minhas vitaminas"` → asserção M1: roteia para coleta (nunca promessa vazia do `principal`).
- **Turno 2:** `"Curcuma C \nVitamina de A a Z \nVitamina b12\nVitamina D"` → asserções M1: os quatro nomes reconhecidos; M2 (expected-fail): itera a coleta item a item SEM perder a lista (após concluir o 1º, oferece o 2º pelo nome).
- **Turno 3:** `"Pó"` como forma → asserção M1: resposta honesta (forma ainda não representada — regra 7; MH-93 é honestidade, não suporte) e **nunca** reperguntar o nome do medicamento que está na conversa (anti-padrão real: "qual é o NOME da Cúrcuma C…?").

### A18 — Juliana 31/08 16:45 (produção) — "É para uma outra pessoa" (escopo estreito)
Escopo deliberadamente de UM turno — o resto da conversa dela foi artefato pré-MH-040 (rajada sem fila) e não é reproduzível no arnês, que chama `routeMessage` direto.
- **Setup:** usuária NOVA em `recep_boas_vindas` (pré-nome).
- **Turno:** `"É para uma outra pessoa"`
- **Asserções M1 (verdes após o item 2 abaixo):** a resposta NÃO afirma capacidade ("funciona sim" e variantes proibidas); vem da postura AINDA_NAO do inventário (honestidade + expectativa: conectar cuidador está chegando); mantém o acolhimento e segue a recepção.

### A19 — Flávia 01/09 (produção) — dois produtos num nome ("X e Y")
- **Setup:** usuário onboarded em coleta de nome de medicamento.
- **Turno:** `"Regenesis e ofolato D"` como nome.
- **Asserções M2 (expected-fail até o M2):** o extrator propõe **dois** registros (confirmando com a pessoa), nunca grava silenciosamente um nome composto por " e "; renderização de confirmação nunca produz "X e Y e Y".
- **Asserção M1:** se gravar como um (comportamento atual), a confirmação declara exatamente o que foi gravado (verdade do banco).

### A20 — Guilherme 02/09 20:04 (produção) — encerramento em lote
- **Setup:** usuário com 4 medicamentos ativos.
- **Turno 1:** `"Encerrar todos"`
- **Asserções M3 (expected-fail até o M3):** reconhecimento de "todos"/seleção múltipla com UMA confirmação agregada; nunca 4 ciclos idênticos de pergunta-confirmação. Evidência do MH-82/MH-39.

## 2. Correção pontual de copy — `recepcionista` (mesmo precedente do §5.8 do briefing M0+M1)

No prompt do recepcionista, a situação "a pessoa diz que é para outra pessoa / para um familiar" vira **especificação de conteúdo** (nunca texto pronto):
- consultar o inventário: conectar cuidador está em AINDA_NAO → resposta honesta com expectativa ("ainda não conecto cuidadores — está chegando"), SEM afirmar que funciona;
- oferecer o caminho real de hoje: a própria pessoa que toma o medicamento pode usar a Nami no telefone dela;
- manter o acolhimento e retomar a recepção (uma pergunta, no fim).
Proibições explícitas no spec: "funciona sim", "consigo acompanhar os medicamentos de outra pessoa" e equivalentes. Não tocar em nenhum outro fluxo do onboarding (segue para o M4).

## 3. Execução e validação

1. Adicionar A16–A20 → `npm run arnes` → **baseline documentado em `arnes/BASELINE.md`** (esperado: asserções M1 de A16/A17/A19 verdes se o M1 estiver íntegro; M2/M3 como 🟡 CONHECIDO; A18 vermelho ANTES do item 2, verde depois).
2. Implementar o item 2 → arnês de novo → A18 verde.
3. Se alguma asserção M1 vier vermelha: é **regressão do M1** — corrigir nesta micro-entrega, antes do M2, e registrar no BASELINE.
4. Validação humana em staging: reproduzir o turno do A18 no WhatsApp de staging.
5. Merge `staging` → `main` com arnês 100% (fora expected-fail), padrão MH-89 C.