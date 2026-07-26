# BRIEFING — MH-020: Exclusão de conta a pedido explícito do usuário (LGPD)

> **Contexto de origem:** sessão de planejamento v21 (26/07/2026). Item MH-020, prioridade **alta**
> (conformidade LGPD). Crítico para a expansão beta — mais usuários desconhecidos = maior chance de
> alguém exercer o direito de exclusão de dados.
>
> **Escopo desta implementação (fechado com Guilherme):**
> 1. Função SQL atômica de exclusão + wrapper `excluirContaUsuario` em `database.js`.
> 2. Portão de detecção em 2 estágios no `router.js` (único ponto de detecção) + novo handler `src/agentes/exclusaoConta.js`.
> 3. Novo estado conversacional `aguardando_confirmacao_exclusao` + fluxo de confirmação com palavra explícita.
> 4. Nova seção de transparência de dados/LGPD no `NAMI_SYSTEM_PROMPT` (`prompts.js`).
>
> **Fora de escopo (NÃO fazer aqui):**
> - NÃO tocar no fluxo de recusa de LGPD durante o onboarding (`recepcionista.js`, estados
>   `lgpd_recusado`/`recep_lgpd_reapresentacao`). Fica intacto.
> - NÃO implementar monitoramento/alerta estruturado de erros (será uma MH nova, próxima sessão).

---

## 0. Achado crítico que motiva a arquitetura (LEIA ANTES DE IMPLEMENTAR)

Um `DELETE FROM users` simples **NÃO funciona** e falharia para praticamente todo usuário real.
Grafo de foreign keys confirmado via `information_schema` no banco de produção (26/07/2026):

| Tabela filha | FK | Aponta para | delete_rule |
|---|---|---|---|
| medications | user_id | users | **CASCADE** ✅ |
| agent_logs | user_id | users | **CASCADE** ✅ |
| conversation_state | user_id | users | **CASCADE** ✅ |
| intencoes_nao_suportadas | user_id | users | **CASCADE** ✅ |
| care_network | user_id / caregiver_id | users | **CASCADE** ✅ |
| **adesao_estado** | user_id | users | **NO ACTION** ⛔ |
| dose_logs | medication_id | medications | CASCADE ✅ |
| schedules | medication_id | medications | CASCADE ✅ |
| **stock_movements** | medication_id | medications | **NO ACTION** ⛔ |
| **stock_movements** | dose_log_id | dose_logs | **NO ACTION** ⛔ |

Duas tabelas bloqueiam a exclusão do pai:
- **`adesao_estado`** (qualquer usuário que já recebeu resumo de adesão tem linha aqui).
- **`stock_movements`** (qualquer usuário que já registrou dose/recompra tem linhas aqui — o MH-042
  grava um movimento por medicamento; `medication_id` é sempre preenchido, nunca nulo).

Por isso a exclusão precisa de **ordem explícita de deleção** dentro de uma **transação atômica**
(tudo-ou-nada). Se qualquer passo falhar → rollback → **nada é apagado** → usuário recebe mensagem
de erro e os dados ficam íntegros. Não usar deletes soltos pelo SDK (risco de exclusão parcial
corrompendo o estado). **Não** alteramos as FKs para CASCADE (evita mudar semântica global da
tabela de auditoria `stock_movements` — princípio 2, baixo acoplamento). A ordem fica encapsulada
na função SQL.

---

## 1. Migration — função SQL atômica `delete_user_account`

Criar novo arquivo: `supabase/migrations/20260726000000_mh020_delete_user_account.sql`

