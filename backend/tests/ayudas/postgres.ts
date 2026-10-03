import pg from 'pg';
import { migrar } from '../../src/infraestructura/postgres/migrar.js';

export function crearPoolDeTest(): pg.Pool {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  if (!url.includes('test')) throw new Error(`Por seguridad, los tests solo corren contra una base *test*: ${url}`);
  return new pg.Pool({ connectionString: url });
}

/** Borra todo el esquema y lo vuelve a migrar desde cero. */
export async function reiniciarBase(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrar(pool);
}
