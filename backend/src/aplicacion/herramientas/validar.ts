import { z } from 'zod';
import type { DefinicionHerramienta, ResultadoHerramienta } from '../puertos.js';

/** Valida los argumentos con el esquema estricto; un error vuelve al modelo como `argumentos_invalidos`. */
export function validarArgumentos<T>(esquema: z.ZodType<T>, argumentos: unknown): { ok: true; datos: T } | Extract<ResultadoHerramienta, { ok: false }> {
  const resultado = esquema.safeParse(argumentos);
  if (resultado.success) return { ok: true, datos: resultado.data };
  const detalle = resultado.error.issues
    .map((i) => (i.code === 'unrecognized_keys' ? `campos no permitidos: ${i.keys.join(', ')}` : `${i.path.join('.') || 'argumentos'}: ${i.message}`))
    .join('; ');
  return { ok: false, error: 'argumentos_invalidos', detalle };
}

/** La definición que ve el modelo sale del mismo esquema que valida: una sola fuente. */
export function definir(nombre: string, descripcion: string, esquema: z.ZodType): DefinicionHerramienta {
  const { $schema: _omitido, ...parametros } = z.toJSONSchema(esquema) as Record<string, unknown>;
  return { nombre, descripcion, parametros };
}
