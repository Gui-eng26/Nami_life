// nami_slides_template.js — Template de apresentacao Nami Life
// Implementa a secao 5 do GUIDANCE_IDENTIDADE_VISUAL.md.
// Ponto unico de escrita para slides: tokens abaixo, nada hardcoded fora deles.

const pptxgen = require("pptxgenjs");

// ---------------------------------------------------------------- TOKENS
const T = {
  laranja:         "FC4C02",
  laranjaEscuro:   "C43C00",
  laranjaTint:     "FFEDE4",
  offWhite:        "F6FFFF",
  marinho:         "0F2B46",
  marinhoTint:     "E9F0F6",
  verdeWhats:      "128C7E",
  verdeTint:       "E7F5F1",
  texto:           "1A2430",
  textoSecundario: "5B6B7A",
  linha:           "D9E1E8",
  fundoSuave:      "F3F6F8",
  branco:          "FFFFFF",
  // estados epistemicos
  hipotese:        "A8710A",
  hipoteseTint:    "FDF3E0",
  alerta:          "A32A1E",
  alertaTint:      "FBECEC",
  decisao:         "0F7A5A",
  decisaoTint:     "E6F4EF",
};

const FONTE = "Arial";                 // tier Entrega (arquivo editavel compartilhado)
const M = 0.8;                         // margem lateral em polegadas
const W = 13.333, H = 7.5;             // LAYOUT_WIDE

const MARCA        = "nami_marca_solida.png";
const MARCA_BRANCA = "nami_marca_mono_branca.png";
const WORDMARK_BR  = "nami_wordmark_branco.png";

const ASSINATURA = "A solução é digital, mas o cuidado nunca foi tão humano.";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";           // ANTES de qualquer addSlide
pres.author = "Nami Life";
pres.title = "Template de apresentação — Nami Life";

// -------------------------------------------------------------- HELPERS
function fonteDoDado(slide, texto) {
  slide.addText(texto, {
    x: M, y: H - 0.62, w: W - 2 * M, h: 0.3,
    fontFace: FONTE, fontSize: 10, color: T.textoSecundario, margin: 0,
  });
}

function titulo(slide, texto, cor) {
  slide.addText(texto, {
    x: M, y: 0.62, w: W - 2 * M, h: 0.9,
    fontFace: FONTE, fontSize: 30, bold: true,
    color: cor || T.marinho, margin: 0, valign: "middle",
  });
}

function marcaDeRodape(slide, clara) {
  slide.addImage({
    path: clara ? MARCA_BRANCA : MARCA,
    x: W - M - 0.34, y: H - 0.72, w: 0.34, h: 0.34,
  });
}

// ============================================================ 1. ABERTURA
{
  const s = pres.addSlide();
  s.background = { color: T.offWhite };
  s.addImage({ path: MARCA, x: (W - 1.9) / 2, y: 1.45, w: 1.9, h: 1.9 });
  s.addText("TÍTULO DA APRESENTAÇÃO", {
    x: 1, y: 3.65, w: W - 2, h: 0.8, align: "center",
    fontFace: FONTE, fontSize: 40, bold: true, color: T.marinho, margin: 0,
  });
  s.addText("Adesão a tratamentos médicos por agente de IA no WhatsApp", {
    x: 1, y: 4.45, w: W - 2, h: 0.4, align: "center",
    fontFace: FONTE, fontSize: 16, color: T.textoSecundario, margin: 0,
  });
  s.addText(ASSINATURA, {
    x: 1, y: 5.35, w: W - 2, h: 0.4, align: "center",
    fontFace: FONTE, fontSize: 14, italic: true, color: T.laranjaEscuro, margin: 0,
  });
  s.addText("Guilherme — fundador   ·   agosto de 2026", {
    x: 1, y: 6.1, w: W - 2, h: 0.35, align: "center",
    fontFace: FONTE, fontSize: 12, color: T.textoSecundario, margin: 0,
  });
  s.addNotes("Slide de abertura. Trocar apenas o título e a data — marca, assinatura verbal e posições são fixas.");
}

// ==================================================== 2. VIRADA DE SEÇÃO
{
  const s = pres.addSlide();
  s.background = { color: T.marinho };
  s.addText("01", {
    x: M, y: 2.3, w: 3, h: 1.6,
    fontFace: FONTE, fontSize: 96, bold: true, color: T.laranja, margin: 0,
  });
  s.addText("O problema", {
    x: M, y: 3.9, w: W - 2 * M, h: 0.9,
    fontFace: FONTE, fontSize: 40, bold: true, color: T.branco, margin: 0,
  });
  s.addText("Por que metade dos pacientes crônicos não segue o tratamento", {
    x: M, y: 4.8, w: 8.5, h: 0.5,
    fontFace: FONTE, fontSize: 16, color: T.linha, margin: 0,
  });
  s.addImage({ path: WORDMARK_BR, x: W - M - 1.5, y: H - 0.95, w: 1.5, h: 0.223 });
  s.addNotes("Virada de seção. Fundo marinho, número em laranja. Usar entre blocos temáticos.");
}

