# BRIEFING DE ENCERRAMENTO — Sessão v27 (31/07/2026)

**Executar com:** *"Leia o briefings/encerramento_v27.md e execute."*

**O que este briefing faz:**
1. Atualiza o cabeçalho do `CONTEXT.md` (v26 → v27)
2. Insere a seção `## Sessão v27` (texto literal completo abaixo)
3. Corrige 3 pontos desatualizados no `CONTEXT.md`
4. Atualiza a "Estrutura de Arquivos"
5. Lista as escritas em `backlog_items`
6. Uma escrita de triagem em `system_events` (exceção explicitamente sinalizada)
7. `git commit` + `push`

**Não faz:** nenhuma alteração em `src/`. O código do MH-065 já foi commitado e está em produção.

---

## 1. Cabeçalho do `CONTEXT.md`

Substituir as linhas 1-4 por:

```markdown
# 🌿 NAMI — Contexto do Projeto (v27 — FECHADA: MH-065 — contexto proativo para o
classificador central: reconstrução a partir de dose_logs (nunca escrita em agent_logs),
regra de inclusão estado + sequência + rede de segurança, renderização cronológica não
predominante; validação em produção pendente — 31/07/2026)
```

---

## 2. Seção nova — inserir ANTES de `## Backlog (BUG/FIX/MH)`

Texto literal completo:

```markdown
## Sessão v27 (31/07/2026) — MH-065: contexto proativo para o classificador central

Sessão de uma frente só. O gatilho foi o diagnóstico da v26: o vazamento do BUG-069 era o
**último** elo de uma cadeia de seis, e a causa está a montante — o classificador central não
enxerga nada que a Nami envie por iniciativa própria.

### A medição que definiu o problema

`logAgentInteraction` tem 3 call sites, **todos no caminho reativo** (`router.js:569`,
`router.js:1040`, `agent.js:31`). Os 8 pontos de `sendTextMessage` fora desse caminho —
lembrete individual e agrupado, follow-up individual e agrupado, aviso de estoque zerado,
alerta pós-`nao_informado`, cuidador, resumo semanal — não escrevem em `agent_logs`.

Turnos de usuário que chegaram até 15 min depois de um `reminder_sent_at`, em todo o histórico
(05/06 → 30/07):

| Métrica | Valor |
|---|---|
| Turnos na janela | 294 |
| Turnos em que o lembrete era o turno real anterior (invisível ao classificador) | **169** |
| Destes, com histórico visível de outro assunto na última hora | **30** |
| Destes, mensagens curtas (≤4 caracteres) | 127 |

**Reenquadramento do BUG-069:** o "1 ocorrência em todo o histórico" registrado na v26 mediu o
*sintoma na ponta da cadeia* (o objeto vazando no envio). A *condição a montante* ocorre 169
vezes.

### Por que o dano é raro apesar da frequência

Dos 169 turnos, **158 foram para `principal`** — o destino correto. Duas camadas mascaram a
lacuna: o fast-path `detectarConfirmacaoDose` intercepta a maioria das confirmações curtas
antes do classificador, e `principal` é o fallback natural.

Dos 11 que não foram para `principal`, **10 eram roteamento correto** — mensagens
auto-suficientes (`"Qual meu estoque de dipirona?"`, `"Parar losartana"`, `"Quero cadastrar
dipirona"`). Princípio 17 em ação: o texto literal resolveu sozinho, o lembrete invisível não
fez falta.

Isso permitiu a formulação precisa da causa raiz:

> O histórico incompleto só causa dano quando a mensagem do usuário **não é auto-suficiente** —
> resposta curta ou anafórica cujo significado depende inteiramente do que a Nami acabou de
> dizer. Mensagens auto-suficientes atravessam a lacuna sem consequência.

### A decisão de arquitetura — e a opção descartada

**Descartada:** inserir os turnos proativos em `agent_logs`.

