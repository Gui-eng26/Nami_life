# GUIDANCE DE IDENTIDADE VISUAL — NAMI LIFE

**Versão:** 1.1 · **Data:** 08/08/2026 · **Responsável:** Guilherme (fundador)
**Escopo:** relatórios, entregáveis, apresentações e documentos formais da Nami Life.
**Status:** contrato ativo. Vale para tudo que for produzido a partir desta data.

---

## 0. Por que este documento existe

Até aqui, cada relatório e cada apresentação da Nami foi montado com decisões visuais
tomadas isoladamente. O resultado é verificável: o entregável da Trilha 3 (07/08/2026)
foi produzido inteiramente em uma paleta **verde** (`#1E4D3E`, `#2E6B55`, `#1A2420`) —
sem uma única ocorrência do laranja da marca. Não havia erro de execução; havia ausência
de contrato.

Este guidance é esse contrato. Ele tem a mesma função que os princípios de arquitetura
têm no código da Nami: eliminar a classe inteira do problema, e não corrigir um caso
visível por vez.

**Três níveis de obrigatoriedade, sempre explícitos no texto:**

| Marcador | Significado |
|---|---|
| **[REGRA]** | Não negociável. Desvio precisa de decisão registrada. |
| **[PADRÃO]** | Default. Pode ser alterado com justificativa no próprio documento. |
| **[RECOMENDAÇÃO]** | Orientação de qualidade, sem obrigatoriedade. |

---

## 1. Fundamentos da marca

Fonte: branding kit oficial (`Drive › Nami_Life_Mescla › Logo Nami Life`).

### 1.1 Marca

A marca é um **disco laranja sólido com o wordmark `NAMI LIFE` em branco**, caixa alta,
sans-serif geométrico condensado, com o "A" estilizado como triângulo sólido sem travessa.

**Achado técnico (08/08/2026):** no arquivo original do kit, as letras `NAMI LIFE`
**não são brancas — são vazadas** (alpha zero). Sobre fundo branco isso funciona; sobre
fundo marinho ou colorido, o texto assume a cor do fundo e a marca se descaracteriza.
Por isso existe uma versão sólida, e ela é a que deve ser usada em slides.

**[REGRA]** Arquivos da marca e usos permitidos:

| Arquivo | Composição | Uso |
|---|---|---|
| `nami_marca_circular.png` | disco laranja, letras vazadas | mestre de origem · **apenas sobre fundo claro** |
| `nami_marca_solida.png` | disco laranja, letras brancas opacas | **padrão** — seguro sobre qualquer fundo |
| `nami_marca_mono_preta.png` | disco grafite, letras vazadas | impressão P&B, uma cor |
| `nami_marca_mono_branca.png` | disco branco, letras vazadas | sobre fundo marinho ou fotografia escura |
| `nami_wordmark_laranja.png` | só o wordmark, horizontal (1417×211) | **versão horizontal da marca** |
| `nami_wordmark_branco.png` | wordmark horizontal, branco | rodapé de slide escuro, assinatura |
| `nami_wordmark_marinho.png` | wordmark horizontal, marinho | documentos monocromáticos |
| `nami_marca_circular_900.png` / `_512.png` | reduções do mestre | capas de documento / cabeçalho, favicon, avatar |

Os wordmarks foram **extraídos do próprio logotipo** (a máscara alpha das letras), não
redesenhados: preservam os glifos originais em Blackpaper sem depender da fonte nem da
sua licença.

**[REGRA]** Não existe lockup "disco + NAMI LIFE ao lado". A marca circular **já contém
o nome** — repeti-lo ao lado é redundância tipográfica. Quando a proporção circular não
couber, use o wordmark isolado. Esta é a versão horizontal oficial.

**[REGRA]** Proibido: distorcer proporção, recolorir o disco, aplicar sombra ou contorno,
recortar o disco, colocar a marca sobre fundo laranja, ou reescrever "NAMI LIFE" em outra
fonte ao lado da marca (o wordmark já está dentro dela).

