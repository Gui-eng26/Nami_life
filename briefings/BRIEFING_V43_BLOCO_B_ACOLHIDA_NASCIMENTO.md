# BRIEFING — v43 Bloco B: acolhida enxuta + data de nascimento em um turno (MH-091, MH-092)

**Sessão:** v43 (17/09/2026)
**Branch:** `staging`
**Arquivos:** `src/agentes/recepcionista.js`, `src/agentes/data_nascimento.js`,
`src/dataNascimento.js`, `src/agentes/cadastro.js` (uma linha de texto)
**Independente do Bloco A** — pode ser implementado em paralelo ou depois, sem conflito de arquivo.

Auto-contido. Todo texto literal está embutido.

---

## 0. Evidência e causa raiz

**Funil do Ciclo 2 (09/09, base real):** 19 chegaram → 10 deram nome e aceitaram a LGPD → 9
completaram a data de nascimento → 6 cadastraram um medicamento. **9 dos 19 sumiram tendo visto
só o texto de acolhida.**

**Jornada real hoje, do "Oi" ao primeiro medicamento:** cerca de 15 turnos, sendo 7 só de
onboarding, antes de a pessoa receber qualquer valor.

**Causa raiz da acolhida (MH-091):** a primeira mensagem acumula quatro coisas — reação à
mensagem inicial, apresentação, capacidades e um parágrafo inteiro avisando que a Nami está em
desenvolvimento — e só então pede o nome. É a mensagem com maior perda isolada do funil e a
mais longa da jornada.

**Causa raiz da data de nascimento (MH-092) — achado da v43, corrige entendimento anterior:**
o piso de 4 turnos **não é da máquina de estados**. `src/dataNascimento.js` já extrai
`data_completa` (`06/11/1989`, `6-11-1989`, `6.11.1989`, "6 de novembro de 1989"), e
`data_nascimento.js` já salta direto para a confirmação quando isso acontece. O que força os 4
turnos é a **pergunta**: a etapa inicial é `nasc_dia`, pede só o dia, e a regra 3 do prompt
proíbe explicitamente mostrar exemplo de data completa quando o campo pendente é isolado.

Ou seja: **MH-092 não depende do runner da Fase 7.** É pergunta nova + uma etapa nova + suporte
a ano de 2 dígitos.

---

## 1. Jornada alvo

| # | Nami | Usuário |
|---|---|---|
| 1 | acolhida curta + pede o nome | Guilherme |
| 2 | LGPD | Sim |
| 3 | agradece + pede a data de nascimento **completa**, com exemplo | 06/11/89 |
| 4 | anotei + pede o primeiro remédio | … |

O aviso de que a Nami está em desenvolvimento sai da mensagem 1 e passa para o fechamento do
primeiro cadastro.

---

## 2. Acolhida enxuta (MH-091) — `src/agentes/recepcionista.js`

### 2.1 Bloco `recep_boas_vindas`, ramo padrão

