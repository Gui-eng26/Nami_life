// ============================================================
// RESOLUÇÃO DETERMINÍSTICA DE DATA (v25)
// O LLM identifica a EXPRESSÃO ("ontem", "domingo", "19/07"); o cálculo da data real
// é sempre feito aqui, em código. Mesmo princípio do BUG-059 (calcularRotuloDia):
// o Claude não infere data relativa sozinho.
// Módulo de funções puras — sem I/O.
// ============================================================

const MAX_DIAS_RETROATIVOS = 30;

const DIAS_SEMANA = {
    domingo: 0,
    segunda: 1, 'segunda-feira': 1,
    terca: 2, 'terça': 2, 'terca-feira': 2, 'terça-feira': 2,
    quarta: 3, 'quarta-feira': 3,
    quinta: 4, 'quinta-feira': 4,
    sexta: 5, 'sexta-feira': 5,
    sabado: 6, 'sábado': 6
};

function normalizar(str) {
    return String(str || '').toLowerCase().trim();
}

// Data de hoje no fuso de Brasília, formato YYYY-MM-DD.
export function hojeBRT() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function somarDias(dataISO, n) {
    const [ano, mes, dia] = dataISO.split('-').map(Number);
    const dt = new Date(Date.UTC(ano, mes - 1, dia));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
}

function diaDaSemana(dataISO) {
    const [ano, mes, dia] = dataISO.split('-').map(Number);
    return new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
}

// Retorna { dataISO, erro } — erro preenchido quando a expressão não é resolvível
// ou está fora da janela suportada.
export function resolverDataReferencia(expressao) {
    const hoje = hojeBRT();
    const exp = normalizar(expressao);

    if (!exp) return { dataISO: hoje, erro: null };
    if (exp === 'hoje') return { dataISO: hoje, erro: null };
    if (exp === 'ontem') return { dataISO: somarDias(hoje, -1), erro: null };
    if (exp === 'anteontem') return { dataISO: somarDias(hoje, -2), erro: null };

    // Dia da semana → ocorrência passada mais recente (hoje conta, se for o mesmo dia)
    if (DIAS_SEMANA[exp] !== undefined) {
        const alvo = DIAS_SEMANA[exp];
        const atual = diaDaSemana(hoje);
        const delta = (atual - alvo + 7) % 7;
        return { dataISO: somarDias(hoje, -delta), erro: null };
    }

    // "19/07", "19/07/2026" ou "19"
    const m = exp.match(/^(\d{1,2})(?:\/(\d{1,2}))?(?:\/(\d{2,4}))?$/);
    if (m) {
        const [anoHoje, mesHoje] = hoje.split('-').map(Number);
        const dia = Number(m[1]);
        const mes = m[2] ? Number(m[2]) : mesHoje;
        let ano = m[3] ? Number(m[3]) : anoHoje;
        if (ano < 100) ano += 2000;

        if (dia < 1 || dia > 31 || mes < 1 || mes > 12) {
            return { dataISO: null, erro: 'invalida' };
        }
        const candidata = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
        if (candidata > hoje) return { dataISO: null, erro: 'futuro' };
        return { dataISO: candidata, erro: null };
    }

    return { dataISO: null, erro: 'nao_reconhecida' };
}

// Valida a janela suportada. Devolve { ok, motivo }.
export function validarJanela(dataISO) {
    const hoje = hojeBRT();
    if (dataISO > hoje) return { ok: false, motivo: 'futuro' };
    const limite = somarDias(hoje, -MAX_DIAS_RETROATIVOS);
    if (dataISO < limite) return { ok: false, motivo: 'antigo' };
    return { ok: true, motivo: null };
}

// Quantos dias atrás está a data (0 = hoje, 1 = ontem...)
export function diasAtras(dataISO) {
    const hoje = hojeBRT();
    const [a1, m1, d1] = hoje.split('-').map(Number);
    const [a2, m2, d2] = dataISO.split('-').map(Number);
    const t1 = Date.UTC(a1, m1 - 1, d1);
    const t2 = Date.UTC(a2, m2 - 1, d2);
    return Math.round((t1 - t2) / (24 * 60 * 60 * 1000));
}

// Rótulo humano da data — "hoje", "ontem", "anteontem" ou "domingo (26/07)"
export function rotularData(dataISO) {
    const d = diasAtras(dataISO);
    if (d === 0) return 'hoje';
    if (d === 1) return 'ontem';
    if (d === 2) return 'anteontem';

    const nomes = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
                   'quinta-feira', 'sexta-feira', 'sábado'];
    const [ano, mes, dia] = dataISO.split('-').map(Number);
    const nome = nomes[diaDaSemana(dataISO)];
    return `${nome} (${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')})`;
}

// Janela UTC correspondente ao dia inteiro em BRT (offset fixo -03:00, sem DST desde 2019)
export function janelaDiaBRT(dataISO) {
    return {
        inicio: new Date(`${dataISO}T00:00:00.000-03:00`).toISOString(),
        fim: new Date(`${dataISO}T23:59:59.999-03:00`).toISOString()
    };
}