// ============================================================== 3. DADO
{
  const s = pres.addSlide();
  s.background = { color: T.branco };
  titulo(s, "A não adesão é uma epidemia invisível");
  s.addText("50%", {
    x: M, y: 2.1, w: 5, h: 2,
    fontFace: FONTE, fontSize: 130, bold: true, color: T.laranja, margin: 0,
  });
  s.addText([
    { text: "dos pacientes com doenças crônicas\n", options: { breakLine: true } },
    { text: "não seguem corretamente as orientações médicas", options: { bold: true } },
  ], {
    x: 5.9, y: 2.55, w: W - M - 5.9, h: 1.4,
    fontFace: FONTE, fontSize: 20, color: T.texto, margin: 0, lineSpacingMultiple: 1.25,
  });
  s.addShape(pres.ShapeType.rect, {
    x: 5.9, y: 4.15, w: W - M - 5.9, h: 0.02, fill: { color: T.linha },
  });
  s.addText("É esse número que a Nami existe para mover.", {
    x: 5.9, y: 4.35, w: W - M - 5.9, h: 0.5,
    fontFace: FONTE, fontSize: 15, italic: true, color: T.laranjaEscuro, margin: 0,
  });
  fonteDoDado(s, "Fonte: OMS — dados mundiais. Dado verificado em fonte primária.");
  marcaDeRodape(s);
  s.addNotes("Slide de dado: UM número, uma linha de leitura, fonte no pé. Nunca dois números grandes no mesmo slide.");
}

// ========================================================== 4. CONTEÚDO
{
  const s = pres.addSlide();
  s.background = { color: T.branco };
  titulo(s, "O que a Nami faz hoje");
  const cards = [
    ["Recebe receitas", "Por texto, áudio ou foto. Monta o esquema de horários automaticamente."],
    ["Lembra na hora certa", "Lembrete determinístico no WhatsApp — o canal que o paciente já usa."],
    ["Alerta de recompra", "Acompanha o estoque e avisa antes do medicamento acabar."],
    ["Relatório de adesão", "Histórico de uso e conformidade, para o paciente e para o médico."],
  ];
  const cw = (W - 2 * M - 3 * 0.32) / 4;
  cards.forEach((c, i) => {
    const x = M + i * (cw + 0.32);
    s.addShape(pres.ShapeType.roundRect, {
      x, y: 2.05, w: cw, h: 3.05, rectRadius: 0.06,
      fill: { color: T.fundoSuave }, line: { color: T.linha, width: 0.75 },
    });
    s.addText(c[0], {
      x: x + 0.28, y: 2.38, w: cw - 0.56, h: 0.78,
      fontFace: FONTE, fontSize: 16, bold: true, color: T.laranjaEscuro, margin: 0,
      valign: "top",
    });
    s.addText(c[1], {
      x: x + 0.28, y: 3.28, w: cw - 0.56, h: 1.6,
      fontFace: FONTE, fontSize: 13, color: T.texto, margin: 0, lineSpacingMultiple: 1.2,
    });
  });
  s.addText("Tudo dentro do WhatsApp — sem instalar nenhum aplicativo novo.", {
    x: M, y: 5.5, w: W - 2 * M, h: 0.4,
    fontFace: FONTE, fontSize: 15, color: T.verdeWhats, bold: true, margin: 0,
  });
  marcaDeRodape(s);
  s.addNotes("Slide de conteúdo: no máximo 4 blocos. Se precisar de 5, são dois slides.");
}

// ============================================ 5. ESTADOS EPISTÊMICOS
{
  const s = pres.addSlide();
  s.background = { color: T.branco };
  titulo(s, "Como ler os números desta apresentação");
  const estados = [
    ["DADO VERIFICADO", "Número com fonte primária citada no pé do slide.", T.marinho, T.marinhoTint],
    ["HIPÓTESE", "Estimativa ou premissa ainda não validada em campo.", T.hipotese, T.hipoteseTint],
    ["LACUNA", "Dado que buscamos e não encontramos — registrado, não preenchido.", T.alerta, T.alertaTint],
    ["DECISÃO", "Escolha já tomada e registrada, com justificativa.", T.decisao, T.decisaoTint],
  ];
  estados.forEach((e, i) => {
    const y = 2.05 + i * 0.98;
    s.addShape(pres.ShapeType.roundRect, {
      x: M, y, w: W - 2 * M, h: 0.82, rectRadius: 0.05, fill: { color: e[3] },
    });
    s.addText(e[0], {
      x: M + 0.3, y: y + 0.06, w: 3.1, h: 0.7,
      fontFace: FONTE, fontSize: 14, bold: true, color: e[2], margin: 0, valign: "middle",
    });
    s.addText(e[1], {
      x: M + 3.5, y: y + 0.06, w: W - 2 * M - 3.8, h: 0.7,
      fontFace: FONTE, fontSize: 14, color: T.texto, margin: 0, valign: "middle",
    });
  });
  s.addText("A cor comunica o status do dado — nunca a sua importância.", {
    x: M, y: 6.15, w: W - 2 * M, h: 0.4,
    fontFace: FONTE, fontSize: 13, italic: true, color: T.textoSecundario, margin: 0,
  });
  marcaDeRodape(s);
  s.addNotes("Slide de convenção. Recomendado em qualquer apresentação com números — reproduz a disciplina de dados do projeto.");
}

