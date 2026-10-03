import { describe, expect, it } from 'vitest';
import { decidirAgendamiento, horariosLibres, normalizar, resolverNombre, validarNombrePaciente } from '../../src/dominio/agenda.js';
import { ahoraDelMensaje } from '../../src/dominio/fechas.js';

const SEDES = [{ id: 1, nombre: 'Sede Norte' }, { id: 2, nombre: 'Sede Sur' }];
const ESPECIALIDADES = [{ id: 1, nombre: 'Medicina general' }, { id: 2, nombre: 'Dermatología' }, { id: 3, nombre: 'Pediatría' }];

describe('resolverNombre', () => {
  it('ignora mayúsculas, tildes y espacios', () => {
    expect(normalizar('  DERMATOLOGÍA ')).toBe('dermatologia');
    expect(resolverNombre('dermatologia', ESPECIALIDADES)?.id).toBe(2);
    expect(resolverNombre('Medicina   General', ESPECIALIDADES)?.id).toBe(1);
  });

  it('encuentra la sede sin la palabra "sede"', () => {
    expect(resolverNombre('norte', SEDES)?.id).toBe(1);
    expect(resolverNombre('SEDE SUR', SEDES)?.id).toBe(2);
  });

  it('no adivina: lo que no está en el catálogo es null', () => {
    expect(resolverNombre('Sede Centro', SEDES)).toBeNull();
    expect(resolverNombre('Cardiología', ESPECIALIDADES)).toBeNull();
    expect(resolverNombre('derma', ESPECIALIDADES)).toBeNull();
    expect(resolverNombre('   ', SEDES)).toBeNull();
  });
});

describe('validarNombrePaciente', () => {
  it.each(['Ana María Pérez', "D'Angelo Ruiz", 'María-José Gómez', 'Lu', 'Ñuño Ibáñez'])('acepta "%s"', (nombre) => {
    expect(validarNombrePaciente(nombre).ok).toBe(true);
  });

  it.each(['Juan 123', 'J', '', '   ', 'Ana; DROP TABLE', 'ana@correo.com', '--', 'x'.repeat(81), '+573001112233'])(
    'rechaza "%s"',
    (nombre) => {
      expect(validarNombrePaciente(nombre).ok).toBe(false);
    },
  );

  it('colapsa los espacios', () => {
    expect(validarNombrePaciente('  Ana   María ')).toEqual({ ok: true, nombre: 'Ana María' });
  });
});

describe('decidirAgendamiento', () => {
  const ahora = ahoraDelMensaje(new Date('2026-10-07T14:00:00Z')); // miércoles 09:00 en Cali
  const futuro = { id: 10, inicio: new Date('2026-10-07T15:00:00Z') };
  const pasado = { id: 11, inicio: new Date('2026-10-07T13:00:00Z') };

  it('agenda un horario libre y futuro', () => {
    expect(decidirAgendamiento(futuro, null, 1, ahora)).toEqual({ tipo: 'agendar' });
  });

  it('horario que no existe', () => {
    expect(decidirAgendamiento(null, null, 1, ahora)).toEqual({ tipo: 'error', error: 'horario_inexistente' });
  });

  it('horario que ya empezó', () => {
    expect(decidirAgendamiento(pasado, null, 1, ahora)).toEqual({ tipo: 'error', error: 'horario_pasado' });
  });

  it('horario con cita activa de otra conversación', () => {
    expect(decidirAgendamiento(futuro, { id: 5, conversacionId: 2 }, 1, ahora)).toEqual({ tipo: 'error', error: 'horario_ocupado' });
  });

  it('horario con cita activa de la misma conversación: éxito con esa cita (reintento del turno)', () => {
    expect(decidirAgendamiento(futuro, { id: 5, conversacionId: 1 }, 1, ahora)).toEqual({ tipo: 'ya_es_tuya', citaId: 5 });
  });

  it('el reintento que llega después de la hora sigue devolviendo la misma cita', () => {
    expect(decidirAgendamiento(pasado, { id: 6, conversacionId: 1 }, 1, ahora)).toEqual({ tipo: 'ya_es_tuya', citaId: 6 });
  });
});

describe('horariosLibres', () => {
  it('quita los ocupados y los que ya empezaron, y ordena por inicio', () => {
    const ahora = ahoraDelMensaje(new Date('2026-10-07T14:00:00Z'));
    const libres = horariosLibres(
      [
        { id: 3, inicio: new Date('2026-10-07T16:00:00Z'), ocupado: false },
        { id: 1, inicio: new Date('2026-10-07T13:30:00Z'), ocupado: false },
        { id: 2, inicio: new Date('2026-10-07T15:00:00Z'), ocupado: true },
        { id: 4, inicio: new Date('2026-10-07T14:30:00Z'), ocupado: false },
      ],
      ahora,
    );
    expect(libres.map((h) => h.id)).toEqual([4, 3]);
  });
});