**[REGRA]** Área de proteção: margem livre igual a **25% do diâmetro** do disco em todos os
lados. Tamanho mínimo: **10 mm** impresso / **32 px** em tela.

**[PADRÃO]** Sobre fundo claro, usar a versão de fundo transparente. Sobre fundo escuro
(marinho), a mesma versão funciona — o disco laranja tem contraste suficiente.

### 1.2 Cores oficiais do kit

| Cor | HEX | RGB | CMYK |
|---|---|---|---|
| Laranja Nami (primária) | `#FC4C02` | 252, 76, 2 | 0, 69, 99, 1 |
| Off-white Nami (secundária) | `#F6FFFF` | 246, 255, 255 | 3, 0, 0, 0 |

---

## 2. Paleta Nami (tokens)

O kit oficial define duas cores. Duas cores não sustentam um relatório de 27 páginas com
tabelas, alertas e hipóteses. A paleta abaixo **estende** o kit sem substituí-lo: o laranja
continua sendo a cor da marca; o restante é infraestrutura de leitura.

**[REGRA]** Nenhuma cor fora desta tabela pode aparecer em documento da Nami.

### 2.1 Núcleo

| Token | HEX | Uso |
|---|---|---|
| `laranja` | `#FC4C02` | marca, filetes, barras de destaque, elementos gráficos grandes |
| `laranja_escuro` | `#C43C00` | **texto** em laranja (títulos H2, links, ênfase) |
| `laranja_tint` | `#FFEDE4` | fundo de bloco de destaque |
| `off_white` | `#F6FFFF` | fundo de peça gráfica e de slide |

**[REGRA]** `#FC4C02` **não é usado como cor de texto corrido nem em textos abaixo de 18 pt**.
Sobre branco ele atinge ~3,3:1 de contraste — abaixo do mínimo WCAG AA (4,5:1) para texto
normal. Para texto, use `laranja_escuro` (`#C43C00`, ~5,3:1). Isso não é preciosismo:
o público-alvo da Nami inclui pessoas idosas, e legibilidade é parte da proposta de valor.

### 2.2 Apoio (aprovado)

| Token | HEX | Uso |
|---|---|---|
| `marinho` | `#0F2B46` | títulos H1/H3, cabeçalho de tabela, dado verificado |
| `marinho_tint` | `#E9F0F6` | fundo de bloco informativo |
| `verde_whatsapp` | `#128C7E` | exclusivamente quando o assunto **é** o canal WhatsApp |
| `verde_tint` | `#E7F5F1` | fundo de bloco sobre o canal |

**[REGRA]** O verde WhatsApp é citação, não cor da Nami. Só aparece quando o conteúdo
trata do canal (print de conversa, diagrama de integração, slide "por que WhatsApp").
Nunca como cor decorativa. `#25D366` (verde claro oficial do WhatsApp) só em elementos
gráficos grandes; para texto, `#128C7E`.

### 2.3 Neutros

| Token | HEX | Uso |
|---|---|---|
| `texto` | `#1A2430` | corpo de texto |
| `texto_secundario` | `#5B6B7A` | legendas, notas de rodapé, metadados |
| `linha` | `#D9E1E8` | filetes de tabela e separadores |
| `fundo_suave` | `#F3F6F8` | zebra de tabela |
| `branco` | `#FFFFFF` | fundo de página de documento |

### 2.4 Estados epistêmicos — o diferencial da Nami

Este é o único bloco da paleta que **não** é decoração. A Nami já opera sob uma disciplina
declarada: *dado verificado, hipótese e lacuna são coisas diferentes e devem ser rotuladas
como tais*. O sistema visual passa a **codificar** essa distinção.

