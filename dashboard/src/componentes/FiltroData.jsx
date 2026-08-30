import { useState } from 'react';

// Atalhos de data comuns aos painéis com filtro (§6.1: "desde 01/08 · últimos 7 dias ·
// ontem · período"). `onMudar(inicio, fim, rotulo)` recebe ISO strings ou null (sem
// filtro extra), mais o calendário para datas específicas e "Limpar" para voltar ao
// padrão e recolher a busca (pedido de Guilherme, v39).
const ATALHOS = [
  { rotulo: 'desde o início', calc: (inicioPadrao) => ({ inicio: inicioPadrao, fim: null }) },
  { rotulo: 'últimos 7 dias', calc: () => ({ inicio: isoDiasAtras(7), fim: null }) },
  { rotulo: 'últimos 30 dias', calc: () => ({ inicio: isoDiasAtras(30), fim: null }) },
  { rotulo: 'ontem', calc: () => diaBrasiliaEmUtc(1) }
];

function isoDiasAtras(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString();
}

// §4.2 do CONTEXT.md: todo recorte por dia converte para America/Sao_Paulo antes de
// truncar. "Ontem" é UM dia-calendário específico em Brasília — não "últimas 24h a
// partir de agora" (isoDiasAtras). Sem isso, um evento de HOJE de madrugada (ex:
// 03:00 BRT) cai dentro da janela rolante de 24h e aparece classificado como "ontem",
// que é justamente o bug que Guilherme reportou testando o dashboard (v39).
//
// Brasil não observa horário de verão desde 2019 — BRT é UTC−3 fixo o ano todo, a
// mesma premissa já usada em todo o resto do projeto (dataReferencia.js, SQL). Meia-
// noite em Brasília cai às 03:00 UTC do mesmo dia-calendário.
function diaBrasiliaEmUtc(diasAtras) {
  const formatador = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [{ value: ano }, , { value: mes }, , { value: dia }] = formatador.formatToParts(new Date());
  const diaAlvoUtc = Date.UTC(Number(ano), Number(mes) - 1, Number(dia) - diasAtras);
  const inicioBrasilia = new Date(diaAlvoUtc + 3 * 60 * 60 * 1000); // 00:00 BRT do dia alvo
  const fimBrasilia = new Date(inicioBrasilia.getTime() + 24 * 60 * 60 * 1000); // 00:00 BRT do dia seguinte
  return { inicio: inicioBrasilia.toISOString(), fim: fimBrasilia.toISOString() };
}

// Exportado para telas que preferem nascer com "ontem" pré-selecionado em vez de
// "desde o início" — evita listas grandes demais na primeira renderização (pedido de
// Guilherme, v39, nas visões Técnica e Medicamentos detalhado).
export function intervaloOntem() {
  return ATALHOS.find(a => a.rotulo === 'ontem').calc();
}

const estiloInput = { padding: '5px 8px', borderRadius: 6, border: '1px solid var(--linha)', fontSize: '0.8rem' };
const estiloLabel = { fontSize: '0.78rem', color: 'var(--texto-secundario)', display: 'flex', flexDirection: 'column', gap: 2 };

export default function FiltroData({ inicioPadrao, ativo, onMudar, onLimpar }) {
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');

  function aplicarPersonalizado() {
    if (!de) return;
    const inicio = new Date(`${de}T00:00:00`).toISOString();
    const fim = ate ? new Date(`${ate}T23:59:59`).toISOString() : null;
    onMudar(inicio, fim, 'personalizado');
  }

  function limpar() {
    setDe('');
    setAte('');
    onLimpar();
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {ATALHOS.map(a => (
          <button
            key={a.rotulo}
            onClick={() => { const r = a.calc(inicioPadrao); onMudar(r.inicio, r.fim, a.rotulo); }}
            style={{
              padding: '5px 10px', borderRadius: 999, border: '1px solid var(--linha)',
              background: ativo === a.rotulo ? 'var(--laranja)' : 'white',
              color: ativo === a.rotulo ? 'white' : 'var(--texto)',
              cursor: 'pointer', fontSize: '0.8rem'
            }}
          >
            {a.rotulo}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={estiloLabel}>
          de
          <input type="date" value={de} onChange={e => setDe(e.target.value)} style={estiloInput} />
        </label>
        <label style={estiloLabel}>
          até
          <input type="date" value={ate} onChange={e => setAte(e.target.value)} style={estiloInput} />
        </label>
        <button
          onClick={aplicarPersonalizado}
          disabled={!de}
          style={{
            padding: '5px 12px', borderRadius: 6, border: '1px solid var(--laranja)',
            background: ativo === 'personalizado' ? 'var(--laranja)' : 'white',
            color: ativo === 'personalizado' ? 'white' : 'var(--laranja-escuro)',
            cursor: de ? 'pointer' : 'not-allowed', opacity: de ? 1 : 0.5, fontSize: '0.8rem'
          }}
        >
          Aplicar
        </button>
        <button
          onClick={limpar}
          style={{
            padding: '5px 12px', borderRadius: 6, border: '1px solid var(--linha)',
            background: 'transparent', color: 'var(--texto-secundario)', cursor: 'pointer', fontSize: '0.8rem'
          }}
        >
          Limpar
        </button>
      </div>
    </div>
  );
}
