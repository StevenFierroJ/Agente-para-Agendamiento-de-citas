import { z } from 'zod';
import { franjasPorDia, horariosLibres, resolverNombre } from '../../dominio/agenda.js';
import { avisoFinDeAgenda, esDiaPasado, parsearFechaLocal, rangoDelDia } from '../../dominio/fechas.js';
import type { Agenda, Herramienta, RepositorioMensajes } from '../puertos.js';
import { definir, validarArgumentos } from './validar.js';

/** Lo que cubre la agenda (seed de 14 días): un rango más largo se recorta y se avisa. */
const DIAS_MAXIMOS = 14;

const Argumentos = z
  .object({
    especialidad: z.string().min(1).max(80).describe('Nombre de la especialidad, de la lista de especialidades válidas'),
    desde: z.string().describe('Primer día del rango, formato YYYY-MM-DD, en hora de Colombia'),
    hasta: z.string().describe('Último día del rango (incluido), formato YYYY-MM-DD, en hora de Colombia'),
    sede: z.string().min(1).max(80).optional().describe('Nombre de la sede; omítela si el paciente no la dijo y se consultan todas'),
  })
  .strict();

export function crearResumirDisponibilidad(agenda: Agenda, catalogo: Pick<RepositorioMensajes, 'catalogo'>): Herramienta {
  return {
    definicion: definir(
      'resumir_disponibilidad',
      `Disponibilidad de una especialidad en un rango de hasta ${DIAS_MAXIMOS} días, por sede y día, en franjas horarias (por ejemplo 08:00-12:00). ` +
        'Para preguntas como "¿qué hay la próxima semana?". No sirve para agendar: cuando el paciente elija día, consulta ese día con consultar_disponibilidad.',
      Argumentos,
    ),
    async ejecutar(argumentos, { ahora }) {
      const validados = validarArgumentos(Argumentos, argumentos);
      if (!validados.ok) return validados;
      const { especialidad, sede } = validados.datos;

      const desde = parsearFechaLocal(validados.datos.desde);
      if (!desde.ok) return { ok: false, error: 'argumentos_invalidos', detalle: `desde: ${desde.detalle}` };
      const hasta = parsearFechaLocal(validados.datos.hasta);
      if (!hasta.ok) return { ok: false, error: 'argumentos_invalidos', detalle: `hasta: ${hasta.detalle}` };
      if (hasta.dia < desde.dia) {
        return { ok: false, error: 'argumentos_invalidos', detalle: `hasta (${validados.datos.hasta}) es anterior a desde (${validados.datos.desde})` };
      }

      const { sedes, especialidades, finDeAgenda } = await catalogo.catalogo();
      const laEspecialidad = resolverNombre(especialidad, especialidades);
      if (!laEspecialidad) {
        return {
          ok: false,
          error: 'especialidad_inexistente',
          detalle: `No existe "${especialidad}". Especialidades válidas: ${especialidades.map((e) => e.nombre).join(', ')}`,
        };
      }
      const lasSedes = sede === undefined ? sedes : [resolverNombre(sede, sedes)];
      if (lasSedes.some((s) => s === null)) {
        return { ok: false, error: 'sede_inexistente', detalle: `No existe "${sede}". Sedes válidas: ${sedes.map((s) => s.nombre).join(', ')}` };
      }
      if (esDiaPasado(hasta.dia, ahora)) {
        return { ok: false, error: 'fecha_pasada', detalle: `${validados.datos.hasta} ya pasó; hoy es ${ahora.toISODate()}` };
      }

      // Un rango que empieza en el pasado se toma desde hoy; uno muy largo se recorta, y el resultado lo dice.
      // Lo que pasa del último día con agenda tampoco se consulta: allí no hay agenda todavía (D-42).
      const hoy = ahora.setZone(desde.dia.zone).startOf('day');
      const primero = esDiaPasado(desde.dia, ahora) ? hoy : desde.dia;
      const fin = finDeAgenda ? parsearFechaLocal(finDeAgenda) : null;
      if (fin?.ok && primero > fin.dia) {
        return { ok: false, error: 'fuera_de_agenda', detalle: avisoFinDeAgenda(finDeAgenda!) };
      }
      const tope = primero.plus({ days: DIAS_MAXIMOS - 1 });
      const porAgenda = fin?.ok && fin.dia < tope;
      const limite = porAgenda && fin?.ok ? fin.dia : tope;
      const ultimo = hasta.dia > limite ? limite : hasta.dia;
      const recortado =
        ultimo < hasta.dia
          ? porAgenda
            ? avisoFinDeAgenda(finDeAgenda!)
            : `Solo se consultaron ${DIAS_MAXIMOS} días; después del ${ultimo.toISODate()} hay que preguntar de nuevo.`
          : null;

      const resumen = [];
      for (const laSede of lasSedes) {
        if (!laSede) continue;
        const horarios = await agenda.horariosDelDia(laEspecialidad.id, laSede.id, rangoDelDia(primero).desde, rangoDelDia(ultimo).hasta);
        const dias = franjasPorDia(horariosLibres(horarios, ahora));
        if (dias.length > 0) resumen.push({ sede: laSede.nombre, dias });
      }
      const rango = `${primero.toISODate()} a ${ultimo.toISODate()}`;
      if (resumen.length === 0) {
        return {
          ok: false,
          error: 'sin_horarios',
          detalle: `No hay horarios libres de ${laEspecialidad.nombre} del ${rango}${recortado ? `. ${recortado}` : ''}`,
        };
      }
      return {
        ok: true,
        datos: {
          especialidad: laEspecialidad.nombre,
          desde: primero.toISODate(),
          hasta: ultimo.toISODate(),
          ...(recortado && { recortado }),
          sedes: resumen,
        },
      };
    },
  };
}
