import { useState } from 'react';
import { supabase } from '../supabaseClient.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(false);

  async function entrar(e) {
    e.preventDefault();
    setErro(null);
    setCarregando(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
    setCarregando(false);
    if (error) setErro(error.message);
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={entrar} style={{
        background: 'white', padding: 32, borderRadius: 'var(--raio)', boxShadow: 'var(--sombra)',
        width: 320, display: 'flex', flexDirection: 'column', gap: 12
      }}>
        <img src="/wordmark-laranja.png" alt="Nami" style={{ height: 32, alignSelf: 'center', marginBottom: 8 }} />
        <h1 style={{ fontSize: '1.1rem', margin: 0, color: 'var(--marinho)', textAlign: 'center' }}>
          Dashboard — acesso restrito
        </h1>
        <input
          type="email" placeholder="e-mail" required value={email}
          onChange={e => setEmail(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid var(--linha)' }}
        />
        <input
          type="password" placeholder="senha" required value={senha}
          onChange={e => setSenha(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid var(--linha)' }}
        />
        {erro && <div style={{ color: 'var(--estado-alerta)', fontSize: '0.85rem' }}>{erro}</div>}
        <button type="submit" disabled={carregando} style={{
          padding: 10, borderRadius: 8, border: 'none', background: 'var(--laranja)',
          color: 'white', fontWeight: 600, cursor: 'pointer'
        }}>
          {carregando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
