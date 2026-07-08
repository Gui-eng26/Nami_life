# BRIEFING — Migração do Backlog (BUG/FIX/MH) para o Supabase

**Contexto:** o backlog (BUG-xxx, FIX-xxx, MH-xxx) vinha sendo mantido em texto livre no `CONTEXT.md`, o que causou: (a) seis colisões de numeração já identificadas em auditoria (BUG-031/032/033/034/035/036 com dois significados cada), (b) sete itens de melhoria "órfãos" nunca fechados nem repriorizados, e (c) custo crescente de tokens para reescrever o CONTEXT.md a cada encerramento de sessão.

**Decisão de arquitetura:** o backlog passa a viver em uma tabela `backlog_items` no Supabase (projeto `Nami_Life Brazil`, `project_id = nputymewnwmnhrtpizzs`). O CONTEXT.md perde a seção de backlog quase por completo.

**Divisão de responsabilidade (fixada em 07/07/2026):**
- **Chat de planejamento** (este): consulta o banco diretamente (leitura apenas, via Supabase MCP) como parte do rito de abertura de sessão. Nunca escreve no banco.
- **Claude Code**: responsável por TODAS as escritas (inserts/updates em `backlog_items`) e pelas implementações no VS Code, exatamente como já faz hoje.

---

## 1. Schema SQL (DDL) — aplicar via `apply_migration`

```sql
CREATE TABLE public.backlog_items (
  id                serial PRIMARY KEY,
  tipo              text NOT NULL CHECK (tipo IN ('BUG', 'FIX', 'MH')),
  numero            integer NOT NULL,
  titulo            text NOT NULL,
  descricao         text,
  causa_raiz        text,
  status            text NOT NULL CHECK (status IN (
                      'aberto', 'em_validacao', 'resolvido',
                      'superseded', 'deferred', 'backlog_orfao',
                      'limitacao_aceitavel', 'historico_substituido'
                    )),
  prioridade        text CHECK (prioridade IN ('alta', 'media', 'baixa')),
  sessao_criacao    text,          -- ex: 'v7'
  data_criacao      date,
  sessao_fechamento text,
  data_fechamento   date,
  notas             text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- Constraint de unicidade que elimina a classe inteira do problema de colisão:
-- só pode haver UM item "vivo" por (tipo, numero). Itens históricos já
-- colididos e resolvidos ficam com status = 'historico_substituido' e
-- ficam de fora dessa checagem — preservando o registro sem permitir
-- que aconteça de novo.
CREATE UNIQUE INDEX backlog_items_tipo_numero_ativo
  ON public.backlog_items (tipo, numero)
  WHERE status <> 'historico_substituido';

CREATE INDEX backlog_items_status_idx ON public.backlog_items (status);

COMMENT ON TABLE public.backlog_items IS
  'Backlog único de BUG/FIX/MH da Nami. Fonte de verdade — substitui a seção de backlog do CONTEXT.md a partir de 07/07/2026.';
```

**Por que isso resolve o problema de origem:** o índice único parcial (`WHERE status <> 'historico_substituido'`) torna fisicamente impossível reaproveitar um número ativo — se alguém tentar inserir "BUG-031" de novo enquanto já existe um BUG-031 com status diferente de `historico_substituido`, o insert falha ruidosamente, em vez de silenciosamente sobrescrever o significado (que foi exatamente o que aconteceu seis vezes até agora).

---

## 2. Carga inicial (backfill) — aplicar via `apply_migration`, depois da DDL acima

Todos os itens já auditados (relatórios v1–v15 do Drive + briefings do GitHub + CONTEXT.md v15). Os seis pares de colisão entram como dois registros: o histórico com `status = 'historico_substituido'`, o atual com o status real.

