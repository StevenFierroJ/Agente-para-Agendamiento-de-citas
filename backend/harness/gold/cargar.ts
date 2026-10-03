import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CasoGold } from './esquema.js';

export const DIRECTORIO_CASOS = fileURLToPath(new URL('./casos/', import.meta.url));

/** Primer día de la agenda del harness: lunes 5 de octubre de 2026. Fijo para que los casos sean reproducibles. */
export const SEED_DESDE_HARNESS = '2026-10-05';

/**
 * Carga y valida todos los casos, en orden estable por id: dos corridas tienen
 * que recorrer lo mismo en el mismo orden para poder compararse.
 */
export async function cargarCasos(directorio: string = DIRECTORIO_CASOS): Promise<CasoGold[]> {
  const archivos = (await readdir(directorio)).filter((a) => a.endsWith('.json')).sort();
  const casos: CasoGold[] = [];
  for (const archivo of archivos) {
    const crudo: unknown = JSON.parse(await readFile(path.join(directorio, archivo), 'utf8'));
    const resultado = CasoGold.safeParse(crudo);
    if (!resultado.success) {
      throw new Error(`Caso inválido ${archivo}:\n${resultado.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
    }
    if (`${resultado.data.id}.json` !== archivo) {
      throw new Error(`El id "${resultado.data.id}" no coincide con el archivo ${archivo}`);
    }
    casos.push(resultado.data);
  }
  return casos.sort((a, b) => a.id.localeCompare(b.id));
}
