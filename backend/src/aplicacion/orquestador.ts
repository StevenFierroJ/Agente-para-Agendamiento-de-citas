import type { DateTime } from 'luxon';
import { estadoFinalDelTurno, type EstadoFinalTurno } from '../dominio/estados.js';
import { afirmaCitaAgendada, diceNoSaber, mencionaReservaDeCita, preguntaPorLosDocumentos, prometeEscalamiento } from '../dominio/promesas.js';
import { fechasIncoherentes } from '../dominio/fechas.js';
import { citarEnContexto, datosSinRespaldo } from '../dominio/respaldo.js';
import type { EstadoConversacion } from '../dominio/errores.js';
import {
  MENSAJE_CITA_NO_CONFIRMADA, MENSAJE_CONVERSACION_ESCALADA, MENSAJE_ESCALADO, MENSAJE_FALLA_TECNICA, MENSAJE_SIN_RESPALDO, MENSAJE_TOPE_ITERACIONES,
} from './mensajes-fijos.js';
import type { ControlTurno, DefinicionHerramienta, Herramienta, VerificadorAfirmaciones, LlamadaHerramienta, LlmClient, MensajeLlm, ResultadoHerramienta, RespuestaLlm } from './puertos.js';

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
  controles: ControlTurno[];
  /** Por qué el turno terminó escalado por el código (falla del LLM, tope); null si no. */
  error: string | null;
}

export interface DependenciasOrquestador {
  llm: LlmClient;
  herramientas: ReadonlyMap<string, Herramienta>;
  timeoutMs: number;
  maxIteraciones: number;
  /** null = solo reglas deterministas (tests y harness en modo guion). */
  verificador: VerificadorAfirmaciones | null;
}

export interface EntradaTurno {
  messageId: string;
  conversacionId: number;
  estadoConversacion: EstadoConversacion;
  /** Citas activas de la conversación antes de este turno. */
  citasActivas: number;
  ahora: DateTime;
  promptSistema: string;
  /** Historial ya incluye el mensaje actual del paciente, como último elemento. */
  historial: readonly MensajeLlm[];
}

