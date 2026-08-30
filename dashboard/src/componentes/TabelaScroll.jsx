// Envelope de rolagem horizontal para tabelas largas — sem isso, uma tabela com muitas
// colunas (ex: visão detalhada de degradação) força a PÁGINA INTEIRA a rolar de lado
// (achado testando o dashboard, v39). A rolagem fica contida na tabela, nunca na página.
export default function TabelaScroll({ children, style }) {
  return <div style={{ overflowX: 'auto', ...style }}>{children}</div>;
}
