import { z } from 'zod';
import { horariosLibres, resolverNombre } from '../../dominio/agenda.js';
import { esDiaPasado, horaLocal, parsearFechaLocal, rangoDelDia } from '../../dominio/fechas.js';
import type { Agenda, Herramienta, RepositorioMensajes } from '../puertos.js';
import { definir, validarArgumentos } from './validar.js';

const Argumentos = z
  .object({
    especialidad: z.string().min(1).max(80).describe('Nombre de la especialidad, de la lista de especialidades válidas'),
    sede: z.string().min(1).max(80).describe('Nombre de la sede, de la lista de sedes válidas'),
    fecha: z.string().describe('Día a consultar, formato YYYY-MM-DD, en hora de Colombia'),
  })
  .strict();

export function crearConsultarDisponibilidad(agenda: Agenda, catalogo: Pick<RepositorioMensajes, 'catalogo'>): Herramienta {
  return {
    definicion: definir(
      'consultar_disponibilidad',
      'Horarios libres reales de una especialidad en una sede en un día. Devuelve horario_id, hora y profesional de cada bloque de 30 minutos.',
      Argumentos,
    ),
    async ejecutar(argumentos, { ahora }) {
      const validados = validarArgumentos(Argumentos, argumentos);
      if (!validados.ok) return validados;
      const { especialidad, sede, fecha } = validados.datos;

      const dia = parsearFechaLocal(fecha);
      if (!dia.ok) return { ok: false, error: 'argumentos_invalidos', detalle: dia.detalle };

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
      if (esDiaPasado(dia.dia, ahora)) {
        return { ok: false, error: 'fecha_pasada', detalle: `${fecha} ya pasó; hoy es ${ahora.toISODate()}` };
      }

      const { desde, hasta } = rangoDelDia(dia.dia);
      const libres = horariosLibres(await agenda.horariosDelDia(laEspecialidad.id, laSede.id, desde, hasta), ahora);
      if (libres.length === 0) {
        return { ok: false, error: 'sin_horarios', detalle: `No hay horarios libres de ${laEspecialidad.nombre} en ${laSede.nombre} el ${fecha}` };
      }
      return {
        ok: true,
        datos: {
          especialidad: laEspecialidad.nombre,
          sede: laSede.nombre,
          fecha,
          horarios: libres.map((h) => ({ horario_id: h.horarioId, inicio: horaLocal(h.inicio), profesional: h.profesional })),
        },
      };
    },
  };
}
