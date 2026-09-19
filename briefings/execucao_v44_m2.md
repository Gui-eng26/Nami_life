# BRIEFING DE EXECUÇÃO — v44 · M2: Runner + Schema do cadastro

**Pré-requisito:** micro-entrega A16–A20 concluída e arnês 100% (fora expected-fail).
**Branch:** `staging`. Promoção por marco (MH-89 C): arnês verde é o portão de merge.
**Governança:** nenhuma escrita em `backlog_items` a partir deste briefing.
**Fonte de verdade:** `CONTEXT.md` §12 (arquitetura-alvo) + Constituição v1 + este briefing.

---

## 0. Objetivo do M2

O `cadastro.js` (3.390 linhas, 13 etapas artesanais) vira **schema declarado como dado + runner de coleta genérico**. Com isso, três capacidades novas nascem por construção: múltiplos medicamentos numa mensagem (MH-96), recorrência de posologia (MH-77) e conclusão automática de tratamento agudo (MH-30/49). E uma família inteira de bugs artesanais deixa de poder existir.

O runner é a implementação de referência: M3 (configuração/relatórios) e M4 (onboarding) o reutilizam. Errar a generalidade aqui custa dois marcos — na dúvida entre genérico e simples, escolher o que o `cadastro` precisa HOJE e anotar a generalização.

## 1. Schema como dado (`src/schemas/cadastro.js` — nome sugerido, vocabulário canônico)

Um tratamento é declarado como estrutura de campos; NADA de prompt por etapa. Cada campo declara:
- `nome` canônico, `nivel` (`have_to_have` | `importante` | `opcional`), `pergunta` (renderizada em CÓDIGO — absorve MH-85/P54; texto segue a constituição E as emendas do guia, incluída a regra 6 da micro-entrega: nunca repetir o que a pessoa acabou de dizer; fechamento curto);
- `validador`: os classificadores especializados existentes viram validadores de campo — `classificarPosologia`, classificadores de estoque, `validadores/recorrencia.js`, resgates determinísticos ("12/12 hrs"). **Nenhum classificador com histórico de casos de borda é reescrito; muda de endereço, não de lógica**;
- `extraivel`: se o extrator completo pode preenchê-lo (regra imutável: extrator só preenche vazio, NUNCA sobrescreve validador especializado).

Níveis do cadastro (decisões v43/v44 mantidas): have-to-have = nome + posologia composta (quantidade+horários); opcionais = dosagem, forma (inferida, nunca perguntada — pergunta só na ambiguidade real), tipo/duração de tratamento, estoque (convite leve pós-gravação). Gravação no instante have-to-have completo (P56); resumo determinístico pós-gravação; sem etapa de confirmação (§12.3).

**Sujeito por tratamento (decisão care_network):** o schema carrega `sujeito` com default "o próprio usuário". Nenhuma UI nova, nenhuma pergunta nova — só a modelagem, para os schemas não precisarem ser refeitos quando o cuidador chegar.

## 2. Runner de coleta (`src/runner.js`)

Uma implementação, quatro responsabilidades, nada além:
1. **O que falta:** próximo campo = primeiro have-to-have vazio (função ÚNICA — mata em definitivo a dupla `primeiraEtapaFaltante`/`proximaEtapaFaltante`).
2. **Absorver a mensagem:** todo turno passa pelo extrator completo + validador do campo corrente; campos incidentais nunca se perdem (P57, §12.3); correção pós-fechamento continua entrando pela porta (A9 permanece verde).
3. **Quando gravar e o que dizer:** gravação por ponto único com guarda anti-duplicata (**absorve ACH-3**: `saveSchedule` recusa horário duplicado do mesmo medicamento); mensagens de persistência 100% template lendo pós-escrita (regra 2).
4. **Quando devolver:** contrato universal da porta (finalizou / ruído / dúvida / mudou de fluxo → devolve). "Medicamento diferente = cadastro novo" (M1) vira comportamento do runner — **absorve MH-83** (nada do anterior vaza para o novo; asserção no arnês).

