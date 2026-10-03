// Cliente de la API. Los tipos reflejan las respuestas del backend.

export const ESTADOS = ['abierta', 'resuelta_por_ia', 'cita_agendada', 'escalada'] as const;
export type Estado = (typeof ESTADOS)[number];

export interface ItemBandeja {
  id: number;
  telefono: string;
  estado: Estado;
  ultimo_mensaje_en: string;
  ultimo_texto: string | null;
  mensajes_pendientes: number;
}

export interface Bandeja {
  conversaciones: ItemBandeja[];
  siguiente: string | null;
}

export interface Mensaje {
  id: string;
  message_id: string;
  rol: 'paciente' | 'asistente';
  texto: string;
  fecha: string;
  orden: 0 | 1;
}

export interface Turno {
  message_id: string;
  fecha: string;
  modelo: string | null;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number | null;
  latencia_ms: number;
  iteraciones: number;
  llamadas_llm: { intento: number; latencia_ms: number; error: string | null }[];
  herramientas: { nombre: string; argumentos: unknown; resultado: unknown; error: string | null; duracion_ms: number }[];
  controles?: { tipo: string; datos: string[]; accion: 'corregir' | 'descartar' | 'escalar' | 'solo_reglas' }[];
  estado_final: Estado;
  error: string | null;
}

export interface Detalle {
  conversacion: { id: number; telefono: string; estado: Estado; ultimo_mensaje_en: string };
  mensajes: Mensaje[];
  pendientes: { message_id: string; texto: string; enviado_en: string; estado: string }[];
  respondiendo: boolean;
  turnos: Turno[];
  citas: { id: number; estado: string; nombre_paciente: string; inicio: string; especialidad: string; sede: string; profesional: string }[];
  resumen: { turnos: number; tokens_entrada: number; tokens_salida: number; costo_usd: number | null };
}

export interface RespuestaWebhook {
  estado: 'recibido' | 'duplicado';
  message_id: string;
  conversacion_id: number;
}

/** Error con lo que devolvió la API: el código y, si hay, el detalle por campo. */
export class ErrorApi extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
    readonly detalle: { campo: string; mensaje: string }[] = [],
  ) {
    super(mensaje);
  }
}

async function pedir<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  let respuesta: Response;
  try {
    respuesta = await fetch(`/api${ruta}`, opciones);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ErrorApi(0, 'No se pudo conectar con la API. ¿Está corriendo en el puerto 3000?');
  }
  const cuerpo: unknown = await respuesta.json().catch(() => null);
  if (!respuesta.ok) {
    const c = (cuerpo ?? {}) as { error?: string; detalle?: unknown };
    const detalle = Array.isArray(c.detalle) ? (c.detalle as { campo: string; mensaje: string }[]) : [];
    const mensaje = typeof c.detalle === 'string' ? c.detalle : (c.error ?? `Error ${respuesta.status}`);
    throw new ErrorApi(respuesta.status, mensaje, detalle);
  }
  return cuerpo as T;
}

export const api = {
  bandeja: (filtro: { estado: Estado | null; antes: string | null }, senal: AbortSignal) => {
    const q = new URLSearchParams();
    if (filtro.estado) q.set('estado', filtro.estado);
    if (filtro.antes) q.set('antes', filtro.antes);
    return pedir<Bandeja>(`/conversaciones?${q}`, { signal: senal });
  },
  detalle: (id: number, senal: AbortSignal) => pedir<Detalle>(`/conversaciones/${id}`, { signal: senal }),
  enviar: (cuerpo: { message_id: string; from: string; text: string; timestamp: string }) =>
    pedir<RespuestaWebhook>('/webhooks/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    }),
};

const FORMATO_FECHA = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });

/** Fechas siempre en hora de Colombia, sin importar la zona del navegador. */
export function fechaColombia(iso: string): string {
  return FORMATO_FECHA.format(new Date(iso));
}

export function usd(valor: number | null): string {
  return valor === null ? 'desconocido' : `USD ${valor.toFixed(4)}`;
}