| Estado | Cor | Fundo | Quando usar |
|---|---|---|---|
| **Dado verificado** | `#0F2B46` marinho | `#E9F0F6` | número ou afirmação com fonte primária citada |
| **Hipótese** | `#A8710A` âmbar | `#FDF3E0` | estimativa, premissa, valor a validar |
| **Advertência / lacuna** | `#A32A1E` tijolo | `#FBECEC` | risco de leitura, dado ausente, comparação inválida |
| **Decisão** | `#0F7A5A` verde | `#E6F4EF` | escolha tomada e registrada |
| **Proposta de valor** | `#FC4C02` laranja | `#FFEDE4` | a promessa central da Nami, sempre igual |

**[REGRA]** A cor comunica **status epistêmico**, nunca importância ou estética.
Um dado verificado ruim continua marinho. Uma hipótese entusiasmante continua âmbar.

**[REGRA]** O laranja em corpo de texto fica reservado à proposta de valor. Isso preserva
seu peso: quem folheia o documento encontra a promessa da Nami sempre no mesmo tom.

---

## 3. Tipografia

### 3.1 Blackpaper — fonte do logotipo

A tipografia declarada no branding kit é **Blackpaper** (VPcreativeshop): display
geométrico, traço pesado, projetado para logotipos, títulos e sinalização.

**[REGRA]** Blackpaper é **fonte de logotipo**, não de documento. Não é usada em títulos
de relatório nem em corpo de texto. Motivos: (a) é uma display de peso único, ilegível em
texto corrido; (b) as versões gratuitas em circulação são *demo / personal use* — uso
comercial exige licença. Antes de usá-la em qualquer peça pública além do logo já
existente, confirmar a licença adquirida.

### 3.2 Dois tiers, com regra de decisão

**[REGRA]** A escolha da fonte depende de **quem renderiza o arquivo**:

| Tier | Quando | Títulos | Corpo |
|---|---|---|---|
| **Entrega** | arquivo editável que outra pessoa vai abrir (.docx, Google Docs, Slides compartilhado) | **Arial** | **Arial** |
| **Peça** | PDF/PNG que **nós** geramos e exportamos (pitch deck, one-pager, social) | **Poppins** SemiBold/Bold | **Inter** Regular/Medium |

Racional: a fidelidade de fonte só é garantida quando controlamos o renderizador. Arial
existe em Word, Google Docs, LibreOffice e impressão sem substituição. Poppins é a
geométrica gratuita mais próxima do desenho do wordmark — mas se o destinatário não a
tiver, o arquivo cai em Times New Roman e a identidade se perde inteira. A regra troca
"parecer melhor" por "parecer igual em todo lugar", que é o que identidade significa.

### 3.3 Escala tipográfica — documento (tier Entrega)

| Elemento | Tamanho | Peso | Cor |
|---|---|---|---|
| Título de capa | 26 pt | Bold | `marinho` |
| Subtítulo de capa | 12 pt | Regular | `texto_secundario` |
| Contexto de capa | 13 pt | Bold, caixa alta | `laranja_escuro` |
| H1 (seção) | 17 pt | Bold | `marinho` + filete laranja inferior |
| H2 | 13 pt | Bold | `laranja_escuro` |
| H3 | 11,5 pt | Bold | `marinho` |
| Corpo | 10,5 pt | Regular | `texto` |
| Tabela | 9,5 pt | Regular | `texto` |
| Nota / legenda | 8,5 pt | Regular ou itálico | `texto_secundario` |
| Cabeçalho e rodapé | 8,5–9 pt | — | `texto_secundario` |

**[REGRA]** Três níveis de título, no máximo. Se o conteúdo exige um quarto, o problema
é de estrutura, não de tipografia.

---

## 4. Padrão de RELATÓRIO (.docx)

### 4.1 Estrutura obrigatória

**[REGRA]** Todo relatório da Nami tem, nesta ordem:

1. **Capa** — marca, título, subtítulo, filete laranja, contexto, organização, autor, datas
2. **Sumário** — estático, sem números de página, com a legenda da convenção de cores
3. **Sobre este documento** — bloco de estado: fase do produto, convenção de dados, limitações
4. **Seções numeradas** — cada H1 começa em página nova
5. **Fontes e Referências** — última seção, sempre presente

### 4.2 Capa

