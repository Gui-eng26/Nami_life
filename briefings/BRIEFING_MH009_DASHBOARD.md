# BRIEFING — MH-009: Dashboard de indicadores do Ciclo 2

**Sessão:** v39
**Data:** 30/08/2026
**Executor:** Claude Code
**Item de backlog:** MH-009 (aberto desde 09/06/2026, prioridade alta)

---

## 1. Objetivo

Dar a Guilherme visibilidade dos indicadores-chave do Ciclo 2 (beta público, aberto em
30/08/2026), em PWA utilizável em computador, iPad e iPhone.

O dash **não é ferramenta de administração**: não escreve em nenhuma tabela de produção,
não edita usuários, não dispara mensagens. É leitura.

---

## 2. Fora de escopo (não implementar)

- **Visão financeira / custo de tokens.** Decisão de Guilherme na v39: adiada. O wrapper
  `chamarLLM()` e a tabela `llm_usage` **não** entram aqui.
- **Monitoramento de infra** (Railway, Z-API, Supabase). Adiado.
- **Camada de snapshots pré-agregados.** Avaliada e descartada para este momento — ver §4.3.
- **Persistência de `subtipoRelatorio`.** Limitação conhecida, ver §9.2. Não implementar.
- **Interface de `care_network`.** Fase 2.
- **Qualquer correção nos achados listados em §9.** São observações, não escopo.

---

## 3. Decisões de arquitetura (fechadas com Guilherme na v39)

| Decisão | Escolha |
|---|---|
| Acesso ao banco | **Camada fina de API**. O navegador nunca recebe credencial do Supabase. |
| Hospedagem | **Serviço Railway separado** do bot. Deploy do dash não derruba a Nami. |
| Localização do código | **Mesmo repositório**, pasta `dashboard/`. Deploy separado, código junto. |
| Stack do front | Vite + React + Recharts, PWA instalável. |
| Autenticação | Supabase Auth, usuário admin único. |
| Leitura de dados | Consulta direta, sem snapshots. |

**Por que o código fica no mesmo repositório:** o dash precisa normalizar
`forma_farmaceutica` (módulo `src/templates/dose.js`) e ler o inventário de capacidades
(`src/inventario.js`, criado neste briefing). Duplicar essas regras no serviço do dash
violaria o P30 — texto repetido em N lugares diverge no N+1. Vivendo no mesmo repo, a API
do dash importa os módulos diretamente.

---

## 4. Definições canônicas

> Estas regras existem **uma vez só**, em `dashboard/api/definicoes.js` (SQL fragments e
> helpers). Nenhum endpoint reescreve nenhuma delas. Qualquer painel que precise de uma
> destas noções importa daqui.

### 4.1 Base real vs. conta de teste

Toda métrica de **perfil de usuário, medicamentos, adesão e feedback** filtra
`users.is_teste = false`.

**Exceção deliberada:** o painel de sinais de degradação (§6.1) **não** filtra. Uma falha
técnica é uma falha técnica independentemente de quem a disparou, e `system_events.user_id`
é nulo em eventos de `scheduler` e `catch_global` — filtrar descartaria justamente os
eventos mais graves. O painel exibe, como número secundário, quantos eventos vieram de
conta de teste.

### 4.2 Fuso horário — regra obrigatória

Timestamps são gravados em UTC; o Brasil é UTC−3 (CONTEXT §6.9). **Todo agrupamento por
dia converte antes de truncar:**

```sql
(created_at AT TIME ZONE 'America/Sao_Paulo')::date
```

Sem isso, tudo que acontece entre 21:00 e 23:59 no horário de Brasília é contado no dia
seguinte. Em um produto cujo lembrete mais tardio é noturno, isso desloca sistematicamente
a adesão do fim do dia.

### 4.3 Sem camada de snapshot

Volumes verificados em 30/08/2026: `agent_logs` 2.363, `eventos_proativos` 1.332,
`dose_logs` 1.296, `schedules` 118, `system_events` 70. Com 50 usuários no beta,
`dose_logs` cresce ~250 linhas/dia.

Consulta direta com índice responde em milissegundos nesse volume. Um snapshot criaria uma
segunda representação dos números, passível de divergir da fonte. Revisitar acima de ~300
usuários.

### 4.4 Faixa etária

Calculada em tempo de consulta, **nunca armazenada**. Função SQL única:

