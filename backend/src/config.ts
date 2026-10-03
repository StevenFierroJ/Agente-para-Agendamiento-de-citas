import { z } from 'zod';

const textoOpcional = z.string().trim().transform((v) => (v === '' ? undefined : v)).optional();
const numeroOpcional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
  .pipe(z.number().nonnegative().optional());

const EsquemaConfig = z.object({
  DATABASE_URL: z.string().min(1),
  MONGO_URL: z.string().min(1),
  PUERTO: z.coerce.number().int().positive().default(3000),
  TRABAJADOR_CONCURRENCIA: z.coerce.number().int().positive().default(5),
  ANTHROPIC_API_KEY: textoOpcional,
  LLM_MODEL: z.string().trim().min(1).default('claude-haiku-4-5'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  LLM_MAX_ITERACIONES: z.coerce.number().int().positive().default(5),
  LLM_PRECIO_ENTRADA_1M: numeroOpcional,
  LLM_PRECIO_SALIDA_1M: numeroOpcional,
  RAG_UMBRAL: numeroOpcional,
});

export type Config = z.infer<typeof EsquemaConfig>;

/** Lee y valida el entorno. Falla al arrancar, con el nombre de cada variable mal puesta. */
export function leerConfig(entorno: NodeJS.ProcessEnv = process.env): Config {
  const resultado = EsquemaConfig.safeParse(entorno);
  if (!resultado.success) {
    const detalle = resultado.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${detalle}`);
  }
  return resultado.data;
}

/** Precios por millón de tokens; null si falta alguno: un costo desconocido no es cero. */
export function preciosLlm(config: Config): { entrada: number; salida: number } | null {
  if (config.LLM_PRECIO_ENTRADA_1M === undefined || config.LLM_PRECIO_SALIDA_1M === undefined) return null;
  return { entrada: config.LLM_PRECIO_ENTRADA_1M, salida: config.LLM_PRECIO_SALIDA_1M };
}
