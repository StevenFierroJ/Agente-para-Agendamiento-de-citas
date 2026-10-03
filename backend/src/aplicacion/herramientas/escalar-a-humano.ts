import { z } from 'zod';
import { MOTIVOS_ESCALAMIENTO } from '../../dominio/errores.js';
import type { Herramienta } from '../puertos.js';
import { definir, validarArgumentos } from './validar.js';

const Argumentos = z.object({ motivo: z.enum(MOTIVOS_ESCALAMIENTO).describe('Por qué se escala') }).strict();

/**
 * Marca que la conversación necesita un humano. No escribe en la base: el estado
 * `escalada` lo fija el código al cerrar el turno (estadoFinalDelTurno).
 */
export function crearEscalarAHumano(): Herramienta {
  return {
    definicion: definir(
      'escalar_a_humano',
      'Pasa la conversación a un asesor humano de la clínica. Después de usarla, despídete diciendo que un asesor continuará.',
      Argumentos,
    ),
    async ejecutar(argumentos) {
      const validados = validarArgumentos(Argumentos, argumentos);
      if (!validados.ok) return validados;
      return { ok: true, datos: { escalada: true, motivo: validados.datos.motivo } };
    },
  };
}