```sql
CREATE OR REPLACE FUNCTION faixa_etaria(nascimento date)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN nascimento IS NULL THEN 'nao_informado'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 20 THEN 'menor_20'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 30 THEN '20_29'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 50 THEN '30_49'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 60 THEN '50_59'
    WHEN EXTRACT(YEAR FROM age(current_date, nascimento)) < 70 THEN '60_69'
    ELSE '70_mais'
  END
$$;
```

Faixas fechadas, sem sobreposição. `nao_informado` é faixa de primeira classe e **nunca é
omitida de um gráfico** (P49: `null` não é `0`).

**Regra de exibição:** todo gráfico ou cruzamento por idade mostra, ao lado, a cobertura —
"12 de 50 usuários (24%)". Sem isso, um gráfico feito com um quarto da base se lê como se
descrevesse a base inteira.

### 4.5 Adesão — quais status entram

| status | entra? | motivo |
|---|---|---|
| `confirmado` | sim | desfecho |
| `nao_informado` | sim | desfecho (terminal após 3 tentativas) |
| `sem_estoque` | sim | desfecho |
| `nao_tomado` | sim | desfecho |
| `pendente` | **não** | estado vivo, ainda não resolvido |
| `pausado` | **não** | ciclo interrompido por remoção de horário, não é desfecho de adesão |

Janela: até **D-1** inclusive, para que todo registro já tenha fechamento.
Acumulado desde **05/06/2026** (início da Nami).

`pausado` tem zero linhas hoje, mas é produzido por `removerSchedule` (`database.js`).
Precisa da exclusão explícita, senão aparece no beta e cai num balde "outros" silencioso.

**Fronteira de ciclo — `2026-08-30`.** Constante única em `definicoes.js`. Toda série que
atravessa essa data marca a fronteira e expõe os dois períodos separados. O Ciclo 1 (teste
fechado, núcleo familiar) **nunca** é apresentado como referência, meta ou linha de
comparação do Ciclo 2 — ver §9.2 para o fundamento.

### 4.6 Confirmação retroativa

Definida pelo **par**, nunca pelo booleano sozinho:

```sql
revertido IS TRUE AND revertido_de = 'nao_informado' AND status = 'confirmado'
```

`revertido = true` isolado devolve quatro fenômenos distintos e mistura correção de engano
com confirmação tardia. Composição verificada em 30/08/2026:

| revertido_de | status | n | o que é |
|---|---|---|---|
| `nao_informado` | `confirmado` | 150 | confirmação retroativa ✅ |
| `confirmado` | `confirmado` | 2 | correção de engano, reconfirmada |
| `nao_informado` | `nao_tomado` | 2 | declaração retroativa de não-tomada |
| `confirmado` | `nao_tomado` | 1 | "confirmei sem querer" |

### 4.7 Tentativas

Teto real é **3** (verificado: `max(tentativas) = 3`). Todo `nao_informado` tem exatamente
3 — é o estado terminal do esgotamento dos lembretes, por construção.

**Regra crítica do painel de tentativas:** confirmações retroativas passaram por
`nao_informado` e portanto carregam `tentativas = 3`. Se entrarem no painel "confirmou na
Nª tentativa", as 150 retroativas empilham na 3ª e distorcem a leitura. O painel de
tentativas **exclui** retroativas; elas têm painel próprio (§8.3).

### 4.8 Horários por medicamento

- Denominador: **medicamentos ativos com pelo menos 1 horário ativo**. Medicamento ativo
  sem horário ativo é estado tecnicamente inválido (protegido por trava em
  `configuracao.js:921`) e fica fora do cálculo — decisão de Guilherme, v39.
- Razão = `Σ horários ativos ÷ nº de medicamentos ativos qualificados`, por usuário.
- Faixas semiabertas, porque a razão é fracionária:
  `[1, 2)` · `[2, 3)` · `[3, 4)` · `[4, ∞)`

### 4.9 Forma farmacêutica

`medications.forma_farmaceutica` tem deriva confirmada em produção: `cápsula`/`capsula`,
`colírio`/`gotas`, `xarope`/`líquido`, e um registro com `forma = comprimido` e
`unidade_dose = ml`.

**A normalização acontece na camada de API, importando `src/templates/dose.js`.** O SQL
devolve o valor bruto e a contagem; a API agrupa. Não escrever uma segunda tabela de
normalização (P30, P45).

### 4.10 Janelas de início por tabela

O atalho "desde o início" significa datas diferentes conforme o painel. Cada painel exibe
a sua:

| tabela | início real | painel |
|---|---|---|
| `users`, `agent_logs`, `dose_logs` | 05/06/2026 | perfil, agentes, adesão |
| `system_events` | 27/07/2026 | degradação (corte em 01/08 — ver §6.1) |
| `eventos_proativos` | 01/08/2026 | — |
| `feedbacks` | 27/07/2026 | feedback |

---

## 5. Passo 0 — pré-requisitos

Executar **antes** de qualquer painel.

### 5.1 Migration: marcação de conta de teste

```sql
ALTER TABLE users
  ADD COLUMN is_teste boolean NOT NULL DEFAULT false;

UPDATE users SET is_teste = true
WHERE phone IN (
  '+5519996078506',
  '+5519998093582',
  '+5511941065858'
);
```

Coluna no banco, não lista em variável de ambiente: contas de teste continuarão sendo
criadas durante o beta, e lista em env diverge do banco sem aviso.

### 5.2 Migration: função de faixa etária

Criar `faixa_etaria(date)` conforme §4.4.

### 5.3 Backfill das datas de nascimento

Inseridas **manualmente por decisão administrativa** (v39), preservando o histórico do
Ciclo 1. A alternativa considerada — apagar os usuários e pedir recadastro — destruiria as
565 doses do baseline, as 150 confirmações retroativas e todo o histórico de adesão de
junho a agosto, na véspera de medir o "depois" do experimento.

```sql
UPDATE users SET data_nascimento = '1989-11-06' WHERE phone IN ('+5519996078506','+5519998093582','+5511941065858');
UPDATE users SET data_nascimento = '1966-04-01' WHERE phone = '+5519988811053';
UPDATE users SET data_nascimento = '1987-02-26' WHERE phone = '+554184800404';
UPDATE users SET data_nascimento = '1997-05-27' WHERE phone = '+5519993961820';
UPDATE users SET data_nascimento = '1997-09-30' WHERE phone = '+5519994349690';
UPDATE users SET data_nascimento = '2000-01-01' WHERE phone = '+5516997994376';
UPDATE users SET data_nascimento = '1991-04-29' WHERE phone = '+5519988491053';
```

Verificação obrigatória: `SELECT count(*) FROM users WHERE data_nascimento IS NULL` deve
retornar **0**.

### 5.4 Índices

```sql
CREATE INDEX IF NOT EXISTS idx_dose_logs_scheduled_at ON dose_logs (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_agent_logs_user_created ON agent_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_created_tipo ON system_events (created_at, tipo);
```

### 5.5 Módulo `src/inventario.js` — extração do inventário

O inventário de capacidades existe hoje **em três lugares divergentes**:

- `src/router.js` (~linhas 355–378) — lista canônica: `AGENTES E SUAS CAPACIDADES` e
  `FUNCIONALIDADES QUE A NAMI AINDA NÃO TEM` (6 itens)
- `src/agentes/configuracao.js:77,88` — segunda lista local (3 itens)
- `src/prompts.js:100` — terceira lista, narrativa

Criar `src/inventario.js` exportando o inventário **como dado**:

```js
export const CAPACIDADES = [
  { agente: 'cadastro',      titulo: '...', descricao: '...' },
  { agente: 'relatorios',    titulo: '...', descricao: '...', subtipos: [...] },
  // ...
];

export const NAO_SUPORTADO = [
  'alterar tempo/duração de tratamento',
  'alterar dosagem de um medicamento',
  'alterar nome de um medicamento',
  'registrar sintomas, pressão, glicemia ou outros dados de saúde',
  'falar com médico, agendar consulta',
  'exportar histórico em arquivo'
];
```

`router.js` passa a **montar as seções do prompt a partir deste módulo**, em vez de manter
a string literal. `configuracao.js` e `prompts.js` idem, na medida do que já declaram.

**Invariante a registrar no CONTEXT (novo princípio, ver §11):** quando uma capacidade for
adicionada ou removida, `src/inventario.js` é atualizado na mesma mudança. Mesma disciplina
do P5.

---

## 6. Visão técnica

### 6.1 Sinais de degradação

**Renomeado de "erros".** A tabela `system_events` não é tabela de erros: 39 dos 70 eventos
vêm do Juiz Offline (`desvio_comportamental`), que é auditoria de qualidade, não falha de
execução. Severidade `baixa` inclui omissões esperadas e documentadas. Chamar tudo de
"erro" faria achado de qualidade ser lido como falha de produção — reações opostas.

