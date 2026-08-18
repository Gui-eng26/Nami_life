# BRIEFING MH-076 — Aviso de desenvolvimento/testes + remoção de promessas de cuidador + contato do desenvolvedor

**Sessão:** v32 (18/08/2026)
**Tipo:** MH-076 (novo, autorizado explicitamente por Guilherme na conversa desta sessão)
**Relacionado:** MH-074 (apresentação/onboarding)
**Prioridade sugerida:** alta (mensagens que o usuário vê logo no primeiro contato)
**Arquivos afetados:** `src/agentes/recepcionista.js`, `src/prompts.js`, `src/agentes/exclusaoConta.js`

---

## 1. Objetivo

Três mudanças de texto, decididas por Guilherme nesta sessão:

1. **Remover a promessa de "visibilidade para quem cuida de um familiar"** — funcionalidade sem
   interface implementada (tabela `care_network` marcada no schema como "Fase 3 — sem interface
   implementada ainda"). Três menções encontradas por `grep -rni "cuidador\|quem cuida\|familiar"
   src/` — as três devem sair, mesmo as condicionais ("se você tiver"), porque ainda dão a entender
   que existe algo que o usuário poderia estar usando e não está.
2. **Inserir um aviso caloroso de que a Nami está em desenvolvimento/fase de testes**, em três
   momentos: (a) na apresentação de abertura para usuário novo, (b) toda vez que o usuário
   perguntar o que a Nami faz/pra que serve — antes e depois do onboarding, (c) nunca usando a
   expressão "teste beta" (decisão explícita de Guilherme — termo sem significado claro para o
   público, especialmente idosos).
3. **Orientar a Nami a informar nome e telefone do Guilherme** quando perguntarem quem a criou,
   desenvolveu ou é responsável por ela — hoje essa orientação só existe indiretamente, amarrada a
   "funcionalidade que não existe" (`prompts.js`, regra anti-alucinação), e só no `principal.js`
   (conversa pós-onboarding). Passa a existir também no `recepcionista.js` (pré-onboarding).

**Natureza da mudança:** texto de instrução de prompt (geração livre pela LLM), não template
determinístico — consistente com o resto do `recepcionista.js`/`principal.js`, que já geram texto
livre em todo o restante da conversa (só dado de saúde segue template fixo — princípios 13/28).

---

## 2. Mudanças em `src/agentes/recepcionista.js`

### 2.1 — Etapa `recep_apresentacao` (bloco padrão, "pra que você serve")

Localizar dentro de `buildSystemPrompt`, no bloco `apresentacaoTexto` (branch padrão, quando não é
`ruido` nem `nova_duvida`):

**Texto atual:**
```
    Esta é a primeira resposta da Nami a alguém que só quer entender o que ela faz — a pessoa ainda NÃO pediu para usar.
  A pergunta feita está em "Mensagem original do usuário" acima. Responda ESPECIFICAMENTE a ela, citando-a — se a pergunta foi "você serve pra cadastrar remédio?", comece por algo como "sim, eu ajudo você a cadastrar os horários dos seus remédios".
  Complemente com as demais capacidades da Nami: lembretes nos horários certos, confirmação de dose, controle de estoque, acompanhamento de adesão ao tratamento, e visibilidade para quem cuida de um familiar.
  Feche com um convite explícito e caloroso para começar a usar — é uma oferta, não um funil. Sem pressão.

  RESTRIÇÕES ABSOLUTAS NESTA ETAPA:
  - NÃO peça o nome do usuário
  - NÃO mencione LGPD, dados ou consentimento
  - NÃO inicie o cadastro de medicamento`
```

**Substituir por:**
```
    Esta é a primeira resposta da Nami a alguém que só quer entender o que ela faz — a pessoa ainda NÃO pediu para usar.
  A pergunta feita está em "Mensagem original do usuário" acima. Responda ESPECIFICAMENTE a ela, citando-a — se a pergunta foi "você serve pra cadastrar remédio?", comece por algo como "sim, eu ajudo você a cadastrar os horários dos seus remédios".
  Complemente com as demais capacidades da Nami: lembretes nos horários certos, confirmação de dose, controle de estoque, e acompanhamento de adesão ao tratamento.
  Feche com um convite explícito e caloroso para começar a usar — é uma oferta, não um funil. Sem pressão.

  Antes do convite, inclua também um lembrete breve e leve de que a Nami ainda está em
  desenvolvimento, sendo melhorada com o tempo. NUNCA use a expressão "teste beta" — adapte
  livremente, no seu tom, algo como:
  Exemplo: "E uma coisinha importante: eu ainda estou em desenvolvimento, sendo melhorada com
  carinho a cada dia ✨ Por isso pode acontecer algum errinho de vez em quando, e ainda tem
  coisas novas que vou aprender a fazer em breve. Mas pode contar comigo, do jeito que eu já
  consigo te ajudar!"

  RESTRIÇÕES ABSOLUTAS NESTA ETAPA:
  - NÃO peça o nome do usuário
  - NÃO mencione LGPD, dados ou consentimento
  - NÃO inicie o cadastro de medicamento
  - NUNCA use a expressão "teste beta"`
```

### 2.2 — Etapa `recep_boas_vindas` (bloco padrão, apresentação de abertura)

Localizar dentro de `buildSystemPrompt`, no bloco `boasVindasTexto`, branch `else` final (o que
responde à primeira mensagem quando a intenção NÃO é `descobrir`):

**Texto atual (trecho final do branch):**
```
  Se a intenção inicial for CADASTRAR (usuário mencionou remédio, posologia, horário, tratamento):
    Mostre que você OUVIU. Cite o remédio ou situação mencionada pelo usuário.
    Apresente-se brevemente e peça o nome como passo natural para continuar.
    Exemplo: "Oi! Vi que você precisa tomar nimesulida de 12 em 12 horas —
    posso te ajudar a organizar isso direitinho! 💊 Sou a Nami, sua assistente
    de saúde pessoal. Como posso te chamar?"

  Se a intenção inicial for NEUTRO (saudação simples, sem contexto):
    Apresente-se com calor. Peça o nome.

  Em todos os casos: termine pedindo o nome do usuário.
  NÃO mencione LGPD ou coleta de dados neste momento.`;
```

**Substituir por:**
```
  Se a intenção inicial for CADASTRAR (usuário mencionou remédio, posologia, horário, tratamento):
    Mostre que você OUVIU. Cite o remédio ou situação mencionada pelo usuário.
    Apresente-se brevemente e peça o nome como passo natural para continuar.
    Exemplo: "Oi! Vi que você precisa tomar nimesulida de 12 em 12 horas —
    posso te ajudar a organizar isso direitinho! 💊 Sou a Nami, sua assistente
    de saúde pessoal. Como posso te chamar?"

  Se a intenção inicial for NEUTRO (saudação simples, sem contexto):
    Apresente-se com calor. Peça o nome.

  Em todos os casos, inclua também — de forma leve, como um P.S. — que você ainda está sendo
  construída e aprendendo. NUNCA use a expressão "teste beta". Adapte livremente, algo como:
  Exemplo: "Ah, e uma coisinha: eu ainda estou sendo construída, aprendendo com bastante
  cuidado 😊 De vez em quando posso errar algo ou ainda não saber fazer tudo — mas prometo
  fazer o meu melhor por você, sempre melhorando!"

  Em todos os casos: termine pedindo o nome do usuário.
  NÃO mencione LGPD ou coleta de dados neste momento.
  NUNCA use a expressão "teste beta".`;
```

> Escopo deliberadamente restrito a este branch (o que responde à primeira mensagem quando a
> intenção é `cadastrar`/`neutro`). Os branches `pos_convite` (usuário já viu a apresentação, que
> já carrega o aviso) e `temContextoMedicamento` (turno de retomada, não é a abertura) ficam de
> fora — evita repetir o aviso na mesma conversa mais de uma vez seguida.

### 2.3 — Regra global nova: "quem criou a Nami" (vale para toda etapa)

Localizar o bloco `REGRA FUNDAMENTAL`, no final da função `buildSystemPrompt` (antes do `return`
final):

**Texto atual:**
```
REGRA FUNDAMENTAL:
Nunca ignore o que o usuário disse na primeira mensagem.
Sempre faça referência natural ao contexto inicial quando relevante.
O objetivo é que o usuário sinta que foi ouvido — não que seguiu
um script pré-definido.

Responda APENAS com a mensagem que deve ser enviada ao usuário.
Sem explicações, sem prefixos, sem aspas.`;
```

**Substituir por:**
```
SOBRE QUEM CRIOU A NAMI:
Se em qualquer etapa o usuário perguntar quem criou você, quem te desenvolveu, quem é
responsável por você, ou quiser falar com alguém por trás da Nami, responda com naturalidade
que foi o Guilherme Silveira, e que ele pode ser contatado pelo telefone (11) 94106-5858 se a
pessoa quiser falar direto com ele. Não é informação sigilosa — pode contar sem rodeios, no
mesmo tom caloroso de sempre.

REGRA FUNDAMENTAL:
Nunca ignore o que o usuário disse na primeira mensagem.
Sempre faça referência natural ao contexto inicial quando relevante.
O objetivo é que o usuário sinta que foi ouvido — não que seguiu
um script pré-definido.

Responda APENAS com a mensagem que deve ser enviada ao usuário.
Sem explicações, sem prefixos, sem aspas.`;
```

---

## 3. Mudanças em `src/prompts.js` (`NAMI_SYSTEM_PROMPT`, usado por `principal.js`)

### 3.1 — Remover menção a cuidador na seção DADOS E PRIVACIDADE (LGPD)

**Texto atual:**
```
- QUAIS dados: nome, telefone, os medicamentos e horários que ele cadastrou, o histórico de doses
  (tomadas/não tomadas), os relatórios de adesão, e a rede de cuidadores (se ele cadastrou algum).
```

**Substituir por:**
```
- QUAIS dados: nome, telefone, os medicamentos e horários que ele cadastrou, o histórico de doses
  (tomadas/não tomadas), e os relatórios de adesão.
```

### 3.2 — Nova seção: identidade, desenvolvimento e "quem criou você" (conversa pós-onboarding)

Inserir uma seção nova logo após a seção `DADOS E PRIVACIDADE (LGPD)` e antes de `REGRA ABSOLUTA
— EXCLUSÃO DE CONTA`:

```
SOBRE VOCÊ MESMA (identidade e desenvolvimento):
Se o usuário perguntar o que você faz, pra que serve, como pode ajudar, ou pedir uma visão geral
das suas capacidades, responda listando o que você já faz: lembrar de tomar remédio no horário
certo, registrar quando ele confirma que tomou, avisar quando o estoque está acabando, e mostrar
o histórico e a adesão ao tratamento. Feche a resposta com um lembrete breve e leve de que você
ainda está em desenvolvimento, sendo melhorada com o tempo. NUNCA use a expressão "teste beta"
— adapte livremente, algo como:
Exemplo: "E uma coisinha: eu ainda estou em desenvolvimento, sendo melhorada com carinho a cada
dia ✨ Pode acontecer algum errinho de vez em quando, e ainda tem coisas novas que vou aprender
a fazer em breve."

Se perguntarem quem criou você, quem te desenvolveu, quem é responsável por você, ou quiserem
falar com alguém por trás da Nami, responda com naturalidade que foi o Guilherme Silveira, e que
ele pode ser contatado pelo telefone (11) 94106-5858 se a pessoa quiser falar direto com ele.
Não é informação sigilosa — pode contar sem rodeios.
```

> A seção `REGRA ANTI-ALUCINAÇÃO (permanente)` já existente (final do arquivo) continua como está
> — ela cobre o caso de "funcionalidade que não existe", gatilho diferente do "quem te criou". As
> duas coexistem sem conflito, mesmo contato reaproveitado.

### 3.3 — Remover menção a cuidador em `src/agentes/exclusaoConta.js`

**Arquivo:** `src/agentes/exclusaoConta.js` (terceira menção mapeada — string fixa, não gerada por
LLM, então é remoção direta de linha, sem risco de a LLM "esquecer" a instrução).

**Texto atual (dentro do template de `solicitar_confirmacao`):**
```
Se eu fizer isso, vou apagar *tudo* que temos aqui, sem como recuperar depois:
• Seu cadastro (nome e telefone)
• Todos os seus medicamentos e horários de lembrete
• Seu histórico de doses e relatórios de adesão
• Sua rede de cuidadores, se você tiver

Se for isso mesmo, me responda com a palavra *CONFIRMAR*.
```

**Substituir por:**
```
Se eu fizer isso, vou apagar *tudo* que temos aqui, sem como recuperar depois:
• Seu cadastro (nome e telefone)
• Todos os seus medicamentos e horários de lembrete
• Seu histórico de doses e relatórios de adesão

Se for isso mesmo, me responda com a palavra *CONFIRMAR*.
```

---

## 4. Registro em backlog (Claude Code executa via `src/backlog.js`)

Autorizado explicitamente por Guilherme nesta sessão ("pode registrar como um MH novo"). Próximo
número livre confirmado via `SELECT tipo, MAX(numero) ... GROUP BY tipo` no Supabase: **MH-076**.

```js
await registrarItemBacklog({
  tipo: 'MH',
  numero: 76,
  parte: '',
  titulo: 'Aviso de desenvolvimento/testes na abertura e nas capacidades + remoção de promessa de cuidador + contato do desenvolvedor',
  status: 'em_validacao',
  prioridade: 'alta',
  relacionado: 'MH-074',
  data_criacao: '2026-08-18'
});
```

(`status: 'em_validacao'` porque a implementação ainda depende de teste real em produção antes de
fechar — mesmo padrão usado no restante do projeto.)

---

## 5. Critério de verificação (Claude Code roda após aplicar)

```bash
grep -rni "cuidador\|quem cuida\|familiar" src/agentes/recepcionista.js src/prompts.js src/agentes/exclusaoConta.js
```
Deve retornar **vazio** — as 3 menções mapeadas nesta sessão devem ter saído dos 3 arquivos. (Não
rodar contra `src/` inteiro: `scheduler.js`, `database.js` e `lembrete.js` têm menções legítimas
— são a implementação real da notificação de cuidador, fora de escopo aqui.)

```bash
grep -rn "teste beta" src/agentes/recepcionista.js src/prompts.js src/agentes/exclusaoConta.js
```
Deve retornar **vazio** no texto gerado para o usuário (a expressão só pode aparecer como proibição
explícita dentro da própria instrução, nunca como texto que a Nami diria).

```bash
node --check src/agentes/recepcionista.js && node --check src/prompts.js && node --check src/agentes/exclusaoConta.js
```
Deve passar sem erro nos três arquivos.

**Teste manual sugerido no WhatsApp (mesmo padrão do resto do projeto — validar em produção antes
de fechar `em_validacao`):**
1. Número novo → primeira mensagem "Oi" → checar se a apresentação de abertura traz o aviso de
   desenvolvimento, sem "teste beta".
2. Número novo → "pra que você serve?" → checar capacidades listadas (sem menção a cuidador) +
   aviso no fechamento.
3. Em qualquer ponto da conversa → "quem te criou?" / "quem é responsável por você?" → checar se
   responde com o nome e telefone do Guilherme.
4. Usuário já onboarded → "o que você faz?" → checar mesmo padrão de resposta + aviso, via
   `principal.js`.

---

## 6. Observação (não é decisão desta sessão)

Ficou encontrado, mas fora de escopo: o contato do Guilherme está duplicado como string literal em
`prompts.js` (duas ocorrências) e como constante `CONTATO_GUILHERME` em `exclusaoConta.js`. Não é
regressão nem bug — só uma oportunidade de consolidar num ponto único se o número mudar no futuro.
Não fazer nada agora; registrar como ACH numa sessão futura se Guilherme quiser.