import { DateTime } from 'luxon';

export const ZONA_COLOMBIA = 'America/Bogota';

/**
 * El "ahora" de un turno: el `timestamp` del mensaje en hora de Colombia.
 * Nunca el reloj del servidor (invariante 5).
 */
export function ahoraDelMensaje(timestamp: Date): DateTime {
  const ahora = DateTime.fromJSDate(timestamp, { zone: ZONA_COLOMBIA });
  if (!ahora.isValid) throw new Error(`timestamp inválido: ${String(timestamp)}`);
  return ahora;
}

/** Lo que el prompt de sistema le dice al modelo sobre el momento actual. */
export interface ContextoTemporal {
  fecha: string;      // 2026-10-05
  hora: string;       // 22:40
  diaSemana: string;  // lunes
  fechaLarga: string; // lunes 5 de octubre de 2026
  manana: string;     // 2026-10-06
}

export function contextoTemporal(ahora: DateTime): ContextoTemporal {
  const local = ahora.setZone(ZONA_COLOMBIA).setLocale('es');
  return {
    fecha: local.toISODate() ?? '',
    hora: local.toFormat('HH:mm'),
    diaSemana: local.toFormat('cccc'),
    fechaLarga: local.toFormat("cccc d 'de' LLLL 'de' yyyy"),
    manana: local.plus({ days: 1 }).toISODate() ?? '',
  };
}

export type ResultadoFecha = { ok: true; dia: DateTime } | { ok: false; detalle: string };

/** Una fecha `YYYY-MM-DD` como el día completo en Colombia. Rechaza cualquier otro formato y fechas imposibles. */
export function parsearFechaLocal(texto: string): ResultadoFecha {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return { ok: false, detalle: `La fecha debe tener el formato YYYY-MM-DD; llegó "${texto}"` };
  }
  const dia = DateTime.fromISO(texto, { zone: ZONA_COLOMBIA });
  if (!dia.isValid) return { ok: false, detalle: `La fecha "${texto}" no existe` };
  return { ok: true, dia: dia.startOf('day') };
}

/** Intervalo [desde, hasta) en UTC que cubre el día local completo, para consultar `horarios.inicio`. */
export function rangoDelDia(dia: DateTime): { desde: Date; hasta: Date } {
  const inicio = dia.setZone(ZONA_COLOMBIA).startOf('day');
  return { desde: inicio.toJSDate(), hasta: inicio.plus({ days: 1 }).toJSDate() };
}

/** Un día es pasado si termina antes de que empiece "hoy" en Colombia. Hoy no es pasado. */
export function esDiaPasado(dia: DateTime, ahora: DateTime): boolean {
  const hoy = ahora.setZone(ZONA_COLOMBIA).startOf('day');
  return dia.setZone(ZONA_COLOMBIA).startOf('day') < hoy;
}

/** Un horario es pasado si ya empezó. */
export function esHorarioPasado(inicio: Date, ahora: DateTime): boolean {
  return inicio.getTime() <= ahora.toMillis();
}

/** `2026-10-06T14:00` en hora de Colombia: como se nombra un horario ante el modelo. */
export function horaLocal(instante: Date): string {
  return DateTime.fromJSDate(instante, { zone: ZONA_COLOMBIA }).toFormat("yyyy-MM-dd'T'HH:mm");
}
