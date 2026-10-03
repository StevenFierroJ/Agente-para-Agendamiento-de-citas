import { describe, expect, it } from 'vitest';
import { estadoFinalDelTurno, siguienteEstadoConversacion } from '../../src/dominio/estados.js';

const NADA = { agendoCita: false, escaloElModelo: false, agotoIteraciones: false, fallaDelLlm: false };

describe('estado final del turno', () => {
  it('respuesta sin más → resuelta_por_ia', () => {
    expect(estadoFinalDelTurno(NADA)).toBe('resuelta_por_ia');
  });

  it('agendó → cita_agendada', () => {
    expect(estadoFinalDelTurno({ ...NADA, agendoCita: true })).toBe('cita_agendada');
  });

  it.each([['escaloElModelo'], ['agotoIteraciones'], ['fallaDelLlm']] as const)('%s → escalada', (hecho) => {
    expect(estadoFinalDelTurno({ ...NADA, [hecho]: true })).toBe('escalada');
  });

  it('agendó y escaló en el mismo turno → escalada', () => {
    expect(estadoFinalDelTurno({ ...NADA, agendoCita: true, escaloElModelo: true })).toBe('escalada');
  });
});

describe('estado de la conversación', () => {
  it('toma el del último turno', () => {
    expect(siguienteEstadoConversacion('cita_agendada', 'resuelta_por_ia')).toBe('resuelta_por_ia');
    expect(siguienteEstadoConversacion('abierta', 'cita_agendada')).toBe('cita_agendada');
  });

  it('escalada es terminal', () => {
    expect(siguienteEstadoConversacion('escalada', 'resuelta_por_ia')).toBe('escalada');
  });
});
