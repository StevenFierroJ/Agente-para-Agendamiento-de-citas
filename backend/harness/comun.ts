import { setTimeout as esperar } from 'node:timers/promises';
import { DateTime } from 'luxon';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { ZONA_COLOMBIA } from '../src/dominio/fechas.js';
import { migrar } from '../src/infraestructura/postgres/migrar.js';
import { sembrarAgenda } from '../seed/seed.js';

export const URL_POSTGRES_HARNESS = process.env['HARNESS_DATABASE_URL'] ?? 'postgres://agenda:agenda@localhost:5432/agenda_harness';
export const URL_MONGO_HARNESS = process.env['HARNESS_MONGO_URL'] ?? 'mongodb://localhost:27017/agenda_harness';

/** El harness borra todo: solo corre contra bases cuyo nombre lo dice. */
export function verificarBasesDelHarness(): void {
  for (const url of [URL_POSTGRES_HARNESS, URL_MONGO_HARNESS]) {
    if (!url.includes('harness')) throw new Error(`Por seguridad, el harness solo corre contra bases *harness*: ${url}`);
  }
}

/** Esquema desde cero, cola vacía, agenda sembrada desde `seedDesde`, MongoDB vacío. */
export async function prepararBasesDelHarness(seedDesde: string): Promise<void> {
  verificarBasesDelHarness();
  const pool = new pg.Pool({ connectionString: URL_POSTGRES_HARNESS });
  try {
    await pool.query('DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrar(pool);
    await sembrarAgenda(pool, seedDesde);
  } finally {
    await pool.end();
  }
  const mongo = new MongoClient(URL_MONGO_HARNESS);
  try {
    await mongo.connect();
    await mongo.db().dropDatabase();
  } finally {
    await mongo.close();
  }
}

export interface RefHorario {
  especialidad: string;
  sede: string;
  inicio: string; // YYYY-MM-DDTHH:mm en hora de Colombia
}

/** El id del horario que nombra la referencia. Falla si no existe: el caso está mal escrito. */
export async function resolverHorario(pool: pg.Pool, ref: RefHorario): Promise<number> {
  const inicio = DateTime.fromISO(ref.inicio, { zone: ZONA_COLOMBIA });
  const { rows } = await pool.query<{ id: number }>(
    `SELECT h.id FROM horarios h
       JOIN profesionales p ON p.id = h.profesional_id
       JOIN especialidades e ON e.id = p.especialidad_id
       JOIN sedes s ON s.id = h.sede_id
      WHERE e.nombre = $1 AND s.nombre = $2 AND h.inicio = $3
      ORDER BY h.id LIMIT 1`,
    [ref.especialidad, ref.sede, inicio.toJSDate()],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`No hay horario ${ref.especialidad} / ${ref.sede} / ${ref.inicio}`);
  return id;
}

/** Reemplaza cada `{ "$horario": {...} }` por su id, a cualquier profundidad. */
export async function resolverReferencias(pool: pg.Pool, valor: unknown): Promise<unknown> {
  if (Array.isArray(valor)) return Promise.all(valor.map((v) => resolverReferencias(pool, v)));
  if (valor === null || typeof valor !== 'object') return valor;
  const objeto = valor as Record<string, unknown>;
  if ('$horario' in objeto) return resolverHorario(pool, objeto['$horario'] as RefHorario);
  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(objeto)) salida[clave] = await resolverReferencias(pool, v);
  return salida;
}

/** Espera a que los mensajes terminen (`procesado` o `fallido`). Devuelve los que no terminaron. */
export async function esperarProcesados(pool: pg.Pool, messageIds: readonly string[], timeoutMs: number): Promise<string[]> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ message_id: string }>(
      `SELECT message_id FROM mensajes_entrantes WHERE message_id = ANY($1) AND estado IN ('procesado', 'fallido')`,
      [messageIds],
    );
    const terminados = new Set(rows.map((r) => r.message_id));
    const pendientes = messageIds.filter((id) => !terminados.has(id));
    if (pendientes.length === 0 || Date.now() > limite) return pendientes;
    await esperar(50);
  }
}

export function sello(): string {
  return DateTime.now().toFormat('yyyyMMdd-HHmmss');
}
