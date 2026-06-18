# Briefing — MH-019: Fluxo Completo de Recusa e Retorno LGPD

Este documento é um briefing de implementação para o Claude Code.
Leia o CONTEXT.md antes de começar.
Antes de qualquer alteração, leia src/agentes/recepcionista.js completo.

---

## Contexto

O fluxo de recusa da LGPD está incompleto. Três situações não são tratadas
corretamente:

1. A Nami não explica por que o consentimento é necessário
2. Se o usuário muda de ideia na mesma conversa, o fluxo não retoma
3. Se o usuário volta dias depois, o onboarding reinicia do zero sem
   reconhecer que ele já esteve aqui

---

## Arquivo a modificar

```
src/agentes/recepcionista.js
```

---

## AJUSTE 1 — Mensagem de recusa com explicação do motivo

No prompt, bloco `SE etapa = 'recep_lgpd'`, substituir a instrução de recusa por:

```
Se o usuário recusar:
  Explique brevemente por que o consentimento é necessário — sem pressão,
  sem tentar convencer, apenas informando.
  Diga que sem o consentimento o serviço não pode funcionar pela LGPD.
  Deixe a porta aberta para ele voltar quando quiser.

  Exemplo:
  "Entendo e respeito sua decisão! 😊
  Pela Lei Geral de Proteção de Dados (LGPD), preciso do seu consentimento
  para guardar seu nome e telefone — sem isso, infelizmente não consigo
  personalizar seus lembretes e o serviço não funciona.
  Se mudar de ideia, é só me chamar. Estarei aqui!"
```

---

## AJUSTE 2 — Novos estados para fluxo de retorno

Adicionar dois novos estados ao fluxo do recepcionista:

### Estado: `lgpd_recusado_retorno`
Nami perguntou se o usuário mudou de ideia. Aguardando confirmação.

### Estado: `recep_lgpd_reapresentacao`
Usuário confirmou que mudou de ideia. Nami reapresenta os termos LGPD
completos para um novo aceite explícito.

---

## AJUSTE 3 — Lógica de estados no código

### Novo bloco no handleRecepcionista

Adicionar tratamento para quando `state = 'lgpd_recusado'` no banco:

```javascript
// Usuário volta após ter recusado LGPD anteriormente
} else if (etapa === 'lgpd_recusado') {
    // Verifica se está confirmando que mudou de ideia
    const mudouDeIdeia = isLgpdAccepted(message); // reutiliza keywords positivas
    
    if (mudouDeIdeia) {
        // Usuário confirmou — reapresentar termos LGPD completos
        nextEtapa = 'recep_lgpd_reapresentacao';
        updatedContext = {
            ...context,
            etapa: 'recep_lgpd_reapresentacao'
        };
    } else {
        // Ainda não quer — manter estado, responder com respeito
        nextEtapa = 'lgpd_recusado';
        updatedContext = { ...context, etapa: 'lgpd_recusado' };
    }
}

// Usuário deu novo aceite explícito após reapresentação
} else if (etapa === 'recep_lgpd_reapresentacao') {
    lgpdAccepted = isLgpdAccepted(message);
    lgpdRecusado = contemRecusa(message);
    nextEtapa = lgpdAccepted ? 'recep_lgpd' : 'lgpd_recusado';
    updatedContext = { ...context, etapa: nextEtapa };
}
```

### Identificar usuário com lgpd_recusado no router

No `router.js`, quando `!user.onboarded`, o contexto já tem o estado
salvo no banco. O recepcionista recebe `context.etapa` com o valor
correto e trata cada caso.

Garantir que quando `saveConversationState` é chamado com
`state: 'lgpd_recusado'`, o contexto preserve `etapa: 'lgpd_recusado'`:

```javascript
if (lgpdRecusado) {
    await saveConversationState(user.id, {
        state: 'lgpd_recusado',
        context: { etapa: 'lgpd_recusado' }
    });
}
```

---

## AJUSTE 4 — Prompts dos novos estados

Adicionar ao `buildSystemPrompt` instruções para os dois novos estados:

```
SE etapa = 'lgpd_recusado':
  O usuário recusou os termos LGPD anteriormente e voltou a conversar.
  Reconheça que ele esteve aqui antes, de forma calorosa e sem pressão.
  Pergunte se mudou de ideia.

  Exemplo:
  "Olá de novo! 😊 Da última vez você preferiu não compartilhar seus dados,
  o que é completamente válido.
  Se mudou de ideia e quer configurar seus lembretes, é só me dizer!"

  Aguarde resposta — não reapresente os termos ainda.

SE etapa = 'recep_lgpd_reapresentacao':
  O usuário confirmou que mudou de ideia. Reapresente os termos LGPD
  completos para que ele dê um consentimento explícito e consciente.

  Exemplo:
  "Ótimo! Para eu poder te ajudar, preciso guardar seu nome e telefone
  para personalizar seus lembretes. Seus dados ficam protegidos e são
  usados exclusivamente para esse fim, conforme a LGPD.
  Você concorda?"

  Aguarde um "Sim" explícito antes de continuar.
```

---

## Fluxo completo após implementação

```
Usuário recusa LGPD
        ↓
state = 'lgpd_recusado'
Nami explica motivo + deixa porta aberta

--- dias depois ---

Usuário manda "oi"
        ↓
etapa = 'lgpd_recusado'
Nami reconhece retorno + pergunta se mudou de ideia
        ↓
Usuário confirma ("sim", "mudei de ideia", "quero")
        ↓
etapa = 'recep_lgpd_reapresentacao'
Nami reapresenta termos LGPD completos
        ↓
Usuário diz "Sim, concordo"
        ↓
lgpdAccepted = true → onboarded = true
Fluxo normal — pede nome e segue onboarding
```

---

## Ordem de implementação

1. Ler src/agentes/recepcionista.js completo
2. Atualizar mensagem de recusa no prompt (Ajuste 1)
3. Adicionar blocos de estado lgpd_recusado e recep_lgpd_reapresentacao
   no handleRecepcionista (Ajuste 3)
4. Garantir que saveConversationState salva etapa correta na recusa (Ajuste 3)
5. Adicionar instruções dos novos estados no buildSystemPrompt (Ajuste 4)
6. Mostrar diff antes de salvar

---

## Critérios de sucesso

- Usuário recusa LGPD → Nami explica que sem consentimento o serviço
  não funciona, sem pressão
- Usuário volta dias depois → Nami reconhece que ele esteve aqui antes
  e pergunta se mudou de ideia
- Usuário confirma que mudou de ideia → Nami reapresenta os termos
  completos antes de aceitar
- Usuário dá novo "Sim" explícito → onboarding segue normalmente
- Usuário recusa de novo → Nami encerra com respeito novamente
- Nenhuma regressão no fluxo normal de onboarding