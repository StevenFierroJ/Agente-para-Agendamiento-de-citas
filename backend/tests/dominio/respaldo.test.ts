import { describe, expect, it } from 'vitest';
import { citarEnContexto, datosSinRespaldo, horasSinRespaldo } from '../../src/dominio/respaldo.js';

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

describe('horasSinRespaldo (D-38)', () => {
  // Caso real: consultar_disponibilidad del miércoles 7 en la Sede Norte (el último bloque empieza 17:30).
  const MIERCOLES = JSON.stringify({
    fecha: '2026-10-07',
    horarios: ['14:00', '14:30', '16:00', '16:30', '17:00', '17:30'].map((h) => ({ inicio: `2026-10-07T${h}`, profesional: 'Dra. Camila Restrepo' })),
  });

  it('detecta una hora armada con números que están en otro lado: 6:30 p. m. no existe', () => {
    const respuesta = 'Horarios disponibles: 4:00 p. m., 4:30 p. m., 5:00 p. m., 5:30 p. m., 6:00 p. m., 6:30 p. m.';
    const evidencia = [MIERCOLES, 'Hay disponibilidad de 4:00 p. m. - 6:00 p. m.'];
    expect(horasSinRespaldo(respuesta, evidencia)).toEqual(['6:30 p. m.']);
    expect(datosSinRespaldo(respuesta, evidencia)).toEqual(['6:30 p. m.']);
  });

  it('acepta las horas de los horarios en 12 h y en 24 h', () => {
    expect(horasSinRespaldo('Tengo 2:00 p. m., 2:30 pm y 16:30.', [MIERCOLES])).toEqual([]);
  });

  it('acepta una hora dentro de una franja y sus límites, incluido el mediodía', () => {
    const franjas = JSON.stringify({ franjas: ['08:00-12:00', '14:00-18:00'] });
    expect(horasSinRespaldo('Puede ser a las 9:30 a. m., hasta las 12:00 m., o de 2:00 a 6:00 p. m.', [franjas])).toEqual([]);
    expect(horasSinRespaldo('También a la 1:00 p. m.', [franjas])).toEqual(['1:00 p. m.']);
  });

  it('a. m. y p. m. no se confunden: 4:30 p. m. no la respalda un 04:30', () => {
    expect(horasSinRespaldo('Tu cita es a las 4:30 p. m.', ['inicio 2026-10-07T04:30'])).toEqual(['4:30 p. m.']);
    expect(horasSinRespaldo('Abrimos a las 8 a. m.', ['abre 08:00'])).toEqual([]);
  });

  it('una hora sin a. m. ni p. m. vale si cualquiera de las dos lecturas está respaldada', () => {
    expect(horasSinRespaldo('Te espero a las 2:30.', [MIERCOLES])).toEqual([]);
  });

  it('las fechas y las direcciones no son horas', () => {
    expect(horasSinRespaldo('El 2026-10-07 en la Calle 16 # 100-25.', [])).toEqual([]);
  });

  it('una franja escrita en 12 h en los documentos respalda las horas de adentro', () => {
    const documento = 'La Sede Sur atiende de lunes a viernes de 8:00 a. m. a 6:00 p. m.';
    expect(horasSinRespaldo('Puedes llegar a las 10:30 a. m.', [documento])).toEqual([]);
    expect(horasSinRespaldo('Abrimos a las 7:00 a. m.', [documento])).toEqual(['7:00 a. m.']);
  });

  it('las horas solo las respaldan los datos: lo que el modelo dijo antes no cuenta', () => {
    const dichoAntes = 'El miércoles hay de 2:00 a 5:00 p. m.';
    const respuesta = 'El miércoles tengo 2:00 p. m. y 5:00 p. m.';
    // Con todo como evidencia, los números y las horas pasan.
    expect(datosSinRespaldo(respuesta, [dichoAntes])).toEqual([]);
    // Con solo datos (prompt y herramientas) para las horas, no.
    expect(datosSinRespaldo(respuesta, [dichoAntes], ['Hoy es lunes, son las 09:00.'])).toEqual(['2:00 p. m.', '5:00 p. m.']);
  });
});

describe('citarEnContexto (D-40)', () => {
  it('cita la frase donde está cada dato, para que el modelo sepa qué quitar', () => {
    const respuesta = 'Atendemos en la Sede Sur desde las 13:00. Aceptamos las 3 medicinas prepagadas, incluida Sura.';
    expect(citarEnContexto(respuesta, ['3'], 20)).toEqual(['«3» en "…3:00. Aceptamos las 3 medicinas prepagada…"']);
  });

  it('una fecha incoherente se busca sin su explicación', () => {
    const respuesta = 'Tu cita es el Lunes 7 de octubre a las 11:00 a. m.';
    expect(citarEnContexto(respuesta, ['Lunes 7 de octubre (el 7 de octubre es miércoles)'], 10)).toEqual([
      '«Lunes 7 de octubre (el 7 de octubre es miércoles)» en "…ita es el Lunes 7 de octubre a las 11:…"',
    ]);
  });

  it('si no encuentra el dato, lo devuelve solo', () => {
    expect(citarEnContexto('Hola', ['99'])).toEqual(['«99»']);
  });
});

