import type { DateTime } from 'luxon';
import type { DecisionAgendamiento } from '../dominio/agenda.js';
import type { ErrorHerramienta, EstadoConversacion } from '../dominio/errores.js';
import type { EstadoFinalTurno } from '../dominio/estados.js';

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

// ---------------------------------------------------------------------------
// Persistencia. Las implementaciones viven en infraestructura/.
// ---------------------------------------------------------------------------

export type EstadoMensajeEntrante = 'recibido' | 'procesando' | 'procesado' | 'fallido';

export interface MensajeAProcesar {
  messageId: string;
  conversacionId: number;
  telefono: string;
  texto: string;
  enviadoEn: Date;
  estado: EstadoMensajeEntrante;
  estadoConversacion: EstadoConversacion;
}

export interface ItemCatalogo {
  id: number;
  nombre: string;
}

export interface Catalogo {
  sedes: ItemCatalogo[];
  especialidades: ItemCatalogo[];
}

/** PostgreSQL: mensajes entrantes, estado de las conversaciones y catálogo. */
export interface RepositorioMensajes {
  obtener(messageId: string): Promise<MensajeAProcesar | null>;
  marcar(messageId: string, estado: EstadoMensajeEntrante): Promise<void>;
  actualizarEstadoConversacion(conversacionId: number, estado: EstadoConversacion): Promise<void>;
  catalogo(): Promise<Catalogo>;
}

/**
 * Un mensaje de la conversación. `id` determinista (`<message_id>:entrada|salida`):
 * un reintento del turno sobrescribe, no duplica. Entrada y salida llevan la
 * `fecha` del mensaje del paciente; `orden` (0 entrada, 1 salida) los ordena (D-15).
 */
export interface RegistroMensaje {
  id: string;
  conversacion_id: number;
  message_id: string;
  rol: 'paciente' | 'asistente';
  texto: string;
  fecha: Date;
  orden: 0 | 1;
  guardado_en: Date;
}

export interface RegistroTurno {
  id: string; // message_id
  conversacion_id: number;
  fecha: Date;
  iniciado_en: Date;
  terminado_en: Date;
  modelo: string | null;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number | null;
  latencia_ms: number;
  iteraciones: number;
  llamadas_llm: { intento: number; latencia_ms: number; tokens_entrada: number; tokens_salida: number; error: string | null }[];
  herramientas: { nombre: string; argumentos: unknown; resultado: unknown; error: string | null; duracion_ms: number }[];
  estado_final: EstadoFinalTurno;
  error: string | null;
}

/** MongoDB: mensajes y turnos, con upsert sobre id determinista. */
export interface AlmacenConversaciones {
  guardarMensaje(mensaje: RegistroMensaje): Promise<void>;
  guardarTurno(turno: RegistroTurno): Promise<void>;
  /** Los últimos `limite` mensajes, del más viejo al más nuevo. */
  historial(conversacionId: number, limite: number): Promise<RegistroMensaje[]>;
}

export interface HorarioDelDia {
  horarioId: number;
  inicio: Date;
  profesional: string;
  ocupado: boolean;
}

export interface HorarioParaAgendar {
  id: number;
  inicio: Date;
  especialidad: string;
  sede: string;
  profesional: string;
}

export type ResultadoAgendar =
  | { tipo: 'agendada' | 'ya_era_tuya'; citaId: number; horario: HorarioParaAgendar }
  | { tipo: 'error'; error: 'horario_inexistente' | 'horario_pasado' | 'horario_ocupado' };

/** PostgreSQL: la agenda. */
export interface Agenda {
  horariosDelDia(especialidadId: number, sedeId: number, desde: Date, hasta: Date): Promise<HorarioDelDia[]>;
  /**
   * Agenda dentro de una transacción. `decidir` es la regla del dominio con lo
   * que hay en la base; si dice agendar y otro paciente ganó la carrera, el
   * índice único parcial lo detecta (23505) y vuelve como `horario_ocupado`.
   */
  agendar(
    pedido: { horarioId: number; conversacionId: number; nombrePaciente: string },
    decidir: (horario: HorarioParaAgendar | null, citaActiva: { id: number; conversacionId: number } | null) => DecisionAgendamiento,
  ): Promise<ResultadoAgendar>;
}
