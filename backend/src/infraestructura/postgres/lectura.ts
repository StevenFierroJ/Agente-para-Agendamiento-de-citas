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

export interface FilaAgenda {
  horario_id: number;
  inicio: Date;
  fin: Date;
  sede: string;
  especialidad: string;
  profesional: string;
  cita: { id: number; nombre_paciente: string; conversacion_id: number } | null;
}

/**
 * La agenda de un rango para el calendario del coordinador: cada horario con su
 * cita activa, si la tiene. Usa el índice (sede_id, inicio) cuando se filtra por sede.
 */
export async function leerAgenda(
  pool: pg.Pool,
  filtro: { desde: Date; hasta: Date; sedeId: number | null; especialidadId: number | null },
): Promise<FilaAgenda[]> {
  const { rows } = await pool.query<Omit<FilaAgenda, 'cita'> & { cita_id: number | null; nombre_paciente: string | null; conversacion_id: number | null }>(
    `SELECT h.id AS horario_id, h.inicio, h.fin, s.nombre AS sede, e.nombre AS especialidad, p.nombre AS profesional,
            c.id AS cita_id, c.nombre_paciente, c.conversacion_id
       FROM horarios h
       JOIN profesionales p ON p.id = h.profesional_id
       JOIN especialidades e ON e.id = p.especialidad_id
       JOIN sedes s ON s.id = h.sede_id
       LEFT JOIN citas c ON c.horario_id = h.id AND c.estado = 'activa'
      WHERE h.inicio >= $1 AND h.inicio < $2
        AND ($3::int IS NULL OR h.sede_id = $3)
        AND ($4::int IS NULL OR p.especialidad_id = $4)
      ORDER BY h.inicio, s.nombre, p.nombre`,
    [filtro.desde, filtro.hasta, filtro.sedeId, filtro.especialidadId],
  );
  return rows.map(({ cita_id, nombre_paciente, conversacion_id, ...h }) => ({
    ...h,
    cita: cita_id !== null ? { id: cita_id, nombre_paciente: nombre_paciente ?? '', conversacion_id: conversacion_id ?? 0 } : null,
  }));
}

export async function leerCatalogoAgenda(pool: pg.Pool) {
  const [sedes, especialidades] = await Promise.all([
    pool.query<{ id: number; nombre: string }>('SELECT id, nombre FROM sedes ORDER BY nombre'),
    pool.query<{ id: number; nombre: string }>('SELECT id, nombre FROM especialidades ORDER BY nombre'),
  ]);
  return { sedes: sedes.rows, especialidades: especialidades.rows };
}

/** Lo que el RAG puede encontrar: cada documento con sus fragmentos, sin los vectores. */
export async function leerConocimiento(pool: pg.Pool) {
  const { rows } = await pool.query<{ id: number; titulo: string; origen: string; fragmentos: { id: number; seccion: string; texto: string }[] }>(
    `SELECT d.id, d.titulo, d.origen,
            COALESCE(json_agg(json_build_object('id', f.id, 'seccion', f.seccion, 'texto', f.texto) ORDER BY f.id)
                     FILTER (WHERE f.id IS NOT NULL), '[]') AS fragmentos
       FROM documentos d LEFT JOIN fragmentos f ON f.documento_id = d.id
      GROUP BY d.id ORDER BY d.origen`,
  );
  return rows;
}

/** Teléfono de cada conversación, para la vista de trazas (se enmascara al responder). */
export async function leerTelefonos(pool: pg.Pool, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query<{ id: number; telefono: string }>('SELECT id, telefono FROM conversaciones WHERE id = ANY($1)', [ids]);
  return new Map(rows.map((r) => [r.id, r.telefono]));
}

/** Estado, teléfono y citas activas de varias conversaciones, para la vista de trazas. */
export async function leerResumenConversaciones(pool: pg.Pool, ids: number[]) {
  if (ids.length === 0) return new Map<number, { telefono: string; estado: EstadoConversacion; citas_activas: number }>();
  const { rows } = await pool.query<{ id: number; telefono: string; estado: EstadoConversacion; citas_activas: number }>(
    `SELECT c.id, c.telefono, c.estado,
            (SELECT count(*)::int FROM citas ci WHERE ci.conversacion_id = c.id AND ci.estado = 'activa') AS citas_activas
       FROM conversaciones c WHERE c.id = ANY($1)`,
    [ids],
  );
  return new Map(rows.map(({ id, ...r }) => [id, r]));
}

/** Ids de las conversaciones en un estado. Usa el índice (estado, ultimo_mensaje_en). */
export async function idsConEstado(pool: pg.Pool, estado: EstadoConversacion): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM conversaciones WHERE estado = $1', [estado]);
  return rows.map((r) => r.id);
}