Em `buildSystemPrompt`, o último `else` de `boasVindasTexto` (o que começa com "Você está
respondendo à PRIMEIRA mensagem que este usuário enviou para a Nami") passa a ser exatamente:

```
  Você está respondendo à PRIMEIRA mensagem que este usuário enviou para a Nami.
  Essa mensagem está em mensagem_inicial. Leia-a com atenção ANTES de responder.

  Esta mensagem tem NO MÁXIMO 3 linhas curtas. É a mensagem que mais perde usuário em
  toda a jornada — cada linha a mais custa. NÃO liste capacidades, NÃO explique como
  você funciona, NÃO conte seu histórico.

  Se a intenção inicial for CADASTRAR (a pessoa mencionou remédio, posologia, horário
  ou tratamento):
    Mostre que você OUVIU, citando o remédio ou a situação que ela trouxe, e peça o nome.
    Exemplo: "Oi! Vi que você toma nimesulida de 12 em 12 horas — posso te ajudar a
    organizar isso. 💊 Como posso te chamar?"

  Se a intenção inicial for NEUTRO (saudação sem contexto):
    Apresente-se em uma frase, diga o que você faz em uma frase, peça o nome.
    Exemplo: "Oi! 😊 Sou a Nami. Eu te lembro dos seus remédios na hora certa, aqui mesmo
    no WhatsApp — sem instalar nada. Como posso te chamar?"

  Em todos os casos: termine pedindo o nome.
  NÃO mencione LGPD, dados ou consentimento neste momento.
  NÃO mencione que está em desenvolvimento, em construção, aprendendo, em teste ou em
  evolução — esse aviso foi movido para o fim do primeiro cadastro.
  NUNCA use a expressão "teste beta".
```

Os exemplos são **exemplos para a LLM**, não frases fixas. O que está sendo fixado é o tamanho
e o conteúdo do turno.

### 2.2 Bloco `recep_apresentacao` — manter o aviso

O caminho do curioso (`recep_apresentacao`) é outra conversa: quem pergunta "o que você faz?"
está pedindo explicação, e ali o aviso de desenvolvimento faz sentido. **Não alterar esse bloco.**

---

## 3. Aviso "ainda estou sendo construída" no fim do cadastro — `src/agentes/cadastro.js`

No prompt da etapa de fechamento do cadastro (`cad_confirmacao`, o texto que a Nami envia
depois de o medicamento estar registrado e confirmado), acrescentar ao final das instruções:

```
  Se este for o PRIMEIRO medicamento cadastrado por esta pessoa, acrescente ao final, em
  UMA linha curta e leve, que você ainda está sendo construída e melhorando a cada dia, e
  que por isso pode escorregar de vez em quando. NUNCA use a expressão "teste beta".
  Exemplo: "Ah, e uma coisinha: eu ainda estou sendo construída e melhorando a cada dia —
  se eu escorregar em algo, me avisa? 😊"
  Se NÃO for o primeiro medicamento, não mencione isso.
```

Para saber se é o primeiro, usar a contagem de medicamentos ativos do usuário que o agente já
tem em contexto no fechamento. Se essa contagem não estiver disponível no ponto do prompt,
**não inventar consulta nova**: passar a informação como flag booleana no `contextParaPrompt`
a partir do dado já lido no fluxo.

---

## 4. Data de nascimento em um turno (MH-092)

### 4.1 `src/agentes/recepcionista.js` — ramo de aceite da LGPD

No bloco `recep_lgpd`, ramo `classificacao_lgpd === 'aceite'`, o texto que hoje manda terminar
perguntando o DIA passa a ser:

```
  O usuário ACEITOU o consentimento.
    Agradeça o aceite em UMA frase curta e peça a DATA DE NASCIMENTO COMPLETA, com exemplo
    obrigatório de formato. No máximo 2 linhas, uma mensagem só.
    Exemplo: "Obrigada, {nome}! 😊 Qual é a sua data de nascimento? Pode mandar completa —
    por exemplo: 06/11/1989"
    NÃO peça dia, mês e ano separadamente. NÃO vá para o cadastro de medicamento.
```

O estado gravado ao final desse turno passa a ter `context.etapa = 'nasc_data'` (etapa nova,
seção 4.3), não mais `nasc_dia`.

### 4.2 `src/dataNascimento.js` — ano de 2 dígitos

Decisão de Guilherme (v43): aceitar `06/11/89`, formato muito comum. Ganho de fluidez maior que
o risco de data errada, **com a salvaguarda da seção 4.4**.

**Nova função exportada:**

```js
// Expande ano de 2 dígitos. Regra: assume o século atual; se cair no futuro, usa o anterior.
// 89 -> 1989 · 60 -> 1960 · 05 -> 2005 · 25 -> 2025
// Ponto cego conhecido e aceito: 00..26 colide com 1900..1926 — faixa de 100 a 110 anos,
// que a validação de idade já limita.
export function expandirAno2Digitos(n) {
    const anoAtual = anoAtualBRT();
    const seculo = Math.floor(anoAtual / 100) * 100;
    const candidato = seculo + n;
    return candidato > anoAtual ? candidato - 100 : candidato;
}
```

**`extrairDataCompleta`** passa a aceitar 2 ou 4 dígitos no ano, nos dois formatos, e devolve
`anoInferido`:

```js
function extrairDataCompleta(norm) {
    const mNumerico = norm.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\b/);
    if (mNumerico) {
        const dia = Number(mNumerico[1]);
        const mes = Number(mNumerico[2]);
        const anoBruto = mNumerico[3];
        const anoInferido = anoBruto.length === 2;
        const ano = anoInferido ? expandirAno2Digitos(Number(anoBruto)) : Number(anoBruto);
        if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
            return { dia, mes, ano, anoInferido };
        }
    }

    const mTextual = norm.match(/\b(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{2}|\d{4})\b/);
    if (mTextual) {
        const dia = Number(mTextual[1]);
        const mes = extrairMes(`de ${mTextual[2]} de`);
        const anoBruto = mTextual[3];
        const anoInferido = anoBruto.length === 2;
        const ano = anoInferido ? expandirAno2Digitos(Number(anoBruto)) : Number(anoBruto);
        if (dia >= 1 && dia <= 31 && mes !== null) {
            return { dia, mes, ano, anoInferido };
        }
    }

    return null;
}
```

**Etapa de ano isolado:** hoje `extrairComponenteData` devolve `indeterminado` quando
`campoEsperado === 'ano'` e o número tem 2 dígitos. Por coerência com a decisão acima, passa a
expandir também:

```js
    if (campoEsperado === 'ano' && numero >= 10 && numero <= 99) {
        return { tipo: 'ano', valor: expandirAno2Digitos(numero), anoInferido: true, candidatos: null };
    }
```

Esse ramo roda **antes** da checagem de `cabeDia`/`cabeMes`, exatamente onde está hoje.
`detectarAnoDoisDigitosRejeitado` deixa de ter uso nesse caminho — remover a chamada
correspondente em `data_nascimento.js` ou deixá-la inerte, nunca as duas coisas ao mesmo tempo.

Propagar `anoInferido` no retorno de `extrairComponenteData` tanto em `data_completa` quanto no
ramo de ano isolado.

### 4.3 `src/agentes/data_nascimento.js` — etapa `nasc_data`

**Etapa inicial passa a ser `nasc_data`:**

```js
const etapa = context.etapa || 'nasc_data';
```

**Campo esperado:** `CAMPO_ESPERADO_POR_ETAPA['nasc_data'] = 'dia'` — se vier um número solto
("6") numa pergunta de data completa, a leitura mais provável é o dia, e a montagem por partes
que se segue termina com confirmação de qualquer forma.

**Rótulo:** `CAMPO_LABEL_POR_ETAPA['nasc_data'] = 'data de nascimento'`.

**Novo bloco em `buildSystemPrompt`:**

```js
    if (etapa === 'nasc_data') {
        return `${base}${correcaoTexto}${saudacaoTexto}

Pergunte a *DATA DE NASCIMENTO* completa de ${nome}, com negrito do WhatsApp (um asterisco de cada lado) na expressão "data de nascimento". O exemplo de formato é OBRIGATÓRIO e deve ser de data completa.
Exemplo: "Qual é a sua *data de nascimento*? Pode mandar completa — por exemplo: 06/11/1989"`;
    }
```

**A regra 3 do bloco de estado** ("o exemplo de formato na pergunta deve corresponder
exatamente ao campo pendente — nunca misture com exemplo de data completa") passa a valer só
para dia, mês e ano isolados:

```
3. O exemplo de formato na pergunta deve corresponder exatamente ao campo pendente. Quando o
   campo pendente for dia, mês ou ano ISOLADO, nunca use exemplo de data completa (DD/MM/AAAA).
   Quando a etapa for nasc_data, o exemplo DEVE ser de data completa.
```

### 4.4 Quando confirma e quando não confirma

**Princípio:** a Nami só pede confirmação daquilo que ela **inferiu** ou **montou**.

| Entrada | Caminho | Confirmação |
|---|---|---|
| Data completa, ano de 4 dígitos (`06/11/1989`) | grava e fecha em 1 turno | **não** |
| Data completa, ano de 2 dígitos (`06/11/89`) | monta, mostra o ano expandido | **sim** |
| Data montada por partes (dia → mês → ano) | comportamento atual | **sim** |
| Número solto, ambíguo entre dia e mês | desambiguação atual | **sim** |

No handler, o ramo `extracao.tipo === 'data_completa'` passa a bifurcar:

```js
    if (extracao.tipo === 'data_completa') {
        const { dia, mes, ano, anoInferido } = extracao.valor;
        const novoContext = {
            ...context, dia, mes, ano,
            tentativas_indeterminado: 0, oferta_pular_ativa: false
        };
        delete novoContext.desambiguando;

        const montagem = montarDataNascimento({ dia, mes, ano });

        if (montagem.valida && !anoInferido && !context.dia && !context.mes && !context.ano) {
            // Data completa, ano explícito, nada montado antes: grava e fecha em 1 turno.
            novoContext.iso = montagem.iso;
            return await gravarEFechar({ user, context: novoContext, message });
        }

        if (anoInferido) {
            console.log(`🎂 [ANO2D] digitado=${String(ano).slice(-2)} expandido=${ano} — ${user.phone}`);
        }

        const correcaoAplicada = (context.dia !== null && context.dia !== undefined)
            ? { campo: 'dia', valor: dia } : null;
        return await validarConcluirOuContinuar({ user, message, novoContext, correcaoAplicada });
    }
```

**Observação sobre `gravarEFechar`:** hoje ela é chamada a partir de `nasc_confirmacao` e já
grava em `users` e emenda a próxima mensagem. Verificar que ela funciona com `novoContext.iso`
recém-calculado, sem depender de `context.etapa === 'nasc_confirmacao'`. Se depender, ajustar
para ler o `iso` do contexto recebido, nunca recalcular a data.

### 4.5 Medição do ano de 2 dígitos

`system_events.tipo` tem CHECK que aceita apenas `erro_tecnico`, `desvio_comportamental` e
`intencao_nao_suportada`. Registrar um tipo novo exigiria migração, que está **fora do escopo
de hoje**.

Medição desta rodada: log estruturado, prefixo fixo `🎂 [ANO2D]`, pesquisável no Railway. Dois
pontos:

```js
console.log(`🎂 [ANO2D] digitado=89 expandido=1989 — ${user.phone}`);              // na expansão
console.log(`🎂 [ANO2D] resultado=confirmado — ${user.phone}`);                    // em gravarEFechar
console.log(`🎂 [ANO2D] resultado=corrigido — ${user.phone}`);                     // em nasc_negacao
```

Os dois últimos só saem se `context.ano_inferido === true` — gravar essa flag no contexto no
momento da expansão.

Em duas semanas isso responde duas perguntas com dado: quantas pessoas escrevem o ano com 2
dígitos, e quantas precisaram corrigir. Se ninguém corrigir, a confirmação some e o caminho
vira 1 turno para todo mundo. Se corrigirem, a regra de expansão estava errada.

---

## 5. Comportamentos que NÃO podem regredir

O usuário pode, em qualquer ponto da jornada, perguntar, mudar de assunto, recusar ou
cancelar. Esses ramos já existem e funcionam. O briefing exige que continuem funcionando
**a partir da etapa `nasc_data` também**:

| Caso | Comportamento obrigatório |
|---|---|
| dúvida ("pra que você precisa disso?") | responde, oferece pular, **preserva** o que já foi coletado |
| recusa ("não quero informar") | acolhe sem insistir, fecha sem o dado, segue a conversa |
| saudação ("oi", "voltei") | responde e repete a pergunta pendente, **sem** consumir tentativa |
| ruído | repete a pergunta; na 3ª tentativa pula sozinha |
| nova intenção ("quero cadastrar meu remédio") | escala ao roteador |
| combinação inválida (31/02) | reabre só o dia, como hoje |

O contador `tentativas_indeterminado` continua sendo consumido **apenas** pelo ramo `ruido` —
invariante do MH-072 A.1 item 7, explicitamente marcado no código para não ser "unificado" em
refatoração. Não unificar.

---

## 6. O que este briefing NÃO faz

- Não mexe em `router.js`, `principal.js` nem no fluxo de cadastro de medicamento (isso é o
  Bloco C).
- Não cria o runner unificado nem o call `{ intencao, campos }` (Fases 6 e 7).
- Não cria tabela, coluna nem migração.
- Não muda a ordem da jornada: a data de nascimento continua logo depois da LGPD, por decisão
  de Guilherme na v43.

---

## 7. Validação em staging

| # | Teste | Esperado |
|---|---|---|
| 1 | "Oi" | acolhida de no máximo 3 linhas, pede o nome, **sem** aviso de desenvolvimento |
| 2 | "tomo losartana 8h" como primeira mensagem | cita a losartana e pede o nome, ainda curto |
| 3 | Aceitar a LGPD | pergunta a data completa com exemplo `06/11/1989` |
| 4 | Responder `06/11/1989` | grava e segue direto, **sem** turno de confirmação |
| 5 | Responder `06.11.1989` | idem |
| 6 | Responder `06/11/89` | mostra `06/11/1989` e **pede confirmação**; log `[ANO2D]` |
| 7 | Responder `6 de novembro de 89` | idem ao 6 |
| 8 | Responder só "novembro" | pergunta o que falta, campo a campo, e confirma no fim |
| 9 | Responder "pra que você precisa disso?" | explica e oferece pular, sem perder nada |
| 10 | Responder "não quero informar" | acolhe e segue sem o dado |
| 11 | Responder "quero cadastrar meu remédio" | escala para o cadastro |
| 12 | Cadastrar o primeiro medicamento até o fim | aviso de "ainda sendo construída" aparece no fechamento |
| 13 | Cadastrar o segundo medicamento | aviso **não** aparece |

---

## 8. Itens de backlog cobertos

- **MH-091** — texto de acolhida enxuto.
- **MH-092** — data de nascimento em um turno quando a mensagem já traz a data.

Mover para `em_validacao` no deploy em staging.