Morrem por construção (verificar por asserção, não por correção): **BUG-102** (cad_confirma_forma não existe mais), **ACH-4** (dosagem ganha validador de formato: número+unidade reconhecível, senão repergunta — "1000mg" nunca vira nome, caso A14), as 13 etapas `cad_*` como código artesanal.

## 3. MH-96 — Múltiplos medicamentos (torna A2-pleno, A16, A17 e A19 verdes)

- O schema aceita **lista de tratamentos**; o extrator completo devolve N candidatos (linhas, separadores " e ", vírgulas).
- **Absorve os precursores do M1 (§12.6 do CONTEXT):** "linha original do 1º medicamento" e "semeadura de horários compartilhados no contexto" deixam de ser caminhos especiais da porta e viram comportamento do runner+extrator — **UM mecanismo de preenchimento, nunca dois** (homogeneidade semântica). O comportamento externo é idêntico; o endereço muda.
- Runner: reconhece TODOS de imediato (regra 3), completa um por vez sem perder a fila ("O Bariatron está pronto! Agora o Imecap Hair — ..."), grava cada um no seu have-to-have completo.
- Nome composto por " e " (A19): propõe divisão em dois, confirma com a pessoa; nunca grava composto em silêncio.
- Fila sobrevive a desvio de fluxo (dúvida no meio → responde → retoma a fila).

## 4. MH-77 — Recorrência (torna A3 mais honesto e depois capaz)

**Descoberta de código:** `schedules.dias_semana` (ARRAY) **JÁ EXISTE** no banco, aparece em um SELECT (`database.js:337`) e **nenhum código escreve ou filtra por ela** — infraestrutura dormente. Aproveitar, não recriar.

- **Modelo de dados:** `dias_semana int[]` (0=domingo…6=sábado; NULL/vazio = todos os dias — compatível com 100% do legado). Acrescentar `intervalo_dias integer` + `data_inicio date` (NULL = sem intervalo) para "dia sim, dia não" (=2) e afins. "1x por semana" = `dias_semana` com um dia. Migração aditiva, zero impacto no legado.
- **Scheduler:** a criação de doses (`createDoseLog`, chamadas em `scheduler.js:220/391/431` e a query `getPendingReminders`) passa a filtrar: hoje ∈ `dias_semana` (quando definido) E (dias desde `data_inicio`) % `intervalo_dias` == 0 (quando definido). Dose de dia não coberto NUNCA nasce.
- **Coleta:** `validadores/recorrencia.js` deixa de só bloquear e passa a PREENCHER (detecta padrão → estrutura por horário: "seg-sex 6h, sáb-dom 10h" = dois schedules com `dias_semana` distintos). O extrator completo ganha o campo.
- **Inventário no MESMO commit (P55):** recorrência sai de AINDA_NAO e entra em FAZ com limites explícitos (dias da semana, dia sim/dia não, 1x por semana; o que ficar de fora — "a cada 3 semanas", ciclos 21/7 — permanece em AINDA_NAO com honestidade).
- **Relatórios/adesão:** revisar os pontos que assumem dose diária (adesão %, dias de cobertura de estoque = estoque ÷ doses POR SEMANA/7, não por dia fixo). Listar no PR os pontos tocados.
- **Desfazer o paliativo da Manô (produção, após merge):** reativar o schedule 10:00 com `dias_semana={0,6}` e restringir o 06:00 a `{1,2,3,4,5}` — script SQL no PR para Guilherme aprovar e rodar. (Aviso a ela: ação do Guilherme.)

## 5. MH-30 + MH-49 — Tratamento agudo de ponta a ponta