**Escopo:** `tipo IN ('erro_tecnico', 'desvio_comportamental')`, desde **01/08/2026**.

`intencao_nao_suportada` **não entra aqui** — é sinal de demanda de produto e vai para a
Visão Feedback (§9.1).

**Visão geral — gráfico de linhas, contagem absoluta diária, últimos 30 dias, duas séries
separadas:**

```sql
SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       tipo,
       count(*) AS n
FROM system_events
WHERE tipo IN ('erro_tecnico','desvio_comportamental')
  AND created_at >= (current_date - interval '30 days')
GROUP BY 1, 2
ORDER BY 1;
```

`erro_tecnico` e `desvio_comportamental` são **séries distintas**, nunca somadas: falha
técnica e achado de qualidade pedem reações diferentes.

**Detalhamento macro — por tipo, severidade e origem:**

```sql
SELECT tipo, severidade, origem, count(*) AS n
FROM system_events
WHERE tipo IN ('erro_tecnico','desvio_comportamental')
  AND created_at >= $inicio AND created_at < $fim
GROUP BY 1,2,3
ORDER BY n DESC;
```

**Visão detalhada — lista com `titulo`:**

Filtros: data (atalhos `desde 01/08` · `últimos 7 dias` · `ontem` · período), severidade,
origem. Colunas: data/hora (Brasília), tipo, severidade, origem, `titulo`, `agent`,
`status_triagem`.

### 6.2 Agentes acionados

**Enquadramento (decisão de Guilherme, v39):** o objetivo é medir o que o usuário solicita
**ativamente**. Lembretes são consequência do cadastro, não algo que o usuário aciona —
por isso a ausência do agente `lembrete` em `agent_logs` (P24) não é problema aqui.

**Bloco 1 — capacidades acionáveis pelo usuário** (o ranking propriamente dito):

```sql
SELECT a.agent, count(*) AS acionamentos, count(DISTINCT a.user_id) AS usuarios
FROM agent_logs a
JOIN users u ON u.id = a.user_id
WHERE u.is_teste = false
  AND a.agent IN ('cadastro','relatorios','configuracao','principal')
  AND a.created_at >= $inicio AND a.created_at < $fim
GROUP BY 1
ORDER BY acionamentos DESC;
```

**Bloco 2 — caminhos de sistema e onboarding** (contagem, sem ranking):
`recepcionista`, `data_nascimento`, `fast_path_resposta_tardia`, `erro`. Não são coisas que
o usuário "pede"; misturá-las no ranking distorce a leitura.

**Nota de calibragem que deve aparecer no painel:** com a base do Ciclo 1, 71% de todos os
turnos eram de conta de teste — `configuracao` 94%, `relatorios` 99%. O filtro
`is_teste = false` é o que torna este painel legível.

### 6.3 Inventário de funcionalidades

Renderiza `CAPACIDADES` e `NAO_SUPORTADO` de `src/inventario.js` (§5.5). Aparece em dois
lugares: aqui e ao lado da Visão Feedback (§9.1), que é onde ganha função comparativa.

---

## 7. Visão perfil dos usuários

Todos os painéis desta seção: `is_teste = false`.

### 7.1 Total e crescimento

Número absoluto como destaque. **Crescimento em janela móvel de 7 dias, não D-1 vs D-2** —
sobre base de dezenas, variação percentual dia a dia é ruído (1 cadastro sobre 10 usuários
= +10%; nenhum = 0%).

```sql
SELECT
  count(*) FILTER (WHERE is_teste = false) AS total,
  count(*) FILTER (WHERE is_teste = false AND created_at >= now() - interval '7 days')  AS novos_7d,
  count(*) FILTER (WHERE is_teste = false AND created_at >= now() - interval '14 days'
                                          AND created_at <  now() - interval '7 days')  AS novos_7d_anterior
FROM users;
```

Visão mensal fica preparada na API (agrupamento por mês), exposta na UI quando houver ≥2
meses de beta.

### 7.2 Interações por usuário

Reportar **mediana e média juntas**, com a distribuição. A média é dominada por outliers —
na base do Ciclo 1 os valores reais vão de 1 a 206.

```sql
WITH por_usuario AS (
  SELECT u.id, count(a.id) AS turnos
  FROM users u
  LEFT JOIN agent_logs a ON a.user_id = u.id
  WHERE u.is_teste = false
  GROUP BY u.id
)
SELECT
  percentile_cont(0.5) WITHIN GROUP (ORDER BY turnos) AS mediana,
  avg(turnos)                                          AS media,
  count(*)                                             AS usuarios
FROM por_usuario;
```

