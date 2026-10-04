import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  ZONA_COLOMBIA, ahoraDelMensaje, contextoTemporal, diaDeLaSemana, esDiaPasado, esHorarioPasado, fechasIncoherentes, horaLocal,
  parsearFechaLocal, rangoDelDia,
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
    expect(ctx).toMatchObject({
      fecha: '2026-10-05',
      hora: '22:40',
      diaSemana: 'lunes',
      fechaLarga: 'lunes 5 de octubre de 2026',
      manana: '2026-10-06',
    });
  });

  it('el calendario del prompt trae 14 días con su día de la semana, calculados por el código (D-39)', () => {
    // Caso real: domingo 4 a las 9:04 a. m.; el paciente dijo "el lunes" y el modelo consultó el 7.
    const { calendario } = contextoTemporal(ahoraDelMensaje(new Date('2026-10-04T14:04:00Z')));
    expect(calendario).toHaveLength(14);
    expect(calendario.slice(0, 4)).toEqual([
      'domingo 4 de octubre: 2026-10-04 (hoy)',
      'lunes 5 de octubre: 2026-10-05 (mañana)',
      'martes 6 de octubre: 2026-10-06',
      'miércoles 7 de octubre: 2026-10-07',
    ]);
    expect(calendario.at(-1)).toBe('sábado 17 de octubre: 2026-10-17');
  });

  it('el día de la semana de una fecha', () => {
    expect(diaDeLaSemana('2026-10-07')).toBe('miércoles');
    expect(diaDeLaSemana('2026-10-05')).toBe('lunes');
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

describe('fechasIncoherentes (D-39)', () => {
  const DOMINGO_4 = ahoraDelMensaje(new Date('2026-10-04T14:04:00Z'));

  it('detecta el caso real: "Lunes 7 de octubre" cuando el 7 es miércoles', () => {
    expect(fechasIncoherentes('¡Listo! Lunes 7 de octubre, 11:00 a. m.', DOMINGO_4)).toEqual(['Lunes 7 de octubre (el 7 de octubre es miércoles)']);
  });

  it('acepta fechas coherentes, con o sin mes y con tildes o sin ellas', () => {
    expect(fechasIncoherentes('El lunes 5, el miércoles 7 y el miercoles 14 de octubre; el sábado 10.', DOMINGO_4)).toEqual([]);
  });

  it('sin mes, un día que ya pasó en este mes es del siguiente; con mes pasado, del año siguiente', () => {
    expect(fechasIncoherentes('el martes 3', DOMINGO_4)).toEqual([]); // 3 de noviembre de 2026: martes
    expect(fechasIncoherentes('el domingo 3 de enero', DOMINGO_4)).toEqual([]); // 3 de enero de 2027: domingo
    expect(fechasIncoherentes('el lunes 3 de enero', DOMINGO_4)).toEqual(['lunes 3 de enero (el 3 de enero es domingo)']);
  });

  it('un día de la semana sin número, o un número sin día, no se verifica', () => {
    expect(fechasIncoherentes('el lunes a las 11 y el 7 de octubre', DOMINGO_4)).toEqual([]);
  });
});
