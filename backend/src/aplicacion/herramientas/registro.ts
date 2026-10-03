import type { Agenda, BaseConocimiento, EmbeddingClient, Herramienta, RepositorioMensajes } from '../puertos.js';
import { crearAgendarCita } from './agendar-cita.js';
import { crearBuscarConocimiento } from './buscar-conocimiento.js';
import { crearConsultarDisponibilidad } from './consultar-disponibilidad.js';
import { crearEscalarAHumano } from './escalar-a-humano.js';

export interface DependenciasHerramientas {
  agenda: Agenda;
  catalogo: Pick<RepositorioMensajes, 'catalogo'>;
  conocimiento: { embeddings: EmbeddingClient; base: BaseConocimiento; umbral: number };
}

/** Las herramientas que el modelo puede pedir, por nombre. */
export function crearHerramientas(deps: DependenciasHerramientas): Map<string, Herramienta> {
  const herramientas = [
    crearBuscarConocimiento(deps.conocimiento.embeddings, deps.conocimiento.base, deps.conocimiento.umbral),
    crearConsultarDisponibilidad(deps.agenda, deps.catalogo),
    crearAgendarCita(deps.agenda),
    crearEscalarAHumano(),
  ];
  return new Map(herramientas.map((h) => [h.definicion.nombre, h]));
}
