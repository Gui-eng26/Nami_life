import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import Login from './componentes/Login.jsx';
import Layout from './componentes/Layout.jsx';
import Tecnica from './paineis/Tecnica.jsx';
import Perfil from './paineis/Perfil.jsx';
import Medicamentos from './paineis/Medicamentos.jsx';
import Adesao from './paineis/Adesao.jsx';
import Feedback from './paineis/Feedback.jsx';

const PAINEIS = { tecnica: Tecnica, perfil: Perfil, medicamentos: Medicamentos, adesao: Adesao, feedback: Feedback };

export default function App() {
  const [sessao, setSessao] = useState(undefined); // undefined = carregando, null = sem sessão
  const [abaAtiva, setAbaAtiva] = useState('tecnica');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSessao(data.session));
    const { data: assinatura } = supabase.auth.onAuthStateChange((_evento, novaSessao) => setSessao(novaSessao));
    return () => assinatura.subscription.unsubscribe();
  }, []);

  if (sessao === undefined) return null;
  if (!sessao) return <Login />;

  const Painel = PAINEIS[abaAtiva];
  return (
    <Layout abaAtiva={abaAtiva} onMudarAba={setAbaAtiva}>
      <Painel />
    </Layout>
  );
}
