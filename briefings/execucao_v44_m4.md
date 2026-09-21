# BRIEFING DE EXECUÇÃO — v44 · M4: Onboarding no runner (último marco da arquitetura-alvo)

**Pré-requisito:** M3 em produção; arnês 32 casos com expected-fail APENAS A10.
**Branch:** `staging`; promoção por marco (MH-89 C).
**Governança:** nenhuma escrita em `backlog_items` a partir deste briefing.
**Fonte de verdade:** CONTEXT.md §12 + Constituição v1+emendas + este briefing.

**⚠️ DIRETRIZ DE CUSTO DE API (decisão de Guilherme, 21/09):** a revisão dos arneses consumiu grande volume de créditos. Neste marco: rodar **apenas os casos afetados pelo commit** durante o desenvolvimento (para o M4: A7, A10, A18 e os novos A33–A35); a suíte completa roda **UMA vez, só no portão de merge**; caso flaky → rerun individual, nunca a suíte; preferir asserções determinísticas sem LLM sempre que possível (a guarda de LGPD abaixo é teste de unidade puro). **A validação de comportamento é manual, pelo Guilherme** — o roteiro está nos critérios de aceite.

---

## 0. Objetivo

`recepcionista.js` (895 linhas) + `data_nascimento.js` (656) = **1.551 linhas viram `schemas/onboarding.js`** no runner que já roda cadastro, configuração e perfil. Com isso o **A10 vira verde** e a arquitetura-alvo fecha 100%: um runner, schemas como dados, uma porta, um funil.

Este marco **sela o contrato do produto**: "você fala com a Nami como se estivesse falando com alguém da sua família" — agora inclusive no primeiro minuto. O funil da v43 (67% de conversão) **se preserva, não se redesenha**: as duas portas de chegada (folheto/descobrir) e a copy da LGPD em produção (instrutiva, validada) continuam como estão.

## 1. Schema do onboarding (`schemas/onboarding.js`)

Três campos, no MESMO runner, **reusando os validadores que o M3 já criou em `schemas/perfil.js`** (nome com vetos de palavras-de-pedido; data com o validador de `dataNascimento.js`):

| Campo | Nível | Regra |
|---|---|---|
| `nome` | have-to-have | marcador explícito ou resposta à pergunta (guardas do A26 valem aqui) |
| `consentimento_lgpd` | **portão** | ver §2 — decisão determinística, conversa fluida |
| `data_nascimento` | **OPCIONAL** (decisão 21/09) | pedido gentil com porta de saída na própria mensagem; recusa/pulo **completa o onboarding normalmente** e nunca atrasa a chegada ao cadastro; editável depois pelo `perfil` (M3). Motivo do campo: KPIs de perfil/adesão — nunca trava o usuário |

Ordem mantida: nome → LGPD → nascimento. Perguntas renderizadas em código sob a constituição + emendas.

## 2. Portão LGPD — determinístico na DECISÃO, fluido na CONVERSA

A palavra "determinístico" vale para uma coisa só: **nenhum dado pessoal declarado é persistido antes do aceite identificado**. O resto é conversa normal. Regras:

1. **Rascunho pré-consentimento guarda o SCHEMA INTEIRO + campos incidentais** — corrige o P57-pela-metade do caso Felipe (nome era recuperado após o "Concordo"; a data não). Tudo que a pessoa disser antes do aceite vive em estado de conversa, nada em `users`/`medications`.
2. **Caso real reforçado por Guilherme — "dump completo na LGPD":** usuário responde a pergunta de consentimento com nome completo + telefone + data de nascimento + (às vezes) um "sim" no meio. Comportamento: o extrator identifica TUDO; o que servir (data de nascimento!) vai ao rascunho para **nunca ser reperguntado**; a detecção de consentimento roda sobre a mensagem:
   - **aceite presente** ("sim", "concordo", variantes) → consentimento registrado, dados do rascunho persistidos, fluxo segue direto para o que faltar;
   - **aceite ausente** → resposta que MOSTRA que entendeu os dados (listagem curta) e repede **só o consentimento**, gentil, uma pergunta na última linha. Especificação de conteúdo, nunca texto pronto. Nada ignorado (regra 3), nada perdido (regra 4).
3. Detecção do aceite: lista determinística de termos + classificador tool-use para formas livres — mas **persistência só acontece com aceite identificado**; na dúvida, repede o consentimento (nunca assume).
4. Recusa da LGPD: comportamento atual (`lgpd_recusado`) preservado.
5. **Guarda determinística no A0 (teste de unidade, sem LLM):** nenhum caminho de código grava dado pessoal declarado com `consentimento_lgpd` ausente no estado.

