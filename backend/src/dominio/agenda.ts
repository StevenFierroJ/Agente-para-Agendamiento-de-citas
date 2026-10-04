import { DateTime } from 'luxon';
import { ZONA_COLOMBIA, esHorarioPasado } from './fechas.js';

/** Minúsculas, sin tildes y con espacios colapsados: "  DERMATOLOGÍA " → "dermatologia". */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca `entrada` en un catálogo de nombres sin importar mayúsculas, tildes ni
 * espacios. Si no hay coincidencia exacta, prueba sin la palabra "sede", para que
 * "norte" encuentre "Sede Norte". Devuelve null si no hay una única coincidencia.
 */
export function resolverNombre<T extends { nombre: string }>(entrada: string, catalogo: readonly T[]): T | null {
  const buscada = normalizar(entrada);
  if (!buscada) return null;
  const exacta = catalogo.filter((item) => normalizar(item.nombre) === buscada);
  if (exacta.length === 1) return exacta[0] ?? null;

  const sinSede = (texto: string) => normalizar(texto).replace(/^sede /, '');
  const parcial = catalogo.filter((item) => sinSede(item.nombre) === sinSede(entrada));
  return parcial.length === 1 ? (parcial[0] ?? null) : null;
}

export type ResultadoNombre = { ok: true; nombre: string } | { ok: false; detalle: string };

const NOMBRE_PERMITIDO = /^[\p{L}' ’-]+$/u;

/**
 * Nombre del paciente: 2 a 80 caracteres; solo letras, espacios, apóstrofo y
 * guion; al menos dos letras. Con dígitos o cualquier otro signo se rechaza.
 * Se devuelve con los espacios colapsados.
 */
export function validarNombrePaciente(entrada: string): ResultadoNombre {
  const nombre = entrada.replace(/\s+/g, ' ').trim();
  if (nombre.length < 2 || nombre.length > 80) {
    return { ok: false, detalle: 'El nombre debe tener entre 2 y 80 caracteres' };
  }
  if (!NOMBRE_PERMITIDO.test(nombre)) {
    return { ok: false, detalle: 'El nombre solo puede tener letras, espacios, apóstrofo y guion' };
  }
  if ((nombre.match(/\p{L}/gu) ?? []).length < 2) {
    return { ok: false, detalle: 'El nombre debe tener al menos dos letras' };
  }
  return { ok: true, nombre };
}

export interface HorarioAgendable {
  id: number;
  inicio: Date;
  /** consultar_disponibilidad lo mostró en esta conversación (D-34). */
  ofrecido: boolean;
}

export interface CitaActiva {
  id: number;
  conversacionId: number;
}

export type DecisionAgendamiento =
  | { tipo: 'agendar' }
  | { tipo: 'ya_es_tuya'; citaId: number }
  | { tipo: 'error'; error: 'horario_inexistente' | 'horario_no_ofrecido' | 'horario_pasado' | 'horario_ocupado' };

/**
 * Qué hacer con un pedido de agendamiento, dado lo que hay en la base.
 * Es la verificación previa; la garantía contra la carrera entre dos pacientes
 * es el índice único parcial (`citas_horario_activa_unica`).
 */
export function decidirAgendamiento(
  horario: HorarioAgendable | null,
  citaActiva: CitaActiva | null,
  conversacionId: number,
  ahora: DateTime,
): DecisionAgendamiento {
  if (!horario) return { tipo: 'error', error: 'horario_inexistente' };
  // Antes que "pasado": reintentar un turno que ya agendó debe devolver la misma
  // cita aunque el reintento llegue después de la hora (invariante 4).
  if (citaActiva?.conversacionId === conversacionId) return { tipo: 'ya_es_tuya', citaId: citaActiva.id };
  // El modelo solo agenda lo que se le mostró al paciente: un id que no salió de
  // consultar_disponibilidad en esta conversación es inventado o de otra charla.
  if (!horario.ofrecido) return { tipo: 'error', error: 'horario_no_ofrecido' };
  if (esHorarioPasado(horario.inicio, ahora)) return { tipo: 'error', error: 'horario_pasado' };
  if (citaActiva) return { tipo: 'error', error: 'horario_ocupado' };
  return { tipo: 'agendar' };
}

/** De una lista de horarios, los que siguen libres y no han empezado, en orden. */
export function horariosLibres<T extends { inicio: Date; ocupado: boolean }>(horarios: readonly T[], ahora: DateTime): T[] {
  return horarios
    .filter((h) => !h.ocupado && !esHorarioPasado(h.inicio, ahora))
    .sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

export interface DiaConFranjas {
  fecha: string;    // 2026-10-06
  dia: string;      // martes
  franjas: string[]; // ["08:00-12:00", "14:00-17:00"], hora de Colombia
}

/**
 * Resume horarios libres en franjas por día: une los bloques que se tocan o se
 * solapan (dos profesionales a la misma hora cuentan una vez). Para responder
 * "¿qué hay la próxima semana?" sin mandarle al modelo cada bloque de 30 minutos.
 */
export function franjasPorDia(horarios: readonly { inicio: Date; fin: Date }[]): DiaConFranjas[] {
  const ordenados = [...horarios].sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  const dias = new Map<string, { dia: string; tramos: { inicio: DateTime; fin: DateTime }[] }>();
  for (const h of ordenados) {
    const inicio = DateTime.fromJSDate(h.inicio, { zone: ZONA_COLOMBIA }).setLocale('es');
    const fin = DateTime.fromJSDate(h.fin, { zone: ZONA_COLOMBIA });
    const fecha = inicio.toISODate() ?? '';
    const delDia = dias.get(fecha) ?? { dia: inicio.toFormat('cccc'), tramos: [] };
    const ultimo = delDia.tramos.at(-1);
    if (ultimo && inicio <= ultimo.fin) {
      if (fin > ultimo.fin) ultimo.fin = fin;
    } else {
      delDia.tramos.push({ inicio, fin });
    }
    dias.set(fecha, delDia);
  }
  return [...dias].map(([fecha, { dia, tramos }]) => ({
    fecha,
    dia,
    franjas: tramos.map((t) => `${t.inicio.toFormat('HH:mm')}-${t.fin.toFormat('HH:mm')}`),
  }));
}
