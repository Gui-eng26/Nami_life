# Baseline do arnês — pré-M1 (documentado em 19/09/2026)

**Status: previsto a partir das transcrições reais de produção; aguardando a
1ª execução** (o arnês exige `.env.arnes` apontando para o staging — a máquina
local só tem credenciais de produção, que o arnês recusa por construção).

Vermelhos esperados no baseline, caso a caso, com a evidência de produção que
os define:

| Caso | Vermelho esperado no baseline | Evidência (agent_logs, produção) |
|---|---|---|
| A1 | Confirmação declarativa — hoje responde "Anotei aqui: *Minoxidil*", que a regra 2 não aceita como confirmação de persistência | Sid 18/09 16:05 UTC-3 |
| A2 | "Sim" pós-mensagem rica perde os dados (mensagem_rica exige horário+palavra NA MESMA linha; "8h" isolado não casa) → repergunta o nome | Thaielly 18/09: "Sim" → "Qual o *NOME* do medicamento?" |
| A3 | Grava posologia de dias da semana sem representá-la e sem avisar do limite | Manô 18/09 15:26 |
| A4 | "sim" com dose pendente durante adding_med é engolido pelo ramo 9 (cadastro) — dose não confirmada | Manô 19/09 09:58 (corrigida à mão em produção) |
| A5 | Dois blocos de estoque na mesma mensagem, com números divergentes (pré e pós-débito) | Eloísa ("4"+"3"), Wellington ("2"+"1"), Flávia 18/09 |
| A6 | "Depois faço isso" na pergunta de estoque responde "parei o cadastro por aqui" com o medicamento JÁ gravado e ativo | Carla 18/09 16:46 |
| A7 | Consentimento LGPD sai como parágrafo corrido, sem lista com emoji semântico (a forma só aparecia quando o usuário se chamava Guilherme — exemplo literal do guia) | João, staging 18/09 06:36 |
| A8 | Recusa de áudio é atalho fora do pipeline (`agent.js:12`) — invisível em agent_logs e fora do funil | código |
| A9 | 🟡 conhecido (M2 — BUG-103): correção "Na verdade 9" no resumo é ignorada e a pergunta repetida | João Pedro 18/09 15:52 |
| A10 | 🟡 conhecido (M4): data de nascimento enviada junto do nome é reperguntada | Felipe 18/09 12:02 |

Após a 1ª execução real, substituir esta tabela pela saída do runner.