```sql
INSERT INTO public.backlog_items (tipo, numero, titulo, descricao, status, sessao_criacao, data_criacao, sessao_fechamento, notas) VALUES
-- BUGs 001-018
('BUG', 1, 'Áudio derrubava estado da conversa', NULL, 'resolvido', 'v1', '2026-05-04', 'v1', NULL),
('BUG', 2, 'Horário salvo como objeto JSON no PostgreSQL', NULL, 'resolvido', 'v1', '2026-05-04', 'v1', NULL),
('BUG', 3, 'Medicamento duplicado a cada tentativa falha', NULL, 'resolvido', 'v1', '2026-05-04', 'v1', NULL),
('BUG', 4, 'claudeResponse fora de escopo em processAction', NULL, 'resolvido', 'v1', '2026-05-04', 'v1', NULL),
('BUG', 5, 'getUserMedications sem join em schedules', NULL, 'resolvido', 'v1', '2026-05-04', 'v1', NULL),
('BUG', 6, 'SUPABASE_URL com caractere faltando', NULL, 'resolvido', 'v1', '2026-05-05', 'v1', NULL),
('BUG', 7, 'ZAPI_CLIENT_TOKEN não configurado', NULL, 'resolvido', 'v1', '2026-05-05', 'v1', NULL),
('BUG', 8, 'Loop de apresentação no onboarding', NULL, 'resolvido', 'v2', '2026-05-08', 'v2', NULL),
('BUG', 9, 'Scheduler falhava silenciosamente', NULL, 'resolvido', 'v2', '2026-05-08', 'v2', NULL),
('BUG', 10, 'State não persistia entre sessões', NULL, 'resolvido', 'v2', '2026-05-08', 'v2', NULL),
('BUG', 11, 'SUPABASE_URL com sufixo /rest/v1/', NULL, 'resolvido', 'v3', '2026-06-04', 'v3', NULL),
('BUG', 12, 'ZAPI_CLIENT_TOKEN com valor da SUPABASE_URL', NULL, 'resolvido', 'v3', '2026-06-04', 'v3', NULL),
('BUG', 13, 'Confirmação duplicada no cadastro', 'Mesmo escopo do MH-001', 'resolvido', 'v3', '2026-06-04', 'v4', NULL),
('BUG', 14, 'SIM/NÃO interpretados como cadastro, não confirmação de dose', NULL, 'resolvido', 'v4', '2026-06-09', 'v4', NULL),
('BUG', 15, 'Follow-up não disparava (coluna status inexistente)', NULL, 'resolvido', 'v5', '2026-06-11', 'v6', NULL),
('BUG', 16, 'Lembrete duplicado no mesmo horário', 'Mesma causa raiz do BUG-015', 'resolvido', 'v5', '2026-06-11', 'v6', NULL),
('BUG', 17, 'getDosesHoje não encontrava doses confirmadas (join quebrado)', NULL, 'resolvido', 'v5', '2026-06-11', 'v5', NULL),
('BUG', 18, 'Confirmação de dose ignorada após relatório', NULL, 'resolvido', 'v5', '2026-06-11', 'v6', NULL),

-- BUGs 019-030
('BUG', 19, 'Duplicação de boas-vindas (Z-API webhook 2x)', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('BUG', 20, 'Contexto do usuário ignorado na primeira mensagem', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('BUG', 21, '"Sim" ao consentimento LGPD interpretado como confirmação de dose', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('BUG', 22, 'detectarConfirmacaoDose sem verificar dose real pendente', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('BUG', 23, 'getRecentDoses com filtro via join quebrado', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('BUG', 24, 'agente_relatorios capturando afirmações como consultas', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('BUG', 25, 'Duplicação de mensagem de confirmação de dose (race condition)', 'Resolvido via correção do BUG-029', 'resolvido', 'v6', '2026-06-12', 'v7', NULL),
('BUG', 26, 'Perda de contexto pós-LGPD: "Sim" sem âncora', NULL, 'resolvido', NULL, '2026-06-13', NULL, NULL),
('BUG', 27, 'Nome de medicamento pré-cadastro perdido no cad_nome', NULL, 'aberto', 'v7', '2026-06-17', NULL, NULL),
('BUG', 28, '"ta bom" interpretado como pergunta em contexto idle', NULL, 'aberto', 'v7', '2026-06-17', NULL, NULL),
('BUG', 29, 'referenceMessageId ignorado / zaapId incompatível', NULL, 'limitacao_aceitavel', NULL, NULL, NULL, 'Fallback via texto funciona; não será resolvido'),
('BUG', 30, 'pareceNome() não filtra "Sim, quero continuar"', NULL, 'aberto', 'v7', '2026-06-17', NULL, NULL),

-- BUG-031 a 036: COLISÕES — par histórico (substituído) + par atual (vigente)
('BUG', 31, 'Lembrete duplicado — CURRENT_DATE em UTC cruzava meia-noite', NULL, 'historico_substituido', 'v7', '2026-06-17', 'v7', 'COLISÃO: número reaproveitado. Ver BUG-031 atual.'),
('BUG', 31, 'Linguagem inadequada no relatório semanal (geração livre do LLM)', NULL, 'resolvido', 'v15', '2026-07-07', 'v15', 'COLISÃO com significado histórico de 17/06 (lembrete duplicado/UTC), já resolvido e arquivado sob historico_substituido'),
('BUG', 32, 'Julia/Vitor cadastro: intenção não detectada + estado fantasma', NULL, 'historico_substituido', 'v7', '2026-06-15', 'v7', 'COLISÃO: número reaproveitado. Ver BUG-032 atual.'),
('BUG', 32, 'Encerramento de tratamento é fluxo sem saída', NULL, 'aberto', 'v12', '2026-06-30', NULL, 'COLISÃO com significado histórico (cadastro Julia/Vitor), já resolvido'),
('BUG', 33, 'Cálculo de adesão ignorava data de início do medicamento', NULL, 'historico_substituido', 'v7', '2026-06-15', 'v7', 'COLISÃO: número reaproveitado. Ver BUG-033 atual.'),
('BUG', 33, 'Dead-end residual em configuracao.js (alteração genérica sem tipo)', NULL, 'aberto', 'v12', '2026-06-30', NULL, 'COLISÃO com significado histórico (cálculo de adesão), já resolvido'),
('BUG', 34, 'post_onboarding consumido por resposta não-cadastro', NULL, 'historico_substituido', 'v7', '2026-06-17', 'v7', 'COLISÃO: número reaproveitado. Ver BUG-034 atual.'),
('BUG', 34, 'Proteção sistêmica contra dose_logs duplicados (vacina)', NULL, 'aberto', 'v12', '2026-06-30', NULL, 'Não urgente. COLISÃO com significado histórico (post_onboarding), já resolvido'),
('BUG', 35, 'cad_confirmacao não reconhece confirmações informais', NULL, 'historico_substituido', 'v7', '2026-06-17', 'v7', 'COLISÃO: número reaproveitado. Ver BUG-035 atual.'),
('BUG', 35, 'Fast-path determinístico de resposta tardia ao esgotamento', NULL, 'em_validacao', 'v13', '2026-07-03', NULL, '7 cenários de validação em BRIEFING_BUG035.md §5. COLISÃO não documentada até auditoria de 07/07 com significado histórico (cad_confirmacao), já resolvido'),
('BUG', 36, 'detectarConfirmacaoDose confirmava doses não tomadas (CRÍTICO)', NULL, 'historico_substituido', 'v7', '2026-06-17', 'v7', 'COLISÃO: número reaproveitado. Ver BUG-036 atual.'),
('BUG', 36, '"manter horários" não reconhecido como confirmação em configuracao.js', NULL, 'aberto', 'v12', '2026-06-30', NULL, 'Causa raiz confirmada, solução desenhada. COLISÃO com significado histórico, já resolvido'),

('BUG', 37, 'Mensagem de estoque zerado disparada em duplicata', NULL, 'resolvido', 'v7', '2026-06-17', 'v7', 'Número citado por engano como apelido interno do BUG-055 durante a v15; corrigido antes do fechamento, sem virar colisão permanente'),

-- BUGs 038-059
('BUG', 38, 'Horário por frequência assumido sem perguntar (cadastro)', NULL, 'resolvido', 'v9', '2026-06-19', 'v9', NULL),
('BUG', 39, 'Resumo não exibido automaticamente após cadastro', NULL, 'resolvido', 'v9', '2026-06-19', 'v9', NULL),
('BUG', 40, 'Confirmação de múltiplas doses não registrada', NULL, 'resolvido', 'v9', '2026-06-19', 'v9', NULL),
('BUG', 41, 'Cálculo de horários por frequência causava loop de cadastro', NULL, 'resolvido', 'v9', '2026-06-19', 'v9', NULL),
('BUG', 42, 'Comunicação de alteração de horário em configuracao.js', NULL, 'resolvido', 'v10', '2026-06-21', 'v10', NULL),
('BUG', 43, 'Fluxo pos_alteracao', NULL, 'resolvido', 'v10', '2026-06-21', 'v10', NULL),
('BUG', 44, 'pausarMedicamento não cancelava dose_logs pendentes', NULL, 'resolvido', 'v10', '2026-06-22', 'v10', NULL),
('BUG', 45, 'Frases no passado ("eu pausei") não reconhecidas por detectarIntencaoConfiguracao', NULL, 'deferred', 'v10', '2026-06-22', NULL, 'Deliberadamente adiado; confirmar se ainda relevante, não estava no backlog priorizado do CONTEXT.md v15'),
('BUG', 46, 'Estado confirming sem âncora confirmava todas as doses pendentes', NULL, 'resolvido', 'v10', '2026-06-23', 'v10', NULL),
('BUG', 47, 'classificarIntencao retornava ambiguo sem horário explícito', NULL, 'resolvido', 'v10', '2026-06-23', 'v10', NULL),
('BUG', 48, 'Medicamentos pausados apareciam em listas indevidas', NULL, 'resolvido', 'v10', '2026-06-23', 'v10', NULL),
('BUG', 49, 'Nome interno de ação exposto ao usuário ("remover_horario")', NULL, 'resolvido', 'v10', '2026-06-23', 'v10', NULL),
('BUG', 50, 'encontrarMedicamento não normalizava acentos', NULL, 'resolvido', 'v10', '2026-06-23', 'v10', NULL),
-- BUG-051: não encontrado em nenhuma fonte, número aparentemente pulado — não inserido
('BUG', 52, 'Cálculo não-determinístico de próxima dose', NULL, 'resolvido', 'v10', '2026-06-23', 'v10', NULL),
('BUG', 53, 'Linguagem não natural de horário em obter_horario', NULL, 'resolvido', 'v10', '2026-06-23', 'v10', NULL),
('BUG', 54, 'Estado ambiguo eliminado, criado esclarecer_pausar_encerrar', NULL, 'resolvido', 'v10', '2026-06-23', 'v10', NULL),
('BUG', 55, 'Perguntas de relatório caindo no agente de conversa geral', NULL, 'resolvido', 'v15', '2026-07-07', 'v15', 'Chamado internamente de "BUG-037" durante a sessão até correção'),
('BUG', 56, 'progresso_tratamento não filtrava por medicamento mencionado + atalho "escolha reconhecida" sem confirmar assunto', NULL, 'resolvido', 'v15', '2026-07-07', 'v15', NULL),
('BUG', 57, 'aguardando_periodo_adesao bloqueava confirmações de dose reais', NULL, 'em_validacao', 'v15', '2026-07-07', NULL, 'Cenário original ainda pendente de validação em produção'),
('BUG', 58, 'relatorioEstoque perdeu filtro por medicamento nomeado (regressão)', NULL, 'aberto', 'v15', '2026-07-07', NULL, 'Novo, não investigado ainda'),

-- FIX-001 a 004 (trilha paralela abandonada)
('FIX', 1, '"Voltaren" disparava agente de configuração (substring de "voltar")', NULL, 'resolvido', 'v7', '2026-06-17', 'v7', NULL),
('FIX', 2, 'Alerta de recompra indevido para tratamento agudo', NULL, 'resolvido', 'v7', '2026-06-17', 'v7', NULL),
('FIX', 3, 'Claude recalculava doses restantes e errava a aritmética', NULL, 'resolvido', 'v7', '2026-06-17', 'v7', NULL),
('FIX', 4, 'agente_principal sem memória entre turnos', NULL, 'em_validacao', 'v8', '2026-06-19', NULL, 'Diagnosticado com causa raiz confirmada; sintoma parece coberto pelo Classificador LLM (v9), mas nunca fechado formalmente com este ID — confirmar'),

-- MHs 001-045
('MH', 1, 'Confirmação duplicada no cadastro', 'Mesmo escopo do BUG-013', 'resolvido', 'v3', NULL, 'v4', NULL),
('MH', 2, 'Follow-up de lembrete sem resposta', NULL, 'resolvido', 'v4', NULL, 'v4', NULL),
('MH', 3, 'Timestamp real de confirmação de dose', NULL, 'em_validacao', 'v4', NULL, NULL, 'Provavelmente implementado — schema atual já tem taken_at separado de scheduled_at; confirmar e fechar'),
('MH', 4, 'Transcrição de áudio via Whisper', NULL, 'deferred', 'v4', NULL, NULL, 'Fase 3+'),
('MH', 5, 'Relatórios para o usuário', 'Virou o agente_relatorios', 'resolvido', 'v4', NULL, 'v5', NULL),
('MH', 6, 'agente_cadastro dedicado', NULL, 'resolvido', 'v4', NULL, 'v4', NULL),
('MH', 7, 'RAG no bulário ANVISA', NULL, 'deferred', 'v4', NULL, NULL, 'Fase 3+'),
('MH', 8, 'Leitura de receitas médicas por imagem', NULL, 'backlog_orfao', 'v4', '2026-06-09', NULL, 'Nunca implementado nem formalmente descartado'),
('MH', 9, 'Dashboard de relatórios para administrador', NULL, 'backlog_orfao', 'v4', '2026-06-09', NULL, 'Nunca implementado nem formalmente descartado'),
('MH', 10, 'agente_acompanhamento (NPS e feedback)', NULL, 'backlog_orfao', 'v4', '2026-06-09', NULL, 'Nunca implementado nem formalmente descartado'),
('MH', 11, 'Tipo de tratamento no cadastro', NULL, 'resolvido', 'v4', NULL, 'v4', NULL),
('MH', 12, 'Dosagem com propriedade via bulário', NULL, 'backlog_orfao', 'v4', '2026-06-09', NULL, 'Nunca implementado nem formalmente descartado'),
('MH', 13, 'Forma farmacêutica no cadastro', NULL, 'resolvido', 'v4', NULL, 'v4', NULL),
('MH', 14, 'Remover/pausar lembrete via conversa', NULL, 'resolvido', NULL, '2026-06-17', NULL, NULL),
('MH', 15, 'Alterar horário de lembrete via conversa', NULL, 'resolvido', NULL, '2026-06-17', NULL, NULL),
('MH', 16, 'Confirmação de encerramento — tratamento temporário', NULL, 'backlog_orfao', 'v5', '2026-06-11', NULL, 'Possível sobreposição com MH-030; nunca vinculado formalmente'),
('MH', 17, 'Lógica de estoque em dias — parte 1 (alerta ≤5 dias)', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('MH', 18, 'Lógica de estoque em dias — parte 2 (aviso no cadastro)', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('MH', 19, 'Fluxo completo de recusa e retorno LGPD', NULL, 'resolvido', 'v6', '2026-06-12', 'v6', NULL),
('MH', 20, 'Exclusão de dados ao recusar consentimento LGPD', NULL, 'backlog_orfao', 'v6', '2026-06-12', NULL, 'Nunca implementado nem formalmente descartado'),
('MH', 21, 'Variação natural do nome do usuário nos prompts', NULL, 'em_validacao', 'v6', '2026-06-12', NULL, 'Possivelmente parcial via saudação condicional v15 — confirmar escopo'),
('MH', 22, 'Lembrete disparado com estoque zerado (não deveria disparar)', NULL, 'resolvido', NULL, NULL, NULL, NULL),
-- MH-023: não encontrado em nenhuma fonte — não inserido
('MH', 24, 'Confirmação retroativa de dose ("tomei mas esqueci de registrar")', NULL, 'resolvido', 'v7', '2026-06-17', 'v11', 'Implementado como "Ciclo de Vida da Dose" v11; nunca fechado formalmente com este ID até agora. NOTA: número também foi usado informalmente em briefings posteriores para um escopo diferente (cálculo preciso de dosesRestantesEstimadas) — se ainda for prioridade, abrir número novo'),
('MH', 25, 'Alerta de estoque apenas no 1º lembrete do dia', NULL, 'superseded', NULL, NULL, NULL, 'Substituído por MH-026, não implementar'),
('MH', 26, 'Reestruturação completa dos alertas de estoque', NULL, 'resolvido', NULL, NULL, NULL, NULL),
('MH', 27, 'Reagendamento de lembrete sob demanda', NULL, 'aberto', NULL, NULL, NULL, NULL),
('MH', 28, 'tratamento_dias/tipo_tratamento acessíveis via conversa', NULL, 'resolvido', NULL, NULL, NULL, 'Base do calcularProgressoTratamento (v15)'),
('MH', 29, 'Alerta de estoque incorreto para tratamento de tempo determinado', NULL, 'aberto', NULL, NULL, NULL, NULL),
('MH', 30, 'Encerramento automático de tratamento agudo', NULL, 'aberto', NULL, NULL, NULL, NULL),
('MH', 31, 'Histórico de tratamentos encerrados via conversa', NULL, 'backlog_orfao', 'v7', '2026-06-17', NULL, 'Nunca implementado nem formalmente descartado'),
('MH', 32, 'Lembretes agrupados por horário de cadastro', NULL, 'em_validacao', NULL, NULL, NULL, '10 cenários em ambiente limpo'),
('MH', 33, 'Alteração de múltiplos horários em uma mensagem', NULL, 'resolvido', NULL, NULL, NULL, NULL),
-- MH-034: não encontrado em nenhuma fonte — não inserido
('MH', 35, 'Gestão de horários de lembrete (parte 2, junto com MH-033/036)', NULL, 'resolvido', NULL, NULL, NULL, NULL),
('MH', 36, 'Gestão de horários de lembrete (parte 3)', NULL, 'resolvido', NULL, NULL, NULL, NULL),
('MH', 37, 'Cálculo de adesão unificado via dose_logs reais + diagnóstico de turno', NULL, 'resolvido', 'v15', '2026-07-06', 'v15', NULL),
('MH', 38, 'Verificação de medicamento duplicado no início do cadastro', NULL, 'resolvido', 'v12', '2026-06-30', NULL, NULL),
('MH', 39, 'Avaliar fluxo de encerramento em lote ("encerrar todos")', NULL, 'aberto', 'v12', '2026-06-30', NULL, 'Relacionado ao BUG-032 atual'),
('MH', 40, 'Mensagens fragmentadas do mesmo contexto recebendo respostas independentes', NULL, 'aberto', 'v10', '2026-06-28', NULL, NULL),
('MH', 41, 'Dose pendente do horário antigo continua cobrando follow-up após alteração de horário', NULL, 'aberto', 'v12', '2026-06-30', NULL, 'Ponto de observação'),
('MH', 42, 'Correção manual de estoque + auditoria sistêmica (stock_movements)', NULL, 'resolvido', 'v13', NULL, 'v14', 'Validado por completo'),
('MH', 43, 'Fim de tratamento: pós-encerramento, alertas vencidos, prorrogação', NULL, 'aberto', 'v14', '2026-07-06', NULL, NULL),
('MH', 44, 'Jornada 2 de mensagens para usuários estáveis 5+ semanas', NULL, 'aberto', 'v15', '2026-07-07', NULL, NULL);
```

