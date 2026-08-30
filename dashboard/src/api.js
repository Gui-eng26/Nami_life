import { supabase } from './supabaseClient.js';

async function autenticado(caminho) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const resposta = await fetch(`/api${caminho}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!resposta.ok) {
    const corpo = await resposta.json().catch(() => ({}));
    throw new Error(corpo.erro || `Erro ${resposta.status} em ${caminho}`);
  }
  return resposta.json();
}

export const api = {
  tecnica: {
    degradacaoSerie: (dias) => autenticado(`/tecnica/degradacao/serie?dias=${dias ?? 30}`),
    degradacaoDetalhamento: (inicio, fim) => autenticado(`/tecnica/degradacao/detalhamento?${qs({ inicio, fim })}`),
    degradacaoLista: (params) => autenticado(`/tecnica/degradacao/lista?${qs(params)}`),
    agentes: (inicio, fim) => autenticado(`/tecnica/agentes?${qs({ inicio, fim })}`)
  },
  perfil: {
    total: () => autenticado('/perfil/total'),
    interacoes: () => autenticado('/perfil/interacoes'),
    inatividade: () => autenticado('/perfil/inatividade'),
    distribuicaoEtaria: () => autenticado('/perfil/distribuicao-etaria'),
    lgpdNaoAceito: () => autenticado('/perfil/lgpd-nao-aceito'),
    semMedicamento: () => autenticado('/perfil/sem-medicamento'),
    medicamentosPorUsuario: () => autenticado('/perfil/medicamentos-por-usuario'),
    horariosPorMedicamento: () => autenticado('/perfil/horarios-por-medicamento')
  },
  medicamentos: {
    total: () => autenticado('/medicamentos/total'),
    porForma: () => autenticado('/medicamentos/por-forma'),
    detalhado: (inicio, fim) => autenticado(`/medicamentos/detalhado?${qs({ inicio, fim })}`)
  },
  adesao: {
    geral: (inicio, fim) => autenticado(`/adesao/geral?${qs({ inicio, fim })}`),
    porFaixaEtaria: (inicio, fim) => autenticado(`/adesao/por-faixa-etaria?${qs({ inicio, fim })}`),
    tentativas: (inicio, fim) => autenticado(`/adesao/tentativas?${qs({ inicio, fim })}`),
    retroativas: (inicio, fim) => autenticado(`/adesao/retroativas?${qs({ inicio, fim })}`)
  },
  feedback: {
    espontaneo: (inicio, fim) => autenticado(`/feedback/espontaneo?${qs({ inicio, fim })}`),
    intencaoNaoSuportada: () => autenticado('/feedback/intencao-nao-suportada'),
    inventario: () => autenticado('/feedback/inventario')
  }
};

function qs(params = {}) {
  const filtrado = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return new URLSearchParams(filtrado).toString();
}