O motivo é **semântico, não de risco**. `agent_logs` registra a resposta PRETENDIDA
(princípio 24: `logAgentInteraction` roda antes de `sendTextMessage`). Já `dose_logs` é escrito
**depois** do envio em todos os pontos verificados (`scheduler.js:203/259/309/333`,
`lembrete.js:103`) — é **registro de entrega**. Inserir um fato de entrega numa tabela de
intenção teria forçado uma escolha entre duas semânticas erradas.

**Sinal de diagnóstico registrado:** a opção descartada exigia 5 adaptações — dois formatadores,
decisão sobre `contexto_conversa`, limite do histórico, valor do campo `agent`, ordem
log/envio. **A quantidade de adaptação necessária era o diagnóstico**: um dado que só entra numa
tabela mediante nulos e três decisões de semântica não pertence àquela tabela.

**Escolhida:** reconstruir o evento proativo a partir de `dose_logs` na leitura, como campo
paralelo ao `historicoConversa` (forma do princípio 22 — dimensão ortogonal não vira novo valor
do eixo existente). Nenhum consumidor de `agent_logs` muda.

### Regra de inclusão — estado, sequência e rede de segurança

```
(1) ESTADO — dose ainda aguardando resposta:
    reminder_sent = true, confirmed = false,
    status ∉ {pausado, nao_tomado, nao_informado, sem_estoque}

(2) SEQUÊNCIA — o evento é mais recente que o último turno registrado:
    instanteEvento > created_at do turno mais recente em historicoConversa

(3) REDE DE SEGURANÇA — scheduled_at dentro do dia de hoje (BRT)
```

**(1) é de estado, não de relógio** — e isso eliminou a única constante de tempo arbitrária do
desenho. A cadência de follow-up é 30min + 1h + 30min, e então `markAsNaoInformado`: o próprio
ciclo de vida da dose fecha a janela em ~2h. A condição é idêntica à de `temDosePendente`
(`router.js:48-54`), mantendo as duas leituras consistentes.

**(2) sozinha não basta.** Cenário: último `agent_log` na segunda, lembrete na terça sem
resposta, usuário escreve na sexta. O lembrete de terça É mais recente que segunda e passaria em
(2), sendo injetado como "turno imediatamente anterior".

**(3) existe porque (1) tem uma premissa.** Se o scheduler cair, uma dose fica `pendente`
indefinidamente e o estado não a fecha. Rede, não regra principal.

### O bloco não é predominante — decisão explícita

O modo de falha simétrico ao que estamos corrigindo: hoje o classificador é cego para o
proativo; um bloco predominante o cegaria para o reativo. Três decisões garantem o equilíbrio:

1. **Integração cronológica, não seção destacada.** O evento entra no fim da mesma linha do
   tempo do bloco `CONVERSA RECENTE` — por (2) ele é mais recente que os 3 turnos.
2. **Zero linguagem instrucional.** Nenhuma frase de precedência. A cronologia carrega a
   informação sozinha. O rótulo entre colchetes é descritivo, existe só para o LLM não ler a
   linha como turno de usuário (sem ele, a alternativa seria `Usuário: null`).
3. **Renderização condicional.** Sem evento proativo, o prompt fica **byte a byte idêntico** ao
   anterior — o que limita o raio de qualquer regressão aos casos-alvo.

**Divisão de trabalho preservada:** o classificador responde apenas *qual agente*. Quem decide
confirmação de dose é o `principal`, que já tem o bloco `DOSES AGUARDANDO CONFIRMAÇÃO` com
`[ref:]` e instrução de precedência. Duplicar essa regra no classificador criaria dois donos da
mesma decisão.

### Escopo de propagação — só o classificador

`principal.js:72` já chama `getRecentDoses(user.id, 3)` e monta o bloco de doses pendentes com
`doseLogId`. Ele **já tem** esse contexto, em formato mais forte que qualquer reconstrução. A
cegueira é exclusiva do roteador. `cadastro`, `configuracao` e `exclusaoConta` não precisam.

