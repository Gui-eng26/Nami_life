# BRIEFING DE EXECUÇÃO — v44 · M0 (Arnês) + M1 (Porta única)

**Branch de trabalho:** `staging`. Fluxo padrão MH-89 Parte C: implementar em `staging` → validar no ambiente de staging → merge `staging` → `main` na sessão de encerramento.
**Fonte de verdade técnica:** `CONTEXT.md` de `main`. Este briefing complementa, não substitui.
**Governança:** nenhuma escrita em `backlog_items` a partir deste briefing — registros de backlog acontecem no encerramento da v44, com aprovação explícita do Guilherme.

---

## 0. Contexto da decisão (v44, 18–19/09)

Guilherme decidiu ajustar a arquitetura agentiva agora ("sem medo"): poucos usuários, staging isolado, e a base real de interações (2.833 turnos, 37 usuários) como rede de segurança. Norte do produto: **"você fala com a Nami como se tivesse falando com alguém da sua família."**

Arquitetura-alvo (registrar no CONTEXT.md no encerramento, não neste briefing):
- **Porta única**: o `principal` absorve o roteamento — 1 chamada de interpretação por turno (`{ intencao, campos, feedback, mensagem_citada? }`), que é **proposta, nunca decisão** (LLM propõe, código dispõe).
- **Especialistas finos** com contrato universal: finalizou / ruído / dúvida / mudou de fluxo → devolve à porta.
- **Runner de coleta** (M2+): uma implementação, campos como schema. Fora deste briefing.
- **Funil único**: tudo que entra e tudo que sai (scheduler incluso) passa pelo mesmo ponto de envio+log.
- **Inventário em três listas**: faz / ainda não faz / nunca fará — consultado como portão, não só como dica de roteamento.
- **Vocabulário canônico obrigatório**: `porta`, `schema`, `runner`, `validador`, `template`, `adaptador`, `funil`, `inventario`. Função nova com trabalho igual a uma existente é defeito de revisão.

Marcos: **M0** arnês · **M1** porta+funil (este briefing) · M2 runner+schema do cadastro · M3 configuração/relatórios · M4 onboarding (LGPD, por último). Este briefing entrega M0 e M1.

---

## 1. CONSTITUIÇÃO DA NAMI — v1 (APROVADA, 19/09)

Critério de aceite de TODO texto que chega ao usuário. Cada regra vira asserção do arnês (§3).

1. **Nunca tom de obrigação.** Todo pedido opcional carrega a porta de saída na própria mensagem ("Se não souber agora, tudo bem. Você pode me falar depois.").
2. **Fato, só depois de gravado — e só do banco.** Persistência e números (estoque, dias, horários) têm **autor único**: template determinístico lendo pós-escrita. A LLM redige em volta dos fatos, nunca os escreve. Confirmação de cadastro é **declarativa e completa**: *"Desvenlafaxina cadastrado, Manô, e vou te lembrar nos horários certos."* — nunca "Anotei" como confirmação de persistência ("Anotei" fica, no máximo, para captura intermediária de campo).
3. **Nada do que a pessoa disse é ignorado.** Toda mensagem recebe reconhecimento do seu conteúdo, mesmo quando não pode ser processado agora.
4. **Nunca pedir o que já foi dito.** Dado presente na conversa é confirmado, não reperguntado.
5. **Confirmação de dose vence qualquer fluxo pendente.** Registra a dose primeiro, retoma a coleta depois.
6. **Honestidade de capacidade em três níveis** (inventário §2): faz → executa; ainda não faz → diz que está chegando; nunca fará → fronteira de segurança, redireciona ao médico/farmacêutico, **sem "ainda"**. Nunca prometer o que não se executa neste turno. **Se não está no "faz", a Nami nunca confirma.**
7. **Padrão que o sistema não representa → recusa honesta, nunca gravação errada em silêncio.**
8. **No máximo uma pergunta por mensagem, sozinha na última linha.**
9. **Voz de alguém da família que cuida — nunca de sistema.** Sem vocabulário interno, sem mencionar mecanismo. Forma: `GUIA_COMPOSICAO` (curto não é cru; negrito com UM asterisco; emoji com função).
10. **Mensagem proativa também é conversa.** Segue as mesmas regras e entra no histórico como turno da Nami.

