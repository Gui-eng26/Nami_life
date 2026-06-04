---
name: project-multi-agent
description: Multi-agent architecture for Nami — what was implemented in Fase 1 (router + recepcionista + principal)
metadata:
  type: project
---

Fase 1 da arquitetura multi-agente foi implementada em 2026-06-04.

**Why:** Evolução do agente único para arquitetura multi-agente — cada agente tem responsabilidade focada.

**How to apply:** Novos agentes (cadastro, lembrete, etc.) seguem o mesmo padrão: criar em `src/agentes/`, exportar `handleXxx`, registrar no `router.js`.

## Arquivos criados/modificados

- `src/router.js` — roteador central: direciona para recepcionista (onboarded=false) ou principal (idle/onboarded)
- `src/agentes/recepcionista.js` — fluxo de 3 etapas para novos usuários (boas_vindas → coleta_nome → lgpd)
- `src/agentes/principal.js` — lógica Claude do agente principal (extraída do agent.js para evitar dependência circular)
- `src/agent.js` — refatorado: só chama routeMessage e sendTextMessage
- `src/database.js` — adicionadas: `updateUser`, `saveConversationState`, `logAgentInteraction`

## Decisão de design: principal.js separado
`handlePrincipal` foi movido para `src/agentes/principal.js` (não ficou em agent.js) para evitar dependência circular: agent.js → router.js → agent.js.

## Estados da conversa (recepcionista)
- `recep_boas_vindas` → aguardando nome
- `recep_coleta_nome` → aguardando resposta LGPD
- `recep_lgpd` → LGPD recusado (usuário pode tentar de novo)
- Ao aceitar LGPD: `onboarded=true`, `lgpd_accepted=true`, state=`idle`
