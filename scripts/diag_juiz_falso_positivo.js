// DIAGNÓSTICO — read-only. Não escreve em nenhuma tabela.
import 'dotenv/config';
import { coletarEpisodios, enriquecerEpisodio, julgarEpisodio, formatarEpisodioParaPrompt } from '../src/juizOffline.js';

const LOG_ALVO = '5a59f39a-24f3-4c1f-b582-2552a8b8db51';
const NOTA_ESPERADA =
    'CONTEXTO: lembrete automático de Elani (07:00:00) enviado 10 min antes deste turno.';

async function main() {
    // Mesma janela que o cron usou: dia 29/07 completo em UTC
    const episodios = await coletarEpisodios({
        dataInicio: '2026-07-29T00:00:00.000Z',
        dataFim:    '2026-07-30T00:00:00.000Z'
    });
    console.log(`episódios coletados: ${episodios.length}`);

    const alvo = episodios.find(e => e.primeiroLogId === LOG_ALVO);
    if (!alvo) {
        console.log('❌ episódio alvo não encontrado — reportar e parar');
        return;
    }
    console.log(`episódio alvo: ${alvo.turnos.length} turno(s), userId ${alvo.userId}`);

    // ---- H1: a nota foi produzida? ----
    const enriquecido = await enriquecerEpisodio(alvo);
    console.log('\n===== RESULTADO H1 =====');
    console.log('notaLembrete:', JSON.stringify(enriquecido.notaLembrete));
    console.log('notaPorTurno:', [...enriquecido.notaPorTurno.entries()]);

    // ---- H2: com a nota forçada, o veredito muda? ----
    const comNota = { ...enriquecido, notaLembrete: NOTA_ESPERADA };
    const semNota = { ...enriquecido, notaLembrete: null };

    console.log('\n===== VARIANTE A — SEM nota (3 execuções) =====');
    for (let i = 1; i <= 3; i++) {
        console.log(`A${i}:`, JSON.stringify(await julgarEpisodio(semNota)));
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log('\n===== VARIANTE B — COM nota (3 execuções) =====');
    for (let i = 1; i <= 3; i++) {
        console.log(`B${i}:`, JSON.stringify(await julgarEpisodio(comNota)));
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log('\n===== PROMPT ENVIADO (variante B) =====\n', formatarEpisodioParaPrompt(comNota));
}

main().catch(e => console.error('erro no diagnóstico:', e));