---

## 2. INVENTÁRIO EM TRÊS LISTAS (substitui a estrutura atual de `src/inventario.js`)

Manter o P55 (dado único, consumido por prompts). Nova estrutura: `CAPACIDADES` (com **limites explícitos** por entrada), `AINDA_NAO`, `NUNCA`. O limite é parte da capacidade — foi a ausência dele que deixou "recorrência semanal" no vazio entre as listas.

**FAZ (com limites):**
- Cadastro de medicamento: nome, dosagem, quantidade por dose, horários — **limite: mesmos horários todos os dias**; formas comprimido/cápsula/líquido(gotas/ml)/unidade; estoque opcional (contagem ou frascos); tratamento contínuo ou por X dias.
- Lembretes nos horários + follow-ups (até 3 tentativas), agrupados por horário.
- Confirmação de dose: normal, retroativa (2 dias), reversão por engano, registrar não-tomado.
- Estoque: registrar, atualizar (recompra/recontagem/perda), alertar quando acabando.
- Relatórios: balanço do dia, meus remédios, estoque, próximo remédio, adesão 7/15/30d, progresso.
- Configuração: pausar/reativar/encerrar tratamento; alterar/remover/adicionar horário.
- Exclusão de conta (LGPD).

**AINDA NÃO FAZ (resposta: honestidade + expectativa):**
áudio · foto · conectar cuidador · horários diferentes por dia da semana · dia sim/dia não · 1x por semana · múltiplos medicamentos numa mensagem (até M2) · alterar dosagem/nome/duração já cadastrados · registrar sintomas/pressão/glicemia · exportar histórico · parada automática no fim de uso agudo (campo existe; comportamento do scheduler a confirmar no M2).

**NUNCA FARÁ (fronteira de segurança, sem "ainda"; redireciona a médico/farmacêutico; emergência → SAMU 192):**
orientar sobre medicação · indicar/recomendar remédios · prescrever ou ajustar dose por decisão própria · interpretar sintomas ou exames · dizer se pode combinar remédio X com Y · atender emergência.

**Portão de composição (novo):** nenhuma mensagem pode **confirmar** algo que não mapeie para uma entrada do FAZ dentro do seu limite. Implementação mínima no M1: validador determinístico de recorrência (§5.7) + regra no contrato da porta + asserções do arnês.

---

## 3. M0 — ARNÊS DE REGRESSÃO

**O que é:** suíte executável (`npm run arnes`) que reproduz conversas reais contra o código, com asserções determinísticas sobre (a) o texto final ao usuário e (b) o estado do banco após o turno. **Fonte: `agent_logs` de produção (transcrições reais). NUNCA classificações do juizOffline** — decisão v44: confiabilidade baixa, só catches diretos (`erro_tecnico`) valem como evidência.

**Implementação (decisões de engenharia do Claude Code, contrato abaixo):**
- Harness chama `routeMessage` diretamente com banco de teste semeado (staging ou schema dedicado — decidir e documentar). Envio real de WhatsApp mockado no ponto do funil (§5.5), capturando o texto final.
- Cada caso: `{ id, marco_alvo, setup (seeds), turnos: [mensagem_usuario], asserções }`.
- Casos são **taggeados por marco** (M1, M2, M4). A entrega do M1 exige: todos os M1 verdes + nenhum caso já-verde regredido. Casos M2/M4 podem falhar (expected-fail, reportados como "conhecido").
- Saída: pass/fail por caso e por asserção, legível em CI e no terminal.

**Casos-ouro (mínimo obrigatório; dados reais em `agent_logs` de produção nas datas indicadas):**

