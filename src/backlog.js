import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Único ponto de escrita em backlog_items — nunca fazer insert/update direto
// em outro lugar do código (mesmo princípio do stock_movements / MH-042).
//
// v29 (governança de backlog, 05/08/2026): tipo aceita também 'ACH' (achado de
// sessão, nem sempre um bug/melhoria fechados) e todo item carrega 'parte'
// (''/'A'/'B'/'C'...) para dividir trabalho grande demais para uma sessão sem abrir
// número novo. 'parte' nunca é omitida do filtro de update — ver comentário abaixo.

export async function registrarItemBacklog({
    tipo, numero, titulo, descricao, causaRaiz,
    status, prioridade, sessaoCriacao, dataCriacao,
    relacionado = null, parte = ''
}) {
    const { data, error } = await supabase
        .from('backlog_items')
        .insert({
            tipo, numero, titulo, descricao,
            causa_raiz: causaRaiz, status, prioridade,
            sessao_criacao: sessaoCriacao, data_criacao: dataCriacao,
            relacionado, parte
        })
        .select()
        .single();

    if (error) {
        // Se for violação do índice único (23505), o número (+ parte) já existe ativo —
        // isso é o comportamento CORRETO: força decisão explícita em vez de
        // sobrescrever silenciosamente (a causa raiz das 6 colisões anteriores).
        throw new Error(`Falha ao registrar ${tipo}-${numero}${parte ? ` Parte ${parte}` : ''}: ${error.message}`);
    }
    return data;
}

export async function atualizarStatusBacklogItem({
    tipo, numero, novoStatus, sessaoFechamento, dataFechamento, notas,
    parte = ''
}) {
    // parte SEMPRE no filtro (default '') — desde a v29, tipo+numero sozinhos não
    // identificam mais uma linha única quando o item foi dividido em partes. Omitir
    // esse filtro faria .single() falhar (mais de uma linha bate) ou, pior, arriscar
    // um update na linha errada quando só uma parte existir no momento da chamada.
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
        .eq('parte', parte)
        .neq('status', 'historico_substituido') // nunca edita o par histórico por engano
        .select()
        .single();

    if (error) throw new Error(`Falha ao atualizar ${tipo}-${numero}${parte ? ` Parte ${parte}` : ''}: ${error.message}`);
    return data;
}
