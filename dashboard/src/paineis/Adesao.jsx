import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api.js';
import Cartao from '../componentes/Cartao.jsx';
import Cobertura from '../componentes/Cobertura.jsx';
import FiltroData from '../componentes/FiltroData.jsx';
import TabelaScroll from '../componentes/TabelaScroll.jsx';

const INICIO_PADRAO = '2026-06-05';

function Secao({ titulo, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: '1.05rem', color: 'var(--marinho)' }}>{titulo}</h2>
      {children}
    </section>
  );
}

export default function Adesao() {
  const [geral, setGeral] = useState(null);
  const [porFaixa, setPorFaixa] = useState(null);
  const [tentativas, setTentativas] = useState(null);
  const [retroativas, setRetroativas] = useState(null);
  const [erro, setErro] = useState(null);
  const [atalhoAtivo, setAtalhoAtivo] = useState('desde o início');
  const [intervalo, setIntervalo] = useState({ inicio: INICIO_PADRAO, fim: null });

  useEffect(() => {
    const { inicio, fim } = intervalo;
    Promise.all([
      api.adesao.geral(inicio, fim),
      api.adesao.porFaixaEtaria(inicio, fim),
      api.adesao.tentativas(inicio, fim),
      api.adesao.retroativas(inicio, fim)
    ]).then(([g, pf, t, r]) => { setGeral(g); setPorFaixa(pf); setTentativas(t); setRetroativas(r); })
      .catch(e => setErro(e.message));
  }, [intervalo]);

  if (erro) return <p style={{ color: 'var(--estado-alerta)' }}>{erro}</p>;

  return (
    <div>
      <Secao titulo="Geral, por status">
        <p style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)' }}>
          Acumulado desde 05/06/2026, corte em D-1 (todo registro já fechado). Exclui{' '}
          <code>pendente</code> (estado vivo) e <code>pausado</code> (interrupção, não desfecho).
          {geral && <> Fronteira do Ciclo 2: <strong>{geral.fronteiraCiclo}</strong> — o Ciclo 1 (teste
          fechado, núcleo familiar) nunca aparece aqui como referência ou meta.</>} Os filtros abaixo
          valem para as três visões desta página (geral, por faixa etária, e tentativas/retroativas).
        </p>
        <FiltroData
          inicioPadrao={INICIO_PADRAO}
          ativo={atalhoAtivo}
          onMudar={(inicio, fim, rotulo) => { setIntervalo({ inicio, fim }); setAtalhoAtivo(rotulo); }}
          onLimpar={() => { setIntervalo({ inicio: INICIO_PADRAO, fim: null }); setAtalhoAtivo('desde o início'); }}
        />
        {geral && (
          <>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
              {geral.status.map(s => (
                <Cartao key={s.status} titulo={s.status} valor={`${Math.round(s.percentual * 100)}%`} subtitulo={`${s.n} de ${geral.total}`} />
              ))}
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={geral.status}>
                <CartesianGrid stroke="var(--linha)" />
                <XAxis dataKey="status" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v, n, p) => [`${v} (${Math.round(p.payload.percentual * 100)}%)`, 'n']} />
                <Bar dataKey="n" fill="var(--verde-whatsapp)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </Secao>

      <Secao titulo="Status cruzado com faixa etária">
        <p style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)' }}>
          Distribuição percentual dentro de cada status, com a faixa dominante em destaque. Ciclo 1 —
          teste fechado, núcleo familiar — não é amostra de nada e nunca serve de baseline aqui.
        </p>
        {porFaixa && porFaixa.porStatus.map(bloco => (
          <div key={bloco.status} style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: '0.9rem', margin: '8px 0 4px' }}>
              {bloco.status} — faixa dominante: <strong>{bloco.faixaDominante || 'n/d'}</strong>
            </h3>
            <Cobertura cobertos={bloco.total - (bloco.faixas.find(f => f.faixa === 'nao_informado')?.n || 0)} total={bloco.total} />
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={bloco.faixas}>
                <CartesianGrid stroke="var(--linha)" />
                <XAxis dataKey="rotulo" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v, n, p) => [`${v} (${Math.round(p.payload.percentual * 100)}%)`, 'n']} />
                <Bar dataKey="n" fill="var(--marinho)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ))}
      </Secao>

      <Secao titulo="Tentativas e confirmação retroativa">
        <h3 style={{ fontSize: '0.9rem' }}>Painel A — confirmações por tentativa (exclui retroativas)</h3>
        {tentativas && (
          <>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={tentativas.porTentativa.map(t => ({ tentativa: `${t.tentativas}ª`, total: t.total, percentual: t.percentual }))}>
                <CartesianGrid stroke="var(--linha)" />
                <XAxis dataKey="tentativa" />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v, n, p) => [`${v} (${Math.round(p.payload.percentual * 100)}%)`, 'confirmações']} />
                <Bar dataKey="total" fill="var(--laranja)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <TabelaScroll style={{ maxWidth: 360 }}>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>tentativa</th><th>confirmações</th><th>% do total</th></tr></thead>
                <tbody>
                  {tentativas.porTentativa.map(t => (
                    <tr key={t.tentativas}>
                      <td>{t.tentativas}ª</td>
                      <td>{t.total}</td>
                      <td>{Math.round(t.percentual * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TabelaScroll>
          </>
        )}

        <h3 style={{ fontSize: '0.9rem', marginTop: 20 }}>Painel B — confirmações retroativas</h3>
        {retroativas && (
          <>
            <Cartao
              titulo="Confirmações retroativas"
              valor={`${Math.round(retroativas.percentual * 100)}%`}
              subtitulo={`${retroativas.totalRetroativas} de ${retroativas.totalConfirmados} confirmações do período`}
              estado="hipotese"
            />
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={retroativas.faixas} style={{ marginTop: 12 }}>
                <CartesianGrid stroke="var(--linha)" />
                <XAxis dataKey="rotulo" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v, n, p) => [`${v} (${Math.round(p.payload.percentual * 100)}% das retroativas)`, 'confirmações']} />
                <Bar dataKey="n" fill="var(--estado-hipotese)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <TabelaScroll style={{ maxWidth: 420 }}>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>faixa etária</th><th>confirmações retroativas</th><th>% das retroativas</th></tr></thead>
                <tbody>
                  {retroativas.faixas.map(f => (
                    <tr key={f.faixa}>
                      <td>{f.rotulo}</td>
                      <td>{f.n}</td>
                      <td>{Math.round(f.percentual * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TabelaScroll>
          </>
        )}
      </Secao>
    </div>
  );
}
