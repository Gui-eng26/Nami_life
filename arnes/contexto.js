// ============================================================
// ARNÊS DE REGRESSÃO — contexto de execução (M0, v44)
//
// Prepara o ambiente ANTES de importar qualquer módulo do app:
// os módulos de src/ criam clientes Supabase/Z-API no load, lendo
// process.env — a ordem aqui é comportamento, não estilo.
//
// DECISÃO DOCUMENTADA (briefing v44 §3): o banco de teste é o
// projeto Supabase de STAGING (Nami-staging), semeado com usuários
// dedicados do arnês (prefixo de telefone reservado). Um schema
// dedicado exigiria duplicar as 33 funções SQL e todo o baseline —
// custo alto para isolamento que o staging já dá. Guarda dura:
// o arnês NUNCA roda contra o ref de produção.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const PROD_REF = 'nputymewnwmnhrtpizzs';
export const PREFIXO_TELEFONE_ARNES = '+5500000000';

export async function prepararContexto() {
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    // .env.arnes (não versionado) tem precedência e deve apontar para o STAGING.
    const envArnes = path.join(raiz, '.env.arnes');
    if (fs.existsSync(envArnes)) {
        dotenv.config({ path: envArnes, override: true });
    }
    // Alternativa sem arquivo: ARNES_SUPABASE_URL / ARNES_SUPABASE_SERVICE_KEY
    if (process.env.ARNES_SUPABASE_URL) process.env.SUPABASE_URL = process.env.ARNES_SUPABASE_URL;
    if (process.env.ARNES_SUPABASE_SERVICE_KEY) process.env.SUPABASE_SERVICE_KEY = process.env.ARNES_SUPABASE_SERVICE_KEY;

    // Completa o que faltar (ex.: ANTHROPIC_API_KEY) a partir do .env comum,
    // SEM sobrescrever o que o .env.arnes já definiu.
    dotenv.config({ path: path.join(raiz, '.env') });

    const url = process.env.SUPABASE_URL || '';
    if (!url || !process.env.SUPABASE_SERVICE_KEY) {
        throw new Error(
            'Arnês sem credenciais de banco. Crie .env.arnes com SUPABASE_URL e ' +
            'SUPABASE_SERVICE_KEY do projeto de STAGING (ver arnes/README.md).'
        );
    }
    if (url.includes(PROD_REF)) {
        throw new Error(
            `Arnês apontando para PRODUÇÃO (${PROD_REF}) — execução recusada. ` +
            'Aponte SUPABASE_URL (ou ARNES_SUPABASE_URL) para o projeto de staging.'
        );
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY ausente — o arnês reproduz turnos reais, com LLM real.');
    }

    // Z-API neutralizada: nenhum turno do arnês pode alcançar a Z-API de verdade.
    // Com o funil (§5.5) presente, o transporte é substituído por captura; sem ele,
    // qualquer envio acidental falha contra estas credenciais inertes.
    process.env.ZAPI_INSTANCE_ID = 'arnes-inerte';
    process.env.ZAPI_TOKEN = 'arnes-inerte';
    process.env.ZAPI_CLIENT_TOKEN = 'arnes-inerte';

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Import do app SÓ depois do ambiente pronto.
    const { routeMessage } = await import('../src/router.js');
    const { handleIncomingMessage } = await import('../src/agent.js');
    // v44 M2 (A21): o job de conclusão é exercitado diretamente pelo caso.
    const { concluirTratamentosVencidos } = await import('../src/scheduler.js');

    // Ponto de mock: o funil (§5.5). Enquanto o funil não existir (baseline do M0),
    // a captura fica só no valor de retorno de routeMessage.
    const enviosCapturados = [];
    let funilMockado = false;
    try {
        const funil = await import('../src/funil.js');
        if (typeof funil.configurarTransporteParaTestes === 'function') {
            funil.configurarTransporteParaTestes(async (phone, texto) => {
                enviosCapturados.push({ phone, texto, em: Date.now() });
                return { zaapId: `arnes-zaap-${enviosCapturados.length}`, messageId: `arnes-msg-${enviosCapturados.length}` };
            });
            funilMockado = true;
        }
    } catch {
        // src/funil.js ainda não existe — baseline pré-§5.5.
    }

    return { db, routeMessage, handleIncomingMessage, concluirTratamentosVencidos, enviosCapturados, funilMockado };
}