Segundo passo, com a mediana como corte: quantos abaixo, quantos acima. Acompanhar de
histograma por faixa de interações.

### 7.3 Inatividade (>7 dias sem interação)

```sql
WITH ultimo AS (
  SELECT u.id, u.data_nascimento, max(a.created_at) AS ultima_interacao
  FROM users u
  LEFT JOIN agent_logs a ON a.user_id = u.id
  WHERE u.is_teste = false
  GROUP BY u.id, u.data_nascimento
)
SELECT faixa_etaria(data_nascimento) AS faixa, count(*) AS usuarios
FROM ultimo
WHERE ultima_interacao IS NULL
   OR ultima_interacao < now() - interval '7 days'
GROUP BY 1
ORDER BY 1;
```

`ultima_interacao IS NULL` (usuário que nunca escreveu) conta como inativo — é o caso mais
severo, não pode sumir por `LEFT JOIN`.

### 7.4 Distribuição etária

Gráfico de barras, contagem e percentual sobre o total da base real. Faixas de §4.4,
`nao_informado` sempre presente.

### 7.5 LGPD não aceita

```sql
SELECT count(*) FROM users
WHERE is_teste = false AND lgpd_accepted IS NOT TRUE;
```

`IS NOT TRUE` cobre `false` **e** `null` — são o mesmo fato (não houve aceite) e colapsá-los
com `= false` perderia registros nulos.

### 7.6 Cadastrou-se mas não cadastrou medicamento

```sql
SELECT count(*) FROM users u
WHERE u.is_teste = false
  AND NOT EXISTS (SELECT 1 FROM medications m WHERE m.user_id = u.id);
```

Critério: **nenhum medicamento jamais cadastrado** (não "nenhum ativo"). A pergunta da H1 é
se a pessoa chegou a completar um cadastro alguma vez.

### 7.7 Medicamentos por usuário

Faixas: `1` · `2` · `3` · `4 ou mais`. Medicamentos **ativos**. Usuários com zero aparecem
no painel §7.6, não aqui.

### 7.8 Horários por medicamento

Conforme §4.8. Faixas semiabertas `[1,2)` `[2,3)` `[3,4)` `[4,∞)`.

```sql
WITH med_qualificado AS (
  SELECT m.id, m.user_id, count(s.id) FILTER (WHERE s.ativo) AS horarios
  FROM medications m
  LEFT JOIN schedules s ON s.medication_id = m.id
  WHERE m.ativo IS TRUE
  GROUP BY m.id, m.user_id
  HAVING count(s.id) FILTER (WHERE s.ativo) > 0
),
razao AS (
  SELECT u.id, sum(mq.horarios)::numeric / count(*) AS horarios_por_med
  FROM med_qualificado mq
  JOIN users u ON u.id = mq.user_id
  WHERE u.is_teste = false
  GROUP BY u.id
)
SELECT
  CASE WHEN horarios_por_med < 2 THEN '1 a menos de 2'
       WHEN horarios_por_med < 3 THEN '2 a menos de 3'
       WHEN horarios_por_med < 4 THEN '3 a menos de 4'
       ELSE '4 ou mais' END AS faixa,
  count(*) AS usuarios
FROM razao GROUP BY 1 ORDER BY 1;
```

Exibir à parte: contagem de medicamentos ativos sem horário ativo (esperado: 0). Se passar
de zero, é sinal de cadastro incompleto e interessa à H1.

---

## 8. Visão base de medicamentos

### 8.1 Total e crescimento

Contagem de medicamentos ativos de usuários reais, com janela móvel de 7 dias (mesma
justificativa de §7.1). Preparar agrupamento mensal na API.

### 8.2 Por forma farmacêutica

SQL devolve bruto; **API normaliza importando `src/templates/dose.js`** (§4.9). Gráfico de
barras ou pizza, com contagem e percentual.

### 8.3 Visão detalhada com filtro de data

Medicamentos cadastrados no período, com forma farmacêutica normalizada por medicamento.

---

## 9. Visão de adesão ao tratamento

Regras de §4.5 (status válidos, exclusão de `pendente` e `pausado`, corte em D-1, acumulado
desde 05/06/2026).

### 9.1 Geral, por status