```sql
-- MH-020: exclusão atômica de conta de usuário a pedido explícito (LGPD).
-- Ordem de deleção necessária por causa de duas FKs com NO ACTION:
--   stock_movements (-> medications, -> dose_logs) e adesao_estado (-> users).
-- A função roda numa transação implícita: ou apaga tudo, ou nada (rollback em erro).

CREATE OR REPLACE FUNCTION delete_user_account(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- 1) stock_movements referencia medications e dose_logs com NO ACTION.
    --    Todo movimento tem medication_id (invariante do MH-042), então apagar por
    --    medication_id do usuário cobre 100% das linhas, inclusive as que apontam para dose_logs.
    DELETE FROM stock_movements
    WHERE medication_id IN (SELECT id FROM medications WHERE user_id = p_user_id);

    -- 2) adesao_estado referencia users com NO ACTION -> apagar antes de users.
    DELETE FROM adesao_estado WHERE user_id = p_user_id;

    -- 3) users -> CASCADE cobre o resto:
    --    medications (-> dose_logs, schedules), agent_logs, care_network,
    --    conversation_state, intencoes_nao_suportadas.
    DELETE FROM users WHERE id = p_user_id;
END;
$$;
```

⚠️ **Aplicar manualmente no SQL Editor do Supabase ANTES do deploy do código** (migrations não são
auto-aplicadas — princípio 7). Se a função não existir em produção, TODA tentativa de exclusão vai
falhar com "function delete_user_account does not exist" → cai na mensagem de erro (dados preservados),
mas nenhum usuário conseguirá excluir até a função ser criada. **Não fazer deploy do código sem
aplicar a migration primeiro.**

Verificação pós-aplicação (rodar no SQL Editor, deve retornar 1 linha):
```sql
SELECT proname FROM pg_proc WHERE proname = 'delete_user_account';
```

---

## 2. `database.js` — wrapper `excluirContaUsuario`

Adicionar na seção de USUÁRIOS (logo após `updateUser`):

```javascript
// MH-020: exclusão de conta a pedido explícito do usuário (LGPD).
// Chama a função SQL atômica delete_user_account (ordem de deleção + transação
// tudo-ou-nada). Único ponto de exclusão de conta no código (princípio 16).
export async function excluirContaUsuario(userId) {
    const { error } = await supabase.rpc('delete_user_account', { p_user_id: userId });
    if (error) throw new Error(`Erro ao excluir conta: ${error.message}`);
}
```

---

## 3. `nlp_helpers.js` — pré-filtro determinístico (estágio 1)

Adicionar ao final do arquivo. Segue o MESMO padrão do `detectarIntencaoConfiguracao` já existente
(palavra de ação + palavra de objeto), mas com um conjunto de objetos **disjunto** do de configuração
(que usa lembrete/remédio/horário). Assim "excluir meu lembrete" nunca cai aqui — só "excluir minha
conta/cadastro/dados".

```javascript
// ============================================================
// MH-020 — PRÉ-FILTRO DE EXCLUSÃO DE CONTA (estágio 1, determinístico)
// Barato: roda em toda mensagem de usuário onboarded. Só sinaliza CANDIDATO —
// a decisão semântica final é do estágio 2 (LLM), em exclusaoConta.js.
// Objetos aqui são DISJUNTOS dos de detectarIntencaoConfiguracao (lembrete/remédio/
// horário), então "excluir meu lembrete" NÃO cai aqui.
// ============================================================

function contemPalavraLivreExcl(texto, palavra) {
    if (palavra.includes(' ')) return texto.includes(palavra);
    return new RegExp(`(^|\\s)${palavra}(\\s|$|[.,!?])`).test(texto);
}

export function pareceExclusaoConta(message) {
    if (!message) return false;
    const msg = normalizar(message);

    // Verbos que, junto de um objeto de CONTA, sugerem exclusão de conta.
    const acoes = [
        'excluir', 'exclua', 'exclua', 'deletar', 'delete', 'apagar', 'apague',
        'remover', 'remova', 'cancelar', 'cancela', 'encerrar', 'encerra',
        'retirar', 'retira', 'tirar'
    ];
    // Objetos que significam "a conta/o cadastro do usuário na Nami".
    const objetos = [
        'conta', 'cadastro', 'meus dados', 'meu dados', 'meus dado',
        'minhas informacoes', 'minha informacao', 'meus registros', 'meu registro',
        'perfil', 'meu usuario', 'da nami', 'na nami', 'da plataforma', 'do app'
    ];
    // Frases que já significam exclusão de conta por si só (verbo + objeto embutidos).
    const frasesDiretas = [
        'me descadastrar', 'descadastrar', 'me descadastra', 'quero sair da nami',
        'sair da nami', 'apagar tudo', 'excluir tudo', 'deletar tudo'
    ];

    if (frasesDiretas.some(f => msg.includes(f))) return true;

    const temAcao = acoes.some(a => contemPalavraLivreExcl(msg, a));
    const temObjeto = objetos.some(o => contemPalavraLivreExcl(msg, o));
    return temAcao && temObjeto;
}
```

