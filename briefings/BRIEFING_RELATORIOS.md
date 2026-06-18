# Briefing — agente_relatorios

Este documento é um briefing de implementação para o Claude Code.
Leia o CONTEXT.md antes de começar.

---

## Objetivo

Criar o `agente_relatorios` — responsável por responder consultas do usuário
sobre seu histórico de tratamento e enviar resumos semanais automáticos.

Opera em modo híbrido:
- **Query direta**: consultas estruturadas respondidas pelo código sem chamar Claude
- **Claude com contexto**: consultas abertas onde linguagem empática e contextualizada
  agrega valor

---

## Arquivos a criar

```
src/agentes/relatorios.js   ← novo
```

## Arquivos a modificar

```
src/router.js               ← adicionar detecção de intenção de relatório
src/scheduler.js            ← adicionar envio de resumo semanal
src/database.js             ← adicionar funções de consulta de histórico
```

---

## Consultas cobertas

### Tipo A — Query direta (sem Claude)

**R-001: Tomei hoje?**
Variações: "tomei hoje?", "já tomei meus remédios?", "tomei alguma coisa hoje?",
"registrei hoje?", "tomei o remédio?", "esqueci de tomar hoje?",
"já tomei?", "tomei tudo hoje?"

Lógica:
- Consultar dose_logs com confirmed = true E taken_at::date = hoje
- Para cada medicamento ativo, verificar se há dose confirmada hoje
- Resposta formatada mostrando o que foi tomado e o que ainda está pendente

Formato de resposta:
```
✅ Aqui está seu registro de hoje, {nome}!

💊 Voltaren — tomado às 14:32
⏳ Nimesulida — ainda não registrado (horário: 19:00)
```

---

**R-002: Quais meus remédios?**
Variações: "quais meus remédios?", "que remédios tenho?", "o que tenho cadastrado?",
"quais remédios eu tomo?", "me mostra meus remédios", "que remédios tenho cadastrado?",
"lista meus remédios", "meus remédios"

Lógica:
- Consultar medications com ativo = true para o user_id
- Incluir schedules ativos de cada medicamento
- Resposta formatada com nome, dosagem, forma farmacêutica e horários

Formato de resposta:
```
💊 Seus remédios cadastrados, {nome}:

1. Voltaren — 50mg (comprimido)
   ⏰ Horários: 08:00 e 14:00

2. Nimesulida — 100mg (comprimido)
   ⏰ Horário: 19:00
```

---

**R-003: Estoque**
Variações: "quanto tenho de cada?", "tô ficando sem remédio?", "quando preciso comprar?",
"quanto sobrou?", "falta muito?", "meu estoque", "quanto tenho ainda?",
"preciso comprar remédio?"

Lógica:
- Consultar medications com ativo = true
- Comparar estoque_atual com estoque_minimo
- Classificar: OK (> minimo), ATENÇÃO (= minimo), CRÍTICO (< minimo)

Formato de resposta:
```
📦 Estoque dos seus remédios, {nome}:

✅ Voltaren — 8 comprimidos (OK)
⚠️ Nimesulida — 5 comprimidos (hora de comprar mais!)
```

---

**R-004: O que tenho que tomar agora / próximo remédio**
Variações: "o que tenho que tomar agora?", "que horas é o próximo remédio?",
"tenho remédio pra tomar?", "esqueci de tomar alguma coisa?",
"que remédio tomo hoje?", "o que devo tomar?", "qual o próximo?"

Lógica:
- Obter hora atual no fuso America/Sao_Paulo
- Consultar schedules ativos com horario próximo (±2h da hora atual)
- Para cada schedule, verificar se já há dose confirmada hoje
- Separar em: já tomou, deve tomar agora, próximo horário

Formato de resposta (exemplo às 13h):
```
⏰ Seus remédios para agora, {nome}:

✅ Voltaren (08:00) — já registrado
💊 Nimesulida (13:00) — está na hora de tomar!
🔜 Voltaren (19:00) — próximo às 19h
```

---

### Tipo B — Claude com contexto (linguagem empática)

**R-005: Adesão / esquecimento**
Variações: "quantas vezes esqueci?", "tenho esquecido muito?", "minha adesão tá boa?",
"tô tomando direitinho?", "quantas doses perdi?", "faltei alguma dose essa semana?",
"como tá meu histórico?", "tô me cuidando bem?"

