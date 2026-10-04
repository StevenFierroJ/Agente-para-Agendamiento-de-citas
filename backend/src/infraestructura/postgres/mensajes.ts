import type pg from 'pg';
import type {
  Catalogo, EstadoMensajeEntrante, HorarioOfrecido, ItemCatalogo, MensajeAProcesar, RepositorioMensajes,
} from '../../aplicacion/puertos.js';
import type { EstadoConversacion } from '../../dominio/errores.js';

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

/** Mensajes entrantes, estado de las conversaciones y catálogo, sobre PostgreSQL. */
export class RepositorioMensajesPostgres implements RepositorioMensajes {
  constructor(private readonly pool: pg.Pool) {}

  async obtener(messageId: string): Promise<MensajeAProcesar | null> {
    const { rows } = await this.pool.query<{
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

  async marcar(messageId: string, estado: EstadoMensajeEntrante): Promise<void> {
    const r = await this.pool.query('UPDATE mensajes_entrantes SET estado = $2 WHERE message_id = $1', [messageId, estado]);
    if (r.rowCount !== 1) throw new Error(`No existe el mensaje ${messageId}`);
  }

  async actualizarEstadoConversacion(conversacionId: number, estado: EstadoConversacion): Promise<void> {
    const r = await this.pool.query('UPDATE conversaciones SET estado = $2 WHERE id = $1', [conversacionId, estado]);
    if (r.rowCount !== 1) throw new Error(`No existe la conversación ${conversacionId}`);
  }

  async citasActivas(conversacionId: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM citas WHERE conversacion_id = $1 AND estado = 'activa'",
      [conversacionId],
    );
    return rows[0]?.n ?? 0;
  }

  /** Los más recientes primero al recortar; se devuelven en orden de inicio. */
  async horariosOfrecidosVigentes(conversacionId: number, ahora: Date, limite: number): Promise<HorarioOfrecido[]> {
    const { rows } = await this.pool.query<{ id: number; inicio: Date; especialidad: string; sede: string; profesional: string }>(
      `SELECT * FROM (
         SELECT h.id, h.inicio, e.nombre AS especialidad, s.nombre AS sede, p.nombre AS profesional, o.ofrecido_en
           FROM horarios_ofrecidos o
           JOIN horarios h ON h.id = o.horario_id
           JOIN profesionales p ON p.id = h.profesional_id
           JOIN especialidades e ON e.id = p.especialidad_id
           JOIN sedes s ON s.id = h.sede_id
          WHERE o.conversacion_id = $1 AND h.inicio > $2
            AND NOT EXISTS (SELECT 1 FROM citas c WHERE c.horario_id = h.id AND c.estado = 'activa')
          ORDER BY o.ofrecido_en DESC, h.inicio
          LIMIT $3
       ) recientes ORDER BY inicio, profesional`,
      [conversacionId, ahora, limite],
    );
    return rows.map((f) => ({ horarioId: f.id, inicio: f.inicio, especialidad: f.especialidad, sede: f.sede, profesional: f.profesional }));
  }

  async catalogo(): Promise<Catalogo> {
    const [sedes, especialidades, fin] = await Promise.all([
      this.pool.query<ItemCatalogo>('SELECT id, nombre FROM sedes ORDER BY nombre'),
      this.pool.query<ItemCatalogo>('SELECT id, nombre FROM especialidades ORDER BY nombre'),
      // max(inicio) recorre el índice único (profesional_id, inicio) por profesional: barato.
      this.pool.query<{ fin: string | null }>(
        "SELECT to_char(max(inicio) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS fin FROM horarios",
      ),
    ]);
    return { sedes: sedes.rows, especialidades: especialidades.rows, finDeAgenda: fin.rows[0]?.fin ?? null };
  }
}
