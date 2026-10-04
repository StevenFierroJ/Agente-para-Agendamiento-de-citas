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
  /** Los próximos 14 días con su día de la semana: el modelo no los calcula (D-39). */
  calendario: string[]; // ["lunes 5 de octubre: 2026-10-05 (hoy)", ...]
}

export const DIAS_DE_CALENDARIO = 14;

export function contextoTemporal(ahora: DateTime): ContextoTemporal {
  const local = ahora.setZone(ZONA_COLOMBIA).setLocale('es');
  return {
    fecha: local.toISODate() ?? '',
    hora: local.toFormat('HH:mm'),
    diaSemana: local.toFormat('cccc'),
    fechaLarga: local.toFormat("cccc d 'de' LLLL 'de' yyyy"),
    manana: local.plus({ days: 1 }).toISODate() ?? '',
    calendario: Array.from({ length: DIAS_DE_CALENDARIO }, (_, i) => {
      const dia = local.plus({ days: i });
      const nota = i === 0 ? ' (hoy)' : i === 1 ? ' (mañana)' : '';
      return `${dia.toFormat("cccc d 'de' LLLL")}: ${dia.toISODate() ?? ''}${nota}`;
    }),
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

export type ResultadoInstante = { ok: true; instante: DateTime } | { ok: false; detalle: string };

/** `2026-10-07` + `16:30` como instante en hora de Colombia. La hora va en 24 h, `HH:mm`. */
export function parsearFechaHoraLocal(fecha: string, hora: string): ResultadoInstante {
  const dia = parsearFechaLocal(fecha);
  if (!dia.ok) return dia;
  const partes = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hora);
  if (!partes) return { ok: false, detalle: `La hora debe ir en 24 h con formato HH:mm (por ejemplo 16:30 para 4:30 p. m.); llegó "${hora}"` };
  return { ok: true, instante: dia.dia.set({ hour: Number(partes[1]), minute: Number(partes[2]) }) };
}

/** "miércoles" para `2026-10-07`. */
export function diaDeLaSemana(fecha: string): string {
  return DateTime.fromISO(fecha, { zone: ZONA_COLOMBIA }).setLocale('es').toFormat('cccc');
}

const DIAS_SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIA_Y_FECHA = new RegExp(
  `\\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\\s+(\\d{1,2})(?:\\s+de\\s+(${MESES.join('|')}))?\\b`,
  'giu',
);

/**
 * "Lunes 7 de octubre" cuando el 7 es miércoles: el día de la semana y la fecha
 * no coinciden (D-39). Sin mes, el número es del mes en curso o, si ya pasó, del
 * siguiente. Devuelve cada mención incoherente con la fecha real entre paréntesis.
 */
export function fechasIncoherentes(texto: string, ahora: DateTime): string[] {
  const hoy = ahora.setZone(ZONA_COLOMBIA).startOf('day');
  const incoherentes: string[] = [];
  for (const m of texto.matchAll(DIA_Y_FECHA)) {
    const nombre = m[1]!.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const numero = Number(m[2]);
    const mes = m[3] ? MESES.indexOf(m[3].toLowerCase()) + 1 : null;
    let fecha = DateTime.fromObject({ year: hoy.year, month: mes ?? hoy.month, day: numero }, { zone: ZONA_COLOMBIA });
    if (!fecha.isValid) continue;
    if (fecha < hoy) fecha = mes ? fecha.plus({ years: 1 }) : fecha.plus({ months: 1 });
    if (!fecha.isValid || fecha.day !== numero) continue;
    const real = DIAS_SEMANA[fecha.weekday - 1]!;
    if (real !== nombre) {
      incoherentes.push(`${m[0]} (el ${numero} de ${MESES[fecha.month - 1]} es ${fecha.setLocale('es').toFormat('cccc')})`);
    }
  }
  return [...new Set(incoherentes)];
}

/** "viernes 16 de octubre de 2026" para `2026-10-16`. */
export function fechaLargaDe(fecha: string): string {
  return DateTime.fromISO(fecha, { zone: ZONA_COLOMBIA }).setLocale('es').toFormat("cccc d 'de' LLLL 'de' yyyy");
}

/**
 * Lo que la herramienta le dice al modelo cuando pide fechas después del último
 * día con agenda (D-42): la agenda no está llena, todavía no existe.
 */
export function avisoFinDeAgenda(finDeAgenda: string): string {
  return `La agenda tiene horarios publicados solo hasta el ${fechaLargaDe(finDeAgenda)} (${finDeAgenda}). ` +
    'Para fechas posteriores todavía no hay agenda: díselo así al paciente (no está llena, aún no se ha abierto) ' +
    'y ofrécele fechas hasta ese día o comunicarlo con un asesor.';
}