---

## 3. Funções JS a adicionar ao código (padrão: ponto único de escrita, igual `registrarMovimentoEstoque`)

Criar em `src/backlog.js` (ou pasta equivalente de utilitários):

```javascript
// Único ponto de escrita em backlog_items — nunca fazer insert/update direto
// em outro lugar do código (mesmo princípio do stock_movements / MH-042).

async function registrarItemBacklog({
  tipo, numero, titulo, descricao, causaRaiz,
  status, prioridade, sessaoCriacao, dataCriacao
}) {
  const { data, error } = await supabase
    .from('backlog_items')
    .insert({
      tipo, numero, titulo, descricao,
      causa_raiz: causaRaiz, status, prioridade,
      sessao_criacao: sessaoCriacao, data_criacao: dataCriacao
    })
    .select()
    .single();

  if (error) {
    // Se for violação do índice único (23505), o número já existe ativo —
    // isso é o comportamento CORRETO: força decisão explícita em vez de
    // sobrescrever silenciosamente (a causa raiz das 6 colisões anteriores).
    throw new Error(`Falha ao registrar ${tipo}-${numero}: ${error.message}`);
  }
  return data;
}

async function atualizarStatusBacklogItem({
  tipo, numero, novoStatus, sessaoFechamento, dataFechamento, notas
}) {
  const { data, error } = await supabase
    .from('backlog_items')
    .update({
      status: novoStatus,
      sessao_fechamento: sessaoFechamento,
      data_fechamento: dataFechamento,
      notas,
      updated_at: new Date().toISOString()
    })
    .eq('tipo', tipo)
    .eq('numero', numero)
    .neq('status', 'historico_substituido') // nunca edita o par histórico por engano
    .select()
    .single();

  if (error) throw new Error(`Falha ao atualizar ${tipo}-${numero}: ${error.message}`);
  return data;
}

module.exports = { registrarItemBacklog, atualizarStatusBacklogItem };
```

