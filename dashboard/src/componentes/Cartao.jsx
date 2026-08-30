// Cartão de indicador — carrega o estado epistêmico como cor do número (§11): a mesma
// disciplina do resto do projeto, aplicada ao dashboard. `estado` aceita
// dado_verificado | hipotese | alerta | decisao; default dado_verificado.
const CORES = {
  dado_verificado: 'var(--estado-dado-verificado)',
  hipotese: 'var(--estado-hipotese)',
  alerta: 'var(--estado-alerta)',
  decisao: 'var(--estado-decisao)'
};

export default function Cartao({ titulo, valor, subtitulo, estado = 'dado_verificado', children }) {
  return (
    <div style={{
      background: 'white', borderRadius: 'var(--raio)', boxShadow: 'var(--sombra)',
      padding: 16, minWidth: 180, flex: '1 1 200px'
    }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)', marginBottom: 6 }}>{titulo}</div>
      {valor !== undefined && (
        <div style={{ fontSize: '1.8rem', fontWeight: 700, color: CORES[estado] || CORES.dado_verificado }}>
          {valor}
        </div>
      )}
      {subtitulo && <div style={{ fontSize: '0.8rem', color: 'var(--texto-secundario)', marginTop: 4 }}>{subtitulo}</div>}
      {children}
    </div>
  );
}
