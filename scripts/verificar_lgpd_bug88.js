// Verificação ad-hoc do classificador de consentimento LGPD (BUG-88, MH-072 Parte B.0)
// contra a matriz de teste das seções 5.A a 5.D do BRIEFING_MH072_PB0.md. Chama a API
// real do Anthropic (classificarConsentimentoLgpd) — não escreve no banco. Projeto não
// tem test runner configurado — rodar manualmente: node scripts/verificar_lgpd_bug88.js
import { classificarConsentimentoLgpd } from '../src/agentes/recepcionista.js';

let ok = 0;
let total = 0;

async function check(desc, message, esperado, historicoConversa = []) {
    total++;
    const categoria = await classificarConsentimentoLgpd({ message, historicoConversa });
    if (categoria === esperado) {
        ok++;
        console.log(`✅ ${desc} -> ${categoria}`);
    } else {
        console.error(`❌ ${desc} -> esperado "${esperado}", obtido "${categoria}"`);
        process.exitCode = 1;
    }
}

async function main() {
    // A — Recusa (o defeito original: BUG-88)
    await check('A1 "Prefiro nao passar os dados"', 'Prefiro nao passar os dados', 'recusa');
    await check('A2 "não posso"', 'não posso', 'recusa');
    await check('A3 "isso não"', 'isso não', 'recusa');
    await check('A4 "sem chance"', 'sem chance', 'recusa');
    await check('A5 "agora não, obrigado"', 'agora não, obrigado', 'recusa');
    await check('A6 "deixa pra lá"', 'deixa pra lá', 'recusa');
    await check('A7 "tô com receio de passar meus dados"', 'tô com receio de passar meus dados', 'recusa');

    // B — Aceite (não-regressão)
    await check('B1 "sim"', 'sim', 'aceite');
    await check('B2 "pode"', 'pode', 'aceite');
    await check('B2 "concordo"', 'concordo', 'aceite');
    await check('B2 "aceito"', 'aceito', 'aceite');
    await check('B2 "claro"', 'claro', 'aceite');
    await check('B2 "ok"', 'ok', 'aceite');
    await check('B3 "sim, pode guardar"', 'sim, pode guardar', 'aceite');
    await check('B4 "tudo bem"', 'tudo bem', 'aceite');

    // C — Dúvida (novo)
    await check('C1 "pra que vocês precisam disso?"', 'pra que vocês precisam disso?', 'duvida');
    await check('C2 "vocês vendem meus dados?"', 'vocês vendem meus dados?', 'duvida');

    const historicoC = [
        { role: 'user', content: 'pra que vocês precisam disso?' },
        { role: 'assistant', content: 'Uso seus dados só pra personalizar seus lembretes — nunca vendo nem compartilho. Posso guardar seu nome, telefone e data de nascimento?' }
    ];
    await check('C3 depois de dúvida: "ah tá, então pode"', 'ah tá, então pode', 'aceite', historicoC);
    await check('C4 depois de dúvida: "não, prefiro não"', 'não, prefiro não', 'recusa', historicoC);

    // D — Indeterminado
    await check('D1 "asdfgh"', 'asdfgh', 'indeterminado');

    console.log(`\n${ok}/${total} verificações passaram.`);
    if (ok !== total) process.exitCode = 1;
}

main().catch(e => {
    console.error('❌ Falha na verificação:', e);
    process.exitCode = 1;
});
