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
  controles?: { tipo: string; datos: string[]; accion: 'corregir' | 'descartar' | 'escalar' | 'solo_reglas'; borrador?: string }[];
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

export interface Catalogo {
  sedes: { id: number; nombre: string }[];
  especialidades: { id: number; nombre: string }[];
}

export interface HorarioAgenda {
  horario_id: number;
  inicio: string;
  fin: string;
  sede: string;
  especialidad: string;
  profesional: string;
  cita: { id: number; nombre_paciente: string; conversacion_id: number } | null;
}

export interface Agenda {
  desde: string;
  hasta: string;
  catalogo: Catalogo;
  horarios: HorarioAgenda[];
}

export interface Conocimiento {
  documentos: { id: number; titulo: string; origen: string; fragmentos: { id: number; seccion: string; texto: string }[] }[];
  fragmentos: number;
}

export type EstadoFinal = Exclude<Estado, 'abierta'>;
export const HERRAMIENTAS = ['buscar_conocimiento', 'consultar_disponibilidad', 'resumir_disponibilidad', 'agendar_cita', 'escalar_a_humano'] as const;

export interface TurnoTraza extends Turno {
  conversacion_id: number;
  telefono: string;
  pregunta: string | null;
  respuesta: string | null;
  iniciado_en: string;
}

export interface ResumenTrazas {
  turnos: number;
  costo_usd: number | null;
  costo_promedio_usd: number | null;
  tokens_entrada: number;
  tokens_salida: number;
  iteraciones_promedio: number;
  llamadas_llm: number;
  llamadas_fallidas: number;
  con_barandilla: number;
  latencia_p50_ms: number;
  latencia_p95_ms: number;
  por_estado: Partial<Record<EstadoFinal, number>>;
  herramientas: { nombre: string; llamadas: number; errores: number; duracion_promedio_ms: number }[];
}

export interface TrazaConversacion {
  conversacion_id: number;
  telefono: string;
  estado: Estado | null;
  citas_activas: number;
  primer_mensaje: string | null;
  turnos: number;
  turnos_sin_llm: number;
  turnos_con_problemas: number;
  primer_turno: string;
  ultimo_turno: string;
  iteraciones: number;
  llamadas_llm: number;
  llamadas_fallidas: number;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number | null;
  latencia_total_ms: number;
  latencia_max_ms: number;
  con_barandilla: number;
  herramientas: { nombre: string; llamadas: number; errores: number }[];
}

export interface TrazasConversaciones {
  conversaciones: TrazaConversacion[];
  siguiente: string | null;
  resumen: ResumenTrazas | null;
}

export interface Trazas {
  turnos: TurnoTraza[];
  siguiente: string | null;
  resumen: ResumenTrazas | null;
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
  agenda: (filtro: { desde: string; hasta: string; sede: number | null; especialidad: number | null }, senal: AbortSignal) => {
    const q = new URLSearchParams({ desde: filtro.desde, hasta: filtro.hasta });
    if (filtro.sede) q.set('sede', String(filtro.sede));
    if (filtro.especialidad) q.set('especialidad', String(filtro.especialidad));
    return pedir<Agenda>(`/agenda?${q}`, { signal: senal });
  },
  trazasConversaciones: (filtro: { estado: Estado | null; herramienta: string | null; con_problemas: boolean; antes: string | null }, senal: AbortSignal) => {
    const q = new URLSearchParams();
    if (filtro.estado) q.set('estado', filtro.estado);
    if (filtro.herramienta) q.set('herramienta', filtro.herramienta);
    if (filtro.con_problemas) q.set('con_problemas', 'true');
    if (filtro.antes) q.set('antes', filtro.antes);
    return pedir<TrazasConversaciones>(`/trazas/conversaciones?${q}`, { signal: senal });
  },
  turnosDeConversacion: (id: number, senal: AbortSignal) => pedir<Trazas>(`/turnos?conversacion_id=${id}&limite=200`, { signal: senal }),
  turnos: (filtro: { estado_final: EstadoFinal | null; herramienta: string | null; con_problemas: boolean; antes: string | null }, senal: AbortSignal) => {
    const q = new URLSearchParams();
    if (filtro.estado_final) q.set('estado_final', filtro.estado_final);
    if (filtro.herramienta) q.set('herramienta', filtro.herramienta);
    if (filtro.con_problemas) q.set('con_problemas', 'true');
    if (filtro.antes) q.set('antes', filtro.antes);
    return pedir<Trazas>(`/turnos?${q}`, { signal: senal });
  },
  conocimiento: (senal: AbortSignal) => pedir<Conocimiento>('/conocimiento', { signal: senal }),
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

const FORMATO_HORA = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });
const FORMATO_DIA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }); // YYYY-MM-DD

/** "2:00 p. m." en hora de Colombia. */
export function horaColombia(iso: string): string {
  return FORMATO_HORA.format(new Date(iso));
}

/** El día (YYYY-MM-DD) en Colombia de un instante; sin argumento, hoy. */
export function diaColombia(instante: Date = new Date()): string {
  return FORMATO_DIA.format(instante);
}

/** Suma días a una fecha YYYY-MM-DD (aritmética de calendario, sin zonas). */
export function sumarDias(dia: string, dias: number): string {
  const fecha = new Date(`${dia}T12:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

/** El lunes de la semana de `dia`. */
export function lunesDe(dia: string): string {
  const semana = new Date(`${dia}T12:00:00Z`).getUTCDay(); // 0 = domingo
  return sumarDias(dia, semana === 0 ? -6 : 1 - semana);
}
