# Arnês — execuções da v44 (staging, alvo M1)

## Micro-entrega pré-M2 (19/09/2026) — casos A16–A20

Cinco casos novos de transcrições reais de produção (30/08–02/09):

| Caso | Resultado | O que documenta |
|---|---|---|
| A16 (Aline, dano máximo do BUG-104) | ✅ M1 verde · 🟡 M2 (4 meds com horário por linha) | verdade de persistência a cada turno; linha do 1º medicamento preservada (nunca a grade inteira no 1º) |
| A17 (Priscila, intenção pura → lista → "Pó") | ✅ M1 verde · 🟡 M2 (lista iterada item a item) | coleta sem promessa vazia; "Pó" reconhecido com honestidade; nome nunca reperguntado |
| A18 (Juliana, "é para outra pessoa") | ✅ verde (após a copy do recepcionista) | postura AINDA_NAO com expectativa + caminho real de hoje + retomada da recepção |
| A19 (Flávia, "Regenesis e ofolato D") | ✅ M1 verde · 🟡 M2 (dois registros) | gravado como um, a confirmação declara o nome exato do banco; nunca "X e Y e Y" |
| A20 (Guilherme, "Encerrar todos") | 🟡 M3 (confirmação agregada) | comportamento atual um-a-um documentado como evidência do MH-82/MH-39 |

A18 estava vermelho antes da copy (a resposta omitia o caminho real de hoje) e ficou
verde depois de a especificação torná-lo obrigatório — exatamente a sequência prevista
no briefing da micro-entrega.

Gate final da micro-entrega: **20/20 casos verdes · 126 asserções · 0 falhas no alvo
M1 · 8 conhecidas (M2/M3/M4 deliberadas)**. Os casos novos ainda forçaram duas
correções de M1: linha do 1º medicamento preservada no multi-med (nunca a grade
inteira no 1º remédio — caso Aline) e horários compartilhados semeados
deterministicamente no contexto, com o salto do extrator respeitando o contexto ao
decidir a etapa (P57 — caso Thaielly/A2).


## 3ª execução (19/09/2026) — ENTREGA DO M1 ✅

**57 asserções verdes · 0 falhas no alvo M1 · 4 conhecidas (marco futuro).**
Todos os 8 casos M1 verdes (A1–A8). Critério de aceite §6.1 do briefing cumprido.
Conhecidos, todos deliberados: A2/M2 (os 4 medicamentos registrados — runner),
A9/M2 (BUG-103, correção no resumo) e A10/M4 (data de nascimento no onboarding).

Entre a 1ª e a 3ª execução foram corrigidos, guiados pelo próprio arnês:
porta desviando mensagens com medicamento para nao_suportado; validador de
recorrência dependente do extrator; campos_rica ausente no aceite; horário
solto descartado pelo salto (P57); pergunta fora da última linha nos blocos de
cad_horarios/cad_quantidade (regra 8); CHECK de system_events sem 'porta';
limpeza do arnês via delete_user_account (LGPD exercitada a cada execução).

---

## 1ª execução (19/09/2026) — baseline histórico

Executado por Guilherme após a implementação completa do M1 (commits até
`fix: v44 §5.6/T0 concluído`). Resultado: **50 asserções verdes · 7 falhas no
alvo M1 · 4 conhecidas (M2/M4)**.

| Caso | Resultado | Observação |
|---|---|---|
| A1 | ✅ VERDE (11/11) | mensagem rica → gravado em 1 turno, confirmação declarativa |
| A2 | ❌ 5 falhas | porta propôs `nao_suportado` para a mensagem com 4 medicamentos (multi-med está na lista AINDA_NAO e a porta seguiu o inventário ao pé da letra, desviando do cadastro); o "sim" recuperou a mensagem rica mas sem os campos da porta → sem caminho multi-med → reperguntou horários |
| A3 | ❌ 2 falhas | mesma causa raiz da A2 (porta → nao_suportado); e o validador de recorrência só disparava quando o extrator produzia pares — com texto de dia-da-semana ele não produz |
| A4 | ✅ VERDE (5/5) | dose vence coleta, estado preservado |
| A5 | ✅ VERDE (6/6) | um único bloco de estoque, número pós-débito |
| A6 | ✅ VERDE (6/6) | recusa do estoque fecha pela verdade do banco |
| A7 | ✅ VERDE (5/5) | consentimento LGPD em lista com emoji por item |
| A8 | ✅ VERDE (5/5) | recusa de áudio pelo funil, registrada em agent_logs |
| A9 | 🟡 conhecidos (M2, BUG-103) | correção "Na verdade 9" ainda ignorada |
| A10 | 🟡 conhecido (M4) | data de nascimento junto do nome ainda reperguntada |

Achados de infraestrutura da execução (corrigidos em seguida):
- `system_events_origem_check` não aceitava `origem: 'porta'` — eventos da porta
  eram perdidos (migration 20260919000002).
- Limpeza do arnês quebrava em `stock_movements` (FK deliberadamente sem CASCADE)
  — passou a usar `delete_user_account`, o mesmo caminho da LGPD.

Correções de comportamento aplicadas após esta execução (re-rodar para validar):
1. Regra na porta: mensagem que traz medicamento(s) é SEMPRE `cadastro`, mesmo
   multi-med ou com recorrência — o especialista faz a honestidade de limite
   sem descartar dados.
2. Validador de recorrência também dispara por horários citados na mensagem
   (regex), sem depender do extrator produzir pares.
3. `campos_rica` preservado junto da `mensagem_rica` — o "sim" recupera o
   caminho multi-med.

## 4ª execução (19/09/2026) — ENTREGA DO M2 ✅ (alvo M2)

Runner + schema (v44 M2): `cadastro.js` (3.709 linhas) substituído por
`src/schemas/cadastro.js` + `src/runner.js` + `src/validadores/*`, em 5 commits
com o arnês verde entre cada um.

Gate final: **24/24 casos verdes · 164 asserções · 0 falhas no alvo M2 ·
4 conhecidas** (A20/M3 e A10/M4, conforme `ORDEM_MARCOS`).

- Commit 1 (paridade): 20/20 no alvo M1, 130 asserções — prova de que schema+
  runner reproduzem o comportamento do M1 sem capacidade nova.
- Commit 2 (MH-96): A2-pleno, A16-M2, A17-M2 e A19-M2 verdes de primeira.
- Commit 3 (MH-77): A3 evoluiu de honestidade de limite para capacidade —
  grava 06:00 seg-sex e 10:00 sáb-dom no MESMO turno.
- Commit 4 (MH-30/49): casos novos A21/A22, deterministicamente verdes (sem
  custo de LLM — job de conclusão e fast-path de dose).
- Commit 5 (MH-86 + guardas): A23 (estoque líquido composto) e A0 (grep-guards
  do §8.2 como asserções executáveis + ACH-3 vivo + ACH-4).

Incidente durante a validação: a chave da Anthropic ficou temporariamente sem
créditos (bloqueou porta e classificadores); voltou sozinha na mesma sessão.
Vale registrar: o arnês FALHA COM CLAREZA nesse cenário (degradação da porta),
e os casos determinísticos (A0/A5/A8/A21/A22/A23) continuam rodando.
