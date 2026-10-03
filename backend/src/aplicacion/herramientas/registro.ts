import type pg from 'pg';
import type { EmbeddingClient, Herramienta } from '../puertos.js';

export interface DependenciasHerramientas {
  pool: pg.Pool;
  embeddings: EmbeddingClient | null;
  ragUmbral: number | null;
}

/** Las herramientas que el modelo puede pedir, por nombre. Se completan en el paso 4. */
export function crearHerramientas(_deps: DependenciasHerramientas): Map<string, Herramienta> {
  return new Map();
}
