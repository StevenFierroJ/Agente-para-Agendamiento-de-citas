import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrar } from '../src/infraestructura/postgres/migrar.js';
import { EmbeddingE5 } from '../src/infraestructura/embeddings/e5.js';
import { ESPECIALIDADES, PROFESIONALES, SEDES, generarBloques, resolverPrimerDia } from './agenda.js';
import { sembrarDocumentos } from './documentos.js';

export interface ResumenSeed {
  primerDia: string;
  horariosNuevos: number;
}

/**
 * Carga sedes, especialidades, profesionales y 14 días de horarios.
 * Idempotente: todo se inserta con ON CONFLICT DO NOTHING sobre llaves naturales,
 * así que correrlo dos veces no duplica. Correrlo otro día agrega los días nuevos.
 */
export async function sembrarAgenda(pool: pg.Pool, seedDesde: string | undefined): Promise<ResumenSeed> {
  const primerDia = resolverPrimerDia(seedDesde);
  const bloques = generarBloques(PROFESIONALES, primerDia);

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(
      'INSERT INTO sedes (nombre) SELECT unnest($1::text[]) ON CONFLICT (nombre) DO NOTHING',
      [SEDES],
    );
    await cliente.query(
      'INSERT INTO especialidades (nombre) SELECT unnest($1::text[]) ON CONFLICT (nombre) DO NOTHING',
      [ESPECIALIDADES],
    );
    await cliente.query(
      `INSERT INTO profesionales (nombre, especialidad_id)
       SELECT p.nombre, e.id
         FROM unnest($1::text[], $2::text[]) AS p (nombre, especialidad)
         JOIN especialidades e ON e.nombre = p.especialidad
       ON CONFLICT (nombre) DO NOTHING`,
      [PROFESIONALES.map((p) => p.nombre), PROFESIONALES.map((p) => p.especialidad)],
    );
    const resultado = await cliente.query(
      `INSERT INTO horarios (profesional_id, sede_id, inicio, fin)
       SELECT p.id, s.id, b.inicio, b.fin
         FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])
              AS b (profesional, sede, inicio, fin)
         JOIN profesionales p ON p.nombre = b.profesional
         JOIN sedes s ON s.nombre = b.sede
       ON CONFLICT (profesional_id, inicio) DO NOTHING`,
      [
        bloques.map((b) => b.profesional),
        bloques.map((b) => b.sede),
        bloques.map((b) => b.inicio),
        bloques.map((b) => b.fin),
      ],
    );
    await cliente.query('COMMIT');
    return { primerDia: primerDia.toISODate() ?? '', horariosNuevos: resultado.rowCount ?? 0 };
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('Falta la variable de entorno DATABASE_URL');
  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrar(pool);
    const resumen = await sembrarAgenda(pool, process.env['SEED_DESDE']);
    console.log(`Agenda desde ${resumen.primerDia}: ${resumen.horariosNuevos} horarios nuevos`);
    console.log('Indexando documentos con multilingual-e5-small (fuera de Docker, la primera vez descarga el modelo, ~118 MB)…');
    const docs = await sembrarDocumentos(pool, new EmbeddingE5());
    console.log(`Documentos: ${docs.indexados.length} indexados, ${docs.sinCambios.length} sin cambios, ${docs.eliminados} eliminados`);
  } finally {
    await pool.end();
  }
}
