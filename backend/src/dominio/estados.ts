import type { EstadoConversacion } from './errores.js';

export type EstadoFinalTurno = Exclude<EstadoConversacion, 'abierta'>;

export interface HechosDelTurno {
  agendoCita: boolean;
  escaloElModelo: boolean;
  agotoIteraciones: boolean;
  fallaDelLlm: boolean;
}

/**
 * El estado final de un turno lo decide el código con lo que pasó, no el modelo
 * con lo que dice. Si en el mismo turno se agendó y se escaló, gana `escalada`:
 * hay algo que un humano tiene que mirar.
 */
export function estadoFinalDelTurno(hechos: HechosDelTurno): EstadoFinalTurno {
  if (hechos.escaloElModelo || hechos.agotoIteraciones || hechos.fallaDelLlm) return 'escalada';
  if (hechos.agendoCita) return 'cita_agendada';
  return 'resuelta_por_ia';
}

/** `escalada` es terminal (D-05); en otro caso, la conversación toma el estado de su último turno. */
export function siguienteEstadoConversacion(actual: EstadoConversacion, final: EstadoFinalTurno): EstadoConversacion {
  return actual === 'escalada' ? 'escalada' : final;
}
