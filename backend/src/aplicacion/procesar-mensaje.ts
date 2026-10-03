import { siguienteEstadoConversacion } from '../dominio/estados.js';
import { ahoraDelMensaje, contextoTemporal } from '../dominio/fechas.js';
import { describirError, enmascararTelefono, type Registro } from '../infraestructura/registro.js';
import { MENSAJE_FALLA_TECNICA } from './mensajes-fijos.js';
import { ejecutarTurno, type DependenciasOrquestador } from './orquestador.js';
import { construirPromptSistema } from './prompt.js';
import type { AlmacenConversaciones, MensajeAProcesar, MensajeLlm, RepositorioMensajes } from './puertos.js';

export const LIMITE_HISTORIAL = 20;

export interface DependenciasProcesamiento extends DependenciasOrquestador {
  mensajes: RepositorioMensajes;
  almacen: AlmacenConversaciones;
  precios: { entrada: number; salida: number } | null;
  registro: Registro;
}

/**
 * Procesa un mensaje entrante de punta a punta. Orden de escritura (consistencia
 * entre bases):
 *   1. PostgreSQL: estado de la conversación (y la cita, dentro de la herramienta).
 *   2. MongoDB: respuesta y turno, con upsert sobre `_id` determinista.
 *   3. PostgreSQL: el mensaje pasa a `procesado` solo después de que MongoDB confirmó.
 * Si algo falla, la excepción se propaga y la cola reintenta; un reintento
 * sobrescribe en MongoDB y no duplica la cita (invariante 4).
 */
export async function procesarMensaje(messageId: string, deps: DependenciasProcesamiento): Promise<void> {
  const mensaje = await deps.mensajes.obtener(messageId);
  if (!mensaje) throw new Error(`El trabajo apunta a un mensaje que no existe: ${messageId}`);
  if (mensaje.estado === 'procesado' || mensaje.estado === 'fallido') return;

  const iniciadoEn = new Date();
  await deps.mensajes.marcar(messageId, 'procesando');
  await deps.almacen.guardarMensaje({
    id: `${messageId}:entrada`,
    conversacion_id: mensaje.conversacionId,
    message_id: messageId,
    rol: 'paciente',
    texto: mensaje.texto,
    fecha: mensaje.enviadoEn,
    turno_iniciado_en: iniciadoEn,
    orden: 0,
    guardado_en: iniciadoEn,
  });

  const ahora = ahoraDelMensaje(mensaje.enviadoEn);
  const [historial, catalogo] = await Promise.all([
    deps.almacen.historial(mensaje.conversacionId, LIMITE_HISTORIAL),
    deps.mensajes.catalogo(),
  ]);
  const turno = await ejecutarTurno(
    {
      messageId,
      conversacionId: mensaje.conversacionId,
      estadoConversacion: mensaje.estadoConversacion,
      ahora,
      promptSistema: construirPromptSistema({
        tiempo: contextoTemporal(ahora),
        sedes: catalogo.sedes.map((s) => s.nombre),
        especialidades: catalogo.especialidades.map((e) => e.nombre),
      }),
      // El historial previo, sin este mensaje (en un reintento su respuesta anterior
      // ya puede estar guardada, D-22), y el mensaje actual siempre al final: el
      // último mensaje que ve el modelo es la pregunta pendiente (D-28).
      historial: [
        ...historial
          .filter((m) => m.message_id !== messageId)
          .map((m): MensajeLlm => (m.rol === 'paciente' ? { rol: 'paciente', contenido: m.texto } : { rol: 'asistente', contenido: m.texto })),
        { rol: 'paciente', contenido: mensaje.texto },
      ],
    },
    deps,
  );

  await deps.mensajes.actualizarEstadoConversacion(
    mensaje.conversacionId,
    siguienteEstadoConversacion(mensaje.estadoConversacion, turno.estadoFinal),
  );

  const terminadoEn = new Date();
  await deps.almacen.guardarMensaje({
    id: `${messageId}:salida`,
    conversacion_id: mensaje.conversacionId,
    message_id: messageId,
    rol: 'asistente',
    texto: turno.respuesta,
    fecha: mensaje.enviadoEn,
    turno_iniciado_en: iniciadoEn,
    orden: 1,
    guardado_en: terminadoEn,
  });
  await deps.almacen.guardarTurno({
    id: messageId,
    conversacion_id: mensaje.conversacionId,
    fecha: mensaje.enviadoEn,
    iniciado_en: iniciadoEn,
    terminado_en: terminadoEn,
    modelo: turno.modelo,
    tokens_entrada: turno.tokensEntrada,
    tokens_salida: turno.tokensSalida,
    costo_usd: calcularCosto(turno.tokensEntrada, turno.tokensSalida, turno.llamoLlm, deps.precios),
    latencia_ms: terminadoEn.getTime() - iniciadoEn.getTime(),
    iteraciones: turno.iteraciones,
    llamadas_llm: turno.llamadasLlm,
    herramientas: turno.herramientas,
    controles: turno.controles,
    estado_final: turno.estadoFinal,
    error: turno.error,
  });

  await deps.mensajes.marcar(messageId, 'procesado');
  deps.registro.info('turno procesado', {
    message_id: messageId,
    telefono: enmascararTelefono(mensaje.telefono),
    estado_final: turno.estadoFinal,
    herramientas: turno.herramientas.map((h) => `${h.nombre}:${h.error ?? 'ok'}`),
    error: turno.error,
  });
}

/** Sin llamada al LLM el costo es 0; sin precios configurados es desconocido (null), no 0. */
export function calcularCosto(
  tokensEntrada: number,
  tokensSalida: number,
  llamoLlm: boolean,
  precios: { entrada: number; salida: number } | null,
): number | null {
  if (!llamoLlm) return 0;
  if (!precios) return null;
  return (tokensEntrada * precios.entrada + tokensSalida * precios.salida) / 1_000_000;
}

/**
 * Último intento agotado (por ejemplo, MongoDB caído durante todos los reintentos).
 * El trabajo no se deja fallar: en una cola `key_strict_fifo` un trabajo fallido
 * bloquea la conversación. Se marca el mensaje como `fallido`, la conversación
 * pasa a `escalada` y se intenta guardar el mensaje fijo.
 */
export async function abandonarMensaje(messageId: string, causa: unknown, deps: DependenciasProcesamiento): Promise<void> {
  deps.registro.error('mensaje abandonado tras el último intento', { message_id: messageId, error: describirError(causa) });
  let mensaje: MensajeAProcesar | null = null;
  try {
    mensaje = await deps.mensajes.obtener(messageId);
    await deps.mensajes.marcar(messageId, 'fallido');
    if (mensaje) await deps.mensajes.actualizarEstadoConversacion(mensaje.conversacionId, 'escalada');
  } catch (error) {
    deps.registro.error('no se pudo marcar el mensaje como fallido', { message_id: messageId, error: describirError(error) });
  }
  if (!mensaje) return;
  try {
    await deps.almacen.guardarMensaje({
      id: `${messageId}:salida`,
      conversacion_id: mensaje.conversacionId,
      message_id: messageId,
      rol: 'asistente',
      texto: MENSAJE_FALLA_TECNICA,
      fecha: mensaje.enviadoEn,
      turno_iniciado_en: new Date(),
      orden: 1,
      guardado_en: new Date(),
    });
  } catch (error) {
    deps.registro.error('no se pudo guardar el mensaje fijo', { message_id: messageId, error: describirError(error) });
  }
}
