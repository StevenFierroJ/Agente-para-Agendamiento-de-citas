/**
 * Códigos de error que una herramienta devuelve al modelo como resultado
 * `{ ok: false, error, detalle }`. Es una lista cerrada: el harness verifica que
 * cada código tenga al menos un caso en el goldset.
 */
export const ERRORES_HERRAMIENTA = [
  // Comunes a todas las herramientas
  'argumentos_invalidos',    // falla el esquema zod: tipo, formato, campo de más, JSON mal formado
  'herramienta_desconocida', // el modelo pidió una herramienta que no existe
  // buscar_conocimiento
  'sin_resultados',          // ningún fragmento supera RAG_UMBRAL
  // consultar_disponibilidad
  'fecha_pasada',
  'sede_inexistente',
  'especialidad_inexistente',
  'sin_horarios',
  // agendar_cita
  'horario_inexistente',
  'horario_pasado',
  'horario_ocupado',
  'nombre_invalido',
] as const;

export type ErrorHerramienta = (typeof ERRORES_HERRAMIENTA)[number];

export const NOMBRES_HERRAMIENTAS = [
  'buscar_conocimiento',
  'consultar_disponibilidad',
  'agendar_cita',
  'escalar_a_humano',
] as const;

export type NombreHerramienta = (typeof NOMBRES_HERRAMIENTAS)[number];

export const MOTIVOS_ESCALAMIENTO = [
  'sin_informacion',
  'solicitud_del_paciente',
  'fuera_de_alcance',
  'error_tecnico',
] as const;

export const ESTADOS_CONVERSACION = ['abierta', 'resuelta_por_ia', 'cita_agendada', 'escalada'] as const;
export type EstadoConversacion = (typeof ESTADOS_CONVERSACION)[number];
