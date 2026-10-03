import type pg from 'pg';
import type { EstadoConversacion } from '../../dominio/errores.js';

export interface FilaBandeja {
  id: number;
  telefono: string;
  estado: EstadoConversacion;
  ultimo_mensaje_en: Date;
  ultimo_texto: string | null;
  mensajes_pendientes: number;
}

export interface Cursor {
  ultimoMensajeEn: Date;
  id: number;
}

/**
 * Bandeja: conversaciones por último mensaje, de la más reciente a la más vieja,
 * con paginación por cursor. Usa los índices de 003_indices_bandeja.sql.
 */
export async function leerBandeja(
  pool: pg.Pool,
  filtro: { estado: EstadoConversacion | null; limite: number; antes: Cursor | null },
): Promise<FilaBandeja[]> {
  const { rows } = await pool.query<FilaBandeja>(
    `SELECT c.id, c.telefono, c.estado, c.ultimo_mensaje_en,
            ultimo.texto AS ultimo_texto,
            (SELECT count(*)::int FROM mensajes_entrantes p
              WHERE p.conversacion_id = c.id AND p.estado IN ('recibido', 'procesando')) AS mensajes_pendientes
       FROM conversaciones c
       LEFT JOIN LATERAL (
         SELECT m.texto FROM mensajes_entrantes m
          WHERE m.conversacion_id = c.id ORDER BY m.enviado_en DESC LIMIT 1
       ) ultimo ON true
      WHERE ($1::text IS NULL OR c.estado = $1)
        AND ($2::timestamptz IS NULL OR (c.ultimo_mensaje_en, c.id) < ($2, $3))
      ORDER BY c.ultimo_mensaje_en DESC, c.id DESC
      LIMIT $4`,
    [filtro.estado, filtro.antes?.ultimoMensajeEn ?? null, filtro.antes?.id ?? null, filtro.limite],
  );
  return rows;
}

export interface FilaConversacion {
  id: number;
  telefono: string;
  estado: EstadoConversacion;
  ultimo_mensaje_en: Date;
}

export async function leerConversacion(pool: pg.Pool, id: number): Promise<FilaConversacion | null> {
  const { rows } = await pool.query<FilaConversacion>(
    'SELECT id, telefono, estado, ultimo_mensaje_en FROM conversaciones WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Mensajes aún no procesados: el frontend los muestra y sabe que "el asistente está respondiendo". */
export async function leerPendientes(pool: pg.Pool, conversacionId: number) {
  const { rows } = await pool.query<{ message_id: string; texto: string; enviado_en: Date; estado: string }>(
    `SELECT message_id, texto, enviado_en, estado FROM mensajes_entrantes
      WHERE conversacion_id = $1 AND estado IN ('recibido', 'procesando') ORDER BY enviado_en`,
    [conversacionId],
  );
  return rows;
}

export async function leerCitas(pool: pg.Pool, conversacionId: number) {
  const { rows } = await pool.query<{
    id: number; estado: string; nombre_paciente: string; inicio: Date; especialidad: string; sede: string; profesional: string; creada_en: Date;
  }>(
    `SELECT ci.id, ci.estado, ci.nombre_paciente, h.inicio, e.nombre AS especialidad, s.nombre AS sede,
            p.nombre AS profesional, ci.creada_en
       FROM citas ci
       JOIN horarios h ON h.id = ci.horario_id
       JOIN profesionales p ON p.id = h.profesional_id
       JOIN especialidades e ON e.id = p.especialidad_id
       JOIN sedes s ON s.id = h.sede_id
      WHERE ci.conversacion_id = $1 ORDER BY h.inicio`,
    [conversacionId],
  );
  return rows;
}

/** El conversacion_id de un mensaje ya registrado (respuesta del webhook a un duplicado). */
export async function conversacionDeMensaje(pool: pg.Pool, messageId: string): Promise<number | null> {
  const { rows } = await pool.query<{ conversacion_id: number }>(
    'SELECT conversacion_id FROM mensajes_entrantes WHERE message_id = $1',
    [messageId],
  );
  return rows[0]?.conversacion_id ?? null;
}