> **Nota:** `normalizar` e a função de palavra-livre já existem no arquivo/no router; aqui
> `contemPalavraLivreExcl` é uma cópia local pequena para não criar dependência cruzada. Se preferir,
> reutilize a `contemPalavraLivre` do `router.js` exportando-a — decisão de implementação sua, desde
> que o comportamento (match de palavra isolada) seja idêntico.

---

## 4. `src/agentes/exclusaoConta.js` — NOVO handler coeso (estágio 2 + fluxo)

Cria o arquivo. Ele é dono de: (a) a confirmação semântica via LLM, (b) os textos do fluxo,
(c) a checagem da palavra de confirmação, (d) a chamada da exclusão. O router só detecta e delega.

```javascript
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState, excluirContaUsuario, formatarHistoricoConversa } from '../database.js';
import { normalizar } from '../nlp_helpers.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CONTATO_GUILHERME = 'Guilherme Silveira pelo (11) 94106-5858';

// ============================================================
// ESTÁGIO 2 — CONFIRMAÇÃO SEMÂNTICA VIA LLM
// Roda SÓ quando pareceExclusaoConta() (estágio 1) já sinalizou candidato.
// Distingue: exclusão real de conta  vs.  "cancelar cadastro" (abortar cadastro de
// remédio no meio do fluxo)  vs.  excluir só um remédio/lembrete/horário  vs.
// negação ("não quero excluir minha conta")  vs.  pergunta sobre dados.
// ============================================================

export async function confirmarIntencaoExclusaoConta({ message, historicoConversa = [], currentState = 'idle' }) {
    const historicoTexto = formatarHistoricoConversa(historicoConversa);

    const systemPrompt = `Você é um classificador binário para um assistente de saúde via WhatsApp (a Nami).

Sua ÚNICA tarefa: decidir se a mensagem do usuário é um pedido EXPLÍCITO para EXCLUIR A CONTA
dele / apagar TODOS os dados dele da Nami.

Responda APENAS com uma palavra: SIM ou NAO. Sem pontuação, sem explicação.

Responda SIM somente quando o usuário quer apagar a CONTA/o CADASTRO inteiro / TODOS os dados dele:
- "quero excluir minha conta", "apaga todos os meus dados", "quero me descadastrar da Nami",
  "deleta meu cadastro", "não quero mais usar a Nami, pode apagar tudo", "sair da Nami de vez e apagar meus dados".

Responda NAO em TODOS os outros casos, incluindo:
- Cancelar/abortar um cadastro de MEDICAMENTO em andamento: "cancelar cadastro", "deixa o cadastro
  pra lá", "não quero cadastrar esse remédio agora" — especialmente se o ESTADO ATUAL indicar que o
  usuário está no meio de um cadastro.
- Excluir/remover só UM remédio, lembrete ou horário: "apagar o lembrete das 8h", "excluir a dipirona",
  "remover um horário".
- Negação: "não quero excluir minha conta", "não é pra apagar nada".
- Perguntas sobre dados/privacidade: "quais dados vocês guardam?", "por que guardam meus dados?",
  "vocês vão excluir meus dados?" (dúvida, não um pedido).

ESTADO ATUAL DA CONVERSA: ${currentState}

