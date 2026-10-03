// Esquema de un caso del goldset.
//
// UN CASO ES UNA CONVERSACIÓN GUIONADA, NO UN TEST UNITARIO
//   Los tests de Vitest prueban piezas. Un caso recorre el sistema completo:
//   webhook → cola → trabajador → herramientas → PostgreSQL y MongoDB, y al final
//   compara lo que quedó en las bases contra lo esperado.
//
// DOS MODOS, COMO EL HARNESS DE MORTON
//   guion  El LLM falso responde lo que dice `guion`, paso por paso. Todo lo demás
//          es real (bases, cola, embeddings). No gasta, es determinista, y es el
//          único modo que puede inyectar fallas del proveedor.
//   real   El LLM de verdad responde. Se ignora `guion` y se compara contra
//          `espera_real`, que es más laxa: un modelo puede llegar bien por otro
//          camino. Gasta: el costo se imprime al final.
//
// EL GUION DECLARA SU PASO; NO SE IMPROVISA
//   Si el LLM falso decidiera solo cuándo equivocarse, dos corridas no serían
//   comparables. Cada paso del guion es la respuesta a UNA llamada al LLM.
import { z } from 'zod';
import { ERRORES_HERRAMIENTA, ESTADOS_CONVERSACION, NOMBRES_HERRAMIENTAS } from '../../src/dominio/errores.js';
import { SITUACIONES } from '../excepciones.js';

const FECHA_HORA_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Referencia simbólica a un horario: los id cambian entre corridas, la
 * combinación especialidad + sede + inicio (hora de Colombia) no.
 * En `argumentos` se escribe como `{ "$horario": { ... } }` y el runner la
 * reemplaza por el `horario_id` real antes de entregársela al trabajador.
 */
export const RefHorario = z
  .object({
    especialidad: z.string().min(1),
    sede: z.string().min(1),
    inicio: z.string().regex(FECHA_HORA_LOCAL, 'inicio: YYYY-MM-DDTHH:mm en hora de Colombia'),
  })
  .strict();

const LlamadaGuionada = z
  .object({
    // Se admite cualquier nombre: pedir una herramienta inexistente es un caso.
    nombre: z.string().min(1),
    argumentos: z.record(z.string(), z.unknown()).optional(),
    // Para simular JSON mal formado: se entrega tal cual, sin serializar.
    argumentos_crudos: z.string().optional(),
  })
  .strict()
  .refine((l) => (l.argumentos === undefined) !== (l.argumentos_crudos === undefined), {
    message: 'Una llamada lleva `argumentos` o `argumentos_crudos`, no ambos ni ninguno',
  });

export const PasoGuion = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('herramientas'), llamadas: z.array(LlamadaGuionada).min(1) }).strict(),
  z.object({ tipo: z.literal('texto'), texto: z.string().min(1) }).strict(),
  z.object({ tipo: z.literal('falla'), falla: z.enum(['timeout', 'error_proveedor']) }).strict(),
]);

const HerramientaEsperada = z
  .object({
    nombre: z.string().min(1),
    // null = la herramienta tuvo éxito
    error: z.enum([...ERRORES_HERRAMIENTA]).nullable(),
  })
  .strict();

const Estado = z.enum([...ESTADOS_CONVERSACION]);

/** Lo que tiene que haber pasado en el turno de un mensaje, en modo guion. */
const EsperaTurno = z
  .object({
    llamo_llm: z.boolean().default(true),
    // Exactas y en orden: el guion las determina.
    herramientas: z.array(HerramientaEsperada).optional(),
    // Una lista cuando el resultado depende de quién gana una carrera (casos concurrentes).
    estado_final: z.union([Estado, z.array(Estado).min(1)]),
    respuesta_contiene: z.array(z.string()).optional(),
    respuesta_no_contiene: z.array(z.string()).optional(),
    // Sobre el prompt de sistema que recibió el LLM (fecha y hora de Colombia, sedes válidas).
    prompt_contiene: z.array(z.string()).optional(),
  })
  .strict();

