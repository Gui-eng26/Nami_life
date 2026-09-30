// ============================================================
// MENSAGEM DIRECIONADA — v47 Onda 1 §5 (resgate)
//
// O Guilherme escreve/aprova uma mensagem individual; a Nami a envia pelo
// WhatsApp dela SABENDO que enviou: origem 'proativo:mensagem_direcionada',
// evento proativo registrado (com resumo) e assunto no envio (§1) com os
// medicamentos referidos — a resposta da pessoa chega ao principal com
// contexto.
//
// Uso:
//   node scripts/enviar_mensagem_direcionada.js --telefone +55XXXXXXXXXXX \
//        (--texto "mensagem" | --arquivo caminho.txt) [--med "Nome do remédio"]... [--staging]
//
// Regras (§5.2–5.3):
//   - o script NÃO redige nem altera texto — o conteúdo vem pronto;
//   - preview completo + confirmação interativa EXPLÍCITA antes de enviar;
//     sem confirmação, nada sai;
//   - sem agendamento, sem lote: um destinatário, um envio por execução.
//
// --staging aponta o banco para o projeto de staging (.env.arnes), mantendo
// o resto do ambiente (Z-API) do .env — mesmo padrão do arnês.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

function falhar(msg) {
    console.error(`\n❌ ${msg}`);
    process.exit(1);
}

function parseArgs(argv) {
    const args = { telefone: null, texto: null, arquivo: null, meds: [], staging: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--telefone') args.telefone = argv[++i];
        else if (argv[i] === '--texto') args.texto = argv[++i];
        else if (argv[i] === '--arquivo') args.arquivo = argv[++i];
        else if (argv[i] === '--med') args.meds.push(argv[++i]);
        else if (argv[i] === '--staging') args.staging = true;
        else falhar(`Argumento desconhecido: ${argv[i]}`);
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.telefone) falhar('Informe --telefone.');
if (!args.texto && !args.arquivo) falhar('Informe o conteúdo com --texto ou --arquivo.');
if (args.texto && args.arquivo) falhar('Use --texto OU --arquivo, não os dois.');

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (args.staging) {
    const envArnes = path.join(raiz, '.env.arnes');
    if (!fs.existsSync(envArnes)) falhar('--staging exige .env.arnes na raiz (ver arnes/README.md).');
    dotenv.config({ path: envArnes, override: true });
}
dotenv.config({ path: path.join(raiz, '.env') });

// O texto vem PRONTO — o script não redige nem altera (só tira o \n final de arquivo).
const texto = args.arquivo
    ? fs.readFileSync(path.resolve(args.arquivo), 'utf8').replace(/\n+$/, '')
    : args.texto;
if (!texto.trim()) falhar('O texto da mensagem está vazio.');

// Imports do app SÓ depois do ambiente pronto (mesma ordem do arnês).
const { createClient } = await import('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: usuarios, error: eUser } = await db.from('users')
    .select('id, name, phone, onboarded')
    .eq('phone', args.telefone);
if (eUser) falhar(`Erro ao buscar usuário: ${eUser.message}`);
if (!usuarios?.length) falhar(`Nenhum usuário com o telefone ${args.telefone}.`);
if (usuarios.length > 1) falhar(`Mais de um usuário com o telefone ${args.telefone} — resolva no banco antes.`);
const user = usuarios[0];

// Medicamentos referidos (opcionais): cada --med precisa casar com EXATAMENTE
// um medicamento ativo da pessoa — o script nunca adivinha.
const medsReferidos = [];
for (const nomeMed of args.meds) {
    const { data: meds, error: eMed } = await db.from('medications')
        .select('id, nome')
        .eq('user_id', user.id)
        .eq('ativo', true)
        .ilike('nome', `%${nomeMed}%`);
    if (eMed) falhar(`Erro ao buscar medicamento "${nomeMed}": ${eMed.message}`);
    if (!meds?.length) falhar(`Nenhum medicamento ativo de ${user.name || user.phone} casa com "${nomeMed}".`);
    if (meds.length > 1) falhar(`"${nomeMed}" é ambíguo: ${meds.map(m => m.nome).join(', ')}. Seja mais específico.`);
    medsReferidos.push(meds[0]);
}

const assuntos = medsReferidos.length
    ? medsReferidos.map(m => ({ fato: 'mensagem_direcionada', medicationId: m.id }))
    : [{ fato: 'mensagem_direcionada' }];
const resumo = texto.replace(/\s+/g, ' ').trim().slice(0, 120);

// ------------------------------------------------------------
// Preview completo (§5.2) — nada foi enviado até aqui.
// ------------------------------------------------------------
console.log('\n━━━━━━━━━━━━ PREVIEW — NADA FOI ENVIADO ━━━━━━━━━━━━');
console.log(`Banco:        ${process.env.SUPABASE_URL}${args.staging ? ' (staging)' : ''}`);
console.log(`Destinatário: ${user.phone}`);
console.log(`Nome:         ${user.name || '(sem nome)'}${user.onboarded ? '' : '  ⚠️ NÃO onboarded'}`);
console.log(`Assunto:      mensagem_direcionada${medsReferidos.length ? ` — medicamentos: ${medsReferidos.map(m => m.nome).join(', ')}` : ' (sem medicamento)'}`);
console.log(`Resumo (evento proativo): "${resumo}"`);
console.log('──────────────────── TEXTO ────────────────────');
console.log(texto);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const resposta = await new Promise(resolve => rl.question('\nDigite ENVIAR (maiúsculas) para confirmar; qualquer outra coisa cancela: ', resolve));
rl.close();

if (resposta.trim() !== 'ENVIAR') {
    console.log('\n🚫 Cancelado — nada foi enviado.');
    process.exit(0);
}

// ------------------------------------------------------------
// Envio pelo funil (§5.1): origem + assunto no ato; evento proativo depois.
// ------------------------------------------------------------
const { enviarAoUsuario } = await import('../src/funil.js');
const { registrarEventoProativo } = await import('../src/database.js');

const { envioId, messageId, zaapId } = await enviarAoUsuario({
    phone: user.phone,
    userId: user.id,
    texto,
    origem: 'proativo:mensagem_direcionada',
    assuntos
});

await registrarEventoProativo({
    userId: user.id,
    tipo: 'mensagem_direcionada',
    medicationId: medsReferidos.length === 1 ? medsReferidos[0].id : null,
    resumo
});

console.log('\n✅ Enviado.');
console.log(`envio_id:   ${envioId}`);
console.log(`message_id: ${messageId || zaapId || '(nenhum id devolvido)'}`);
console.log('evento proativo: mensagem_direcionada registrado');
process.exit(0);
