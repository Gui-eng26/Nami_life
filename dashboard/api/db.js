// Cliente Supabase com service key — vive apenas no servidor (BRIEFING §12). O navegador
// nunca recebe esta credencial; toda consulta do front passa pela API do dashboard.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórias para o dashboard.');
}

// As agregações do briefing (§4, §6-10) vivem como funções SQL no banco (migration
// MH-009: dash_*), chamadas via supabase.rpc(nome, params) — nunca SQL dinâmico
// montado a partir de entrada do usuário.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
