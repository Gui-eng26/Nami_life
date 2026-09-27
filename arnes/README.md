# Arnês de regressão (M0, v44)

Suíte executável que reproduz conversas **reais** (extraídas de `agent_logs` de
produção em 19/09/2026) contra o código atual, com asserções determinísticas
sobre (a) o texto final ao usuário e (b) o estado do banco após cada turno.

```bash
npm run arnes                # todos os casos, alvo M1
npm run arnes -- --caso A3   # um caso
npm run arnes -- --lista     # lista os casos sem executar
```

## Decisões de engenharia (contrato do briefing v44 §3)

- **Banco de teste: o projeto Supabase de STAGING** (`Nami-staging`), não um
  schema dedicado — um schema dedicado exigiria duplicar as 33 funções SQL e o
  baseline inteiro. Isolamento garantido por três camadas:
  1. guarda dura em `arnes/contexto.js`: execução **recusada** se `SUPABASE_URL`
     contiver o ref de produção (`nputymewnwmnhrtpizzs`);
  2. usuários do arnês vivem no prefixo de telefone reservado `+5500000000xx`
     (número inválido no Brasil), sempre com `is_teste = true`, e são apagados
     antes e depois de cada execução (CASCADE);
  3. Z-API neutralizada por credenciais inertes — nenhum turno alcança o WhatsApp.
- **Mock de envio: no ponto do funil (§5.5).** `src/funil.js` expõe
  `configurarTransporteParaTestes()`; o arnês injeta um transporte de captura.
  Antes do funil existir (baseline), a captura fica no retorno de `routeMessage`
  e os casos que dependem do funil (A8) ficam vermelhos por construção.
- **LLM real.** O arnês reproduz turnos reais com as chamadas reais — as
  asserções são determinísticas sobre texto e banco, não sobre a LLM.
- **Fonte dos casos: transcrições de `agent_logs`** nas datas indicadas em cada
  caso. NUNCA classificações do juizOffline (decisão v44: só catches diretos
  valem como evidência).

## Credenciais

Crie `.env.arnes` na raiz (não versionado, ver `.env.arnes.example`) com:

```
SUPABASE_URL=<url do projeto Nami-staging>
SUPABASE_SERVICE_KEY=<service key do Nami-staging>
```

`ANTHROPIC_API_KEY` é herdada do `.env` comum se não for redefinida.

## Marcos e expected-fail

Cada caso (e cada checagem, quando divergem) é taggeado por marco (M1, M2, M4).
Checagem de marco **acima** do alvo da execução que falha aparece como
🟡 CONHECIDO — nunca como regressão, e não derruba o exit code. A entrega do M1
exige: todos os M1 verdes + nenhum caso já-verde regredido.

Desde o v44 M4 (onboarding no runner) **não há mais expected-fail**: a suíte
inteira (A0–A36) roda verde com `--alvo M4` — primeiro estado 100% pleno da
arquitetura-alvo. Diretriz de custo (21/09): durante o desenvolvimento rodam
só os casos afetados pelo commit; a suíte completa roda UMA vez, no portão de
merge; caso flaky → rerun individual, nunca a suíte.

Baseline pré-M1 documentado em `arnes/BASELINE.md`.

v45 P1: casos A37–A47 (o principal como porta única) e guardas P1 no A0. Os
casos de atalho exato (A41, A47) afirmam **zero chamadas de LLM** pelo campo
`chamadasLLM` que `routeMessage` devolve. `NAMI_DEBUG_PRINCIPAL=1` imprime o
contexto que o principal recebe em cada turno.

v45 P1-ajustes: casos A49–A55 (um fato, um autor no estoque; ponte do fim do
onboarding; concordância "quantos/quantas"; convite de estoque sem repetição;
"ainda não" por padrão com evento `intencao_nao_suportada`). A51 e A52 são de
template (sem LLM); os demais semeiam a última fala da Nami em `agent_logs`
(`falaDaNami`) para a pendência aberta existir sem gastar um turno de LLM.

## Corpus (`arnes/corpus/`) — v45 P0

Suíte **separada**, que convive com esta e não a substitui. É a régua do
principal como porta única (P1): cada item é UM turno real, com o contexto
estruturado em que chegou, o que o sistema fez em produção e o que deveria
ter feito.

```bash
npm run corpus -- --adaptador=producao_observada   # dose + delegacao, sem API
npm run corpus -- --adaptador=porta_atual          # extração, 1 chamada por item
npm run corpus -- --adaptador=principal_p1         # o principal (P1), 1 chamada por item
npm run corpus -- --adaptador=principal_p1 --modelo=claude-sonnet-5
npm run corpus -- --adaptador=porta_atual --categoria=horario
npm run corpus -- --item=D-02 --json=saida.json
```

|  | `arnes/casos.js` | `arnes/corpus/` |
|---|---|---|
| O que testa | **comportamento**, conversa inteira, turno a turno | **interpretação** de UM turno |
| Dependências | Supabase de staging, seeds, mock do funil | nenhuma além da `ANTHROPIC_API_KEY` (só no `porta_atual` e no `principal_p1`) |
| Veredito | binário: é o portão de merge | taxa de acerto por categoria e por campo |
| Cadência | uma vez, no portão de merge | **sob demanda** |

O corpus **nunca entra no portão de merge** e sai sempre com código 0: ele
mede, não reprova. Campos que a porta atual não representa aparecem como
`nao_suportado_pela_porta_atual`, nunca como erro.

Quando um item do corpus revelar defeito de **comportamento**, ele vira também
um caso do arnês. O caminho é sempre esse, nunca o contrário.

Resultado e leitura: `arnes/corpus/BASELINE.md`.
