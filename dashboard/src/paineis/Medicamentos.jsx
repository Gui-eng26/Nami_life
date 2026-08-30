import { useEffect, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { api } from '../api.js';
import Cartao from '../componentes/Cartao.jsx';
import FiltroData, { intervaloOntem } from '../componentes/FiltroData.jsx';
import TabelaScroll from '../componentes/TabelaScroll.jsx';

const CORES = ['#FC4C02', '#0F2B46', '#128C7E', '#A8710A', '#5B6B7A', '#C43C00'];
const INICIO_PADRAO = '2026-06-05';

function Secao({ titulo, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: '1.05rem', color: 'var(--marinho)' }}>{titulo}</h2>
      {children}
    </section>
  );
}

export default function Medicamentos() {
  const [total, setTotal] = useState(null);
  const [porForma, setPorForma] = useState(null);
  const [detalhado, setDetalhado] = useState(null);
  const [erro, setErro] = useState(null);
  // "Ontem" como padrão, não "desde o início" — a lista cresce todo dia de beta (pedido
  // de Guilherme, v39).
  const [atalhoAtivo, setAtalhoAtivo] = useState('ontem');
  const [intervalo, setIntervalo] = useState(intervaloOntem);

  useEffect(() => {
    Promise.all([api.medicamentos.total(), api.medicamentos.porForma()])
      .then(([t, f]) => { setTotal(t); setPorForma(f); })
      .catch(e => setErro(e.message));
  }, []);

  useEffect(() => {
    api.medicamentos.detalhado(intervalo.inicio, intervalo.fim)
      .then(setDetalhado)
      .catch(e => setErro(e.message));
  }, [intervalo]);

  if (erro) return <p style={{ color: 'var(--estado-alerta)' }}>{erro}</p>;

  return (
    <div>
      <Secao titulo="Total e crescimento">
        {total && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Cartao titulo="Medicamentos ativos" valor={total.total} />
            <Cartao titulo="Novos nos últimos 7 dias" valor={total.novos_7d} subtitulo={`7 dias anteriores: ${total.novos_7d_anterior}`} />
          </div>
        )}
      </Secao>

      <Secao titulo="Por forma farmacêutica">
        <p style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)' }}>
          Normalizado importando <code>src/templates/dose.js</code> — funde variações de acento e
          sinônimos conhecidos (cápsula/capsula, colírio/gotas, xarope/líquido).
        </p>
        {porForma && (
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={porForma.formas} dataKey="n" nameKey="forma" outerRadius={90} label={({ forma, percentual }) => `${forma} (${Math.round(percentual * 100)}%)`}>
                {porForma.formas.map((f, i) => <Cell key={f.forma} fill={CORES[i % CORES.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        )}
      </Secao>

      <Secao titulo="Visão detalhada">
        <FiltroData
          inicioPadrao={INICIO_PADRAO}
          ativo={atalhoAtivo}
          onMudar={(inicio, fim, rotulo) => { setIntervalo({ inicio, fim }); setAtalhoAtivo(rotulo); }}
          onLimpar={() => { setIntervalo(intervaloOntem()); setAtalhoAtivo('ontem'); }}
        />
        {detalhado && (
          <TabelaScroll>
            <table>
              <thead><tr><th>cadastrado em</th><th>forma farmacêutica</th></tr></thead>
              <tbody>
                {detalhado.medicamentos.slice(0, 200).map((m, i) => (
                  <tr key={i}>
                    <td>{new Date(m.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
                    <td>{m.forma}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabelaScroll>
        )}
      </Secao>
    </div>
  );
}