| # | Caso real | Marco | Asserções principais |
|---|---|---|---|
| A1 | Sid 18/09 — mensagem rica única ("Minoxidil 3mg, 1 comprimido às 21h") | M1 | cadastro em ≤2 turnos; nenhum campo fornecido reperguntado; confirmação declarativa (regra 2) |
| A2 | Thaielly 18/09 16:19 — 4 medicamentos + "8h" em `post_onboarding` | M1 (parcial) / M2 (pleno) | M1: nada ignorado (regra 3); nenhuma promessa fora do executável (regra 6); dados da mensagem chegam ao cadastro (nome do 1º med + 8h não reperguntados). M2: os 4 registrados |
| A3 | Manô 18/09 15:26 — "seg a sexta às 6h, sáb e dom às 10h" | M1 | NUNCA grava 2 horários diários; resposta honesta de limite (regras 6/7); grava só com consentimento do subconjunto |
| A4 | Manô 19/09 09:58 — "sim" com dose pendente durante `adding_med` | M1 | dose confirmada no banco; coleta retomada depois; regra 5 |
| A5 | Eloísa/Wellington/Flávia 18/09 — confirmação de dose com estoque baixo | M1 | exatamente UM bloco de estoque na mensagem; número == leitura pós-débito do banco; segmento redigido pela LLM sem números de estado (regra 2) |
| A6 | Carla 18/09 — "Depois faço isso" na pergunta de estoque | M1 | resposta afirma que o medicamento ESTÁ cadastrado e lembretes ativos (verdade do banco) |
| A7 | LGPD (staging, João 18/09 06:36) — forma da mensagem de consentimento | M1 | formato lista com emoji semântico por item, independente do nome do usuário; 1 pergunta, sozinha na última linha; negrito com um asterisco |
| A8 | Áudio recebido | M1 | recusa vem da lista AINDA_NAO, registrada em `agent_logs` (hoje é invisível — `agent.js:12` responde fora do pipeline) |
| A9 | João Pedro 18/09 15:52 — "Na verdade 9 no estoque" pós-pergunta de estoque | M2 | correção aceita no mesmo turno (expected-fail no M1; BUG-103) |
| A10 | Felipe 18/09 12:02 — data de nascimento junto do nome | M4 | dado não reperguntado (expected-fail até M4) |

**Catálogo de asserções determinísticas (reutilizáveis):** campo já fornecido não reperguntado · contagem de `?` no texto final ≤1 e, existindo, na última linha · nenhum `**` (negrito markdown) · no máximo um bloco `Lembrete de estoque` e número igual ao banco pós-escrita · estado da conversa esperado após o turno · linhas esperadas em `medications`/`schedules`/`dose_logs` · confirmação de persistência só após INSERT/UPDATE bem-sucedido · resposta de capacidade mapeia para a lista correta do inventário.

---

## 4. AÇÃO PRÉVIA — T0: teste de compatibilidade de id da citação (depende do Guilherme)

Antes do §5.6: descobrir empiricamente qual id devolvido no envio (`zaapId` vs `messageId`, `whatsapp.js:53`) bate com o `referenceMessageId` do webhook quando o usuário cita. Procedimento: Guilherme manda mensagem ao número de staging, recebe resposta, **cita a resposta** e envia "teste citação". O `index.js:34` já loga o payload completo — comparar com o retorno do envio logado. Registrar a conclusão no topo do commit do §5.6. Se nenhum id bater, gravar AMBOS no funil e comparar contra os dois (e reportar o achado).

---

## 5. M1 — ESCOPO DE IMPLEMENTAÇÃO

**Fora do escopo do M1 (não tocar):** runner/schemas (M2) · suporte real a recorrência e multi-medicamento (M2) · reescrita do onboarding — estados `recepcionista`/`coletando_nascimento` e ramos 1–3.5 do `routeMessage` ficam como estão até o M4, exceto o item 5.8 (copy) · recalibração do juizOffline · `filaTurnos` (janela 5000ms mantida por decisão do Guilherme) · fast-paths determinísticos de dose (ficam, ver 5.4).

