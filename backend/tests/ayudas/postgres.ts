import pg from 'pg';
import { migrar } from '../../src/infraestructura/postgres/migrar.js';

export function urlPostgresDeTest(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  if (!url.includes('test')) throw new Error(`Por seguridad, los tests solo corren contra una base *test*: ${url}`);
  return url;
}

export function crearPoolDeTest(): pg.Pool {
  return new pg.Pool({ connectionString: urlPostgresDeTest() });
}

/** Borra todo (incluida la cola) y vuelve a migrar desde cero. */
export async function reiniciarBase(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrar(pool);
}
