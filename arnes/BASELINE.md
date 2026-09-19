# Arnês — execuções da v44 (staging, alvo M1)

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
