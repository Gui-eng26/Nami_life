# BRIEFING — Trabalho 2: Verificação antecipada de medicamento no cadastro + Reativação completa

**Sessão:** v10 — 21/06/2026  
**Arquivos afetados:** `src/database.js`, `src/agentes/cadastro.js`, `src/agentes/configuracao.js`

---

## Contexto

Hoje a detecção de medicamento duplicado só acontece em `processarAcao` dentro de `handleCadastro`, chamada na etapa `cad_salvo` — depois que o usuário passou por todas as 8 etapas do fluxo. O usuário só descobre que o medicamento já existe após responder nome, forma, dosagem, tipo de tratamento, horários, estoque e confirmação.

O Trabalho 2 move essa verificação para o início do fluxo, logo após o nome ser coletado, e trata cada caso de forma correta: medicamento ativo, pausado ou encerrado recebem condutas distintas.

O caso do medicamento **pausado** é redirecionado para o `agente_configuracao`, que é o responsável por alterações. O fluxo de reativação inclui atualização de tipo de tratamento, estoque e horários — porque o usuário que não se lembrava do medicamento provavelmente tem dados desatualizados, e forçá-lo a voltar depois para ajustar é prolongar desnecessariamente uma tarefa que a Nami já tem contexto para resolver.

---

## Alteração 1 — `database.js`: nova função `verificarMedicamentoExistente`

Adicionar função que retorna o medicamento pelo nome em **qualquer estado** (ativo, pausado ou encerrado), incluindo seus schedules:

```javascript
export async function verificarMedicamentoExistente(userId, nome) {
    const { data } = await supabase
        .from('medications')
        .select('id, nome, dosagem, estoque_atual, ativo, tipo_tratamento, tratamento_dias, schedules(id, horario, ativo)')
        .eq('user_id', userId)
        .ilike('nome', nome)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || null;
}
```

Adicionar também função para executar a reativação com atualização de dados:

```javascript
export async function reativarComAtualizacao({ medicationId, estoque, tipo_tratamento, tratamento_dias, horarios }) {
    // Atualiza dados do medicamento
    const { error: errMed } = await supabase
        .from('medications')
        .update({
            estoque_atual: estoque,
            tipo_tratamento,
            tratamento_dias: tratamento_dias || null,
            ativo: true
        })
        .eq('id', medicationId);
    if (errMed) throw new Error(`Erro ao atualizar medicamento: ${errMed.message}`);

    // Desativa todos os schedules existentes
    const { error: errDel } = await supabase
        .from('schedules')
        .update({ ativo: false })
        .eq('medication_id', medicationId);
    if (errDel) throw new Error(`Erro ao desativar schedules: ${errDel.message}`);

    // Cria novos schedules com os horários confirmados
    for (const horario of horarios) {
        const horarioStr = String(horario).trim().substring(0, 5);
        const { error: errSched } = await supabase
            .from('schedules')
            .insert({ medication_id: medicationId, horario: `${horarioStr}:00`, ativo: true });
        if (errSched) throw new Error(`Erro ao criar schedule: ${errSched.message}`);
    }

    console.log(`▶️ Medicamento reativado com atualização — id: ${medicationId}`);
}
```

Importar `reativarComAtualizacao` e `verificarMedicamentoExistente` nos arquivos que os utilizam.

---

## Alteração 2 — `agentes/cadastro.js`: verificação antecipada após `cad_nome`

No `handleCadastro`, após o Claude retornar da etapa `cad_nome` com `novoContext.nome` preenchido, inserir verificação determinística antes de avançar para `cad_forma`.

**Localização exata:** após o bloco de cálculo de horários (BUG-041) e antes do `saveConversationState` final.

**Lógica a adicionar:**

