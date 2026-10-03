import type { PgBoss } from 'pg-boss';
import { COLA_MENSAJES, type OpcionesCola, type TrabajoMensaje } from '../infraestructura/cola/cola.js';
import { abandonarMensaje, procesarMensaje, type DependenciasProcesamiento } from './procesar-mensaje.js';

export interface Trabajador {
  detener(): Promise<void>;
}

/**
 * Consume la cola de mensajes. `concurrencia` trabajos a la vez, nunca dos de la
 * misma conversación (lo garantiza la política de la cola).
 */
export async function iniciarTrabajador(
  boss: PgBoss,
  deps: DependenciasProcesamiento,
  opciones: OpcionesCola & { concurrencia: number },
): Promise<Trabajador> {
  await boss.work<TrabajoMensaje>(
    COLA_MENSAJES,
    { localConcurrency: opciones.concurrencia, batchSize: 1, pollingIntervalSeconds: 0.5 },
    async (trabajos) => {
      for (const trabajo of trabajos) {
        try {
          await procesarMensaje(trabajo.data.messageId, deps);
        } catch (error) {
          if (trabajo.retryCount < opciones.reintentos) throw error; // la cola reintenta
          await abandonarMensaje(trabajo.data.messageId, error, deps);
        }
      }
    },
  );
  return { detener: () => boss.offWork(COLA_MENSAJES) };
}
