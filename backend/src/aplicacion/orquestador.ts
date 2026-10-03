import type { DateTime } from 'luxon';
import { estadoFinalDelTurno, type EstadoFinalTurno } from '../dominio/estados.js';
import { datosSinRespaldo } from '../dominio/respaldo.js';
import type { EstadoConversacion } from '../dominio/errores.js';
import { MENSAJE_CONVERSACION_ESCALADA, MENSAJE_FALLA_TECNICA, MENSAJE_SIN_RESPALDO, MENSAJE_TOPE_ITERACIONES } from './mensajes-fijos.js';
import type { DefinicionHerramienta, Herramienta, LlamadaHerramienta, LlmClient, MensajeLlm, ResultadoHerramienta, RespuestaLlm } from './puertos.js';

export interface TrazaHerramientaTurno {
  nombre: string;
  argumentos: unknown;
  resultado: unknown;
  error: string | null;
  duracion_ms: number;
}

export interface TrazaLlamadaLlmTurno {
  intento: number;
  latencia_ms: number;
  tokens_entrada: number;
  tokens_salida: number;
  error: string | null;
}

export interface ResultadoTurno {
  respuesta: string;
  estadoFinal: EstadoFinalTurno;
  llamoLlm: boolean;
  modelo: string | null;
  tokensEntrada: number;
  tokensSalida: number;
  iteraciones: number;
  llamadasLlm: TrazaLlamadaLlmTurno[];
  herramientas: TrazaHerramientaTurno[];
  controles: { tipo: 'datos_sin_respaldo'; datos: string[]; accion: 'corregir' | 'descartar' }[];
  /** Por qué el turno terminó escalado por el código (falla del LLM, tope); null si no. */
  error: string | null;
}

export interface DependenciasOrquestador {
  llm: LlmClient;
  herramientas: ReadonlyMap<string, Herramienta>;
  timeoutMs: number;
  maxIteraciones: number;
}

export interface EntradaTurno {
  messageId: string;
  conversacionId: number;
  estadoConversacion: EstadoConversacion;
  ahora: DateTime;
  promptSistema: string;
  /** Historial ya incluye el mensaje actual del paciente, como último elemento. */
  historial: readonly MensajeLlm[];
}

const HERRAMIENTA_AGENDAR = 'agendar_cita';
const HERRAMIENTA_ESCALAR = 'escalar_a_humano';
const INTENTOS_POR_LLAMADA = 2; // una llamada y un reintento

class FallaLlm extends Error {}

/**
 * Un turno del asistente. El modelo propone; este código valida, ejecuta y
 * decide el estado final. Errores de herramienta vuelven al modelo como
 * resultado; fallas del proveedor terminan en mensaje fijo y escalamiento.
 * Una excepción de infraestructura (base caída) se propaga: el trabajo se reintenta.
 */
export async function ejecutarTurno(entrada: EntradaTurno, deps: DependenciasOrquestador): Promise<ResultadoTurno> {
  const resultado: ResultadoTurno = {
    respuesta: '',
    estadoFinal: 'resuelta_por_ia',
    llamoLlm: false,
    modelo: null,
    tokensEntrada: 0,
    tokensSalida: 0,
    iteraciones: 0,
    llamadasLlm: [],
    herramientas: [],
    controles: [],
    error: null,
  };

  if (entrada.estadoConversacion === 'escalada') {
    return { ...resultado, respuesta: MENSAJE_CONVERSACION_ESCALADA, estadoFinal: 'escalada' };
  }

  const definiciones = [...deps.herramientas.values()].map((h) => h.definicion);
  const mensajes: MensajeLlm[] = [{ rol: 'sistema', contenido: entrada.promptSistema }, ...entrada.historial];
  const hechos = { agendoCita: false, escaloElModelo: false, agotoIteraciones: false, fallaDelLlm: false, datoSinRespaldo: false };
  // Evidencia del turno para la barandilla de datos (D-26): lo que el modelo puede
  // citar. Sus propios argumentos no cuentan: podrían ser inventados.
  const evidencias: string[] = [entrada.promptSistema, ...entrada.historial.flatMap((m) => ('contenido' in m ? [m.contenido] : []))];

  while (resultado.iteraciones < deps.maxIteraciones) {
    resultado.iteraciones++;
    let respuesta: RespuestaLlm;
    try {
      respuesta = await llamarConReintento(entrada.messageId, mensajes, definiciones, deps, resultado);
    } catch (error) {
      if (!(error instanceof FallaLlm)) throw error;
      hechos.fallaDelLlm = true;
      resultado.error = error.message;
      resultado.respuesta = MENSAJE_FALLA_TECNICA;
      resultado.estadoFinal = estadoFinalDelTurno(hechos);
      return resultado;
    }

    if (respuesta.llamadas.length === 0) {
      const texto = respuesta.texto?.trim() ?? '';
      if (!texto) {
        hechos.fallaDelLlm = true;
        resultado.error = 'respuesta_vacia: el modelo no devolvió texto ni herramientas';
        resultado.respuesta = MENSAJE_FALLA_TECNICA;
        resultado.estadoFinal = estadoFinalDelTurno(hechos);
        return resultado;
      }

      // Barandilla: todo dato verificable de la respuesta tiene que estar en la evidencia.
      const sinRespaldo = datosSinRespaldo(texto, evidencias);
      if (sinRespaldo.length > 0) {
        const yaCorregido = resultado.controles.length > 0;
        if (!yaCorregido && resultado.iteraciones < deps.maxIteraciones) {
          resultado.controles.push({ tipo: 'datos_sin_respaldo', datos: sinRespaldo, accion: 'corregir' });
          mensajes.push({ rol: 'asistente', contenido: texto });
          mensajes.push({ rol: 'control', contenido: mensajeDeCorreccion(sinRespaldo) });
          continue;
        }
        resultado.controles.push({ tipo: 'datos_sin_respaldo', datos: sinRespaldo, accion: 'descartar' });
        hechos.datoSinRespaldo = true;
        resultado.error = `datos_sin_respaldo: ${sinRespaldo.join(', ')}`;
        resultado.respuesta = MENSAJE_SIN_RESPALDO;
        resultado.estadoFinal = estadoFinalDelTurno(hechos);
        return resultado;
      }

      resultado.respuesta = texto;
      resultado.estadoFinal = estadoFinalDelTurno(hechos);
      return resultado;
    }

    mensajes.push({ rol: 'asistente_con_llamadas', crudo: respuesta.mensajeCrudo });
    for (const llamada of respuesta.llamadas) {
      const inicio = performance.now();
      const { argumentos, salida } = await ejecutarHerramienta(llamada, deps.herramientas, entrada);
      resultado.herramientas.push({
        nombre: llamada.nombre,
        argumentos,
        resultado: salida.ok ? salida.datos : { error: salida.error, detalle: salida.detalle },
        error: salida.ok ? null : salida.error,
        duracion_ms: Math.round(performance.now() - inicio),
      });
      if (salida.ok && llamada.nombre === HERRAMIENTA_AGENDAR) hechos.agendoCita = true;
      if (salida.ok && llamada.nombre === HERRAMIENTA_ESCALAR) hechos.escaloElModelo = true;
      mensajes.push({ rol: 'herramienta', llamadaId: llamada.id, contenido: JSON.stringify(salida), esError: !salida.ok });
      evidencias.push(JSON.stringify(salida, (clave, valor: unknown) => (clave === 'similitud' ? undefined : valor)));
    }
  }

  hechos.agotoIteraciones = true;
  resultado.error = `tope_iteraciones: ${deps.maxIteraciones} iteraciones sin respuesta final`;
  resultado.respuesta = MENSAJE_TOPE_ITERACIONES;
  resultado.estadoFinal = estadoFinalDelTurno(hechos);
  return resultado;
}

