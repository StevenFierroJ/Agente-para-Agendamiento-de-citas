import type pg from 'pg';
import type { BaseConocimiento, FragmentoEncontrado } from '../../aplicacion/puertos.js';

/** pgvector recibe el vector como texto: '[0.1,0.2,...]'. */
export function aVectorSql(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export class ConocimientoPostgres implements BaseConocimiento {
  constructor(private readonly pool: pg.Pool) {}

  /** Los `limite` fragmentos más cercanos por distancia coseno (`<=>`). Recorrido exacto (D-07). */
  async buscar(vector: readonly number[], limite: number): Promise<FragmentoEncontrado[]> {
    const { rows } = await this.pool.query<{ titulo: string; seccion: string; texto: string; similitud: number }>(
      `SELECT d.titulo, f.seccion, f.texto, 1 - (f.embedding <=> $1::vector) AS similitud
         FROM fragmentos f JOIN documentos d ON d.id = f.documento_id
        ORDER BY f.embedding <=> $1::vector
        LIMIT $2`,
      [aVectorSql(vector), limite],
    );
    return rows.map((r) => ({ ...r, similitud: Number(r.similitud) }));
  }
}

export interface DocumentoIndexable {
  origen: string;
  titulo: string;
  hash: string;
  fragmentos: { seccion: string; texto: string; embedding: readonly number[] }[];
}

/** El documento ya indexado con este contenido: no hace falta volver a embeberlo. */
export async function documentoAlDia(pool: pg.Pool, origen: string, hash: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM documentos WHERE origen = $1 AND contenido_hash = $2', [origen, hash]);
  return rows.length > 0;
}

/** Reemplaza el documento y todos sus fragmentos en una transacción. */
export async function guardarDocumento(pool: pg.Pool, doc: DocumentoIndexable): Promise<void> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query<{ id: number }>(
      `INSERT INTO documentos (titulo, origen, contenido_hash) VALUES ($1, $2, $3)
       ON CONFLICT (origen) DO UPDATE SET titulo = EXCLUDED.titulo, contenido_hash = EXCLUDED.contenido_hash
       RETURNING id`,
      [doc.titulo, doc.origen, doc.hash],
    );
    const documentoId = rows[0]!.id;
    await cliente.query('DELETE FROM fragmentos WHERE documento_id = $1', [documentoId]);
    for (const f of doc.fragmentos) {
      await cliente.query('INSERT INTO fragmentos (documento_id, seccion, texto, embedding) VALUES ($1, $2, $3, $4::vector)', [
        documentoId, f.seccion, f.texto, aVectorSql(f.embedding),
      ]);
    }
    await cliente.query('COMMIT');
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}
