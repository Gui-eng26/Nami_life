import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { saveConversationState, excluirContaUsuario, formatarHistoricoConversa } from '../database.js';
import { normalizar } from '../nlp_helpers.js';
import { degradar } from '../observabilidade.js';

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
        // A decisão segura continua a mesma; o que muda é que ela deixa de ser invisível —
        // um pedido de exclusão de conta que desaparece sem rastro é problema de LGPD.
        console.error(`❌ [EXCLUSAO-CONTA] Erro no estágio 2 (LLM): ${e.message} — assumindo NAO`);
        return await degradar({
            origem: 'exclusao_conta',
            motivo: 'deteccao_llm_falhou',
            agent: 'excluir_conta',
            detalhe: { erro: e.name, status: e?.status ?? null },
            fallback: false
        });
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

// Afirmativo curto/ambíguo que NÃO é a palavra de confirmação — merece re-orientação,
// não cancelamento silencioso (ex: "sim", "ok", "pode", "quero").
function pareceAfirmativoAmbiguo(message) {
    if (!message) return false;
    const m = normalizar(message).trim();
    const termos = ['sim', 's', 'ok', 'okay', 'pode', 'pode sim', 'quero', 'quero sim',
        'isso', 'isso mesmo', 'claro', 'com certeza', 'aceito', 'positivo', 'uhum', 'aham',
        'blz', 'beleza', 'yes', 'sim quero', 'sim pode'];
    return termos.some(t => m === t || m.startsWith(t + ' '));
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

    // etapa === 'confirmar' — 3 buckets:
    // (1) palavra explícita CONFIRMAR -> executa | (2) afirmativo ambíguo -> re-orienta (mantém estado)
    // (3) qualquer outra coisa (negação/desistência/outro assunto) -> cancela com segurança.

    // Bucket 2: afirmativo ambíguo que NÃO é a palavra -> re-orienta, NÃO altera o estado.
    if (!confirmouExclusao(message) && pareceAfirmativoAmbiguo(message)) {
        console.log(`🗑️ [EXCLUSAO-CONTA] Afirmativo ambíguo ("${message}") — re-orientando para CONFIRMAR — ${user.phone}`);
        const response =
`${firstName}, como essa ação apaga *tudo* e não tem como voltar atrás, preciso que você escreva exatamente a palavra *CONFIRMAR* para eu seguir. 🌿

Se mudou de ideia, é só me dizer qualquer outra coisa que eu deixo tudo como está. 💛`;
        return { response, contaExcluida: false };
    }

    // Bucket 3: não é a palavra e não é afirmativo ambíguo -> cancela com segurança (saída de emergência).
    if (!confirmouExclusao(message)) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        console.log(`🗑️ [EXCLUSAO-CONTA] Exclusão NÃO confirmada — cancelada — ${user.phone}`);
        const response =
`Que bom, ${firstName}! 😊 Não apaguei nada — seus dados e seus lembretes continuam todos aqui comigo.

Se precisava de outra coisa, é só me dizer. 🌿`;
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
        // Registrado em system_events com severidade critica (MH-064, v26). Nada foi apagado — a
        // transação atômica fez rollback. Estado mantido em aguardando_confirmacao_exclusao para
        // permitir retry com CONFIRMAR.
        console.error(`❌ [EXCLUSAO-CONTA] Falha ao excluir conta — ${user.phone} — ${e.message}`);
        console.error('Stack:', e.stack);

        const response =
`${firstName}, tive um probleminha técnico e não consegui concluir a exclusão agora. 😔 Pode ficar tranquilo(a): *nada foi apagado*, seus dados continuam seguros.

Tente de novo daqui a alguns minutos, por favor. Se ainda assim não der certo, fale diretamente com o ${CONTATO_GUILHERME} — ele resolve isso pra você manualmente. 🌿`;

        return await degradar({
            origem: 'exclusao_conta',
            motivo: 'exclusao_falhou',
            agent: 'excluir_conta',
            userId: user.id,
            detalhe: { erro: e.name, estado_preservado: 'aguardando_confirmacao_exclusao' },
            fallback: { response, contaExcluida: false }
        });
    }
}