```
        [ marca circular — altura 3,4 cm, centralizada ]

              TÍTULO DO DOCUMENTO          26 pt bold marinho
        descritor de uma linha do produto   12 pt cinza
    ─────────────── filete laranja ───────────────
          CONTEXTO / ENTREGÁVEL             13 pt bold laranja escuro, caixa alta
          Organização — Instituição         11 pt bold marinho
              Autor — papel                 10 pt cinza
        Entrega: dd/mm/aaaa · Evento: ...   10 pt cinza
```

**[REGRA]** Rodapé da capa: *"A solução é digital, mas o cuidado nunca foi tão humano."*
em `laranja_escuro`, itálico, 9 pt. É a assinatura verbal da marca, herdada do pitch.
**[REGRA]** A capa não leva cabeçalho nem numeração.

### 4.3 Cabeçalho e rodapé (demais páginas)

- **Cabeçalho:** marca 0,52 cm + `NAMI LIFE` (marinho, bold, 9 pt) + `·` + nome do
  documento (cinza, 9 pt), filete `linha` embaixo.
- **Rodapé:** `Nami Life · [PAGE] de [NUMPAGES]`, centralizado, 8,5 pt, com o número da
  página em `laranja_escuro` bold.

### 4.4 Hierarquia e paginação

- **[REGRA]** H1 leva filete laranja inferior (1,5 pt) e **quebra de página antes** —
  exceto o primeiro.
- **[REGRA]** Paginação é propriedade da hierarquia, não do teclado. Quebras de página
  manuais inseridas à mão antes de um H1 são removidas: elas produzem páginas em branco
  assim que o estilo muda. (No entregável da Trilha 3, 9 quebras redundantes foram
  removidas — o documento perdeu 1 página e ganhou 2 páginas de espaço útil.)

### 4.5 Tabelas

- **[REGRA]** Linha de cabeçalho: fundo `marinho`, texto branco bold, 9,5 pt.
- **[PADRÃO]** Zebra em `fundo_suave` nas linhas pares.
- **[PADRÃO]** Filetes horizontais em `linha`; sem filetes verticais internos.
- **[REGRA]** Toda tabela com número tem **coluna ou nota de fonte**. Sem fonte, o número
  é hipótese e precisa estar rotulado como tal.

### 4.6 Blocos de destaque (callouts)

**[REGRA]** Um callout é uma tabela de 1 célula com:
- **barra lateral esquerda de 1,5 pt** na cor do estado epistêmico
- **fundo** no tint do mesmo estado
- **sem nenhuma outra borda**
- primeira linha em negrito, na cor do estado, funcionando como rótulo

**[REGRA]** O estado é escolhido pelo conteúdo, não pelo gosto. Um bloco que começa com
"Advertência" ou "Lacuna registrada" é **tijolo**, mesmo que o texto seja tranquilizador.

### 4.7 Nomenclatura e versionamento

**[REGRA]** `Nami_<Assunto>_<Contexto>_v<N>.docx` — ex.: `Nami_Modelo_de_Negocio_Trilha3_Venture_v2.docx`.
Relatórios de sessão mantêm a convenção já em uso: `Nami_Relatorio_vN.docx`.
**[REGRA]** Versão nunca é sobrescrita. Um documento entregue é um fato histórico.

---

## 5. Padrão de APRESENTAÇÃO (slides)

### 5.1 Formato e grade

- **[REGRA]** 16:9 (1920×1080). **[PADRÃO]** margens de 80 px; grade de 12 colunas.
- **[PADRÃO]** Fundo `off_white` (`#F6FFFF`) ou branco. Fundo `marinho` reservado a
  slides de virada de seção e ao slide de encerramento.

### 5.2 Tipos de slide

| Tipo | Composição |
|---|---|
| **Abertura** | marca grande centralizada, título, assinatura verbal, data |
| **Virada de seção** | fundo marinho, número da seção em laranja, título em branco |
| **Dado** | um número gigante (laranja, 120–200 px) + uma linha de leitura + fonte no pé |
| **Conteúdo** | título + até 4 blocos; nunca mais de 4 |
| **Citação / promessa** | fundo `laranja_tint` de borda a borda, texto marinho centralizado, marca abaixo |
| **Encerramento** | marca, assinatura verbal, contato |