```sql
SELECT d.status, count(*) AS n
FROM dose_logs d
JOIN medications m ON m.id = d.medication_id
JOIN users u       ON u.id = m.user_id
WHERE u.is_teste = false
  AND d.status IN ('confirmado','nao_informado','sem_estoque','nao_tomado')
  AND (d.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date <= current_date - 1
GROUP BY 1
ORDER BY n DESC;
```

Visão detalhada: mesmo agrupamento com filtro de data.

### 9.2 Status cruzado com faixa etária

Mesma query com `faixa_etaria(u.data_nascimento)` adicionada ao `GROUP BY`. Apresentação:
para cada status, a distribuição percentual **dentro daquele status**, destacando a faixa
dominante.

**O Ciclo 1 não é baseline comparável — regra de apresentação obrigatória.**

O Ciclo 1 foi teste fechado com o núcleo familiar de Guilherme. A composição etária resultante
(três usuários em 20–29, dois em 30–49, um em 60–69) é consequência de quem está na família,
não de captação. **Não é amostra de nada** — nem do público que a Nami atrai, nem do público
que ela serve melhor. Comparar suas taxas por faixa com as do Ciclo 2 seria comparar um
conjunto escolhido por parentesco com um conjunto escolhido por interesse.

Por isso o painel:

- **marca 30/08/2026 como fronteira de ciclo**, visualmente explícita na série temporal;
- **nunca calcula uma média que atravesse a fronteira** sem exibir os dois números separados;
- **não apresenta o Ciclo 1 como referência, meta ou linha de comparação** em nenhum lugar da
  interface. Ele aparece como período anterior, rotulado "Ciclo 1 — teste fechado, núcleo
  familiar";
- exibe a taxa por faixa etária do Ciclo 2 **sem linha de baseline herdada**. O cruzamento
  idade × adesão começa do zero em 30/08/2026.

**A H3 é descoberta, não validação.** A persona da Nami está em aberto: o público idoso foi
a motivação inicial, e a etapa de discovery levantou também o adulto de meia-idade (30–50)
por rotina agitada e dificuldade de lembrar. O Ciclo 2 é o que começa a revelar qual público
tem mais aderência à solução. Nenhuma distribuição etária observada no beta torna o Ciclo 1
certo ou errado, e nenhuma faixa é tratada pela interface como resultado esperado ou desviante.
O painel apresenta a distribuição; a leitura é de Guilherme.

### 9.3 Tentativas e confirmação retroativa

**Painel A — confirmações por número de tentativa (1, 2 ou 3), excluindo retroativas:**

```sql
SELECT d.tentativas, count(*) AS n
FROM dose_logs d
JOIN medications m ON m.id = d.medication_id
JOIN users u       ON u.id = m.user_id
WHERE u.is_teste = false
  AND d.status = 'confirmado'
  AND d.revertido IS NOT TRUE
  AND (d.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date <= current_date - 1
GROUP BY 1 ORDER BY 1;
```

A exclusão de `revertido` é obrigatória: retroativas carregam `tentativas = 3` por
construção e empilhariam na 3ª tentativa.

**Painel B — confirmações retroativas**, pela definição de §4.6. Métrica de destaque, não
linha escondida: 150 de 733 confirmações do Ciclo 1 (20,5%) foram retroativas — uma em cada
cinco só aconteceu depois dos três lembretes expirarem.

Ambos os painéis com quebra por faixa etária e filtro de data.

---

## 10. Visão feedback

### 10.1 Três correntes, lado a lado com o inventário

**Corrente 1 — feedback espontâneo classificado** (`feedbacks`): `elogio`, `critica`,
`sugestao`, com `texto`, `origem`, `status_triagem`, data e faixa etária do usuário.

**Corrente 2 — intenção não suportada** (`system_events`):

```sql
SELECT se.created_at, se.titulo, al.user_message, faixa_etaria(u.data_nascimento) AS faixa
FROM system_events se
LEFT JOIN agent_logs al ON al.id = se.agent_log_id
LEFT JOIN users u       ON u.id = se.user_id
WHERE se.tipo = 'intencao_nao_suportada'
  AND (u.is_teste = false OR u.id IS NULL)
ORDER BY se.created_at DESC;
```

Confirmado em `src/router.js:1161`: o classificador central grava este evento sempre que
retorna `nao_suportado`, ligado ao `agent_log_id`. O `configuracao.js` não perde nada —
escala para o roteador (`escalarParaRoteador: true`), que reclassifica e registra. Ponto de
captura único.

