# ENCERRAMENTO v44 → v45

Salvar como `briefings/encerramento_v45.md`. Execução pelo Claude Code: "Leia o briefings/encerramento_v45.md e execute".

**Diretriz de custo (vale aqui):** este encerramento é só documentação e backlog — **não rodar o arnês**.

## 1. CONTEXT.md — edições pontuais em `main` (NÃO reescrever o arquivo)

O CONTEXT.md foi mantido em dia a cada marco (§12.6–§12.9). Este encerramento só corrige o que envelheceu e fecha a sessão. Editar em `main`; `staging` herda por merge.

1. **Cabeçalho** — "Última atualização" → `21/09/2026 (encerramento da v44 — arquitetura-alvo M0–M4 concluída, ver §12.9 e §12.10)`.
2. **§3.1 Entregue e validado** — inserir no topo, acima do item do M2:
   - `**v44 M4 (21/09/2026, EM PRODUÇÃO)** — onboarding no runner: portão LGPD determinístico na decisão e fluido na conversa, data de nascimento opcional, pedido pré-onboarding preservado e retomado. Arquitetura-alvo 100%. Ver §12.9.`
   - `**v44 M3 (20/09/2026, EM PRODUÇÃO)** — configuração e relatórios no runner: estado explícito do tratamento, edição e reativação, período livre, elegibilidade do proativo, tool-use em todo o sistema. Ver §12.8.`
3. **§3.1, item MH-072** — a descrição "coleta de data de nascimento em três perguntas separadas" descreve um agente que morreu no M4. Substituir por: `**MH-072** — coleta de data de nascimento (desde o M4: campo opcional do schema de onboarding, ver §12.9).`
4. **§3.2 Em validação** — trocar a frase "Ao fim da v42, 61 itens…" por: `Ao fim da v44, 28 itens abertos; nenhum em validação. Altas: MH-73 D/E, MH-93, MH-97.`
5. **Nova §12.10 — Encerramento da v44 (21/09/2026)**, com este conteúdo:

```
### 12.10 Encerramento da v44 (21/09/2026)

Sessão contínua de 18 a 21/09 (aberta no dia do Campinas Innovation Week). Decisão
de Guilherme de reconstruir a arquitetura "sem medo" — poucos usuários, staging
isolado e a base real de interações como rede de segurança — com o norte de produto:
"você fala com a Nami como se estivesse falando com alguém da sua família".

Entregue e em produção: M0 (arnês), M1 (porta/funil/autoria de fatos/inventário/
citação), micro-entrega A16–A20, M2 (runner + schema do cadastro), M3 (configuração +
relatórios), M4 (onboarding). Arnês final: 36 casos, 391 asserções, 0 falhas,
0 expected-fail. Agentes artesanais removidos: cadastro.js, recepcionista.js,
agentes/data_nascimento.js (5.260 linhas).

Diretriz de custo de API (21/09), permanente: casos afetados por commit; suíte
completa UMA vez no portão de merge; flaky → rerun individual; validação de
comportamento é manual (Guilherme).

Próximos passos recomendados (a decidir na v45):
1. Medir a jornada com os próximos usuários orgânicos (mediana de turnos até o 1º
   medicamento, zero repergunta, conversão do funil).
2. Entrega única "apresentações e unidades": MH-73 D, MH-73 E e MH-93 (mesmo
   validador de forma do schema).
3. Decidir o destino do juiz offline (recalibrar, reescopar ou aposentar) — desde a
   v44 ele não é fonte de análise.
4. Alerta de billing da API.
```

6. Commit + push em `main`; merge `main` → `staging`.

## 2. Backlog — SOMENTE com "sim, registra" de Guilherme

**Não executar esta seção sem a confirmação explícita dele no chat de planejamento, repassada no comando de execução.**

| Item | Ação proposta | Evidência |
|---|---|---|
| MH-88 | `resolvido` por superação | `src/funil.js:30-42` — `enviarAoUsuario` grava `texto` + `zaapId` + `messageId` de todo envio em `funil_envios` (M1). O item pedia exatamente o texto além do msgId. |
| ACH-8 | manter aberto; anotar na descrição: "decisão pendente sobre o destino do juiz offline (v45)" | Decisão de Guilherme (v44): juiz offline não é fonte confiável de análise. |

Nenhum item novo.