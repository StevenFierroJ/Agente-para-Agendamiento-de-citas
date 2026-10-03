import { ERRORES_HERRAMIENTA } from '../src/dominio/errores.js';

/**
 * Todo camino que no es el feliz, con nombre. Cada uno tiene que estar cubierto
 * por al menos un caso del goldset (`cubre`); el test de cobertura falla si
 * aparece un código nuevo en el dominio y nadie escribió su caso.
 */
export const SITUACIONES = [
  // Recepción
  'cuerpo_invalido',             // 400: falta campo, timestamp o teléfono mal formado, texto vacío, campo de más
  'mensaje_duplicado',           // mismo message_id dos veces: 200 y un solo turno
  // Herramientas: cada código del dominio
  ...ERRORES_HERRAMIENTA,
  'reintento_misma_conversacion', // agendar un horario que ya es de esta conversación: éxito con la misma cita
  'modelo_corrige_tras_error',    // el error vuelve al modelo y en la iteración siguiente pide bien
  // LLM
  'llm_timeout',
  'llm_error_proveedor',
  'llm_reintento_exitoso',
  'tope_iteraciones',
  // Conversación
  'conversacion_escalada',        // no se llama al LLM; mensaje fijo
  'escalamiento_por_modelo',
  'serie_por_conversacion',       // dos mensajes del mismo teléfono a la vez: uno tras otro, en orden
  'concurrencia_mismo_horario',   // dos pacientes, el mismo horario, a la vez: una cita
  // Barandilla de datos (D-26)
  'dato_sin_respaldo_corregido',  // el modelo cita un dato que no está en la evidencia y lo corrige
  'dato_sin_respaldo_descartado', // insiste: se descarta su respuesta, mensaje fijo y escala
  'escalamiento_prometido',       // "te paso con un asesor" sin la herramienta: el código escala (D-29)
  'cita_afirmada_sin_agendar',    // "tu cita está agendada" sin agendar_cita: corrige o se descarta (D-29)
  'respuesta_vacia_tras_accion',  // texto vacío después de escalar o agendar: el código redacta (D-29)
  // Hora de Colombia
  'zona_horaria',
  // Caminos felices (para que el goldset también diga que lo normal funciona)
  'respuesta_con_documentos',
  'cita_agendada',
] as const;

export type Situacion = (typeof SITUACIONES)[number];