```javascript
// TRABALHO 2: verificação antecipada de medicamento existente
// Só executa quando saindo de cad_nome com nome coletado
if (etapaAtual === 'cad_nome' && novoContext.nome && proximaEtapa === 'cad_forma') {
    const existente = await verificarMedicamentoExistente(user.id, novoContext.nome);

    if (existente) {
        const schedules = existente.schedules || [];
        const schedulesAtivos = schedules.filter(s => s.ativo);
        const todosInativos = schedules.length > 0 && schedulesAtivos.length === 0;

        // CASO 1: Medicamento encerrado (ativo = false)
        // → Pergunta se quer cadastrar como novo tratamento
        if (!existente.ativo) {
            await saveConversationState(user.id, {
                state: 'adding_med',
                context: {
                    etapa: 'cad_reencadastro_confirmar',
                    nome: existente.nome,
                    medicationId: existente.id
                }
            });
            return `O *${existente.nome}* foi encerrado anteriormente.\n\nQuer cadastrar um novo tratamento com ele agora?`;
        }

        // CASO 2: Medicamento pausado (ativo = true, todos os schedules inativos)
        // → Redireciona para agente_configuracao com etapa reativ_confirmar
        if (todosInativos) {
            const horariosFormatados = schedules
                .map(s => `• ${s.horario.substring(0, 5)}`)
                .join('\n');
            const tipoLabel = existente.tipo_tratamento === 'temporario'
                ? `${existente.tratamento_dias} dias`
                : 'uso contínuo';

            await saveConversationState(user.id, {
                state: 'configurando',
                context: {
                    etapa: 'reativ_confirmar',
                    medicationId: existente.id,
                    medicationNome: existente.nome,
                    estoqueAtual: existente.estoque_atual,
                    tipo_tratamento: existente.tipo_tratamento,
                    tratamento_dias: existente.tratamento_dias,
                    schedulesExistentes: schedules,
                    schedulesAtivos: schedulesAtivos
                }
            });
            return `O *${existente.nome}* está com os lembretes pausados 💊\n\nÚltimos dados cadastrados:\n${horariosFormatados}\nEstoque: ${existente.estoque_atual} unidades\nTratamento: ${tipoLabel}\n\nQuer reativar os lembretes?`;
        }

        // CASO 3: Medicamento ativo (ativo = true, tem schedules ativos)
        // → Informa que já existe, encerra cadastro
        const horariosFormatados = schedulesAtivos
            .map(s => `• ${s.horario.substring(0, 5)}`)
            .join('\n');
        const tipoLabel = existente.tipo_tratamento === 'temporario'
            ? `${existente.tratamento_dias} dias`
            : 'uso contínuo';

        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `O *${existente.nome}* já está cadastrado e ativo 💊\n\nDosagem: ${existente.dosagem}\nHorários:\n${horariosFormatados}\nEstoque: ${existente.estoque_atual} unidades\nTratamento: ${tipoLabel}\n\nSe quiser atualizar alguma informação, é só me dizer!`;
    }
}
```

**Tratamento da etapa `cad_reencadastro_confirmar`** (medicamento encerrado — usuário confirma novo cadastro):

Adicionar no `handleCadastro` antes do fallback final, para tratar a resposta do usuário sobre re-encadastrar:

```javascript
// TRABALHO 2: resposta do usuário sobre re-encadastrar medicamento encerrado
if (etapaAtual === 'cad_reencadastro_confirmar') {
    const msg = message.toLowerCase().trim();
    const confirmou = ['sim', 's', 'ok', 'pode', 'claro', 'quero', 'sim quero', 'vai', 'vamos'].some(t => msg === t || msg.startsWith(t + ' '));

    if (!confirmou) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem! Se precisar de algo mais, é só me chamar 🌿`;
    }

    // Continua o cadastro normalmente a partir de cad_forma
    // O nome já está no contexto — avança direto para a próxima etapa
    const systemPrompt = buildSystemPrompt('cad_forma', { nome: context.nome }, user.name);
    const claudeResponse = await callClaude({
        systemPrompt,
        message: `Quero cadastrar o ${context.nome} novamente`,
        context: { nome: context.nome }
    });

    const proximaEtapa = claudeResponse.proximaEtapa || 'cad_forma';
    const novoContext = { ...claudeResponse.novoContext, nome: context.nome };
    await saveConversationState(user.id, {
        state: 'adding_med',
        context: { ...novoContext, etapa: proximaEtapa }
    });
    return claudeResponse.message;
}
```

**Importar `verificarMedicamentoExistente` no topo de `cadastro.js`:**

```javascript
import {
    saveConversationState,
    saveMedication,
    saveSchedule,
    replaceMedication,
    verificarMedicamentoExistente  // ← adicionar
} from '../database.js';
```

---

## Alteração 3 — `agentes/configuracao.js`: fluxo de reativação completo

### 3.1 — Importar `reativarComAtualizacao`

```javascript
import {
    saveConversationState,
    getUserMedications,
    pausarMedicamento,
    reativarMedicamento,
    encerrarTratamento,
    alterarHorarioSchedule,
    reativarComAtualizacao  // ← adicionar
} from '../database.js';
```

### 3.2 — Novas etapas no handler principal

Adicionar antes do fallback final (`// Fallback`), nesta ordem:

