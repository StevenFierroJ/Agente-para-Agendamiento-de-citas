import type { EmbeddingClient } from '../../aplicacion/puertos.js';

const DIMENSIONES = 384;

/**
 * Embeddings falsos para tests: bolsa de palabras con hashing, normalizada.
 * Deterministas y sin descargar nada; textos que comparten palabras quedan
 * cerca, los que no comparten ninguna, en similitud 0.
 */
export class EmbeddingFalso implements EmbeddingClient {
  async embeberConsulta(texto: string): Promise<number[]> {
    return vectorizar(texto);
  }

  async embeberPasajes(textos: readonly string[]): Promise<number[][]> {
    return textos.map(vectorizar);
  }
}

function vectorizar(texto: string): number[] {
  const vector = new Array<number>(DIMENSIONES).fill(0);
  const palabras = texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .match(/\p{L}{3,}/gu) ?? [];
  for (const palabra of palabras) {
    let h = 2166136261;
    for (const c of palabra) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    vector[(h >>> 0) % DIMENSIONES]! += 1;
  }
  const norma = Math.hypot(...vector) || 1;
  return vector.map((x) => x / norma);
}
