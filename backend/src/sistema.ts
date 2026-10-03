import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Herramienta, LlmClient } from './aplicacion/puertos.js';
import { iniciarTrabajador, type Trabajador } from './aplicacion/trabajador.js';
import { crearApi } from './http/api.js';
import { iniciarCola, type OpcionesCola } from './infraestructura/cola/cola.js';
import { AlmacenMongo, conectarMongo, type Mongo } from './infraestructura/mongo/mongo.js';
import { AgendaPostgres } from './infraestructura/postgres/agenda.js';
import { RepositorioMensajesPostgres } from './infraestructura/postgres/mensajes.js';
import type { Agenda, RepositorioMensajes } from './aplicacion/puertos.js';
import type { Registro } from './infraestructura/registro.js';

export interface OpcionesSistema {
  databaseUrl: string;
  mongoUrl: string;
  registro: Registro;
  /** Si se pasa, se levanta el trabajador con este LLM. */
  trabajador?: {
    llm: LlmClient;
    /** Recibe la agenda del sistema: las herramientas consultan la misma base. */
    crearHerramientas: (dependencias: { agenda: Agenda; mensajes: RepositorioMensajes; pool: pg.Pool }) => ReadonlyMap<string, Herramienta>;
    timeoutMs: number;
    maxIteraciones: number;
    precios: { entrada: number; salida: number } | null;
    concurrencia: number;
  };
  cola?: OpcionesCola;
}

export interface Sistema {
  pool: pg.Pool;
  mongo: Mongo;
  boss: PgBoss;
  api: FastifyInstance;
  trabajador: Trabajador | null;
  detener(): Promise<void>;
}

/**
 * Arma el sistema con sus dependencias inyectadas. `api.ts` y `trabajador.ts`
 * la llaman con la configuración real; los tests y el harness, con el LLM falso.
 */
export async function levantarSistema(opciones: OpcionesSistema): Promise<Sistema> {
  const cola = opciones.cola ?? { reintentos: 3 };
  const pool = new pg.Pool({ connectionString: opciones.databaseUrl, max: 20 });
  const mongo = await conectarMongo(opciones.mongoUrl);
  const boss = await iniciarCola(opciones.databaseUrl, cola);
  const api = crearApi({ pool, boss, mongo, registro: opciones.registro });

  const trabajador = opciones.trabajador
    ? await iniciarTrabajador(
        boss,
        {
          llm: opciones.trabajador.llm,
          herramientas: opciones.trabajador.crearHerramientas({ agenda: new AgendaPostgres(pool), mensajes: new RepositorioMensajesPostgres(pool), pool }),
          timeoutMs: opciones.trabajador.timeoutMs,
          maxIteraciones: opciones.trabajador.maxIteraciones,
          precios: opciones.trabajador.precios,
          mensajes: new RepositorioMensajesPostgres(pool),
          almacen: new AlmacenMongo(mongo),
          registro: opciones.registro,
        },
        { ...cola, concurrencia: opciones.trabajador.concurrencia },
      )
    : null;

  return {
    pool,
    mongo,
    boss,
    api,
    trabajador,
    async detener() {
      await trabajador?.detener();
      await api.close();
      await boss.stop({ graceful: true, timeout: 5_000 });
      await mongo.cerrar();
      await pool.end();
    },
  };
}