`despacharEscalada` recebe **obrigatoriamente** — é o passo 5 da cadeia do `"S"`; sem isso a
reclassificação repete a decisão cega e a cadeia continua inteira.

### Redundância intencional com o Juiz Offline — documentada, não unificada

`juizOffline.js:205-232` já faz uma reconstrução de lembrete a partir de `dose_logs`. A extração
de função compartilhada foi **deliberadamente adiada**: os contratos ainda diferem — o juiz
ancora num instante passado para julgar retrospectivamente, em batch; o classificador ancora no
agora para rotear, por mensagem. O princípio 30 trata de *mesmo contrato replicado*, e ainda não
é o caso.

**Gatilho de revisão (MH-067):** na próxima reavaliação do Juiz Offline, comparar as duas
implementações; se o contrato tiver convergido, unificar.

Efeito colateral positivo: a função nova segue a **regra padrão do projeto** (duas etapas com
`.in()`), sem herdar o `!inner` que hoje existe só no juiz.

### Lição de forma herdada do diagnóstico do juiz (H3)

O diagnóstico do falso positivo da v26 revelou que a `notaLembrete` do juiz — *"lembrete
automático de Elani"* — é **gramaticalmente ambígua** quando o nome do medicamento soa como nome
próprio: lê tanto como "lembrete do medicamento Elani" quanto como "lembrete [pertencente a]
Elani [pessoa]". O juiz resolveu para o lado errado e produziu um `informacao_saude_incorreta`
de severidade **crítica** — falso positivo.

**Nenhuma correção foi aplicada no juiz nesta sessão** (decisão de escopo). Mas o texto novo
nasceu sem o defeito: campos rotulados, sem genitivo solto.

```
[mensagem automática da Nami — sem resposta do usuário até aqui]
Nami: lembrete de dose — medicamento: Ômega 3 (dose das 20:00) — enviado 3 min atrás
```

Origem do princípio 32.

### Fora de cobertura, declarado

| Envio proativo | Registro | Coberto? |
|---|---|---|
| `lembrete.js:133` — alerta de estoque pós-`nao_informado` | nenhum | ❌ |
| `relatorios.js:665` — resumo semanal | só `adesao_estado.updated_at` | ❌ |
| `lembrete.js:76` — cuidador | `caregiver_notified` | ❌ (outro telefone, não é contexto do paciente) |

Exposição medida do resumo semanal: **1 turno de usuário** em todo o histórico dentro de 1h30
depois de um domingo 16:00 (28/06, `"Tomei"`, roteado corretamente). Lacuna conhecida, não
oculta.

### Decisão explícita: uma camada por vez

O sinal determinístico — passar `temDosePendente` ao classificador — ficou **fora** desta
rodada. Hoje esse fato só é consultado atrás de `detectarConfirmacaoDose(message) &&`
(`router.js:654/749/910/919`), ou seja, nunca é olhado quando o parser não reconhece a mensagem.
É provavelmente um sinal mais forte que a reconstrução do histórico.

Motivo do adiamento: empilhar as duas camadas de uma vez torna impossível saber qual funcionou.
O projeto já tem histórico de correção sistêmica boa sendo mascarada por camada extra. Medir
primeiro.

### Validação da v26 — fechada

O Juiz Offline rodou em 31/07 03:00 BRT sobre os dados de 30/07:
`turnos_totais 16 · episodios_totais 7 · episodios_avaliados 7 · pulados_idempotencia 0 ·
falha_julgamento 0 · status sucesso`.

Critério da v26 atendido: `avaliados + pulados = totais`. Cobertura **100%**, contra 3,1% na
execução anterior. As correções do juiz (try/catch por episódio, retry, `status` derivado de
`episodios_falha_julgamento`) e o MH-058 estão validados.

### Pendências de validação da v27

