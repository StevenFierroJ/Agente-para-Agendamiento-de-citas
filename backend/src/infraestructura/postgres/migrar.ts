import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DIRECTORIO_MIGRACIONES = fileURLToPath(new URL('../../../migraciones/', import.meta.url));

// Llave arbitraria del bloqueo consultivo que impide dos migraciones a la vez.
const LLAVE_BLOQUEO_MIGRACIONES = 7_301_001;

/**
 * Aplica, en orden, los archivos `NNN_nombre.sql` que aún no se han aplicado.
 * Cada archivo corre en su propia transacción: o entra completo o no entra.
 * Devuelve los nombres de los archivos aplicados en esta corrida.
 */
export async function migrar(pool: pg.Pool): Promise<string[]> {
  const cliente = await pool.connect();
  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [LLAVE_BLOQUEO_MIGRACIONES]);
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
        nombre      text PRIMARY KEY,
        aplicada_en timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await cliente.query<{ nombre: string }>('SELECT nombre FROM migraciones_aplicadas');
    const yaAplicadas = new Set(rows.map((fila) => fila.nombre));

    const archivos = (await readdir(DIRECTORIO_MIGRACIONES))
      .filter((nombre) => /^\d{3}_.+\.sql$/.test(nombre))
      .sort();

    const aplicadas: string[] = [];
    for (const archivo of archivos) {
      if (yaAplicadas.has(archivo)) continue;
      const sql = await readFile(path.join(DIRECTORIO_MIGRACIONES, archivo), 'utf8');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migraciones_aplicadas (nombre) VALUES ($1)', [archivo]);
        await cliente.query('COMMIT');
      } catch (error) {
        await cliente.query('ROLLBACK');
        throw new Error(`La migración ${archivo} falló`, { cause: error });
      }
      aplicadas.push(archivo);
    }
    return aplicadas;
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [LLAVE_BLOQUEO_MIGRACIONES]);
    cliente.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('Falta la variable de entorno DATABASE_URL');
  const pool = new pg.Pool({ connectionString: url });
  try {
    const aplicadas = await migrar(pool);
    console.log(aplicadas.length ? `Migraciones aplicadas: ${aplicadas.join(', ')}` : 'Sin migraciones pendientes');
  } finally {
    await pool.end();
  }
}