---

## 4. Ajuste no CONTEXT.md

Remover a seção detalhada de backlog (lista item a item). Substituir por uma nota curta:

```markdown
## Backlog (BUG/FIX/MH)

A partir de 07/07/2026, o backlog completo vive na tabela `backlog_items`
do Supabase (projeto Nami_Life Brazil, project_id nputymewnwmnhrtpizzs).
Não é mais mantido neste arquivo. Consultar via Supabase MCP:

  SELECT tipo, numero, titulo, status, prioridade, data_criacao
  FROM backlog_items
  WHERE status IN ('aberto', 'em_validacao')
  ORDER BY prioridade, data_criacao;
```

Isso é o que efetivamente reduz o CONTEXT.md e corta o custo de tokens de regeneração a cada encerramento — a lista deixa de existir como texto para reescrever.

---

## 5. Ordem de execução recomendada para o Claude Code

1. Rodar a migration da seção 1 (DDL).
2. Rodar os inserts da seção 2 (carga inicial/backfill).
3. Criar `src/backlog.js` com as funções da seção 3.
4. Atualizar `CONTEXT.md` conforme seção 4, commit + push.
5. Rodar `SELECT tipo, numero, COUNT(*) FROM backlog_items WHERE status <> 'historico_substituido' GROUP BY 1,2 HAVING COUNT(*) > 1;` — deve retornar **zero linhas**. Se retornar alguma, há um problema na carga inicial que precisa ser corrigido antes de considerar a migração concluída.