### 5.1 Porta única de interpretação
- O `classificarIntencaoComContexto` (`router.js:347`) deixa de ser "ramo 15" e vira **a porta**: para usuário onboarded, os ramos 4–15 do `routeMessage` são substituídos por: fast-paths determinísticos (5.4) → porta → despacho.
- A chamada usa **tool-use com schema** (nunca JSON em texto livre — lição do `parse_json_falhou`, Felipe 18/09 13:21): `{ intencao, campos, feedback, mensagem_citada_relevante? }`. Um retry em falha de schema; segunda falha → `degradar()` para repergunta segura. A saída é **proposta**: campos passam pelos validadores existentes; transição é computada pelo código.
- `pareceLinhaDePosologia` e a lista de substrings de `detectarIntencaoCadastro` (`router.js:249-273`) **deixam de decidir roteamento** (podem sobreviver apenas como heurística de log). `estadoPosOnboarding.js` morre — a porta já interpreta a intenção.
- `mensagem_rica` (`router.js:826`): guardar **sempre** a mensagem anterior do turno `post_onboarding`, sem condição de regex (rede de segurança P57).

### 5.2 Ponto único de entrada no cadastro
- Função única `entrarNoCadastro({ user, message, state, camposExtraidos })` substitui os 10 pontos atuais (`router.js:620/790/805/880/970/1062/1074/1084/1139` + `estadoPosOnboarding.js:64`). Ela SEMPRE mescla rascunho existente + campos extraídos pela porta + mensagem original. Proibido `context: { etapa: 'cad_nome' }` literal fora dela.

### 5.3 Contrato universal de devolução
- `principal` ganha `escalarParaRoteador` (hoje: 0 ocorrências — é o único agente conversacional sem saída; a promessa falsa da Thaielly é consequência). Padrão do `despacharCadastro`/`configuracao`.
- Regra de prompt do `principal`: **nunca prometer ação de outro agente** — sinaliza e devolve (mata o MH-090 pela raiz estrutural + proibição).

### 5.4 Precedência: dose vence coleta
- Antes de qualquer estado de coleta (`adding_med`, `configurando`, etc.): se `detectarConfirmacaoDose(message) && temDosePendente(user.id)` → confirma a dose (código determinístico existente) e **depois** retoma a coleta pendente na mesma mensagem ("✅ Dose confirmada! E quando quiser me falar do estoque, tô aqui."). Corrige a classe do caso Manô 19/09 (ramo 9 engolindo o ramo 12).

### 5.5 Funil único de saída
- Um ponto de envio (`enviarAoUsuario`) por onde passa TODA mensagem — reativa e proativa (scheduler incluso). Grava: user_id, texto final, origem (agente/proativo+tipo), ids do provedor (zaapId E messageId até o T0 decidir), timestamp, vínculo (agent_log_id ou grupo de doses).
- Corrige o gap MH-032: lembrete agrupado grava o id vinculado ao grupo; as N doses apontam para o registro (hoje `scheduler.js:206/306` descarta o id).
- O atalho do áudio (`agent.js:12`) entra no pipeline: recusa gerada da lista AINDA_NAO e registrada em `agent_logs`.
- Mensagens proativas entram no histórico que a porta lê (regra 10) — `eventos_proativos` continua sendo alimentada até o M2 absorver.

### 5.6 Citação (responder do WhatsApp) — supera BUG-029
- `agent_logs.reference_message_id` (nova coluna) — observabilidade de uso.
- Resolução: `referenceMessageId` → lookup no funil (5.5) → injeta `mensagem_citada: { texto, quando, origem }` no contexto da porta.
- Determinístico preservado e consertado: citação de lembrete + confirmação → confirma exatamente aquele grupo de doses (generaliza `router.js:659`).
- Regras: citado vence estado atual **na interpretação**, nunca escreve estado direto; citação da própria mensagem do usuário = âncora de continuação/correção.

