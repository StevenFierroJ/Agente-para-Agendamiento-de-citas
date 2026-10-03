import type { EstadoConversacion } from './errores.js';

export type EstadoFinalTurno = Exclude<EstadoConversacion, 'abierta'>;

export interface HechosDelTurno {
  agendoCita: boolean;
  escaloElModelo: boolean;
  agotoIteraciones: boolean;
  fallaDelLlm: boolean;
  /** La respuesta final tenía datos sin respaldo aun después de la corrección (D-26). */
  datoSinRespaldo: boolean;
}

/**
 * El estado final de un turno lo decide el código con lo que pasó, no el modelo
 * con lo que dice. Si en el mismo turno se agendó y se escaló, gana `escalada`:
 * hay algo que un humano tiene que mirar.
 */
export function estadoFinalDelTurno(hechos: HechosDelTurno): EstadoFinalTurno {
  if (hechos.escaloElModelo || hechos.agotoIteraciones || hechos.fallaDelLlm || hechos.datoSinRespaldo) return 'escalada';
  if (hechos.agendoCita) return 'cita_agendada';
  return 'resuelta_por_ia';
}

const PRIORIDAD: Record<EstadoConversacion, number> = { abierta: 0, resuelta_por_ia: 1, cita_agendada: 2, escalada: 3 };

/**
 * El estado de la conversación solo sube de prioridad (D-05):
 * escalada > cita_agendada > resuelta_por_ia > abierta. Un "gracias" después de
 * agendar no borra de la bandeja que hubo una cita. El estado de cada turno se
 * guarda aparte, en su traza.
 */
export function siguienteEstadoConversacion(actual: EstadoConversacion, final: EstadoFinalTurno): EstadoConversacion {
  return PRIORIDAD[final] > PRIORIDAD[actual] ? final : actual;
}