O MH-065 permanece `em_validacao`. Os testes exigem tráfego real e correm ao longo de 31/07:
cenário-alvo (reprodução do `"S"` com histórico enviesado), lembrete agrupado (20:00 —
Dipirona + Vitamina C), follow-up, os 10 casos nominais de não-regressão, e as condições de
exclusão — com destaque para a regra de sequência, cuja falha faria o bloco aparecer em todas as
mensagens seguintes do dia.

**Limite de observabilidade do teste:** o prompt do classificador não é logado em lugar nenhum.
Testar só por WhatsApp mostra o desfecho do roteamento, mas não distingue "bloco renderizado
certo" de "renderizado errado e o LLM acertou assim mesmo". `getContextoProativoRecente` é
exportada e pode ser inspecionada por script read-only; a renderização é função pura do objeto.
```

---

## 3. Correções pontuais no `CONTEXT.md`

**3.1 — Linha ~1116 (seção da Sessão v24).** O texto ainda afirma que o resumo semanal usa
`cron.schedule('0 16 * * 0', ...)` **sem `timezone`**. Isso agora contradiz a linha 84, já
corrigida. Não reescrever o registro de época — **acrescentar** logo abaixo do parágrafo:

```markdown
> **Corrigido na v27:** a afirmação acima está superada. O código tem `{ timezone:
> 'America/Sao_Paulo' }` (`scheduler.js:45`) e o dado de produção confirma o disparo correto:
> `adesao_estado.updated_at` das 6 linhas em 26/07 19:00 UTC = **16:00 BRT**. Se o processo
> rodasse em UTC sem timezone, teria disparado 13:00 BRT. Pendência fechada por evidência.
```

**3.2 — Seção "Pendências de validação" da Sessão v26.** Acrescentar ao final:

```markdown
> **Fechada na v27:** execução de 31/07 03:00 BRT sobre os dados de 30/07 — 7 de 7 episódios
> avaliados, 0 falhas, `status: sucesso`. Critério `avaliados + pulados = totais` atendido.
> Cobertura 100% (era 3,1%).
```

**3.3 — Princípio novo, ao final da lista de Princípios de Engenharia:**

```markdown
32. **Transporte de fato estruturado entre camadas não depende de desambiguação de linguagem
    natural (v27, H3 do juiz).** Quando um dado estruturado (nome de medicamento, horário,
    status) é transportado para dentro do prompt de outra camada, ele vai em **campos
    rotulados**, nunca embutido em prosa com genitivo ou aposto. Caso concreto: a nota
    `"lembrete automático de Elani"` do Juiz Offline é ambígua quando o nome do medicamento soa
    como nome próprio — o juiz leu "Elani" como o nome da usuária, concluiu que a Nami errara o
    nome dela e emitiu `informacao_saude_incorreta` de severidade crítica. Extensão dos
    princípios 25 e 26: lá, identidade de agrupamento não pode depender de geração livre de LLM;
    aqui, o significado de um campo não pode depender de leitura correta de uma construção
    gramatical ambígua. **Corolário:** se dois nomes próprios podem aparecer no mesmo bloco
    (usuário e medicamento), ambos precisam de rótulo — desambiguar um só deixa o outro exposto.
