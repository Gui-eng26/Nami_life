// ============================================================
// SCHEMA DE PERFIL (v44 M3 P2 — MH-75)
//
// Segundo schema do runner: dados pessoais do usuário — nome e data
// de nascimento — editáveis DEPOIS do onboarding, no MESMO modo de
// correção do runner que edita o cadastro de tratamento. Reaproveita
// o validador de data existente (dataNascimento.js) — nenhuma
// pergunta nova fora do schema.
//
// Caminho de remediação do BUG-030 (nome gravado errado).
// ============================================================

import { extrairComponenteData, montarDataNascimento } from '../dataNascimento.js';

// Nome de pessoa plausível: só letras/espaços/apóstrofo-hífen, 2+ caracteres,
// nunca uma pergunta nem um número.
export function nomePessoaPlausivel(texto) {
    const t = String(texto || '').trim();
    if (t.length < 2 || t.length > 80) return false;
    if (/[?0-9]/.test(t)) return false;
    return /^[a-zà-úA-ZÀ-Ú][a-zà-úA-ZÀ-Ú'\- ]+$/.test(t);
}

// Palavras de PEDIDO, nunca de nome — "Corrigir meu nome" virou o nome do
// usuário no replay de 20/09 (João → "Corrigir meu nome"); o candidato passa
// por este veto SEMPRE, mesmo vindo de marcador.
const RE_NAO_E_NOME = /\b(corrig\w*|mudar?|trocar?|alterar?|atualizar?|nome|cadastr\w*|errad\w*|quero|dados?|nascimento|perfil)\b/i;

// Guarda compartilhada com o onboarding (v44 M4, §1: "guardas do A26 valem
// aqui"): um candidato a nome só é aceito quando é plausível E não é palavra
// de pedido.
export function nomeUsuarioAceitavel(candidato) {
    return nomePessoaPlausivel(candidato) && !RE_NAO_E_NOME.test(candidato);
}

// Validador do campo nome (contrato dos validadores de campo do runner).
// O valor SÓ é aceito de um marcador explícito ("me chamo X", "meu nome é X",
// "pode me chamar de X", "para X") — ou da mensagem inteira quando a Nami
// ACABOU de perguntar o nome (valorLivre). Sem isso, pergunta — nunca escreve
// por dedução.
function validarNomePessoa({ message, valorLivre = false }) {
    const m = String(message).match(/(?:me chamo|meu nome (?:é|e)|(?:pode )?me chamar? de|para|pra)\s+(.+)$/i);
    const candidato = (m ? m[1] : (valorLivre ? String(message) : '')).trim().replace(/[.!]+$/, '');
    if (candidato && nomePessoaPlausivel(candidato) && !RE_NAO_E_NOME.test(candidato)) {
        return { acao: 'valor', updates: { nome_usuario: candidato } };
    }
    return { acao: 'indeterminado', updates: {} };
}

// Validador do campo data de nascimento — reaproveita o extrator do onboarding.
function validarDataNascimento({ message }) {
    const componente = extrairComponenteData(message, 'dia');
    if (componente.tipo === 'data_completa') {
        const montagem = montarDataNascimento(componente.valor);
        if (montagem.valida) {
            return { acao: 'valor', updates: { data_nascimento: montagem.iso } };
        }
        return { acao: 'data_invalida', updates: {} };
    }
    return { acao: 'indeterminado', updates: {} };
}

export const SCHEMA_PERFIL = {
    nome: 'perfil',
    estadoConversa: 'configurando',
    campos: [
        {
            nome: 'nome_usuario',
            rotulo: 'seu nome',
            validador: validarNomePessoa,
            pergunta: () => 'Como você quer que eu te chame? Me manda o nome certinho. 😊'
        },
        {
            nome: 'data_nascimento',
            rotulo: 'sua data de nascimento',
            validador: validarDataNascimento,
            pergunta: () => 'Qual a sua data de nascimento?\nPor exemplo: 19/03/1985'
        }
    ]
};

export function renderizarPerguntaQualDadoPessoal() {
    return 'Posso corrigir seu nome ou sua data de nascimento. 😊\n\nQual dos dois você quer ajustar?';
}

export function renderizarDataInvalida() {
    return 'Essa data não parece válida. 😊\n\nQual a sua data de nascimento?\nPor exemplo: 19/03/1985';
}

// Confirmação pós-escrita (regra 2): declara o ANTES → DEPOIS.
export function renderizarPerfilAtualizado({ campo, antes, depois }) {
    const rotulo = campo === 'nome_usuario' ? 'Nome' : 'Data de nascimento';
    const de = antes ? ` ${antes} →` : '';
    return `✏️ ${rotulo} atualizado:${de} *${depois}*. Se precisar de mais algum ajuste, é só me falar! 🌿`;
}
