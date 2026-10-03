import type { DateTime } from 'luxon';
import { esHorarioPasado } from './fechas.js';

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
}

export interface CitaActiva {
  id: number;
  conversacionId: number;
}

export type DecisionAgendamiento =
  | { tipo: 'agendar' }
  | { tipo: 'ya_es_tuya'; citaId: number }
  | { tipo: 'error'; error: 'horario_inexistente' | 'horario_pasado' | 'horario_ocupado' };

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
