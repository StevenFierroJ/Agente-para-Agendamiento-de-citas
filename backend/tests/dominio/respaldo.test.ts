import { describe, expect, it } from 'vitest';
import { datosSinRespaldo } from '../../src/dominio/respaldo.js';

const FRAGMENTO = 'Sedes — Sede Sur\nDirección: Calle 16 # 100-25, barrio Ciudad Jardín, Cali.';
const DISPONIBILIDAD = JSON.stringify({ horarios: [{ inicio: '2026-10-06T14:00' }, { inicio: '2026-10-06T14:30' }] });

describe('datosSinRespaldo', () => {
  it('acepta datos que están en la evidencia', () => {
    expect(datosSinRespaldo('La Sede Sur queda en la Calle 16 # 100-25.', [FRAGMENTO])).toEqual([]);
  });

  it('acepta horas convertidas a 12 horas y fechas sin cero inicial', () => {
    expect(datosSinRespaldo('Tengo el martes 6 a las 2:00 p. m. y a las 2:30 p. m.', [DISPONIBILIDAD])).toEqual([]);
  });

  it('acepta números escritos en letras en la fuente', () => {
    expect(datosSinRespaldo('Ofrecemos 3 especialidades.', ['La clínica ofrece tres especialidades.'])).toEqual([]);
  });

  it('acepta números que vienen del paciente o del prompt', () => {
    expect(datosSinRespaldo('Hoy a las 22:40 ya no quedan citas.', ['son las 22:40'])).toEqual([]);
  });

  it('detecta un teléfono inventado', () => {
    expect(datosSinRespaldo('Puedes llamar al 602 555 1234.', [FRAGMENTO])).toEqual(['602 555 1234']);
  });

  it('detecta un precio inventado, con o sin puntos de miles', () => {
    expect(datosSinRespaldo('La consulta cuesta $120.000.', [FRAGMENTO])).toEqual(['$120000']);
    expect(datosSinRespaldo('Cuesta 80000 pesos.', [FRAGMENTO])).toEqual(['80000']);
  });

  it('detecta una hora inventada', () => {
    expect(datosSinRespaldo('Abrimos a las 9:00 a. m.', ['La Sede Norte atiende de 7:00 a. m. a 6:00 p. m.'])).toEqual(['9:00']);
  });

  it('una respuesta sin números no tiene nada que verificar', () => {
    expect(datosSinRespaldo('No tengo esa información; un asesor te ayudará.', [])).toEqual([]);
  });
});
