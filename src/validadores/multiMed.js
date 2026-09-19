// ============================================================
// DIVISÃO MULTI-MEDICAMENTO (v44 M2 — MH-96, briefing §3)
//
// O schema aceita LISTA de tratamentos: a mensagem rica é dividida
// em N candidatos de forma determinística (linhas, separadores " e ",
// vírgulas), a partir dos nomes que a porta propôs. Absorve os
// precursores do M1 (§12.6 do CONTEXT): "linha original do 1º
// medicamento" e "semeadura de horários compartilhados" deixam de
// ser caminhos especiais da porta e viram comportamento do
// runner+extrator — UM mecanismo de preenchimento, nunca dois.
// ============================================================

import { normalizar } from '../nlp_helpers.js';
import { extrairHorariosCitados } from './recorrencia.js';

// Dosagem e quantidade impressas na própria linha ("Lamotrigina 100mg",
// "1 comprimido") — determinísticas, para o lote não precisar de uma chamada
// de extrator por item.
const RE_DOSAGEM_LINHA = /(\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|%|ui)(?:\/ml)?)\b/i;
const RE_QTD_LINHA = /\b(\d+(?:[.,]\d+)?)\s*(cps?|comprimidos?|c[áa]psulas?|gotas?|unidades?)\b/i;

const ROTULO_QTD = {
    cp: 'comprimido', cps: 'comprimido', comprimido: 'comprimido', comprimidos: 'comprimido',
    capsula: 'capsula', capsulas: 'capsula', cápsula: 'capsula', cápsulas: 'capsula',
    gota: 'gota', gotas: 'gota', unidade: 'unidade', unidades: 'unidade'
};

function linhaDoCandidato(linhas, nome) {
    const alvo = normalizar(nome);
    let idx = linhas.findIndex(l => normalizar(l).includes(alvo));
    if (idx === -1) idx = linhas.findIndex(l => normalizar(l).includes(alvo.split(/\s+/).pop()));
    return idx;
}

// Divide a mensagem em candidatos [{ nome, linha, horarios, dosagem, grupo }].
// `grupo` marca candidatos que vieram da MESMA linha (ex.: "Regenesis e
// ofolato D") — a posologia respondida vale para o grupo inteiro.
// Horário "compartilhado" (linha solta, caso Thaielly) só entra quando a linha
// do candidato não tem hora — normalizado como HH:MM (dado determinístico).
export function dividirCandidatos({ message, medicamentosPropostos, horariosPorta = [] }) {
    const linhas = String(message).split('\n').map(l => l.trim()).filter(Boolean);

    const indicesUsados = new Set();
    const candidatos = medicamentosPropostos.map(nome => {
        const idx = linhaDoCandidato(linhas, nome);
        const linha = idx >= 0 ? linhas[idx] : null;
        if (idx >= 0) indicesUsados.add(idx);
        const mQtd = linha ? linha.match(RE_QTD_LINHA) : null;
        return {
            nome,
            linha,
            grupo: idx >= 0 ? idx : null,
            horarios: linha ? extrairHorariosCitados(linha) : [],
            dosagem: linha ? (linha.match(RE_DOSAGEM_LINHA)?.[1] ?? null) : null,
            quantidade: mQtd ? Number(mQtd[1].replace(',', '.')) : null,
            formaRotulo: mQtd ? (ROTULO_QTD[mQtd[2].toLowerCase()] || 'unidade') : null
        };
    });

    // Horários compartilhados: linhas que não pertencem a nenhum candidato +
    // o que a porta extraiu como horários da mensagem.
    const linhasSoltas = linhas.filter((_, i) => !indicesUsados.has(i)).join(' ');
    const horariosCompartilhados = extrairHorariosCitados(`${linhasSoltas} ${(horariosPorta || []).join(' ')}`);

    for (const c of candidatos) {
        if (c.horarios.length === 0 && horariosCompartilhados.length > 0) {
            c.horarios = [...horariosCompartilhados];
            c.horariosCompartilhados = true;
        }
    }

    return { candidatos, horariosCompartilhados };
}

// Nome composto por " e " (caso A19 — "Regenesis e ofolato D"): dois produtos
// num nome só. Divide quando as duas metades são nomes plausíveis; a proposta
// de divisão é confirmável pela pessoa (nunca gravação composta em silêncio).
export function dividirNomeComposto(nome) {
    const m = String(nome || '').split(/\s+e\s+/i);
    if (m.length !== 2) return null;
    const [a, b] = m.map(s => s.trim());
    if (a.length < 3 || b.length < 3) return null;
    // "Vitamina C e D" tem metade curta demais; nomes reais têm corpo próprio.
    if (!/[a-zà-ú]{3,}/i.test(a) || !/[a-zà-ú]{3,}/i.test(b)) return null;
    return [a, b];
}

// Um candidato está "pronto para o lote" quando já tem horário — a proposta
// agregada completa a quantidade com o padrão explícito (1 unidade), que a
// pessoa confirma (nunca gravação de suposição em silêncio).
export function todosComHorario(candidatos) {
    return candidatos.length > 1 && candidatos.every(c => (c.horarios || []).length > 0);
}
