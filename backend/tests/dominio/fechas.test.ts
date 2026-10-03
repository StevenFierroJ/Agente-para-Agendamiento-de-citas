import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  ZONA_COLOMBIA, ahoraDelMensaje, contextoTemporal, esDiaPasado, esHorarioPasado, horaLocal, parsearFechaLocal, rangoDelDia,
} from '../../src/dominio/fechas.js';

// El caso del enunciado: 03:40 UTC del 6 de octubre = 22:40 del lunes 5 en Cali.
const ENUNCIADO = ahoraDelMensaje(new Date('2026-10-06T03:40:00Z'));

function dia(texto: string): DateTime {
  const r = parsearFechaLocal(texto);
  if (!r.ok) throw new Error(r.detalle);
  return r.dia;
}

describe('hora de Colombia', () => {
  it('el ahora del enunciado es el lunes 5 a las 22:40, y mañana es el 6', () => {
    const ctx = contextoTemporal(ENUNCIADO);
    expect(ctx).toEqual({
      fecha: '2026-10-05',
      hora: '22:40',
      diaSemana: 'lunes',
      fechaLarga: 'lunes 5 de octubre de 2026',
      manana: '2026-10-06',
    });
  });

  it('el ahora sale del timestamp del mensaje, no del reloj del servidor', () => {
    const viejo = ahoraDelMensaje(new Date('2020-01-01T12:00:00Z'));
    expect(contextoTemporal(viejo).fecha).toBe('2020-01-01');
  });

  it('el día local se consulta como un intervalo UTC de 05:00 a 05:00', () => {
    const { desde, hasta } = rangoDelDia(dia('2026-10-06'));
    expect(desde.toISOString()).toBe('2026-10-06T05:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-10-07T05:00:00.000Z');
  });

  it('a las 22:40 del 5, el 5 es hoy (no pasado) y el 4 sí es pasado', () => {
    expect(esDiaPasado(dia('2026-10-05'), ENUNCIADO)).toBe(false);
    expect(esDiaPasado(dia('2026-10-04'), ENUNCIADO)).toBe(true);
    expect(esDiaPasado(dia('2026-10-06'), ENUNCIADO)).toBe(false);
  });

  it('un horario es pasado si ya empezó', () => {
    const ahora = ahoraDelMensaje(new Date('2026-10-07T14:00:00Z')); // 09:00 en Cali
    expect(esHorarioPasado(new Date('2026-10-07T13:30:00Z'), ahora)).toBe(true);
    expect(esHorarioPasado(new Date('2026-10-07T14:00:00Z'), ahora)).toBe(true);
    expect(esHorarioPasado(new Date('2026-10-07T14:30:00Z'), ahora)).toBe(false);
  });

  it('nombra un horario en hora local', () => {
    expect(horaLocal(new Date('2026-10-06T19:00:00Z'))).toBe('2026-10-06T14:00');
  });
});

describe('parsearFechaLocal', () => {
  it('acepta YYYY-MM-DD como el inicio del día en Colombia', () => {
    const d = dia('2026-10-06');
    expect(d.zoneName).toBe(ZONA_COLOMBIA);
    expect(d.toISO()).toBe('2026-10-06T00:00:00.000-05:00');
  });

  it.each(['07/10/2026', '2026-10-6', '2026-10-06T10:00', 'mañana', '', '2026-02-30', '2026-13-01'])(
    'rechaza "%s"',
    (texto) => {
      expect(parsearFechaLocal(texto).ok).toBe(false);
    },
  );
});
