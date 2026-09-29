# BRIEFING DE EXECUÇÃO — v45 · P1-ajustes 3: turno só de estoque (correção mínima para promover)

**Pré-requisito:** `staging` em `257ed14` (P1-ajustes 2).
**Branch:** `staging`. Depois: validação manual do Guilherme → migração do §8 do P1 em produção → merge `staging` → `main`.
**Governança:** nenhuma escrita em `backlog_items`.
**Custo:** casos de arnês com LLM continuam bloqueados (decisão do Guilherme). A verificação deste ajuste é o teste determinístico do §2 + validação manual (§3).
**Natureza (decisão de 29/09):** contenção dentro do desenho atual, para destravar a promoção. A correção estrutural — **um ponto único de saída** que compõe toda resposta a partir dos fatos do turno — é a próxima discussão de arquitetura, **antes do P3**.

---

## 0. O problema

**Evidência (staging, 29/09, logs do Railway 17:53, 17:55, 17:59):** "Comprei mais 20cps do decadron", "Tenho 20cps em estoque do decadron", "Eu tenho 20cps". Nos três, o principal devolveu:

```
{ "tipo": "dose", "message": "", "doses": [], "actions": [UPDATE_STOCK …] }
```

`decisaoValida` (`principal.js`) recusou nas duas tentativas → degradação → "não consegui te entender". Nada foi gravado.

**Causa (confirmada no código):** o P1-ajustes 2 mudou o prompt ("quando você dispara UPDATE_STOCK… deixe `message` vazia") sem mudar o validador. Nenhum dos quatro tipos (responder, dose, delegar, perguntar) aceita `message` vazia sem dose; não existe tipo para "ação do meu domínio que o código executa e escreve". O mesmo contrato estava escrito em dois lugares, e eles divergiram.

## 1. Mudanças

1. **Tipo novo `acao`:** a pessoa pediu algo do domínio do principal que o código executa e escreve (hoje: `UPDATE_STOCK`, `SET_USER_NAME`). Regras: `message` pode ser vazia; `actions.length ≥ 1`; `doses` pode vir junto (ex.: "Comprei 60 comprimidos / Sim" continua valendo como hoje, com a ordem doses → ações).
2. **Contrato num lugar só:** a lista de tipos e as regras de cada tipo (o que é obrigatório, o que pode ficar vazio) passam a vir de **uma única definição**, lida tanto pelo texto do prompt que descreve os tipos quanto por `decisaoValida`. Nenhuma regra de tipo escrita à mão em só um dos dois.
3. **Prompt:** a definição dos tipos ganha `acao`; a regra "UM FATO, UM AUTOR" do estoque passa a dizer "use o tipo `acao` e deixe `message` vazia".

## 2. Teste determinístico (custo zero, no A0)

Para cada combinação que o prompt instrui o principal a usar, o teste monta a decisão correspondente e confirma que `decisaoValida` aceita. No mínimo:

- `acao` + `message` vazia + `UPDATE_STOCK`;
- `dose` + dose + `UPDATE_STOCK` (compra + "Sim");
- `delegar` `nao_suportado` + `message` vazia + chave ou pedido;
- `dose` com `ainda_nao`/`nao_tomou` + acolhimento em `message`;
- `perguntar` + `message`;
- e que `acao` **sem** ação é recusada.

Se um dia o prompt mandar uma combinação que o validador recusa, este teste quebra — no portão, não no WhatsApp.

## 3. Validação manual (Guilherme, no staging)

- "Comprei mais 20cps do Decadron" → abertura + "📦 Estoque do *Decadron* atualizado: *20* comprimidos."; nunca "não entendi".
- "Tenho 20cps em estoque do Decadron" → idem (modo set).
- "Comprei 60 comprimidos / Sim" com dose aberta → abertura, linha da dose, linha do estoque.

## 4. Critérios de aceite

- Teste do §2 verde; suíte sem LLM verde.
- Os três turnos do §3 corretos no staging.

## 5. Fora de escopo

O ponto único de saída (discussão de arquitetura antes do P3).