`tipo_tratamento`, `tratamento_dias`, `tratamento_fim` já existem e o cadastro já os captura ("por 5 dias" — casos Tantin/Tramal/Nimesulida 19/09). Fecham o ciclo:
- **MH-30 — conclusão automática:** job diário do scheduler: `tratamento_fim` < hoje E `ativo` → desativa medicamento e schedules, e envia PELO FUNIL mensagem de conclusão (template, tom de celebração leve: tratamento do X concluído; se o médico estendeu, é só cadastrar de novo). Origem proativa nova no funil; regra 10 vale.
- **MH-49 — limiar de alerta correto:** para temporário, o alerta de estoque compara com os **dias restantes do tratamento**, não com o limiar fixo de contínuo (nunca "compre mais" para tratamento que acaba antes do estoque).
- Asserções novas no arnês (batizar A21/A22): dose não nasce após `tratamento_fim`; mensagem de conclusão sai pelo funil; alerta de temporário respeita dias restantes.

## 6. MH-86 — Classificador unificado de estoque líquido

Status do frasco + nº de frascos + volume + fração num turno só, como **validador composto do campo estoque** no schema (absorve também MH-73 C.1/C.2 na prática: dados presentes na mesma mensagem nunca descartados — P57). Manter os resgates determinísticos existentes; unificar o ponto de entrada, não reescrever a matemática de gotas/ml (P-gotas do CONTEXT §4).

## 7. Fora de escopo do M2 (não tocar)

Onboarding e `recepcionista`/`data_nascimento` (M4) · runner no `configuracao`/`relatorios` (M3 — mas o runner nasce genérico o bastante para eles) · áudio/foto/cuidador (adaptadores futuros) · MH-93 suporte real a pó/sachê (M2 mantém a convenção já em produção pela micro-entrega: apresentação não representada é reconhecida com honestidade e cai em "unidade" como dose — o validador de forma do schema preserva exatamente isso, A17) · MH-73 D/E · juizOffline.

## 8. Critérios de aceite

1. **Arnês 100%** no alvo M2 sobre os **20 casos atuais**: A2-pleno, A9, A16-M2, A17-M2, A19-M2 verdes; A21/A22 novos verdes; **nenhum caso regredido** — expected-fail restantes apenas A20 (M3) e A10 (M4), conforme `ORDEM_MARCOS`.
2. Grep-guards: nenhum `sendTextMessage` fora de `whatsapp.js`/`funil.js`; nenhuma string de pergunta de coleta fora do schema; `saveSchedule` único ponto de escrita de schedules.
3. Replay manual em staging (Guilherme): (a) lista da Aline ×4 → 4 registros; (b) "seg-sex 6h, sáb-dom 10h" → dois schedules corretos e lembrete só nos dias certos (validar com um schedule de teste no dia corrente); (c) "por 3 dias" → conclusão automática (simular com `tratamento_fim` = ontem); (d) vitaminas da Priscila.
4. Métricas pós-produção (primeiros usuários orgânicos): mediana ≤3 turnos até 1º medicamento; mensagem com N medicamentos → N registros ou explicação honesta.

## 9. Sequência de commits sugerida (arnês entre cada um)

1. Schema + runner em **paridade** com o comportamento atual — **incluindo as correções de M1 da micro-entrega (§12.6): linha do 1º medicamento, horários semeados, salto do extrator sensível ao contexto**. Nenhuma capacidade nova; arnês 20/20 (fora A20/A10) é a prova da paridade. O commit mais arriscado, isolado de propósito.
2. MH-96 multi-medicamento → A2-pleno/A16/A17/A19 verdes.
3. MH-77 recorrência (migração + scheduler + coleta + inventário) → A3 evolui; SQL da Manô no PR.
4. MH-30/49 tratamento agudo → A21/A22.
5. MH-86 estoque unificado + limpezas finais (asserções ACH-3/ACH-4/BUG-102/MH-83).

## 10. Registros para o encerramento (dependem de "sim, registra")

Resolvidos pelo M2: MH-96, MH-77, MH-30, MH-49, MH-86, MH-85, MH-83, BUG-102, ACH-3, ACH-4, MH-73 C.1/C.2 (verificar cobertura real antes de marcar) · CONTEXT.md: §12 ganha M2, esquema de recorrência documentado, `cadastro.js` removido do mapa de módulos · Backlog novo: nenhum previsto (achados do M2 entram como ACH com aprovação).