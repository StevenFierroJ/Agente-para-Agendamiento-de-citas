import { describe, expect, it } from 'vitest';
import { afirmaCitaAgendada, mencionaReservaDeCita, prometeEscalamiento } from '../../src/dominio/promesas.js';

describe('prometeEscalamiento', () => {
  it.each([
    'Claro, te paso con un asesor de la clínica en un momento.',
    'Te comunico con un asesor. Un asesor continuará contigo.',
    'Un asesor de la clínica te contactará pronto.',
    'Listo, ya escalé tu solicitud.',
    'Voy a pasarte con una persona del equipo.',
  ])('promesa: %s', (texto) => {
    expect(prometeEscalamiento(texto)).toBe(true);
  });

  it.each([
    '¿Quieres que te pase con un asesor?',
    'Si prefieres, ¿te comunico con un asesor?',
    'No tengo esa información. ¿Quieres que un asesor te contacte?',
    'Tu cita quedó agendada para el martes a las 2:00 p. m.',
    'Para cancelar, un asesor debe hacerlo: escríbelo por este chat.',
  ])('no es promesa: %s', (texto) => {
    expect(prometeEscalamiento(texto)).toBe(false);
  });
});

describe('afirmaCitaAgendada', () => {
  it.each([
    'Excelente, tu cita está agendada ✅',
    'Listo, tu cita quedó confirmada para el martes a las 2:00 p. m.',
    'Agendé tu cita con el Dr. Julián Mora.',
    'Confirmamos tu cita para mañana.',
    'Listo: cita de dermatología el martes 6.',
    'Perfecto, confirmo tu cita con Dermatología en Sede Sur mañana a las 2:00 p. m.',
    'Te dejo la cita agendada para el martes.',
    'Ya tienes tu cita confirmada.',
    'Perfecto, he agendado tu cita con Dermatología en la Sede Sur.',
  ])('afirma: %s', (texto) => {
    expect(afirmaCitaAgendada(texto)).toBe(true);
  });

  it.each([
    '¿Confirmo tu cita a ese horario?',
    '¿Quieres que agende la cita de las 2:00 p. m.?',
    'Hay cita a las 2:00 p. m. con el Dr. Julián Mora.',
    'Para cancelar una cita escribe por este chat.',
    'No pude agendar: ese horario ya fue tomado.',
  ])('no afirma: %s', (texto) => {
    expect(afirmaCitaAgendada(texto)).toBe(false);
  });
});

describe('mencionaReservaDeCita (filtro para el verificador)', () => {
  it.each([
    'Listo ✅ tu cita del martes.',
    'Tu cita ya está apartada para el martes.',
    'Para agendar tu cita necesito tu nombre completo.',
  ])('dispara: %s', (texto) => {
    expect(mencionaReservaDeCita(texto)).toBe(true);
  });

  it.each(['¿Agendo esa cita para Ana?', 'Hay disponibilidad a las 2:00 p. m.', 'La sede atiende de 7 a 6.'])('no dispara: %s', (texto) => {
    expect(mencionaReservaDeCita(texto)).toBe(false);
  });
});