CONVERSA RECENTE:
${historicoTexto}`;

    try {
        const resposta = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 5,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }]
        });
        const texto = normalizar(resposta.content[0]?.text || '').trim();
        const isExclusao = texto.startsWith('sim');
        console.log(`🗑️ [EXCLUSAO-CONTA] Estágio 2 (LLM): "${message}" -> ${isExclusao ? 'SIM' : 'NAO'}`);
        return isExclusao;
    } catch (e) {
        // Falha do LLM: por segurança, NÃO trata como exclusão (evita apagar por engano).
        console.error(`❌ [EXCLUSAO-CONTA] Erro no estágio 2 (LLM): ${e.message} — assumindo NAO`);
        return false;
    }
}

// ============================================================
// CHECAGEM DA PALAVRA DE CONFIRMAÇÃO
// Exige palavra explícita (CONFIRMAR/EXCLUIR). Guarda de negação por causa da
// irreversibilidade: "não quero excluir" contém "excluir" mas NÃO deve confirmar.
// ============================================================

function confirmouExclusao(message) {
    if (!message) return false;
    const m = normalizar(message).trim();
    const temNegacao = /\b(nao|nunca|cancela|cancelar|deixa|desisto|desistir|para|espera|esquece|melhor nao|mudei de ideia)\b/.test(m);
    if (temNegacao) return false;
    return /\b(confirmar|confirmo|confirmado|excluir|exclua|exclua|apagar tudo|pode apagar|pode excluir)\b/.test(m);
}

// ============================================================
// HANDLER PRINCIPAL DO FLUXO
// etapa 'solicitar_confirmacao' -> pede CONFIRMAR e salva estado
// etapa 'confirmar'            -> executa/cancela conforme a resposta
//
// Retorna sempre um objeto: { response, contaExcluida }.
// contaExcluida = true sinaliza ao router para RETORNAR ANTES do logAgentInteraction
// final (o user_id não existe mais — inserir em agent_logs daria FK error).
// ============================================================

export async function handleExclusaoConta({ user, message, etapa, historicoConversa = [] }) {
    const firstName = user.name ? user.name.split(' ')[0] : 'você';

    if (etapa === 'solicitar_confirmacao') {
        await saveConversationState(user.id, {
            state: 'aguardando_confirmacao_exclusao',
            context: {}
        });
        console.log(`🗑️ [EXCLUSAO-CONTA] Pedido de exclusão reconhecido — aguardando CONFIRMAR — ${user.phone}`);

        const response =
`${firstName}, só pra confirmar antes de seguir: você quer mesmo excluir sua conta na Nami? 🌿

Se eu fizer isso, vou apagar *tudo* que temos aqui, sem como recuperar depois:
• Seu cadastro (nome e telefone)
• Todos os seus medicamentos e horários de lembrete
• Seu histórico de doses e relatórios de adesão
• Sua rede de cuidadores, se você tiver

Se for isso mesmo, me responda com a palavra *CONFIRMAR*.
Se mudou de ideia, é só me dizer qualquer outra coisa que eu deixo tudo como está. 💛`;

        return { response, contaExcluida: false };
    }

    // etapa === 'confirmar'
    if (!confirmouExclusao(message)) {
        // Não confirmou -> cancela com segurança, volta pra idle (saída de emergência).
        await saveConversationState(user.id, { state: 'idle', context: {} });
        console.log(`🗑️ [EXCLUSAO-CONTA] Exclusão NÃO confirmada — cancelada — ${user.phone}`);

        const response =
`Que bom, ${firstName}! 😊 Não apaguei nada — seus dados e seus lembretes continuam todos aqui comigo.

Se precisar de qualquer coisa, é só falar. 🌿`;
        return { response, contaExcluida: false };
    }

    // Confirmou explicitamente -> executa a exclusão atômica.
    try {
        await excluirContaUsuario(user.id);
        console.log(`✅ [EXCLUSAO-CONTA] Conta excluída com sucesso (LGPD) — ${user.phone}`);

        // SEM nome: após a exclusão não conhecemos mais o usuário.
        const response =
`Pronto. Apaguei todos os dados desta conta da Nami, como foi pedido. 🌿

Foi um prazer ter ajudado até aqui. Se um dia quiser voltar a organizar seus tratamentos, é só me chamar de novo — começamos do zero, no seu tempo. 💛

