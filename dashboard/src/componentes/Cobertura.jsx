// §4.4 — todo gráfico ou cruzamento por idade mostra, ao lado, a cobertura: "12 de 50
// usuários (24%)". Sem isso, um gráfico feito com um quarto da base se lê como se
// descrevesse a base inteira.
export default function Cobertura({ cobertos, total }) {
  const percentual = total ? Math.round((cobertos / total) * 100) : 0;
  const baixa = total > 0 && cobertos / total < 0.6;
  return (
    <span style={{ fontSize: '0.78rem', color: baixa ? 'var(--estado-hipotese)' : 'var(--texto-secundario)' }}>
      cobertura de idade: {cobertos} de {total} ({percentual}%)
      {baixa && ' — amostra pequena'}
    </span>
  );
}
