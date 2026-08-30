import { supabase } from '../supabaseClient.js';

const ABAS = [
  { chave: 'tecnica', rotulo: 'Técnica' },
  { chave: 'perfil', rotulo: 'Perfil' },
  { chave: 'medicamentos', rotulo: 'Medicamentos' },
  { chave: 'adesao', rotulo: 'Adesão' },
  { chave: 'feedback', rotulo: 'Feedback' }
];

export default function Layout({ abaAtiva, onMudarAba, children }) {
  return (
    <div>
      <header style={{
        background: 'var(--marinho)', color: 'white', padding: '10px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/wordmark-branco.png" alt="Nami" style={{ height: 22 }} />
          <span style={{ opacity: 0.8, fontSize: '0.85rem' }}>Dashboard — Ciclo 2 (leitura)</span>
        </div>
        <button
          onClick={() => supabase.auth.signOut()}
          style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.4)', color: 'white', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
        >
          Sair
        </button>
      </header>

      <nav style={{ display: 'flex', gap: 4, background: 'white', borderBottom: '1px solid var(--linha)', padding: '0 20px', overflowX: 'auto' }}>
        {ABAS.map(aba => (
          <button
            key={aba.chave}
            onClick={() => onMudarAba(aba.chave)}
            style={{
              padding: '12px 16px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontWeight: abaAtiva === aba.chave ? 700 : 400,
              color: abaAtiva === aba.chave ? 'var(--laranja-escuro)' : 'var(--texto-secundario)',
              borderBottom: abaAtiva === aba.chave ? '3px solid var(--laranja)' : '3px solid transparent',
              whiteSpace: 'nowrap'
            }}
          >
            {aba.rotulo}
          </button>
        ))}
      </nav>

      <main style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>
        {children}
      </main>
    </div>
  );
}
