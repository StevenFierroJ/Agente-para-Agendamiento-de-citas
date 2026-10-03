import type { Agenda, Herramienta, RepositorioMensajes } from '../puertos.js';
import { crearAgendarCita } from './agendar-cita.js';
import { crearConsultarDisponibilidad } from './consultar-disponibilidad.js';
import { crearEscalarAHumano } from './escalar-a-humano.js';

export interface DependenciasHerramientas {
  agenda: Agenda;
  catalogo: Pick<RepositorioMensajes, 'catalogo'>;
}

/** Las herramientas que el modelo puede pedir, por nombre. `buscar_conocimiento` llega con el RAG (paso 6). */
export function crearHerramientas(deps: DependenciasHerramientas): Map<string, Herramienta> {
  const herramientas = [crearConsultarDisponibilidad(deps.agenda, deps.catalogo), crearAgendarCita(deps.agenda), crearEscalarAHumano()];
  return new Map(herramientas.map((h) => [h.definicion.nombre, h]));
}
