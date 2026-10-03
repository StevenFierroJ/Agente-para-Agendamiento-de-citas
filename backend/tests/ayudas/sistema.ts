import { setTimeout as esperar } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import type pg from 'pg';
import type { Herramienta } from '../../src/aplicacion/puertos.js';
import { COLA_MENSAJES } from '../../src/infraestructura/cola/cola.js';
import { LlmGuionado } from '../../src/infraestructura/llm/falso.js';
import { registroSilencioso } from '../../src/infraestructura/registro.js';
import { levantarSistema, type Sistema } from '../../src/sistema.js';
import { sembrarAgenda } from '../../seed/seed.js';
import { crearPoolDeTest, reiniciarBase, urlPostgresDeTest } from './postgres.js';

export const SEED_DESDE_TESTS = '2026-10-05';

export function urlMongoDeTest(): string {
  const url = process.env['TEST_MONGO_URL'];
  if (!url?.includes('test')) throw new Error(`Por seguridad, los tests solo corren contra una base *test*: ${url}`);
  return url;
}

/** Base nueva: esquema migrado, agenda sembrada desde el lunes 5 de octubre y MongoDB vacío. */
export async function prepararBasesDeTest(): Promise<void> {
  const pool = crearPoolDeTest();
  try {
    await reiniciarBase(pool);
    await sembrarAgenda(pool, SEED_DESDE_TESTS);
  } finally {
    await pool.end();
  }
  const mongo = new MongoClient(urlMongoDeTest());
  try {
    await mongo.connect();
    await mongo.db().dropDatabase();
  } finally {
    await mongo.close();
  }
}

export interface OpcionesSistemaDeTest {
  llm?: LlmGuionado;
  herramientas?: ReadonlyMap<string, Herramienta>;
  conTrabajador?: boolean;
  reintentos?: number;
  concurrencia?: number;
  timeoutMs?: number;
}

export async function levantarSistemaDeTest(opciones: OpcionesSistemaDeTest = {}): Promise<{ sistema: Sistema; llm: LlmGuionado }> {
  const llm = opciones.llm ?? new LlmGuionado();
  const sistema = await levantarSistema({
    databaseUrl: urlPostgresDeTest(),
    mongoUrl: urlMongoDeTest(),
    registro: registroSilencioso,
    cola: { reintentos: opciones.reintentos ?? 3 },
    ...(opciones.conTrabajador === false
      ? {}
      : {
          trabajador: {
            llm,
            crearHerramientas: () => opciones.herramientas ?? new Map(),
            timeoutMs: opciones.timeoutMs ?? 2_000,
            maxIteraciones: 5,
            precios: { entrada: 0.3, salida: 2.5 },
            concurrencia: opciones.concurrencia ?? 5,
          },
        }),
  });
  return { sistema, llm };
}

/** Deja la agenda y vacía todo lo conversacional: citas, conversaciones, mensajes, cola y MongoDB. */
export async function limpiarConversaciones(sistema: Sistema): Promise<void> {
  await sistema.boss.deleteAllJobs(COLA_MENSAJES);
  await sistema.pool.query('TRUNCATE citas, mensajes_entrantes, conversaciones RESTART IDENTITY CASCADE');
  await Promise.all([sistema.mongo.mensajes.deleteMany({}), sistema.mongo.turnos.deleteMany({})]);
}

/** Espera a que todos los mensajes terminen (`procesado` o `fallido`). */
export async function esperarProcesados(pool: pg.Pool, messageIds: readonly string[], timeoutMs = 15_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ pendientes: string }>(
      `SELECT count(*) AS pendientes FROM mensajes_entrantes
        WHERE message_id = ANY($1) AND estado NOT IN ('procesado', 'fallido')`,
      [messageIds],
    );
    const { rows: existentes } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM mensajes_entrantes WHERE message_id = ANY($1)',
      [messageIds],
    );
    if (Number(rows[0]?.pendientes) === 0 && Number(existentes[0]?.n) === messageIds.length) return;
    if (Date.now() > limite) throw new Error(`Timeout esperando ${messageIds.join(', ')}`);
    await esperar(50);
  }
}

export function mensaje(messageId: string, texto = 'Hola', opciones: { from?: string; timestamp?: string } = {}) {
  return {
    message_id: messageId,
    from: opciones.from ?? '+573001112233',
    text: texto,
    timestamp: opciones.timestamp ?? '2026-10-05T14:00:00Z',
  };
}
