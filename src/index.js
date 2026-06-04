import express from 'express';
import 'dotenv/config';
import { handleIncomingMessage } from './agent.js';
import { parseZApiPayload } from './whatsapp.js';
import { startScheduler } from './scheduler.js';
import { getPendingReminders } from './database.js';

const app = express();
app.use(express.json());

// ============================================================
// WEBHOOK — recebe mensagens do WhatsApp via Z-API
// ============================================================

const processedMessages = new Set();

app.post('/webhook/whatsapp', async (req, res) => {
    res.sendStatus(200);

    try {
        const parsed = parseZApiPayload(req.body);
        if (!parsed) return;

        const { phone, text, audio, image } = parsed;
        if (!text && !audio && !image) return;

        // Proteção contra webhook duplicado
        const messageId = req.body.messageId || req.body.id || `${phone}-${Date.now()}`;
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);
        setTimeout(() => processedMessages.delete(messageId), 30000);

        console.log(`📩 Mensagem recebida de ${phone}: ${text || '[mídia]'}`);
        await handleIncomingMessage({ phone, text, audio, image });

    } catch (error) {
        console.error('❌ Erro no webhook:', error.message);
    }
});

// ============================================================
// ENDPOINT DE SAÚDE — pra verificar se o servidor está rodando
// ============================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Nami Backend',
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// ENDPOINT MANUAL — disparar lembretes (útil pra testar)
// ============================================================

app.get('/reminders/check', async (req, res) => {
    try {
        const reminders = await getPendingReminders();
        res.json({
            total: reminders.length,
            reminders
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// INICIA O SERVIDOR E O SCHEDULER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`
  ╔════════════════════════════════╗
  ║   💊 Nami Backend rodando!     ║
  ║   Porta: ${PORT}                  ║
  ╚════════════════════════════════╝
  `);

    // Inicia o scheduler de lembretes
    startScheduler();
});