Lógica:
- Calcular: total de doses esperadas no período vs. doses confirmadas
- Calcular percentual de adesão
- Identificar qual medicamento tem menor adesão
- Passar esses dados calculados para o Claude formatar com empatia

Prompt para Claude (tipo B):
```
Você é a Nami. Responda de forma calorosa e motivadora sobre a adesão do usuário.

Dados calculados:
- Período: últimos 7 dias
- Doses esperadas: {total_esperado}
- Doses confirmadas: {total_confirmado}
- Percentual de adesão: {percentual}%
- Medicamento com menor adesão: {nome_med} ({percentual_med}%)
- Nome do usuário: {nome}

Se adesão >= 80%: celebre e encoraje a manter.
Se adesão entre 50-79%: seja empática, sem julgamento, sugira dicas simples.
Se adesão < 50%: acolha sem culpa, pergunte se está tudo bem, ofereça ajuda.

Responda APENAS com a mensagem para o usuário. Sem JSON. Texto simples.
```

---

### Resumo Semanal Proativo (automático)

Enviado toda segunda-feira às 08:00 para todos os usuários com onboarded = true.

Lógica:
- Calcular para os últimos 7 dias (seg a dom):
  - Total de doses esperadas por medicamento
  - Total de doses confirmadas por medicamento
  - Percentual de adesão geral
  - Estoque atual de cada medicamento

- Dados calculados pelo código → Claude formata em linguagem natural

Prompt para Claude (resumo semanal):
```
Você é a Nami. Monte um resumo semanal caloroso e motivador para o usuário.

Dados da semana:
{dados_json}

Nome do usuário: {nome}

Formato esperado:
- Saudação personalizada com o nome
- Resumo de adesão (quantos % das doses tomou)
- Lista de medicamentos com estoque
- Frase motivadora ao final

Seja breve, calorosa e clara. Responda APENAS com a mensagem. Sem JSON.
```

---

## Arquivo: src/agentes/relatorios.js

