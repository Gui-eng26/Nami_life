import { formatarQuantidadeDose, linhaQuantidadeDose } from '../src/templates/dose.js';

const casos = [
    [{ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: 'cápsula' },   '2 cápsulas'],
    [{ quantidade: 1, unidade_dose: 'unidade', forma_farmaceutica: 'capsula' },   '1 cápsula'],
    [{ quantidade: 1, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' },'1 comprimido'],
    [{ quantidade: 3, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' },'3 comprimidos'],
    [{ quantidade: 0.5, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, '0,5 comprimido'],
    [{ quantidade: 5, unidade_dose: 'ml', forma_farmaceutica: 'xarope' },         '5 ml'],
    [{ quantidade: 1, unidade_dose: 'ml', forma_farmaceutica: 'xarope' },         '1 ml'],
    [{ quantidade: 2.5, unidade_dose: 'ml', forma_farmaceutica: 'xarope' },       '2,5 ml'],
    [{ quantidade: 4, unidade_dose: 'gota', forma_farmaceutica: 'colírio' },      '4 gotas'],
    [{ quantidade: 1, unidade_dose: 'gota', forma_farmaceutica: 'colírio' },      '1 gota'],
    [{ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: 'efervescente' }, '2 unidades'],
    [{ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: null },        '2 unidades'],
    [{ quantidade: '2', unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, '2 comprimidos'],
    [{ quantidade: null, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, null],
    [{ quantidade: undefined, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, null],
    [{ quantidade: 0, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, null]
];

// Formato da LINHA — a quebra vem embutida, o rótulo é fixo, e a omissão é string vazia.
const casosLinha = [
    [
        [{ quantidade: 2, unidade_dose: 'unidade', forma_farmaceutica: 'cápsula' }, undefined],
        '\nQuantidade: 2 cápsulas'
    ],
    [
        [{ quantidade: 1, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, { indentacao: '  ' }],
        '\n  Quantidade: 1 comprimido'
    ],
    [
        [{ quantidade: null, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, undefined],
        ''
    ],
    [
        [{ quantidade: null, unidade_dose: 'unidade', forma_farmaceutica: 'comprimido' }, { indentacao: '  ' }],
        ''
    ]
];

let falhas = 0;
for (const [entrada, esperado] of casos) {
    const obtido = formatarQuantidadeDose(entrada);
    const ok = obtido === esperado;
    if (!ok) falhas++;
    console.log(`${ok ? '✅' : '❌'} ${JSON.stringify(entrada)} -> ${JSON.stringify(obtido)} (esperado ${JSON.stringify(esperado)})`);
}
for (const [[args, opcoes], esperado] of casosLinha) {
    const obtido = linhaQuantidadeDose(args, opcoes);
    const ok = obtido === esperado;
    if (!ok) falhas++;
    console.log(`${ok ? '✅' : '❌'} linha ${JSON.stringify(args)} ${JSON.stringify(opcoes || {})} -> ${JSON.stringify(obtido)} (esperado ${JSON.stringify(esperado)})`);
}
console.log(falhas === 0 ? '\n✅ 20/20' : `\n❌ ${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);