## 3. Pedido chegando ANTES do onboarding — preservar, atravessar, retomar

Escopo reforçado por Guilherme: usuário chega com medicamento + posologia (ou qualquer pedido) na primeira mensagem, ou no meio do onboarding.

- O extrator completo roda em TODA mensagem do onboarding; campos de cadastro vão ao **rascunho** (nunca ao banco — §2).
- A resposta reconhece o que chegou (regra 3: "anotei o Losartana, já cuido dele") e segue o onboarding.
- Onboarding completo → a porta despacha ao cadastro **com os campos semeados** — retomada no momento certo, sem repergunta de nada que já foi dito.
- É a versão completa do A10 (Felipe) e da Thaielly-pré-onboarding.

## 4. O que morre e o que é absorvido

- `recepcionista.js` e `agentes/data_nascimento.js` inteiros; os ramos 1–3.5 do `routeMessage`; estados `recep_*`/`coletando_nascimento` (viram etapas do runner). `dataNascimento.js` (helper) sobrevive como validador.
- **MH-92** (o marco em si) e **MH-87 lado onboarding** (reformulação pós-falha reconhece o que a pessoa disse — o runner já faz isso por construção nos outros domínios).
- Spec "é para outra pessoa" (A18) migra intacto para o schema.

## 5. O que NÃO muda

Duas portas da v43 (folheto/descobrir) · copy da LGPD em produção (asserções de forma do A7 seguram) · fila/janela (5000ms) · `exclusaoConta` · fast-paths determinísticos · gate de menores de idade **fora do escopo** (decisão 21/09 — candidato a item de backlog no encerramento, para análise com apoio jurídico).

## 6. Arnês — casos novos

| Caso | O quê | Asserções-chave |
|---|---|---|
| **A33** | Dump completo na etapa LGPD (com e sem "sim" no meio) | tudo reconhecido; nada persistido antes do aceite; com aceite → segue sem reperguntar NADA do que veio; sem aceite → listagem curta + só o consentimento na última linha; data de nascimento nunca reperguntada depois |
| **A34** | Data de nascimento recusada/pulada | onboarding completa; chegada ao cadastro sem atraso; sem insistência; editável depois via perfil |
| **A35** | Medicamento com posologia na 1ª mensagem (pré-onboarding) | reconhecido na hora; NADA no banco antes do aceite; pós-onboarding → cadastro com campos semeados, zero repergunta — **A10 vira verde junto** |

Execução conforme a diretriz de custo: por commit, só os casos tocados; suíte completa uma vez no merge.

## 7. Critérios de aceite

1. A7, A10, A18, A33–A35 verdes; **nenhum expected-fail restante no arnês** (primeiro estado 100% pleno da arquitetura); suíte completa verde no portão de merge (execução única).
2. Guarda LGPD determinística no A0 (teste de unidade, sem custo de API).
3. **Replay manual (Guilherme, staging, como usuário novo — número limpo):** (a) chegada pelo folheto até o 1º medicamento; (b) dump completo na LGPD sem "sim" e depois com "sim"; (c) recusar a data de nascimento e seguir até cadastrar; (d) medicamento com posologia na PRIMEIRA mensagem; (e) "é para outra pessoa".
4. Funil intacto: mediana de turnos até o 1º medicamento não piora nos primeiros usuários reais pós-promoção.

## 8. Sequência de commits sugerida (casos afetados entre cada um; suíte só no merge)

1. Schema + runner em **paridade** (A7/A18 verdes como estão) — o commit de risco, isolado.
2. Rascunho pré-consentimento completo + detecção de aceite + caso do dump → A33.
3. Data de nascimento opcional → A34.
4. Semeadura pré-onboarding → porta/cadastro → A35 + **A10 verde**.
5. Limpeza: arquivos e ramos mortos; grep-guards.

## 9. Registros para o encerramento (dependem de "sim, registra")

- MH-92 → resolvido (o marco); MH-87 → resolvido (os dois lados agora); A10 verde encerra a linha Felipe.
- Candidatos a flip por superação (verificar): MH-73 B.1, MH-89 A, MH-46 (estados-alvo mortos no M3).
- Item novo candidato: **gate de menores de idade no onboarding** (LGPD de menores; decisão adiada com apoio jurídico).
- CONTEXT.md: §12.9 do M4 + marca de conclusão da arquitetura-alvo (M0–M4, 100%).