/** Lo que tiene que haber pasado con un LLM real: más laxo. */
const EsperaTurnoReal = z
  .object({
    estado_final: z.union([Estado, z.array(Estado).min(1)]),
    herramientas_incluye: z.array(z.enum([...NOMBRES_HERRAMIENTAS])).optional(),
    herramientas_excluye: z.array(z.enum([...NOMBRES_HERRAMIENTAS])).optional(),
    // Al menos una llamada a `nombre` cuyos argumentos incluyan estos pares.
    // Es como se mide la zona horaria con un modelo real: qué fecha pidió.
    herramientas_con_argumentos: z
      .array(z.object({ nombre: z.enum([...NOMBRES_HERRAMIENTAS]), argumentos: z.record(z.string(), z.unknown()) }).strict())
      .optional(),
    respuesta_no_contiene: z.array(z.string()).optional(),
  })
  .strict();

const MensajeValido = z
  .object({
    message_id: z.string().min(1),
    from: z.string().min(1),
    text: z.string(),
    timestamp: z.string(),
  })
  .strict();

const Envio = z
  .object({
    // Cuerpo bien formado o, para probar el 400, cualquier cosa.
    cuerpo: MensajeValido.optional(),
    cuerpo_crudo: z.unknown().optional(),
    // Cuántas veces se manda el mismo cuerpo (duplicados del webhook).
    envios: z.number().int().min(1).default(1),
    // Envíos con el mismo `grupo` salen a la vez (Promise.all); los demás, en orden.
    grupo: z.string().optional(),
    http: z.array(z.number().int()).min(1),
    guion: z.array(PasoGuion).optional(),
    espera: EsperaTurno.optional(),
    espera_real: EsperaTurnoReal.optional(),
  })
  .strict()
  .refine((e) => (e.cuerpo === undefined) !== (e.cuerpo_crudo === undefined), {
    message: 'Un envío lleva `cuerpo` o `cuerpo_crudo`',
  })
  .refine((e) => e.http.length === e.envios, { message: '`http` lleva un código por envío' });

const Preparacion = z
  .object({
    citas: z
      .array(z.object({ telefono: z.string(), horario: RefHorario, nombre_paciente: z.string() }).strict())
      .default([]),
    escaladas: z.array(z.string()).default([]),
  })
  .strict();

const EsperaFinal = z
  .object({
    conversaciones: z
      .record(z.string(), z.object({ estado: Estado, citas_activas: z.number().int().min(0) }).strict())
      .optional(),
    // Para casos concurrentes, donde no se sabe cuál conversación gana.
    conteo_estados: z.record(z.string(), z.number().int().min(0)).optional(),
    citas_activas_total: z.number().int().min(0).optional(),
    conversaciones_total: z.number().int().min(0).optional(),
    turnos_total: z.number().int().min(0).optional(),
    // Los turnos de cada conversación no se solapan y siguen el orden de `timestamp`.
    turnos_en_serie: z.boolean().optional(),
  })
  .strict();

export const CasoGold = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    descripcion: z.string().min(1),
    cubre: z.array(z.enum([...SITUACIONES])).min(1),
    modos: z.array(z.enum(['guion', 'real'])).min(1),
    // Quién revisó que lo esperado es lo correcto. null = nadie más que quien lo escribió.
    validado_por: z.string().nullable(),
    preparacion: Preparacion.default({ citas: [], escaladas: [] }),
    envios: z.array(Envio).min(1),
    espera_final: EsperaFinal.default({}),
  })
  .strict()
  .superRefine((caso, ctx) => {
    for (const [i, envio] of caso.envios.entries()) {
      const procesa = envio.cuerpo !== undefined && envio.http.includes(202);
      if (caso.modos.includes('guion') && procesa && !envio.espera) {
        ctx.addIssue({ code: 'custom', path: ['envios', i, 'espera'], message: 'Modo guion: falta `espera`' });
      }
      if (caso.modos.includes('guion') && procesa && envio.espera?.llamo_llm !== false && !envio.guion) {
        ctx.addIssue({ code: 'custom', path: ['envios', i, 'guion'], message: 'Modo guion: falta `guion`' });
      }
      if (caso.modos.includes('real') && procesa && !envio.espera_real) {
        ctx.addIssue({ code: 'custom', path: ['envios', i, 'espera_real'], message: 'Modo real: falta `espera_real`' });
      }
    }
  });

export type CasoGold = z.infer<typeof CasoGold>;
export type PasoGuion = z.infer<typeof PasoGuion>;