const HERRAMIENTA_AGENDAR = 'agendar_cita';
const HERRAMIENTA_ESCALAR = 'escalar_a_humano';
const HERRAMIENTA_CONOCIMIENTO = 'buscar_conocimiento';
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
  const hechos = { agendoCita: false, escaloElModelo: false, agotoIteraciones: false, fallaDelLlm: false, datoSinRespaldo: false, escalamientoPrometido: false, citaNoAgendada: false };
  let citaAgendada: Record<string, unknown> | null = null;
  let buscoConocimiento = false;
  // El mensaje actual del paciente: siempre el último del historial (D-28).
  const ultimo = entrada.historial.at(-1);
  const preguntaDelPaciente = ultimo && ultimo.rol === 'paciente' ? ultimo.contenido : '';
  // Evidencia del turno para la barandilla de datos (D-26): lo que el modelo puede
  // citar. Sus propios argumentos no cuentan: podrían ser inventados.
  const evidencias: string[] = [entrada.promptSistema, ...entrada.historial.flatMap((m) => ('contenido' in m ? [m.contenido] : []))];
  // Las horas son más estrictas: solo las respaldan datos (el prompt, que trae los
  // horarios ofrecidos, y las herramientas del turno), no lo que el modelo o el
  // paciente dijeron antes. Para hablar de horas, el modelo consulta (D-38).
  const evidenciasDeHoras: string[] = [entrada.promptSistema];

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
        // Texto vacío tras una acción exitosa no es una falla: la acción ocurrió y
        // el código redacta la respuesta con sus datos reales.
        if (hechos.escaloElModelo) resultado.respuesta = MENSAJE_ESCALADO;
        else if (citaAgendada) resultado.respuesta = confirmacionDeCita(citaAgendada);
        else {
          hechos.fallaDelLlm = true;
          resultado.error = 'respuesta_vacia: el modelo no devolvió texto ni herramientas';
          resultado.respuesta = MENSAJE_FALLA_TECNICA;
        }
        resultado.estadoFinal = estadoFinalDelTurno(hechos);
        return resultado;
      }

      // Barandilla: todo dato verificable de la respuesta tiene que estar en la evidencia.
      // Más las fechas con un día de la semana que no les corresponde ("lunes 7" si el 7 es miércoles, D-39).
      const sinRespaldo = [...datosSinRespaldo(texto, evidencias, evidenciasDeHoras), ...fechasIncoherentes(texto, entrada.ahora)];
      if (sinRespaldo.length > 0) {
        const yaCorregido = resultado.controles.some((c) => c.tipo === 'datos_sin_respaldo');
        if (!yaCorregido && resultado.iteraciones < deps.maxIteraciones) {
          resultado.controles.push({ tipo: 'datos_sin_respaldo', datos: sinRespaldo, accion: 'corregir', borrador: texto });
          mensajes.push({ rol: 'asistente', contenido: texto });
          mensajes.push({ rol: 'control', contenido: mensajeDeCorreccion(citarEnContexto(texto, sinRespaldo)) });
          continue;
        }
        resultado.controles.push({ tipo: 'datos_sin_respaldo', datos: sinRespaldo, accion: 'descartar', borrador: texto });
        hechos.datoSinRespaldo = true;
        resultado.error = `datos_sin_respaldo: ${sinRespaldo.join(', ')}`;
        resultado.respuesta = MENSAJE_SIN_RESPALDO;
        resultado.estadoFinal = estadoFinalDelTurno(hechos);
        return resultado;
      }

      // Barandilla: una cita afirmada tiene que existir (agendada en este turno o ya activa).
      if (!hechos.agendoCita && entrada.citasActivas === 0 && (await afirmaCita(texto, deps.verificador, resultado.controles))) {
        const yaCorregida = resultado.controles.some((c) => c.tipo === 'cita_no_agendada');
        if (!yaCorregida && resultado.iteraciones < deps.maxIteraciones) {
          resultado.controles.push({ tipo: 'cita_no_agendada', datos: [], accion: 'corregir', borrador: texto });
          mensajes.push({ rol: 'asistente', contenido: texto });
          mensajes.push({ rol: 'control', contenido: CORRECCION_CITA });
          continue;
        }
        resultado.controles.push({ tipo: 'cita_no_agendada', datos: [], accion: 'descartar', borrador: texto });
        hechos.citaNoAgendada = true;
        resultado.error = 'cita_no_agendada: la respuesta afirmó una cita que no se agendó';
        resultado.respuesta = MENSAJE_CITA_NO_CONFIRMADA;
        resultado.estadoFinal = estadoFinalDelTurno(hechos);
        return resultado;
      }

      // Barandilla: responder sin buscar en los documentos cuando el paciente preguntó por un tema
      // que solo ellos cubren, o decir "no tengo esa información" sin haber buscado (D-41).
      // Se pide buscar una vez; si después de buscar sigue sin el dato, abstenerse es lo correcto.
      if (!buscoConocimiento && !hechos.escaloElModelo && !hechos.agendoCita && (diceNoSaber(texto) || preguntaPorLosDocumentos(preguntaDelPaciente)) && !resultado.controles.some((c) => c.tipo === 'abstencion_sin_busqueda') && resultado.iteraciones < deps.maxIteraciones) {
        resultado.controles.push({ tipo: 'abstencion_sin_busqueda', datos: [], accion: 'corregir', borrador: texto });
        mensajes.push({ rol: 'asistente', contenido: texto });
        mensajes.push({ rol: 'control', contenido: CORRECCION_ABSTENCION });
        continue;
      }

      // Barandilla: si prometió pasar con un humano sin usar la herramienta, el código cumple la promesa.
      if (!hechos.escaloElModelo && prometeEscalamiento(texto)) {
        hechos.escalamientoPrometido = true;
        resultado.controles.push({ tipo: 'escalamiento_prometido', datos: [], accion: 'escalar' });
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
      if (salida.ok && llamada.nombre === HERRAMIENTA_AGENDAR) {
        hechos.agendoCita = true;
        citaAgendada = salida.datos as Record<string, unknown>;
      }
      if (salida.ok && llamada.nombre === HERRAMIENTA_ESCALAR) hechos.escaloElModelo = true;
      if (llamada.nombre === HERRAMIENTA_CONOCIMIENTO) buscoConocimiento = true;
      mensajes.push({ rol: 'herramienta', llamadaId: llamada.id, contenido: JSON.stringify(salida), esError: !salida.ok });
      const evidencia = JSON.stringify(salida, (clave, valor: unknown) => (clave === 'similitud' ? undefined : valor));
      evidencias.push(evidencia);
      evidenciasDeHoras.push(evidencia);
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

/**
 * ¿La respuesta afirma una cita? Regla rápida para las frases conocidas; para el
 * resto, si el filtro amplio dispara, el verificador (LLM) decide. Si el
 * verificador falla, queda la regla: no se bloquea el turno por el control.
 */
async function afirmaCita(texto: string, verificador: VerificadorAfirmaciones | null, controles: ControlTurno[]): Promise<boolean> {
  if (afirmaCitaAgendada(texto)) return true;
  if (!verificador || !mencionaReservaDeCita(texto)) return false;
  try {
    return await verificador.afirmaCitaAgendada(texto);
  } catch (error) {
    // Capa adicional: si falla, decide la regla (que ya dijo que no) y la falla queda en la traza.
    controles.push({ tipo: 'verificador_no_disponible', datos: [describir(error)], accion: 'solo_reglas' });
    return false;
  }
}

const CORRECCION_CITA = [
  'Control automático (el paciente no lo ve: no lo menciones ni agradezcas la corrección; responde directamente): tu respuesta afirma que la cita quedó agendada, pero en este turno no se llamó a agendar_cita.',
  'Una cita solo existe si agendar_cita responde con éxito: consulta la disponibilidad del día elegido y llama a agendar_cita con la hora que eligió el paciente.',
  'Si te falta algún dato, pregúntalo y no afirmes que la cita está agendada.',
].join(' ');

/** Confirmación redactada por el código con los datos que devolvió agendar_cita. */
function confirmacionDeCita(datos: Record<string, unknown>): string {
  const inicio = String(datos['inicio'] ?? '').replace('T', ' a las ');
  return `Tu cita quedó agendada: ${String(datos['especialidad'])} en la ${String(datos['sede'])}, el ${inicio}, con ${String(datos['profesional'])}.`;
}

const CORRECCION_ABSTENCION = [
  'Control automático (el paciente no lo ve: no lo menciones ni agradezcas la corrección; responde directamente): respondiste sin buscar en los documentos de la clínica, y el paciente preguntó por algo que solo ellos responden (coberturas, prepagadas, precios, pagos, preparación, cancelación, qué llevar, sedes) o dijiste que no tienes la información.',
  'Búscala ahora con buscar_conocimiento (una búsqueda por tema) y responde con lo que devuelva. Si después de buscar no está, dilo.',
].join(' ');

function mensajeDeCorreccion(datos: readonly string[]): string {
  return [
    `Control automático (el paciente no lo ve: no lo menciones ni agradezcas la corrección; responde directamente): tu respuesta incluye datos que no aparecen en los resultados de las herramientas ni en la conversación: ${datos.join('; ')}.`,
    'Reescríbela usando solo datos que devolvieron las herramientas. Si un número es un conteo o algo que dedujiste, quítalo o escribe el dato tal como aparece en la fuente. Si no tienes el dato, dilo y ofrece comunicar al paciente con un asesor; no descartes por eso el resto de la respuesta.',
    'Para los días de la semana, usa el calendario del prompt de sistema. Si agendaste o consultaste un día distinto del que pidió el paciente, díselo.',
  ].join(' ');
}

function describir(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
