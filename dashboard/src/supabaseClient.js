// Cliente Supabase do NAVEGADOR — só para autenticação (login do admin único). Usa a
// chave publicável (anon/publishable), nunca a service key (BRIEFING_MH009 §12). Toda
// leitura de dado passa pela API do dashboard, autenticada com o JWT desta sessão.
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
