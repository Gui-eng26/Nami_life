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
inteira (A0–A35) roda verde com `--alvo M4` — primeiro estado 100% pleno da
arquitetura-alvo. Diretriz de custo (21/09): durante o desenvolvimento rodam
só os casos afetados pelo commit; a suíte completa roda UMA vez, no portão de
merge; caso flaky → rerun individual, nunca a suíte.

Baseline pré-M1 documentado em `arnes/BASELINE.md`.