**Corrente 3 — o inventário** (§5.5), renderizado ao lado. É a comparação que Guilherme
descreveu querer: o que a Nami faz × o que os usuários pediram e não obtiveram. As duas
listas juntas respondem isso sem trabalho manual.

**Advertência que deve constar no painel:** os 6 registros de `feedbacks` foram todos
gerados pelo próprio fundador em 27/07/2026, durante a construção do extrator. Não são
percepção de usuário real. Com `is_teste = false`, o painel nasce vazio — e isso é o
resultado correto.

Igualmente: há apenas 2 eventos `intencao_nao_suportada` em dois meses, ambos de 27/07. Com
71% do tráfego sendo teste, a amostra não sustenta nenhuma conclusão sobre frequência.
Tratar como pergunta aberta do Ciclo 2, não como achado.

---

## 11. Identidade visual

Tokens de `assets/templates/nami_identidade.py` (§1, única definição autorizada), expostos
como variáveis CSS em `dashboard/src/tokens.css`:

| token | hex | uso no dash |
|---|---|---|
| `laranja` | `#FC4C02` | primária, destaques, série principal |
| `laranja_escuro` | `#C43C00` | texto pequeno sobre branco (contraste AA) |
| `marinho` | `#0F2B46` | títulos, cabeçalho de tabela |
| `off_white` | `#F6FFFF` | fundo |
| `verde_whatsapp` | `#128C7E` | métricas de confirmação |
| `texto` | `#1A2430` | corpo |
| `texto_secundario` | `#5B6B7A` | rótulos, notas de cobertura |
| `linha` | `#D9E1E8` | bordas, grades |
| `fundo_suave` | `#F3F6F8` | zebra de tabela |

**Estados epistêmicos — trazer para o dash.** É o que distingue um artefato da Nami:

| estado | hex | quando aplicar a um indicador |
|---|---|---|
| `dado_verificado` | `#0F2B46` | cobertura alta, número confiável |
| `hipotese` | `#A8710A` | amostra pequena ou cobertura baixa |
| `alerta` | `#A32A1E` | degradação, queda de adesão |
| `decisao` | `#0F7A5A` | meta atingida |

Regra concreta: **indicador com cobertura de idade abaixo de 60% renderiza em `hipotese`
(âmbar), não em `dado_verificado`.** O dash passa a comunicar quanto confia em cada número
— a mesma disciplina aplicada no resto do projeto.

Marca: `assets/brand/nami_marca_circular_512.png` (ícone do PWA, também em 900),
`nami_wordmark_laranja.png` (cabeçalho), `nami_wordmark_branco.png` (splash).

---

## 12. Autenticação e privacidade

- Supabase Auth, **usuário admin único**. A API valida o JWT e confere que o `sub` bate com
  o id de admin configurado em variável de ambiente. Qualquer outro id recebe 403.
- A **service key do Supabase vive apenas no servidor**. O navegador nunca a recebe.
- Nenhum endpoint devolve `users.phone`. Identificação de usuário na UI usa `name` ou id
  parcial.
- Nas visões agregadas, `medications.nome` **nunca** é retornado junto a usuário
  identificável. Ele aparece apenas agregado por forma farmacêutica.
- Na Visão Feedback, retornar o texto e a faixa etária — não o nome.
- O dash não expõe nenhum endpoint de escrita.

---

## 13. Estrutura de arquivos

```
dashboard/
├── api/
│   ├── server.js            # Express, auth middleware, rotas
│   ├── definicoes.js        # §4 — TODAS as regras canônicas, ponto único
│   ├── db.js                # cliente Supabase com service key
│   └── rotas/
│       ├── tecnica.js       # §6
│       ├── perfil.js        # §7
│       ├── medicamentos.js  # §8
│       ├── adesao.js        # §9
│       └── feedback.js      # §10
├── src/                     # PWA (Vite + React)
│   ├── tokens.css
│   ├── componentes/
│   └── paineis/
├── public/manifest.json
└── package.json
```

`api/definicoes.js` importa `../../src/templates/dose.js` e `../../src/inventario.js`.

---

## 14. Checklist de verificação

Executar contra snapshot fresco do GitHub. Auto-relato do Claude Code não é aceito.

