import { PgBoss } from 'pg-boss';
import type pg from 'pg';

export const COLA_MENSAJES = 'mensajes';

export interface TrabajoMensaje {
  messageId: string;
}

export interface OpcionesCola {
  /** Intentos adicionales tras el primero. El último no se deja fallar: ver trabajador. */
  reintentos: number;
}

export const OPCIONES_COLA_POR_DEFECTO: OpcionesCola = { reintentos: 3 };

/**
 * Una cola `key_strict_fifo` con `singletonKey` = conversación: la base garantiza
 * un solo trabajo activo por conversación y orden de llegada (D-03), entre todos
 * los trabajadores. Un trabajo activo, en reintento o fallido retiene a los que
 * siguen con la misma clave; por eso el trabajador nunca deja fallar el último
 * intento.
 */
export async function iniciarCola(connectionString: string, opciones: OpcionesCola = OPCIONES_COLA_POR_DEFECTO): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, max: 5 });
  boss.on('error', (error: unknown) => {
    console.error(JSON.stringify({ nivel: 'error', mensaje: 'pg-boss', error: String(error) }));
  });
  await boss.start();
  if (!(await boss.getQueue(COLA_MENSAJES))) {
    await boss.createQueue(COLA_MENSAJES, {
      policy: 'key_strict_fifo',
      retryLimit: opciones.reintentos,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 30,
      // Un turno puede durar minutos (5 iteraciones × 2 intentos × 20 s); el latido
      // lo mantiene vivo y libera en ~30 s el de un trabajador caído.
      heartbeatSeconds: 30,
      expireInSeconds: 600,
    });
  }
  return boss;
}

/**
 * Encola dentro de la transacción del llamador: si la transacción se revierte,
 * el trabajo no existe (invariante 1).
 */
export async function encolarMensaje(
  boss: PgBoss,
  cliente: pg.PoolClient,
  messageId: string,
  conversacionId: number,
): Promise<void> {
  const id = await boss.send(COLA_MENSAJES, { messageId } satisfies TrabajoMensaje, {
    singletonKey: String(conversacionId),
    db: { executeSql: (texto, valores) => cliente.query(texto, valores) },
  });
  if (!id) throw new Error(`pg-boss no aceptó el trabajo del mensaje ${messageId}`);
}