### 5.7 Autoria única de fatos (mata o alerta de estoque contraditório)
- `prompts.js:286`: a REGRA ABSOLUTA passa de lista de ações para **propriedade do dado**: a LLM NUNCA escreve número de estoque/dias/doses em NENHUMA ação — `CONFIRM_DOSE` incluída.
- Remover o template paralelo de estoque de dentro do `principal` (`principal.js:43`) — autor único é `estoqueTemplates.js`, montado do banco pós-débito (`principal.js:378` já faz o append correto).
- Avaliar remover/neutralizar o valor de estoque pré-débito exposto à LLM (`principal.js:227`) quando há dose pendente.
- Validador determinístico de recorrência no cadastro: padrão de dia-da-semana/frequência detectado ("segunda", "sáb", "fim de semana", "dia sim", "1x por semana"...) → bloqueia gravação, resposta honesta de limite (inventário), oferece o subconjunto representável. Evidência A3.

### 5.8 Copy da recepção (única exceção de onboarding no M1)
- `recepcionista.js:402-478`: exemplos literais por etapa viram **especificação de conteúdo** (o que dizer, nunca texto pronto). Fonte única de forma: `GUIA_COMPOSICAO`.
- `composicao.js`: trocar "Guilherme" do exemplo por nome neutro/placeholder — o exemplo ensina forma, não conteúdo (evidência: forma em lista só aparecia quando o usuário se chamava Guilherme).
- Propagar o guia aos agentes que ficaram fora na v43 (`cadastro.js` e `principal.js` já importam — revisar aderência; regra do asterisco único incluída).

### 5.9 Inventário três listas
- Reestruturar `src/inventario.js` conforme §2, mantendo os consumidores (porta, `configuracao`, dashboard Corrente 3). A porta consulta as três listas em todo turno; resposta de capacidade sai da lista correta com a postura correta.

**Sequência de commits sugerida (arnês roda após cada um):**
1. M0 completo (baseline: M1-cases vermelhos documentados)
2. §5.5 funil de saída (+ resultado do T0)
3. §5.7 autoria única de fatos → A5/A6 verdes
4. §5.1–5.4 porta + entrada única + contrato + precedência → A1–A4 verdes
5. §5.9 inventário + §5.8 copy → A7/A8 verdes
6. §5.6 citação

---

## 6. CRITÉRIOS DE ACEITE DO M1 (staging)

1. Arnês: todos os casos M1 verdes; A9/A10 em expected-fail documentado; nenhum caso verde regredido.
2. Replay manual no WhatsApp de staging: fluxos A1, A3, A4 e A5 reproduzidos por humano.
3. Métricas-alvo (medir nos primeiros usuários reais pós-merge): mediana de turnos até 1º medicamento ≤3 · zero repergunta de dado já fornecido · zero promessa sem executor · mensagem com N medicamentos → nunca silêncio.
4. Nenhuma mensagem ao usuário fora do funil (verificável por grep de `sendTextMessage` fora de `enviarAoUsuario`).

## 7. Registros para o encerramento da v44 (NÃO executar agora; dependem de "sim, registra")
- Arquitetura-alvo + constituição + inventário três listas no CONTEXT.md.
- BUG-029 superado por item novo (citação como contexto de primeira classe; evidência Wellington + Manô 18/09).
- Remapeamento: Fase 5→M2 · Fase 6→M1 · Fase 7→M2+M4 · MH-090 morto no M1 · BUG-103 → caso A9/M2 · MH-77 (recorrência) → M2 com requisito do schema.
- Correção manual aplicada em produção 19/09 (Manô): dose 10h confirmada retroativamente, schedule 10:00 desativado, estado destravado — registrado em `response_raw`.