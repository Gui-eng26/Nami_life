import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Cartao from '../componentes/Cartao.jsx';

function Secao({ titulo, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: '1.05rem', color: 'var(--marinho)' }}>{titulo}</h2>
      {children}
    </section>
  );
}

function Aviso({ texto }) {
  if (!texto) return null;
  return (
    <p style={{ background: 'var(--fundo-suave)', borderLeft: '3px solid var(--estado-hipotese)', padding: '8px 12px', fontSize: '0.85rem', color: 'var(--texto-secundario)' }}>
      {texto}
    </p>
  );
}

export default function Feedback() {
  const [espontaneo, setEspontaneo] = useState(null);
  const [naoSuportada, setNaoSuportada] = useState(null);
  const [inventario, setInventario] = useState(null);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    Promise.all([
      api.feedback.espontaneo(),
      api.feedback.intencaoNaoSuportada(),
      api.feedback.inventario()
    ]).then(([e, n, inv]) => { setEspontaneo(e); setNaoSuportada(n); setInventario(inv); })
      .catch(err => setErro(err.message));
  }, []);

  if (erro) return <p style={{ color: 'var(--estado-alerta)' }}>{erro}</p>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
      <Secao titulo="Corrente 1 — feedback espontâneo">
        {espontaneo && (
          <>
            <Aviso texto={espontaneo.aviso} />
            {espontaneo.feedbacks.map((f, i) => (
              <div key={i} style={{ background: 'white', borderRadius: 8, padding: 10, marginBottom: 8, boxShadow: 'var(--sombra)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--texto-secundario)' }}>
                  {f.categoria} · {f.origem} · faixa {f.faixa} · {new Date(f.created_at).toLocaleDateString('pt-BR')}
                </div>
                <div style={{ fontSize: '0.9rem' }}>{f.texto}</div>
              </div>
            ))}
          </>
        )}
      </Secao>

      <Secao titulo="Corrente 2 — intenção não suportada">
        {naoSuportada && (
          <>
            <Aviso texto={naoSuportada.aviso} />
            {naoSuportada.eventos.map((e, i) => (
              <div key={i} style={{ background: 'white', borderRadius: 8, padding: 10, marginBottom: 8, boxShadow: 'var(--sombra)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--texto-secundario)' }}>
                  faixa {e.faixa} · {new Date(e.created_at).toLocaleDateString('pt-BR')}
                </div>
                <div style={{ fontSize: '0.9rem' }}>{e.titulo}</div>
                {e.user_message && <div style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)', marginTop: 4 }}>"{e.user_message}"</div>}
              </div>
            ))}
          </>
        )}
      </Secao>

      <Secao titulo="Corrente 3 — o inventário">
        {inventario && (
          <>
            <Cartao titulo="O que a Nami faz">
              <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.85rem' }}>
                {inventario.capacidades.map(c => <li key={c.agente}>{c.titulo}</li>)}
              </ul>
            </Cartao>
            <div style={{ height: 12 }} />
            <Cartao titulo="O que a Nami ainda não faz">
              <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.85rem' }}>
                {inventario.naoSuportado.map(item => <li key={item}>{item}</li>)}
              </ul>
            </Cartao>
          </>
        )}
      </Secao>
    </div>
  );
}