### 5.3 Regras de slide

- **[REGRA]** Um slide, uma ideia. Se precisa de duas frases para explicar o título,
  são dois slides.
- **[REGRA]** Todo número em slide leva **fonte no rodapé do próprio slide**, 12–14 px,
  `texto_secundario`. Sem exceção — foi assim no pitch do Mescla e continua sendo.
- **[REGRA]** Estados epistêmicos valem em slide: hipótese exibida como dado é erro de
  conteúdo, não de design. Marcar com o âmbar ou com a palavra "hipótese" no rótulo.
- **[PADRÃO]** Gráficos: série principal em `laranja`, comparação em `marinho`, demais em
  cinzas de `texto_secundario`. Sem gradiente, sem 3D, sem sombra.
- **[REGRA]** **Sem faixas, filetes ou barras decorativas em slide** — nem linha sob o
  título, nem tarja lateral, nem borda colorida em um único lado de card. Para separar um
  bloco, use fundo em tint e cantos arredondados. (O filete laranja existe **apenas** em
  documento, sob o H1, onde cumpre função de navegação — em slide vira ruído.)
- **[REGRA]** Blocos de conteúdo em card: fundo `fundo_suave`, borda `linha` de 0,75 pt,
  raio 0,06". Título do card com **altura fixa**, para que os corpos alinhem mesmo quando
  um título quebra em duas linhas.
- **[REGRA]** Rótulo de valor em gráfico monetário usa formato explícito
  (`R$ #,##0.00`). Sem isso, R$ 9,54 é exibido como "10" — e um número de unit economics
  arredondado deixa de ser o número.
- **[RECOMENDAÇÃO]** Máximo de 3 cores por slide, incluindo o texto.

---

## 6. Aplicação técnica

### 6.1 `nami_identidade.py` — ponto único de escrita

O guidance é aplicado por código, não por memória. O módulo `nami_identidade.py`
implementa o padrão de documento e é a **única** origem autorizada de cor, fonte e
espaçamento — mesmo princípio de `registrarMovimentoEstoque` e `registrarFeedback`
no produto: uma função por domínio, nunca contornada.

```bash
python nami_identidade.py entrada.docx saida.docx \
  --titulo "MODELO DE NEGÓCIO" \
  --subtitulo "Adesão a tratamentos médicos por agente de IA no WhatsApp" \
  --contexto "Entregável da Trilha 3 — Venture" \
  --org "Mescla Empreende — PUC Campinas" \
  --autor "Guilherme — fundador" \
  --data "Entrega: 07/08/2026 · Apresentação: 10/08/2026" \
  --rodape "Modelo de Negócio — Trilha 3 Venture"
```

O módulo opera em duas camadas:

1. **Remapeamento determinístico de tokens** no `document.xml` — troca pigmento
   preservando 100% do conteúdo e da semântica existente. Emite relatório de auditoria
   com a contagem de cada substituição.
2. **Composição estrutural** via `python-docx` — capa, sumário, cabeçalho, rodapé,
   hierarquia, callouts, normalização de paginação.

**[REGRA]** Nenhum relatório da Nami é entregue sem passar pelo módulo.
**[REGRA]** Mudou a identidade? Muda em `TOKENS`, e só ali.

### 6.1-b `nami_slides_template.js` — template de apresentação

Implementa a seção 5 e entrega os oito masters prontos em
`Nami_Template_Apresentacao_v1.pptx`: abertura, virada de seção, dado, conteúdo em cards,
convenção de estados epistêmicos, gráfico, citação e encerramento. Cada slide traz nota
do apresentador explicando o que pode e o que não pode ser alterado.

```bash
node nami_slides_template.js     # regenera o template a partir dos tokens
```