```

---

## 4. Estrutura de Arquivos — atualizar 3 entradas

**`src/database.js`** — acrescentar ao final da descrição:

```
getContextoProativoRecente() (v27, MH-065) — reconstrói o ÚLTIMO evento proativo (lembrete
ou follow-up) a partir de dose_logs, que é registro de ENTREGA (escrito depois de
sendTextMessage), ao contrário de agent_logs que é registro de INTENÇÃO (princípio 24).
Duas etapas com .in(), regra padrão do projeto. Consumida SÓ pelo classificador central.
```

**`src/router.js`** — acrescentar ao final da descrição:

```
v27 (MH-065): classificarIntencaoComContexto recebe contextoProativo como campo paralelo
(princípio 22) em 4 call sites; despacharEscalada propaga em 5 call sites, sem query nova
(princípio 6). renderizarContextoProativo() insere o evento no FIM da cronologia do bloco
CONVERSA RECENTE — sem seção destacada e sem instrução de precedência, para não cegar o
classificador do lado reativo. Sem evento proativo, o prompt é idêntico ao anterior.
```

**`src/observabilidade.js`** — acrescentar:

```
v27: entrada 'contexto_proativo:query_falhou' no catálogo DEGRADACOES (severidade media —
a degradação devolve ao comportamento anterior, que é a ausência que o MH-065 corrige).
```

---

## 5. Escritas em `backlog_items`

Via `atualizarStatusBacklogItem` / `registrarItemBacklog` (`src/backlog.js`) — **nunca SQL
direto** (princípio 16).

| Item | Ação | Motivo |
|---|---|---|
| **MH-058** | `em_validacao` → `resolvido` | Critério da v26 atendido na execução de 31/07: 7+0=7, `status sucesso`, cobertura 100% |
| **MH-064** | **permanece `em_validacao`** | Ver nota abaixo |
| **MH-065** | permanece `em_validacao` | Testes de produção correm ao longo de 31/07 |

**Nota sobre o MH-064 — não fechar.** A execução bem-sucedida do juiz valida as *correções do
juiz*, não o `degradar()`. Nenhuma degradação ocorreu desde o deploy, então nenhum dos 5 pontos
instrumentados disparou. **Ausência de evento não é prova de que o mecanismo funciona** — é
exatamente o raciocínio que originou o princípio 29. Critério explícito para fechar: o primeiro
evento real com `payload.origem`/`payload.motivo` preenchidos, **ou** verificação dirigida em
ambiente isolado. Registrar esse critério no item.

Nenhum item novo a registrar: MH-066, MH-067, MH-068 e MH-069 já foram criados durante a
execução do MH-065.

---

## 6. Triagem em `system_events` — exceção explicitamente sinalizada

⚠️ **SQL direto, permitido como manutenção pontual revisada** (princípio 16, cláusula de
exceção). Uma linha, alvo único por `id`.

O evento `943f039e-f34c-4a6c-82e2-f2cbde9a30bb` (`Informação de saúde incorreta ao usuário`,
severidade `critica`, 30/07 03:00 BRT) está `novo`. O diagnóstico H1/H2/H3 provou que é **falso
positivo** — a resposta da Nami estava correta, confirmada em `dose_logs`
`159f49a9-cbd6-4f40-9146-fdaf4e5be711`. É precisamente o caso de uso que justificou criar o
valor `nao_valida` na v26.

```sql
UPDATE system_events
SET status_triagem = 'nao_valida', revisado_at = now()
WHERE id = '943f039e-f34c-4a6c-82e2-f2cbde9a30bb';
```

---

## 7. Git

```bash
git add CONTEXT.md briefings/
git commit -m "docs: encerramento v27 — MH-065 contexto proativo para o classificador central

- Seção Sessão v27 no CONTEXT.md com a medição (169 turnos), a decisão de
  arquitetura (dose_logs como registro de entrega vs agent_logs como registro
  de intenção) e a regra de inclusão estado + sequência + rede de segurança
- Princípio 32: transporte de fato estruturado em campos rotulados
- Correção da nota de timezone do scheduler na seção v24 (pendência fechada
  por evidência)
- Pendência de validação da v26 fechada: juiz 7/7, status sucesso, cobertura 100%
- Estrutura de Arquivos atualizada: database.js, router.js, observabilidade.js"
git push
```

---

## 8. Verificação pós-execução

```bash
# cabeçalho atualizado
head -4 CONTEXT.md | grep -c "v27"        # → 1

# seção da sessão existe (falha das v23/v24 não pode se repetir)
grep -c "^## Sessão v27" CONTEXT.md       # → 1

# princípio 32 existe
grep -c "^32\. \*\*Transporte de fato estruturado" CONTEXT.md   # → 1

# nenhum arquivo de código foi tocado neste encerramento
git diff --name-only HEAD~1 | grep "^src/" || echo "OK: nenhum src/ alterado"
```