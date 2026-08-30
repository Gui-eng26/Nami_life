// Camada fina de API do dashboard (BRIEFING_MH009 §3, §12). O navegador nunca recebe
// credencial do Supabase; toda leitura passa por aqui. Nenhuma rota escreve em tabela
// de produção — só SELECT, via as funções de leitura de dashboard/api/definicoes.js e
// as funções RPC criadas na migration MH-009.
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { supabase } from './db.js';

import tecnicaRotas from './rotas/tecnica.js';
import perfilRotas from './rotas/perfil.js';
import medicamentosRotas from './rotas/medicamentos.js';
import adesaoRotas from './rotas/adesao.js';
import feedbackRotas from './rotas/feedback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// §12 — Supabase Auth, usuário admin único. A API valida o JWT e confere que o `sub`
// bate com o id de admin configurado em ADMIN_USER_ID. Qualquer outro id recebe 403.
async function exigirAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Token ausente.' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ erro: 'Token inválido.' });

  if (data.user.id !== process.env.ADMIN_USER_ID) {
    return res.status(403).json({ erro: 'Usuário não autorizado.' });
  }

  req.adminUser = data.user;
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/tecnica', exigirAdmin, tecnicaRotas);
app.use('/api/perfil', exigirAdmin, perfilRotas);
app.use('/api/medicamentos', exigirAdmin, medicamentosRotas);
app.use('/api/adesao', exigirAdmin, adesaoRotas);
app.use('/api/feedback', exigirAdmin, feedbackRotas);

// Serve o PWA compilado (vite build → dashboard/dist) no mesmo serviço Railway — um
// único serviço, separado do bot (§3), em vez de duas hospedagens para um dashboard só.
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distPath, 'index.html'));
});

// Railway injeta a porta via PORT — sem ler essa variável o serviço não sobe lá.
// DASHBOARD_PORT continua valendo para rodar localmente sem depender do Railway.
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 8080;
app.listen(PORT, () => console.log(`📊 Dashboard API na porta ${PORT}`));