```javascript
// ── ETAPA reativ_confirmar: usuário confirma se quer reativar ────────────────
if (etapa === 'reativ_confirmar') {
    if (isCancelamento(message) || /\b(não|nao|n)\b/i.test(message.toLowerCase())) {
        await saveConversationState(user.id, { state: 'idle', context: {} });
        return `Tudo bem, ${firstName}! Se precisar de algo, é só me chamar 🌿`;
    }

    // Qualquer resposta afirmativa → avança para tipo de tratamento
    await saveConversationState(user.id, {
        state: 'configurando',
        context: { ...context, etapa: 'reativ_tipo_tratamento' }
    });
    return `Ótimo! Vamos atualizar as informações antes de reativar.\n\nO *${context.medicationNome}* é de uso contínuo (sem previsão de parada) ou tem prazo determinado, como um antibiótico ou anti-inflamatório?`;
}

// ── ETAPA reativ_tipo_tratamento: coleta tipo e prazo ───────────────────────
if (etapa === 'reativ_tipo_tratamento') {
    const msg = message.toLowerCase();
    let tipo_tratamento = null;
    let tratamento_dias = null;

    if (/contínuo|continuo|sempre|sem prazo|permanente|crônico|cronico/.test(msg)) {
        tipo_tratamento = 'continuo';
    } else if (/temporar|prazo|dias|semana|antibiótico|antibiotico|anti-inflamatório|antiinflamatorio/.test(msg)) {
        tipo_tratamento = 'temporario';
        // Tenta extrair número de dias da mensagem
        const diasMatch = msg.match(/(\d+)\s*dias?/);
        tratamento_dias = diasMatch ? parseInt(diasMatch[1]) : null;
    }

    if (!tipo_tratamento) {
        return `Não entendi, ${firstName}. É uso *contínuo* (sem previsão de parada) ou *temporário* (tem um prazo determinado)?`;
    }

    if (tipo_tratamento === 'temporario' && !tratamento_dias) {
        await saveConversationState(user.id, {
            state: 'configurando',
            context: { ...context, etapa: 'reativ_tipo_tratamento', tipo_tratamento }
        });
        return `Quantos dias dura esse tratamento?`;
    }

    await saveConversationState(user.id, {
        state: 'configurando',
        context: { ...context, etapa: 'reativ_estoque', tipo_tratamento, tratamento_dias }
    });
    return `Certo! Seu estoque anterior era de *${context.estoqueAtual} unidades*. Continua assim ou quer atualizar?`;
}

// ── ETAPA reativ_estoque: confirma ou atualiza estoque ──────────────────────
if (etapa === 'reativ_estoque') {
    const msg = message.toLowerCase().trim();
    const confirmouEstoque = ['sim', 's', 'ok', 'continua', 'mesmo', 'igual', 'está certo', 'tá bom', 'pode'].some(t =>
        msg === t || msg.startsWith(t + ' ')
    );

    let novoEstoque = context.estoqueAtual;

    if (!confirmouEstoque) {
        // Tenta extrair número da mensagem
        const numMatch = message.match(/\d+/);
        if (numMatch) {
            novoEstoque = parseInt(numMatch[0]);
        } else {
            return `Não entendi, ${firstName}. Qual a quantidade atual em estoque? (ex: *20*)`;
        }
    }

    // Monta lista de horários anteriores para exibir
    const schedulesAnteriores = context.schedulesExistentes || [];
    const horariosAnteriores = schedulesAnteriores
        .map(s => `• ${s.horario.substring(0, 5)}`)
        .join('\n');

    await saveConversationState(user.id, {
        state: 'configurando',
        context: { ...context, etapa: 'reativ_horarios', novoEstoque }
    });

    return `Ótimo! Os horários anteriores eram:\n${horariosAnteriores || '(nenhum cadastrado)'}\n\nContinua igual ou quer definir novos horários?`;
}

// ── ETAPA reativ_horarios: confirma ou coleta novos horários ────────────────
if (etapa === 'reativ_horarios') {
    const msg = message.toLowerCase().trim();
    const confirmouHorarios = ['sim', 's', 'ok', 'continua', 'mesmo', 'igual', 'está certo', 'tá bom', 'pode'].some(t =>
        msg === t || msg.startsWith(t + ' ')
    );

    let horariosFinais;

    if (confirmouHorarios) {
        // Usa horários anteriores
        const schedulesAnteriores = context.schedulesExistentes || [];
        horariosFinais = schedulesAnteriores.map(s => s.horario.substring(0, 5));
    } else {
        // Coleta novos horários — extrai todos os horários mencionados na mensagem
        const matches = [...message.matchAll(/(\d{1,2})[:h](\d{2})?/g)].map(m => {
            const h = m[1].padStart(2, '0');
            const min = (m[2] || '00').padStart(2, '0');
            return `${h}:${min}`;
        });

        if (matches.length === 0) {
            return `Não entendi os horários, ${firstName}. Me diga os horários das doses — por exemplo: *08:00 e 20:00*`;
        }

        horariosFinais = matches;
    }

    // Executa reativação com todos os dados atualizados
    await reativarComAtualizacao({
        medicationId: context.medicationId,
        estoque: context.novoEstoque,
        tipo_tratamento: context.tipo_tratamento,
        tratamento_dias: context.tratamento_dias || null,
        horarios: horariosFinais
    });

    const tipoLabel = context.tipo_tratamento === 'temporario'
        ? `${context.tratamento_dias} dias`
        : 'uso contínuo';
    const horariosLabel = horariosFinais.join(', ');

    await saveConversationState(user.id, { state: 'idle', context: {} });
    return `✅ Pronto, ${firstName}! *${context.medicationNome}* reativado com sucesso 💊\n\nHorários: ${horariosLabel}\nEstoque: ${context.novoEstoque} unidades\nTratamento: ${tipoLabel}\n\nVou voltar a te lembrar nos horários certos!`;
}
```

