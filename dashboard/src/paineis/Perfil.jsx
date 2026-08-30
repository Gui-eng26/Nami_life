import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api.js';
import Cartao from '../componentes/Cartao.jsx';
import Cobertura from '../componentes/Cobertura.jsx';

function Secao({ titulo, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: '1.05rem', color: 'var(--marinho)' }}>{titulo}</h2>
      {children}
    </section>
  );
}

export default function Perfil() {
  const [total, setTotal] = useState(null);
  const [interacoes, setInteracoes] = useState(null);
  const [inatividade, setInatividade] = useState(null);
  const [distribuicaoEtaria, setDistribuicaoEtaria] = useState(null);
  const [lgpd, setLgpd] = useState(null);
  const [semMedicamento, setSemMedicamento] = useState(null);
  const [medsPorUsuario, setMedsPorUsuario] = useState(null);
  const [horariosPorMed, setHorariosPorMed] = useState(null);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    Promise.all([
      api.perfil.total(), api.perfil.interacoes(), api.perfil.inatividade(),
      api.perfil.distribuicaoEtaria(), api.perfil.lgpdNaoAceito(), api.perfil.semMedicamento(),
      api.perfil.medicamentosPorUsuario(), api.perfil.horariosPorMedicamento()
    ]).then(([t, i, ina, de, l, sm, mpu, hpm]) => {
      setTotal(t); setInteracoes(i); setInatividade(ina); setDistribuicaoEtaria(de);
      setLgpd(l); setSemMedicamento(sm); setMedsPorUsuario(mpu); setHorariosPorMed(hpm);
    }).catch(e => setErro(e.message));
  }, []);

  if (erro) return <p style={{ color: 'var(--estado-alerta)' }}>{erro}</p>;

  return (
    <div>
      <Secao titulo="Total e crescimento">
        {total && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Cartao titulo="Usuários reais (base total)" valor={total.total} />
            <Cartao
              titulo="Novos nos últimos 7 dias"
              valor={total.novos_7d}
              subtitulo={`7 dias anteriores: ${total.novos_7d_anterior}`}
              estado={total.novos_7d < total.novos_7d_anterior ? 'alerta' : 'dado_verificado'}
            />
          </div>
        )}
      </Secao>

      <Secao titulo="Distribuição etária">
        {distribuicaoEtaria && (
          <>
            <Cobertura cobertos={distribuicaoEtaria.cobertura.cobertos} total={distribuicaoEtaria.cobertura.total} />
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={distribuicaoEtaria.faixas}>
                <CartesianGrid stroke="var(--linha)" />
                <XAxis dataKey="rotulo" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v, n, p) => [`${v} (${Math.round(p.payload.percentual * 100)}%)`, 'usuários']} />
                <Bar dataKey="n" fill="var(--marinho)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </Secao>

      <Secao titulo="Interações por usuário">
        {interacoes && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Cartao titulo="Mediana de turnos" valor={interacoes.mediana} />
            <Cartao titulo="Média de turnos" valor={interacoes.media.toFixed(1)} subtitulo="dominada por outliers — veja a mediana" />
            <Cartao titulo="Abaixo da mediana" valor={`${Math.round(interacoes.percentualAbaixoDaMediana * 100)}%`} subtitulo={`${interacoes.abaixoDaMediana} usuários`} />
            <Cartao titulo="Acima da mediana" valor={`${Math.round(interacoes.percentualAcimaDaMediana * 100)}%`} subtitulo={`${interacoes.acimaDaMediana} usuários`} />
          </div>
        )}
      </Secao>

      <Secao titulo="Inatividade (>7 dias sem interação)">
        {inatividade && (
          <>
            <Cobertura cobertos={inatividade.cobertura.cobertos} total={inatividade.cobertura.total} />
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={inatividade.faixas}>
                <CartesianGrid stroke="var(--linha)" />
                <XAxis dataKey="rotulo" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="usuarios" fill="var(--estado-hipotese)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </Secao>

      <Secao titulo="LGPD e cadastro de medicamento">
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {lgpd && <Cartao titulo="LGPD não aceito" valor={lgpd.total} estado={lgpd.total > 0 ? 'alerta' : 'dado_verificado'} />}
          {semMedicamento && <Cartao titulo="Cadastrou-se, sem medicamento" valor={semMedicamento.total} subtitulo="nenhum medicamento jamais cadastrado" />}
        </div>
      </Secao>

      <Secao titulo="Medicamentos por usuário">
        {medsPorUsuario && (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={medsPorUsuario.faixas}>
              <CartesianGrid stroke="var(--linha)" />
              <XAxis dataKey="faixa" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="usuarios" fill="var(--verde-whatsapp)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Secao>

      <Secao titulo="Horários por medicamento">
        {horariosPorMed && (
          <>
            <p style={{ fontSize: '0.85rem', color: 'var(--texto-secundario)' }}>
              Medicamentos ativos sem horário ativo (esperado 0):{' '}
              <strong style={{ color: horariosPorMed.medicamentosAtivosSemHorarioAtivo > 0 ? 'var(--estado-alerta)' : 'var(--estado-decisao)' }}>
                {horariosPorMed.medicamentosAtivosSemHorarioAtivo}
              </strong>
            </p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={horariosPorMed.faixas}>
                <CartesianGrid stroke="var(--linha)" />
                <XAxis dataKey="faixa" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="usuarios" fill="var(--laranja)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </Secao>
    </div>
  );
}
