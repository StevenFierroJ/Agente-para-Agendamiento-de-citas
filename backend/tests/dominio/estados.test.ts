import { describe, expect, it } from 'vitest';
import { estadoFinalDelTurno, siguienteEstadoConversacion } from '../../src/dominio/estados.js';

const NADA = { agendoCita: false, escaloElModelo: false, agotoIteraciones: false, fallaDelLlm: false, datoSinRespaldo: false, escalamientoPrometido: false, citaNoAgendada: false };

describe('estado final del turno', () => {
  it('respuesta sin más → resuelta_por_ia', () => {
    expect(estadoFinalDelTurno(NADA)).toBe('resuelta_por_ia');
  });

  it('agendó → cita_agendada', () => {
    expect(estadoFinalDelTurno({ ...NADA, agendoCita: true })).toBe('cita_agendada');
  });

  it.each([['escaloElModelo'], ['agotoIteraciones'], ['fallaDelLlm'], ['datoSinRespaldo'], ['escalamientoPrometido'], ['citaNoAgendada']] as const)('%s → escalada', (hecho) => {
    expect(estadoFinalDelTurno({ ...NADA, [hecho]: true })).toBe('escalada');
  });

  it('agendó y escaló en el mismo turno → escalada', () => {
    expect(estadoFinalDelTurno({ ...NADA, agendoCita: true, escaloElModelo: true })).toBe('escalada');
  });
});

describe('estado de la conversación', () => {
  it('sube de prioridad con el turno', () => {
    expect(siguienteEstadoConversacion('abierta', 'resuelta_por_ia')).toBe('resuelta_por_ia');
    expect(siguienteEstadoConversacion('resuelta_por_ia', 'cita_agendada')).toBe('cita_agendada');
    expect(siguienteEstadoConversacion('cita_agendada', 'escalada')).toBe('escalada');
  });

  it('no baja: un "gracias" después de agendar no borra la cita de la bandeja', () => {
    expect(siguienteEstadoConversacion('cita_agendada', 'resuelta_por_ia')).toBe('cita_agendada');
  });

  it('escalada es terminal', () => {
    expect(siguienteEstadoConversacion('escalada', 'resuelta_por_ia')).toBe('escalada');
  });
});
