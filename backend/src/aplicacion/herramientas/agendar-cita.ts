import { z } from 'zod';
import { decidirAgendamiento, normalizar, resolverNombre, validarNombrePaciente } from '../../dominio/agenda.js';
import { diaDeLaSemana, horaLocal, parsearFechaHoraLocal } from '../../dominio/fechas.js';
import type { Agenda, Herramienta, RepositorioMensajes } from '../puertos.js';
import { definir, validarArgumentos } from './validar.js';

// El modelo nombra el horario como lo eligió el paciente (especialidad, sede, día y
// hora) y el código lo resuelve: no hay un id que el modelo pueda inventar o
// confundir (D-37). Sin campos de texto libre (motivo, síntomas): el esquema
// estricto los rechaza. El teléfono no es argumento: la cita es de la conversación.
const Argumentos = z
  .object({
    especialidad: z.string().min(1).max(80).describe('Especialidad del horario elegido'),
    sede: z.string().min(1).max(80).describe('Sede del horario elegido'),
    fecha: z.string().describe('Día del horario elegido, YYYY-MM-DD, en hora de Colombia'),
    hora: z.string().describe('Hora de inicio en 24 h, HH:mm, en hora de Colombia: 4:30 p. m. es 16:30'),
    profesional: z.string().min(1).max(80).optional().describe('Solo si a esa hora atiende más de un profesional'),
    nombre_paciente: z.string().describe('Nombre completo del paciente'),
  })
  .strict();

export function crearAgendarCita(agenda: Agenda, catalogo: Pick<RepositorioMensajes, 'catalogo'>): Herramienta {
  return {
    definicion: definir(
      'agendar_cita',
      'Agenda una cita en un horario que consultar_disponibilidad mostró en esta conversación (o de la lista de horarios ya ofrecidos), con la hora exacta que eligió el paciente y su nombre completo.',
      Argumentos,
    ),
    async ejecutar(argumentos, { conversacionId, ahora }) {
      const validados = validarArgumentos(Argumentos, argumentos);
      if (!validados.ok) return validados;
      const { especialidad, sede, fecha, hora, profesional } = validados.datos;

      const nombre = validarNombrePaciente(validados.datos.nombre_paciente);
      if (!nombre.ok) return { ok: false, error: 'nombre_invalido', detalle: nombre.detalle };

      const { sedes, especialidades } = await catalogo.catalogo();
      const laEspecialidad = resolverNombre(especialidad, especialidades);
      if (!laEspecialidad) {
        return {
          ok: false,
          error: 'especialidad_inexistente',
          detalle: `No existe "${especialidad}". Especialidades válidas: ${especialidades.map((e) => e.nombre).join(', ')}`,
        };
      }
      const laSede = resolverNombre(sede, sedes);
      if (!laSede) {
        return { ok: false, error: 'sede_inexistente', detalle: `No existe "${sede}". Sedes válidas: ${sedes.map((s) => s.nombre).join(', ')}` };
      }
      const inicio = parsearFechaHoraLocal(fecha, hora);
      if (!inicio.ok) return { ok: false, error: 'argumentos_invalidos', detalle: inicio.detalle };

      const aEsaHora = await agenda.horariosQueEmpiezan(laEspecialidad.id, laSede.id, inicio.instante.toJSDate());
      const candidatos = profesional ? aEsaHora.filter((h) => normalizar(h.profesional).includes(normalizar(profesional))) : aEsaHora;
      const cuando = `${laEspecialidad.nombre} en la ${laSede.nombre} el ${fecha} a las ${hora}`;
      if (candidatos.length === 0) {
        return {
          ok: false,
          error: 'horario_inexistente',
          detalle: aEsaHora.length
            ? `A esa hora no atiende "${profesional}" sino: ${aEsaHora.map((h) => h.profesional).join(', ')}`
            : `No hay ningún horario de ${cuando}. Consulta la disponibilidad de ese día y usa una hora que devuelva`,
        };
      }
      if (candidatos.length > 1) {
        return {
          ok: false,
          error: 'argumentos_invalidos',
          detalle: `A esa hora atienden ${candidatos.map((h) => h.profesional).join(' y ')}: indica el profesional que eligió el paciente`,
        };
      }

      const resultado = await agenda.agendar(
        { horarioId: candidatos[0]!.horarioId, conversacionId, nombrePaciente: nombre.nombre },
        (horario, citaActiva) => decidirAgendamiento(horario, citaActiva, conversacionId, ahora),
      );
      if (resultado.tipo === 'error') {
        const detalles = {
          horario_inexistente: `No hay ningún horario de ${cuando}`,
          horario_no_ofrecido: `${cuando} no se le mostró al paciente en esta conversación. Consulta con consultar_disponibilidad el día que eligió y agenda una hora que devuelva`,
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
          dia: diaDeLaSemana(horaLocal(resultado.horario.inicio).slice(0, 10)),
          especialidad: resultado.horario.especialidad,
          sede: resultado.horario.sede,
          profesional: resultado.horario.profesional,
          nombre_paciente: nombre.nombre,
        },
      };
    },
  };
}
