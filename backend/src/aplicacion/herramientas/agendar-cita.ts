import { z } from 'zod';
import { decidirAgendamiento, validarNombrePaciente } from '../../dominio/agenda.js';
import { horaLocal } from '../../dominio/fechas.js';
import type { Agenda, Herramienta } from '../puertos.js';
import { definir, validarArgumentos } from './validar.js';

// Sin campos de texto libre (motivo, síntomas): el esquema estricto los rechaza.
// El teléfono no es argumento: la cita se asocia a la conversación del turno.
const Argumentos = z
  .object({
    horario_id: z.number().int().positive().describe('El horario_id exacto que devolvió consultar_disponibilidad'),
    nombre_paciente: z.string().describe('Nombre completo del paciente'),
  })
  .strict();

export function crearAgendarCita(agenda: Agenda): Herramienta {
  return {
    definicion: definir(
      'agendar_cita',
      'Agenda una cita en un horario libre. Usar solo con un horario_id devuelto por consultar_disponibilidad y el nombre completo del paciente.',
      Argumentos,
    ),
    async ejecutar(argumentos, { conversacionId, ahora }) {
      const validados = validarArgumentos(Argumentos, argumentos);
      if (!validados.ok) return validados;

      const nombre = validarNombrePaciente(validados.datos.nombre_paciente);
      if (!nombre.ok) return { ok: false, error: 'nombre_invalido', detalle: nombre.detalle };

      const resultado = await agenda.agendar(
        { horarioId: validados.datos.horario_id, conversacionId, nombrePaciente: nombre.nombre },
        (horario, citaActiva) => decidirAgendamiento(horario, citaActiva, conversacionId, ahora),
      );
      if (resultado.tipo === 'error') {
        const detalles = {
          horario_inexistente: `No existe el horario ${validados.datos.horario_id}; consulta la disponibilidad primero`,
          horario_pasado: 'Ese horario ya empezó o pasó',
          horario_ocupado: 'Ese horario ya fue tomado; consulta la disponibilidad de nuevo',
        } as const;
        return { ok: false, error: resultado.error, detalle: detalles[resultado.error] };
      }
      return {
        ok: true,
        datos: {
          cita_id: resultado.citaId,
          ya_estaba_agendada: resultado.tipo === 'ya_era_tuya',
          inicio: horaLocal(resultado.horario.inicio),
          especialidad: resultado.horario.especialidad,
          sede: resultado.horario.sede,
          profesional: resultado.horario.profesional,
          nombre_paciente: nombre.nombre,
        },
      };
    },
  };
}
