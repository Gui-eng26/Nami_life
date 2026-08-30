import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { api } from '../api.js';
import FiltroData, { intervaloOntem } from '../componentes/FiltroData.jsx';
import TabelaScroll from '../componentes/TabelaScroll.jsx';

const INICIO_DEGRADACAO = '2026-08-01';

function Secao({ titulo, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: '1.05rem', color: 'var(--marinho)' }}>{titulo}</h2>
      {children}
    </section>
  );
}

function Select({ rotulo, valor, opcoes, onChange }) {
  return (
    <label style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)', display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rotulo}
      <select value={valor} onChange={e => onChange(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--linha)' }}>
        <option value="">todos</option>
        {opcoes.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

// §6.1 — pivota a série (dia, tipo, n) para um formato por-dia com duas colunas, nunca
// somadas: erro_tecnico e desvio_comportamental são séries distintas.
function pivotarSerie(serie) {
  const porDia = new Map();
  for (const linha of serie) {
    if (!porDia.has(linha.dia)) porDia.set(linha.dia, { dia: linha.dia, erro_tecnico: 0, desvio_comportamental: 0 });
    porDia.get(linha.dia)[linha.tipo] = Number(linha.n);
  }
  return [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia));
}

// "Ontem" como padrão, não "desde o início" — numa lista que cresce todo dia de beta,
// nascer mostrando tudo deixa a página densa demais (pedido de Guilherme, v39).
function filtrosPadrao() {
  return { ...intervaloOntem(), tipo: '', severidade: '', origem: '' };
}

export default function Tecnica() {
  const [serie, setSerie] = useState(null);
  const [detalhamento, setDetalhamento] = useState(null);
  const [lista, setLista] = useState(null);
  const [agentes, setAgentes] = useState(null);
  const [erro, setErro] = useState(null);
  const [atalhoAtivo, setAtalhoAtivo] = useState('ontem');
  const [filtros, setFiltros] = useState(filtrosPadrao);

  useEffect(() => {
    Promise.all([
      api.tecnica.degradacaoSerie(30),
      api.tecnica.degradacaoDetalhamento(),
      api.tecnica.agentes()
    ]).then(([s, d, a]) => {
      setSerie(s.serie); setDetalhamento(d); setAgentes(a);
    }).catch(e => setErro(e.message));
  }, []);

  useEffect(() => {
    api.tecnica.degradacaoLista(filtros).then(setLista).catch(e => setErro(e.message));
  }, [filtros]);

  if (erro) return <p style={{ color: 'var(--estado-alerta)' }}>{erro}</p>;

  return (
    <div>
      <Secao titulo="Sinais de degradação (últimos 30 dias)">
        <p style={{ fontSize: '0.85rem', color: 'var(--texto-secundario)' }}>
          Renomeado de "erros": <code>desvio_comportamental</code> é auditoria de qualidade do Juiz
          Offline, não falha de execução. As duas séries nunca são somadas.
          {detalhamento && (
            <> — {detalhamento.contagemTeste.de_conta_teste} de {detalhamento.contagemTeste.total} eventos no
            período vieram de conta de teste (este painel não filtra por design, §4.1).</>
          )}
        </p>
        {serie && (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={pivotarSerie(serie)}>
              <CartesianGrid stroke="var(--linha)" />
              <XAxis dataKey="dia" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="erro_tecnico" name="erro técnico" stroke="#D62728" strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="desvio_comportamental" name="desvio comportamental" stroke="var(--marinho)" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}

        <h3 style={{ fontSize: '0.9rem', color: 'var(--texto-secundario)' }}>Detalhamento por tipo, severidade e origem</h3>
        {detalhamento && (
          <TabelaScroll>
            <table>
              <thead><tr><th>tipo</th><th>severidade</th><th>origem</th><th>n</th></tr></thead>
              <tbody>
                {detalhamento.detalhamento.map((l, i) => (
                  <tr key={i}><td>{l.tipo}</td><td>{l.severidade}</td><td>{l.origem}</td><td>{l.n}</td></tr>
                ))}
              </tbody>
            </table>
          </TabelaScroll>
        )}

        <h3 style={{ fontSize: '0.9rem', color: 'var(--texto-secundario)', marginTop: 20 }}>Visão detalhada — busca</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)' }}>
          Filtre por período, tipo, severidade e origem — a lista cresce a cada dia de beta, então
          por padrão ela só mostra desde 01/08. Amplie o período ou os filtros conforme precisar.
        </p>
        <FiltroData
          inicioPadrao={INICIO_DEGRADACAO}
          ativo={atalhoAtivo}
          onMudar={(inicio, fim, rotulo) => { setFiltros(f => ({ ...f, inicio, fim })); setAtalhoAtivo(rotulo); }}
          onLimpar={() => { setFiltros(filtrosPadrao()); setAtalhoAtivo('ontem'); }}
        />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <Select rotulo="tipo" valor={filtros.tipo} opcoes={['erro_tecnico', 'desvio_comportamental']}
            onChange={v => setFiltros(f => ({ ...f, tipo: v }))} />
          <Select rotulo="severidade" valor={filtros.severidade} opcoes={['baixa', 'media', 'alta', 'critica']}
            onChange={v => setFiltros(f => ({ ...f, severidade: v }))} />
          <Select rotulo="origem" valor={filtros.origem} opcoes={['catch_global', 'classificador_central', 'juiz_offline', 'scheduler', 'outro']}
            onChange={v => setFiltros(f => ({ ...f, origem: v }))} />
        </div>
        {lista && (
          <>
            <p style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)' }}>{lista.total} evento(s) encontrado(s)</p>
            <TabelaScroll>
              <table>
                <thead><tr><th>data/hora (Brasília)</th><th>tipo</th><th>severidade</th><th>origem</th><th>título</th><th>agente</th><th>triagem</th></tr></thead>
                <tbody>
                  {lista.eventos.slice(0, 200).map((e, i) => (
                    <tr key={i}>
                      <td>{new Date(e.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
                      <td>{e.tipo}</td><td>{e.severidade}</td><td>{e.origem}</td><td>{e.titulo}</td><td>{e.agent}</td><td>{e.status_triagem}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TabelaScroll>
          </>
        )}
      </Secao>

      <Secao titulo="Agentes acionados">
        <p style={{ fontSize: '0.85rem', color: 'var(--texto-secundario)' }}>
          Mede o que o usuário solicita ativamente — filtrado a <code>is_teste = false</code>.
          {agentes && (() => {
            const principal = agentes.proporcaoTeste.find(p => p.agent === 'configuracao') || agentes.proporcaoTeste[0];
            return principal ? <> Sem esse filtro, {principal.agent} teria {Math.round(100 * principal.de_conta_teste / principal.total)}% de turnos de conta de teste.</> : null;
          })()}
        </p>
        {agentes && (
          <>
            <h3 style={{ fontSize: '0.9rem', color: 'var(--texto-secundario)' }}>Capacidades acionáveis (ranking)</h3>
            {(() => {
              const totalAcionamentos = agentes.ranking.reduce((acc, a) => acc + Number(a.acionamentos), 0);
              const comPercentual = agentes.ranking.map(a => ({ ...a, percentual: totalAcionamentos ? a.acionamentos / totalAcionamentos : 0 }));
              return (
                <>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={comPercentual}>
                      <CartesianGrid stroke="var(--linha)" />
                      <XAxis dataKey="agent" tick={{ fontSize: 12 }} />
                      <YAxis allowDecimals={false} />
                      <Tooltip formatter={(v, n, p) => [`${v} (${Math.round(p.payload.percentual * 100)}%)`, 'acionamentos']} />
                      <Bar dataKey="acionamentos" fill="var(--laranja)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <TabelaScroll style={{ maxWidth: 420 }}>
                    <table style={{ marginTop: 8 }}>
                      <thead><tr><th>agente</th><th>acionamentos</th><th>% do total</th></tr></thead>
                      <tbody>
                        {comPercentual.map(a => (
                          <tr key={a.agent}>
                            <td>{a.agent}</td>
                            <td>{a.acionamentos}</td>
                            <td>{Math.round(a.percentual * 100)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TabelaScroll>
                </>
              );
            })()}
          </>
        )}
      </Secao>
    </div>
  );
}
