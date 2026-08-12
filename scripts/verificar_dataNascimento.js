// Verificação ad-hoc de src/dataNascimento.js contra os cenários determinísticos
// da tabela de aceite do BRIEFING_MH072_PARTEA.md (#1 a #8). Projeto não tem test
// runner configurado — rodar manualmente: node scripts/verificar_dataNascimento.js
import assert from 'node:assert/strict';
import { extrairComponenteData, montarDataNascimento } from '../src/dataNascimento.js';

let ok = 0;
function check(desc, fn) {
    try {
        fn();
        ok++;
        console.log(`✅ ${desc}`);
    } catch (e) {
        console.error(`❌ ${desc}\n   ${e.message}`);
        process.exitCode = 1;
    }
}

// #1 — fluxo feliz: 7 -> março -> 1958
check('"7" na etapa dia -> dia:7', () => {
    const r = extrairComponenteData('7', 'dia');
    assert.deepEqual(r, { tipo: 'dia', valor: 7, candidatos: null });
});
check('"março" na etapa mes -> mes:3', () => {
    const r = extrairComponenteData('março', 'mes');
    assert.deepEqual(r, { tipo: 'mes', valor: 3, candidatos: null });
});
check('"1958" na etapa ano -> ano:1958', () => {
    const r = extrairComponenteData('1958', 'ano');
    assert.deepEqual(r, { tipo: 'ano', valor: 1958, candidatos: null });
});
check('montarDataNascimento(7,3,1958) -> válida 1958-03-07', () => {
    const r = montarDataNascimento({ dia: 7, mes: 3, ano: 1958 });
    assert.deepEqual(r, { valida: true, iso: '1958-03-07' });
});

// #2 — data completa na etapa do dia
check('"15/03/1960" na etapa dia -> data_completa', () => {
    const r = extrairComponenteData('15/03/1960', 'dia');
    assert.deepEqual(r, { tipo: 'data_completa', valor: { dia: 15, mes: 3, ano: 1960 }, candidatos: null });
});

// #3 — mês reconhecido na etapa do dia
check('"novembro" na etapa dia -> mes:11 (nunca ambíguo)', () => {
    const r = extrairComponenteData('novembro', 'dia');
    assert.deepEqual(r, { tipo: 'mes', valor: 11, candidatos: null });
});

// #4 — número por extenso com marcador
check('"dia dois" -> dia:2', () => {
    const r = extrairComponenteData('dia dois', 'mes');
    assert.deepEqual(r, { tipo: 'dia', valor: 2, candidatos: null });
});

// #5 — tolerância a erro de digitação (Levenshtein <= 1)
check('"nvembro" -> mes:11', () => {
    const r = extrairComponenteData('nvembro', 'mes');
    assert.deepEqual(r, { tipo: 'mes', valor: 11, candidatos: null });
});
check('"fevereito" -> mes:2', () => {
    const r = extrairComponenteData('fevereito', 'mes');
    assert.deepEqual(r, { tipo: 'mes', valor: 2, candidatos: null });
});

// #6 — ano de 2 dígitos nunca é inferido
check('"60" na etapa ano -> indeterminado (nunca 1960)', () => {
    const r = extrairComponenteData('60', 'ano');
    assert.deepEqual(r, { tipo: 'indeterminado', valor: null, candidatos: null });
});
check('"25" na etapa ano -> indeterminado (nunca 1925/2025)', () => {
    const r = extrairComponenteData('25', 'ano');
    assert.deepEqual(r, { tipo: 'indeterminado', valor: null, candidatos: null });
});

// #7 — correção implícita: dia já preenchido, usuário corrige durante etapa do ano
check('"na verdade o dia é 10" (etapa ano) -> dia:10', () => {
    const r = extrairComponenteData('na verdade o dia é 10', 'ano');
    assert.deepEqual(r, { tipo: 'dia', valor: 10, candidatos: null });
});

// #8 — combinação inválida (31 de fevereiro) -> reperguntar o dia
check('montarDataNascimento(31,2,1990) -> inválida, campoARefazer dia', () => {
    const r = montarDataNascimento({ dia: 31, mes: 2, ano: 1990 });
    assert.deepEqual(r, { valida: false, campoARefazer: 'dia' });
});