```javascript
import Anthropic from '@anthropic-ai/sdk';
import {
  getDosesHoje,
  getMedicamentosAtivos,
  getEstoque,
  getProximosMedicamentos,
  getAdesaoPeriodo
} from '../database.js';
import { sendTextMessage } from '../whatsapp.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Classificador de intenção de relatório
export function classificarIntencaoRelatorio(message) {
  const msg = message.toLowerCase().trim();

  const padroes = {
    'tomei_hoje': [
      'tomei hoje', 'já tomei', 'tomei alguma', 'registrei hoje',
      'esqueci de tomar hoje', 'já tomei meus', 'tomei tudo'
    ],
    'meus_remedios': [
      'quais meus remédios', 'que remédios tenho', 'o que tenho cadastrado',
      'quais remédios eu tomo', 'me mostra meus remédios', 'meus remédios',
      'lista meus', 'remédios cadastrados'
    ],
    'estoque': [
      'quanto tenho', 'tô ficando sem', 'quando preciso comprar',
      'quanto sobrou', 'falta muito', 'meu estoque', 'preciso comprar'
    ],
    'proximo_remedio': [
      'que tomar agora', 'próximo remédio', 'tenho remédio pra tomar',
      'esqueci de tomar alguma', 'que remédio tomo', 'o que devo tomar',
      'qual o próximo', 'devo tomar agora'
    ],
    'adesao': [
      'esqueci muito', 'tenho esquecido', 'minha adesão', 'tô tomando direitinho',
      'doses perdi', 'faltei alguma dose', 'como tá meu histórico',
      'tô me cuidando', 'quantas vezes esqueci', 'minha adesão tá'
    ]
  };

  for (const [tipo, termos] of Object.entries(padroes)) {
    if (termos.some(t => msg.includes(t))) return tipo;
  }

  return null;
}

export async function handleRelatorios({ user, message }) {
  const intencao = classificarIntencaoRelatorio(message);

  switch (intencao) {
    case 'tomei_hoje':
      return await relatorioTomeiHoje(user);
    case 'meus_remedios':
      return await relatorioMeusRemedios(user);
    case 'estoque':
      return await relatorioEstoque(user);
    case 'proximo_remedio':
      return await relatorioProximoRemedio(user);
    case 'adesao':
      return await relatorioAdesao(user, message);
    default:
      return null; // não reconheceu — volta para agente_principal
  }
}

// ── RELATÓRIO: TOMEI HOJE ────────────────────────────────────
async function relatorioTomeiHoje(user) {
  const firstName = user.name?.split(' ')[0] || 'você';
  const { tomadas, pendentes } = await getDosesHoje(user.id);

  if (tomadas.length === 0 && pendentes.length === 0) {
    return `Não encontrei nenhum lembrete registrado para hoje, ${firstName}. Seus próximos remédios vão aparecer aqui conforme os horários chegarem! 💊`;
  }

  let msg = `✅ Registro de hoje, ${firstName}!\n\n`;

  for (const dose of tomadas) {
    const hora = new Date(dose.taken_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    msg += `✅ ${dose.med_nome} — tomado às ${hora}\n`;
  }

  for (const dose of pendentes) {
    msg += `⏳ ${dose.med_nome} — ainda não registrado`;
    if (dose.horario) msg += ` (horário: ${dose.horario.substring(0, 5)})`;
    msg += '\n';
  }

  return msg.trim();
}

// ── RELATÓRIO: MEUS REMÉDIOS ─────────────────────────────────
async function relatorioMeusRemedios(user) {
  const firstName = user.name?.split(' ')[0] || 'você';
  const medications = await getMedicamentosAtivos(user.id);

  if (medications.length === 0) {
    return `Você ainda não tem remédios cadastrados, ${firstName}. Quer cadastrar agora? 💊`;
  }

  let msg = `💊 Seus remédios cadastrados, ${firstName}:\n\n`;

  medications.forEach((med, i) => {
    const horarios = med.schedules?.filter(s => s.ativo).map(s => s.horario.substring(0, 5)).join(' e ') || 'sem horário';
    const forma = med.forma_farmaceutica || 'comprimido';
    msg += `${i + 1}. *${med.nome}* — ${med.dosagem} (${forma})\n`;
    msg += `   ⏰ ${horarios}\n\n`;
  });

  return msg.trim();
}

// ── RELATÓRIO: ESTOQUE ───────────────────────────────────────
async function relatorioEstoque(user) {
  const firstName = user.name?.split(' ')[0] || 'você';
  const estoque = await getEstoque(user.id);

  if (estoque.length === 0) {
    return `Você ainda não tem remédios cadastrados, ${firstName}. 💊`;
  }

  let msg = `📦 Estoque dos seus remédios, ${firstName}:\n\n`;

  for (const med of estoque) {
    if (med.estoque_atual <= 0) {
      msg += `🚨 *${med.nome}* — sem estoque! Compre com urgência\n`;
    } else if (med.estoque_atual <= med.estoque_minimo) {
      msg += `⚠️ *${med.nome}* — ${med.estoque_atual} unidades (hora de comprar mais!)\n`;
    } else {
      msg += `✅ *${med.nome}* — ${med.estoque_atual} unidades\n`;
    }
  }

  return msg.trim();
}

// ── RELATÓRIO: PRÓXIMO REMÉDIO ───────────────────────────────
async function relatorioProximoRemedio(user) {
  const firstName = user.name?.split(' ')[0] || 'você';
  const { passados, agora, proximos } = await getProximosMedicamentos(user.id);

  if (passados.length === 0 && agora.length === 0 && proximos.length === 0) {
    return `Não encontrei remédios agendados para hoje, ${firstName}. 💊`;
  }

  let msg = `⏰ Seus remédios de hoje, ${firstName}:\n\n`;

  for (const med of passados) {
    const status = med.confirmado ? '✅' : '⚠️';
    msg += `${status} *${med.nome}* (${med.horario}) — ${med.confirmado ? 'já registrado' : 'não registrado'}\n`;
  }

  for (const med of agora) {
    msg += `💊 *${med.nome}* (${med.horario}) — está na hora de tomar!\n`;
  }

  for (const med of proximos) {
    msg += `🔜 *${med.nome}* — próximo às ${med.horario}\n`;
  }

  return msg.trim();
}

// ── RELATÓRIO: ADESÃO (Claude) ───────────────────────────────
async function relatorioAdesao(user, message) {
  const firstName = user.name?.split(' ')[0] || 'você';
  const dados = await getAdesaoPeriodo(user.id, 7);

  const prompt = `Você é a Nami, assistente de saúde calorosa e empática.

Responda sobre a adesão ao tratamento do usuário com base nos dados abaixo.

Nome: ${firstName}
Período: últimos 7 dias
Doses esperadas: ${dados.totalEsperado}
Doses confirmadas: ${dados.totalConfirmado}
Percentual de adesão: ${dados.percentual}%
Medicamento com menor adesão: ${dados.piorMedicamento || 'nenhum'}