---

## Fluxos cobertos — resumo

### Medicamento ativo (ativo=true, tem schedules ativos)
→ Informa que já existe com dados atuais → `idle`  
→ Usuário que quiser alterar algo usa o `agente_configuracao` normalmente

### Medicamento pausado (ativo=true, todos schedules inativos)
→ Detectado no `agente_cadastro` → redireciona para `agente_configuracao` (state: `configurando`)  
→ Fluxo: `reativ_confirmar` → `reativ_tipo_tratamento` → `reativ_estoque` → `reativ_horarios`  
→ Executa `reativarComAtualizacao` com todos os dados confirmados

### Medicamento encerrado (ativo=false)
→ Pergunta se quer cadastrar como novo tratamento  
→ Sim: continua fluxo normal de cadastro a partir de `cad_forma` (nome já coletado)  
→ Não: `idle`

### Medicamento não encontrado
→ Continua fluxo normal de cadastro (comportamento atual inalterado)

---

## Detalhes arquiteturais importantes

**Por que `reativarComAtualizacao` desativa todos os schedules e cria novos:**  
Mesmo quando o usuário confirma os horários anteriores, a função desativa e recria. Isso garante que schedules em estado inconsistente (ex: parcialmente inativos por bug anterior) sejam normalizados.

**Por que o tipo de tratamento é sempre perguntado na reativação:**  
O usuário pode ter pausado um tratamento agudo e estar reativando com um novo ciclo de dias diferente. Além disso, o tipo de tratamento afeta os alertas de estoque e o futuro MH-030 (encerramento automático). Confirmar sempre é mais seguro do que assumir que continua igual.

**Por que os horários novos são coletados do zero (não editados um a um):**  
O usuário que quer mudar horários na reativação provavelmente quer redefinir tudo. O sub-fluxo `identif_schedule` → `obter_horario` do BUG-042/043 é para edição pontual de horário específico, não para o contexto de reativação.

**`schedulesExistentes` no contexto:**  
Propagado desde a detecção no `agente_cadastro` até `reativ_horarios`. Contém todos os schedules (ativos e inativos) para exibir os horários anteriores ao usuário. Não confundir com `schedulesAtivos` do `agente_configuracao` — aqui pode estar vazio propositalmente (medicamento pausado = todos inativos).

---

## Validação esperada após implementação

1. Usuário tenta cadastrar "Dipirona" que está **ativa** → Nami informa que já existe com os dados atuais → `idle`
2. Usuário tenta cadastrar "Losartana" que está **pausado** → Nami informa que está pausado, mostra dados anteriores, pergunta se quer reativar → fluxo completo de reativação com tipo, estoque e horários → reativado
3. Usuário tenta cadastrar "Nimesulida" que foi **encerrada** → Nami pergunta se quer cadastrar como novo tratamento → sim → fluxo normal a partir de `cad_forma`
4. Usuário tenta cadastrar "Amoxicilina" que **não existe** → fluxo normal inalterado
5. Busca é case-insensitive: "dipirona", "Dipirona", "DIPIRONA" → todos detectados

---

**Comando para Claude Code:**  
`Leia o briefings/BRIEFING_TRABALHO2.md e implemente.`