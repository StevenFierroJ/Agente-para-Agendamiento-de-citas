import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { EmbeddingClient } from '../src/aplicacion/puertos.js';
import { partirMarkdown } from '../src/aplicacion/rag/particion.js';
import { documentoAlDia, guardarDocumento } from '../src/infraestructura/postgres/conocimiento.js';

export const DIRECTORIO_DOCUMENTOS = fileURLToPath(new URL('./documentos/', import.meta.url));

export interface ResumenDocumentos {
  indexados: string[];
  sinCambios: string[];
  eliminados: number;
}

/**
 * Indexa los .md de seed/documentos. Idempotente: un documento cuyo contenido no
 * cambió (misma huella SHA-256) no se vuelve a embeber; uno que ya no está en la
 * carpeta se elimina con sus fragmentos.
 */
export async function sembrarDocumentos(
  pool: pg.Pool,
  embeddings: EmbeddingClient,
  directorio: string = DIRECTORIO_DOCUMENTOS,
): Promise<ResumenDocumentos> {
  const archivos = (await readdir(directorio)).filter((a) => a.endsWith('.md')).sort();
  const resumen: ResumenDocumentos = { indexados: [], sinCambios: [], eliminados: 0 };

  for (const archivo of archivos) {
    const contenido = await readFile(path.join(directorio, archivo), 'utf8');
    const hash = createHash('sha256').update(contenido).digest('hex');
    if (await documentoAlDia(pool, archivo, hash)) {
      resumen.sinCambios.push(archivo);
      continue;
    }
    const { titulo, fragmentos } = partirMarkdown(contenido, archivo);
    const vectores = await embeddings.embeberPasajes(fragmentos.map((f) => f.texto));
    await guardarDocumento(pool, {
      origen: archivo,
      titulo,
      hash,
      fragmentos: fragmentos.map((f, i) => ({ ...f, embedding: vectores[i]! })),
    });
    resumen.indexados.push(archivo);
  }

  const eliminados = await pool.query('DELETE FROM documentos WHERE NOT (origen = ANY($1))', [archivos]);
  resumen.eliminados = eliminados.rowCount ?? 0;
  return resumen;
}