Cuide-se!`;
        return { response, contaExcluida: true };

    } catch (e) {
        // Erro técnico: nada foi apagado (transação atômica fez rollback).
        // console.error completo vai pros logs do Railway (monitoramento reativo atual).
        // Mantém o estado aguardando_confirmacao_exclusao para permitir retry direto com CONFIRMAR.
        console.error(`❌ [EXCLUSAO-CONTA] Falha ao excluir conta — ${user.phone} — ${e.message}`);
        console.error('Stack:', e.stack);

        const response =
`${firstName}, tive um probleminha técnico e não consegui concluir a exclusão agora. 😔 Pode ficar tranquilo(a): *nada foi apagado*, seus dados continuam seguros.

Tente de novo daqui a alguns minutos, por favor. Se ainda assim não der certo, fale diretamente com o ${CONTATO_GUILHERME} — ele resolve isso pra você manualmente. 🌿`;
        return { response, contaExcluida: false };
    }
}
```

---

## 5. `router.js` — integração do portão e do estado de confirmação

### 5.1 Import

No topo, junto dos outros imports de agentes:
```javascript
import { handleExclusaoConta, confirmarIntencaoExclusaoConta } from './agentes/exclusaoConta.js';
```
E adicionar `pareceExclusaoConta` ao import existente de `./nlp_helpers.js`:
```javascript
import { isCancelamento, pareceExclusaoConta } from './nlp_helpers.js';
```
(mantenha os outros itens já importados de `nlp_helpers.js`, se houver).

### 5.2 Dois novos branches, colocados LOGO APÓS o branch de onboarding (`if (!user.onboarded)`) e ANTES de `else if (currentState === 'post_onboarding')`

A ordem importa: o branch de confirmação vem primeiro (trata o estado pendente); o portão vem logo
depois (detecta pedido novo em QUALQUER outro estado — é o que dá precedência sobre todos os fluxos).

```javascript
    // MH-020 — Confirmação pendente de exclusão de conta (trata o estado antes de tudo)
    } else if (currentState === 'aguardando_confirmacao_exclusao') {
        agentName = 'exclusao_conta';
        console.log(`🗑️ Roteando para exclusão de conta (confirmação pendente) — ${user.phone}`);
        const r = await handleExclusaoConta({ user, message, etapa: 'confirmar', historicoConversa });

        if (r.contaExcluida) {
            // Usuário não existe mais — RETORNA ANTES do logAgentInteraction final
            // (inserir agent_logs com user_id apagado daria FK error).
            return r.response;
        }
        response = r.response;

    // MH-020 — Portão de detecção de pedido de exclusão de conta (único ponto de detecção).
    // Roda para qualquer usuário onboarded, em qualquer estado -> precedência sobre todos os fluxos.
    // Estágio 1 (barato, determinístico) curto-circuita o estágio 2 (LLM) quando não é candidato.
    } else if (user.onboarded
        && pareceExclusaoConta(message)
        && await confirmarIntencaoExclusaoConta({ message, historicoConversa, currentState })) {
        agentName = 'exclusao_conta';
        console.log(`🗑️ Pedido de exclusão de conta detectado — ${user.phone}`);
        const r = await handleExclusaoConta({ user, message, etapa: 'solicitar_confirmacao', historicoConversa });
        response = r.response;
```

> **Importante:** manter esses dois branches como parte da MESMA cadeia `if/else if` do `routeMessage`
> (encaixar entre o `if (!user.onboarded) { ... }` e o `} else if (currentState === 'post_onboarding')`).
> Como são `else if`, quando o portão dispara ele curto-circuita todos os branches seguintes
> (`configurando`, `adding_med`, `aguardando_periodo_adesao` etc.) — é exatamente o comportamento
> desejado: nenhum fluxo se sobrepõe ao pedido explícito de exclusão.
>
> Quando o estágio 1 é `false`, o `&&` curto-circuita e o estágio 2 (LLM) nem roda — custo zero na
> esmagadora maioria das mensagens. Quando o estágio 1 é `true` mas o estágio 2 retorna `false`
> (ex: "cancelar cadastro" no meio de um cadastro), o branch inteiro é `false` e o roteamento segue
> normalmente para os branches seguintes (o `adding_med`/config trata o caso como sempre).