// ============================================================ 6. GRÁFICO
{
  const s = pres.addSlide();
  s.background = { color: T.branco };
  titulo(s, "Diluição do custo por usuário conforme a base cresce");
  s.addChart(pres.ChartType.bar, [{
    name: "Custo total por usuário/mês (R$)",
    labels: ["100 usuários", "500", "1.000", "5.000", "10.000"],
    values: [24.5, 12.8, 11.2, 9.9, 9.54],
  }], {
    x: M, y: 1.85, w: W - 2 * M, h: 4.1,
    barDir: "col",
    chartColors: [T.laranja],
    showValue: true, dataLabelPosition: "outEnd",
    dataLabelFormatCode: 'R$ #,##0.00',
    dataLabelColor: T.texto, dataLabelFontFace: FONTE, dataLabelFontSize: 12,
    catAxisLabelColor: T.textoSecundario, catAxisLabelFontFace: FONTE, catAxisLabelFontSize: 12,
    valAxisLabelColor: T.textoSecundario, valAxisLabelFontFace: FONTE, valAxisLabelFontSize: 11,
    valGridLine: { color: T.linha, size: 0.5 },
    catGridLine: { style: "none" },
    showLegend: false,
  });
  fonteDoDado(s, "Hipótese de modelagem — derivada da estrutura de custos da Parte 5. Não é dado observado.");
  marcaDeRodape(s);
  s.addNotes("Gráficos: série principal em laranja, comparação em marinho, demais em cinza. Sem 3D, sem gradiente.");
}

// ================================================= 7. CITAÇÃO / PROMESSA
{
  const s = pres.addSlide();
  s.background = { color: T.laranjaTint };
  s.addText(
    "\u201CA Nami ajuda pessoas a nunca mais esquecerem de tomar seus remédios — " +
    "sem instalar nenhum aplicativo novo, direto no WhatsApp.\u201D", {
      x: 1.4, y: 2.3, w: W - 2.8, h: 2.2, align: "center",
      fontFace: FONTE, fontSize: 28, bold: true, color: T.marinho,
      margin: 0, lineSpacingMultiple: 1.3,
    });
  s.addText("Proposta de valor — Nami Life", {
    x: 1.4, y: 4.75, w: W - 2.8, h: 0.4, align: "center",
    fontFace: FONTE, fontSize: 14, color: T.laranjaEscuro, margin: 0,
  });
  s.addImage({ path: MARCA, x: (W - 0.75) / 2, y: 5.5, w: 0.75, h: 0.75 });
  s.addNotes("Único lugar onde o laranja aparece como fundo de slide inteiro. Reservado à promessa central.");
}

// ======================================================== 8. ENCERRAMENTO
{
  const s = pres.addSlide();
  s.background = { color: T.marinho };
  s.addImage({ path: MARCA, x: (W - 1.7) / 2, y: 1.9, w: 1.7, h: 1.7 });
  s.addText(ASSINATURA, {
    x: 1, y: 4.0, w: W - 2, h: 0.6, align: "center",
    fontFace: FONTE, fontSize: 22, italic: true, color: T.branco, margin: 0,
  });
  s.addText("Instagram: @namilifesaude", {
    x: 1, y: 5.0, w: W - 2, h: 0.4, align: "center",
    fontFace: FONTE, fontSize: 15, color: T.laranja, margin: 0,
  });
  s.addText("Obrigado.", {
    x: 1, y: 5.6, w: W - 2, h: 0.4, align: "center",
    fontFace: FONTE, fontSize: 14, color: T.linha, margin: 0,
  });
  s.addNotes("Encerramento. Mesma composição da abertura, invertida em fundo marinho.");
}

pres.writeFile({ fileName: "Nami_Template_Apresentacao_v1.pptx" })
  .then(() => console.log("Template gerado: Nami_Template_Apresentacao_v1.pptx"));