Regras:
- Se adesão >= 80%: celebre e encoraje a manter o ritmo
- Se adesão entre 50-79%: seja empática, sem julgamento, dê uma dica simples
- Se adesão < 50%: acolha sem culpa, pergunte se está tudo bem, ofereça ajuda
- Seja breve (máximo 4 linhas)
- Responda APENAS com a mensagem para o usuário. Sem JSON. Texto simples.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim();
}

// ── RESUMO SEMANAL (chamado pelo scheduler) ──────────────────
export async function enviarResumoSemanal(user) {
  const firstName = user.name?.split(' ')[0] || 'você';
  const dados = await getAdesaoPeriodo(user.id, 7);
  const estoque = await getEstoque(user.id);

  const dadosFormatados = {
    adesao_percentual: dados.percentual,
    doses_esperadas: dados.totalEsperado,
    doses_confirmadas: dados.totalConfirmado,
    medicamentos: estoque.map(m => ({
      nome: m.nome,
      estoque: m.estoque_atual,
      status: m.estoque_atual <= m.estoque_minimo ? 'baixo' : 'ok'
    }))
  };

  const prompt = `Você é a Nami, assistente de saúde calorosa.

Monte um resumo semanal breve e motivador para ${firstName}.

Dados da semana passada:
${JSON.stringify(dadosFormatados, null, 2)}

Formato:
1. Saudação com o nome
2. Resumo da adesão (% das doses tomadas) — celebre ou encoraje conforme o resultado
3. Status do estoque (só mencione se algum estiver baixo)
4. Frase motivadora curta

Seja calorosa, breve (máximo 6 linhas) e clara.
Responda APENAS com a mensagem. Sem JSON. Texto simples.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  const mensagem = response.content[0].text.trim();
  await sendTextMessage(user.phone, mensagem);
  console.log(`📊 Resumo semanal enviado para ${user.phone}`);
}
```

---

## Funções novas no database.js

```javascript
// Doses de hoje — separadas em tomadas e pendentes
export async function getDosesHoje(userId) {
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  // Doses confirmadas hoje
  const { data: tomadas } = await supabase
    .from('dose_logs')
    .select('*, medications(nome, user_id)')
    .eq('confirmed', true)
    .gte('taken_at', new Date().toISOString().split('T')[0] + 'T00:00:00Z')
    .eq('medications.user_id', userId);

  // Schedules ativos sem dose confirmada hoje
  const medications = await getUserMedications(userId);
  const tomadosIds = (tomadas || []).map(d => d.medication_id);

  const pendentes = [];
  for (const med of medications) {
    if (!tomadosIds.includes(med.id)) {
      const schedules = med.schedules?.filter(s => s.ativo) || [];
      if (schedules.length > 0) {
        pendentes.push({
          med_nome: med.nome,
          medication_id: med.id,
          horario: schedules[0].horario
        });
      }
    }
  }

  return {
    tomadas: (tomadas || []).filter(d => d.medications?.user_id === userId).map(d => ({
      med_nome: d.medications.nome,
      taken_at: d.taken_at
    })),
    pendentes
  };
}

// Medicamentos ativos (alias mais semântico)
export async function getMedicamentosAtivos(userId) {
  return getUserMedications(userId); // já existe — apenas expor com nome semântico
}

// Estoque de todos os medicamentos ativos
export async function getEstoque(userId) {
  const { data } = await supabase
    .from('medications')
    .select('id, nome, estoque_atual, estoque_minimo, forma_farmaceutica')
    .eq('user_id', userId)
    .eq('ativo', true);
  return data || [];
}

// Próximos medicamentos com base no horário atual
export async function getProximosMedicamentos(userId) {
  const agora = new Date();
  const horaAtual = agora.toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
  }); // "HH:MM"

  const medications = await getUserMedications(userId);
  const dosesHoje = await getDosesHoje(userId);
  const tomadosIds = dosesHoje.tomadas.map(d => d.medication_id);

  const passados = [], agoraList = [], proximos = [];

  for (const med of medications) {
    for (const schedule of (med.schedules || []).filter(s => s.ativo)) {
      const horario = schedule.horario.substring(0, 5);
      const confirmado = tomadosIds.includes(med.id);
      const diff = minutesDiff(horaAtual, horario);

      if (diff < -120) {
        passados.push({ nome: med.nome, horario, confirmado });
      } else if (diff >= -120 && diff <= 30) {
        agoraList.push({ nome: med.nome, horario, confirmado });
      } else {
        proximos.push({ nome: med.nome, horario });
      }
    }
  }

  return { passados, agora: agoraList, proximos };
}

// Diferença em minutos entre dois horários HH:MM
function minutesDiff(horaAtual, horarioAlvo) {
  const [hA, mA] = horaAtual.split(':').map(Number);
  const [hT, mT] = horarioAlvo.split(':').map(Number);
  return (hT * 60 + mT) - (hA * 60 + mA);
}

// Adesão em um período (dias)
export async function getAdesaoPeriodo(userId, dias = 7) {
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);

  const medications = await getUserMedications(userId);

  let totalEsperado = 0;
  let totalConfirmado = 0;
  let piorMedicamento = null;
  let piorPercentual = 100;

  for (const med of medications) {
    const schedulesAtivos = (med.schedules || []).filter(s => s.ativo).length;
    const esperado = schedulesAtivos * dias;
    totalEsperado += esperado;

    const { data: confirmadas } = await supabase
      .from('dose_logs')
      .select('id')
      .eq('medication_id', med.id)
      .eq('confirmed', true)
      .gte('taken_at', desde.toISOString());

    const confirmado = (confirmadas || []).length;
    totalConfirmado += confirmado;

    if (esperado > 0) {
      const pct = Math.round((confirmado / esperado) * 100);
      if (pct < piorPercentual) {
        piorPercentual = pct;
        piorMedicamento = med.nome;
      }
    }
  }

  const percentual = totalEsperado > 0
    ? Math.round((totalConfirmado / totalEsperado) * 100)
    : 0;

  return { totalEsperado, totalConfirmado, percentual, piorMedicamento };
}

// Buscar todos os usuários onboarded (para resumo semanal)
export async function getUsuariosAtivos() {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('onboarded', true);
  return data || [];
}
```

---

## Atualização do router.js

Adicionar detecção de intenção de relatório antes do agente_principal:

```javascript
import { handleRelatorios, classificarIntencaoRelatorio } from './agentes/relatorios.js';

// Dentro de routeMessage(), antes do bloco "else" do agente principal:
} else if (currentState === 'idle' && classificarIntencaoRelatorio(message)) {
  agentName = 'relatorios';
  console.log(`📊 Roteando para relatorios — ${user.phone}`);
  const resultado = await handleRelatorios({ user, message });

  if (resultado) {
    response = resultado;
  } else {
    // Classificador não reconheceu — cai no principal
    agentName = 'principal';
    response = await handlePrincipal({ user, message, image });
  }
}
```

---

## Atualização do scheduler.js

Adicionar envio de resumo semanal toda segunda-feira às 08h:

```javascript
import { enviarResumoSemanal } from './agentes/relatorios.js';
import { getUsuariosAtivos } from './database.js';

// Dentro de startScheduler(), adicionar novo cron:
// Toda segunda-feira às 08:00 (horário de Brasília)
cron.schedule('0 8 * * 1', async () => {
  console.log('📊 Enviando resumos semanais...');
  try {
    const usuarios = await getUsuariosAtivos();
    for (const user of usuarios) {
      await enviarResumoSemanal(user);
      await sleep(2000); // pausa entre envios
    }
  } catch (error) {
    console.error('❌ Erro ao enviar resumos semanais:', error.message);
  }
}, { timezone: 'America/Sao_Paulo' });
```

---

## Ordem de implementação

1. Adicionar funções novas ao `database.js`
2. Criar `src/agentes/relatorios.js`
3. Atualizar `src/router.js` para rotear para agente_relatorios
4. Atualizar `src/scheduler.js` para resumo semanal
5. Testar cada consulta individualmente no WhatsApp
6. Aguardar próxima segunda-feira para validar resumo semanal (ou testar manualmente)

---

## Critérios de sucesso

- "Tomei hoje?" retorna lista correta de doses tomadas e pendentes
- "Quais meus remédios?" lista medicamentos ativos com horários
- "Quanto estoque tenho?" mostra status com alerta para estoque baixo
- "O que devo tomar agora?" contextualiza com base no horário atual
- "Tenho esquecido muito?" recebe resposta empática com percentual real
- Resumo semanal enviado automaticamente toda segunda às 08h
- Agente principal não é afetado — sem regressão
- Consultas não reconhecidas caem corretamente no agente_principal