Nada mais no `router.js` precisa mudar. O `logAgentInteraction` final e o `return response` no fim
do `routeMessage` continuam iguais (só o caminho de exclusão bem-sucedida retorna antes, de propósito).

---

## 6. `prompts.js` — nova seção de transparência de dados/LGPD

Adicionar ao `NAMI_SYSTEM_PROMPT`, sugerido logo após a seção `LIMITES IMPORTANTES:`
(antes de `AÇÕES DISPONÍVEIS:`). Texto literal a inserir:

```
DADOS E PRIVACIDADE (LGPD):
Se o usuário perguntar quais dados você guarda, por quê, como, onde, ou sobre privacidade/LGPD,
responda com clareza, calor e sem juridiquês. Diretrizes do que informar:
- QUAIS dados: nome, telefone, os medicamentos e horários que ele cadastrou, o histórico de doses
  (tomadas/não tomadas), os relatórios de adesão, e a rede de cuidadores (se ele cadastrou algum).
- POR QUÊ: exclusivamente para enviar os lembretes, registrar as doses, calcular a adesão e avisar
  sobre o estoque. Os dados NUNCA são vendidos nem compartilhados com terceiros.
- ONDE: ficam guardados de forma segura, em servidor no Brasil, em conformidade com a LGPD.
  Não entre em detalhes técnicos além disso.
- DIREITOS: o usuário pode pedir para excluir todos os dados dele a qualquer momento — basta dizer,
  por exemplo, "quero excluir minha conta". Deixe claro que isso é um direito dele.
Não invente políticas nem prazos que você não tem certeza. Se a pergunta for além disso (ex: pedidos
formais, contratos, dúvidas jurídicas específicas), direcione ao Guilherme Silveira, (11) 94106-5858.
Nunca trate uma PERGUNTA sobre dados como um pedido de exclusão — só o pedido explícito de excluir a
conta aciona a exclusão.
```

---

## 7. Checklist de teste em produção (validação real, pós-deploy)

Ordem obrigatória de deploy: **(1) aplicar migration no SQL Editor → (2) verificar função existe →
(3) deploy do código.**

Cenários a validar no WhatsApp (usuário de teste onboarded, com pelo menos 1 medicamento e alguma
dose/estoque para exercitar `stock_movements`/`adesao_estado`):

**A. Detecção correta (dispara o fluxo):**
1. "quero excluir minha conta" → Nami pede CONFIRMAR.
2. "apaga todos os meus dados" → pede CONFIRMAR.
3. "quero me descadastrar da Nami" → pede CONFIRMAR.
4. Pedido NO MEIO de um fluxo: iniciar cadastro de remédio e, no meio, mandar "excluir minha conta"
   → deve abandonar o cadastro e pedir CONFIRMAR (precedência sobre o fluxo).

**B. Não-detecção correta (NÃO dispara — cai no fluxo normal):**
5. No meio de um cadastro de remédio: "cancelar cadastro" → deve cancelar/tratar o CADASTRO do
   remédio, NÃO a conta.
6. "apagar o lembrete das 8h" / "excluir a dipirona" → vai para configuração, NÃO exclui conta.
7. "não quero excluir minha conta" → NÃO dispara exclusão (resposta normal).
8. "por que vocês guardam meus dados?" / "quais dados vocês guardam?" → resposta informativa da nova
   seção LGPD, sem acionar exclusão.

**C. Confirmação e execução:**
9. Pedir exclusão → responder "CONFIRMAR" → conta apagada; mensagem de sucesso SEM nome.
   - Verificar no Supabase que sumiram: `users`, `medications`, `dose_logs`, `schedules`,
     `stock_movements`, `agent_logs`, `conversation_state`, `adesao_estado`, `intencoes_nao_suportadas`,
     `care_network` do usuário. (Rodar `SELECT` por telefone/user_id em cada uma → 0 linhas.)
10. Mandar nova mensagem depois de excluído → `getOrCreateUser` recria limpo → cai no onboarding
    (recepcionista), como novo usuário.