async function llamarConReintento(
  etiqueta: string,
  mensajes: readonly MensajeLlm[],
  herramientas: readonly DefinicionHerramienta[],
  deps: DependenciasOrquestador,
  resultado: ResultadoTurno,
): Promise<RespuestaLlm> {
  const errores: string[] = [];
  for (let intento = 1; intento <= INTENTOS_POR_LLAMADA; intento++) {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(new Error('timeout')), deps.timeoutMs);
    const inicio = performance.now();
    resultado.llamoLlm = true;
    try {
      const respuesta = await deps.llm.completar({ mensajes, herramientas, senal: controlador.signal, etiqueta });
      resultado.modelo = respuesta.modelo;
      resultado.tokensEntrada += respuesta.tokensEntrada;
      resultado.tokensSalida += respuesta.tokensSalida;
      resultado.llamadasLlm.push({
        intento,
        latencia_ms: Math.round(performance.now() - inicio),
        tokens_entrada: respuesta.tokensEntrada,
        tokens_salida: respuesta.tokensSalida,
        error: null,
      });
      return respuesta;
    } catch (error) {
      const descripcion = controlador.signal.aborted ? `timeout tras ${deps.timeoutMs} ms` : describir(error);
      errores.push(descripcion);
      resultado.llamadasLlm.push({
        intento,
        latencia_ms: Math.round(performance.now() - inicio),
        tokens_entrada: 0,
        tokens_salida: 0,
        error: descripcion,
      });
    } finally {
      clearTimeout(temporizador);
    }
  }
  throw new FallaLlm(`falla_llm: ${errores.join(' | ')}`);
}

async function ejecutarHerramienta(
  llamada: LlamadaHerramienta,
  herramientas: ReadonlyMap<string, Herramienta>,
  entrada: EntradaTurno,
): Promise<{ argumentos: unknown; salida: ResultadoHerramienta }> {
  const herramienta = herramientas.get(llamada.nombre);
  if (!herramienta) {
    return {
      argumentos: llamada.argumentosCrudos,
      salida: {
        ok: false,
        error: 'herramienta_desconocida',
        detalle: `No existe la herramienta "${llamada.nombre}". Disponibles: ${[...herramientas.keys()].join(', ') || 'ninguna'}`,
      },
    };
  }
  let argumentos: unknown;
  try {
    argumentos = JSON.parse(llamada.argumentosCrudos || '{}');
  } catch {
    // JSON.parse solo falla por sintaxis: es un error del modelo, no del sistema.
    return {
      argumentos: llamada.argumentosCrudos,
      salida: { ok: false, error: 'argumentos_invalidos', detalle: 'Los argumentos no son JSON válido' },
    };
  }
  const salida = await herramienta.ejecutar(argumentos, { conversacionId: entrada.conversacionId, ahora: entrada.ahora });
  return { argumentos, salida };
}

function mensajeDeCorreccion(datos: readonly string[]): string {
  return [
    `Control automático: tu respuesta incluye datos que no aparecen en los resultados de las herramientas ni en la conversación: ${datos.join(', ')}.`,
    'Reescríbela usando solo datos que devolvieron las herramientas. Si no tienes el dato, dilo y ofrece comunicar al paciente con un asesor.',
  ].join(' ');
}

function describir(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