// Extras de robustez (fora da tabela, mas cobrem regras explícitas do briefing)
check('ambiguidade: "5" na etapa ano -> ambiguo entre dia e mes', () => {
    const r = extrairComponenteData('5', 'ano');
    assert.equal(r.tipo, 'ambiguo');
    assert.deepEqual(r.candidatos.sort(), ['dia', 'mes']);
});
check('data no futuro -> inválida', () => {
    const r = montarDataNascimento({ dia: 1, mes: 1, ano: 2099 });
    assert.equal(r.valida, false);
});
check('idade acima de 110 anos -> inválida', () => {
    const r = montarDataNascimento({ dia: 1, mes: 1, ano: 1850 });
    assert.equal(r.valida, false);
});
check('"31/04/2000" (abril não tem 31 dias) -> data_completa extraída, montagem inválida', () => {
    const r = extrairComponenteData('31/04/2000', 'dia');
    assert.equal(r.tipo, 'data_completa');
    const m = montarDataNascimento(r.valor);
    assert.deepEqual(m, { valida: false, campoARefazer: 'dia' });
});
check('"12" na etapa do dia -> dia:12 (não pergunta se é dezembro)', () => {
    const r = extrairComponenteData('12', 'dia');
    assert.deepEqual(r, { tipo: 'dia', valor: 12, candidatos: null });
});
check('bissexto: 29/02/2000 válida', () => {
    const r = montarDataNascimento({ dia: 29, mes: 2, ano: 2000 });
    assert.equal(r.valida, true);
});
check('não-bissexto: 29/02/1990 inválida', () => {
    const r = montarDataNascimento({ dia: 29, mes: 2, ano: 1990 });
    assert.equal(r.valida, false);
});

// MH-072 A.1 item 0 — Levenshtein sobre tokens curtos não pode engolir vocabulário
// funcional do português. Nenhuma das frases abaixo pode devolver mês.
const FRASES_SEM_MES = [
    'nossa que chato nao quero mais', 'nao quero mais', 'mas nao sei',
    'nao sei', 'pode ser', 'sei la',
    'nem sei', 'ate mais', 'deixa pra la',
    'prefiro nao dizer', 'tanto faz', 'quero ver'
];
for (const frase of FRASES_SEM_MES) {
    check(`"${frase}" -> NUNCA mês (era o bug do item 0)`, () => {
        const r = extrairComponenteData(frase, 'mes');
        assert.notEqual(r.tipo, 'mes');
    });
}

// E as variações abaixo de "novembro" continuam funcionando (ganho preservado).
const VARIACOES_NOVEMBRO = ['novembro', 'Nvembro', 'Novembto', 'Novenbro', 'Novmbro', 'nov', 'Nov'];
for (const variacao of VARIACOES_NOVEMBRO) {
    check(`"${variacao}" -> mes:11 (novembro)`, () => {
        const r = extrairComponenteData(variacao, 'mes');
        assert.equal(r.tipo, 'mes');
        assert.equal(r.valor, 11);
    });
}

// Cobertura extra pedida na seção 11.1: nome completo, forma normalizada e
// abreviação de cada mês citado como colisão.
check('"marco" -> mes:3 (nome completo, sem acento)', () => {
    assert.deepEqual(extrairComponenteData('marco', 'mes'), { tipo: 'mes', valor: 3, candidatos: null });
});
check('"março" -> mes:3', () => {
    assert.deepEqual(extrairComponenteData('março', 'mes'), { tipo: 'mes', valor: 3, candidatos: null });
});
check('"mar" (abreviação exata) -> mes:3', () => {
    assert.deepEqual(extrairComponenteData('mar', 'mes'), { tipo: 'mes', valor: 3, candidatos: null });
});
check('"maio" -> mes:5', () => {
    assert.deepEqual(extrairComponenteData('maio', 'mes'), { tipo: 'mes', valor: 5, candidatos: null });
});
check('"mai" (abreviação exata) -> mes:5', () => {
    assert.deepEqual(extrairComponenteData('mai', 'mes'), { tipo: 'mes', valor: 5, candidatos: null });
});
check('"setembro" -> mes:9', () => {
    assert.deepEqual(extrairComponenteData('setembro', 'mes'), { tipo: 'mes', valor: 9, candidatos: null });
});
check('"set" (abreviação exata) -> mes:9', () => {
    assert.deepEqual(extrairComponenteData('set', 'mes'), { tipo: 'mes', valor: 9, candidatos: null });
});
check('"dezembro" -> mes:12', () => {
    assert.deepEqual(extrairComponenteData('dezembro', 'mes'), { tipo: 'mes', valor: 12, candidatos: null });
});
check('"dez" (abreviação exata) -> mes:12', () => {
    assert.deepEqual(extrairComponenteData('dez', 'mes'), { tipo: 'mes', valor: 12, candidatos: null });
});

console.log(`\n${ok} verificações passaram.`);