**[PADRÃO]** Apresentações novas partem deste arquivo. Alterar o template é alterar o
`.js` e regerar — não editar o `.pptx` e salvar por cima.

### 6.2 Onde os arquivos vivem

**[REGRA]** Os assets de marca passam a viver no repositório, não apenas no Drive:

```
Gui-eng26/Nami_life/
├── docs/
│   └── GUIDANCE_IDENTIDADE_VISUAL.md      ← este documento
└── assets/
    ├── brand/
    │   ├── nami_marca_circular.png        ← mestre (letras vazadas)
    │   ├── nami_marca_solida.png          ← padrão de uso
    │   ├── nami_marca_mono_preta.png
    │   ├── nami_marca_mono_branca.png
    │   ├── nami_wordmark_laranja.png      ← versão horizontal
    │   ├── nami_wordmark_branco.png
    │   ├── nami_wordmark_marinho.png
    │   ├── nami_marca_circular_900.png
    │   └── nami_marca_circular_512.png
    └── templates/
        ├── nami_identidade.py             ← documentos
        └── nami_slides_template.js        ← apresentações
```

Racional: o Drive é o arquivo de entrega; o repositório é o que a automação alcança.
Com os assets versionados no Git, qualquer sessão futura os obtém por
`raw.githubusercontent.com` sem depender de download manual. O Drive continua sendo a
origem editorial da marca — o repositório é a cópia operacional.

---

## 7. Checklist de publicação

Antes de enviar qualquer relatório ou apresentação da Nami:

- [ ] Passou por `nami_identidade.py` (ou pelo template de slides)
- [ ] Marca na capa, com área de proteção respeitada
- [ ] Nenhuma cor fora da paleta da seção 2
- [ ] Laranja em texto apenas como `#C43C00`, e apenas na proposta de valor
- [ ] Todo número tem fonte citada, ou está rotulado como hipótese
- [ ] Callouts com o estado epistêmico correto
- [ ] Sumário coerente com as seções
- [ ] Cabeçalho e rodapé presentes em todas as páginas exceto a capa
- [ ] Nome do arquivo na convenção, versão não sobrescrita
- [ ] Nenhuma página em branco ao final da renderização em PDF

---

## 8. Lacunas registradas

Registradas como lacuna, não preenchidas por suposição:

| Lacuna | Situação | Encaminhamento |
|---|---|---|
| Versão horizontal da marca | **Resolvida (v1.1)** — wordmark extraído do próprio logo | — |
| Versão monocromática / negativa | **Resolvida (v1.1)** — mono preta, mono branca e marca sólida | — |
| Template `.pptx` com os masters da seção 5 | **Resolvida (v1.1)** — `Nami_Template_Apresentacao_v1.pptx` | — |
| **Licença do Blackpaper** | **Aberta** — não confirmada | verificar a compra no fornecedor (VPcreativeshop). O logotipo já produzido segue válido; a fonte não pode ser reutilizada em peça nova sem licença comercial |
| Marca em vetor (SVG/AI) | **Aberta** — só existem rasterizações | o mestre PNG tem 1793 px, suficiente até ~15 cm impresso a 300 dpi. Acima disso, exige revetorização |
| Paleta para dashboard/produto (interface web) | **Aberta** — fora de escopo hoje | abrir quando o dashboard admin (MH-9) entrar em prioridade |
| Assets versionados no repositório | **Aberta** — hoje só no Drive | briefing `BRIEFING_IDENTIDADE_VISUAL.md` |

---

## 9. Histórico

| Versão | Data | Mudança |
|---|---|---|
| 1.0 | 08/08/2026 | Criação. Paleta, tipografia, padrão de relatório e de apresentação, estados epistêmicos, módulo `nami_identidade.py`. Aplicado retroativamente ao entregável da Trilha 3 (v2). |
| 1.1 | 08/08/2026 | Variantes da marca (sólida, monocromáticas, wordmark horizontal) derivadas do mestre. Template `.pptx` com 8 masters. Regra contra faixas decorativas em slide. Achado das letras vazadas documentado. |
