# Briefing de execução — v47 Onda 3: jornada catalogada (MH-100 parte D — fecha a Etapa 1)

Branch: `staging`, em cima do estado atual (Ondas 0–2 aplicadas). Fluxo padrão. `CONTEXT.md` não é tocado nesta execução.

**Restrição rígida de custo (29/09): o Claude Code não executa NENHUMA validação que dependa de chamada de LLM.** Portão 100% determinístico.

**Natureza da onda: equivalência estrita, como a Onda 2.** Nenhum texto muda. Nenhuma pergunta de coleta muda de casa (§1 explica por quê). Melhoria observada = nota no relatório, decisão do Guilherme.

## §0 — Objetivo

Fechar a Etapa 1 com a propriedade completa: **toda mensagem que a Nami envia tem autoria numa casa conhecida, registrada no índice do catálogo, com assunto gravado no envio e protegida por guard.** As Ondas 0–2 cobriram dose, estoque, turno composto e proativas; esta cobre a jornada — coleta do cadastro, onboarding, nascimento, exclusão, textos de sistema (ainda não / nunca / recusa de áudio / degradado) — sem reescrever nada.

## §1 — O catálogo como índice, não como mudança de casa

Princípio: o catálogo unifica o **lookup**, não força uma casa única onde a coesão manda outra coisa.

1. As perguntas de coleta **permanecem em `schemas/cadastro.js` e `schemas/onboarding.js`** — a coesão campo↔pergunta↔validador é valor, e o grep-guard M2 §8.2 ("nenhuma string de pergunta fora do schema") continua intocado e em vigor. O schema é o sub-catálogo da coleta; `templates/catalogo.js` ganha entradas de jornada que **apontam** para os renderizadores do schema (mesmo padrão que `resumo_semanal` → adesaoTemplates na Onda 2).
2. Entradas novas no índice: `pergunta_coleta {campo, medicamento?}` (schema cadastro), `pergunta_onboarding {campo}`, `boas_vindas` (marcada como redação-LLM com regras — o índice sabe que essa entrada não tem canônico fixo), `pergunta_nascimento`, `dialogo_exclusao`, `nao_suportado`/`nunca`/`recusa_audio` (inventario.js), `degradado` (reperguntaSegura).
3. Textos soltos em casas pequenas (`dataNascimento.js`, strings de `agentes/exclusaoConta.js`, `reperguntaSegura` no router): **não mover nesta onda** — entram no índice apontando para onde estão, e sob guard (§3). Mudança de casa só se for trivialmente segura e coberta por fixture; na dúvida, aponta e não move.
4. **Configuração fica inteiramente fora** — ela será reconstruída em runner+schema na Etapa 3, com os textos nascendo lá. Nenhuma linha de `agentes/configuracao.js` é tocada ou indexada nesta onda.

## §2 — Assunto nos envios da jornada

As respostas dos fluxos de jornada passam a registrar assunto em `funil_envio_assuntos` (tabela da Onda 0):

- Coleta do cadastro: `fato: 'pergunta_coleta'` com o campo corrente e, quando houver, o medicamento em cadastro.
- Onboarding: `pergunta_onboarding` / `boas_vindas`.
- Nascimento, exclusão, degradado, ainda-não/nunca/recusa: o fato correspondente.

Valor prático: uma pessoa que responde dias depois **citando** uma pergunta da Nami ("respondendo àquela pergunta") resolve o assunto pela mesma mecânica da Onda 0 — e a observabilidade passa a dizer do que cada mensagem da jornada tratava. Nenhuma mudança de comportamento do runner além do registro.

## §3 — Guard de cobertura total (o fecho da Etapa 1)

Novo guard no portão: **lista fechada de casas autorizadas a conter texto de mensagem ao usuário** (templates/, schemas/, inventario.js, router.js:reperguntaSegura, dataNascimento.js, agentes/exclusaoConta.js, agentes/configuracao.js até a Etapa 3 — com marcação explícita de "dívida da Etapa 3"). O guard verifica, da forma mais robusta que a implementação conseguir sem falso positivo intratável (ex.: template literals multilinha com marcadores de mensagem — emoji, `{firstName}`, saudações — fora das casas da lista), que nenhuma casa nova de texto surgiu. Mecanismo a critério; requisitos: regressão fica vermelha, limites da heurística documentados no próprio guard.

## §4 — Equivalência

Mesmo método da Onda 2 para qualquer texto que mudar de casa (fixture antes, byte-idêntico depois). Textos que só entram no índice sem mover não precisam de fixture — o guard §3 e o M2 §8.2 os cobrem.

## §5 — O que esta onda NÃO faz

- Não reescreve nenhum texto e não muda nenhuma pergunta.
- Não toca `agentes/configuracao.js` (Etapa 3) nem o `porta.js` legado do onboarding (sai na Etapa 2, entrada estruturada).
- Não toca compositor, proativas, dose, estoque — além das entradas de índice.
- Não executa validação com custo de LLM.

## §6 — Relatório final

(1) Checks do portão — incluindo o portão acumulado das Ondas 0–2 verde; (2) o índice completo do catálogo impresso (fato → casa), que é o mapa de autoria da Etapa 1 encerrada; (3) notas de melhoria observadas (sem aplicar); (4) validação manual do Guilherme — leve: percorrer um cadastro em staging do início ao fim e confirmar que nada mudou; (5) a dívida explícita registrada: configuração fora do catálogo até a Etapa 3.