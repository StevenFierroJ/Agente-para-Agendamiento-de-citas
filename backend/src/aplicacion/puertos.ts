import type { DateTime } from 'luxon';
import type { ErrorHerramienta } from '../dominio/errores.js';

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export type MensajeLlm =
  | { rol: 'sistema'; contenido: string }
  | { rol: 'paciente'; contenido: string }
  | { rol: 'asistente'; contenido: string }
  // El mensaje del asistente que pidió herramientas se reenvía tal como llegó:
  // el proveedor puede incluir campos que necesita de vuelta.
  | { rol: 'asistente_con_llamadas'; crudo: unknown }
  | { rol: 'herramienta'; llamadaId: string; contenido: string };

export interface DefinicionHerramienta {
  nombre: string;
  descripcion: string;
  /** JSON Schema de los argumentos. */
  parametros: Record<string, unknown>;
}

export interface PedidoLlm {
  mensajes: readonly MensajeLlm[];
  herramientas: readonly DefinicionHerramienta[];
  senal: AbortSignal;
  /** El message_id del turno. El cliente real lo ignora; el falso responde según él. */
  etiqueta: string;
}

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  /** Tal como los mandó el modelo: puede no ser JSON válido. */
  argumentosCrudos: string;
}

export interface RespuestaLlm {
  texto: string | null;
  llamadas: LlamadaHerramienta[];
  mensajeCrudo: unknown;
  tokensEntrada: number;
  tokensSalida: number;
  modelo: string;
}

export type TipoFallaLlm = 'timeout' | 'proveedor';

export class ErrorLlm extends Error {
  constructor(
    readonly tipo: TipoFallaLlm,
    mensaje: string,
    opciones?: { cause?: unknown },
  ) {
    super(mensaje, opciones);
    this.name = 'ErrorLlm';
  }
}

export interface LlmClient {
  completar(pedido: PedidoLlm): Promise<RespuestaLlm>;
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

export interface ContextoHerramienta {
  conversacionId: number;
  /** El ahora del turno: timestamp del mensaje en hora de Colombia. */
  ahora: DateTime;
}

export type ResultadoHerramienta =
  | { ok: true; datos: unknown }
  | { ok: false; error: ErrorHerramienta; detalle: string };

export interface Herramienta {
  definicion: DefinicionHerramienta;
  /** Recibe los argumentos ya parseados como JSON y los valida con su esquema. */
  ejecutar(argumentos: unknown, contexto: ContextoHerramienta): Promise<ResultadoHerramienta>;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingClient {
  /** Vector normalizado de 384 dimensiones. */
  embeberConsulta(texto: string): Promise<number[]>;
  embeberPasajes(textos: readonly string[]): Promise<number[][]>;
}
