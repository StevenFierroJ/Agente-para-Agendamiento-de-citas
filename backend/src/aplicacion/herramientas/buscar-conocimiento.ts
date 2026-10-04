import { z } from 'zod';
import type { BaseConocimiento, EmbeddingClient, Herramienta } from '../puertos.js';
import { definir, validarArgumentos } from './validar.js';

export const FRAGMENTOS_POR_BUSQUEDA = 4;

const Argumentos = z
  .object({ pregunta: z.string().trim().min(3).max(500).describe('La pregunta del paciente, en sus palabras o reformulada') })
  .strict();

/**
 * Búsqueda semántica en los documentos de la clínica. Devuelve solo los
 * fragmentos con similitud ≥ umbral; si ninguno lo alcanza, `sin_resultados`:
 * el modelo no recibe texto "parecido" del que pueda inventar una respuesta.
 */
export function crearBuscarConocimiento(embeddings: EmbeddingClient, base: BaseConocimiento, umbral: number): Herramienta {
  return {
    definicion: definir(
      'buscar_conocimiento',
      'Busca en los documentos de la clínica (horarios, sedes, especialidades, preparación de exámenes, cancelación, cobertura y pagos, documentos para la cita). ' +
        'Devuelve los 4 fragmentos más cercanos: una búsqueda por tema. Si la pregunta mezcla varios (servicios y horarios, o las dos sedes), busca una vez por cada uno. Responde solo con lo que devuelva.',
      Argumentos,
    ),
    async ejecutar(argumentos) {
      const validados = validarArgumentos(Argumentos, argumentos);
      if (!validados.ok) return validados;

      const vector = await embeddings.embeberConsulta(validados.datos.pregunta);
      const fragmentos = (await base.buscar(vector, FRAGMENTOS_POR_BUSQUEDA)).filter((f) => f.similitud >= umbral);
      if (fragmentos.length === 0) {
        return {
          ok: false,
          error: 'sin_resultados',
          detalle: 'Los documentos de la clínica no tienen información sobre esto. No respondas de memoria: dilo o escala.',
        };
      }
      return {
        ok: true,
        datos: {
          fragmentos: fragmentos.map((f) => ({
            documento: f.titulo,
            seccion: f.seccion,
            texto: f.texto,
            similitud: Math.round(f.similitud * 1000) / 1000,
          })),
        },
      };
    },
  };
}
