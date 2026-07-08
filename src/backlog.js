import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Único ponto de escrita em backlog_items — nunca fazer insert/update direto
// em outro lugar do código (mesmo princípio do stock_movements / MH-042).

export async function registrarItemBacklog({
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

export async function atualizarStatusBacklogItem({
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