1. `SELECT count(*) FROM users WHERE data_nascimento IS NULL` → **0**
2. `SELECT count(*) FROM users WHERE is_teste` → **3**
3. `SELECT faixa_etaria('1966-04-01'::date)` → `60_69`; `faixa_etaria(NULL)` → `nao_informado`
4. `grep -rn "forma_farmaceutica" dashboard/` → nenhuma tabela de normalização própria; só
   importação de `src/templates/dose.js`
5. `grep -rn "AT TIME ZONE 'America/Sao_Paulo'" dashboard/api/` → presente em **todo**
   agrupamento por dia
6. `grep -rn "'pendente'\|'pausado'" dashboard/api/rotas/adesao.js` → ambos excluídos
7. `grep -n "revertido_de" dashboard/api/definicoes.js` → definição de retroativa usa o par,
   nunca `revertido` sozinho
8. `grep -rn "intencao_nao_suportada" dashboard/api/rotas/tecnica.js` → **ausente** (mora em
   `feedback.js`)
9. `grep -rn "is_teste" dashboard/api/rotas/` → presente em perfil, medicamentos, adesão e
   feedback; **ausente** em `tecnica.js` (exceção deliberada de §4.1)
10. `node --check` em todos os arquivos de `dashboard/api/`
11. `grep -n "CAPACIDADES\|NAO_SUPORTADO" src/router.js` → o prompt é montado a partir do
    módulo, não de string literal
12. Nenhuma rota do dash executa `INSERT`, `UPDATE` ou `DELETE`
13. `grep -rn "SUPABASE_SERVICE" dashboard/src/` → **nenhum resultado** (service key não
    vaza para o front)
14. `grep -rn "2026-08-30\|FRONTEIRA_CICLO" dashboard/api/definicoes.js` → constante única
15. `grep -rni "baseline\|meta\|referência" dashboard/src/paineis/` → nenhum uso que
    apresente o Ciclo 1 como parâmetro de comparação do Ciclo 2 (§9.2)

---

## 15. Correção obrigatória no CONTEXT.md

`CONTEXT.md` §8 registra, nas referências rápidas de Guilherme:

```
Busca por telefone: WHERE phone LIKE '%5519988491053%'
```

Esse número pertence ao usuário **Wellington**, que não é conta de teste. O telefone de
Guilherme é `+5511941065858`. Corrigir — do jeito que está, qualquer sessão futura que
seguir o CONTEXT investiga a pessoa errada.

---

## 16. Achados registrados nesta sessão (fora de escopo, sem autorização de registro)

Apresentados a Guilherme; **não** inserir em `backlog_items` sem "sim, registra".

1. **`agent_logs` não persiste `subtipoRelatorio`.** O classificador distingue 6 subtipos
   (`balanco_do_dia`, `meus_remedios`, `estoque`, `proximo_remedio`, `adesao`,
   `progresso_tratamento`), mas só o agente é gravado. "relatorios: 153" esconde qual
   relatório as pessoas usam — que é exatamente a pergunta de MH-059 e MH-062.
2. **10 registros presos em `pendente`** de 05 a 09/06/2026 com `tentativas = 0`, que nunca
   receberam o primeiro lembrete. Excluídos do dash pela regra de §4.5, portanto invisíveis.
3. **1 registro com `status = 'pendente'` e `taken_at` preenchido** — estado internamente
   inconsistente.
4. **Trava do último horário mora no chamador, não no ponto de escrita.**
   `configuracao.js:921` protege o invariante; `removerSchedule` (`database.js`) deleta sem
   verificar. Hoje há um único chamador, mas a proteção depende disso.
5. **Sem verificação de idade no onboarding.** Com `data_nascimento` preenchido, a Nami
   passa a ter, pela primeira vez, como detectar usuário menor de 18 anos — que sob LGPD
   exige consentimento de responsável. Não existe barreira hoje.
6. **26 pontos de chamada de `anthropic.messages.create`** em 10 arquivos, cada um
   instanciando seu próprio cliente, com `usage` descartado em todos. Relevante quando a
   visão financeira sair da geladeira; o custo do refactor cresce a cada novo ponto.

---

## 17. Novo princípio para o CONTEXT

**P55 — o inventário de capacidades é dado, não texto de prompt.** Vive em
`src/inventario.js` e é consumido tanto pelos prompts quanto pela interface de observação.
Capacidade adicionada ou removida atualiza o módulo na mesma mudança. Nasceu do MH-009: o
inventário existia em três lugares divergentes (`router.js`, `configuracao.js`,
`prompts.js`), e um dash que o copiasse criaria o quarto.