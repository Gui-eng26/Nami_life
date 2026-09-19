// ============================================================
// CLASSIFICADOR DE FALHA — camada 2 do modelo canônico (v44 M2 —
// endereço novo do MH-073 Parte B.1; a LÓGICA não mudou)
//
// Roda SÓ quando a camada 1 (validador do campo corrente) falhou.
// Não julga domínio — julga POR QUE a mensagem não foi reconhecida.
// É a base do contrato universal de devolução do runner (M2 §2.4):
// finalizou / ruído / dúvida / mudou de fluxo → devolve.
// ============================================================

import { formatarHistoricoConversa } from '../database.js';
import { classificarPalavra } from './llm.js';

export async function classificarIndeterminadoCadastro({ message, etapa, nomeMedicamento, historicoConversa = [] }) {
    const systemPrompt = `Você é um classificador para uma assistente de saúde via WhatsApp (a Nami),
que está no meio do cadastro de um medicamento${nomeMedicamento ? ` ("${nomeMedicamento}")` : ''} e fez
uma pergunta ao usuário. A mensagem do usuário NÃO foi reconhecida como resposta a essa pergunta.

Classifique-a em UMA destas categorias:

- recusa: o usuário não quer continuar o cadastro agora, está incomodado, ou pede para parar.
  Ex: "não quero mais", "chega", "deixa isso pra depois", "para com isso".
- duvida: o usuário pergunta o motivo da pergunta ou questiona a necessidade dela, sem recusar
  e sem mudar de assunto. Ex: "pra que você precisa disso?", "por que essa pergunta?",
  "isso é obrigatório?".
- nova_intencao: o usuário quer fazer OUTRA COISA, FORA do cadastro de medicamento.
  Ex: "quero ver meus remédios", "qual meu estoque de atenolol?", "tomei o remédio das 8",
  "quero pausar os lembretes da dipirona", "quanto tempo falta pro meu tratamento acabar".
  ATENÇÃO — o seguinte NÃO é nova_intencao, é ruido:
    * corrigir qualquer informação DO PRÓPRIO cadastro em andamento (nome do remédio,
      dosagem, horário, quantidade, estoque);
    * dizer que o medicamento está errado ou que quer cadastrar outro
      (ex: "não é esse remédio, é outro", "na verdade é o losartana");
    * qualquer coisa que continue sendo sobre o cadastro que está acontecendo agora.
- ruido: a mensagem não se encaixa em nenhuma das anteriores — resposta confusa,
  incompreensível, fora de contexto, ou que simplesmente não responde à pergunta.

CONVERSA RECENTE:
${formatarHistoricoConversa(historicoConversa)}

ETAPA ATUAL DO CADASTRO: ${etapa}

MENSAGEM ATUAL: "${message}"

Responda APENAS com uma palavra: recusa, duvida, nova_intencao ou ruido.
Sem pontuação, sem explicação.`;

    const achado = await classificarPalavra({
        systemPrompt, message,
        validos: ['recusa', 'duvida', 'nova_intencao', 'ruido'],
        motivo: 'classificador_falha_indeterminado',
        detalheExtra: { etapa },
        fallback: 'ruido'
    });
    console.log(`🔎 [CAD-CLASSIF] classificarIndeterminadoCadastro -> ${achado} (etapa: ${etapa})`);
    return achado;
}
