import type pg from 'pg';
import type { EstadoConversacion } from '../../dominio/errores.js';

export type EstadoMensajeEntrante = 'recibido' | 'procesando' | 'procesado' | 'fallido';

export interface NuevoMensajeEntrante {
  messageId: string;
  telefono: string;
  texto: string;
  enviadoEn: Date;
}

/**
 * Dentro de la transacción del webhook: crea o actualiza la conversación del
 * teléfono y registra el mensaje. Devuelve null si el `message_id` ya existía
 * (el llamador hace ROLLBACK, así un duplicado no toca nada).
 */
export async function registrarMensajeEntrante(
  cliente: pg.PoolClient,
  mensaje: NuevoMensajeEntrante,
): Promise<{ conversacionId: number } | null> {
  const conversacion = await cliente.query<{ id: number }>(
    `INSERT INTO conversaciones (telefono, ultimo_mensaje_en) VALUES ($1, $2)
     ON CONFLICT (telefono) DO UPDATE
       SET ultimo_mensaje_en = GREATEST(conversaciones.ultimo_mensaje_en, EXCLUDED.ultimo_mensaje_en)
     RETURNING id`,
    [mensaje.telefono, mensaje.enviadoEn],
  );
  const conversacionId = conversacion.rows[0]?.id;
  if (conversacionId === undefined) throw new Error('El upsert de la conversación no devolvió id');

  const insertado = await cliente.query(
    `INSERT INTO mensajes_entrantes (message_id, conversacion_id, texto, enviado_en)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id) DO NOTHING`,
    [mensaje.messageId, conversacionId, mensaje.texto, mensaje.enviadoEn],
  );
  return insertado.rowCount === 1 ? { conversacionId } : null;
}

export interface MensajeAProcesar {
  messageId: string;
  conversacionId: number;
  telefono: string;
  texto: string;
  enviadoEn: Date;
  estado: EstadoMensajeEntrante;
  estadoConversacion: EstadoConversacion;
}

export async function obtenerMensaje(pool: pg.Pool, messageId: string): Promise<MensajeAProcesar | null> {
  const { rows } = await pool.query<{
    message_id: string; conversacion_id: number; telefono: string; texto: string;
    enviado_en: Date; estado: EstadoMensajeEntrante; estado_conversacion: EstadoConversacion;
  }>(
    `SELECT m.message_id, m.conversacion_id, c.telefono, m.texto, m.enviado_en, m.estado,
            c.estado AS estado_conversacion
       FROM mensajes_entrantes m JOIN conversaciones c ON c.id = m.conversacion_id
      WHERE m.message_id = $1`,
    [messageId],
  );
  const fila = rows[0];
  if (!fila) return null;
  return {
    messageId: fila.message_id,
    conversacionId: fila.conversacion_id,
    telefono: fila.telefono,
    texto: fila.texto,
    enviadoEn: fila.enviado_en,
    estado: fila.estado,
    estadoConversacion: fila.estado_conversacion,
  };
}

export async function marcarMensaje(pool: pg.Pool, messageId: string, estado: EstadoMensajeEntrante): Promise<void> {
  const r = await pool.query('UPDATE mensajes_entrantes SET estado = $2 WHERE message_id = $1', [messageId, estado]);
  if (r.rowCount !== 1) throw new Error(`No existe el mensaje ${messageId}`);
}

export async function actualizarEstadoConversacion(pool: pg.Pool, conversacionId: number, estado: EstadoConversacion): Promise<void> {
  const r = await pool.query('UPDATE conversaciones SET estado = $2 WHERE id = $1', [conversacionId, estado]);
  if (r.rowCount !== 1) throw new Error(`No existe la conversación ${conversacionId}`);
}

/** Sedes y especialidades válidas, para el prompt de sistema. */
export async function leerCatalogo(pool: pg.Pool): Promise<{ sedes: string[]; especialidades: string[] }> {
  const [sedes, especialidades] = await Promise.all([
    pool.query<{ nombre: string }>('SELECT nombre FROM sedes ORDER BY nombre'),
    pool.query<{ nombre: string }>('SELECT nombre FROM especialidades ORDER BY nombre'),
  ]);
  return { sedes: sedes.rows.map((f) => f.nombre), especialidades: especialidades.rows.map((f) => f.nombre) };
}
