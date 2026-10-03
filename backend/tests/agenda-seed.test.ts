import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { DURACION_BLOQUE_MIN, PROFESIONALES, ZONA_COLOMBIA, generarBloques, resolverPrimerDia } from '../seed/agenda.js';

describe('generarBloques', () => {
  // Sábado 3 de octubre de 2026 en Colombia: 14 días calendario = 10 días hábiles.
  const sabado = DateTime.fromISO('2026-10-03', { zone: ZONA_COLOMBIA });
  const bloques = generarBloques(PROFESIONALES, sabado, 14);

  it('solo genera bloques de lunes a viernes, dentro de los 14 días', () => {
    const dias = new Set(bloques.map((b) => DateTime.fromJSDate(b.inicio, { zone: ZONA_COLOMBIA }).toISODate()));
    expect(dias.size).toBe(10);
    for (const b of bloques) {
      const inicio = DateTime.fromJSDate(b.inicio, { zone: ZONA_COLOMBIA });
      expect(inicio.weekday).toBeLessThanOrEqual(5);
      expect(inicio >= sabado && inicio < sabado.plus({ days: 14 })).toBe(true);
    }
  });

  it('cada bloque dura 30 minutos', () => {
    for (const b of bloques) {
      expect(b.fin.getTime() - b.inicio.getTime()).toBe(DURACION_BLOQUE_MIN * 60_000);
    }
  });

  it('interpreta las horas de la plantilla en hora de Colombia (UTC-5)', () => {
    const primero = bloques.find((b) => b.profesional === 'Dra. Laura Gómez');
    // Lunes 5 de octubre, 07:00 en Cali = 12:00 UTC.
    expect(primero?.inicio.toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });

  it('no deja un bloque cortado al final de la franja', () => {
    const mora = bloques.filter((b) => b.profesional === 'Dr. Julián Mora');
    const ultimoDelMartes = mora.filter((b) => b.inicio.toISOString().startsWith('2026-10-06')).at(-1);
    // Franja 14:00–17:00: el último bloque es 16:30–17:00 (22:00 UTC).
    expect(ultimoDelMartes?.fin.toISOString()).toBe('2026-10-06T22:00:00.000Z');
  });
});

describe('resolverPrimerDia', () => {
  it('sin SEED_DESDE usa la fecha de hoy en Colombia, no la del servidor en UTC', () => {
    // 03:40 UTC del 6 de octubre = 22:40 del 5 en Cali.
    const ahora = DateTime.fromISO('2026-10-06T03:40:00Z');
    expect(resolverPrimerDia(undefined, ahora).toISODate()).toBe('2026-10-05');
    expect(resolverPrimerDia('', ahora).toISODate()).toBe('2026-10-05');
  });

  it('acepta SEED_DESDE con formato YYYY-MM-DD', () => {
    expect(resolverPrimerDia('2026-11-02').toISODate()).toBe('2026-11-02');
  });

  it('rechaza un SEED_DESDE mal formado', () => {
    expect(() => resolverPrimerDia('02/11/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => resolverPrimerDia('2026-13-40')).toThrow(/YYYY-MM-DD/);
  });
});