**D. Cancelamento e segurança:**
11. Pedir exclusão → responder "não" / "deixa" / "mudei de ideia" → NÃO apaga; mensagem de
    cancelamento com nome; estado volta a idle.
12. Pedir exclusão → responder "sim" (sem a palavra CONFIRMAR/EXCLUIR) → NÃO apaga (só a palavra
    explícita confirma). Conferir esse ponto com atenção: "sim" sozinho não pode apagar.

**E. Erro técnico (simular):**
13. (Opcional, ambiente controlado) Renomear temporariamente a função SQL ou testar antes de aplicar
    a migration → pedir exclusão → CONFIRMAR → deve cair na mensagem de erro ("nada foi apagado…
    fale com o Guilherme"), estado mantido, e o stack do erro deve aparecer nos logs do Railway.
    Verificar que os dados do usuário continuam intactos no banco.

---

## 8. Itens a registrar em `backlog_items` (escrita exclusiva do Claude Code)

**Atualizar MH-020:**
- `numero`=20, `tipo`='MH'
- `status` → `em_validacao`
- `sessao_fechamento` → (versão desta sessão)
- `data_fechamento` → 2026-07-26
- `causa_raiz` → "Capacidade de exclusão de dados a pedido do usuário nunca foi construída. Além disso, a cascata pura de FK falharia para usuários reais por causa de adesao_estado e stock_movements (NO ACTION). Resolvido com função SQL atômica de deleção ordenada + portão de detecção em 2 estágios (determinístico + LLM) com precedência sobre todos os fluxos, exigindo confirmação por palavra explícita."
- `notas` → "Onboarding/recusa LGPD mantidos intactos (fora de escopo). Implementados: migration delete_user_account, excluirContaUsuario (database.js), pareceExclusaoConta (nlp_helpers.js), exclusaoConta.js (handler + estágio 2 LLM), 2 branches no router.js, estado aguardando_confirmacao_exclusao, seção DADOS E PRIVACIDADE no NAMI_SYSTEM_PROMPT. Aguardando validação em produção (checklist do briefing)."

**Registrar MH nova — monitoramento/alerta estruturado de erros:**
- `tipo`='MH', `numero`= (próximo livre — consultar `SELECT MAX(numero) FROM backlog_items WHERE tipo='MH' AND status <> 'historico_substituido'`)
- `titulo`="Monitoramento/alerta estruturado de erros técnicos (ex: falha de exclusão de conta)"
- `descricao`="Hoje erros só aparecem via console.error nos logs do Railway (reativo, sem alerta). Casos sensíveis como falha de exclusão de conta (LGPD) deveriam gerar alerta proativo ao Guilherme e permitir distinguir erro transitório (retry resolve) de persistente (ex: migration não aplicada, FK nova sem cascata) para direcionar a mensagem certa ao usuário."
- `status`='aberto', `prioridade`='media', `data_criacao`=2026-07-26

---

## 9. Resumo dos arquivos tocados

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/20260726000000_mh020_delete_user_account.sql` | **NOVO** — função SQL atômica (aplicar manual antes do deploy) |
| `src/database.js` | `excluirContaUsuario(userId)` (wrapper RPC) |
| `src/nlp_helpers.js` | `pareceExclusaoConta(message)` (estágio 1) + helper local de palavra-livre |
| `src/agentes/exclusaoConta.js` | **NOVO** — estágio 2 (LLM) + handler do fluxo + textos + checagem de confirmação |
| `src/router.js` | import + 2 branches (confirmação pendente / portão de detecção) |
| `src/prompts.js` | seção `DADOS E PRIVACIDADE (LGPD)` no `NAMI_SYSTEM_PROMPT` |

**Princípios aplicados:** 1 (sistêmico — resolve a classe: exclusão + transparência), 2 (baixo
acoplamento — não altera FKs globais), 7 (migration manual), 11/13 (texto de resultado determinístico,
templates fixos), 14 (classificação semântica central, não lista de palavras — estágio 2 LLM decide),
16 (exclusão via função única), 18 (cancelamento não tem precedência cega — objeto da ação distingue
conta de remédio).