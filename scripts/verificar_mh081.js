import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
    .from('dose_logs')
    .select(`
        id, schedule_id, horario_agendado,
        medications ( nome, forma_farmaceutica, unidade_dose ),
        schedules!dose_logs_schedule_id_fkey ( quantidade_por_dose )
    `)
    .not('schedule_id', 'is', null)
    .limit(5);

if (error) {
    console.error('❌ EMBED FALHOU:', error.message);
    process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
