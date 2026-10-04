import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Filter } from 'mongodb';
import { ESTADOS_CONVERSACION, NOMBRES_HERRAMIENTAS } from '../dominio/errores.js';
import type { DocTurno, Mongo } from '../infraestructura/mongo/mongo.js';
import { parsearFechaLocal } from '../dominio/fechas.js';
import {
  leerAgenda,
  leerBandeja,
  leerCatalogoAgenda,
  leerCitas,
  leerConocimiento,
  leerConversacion,
  leerPendientes,
  leerResumenConversaciones,
  leerTelefonos,
  idsConEstado,
} from '../infraestructura/postgres/lectura.js';
import { enmascararTelefono } from '../infraestructura/registro.js';
import { detalleDeError } from './webhook.js';

const LIMITE_MENSAJES = 500;

const ConsultaBandeja = z
  .object({
    estado: z.enum(ESTADOS_CONVERSACION).optional(),
    limite: z.coerce.number().int().min(1).max(100).default(50),
    // Cursor opaco: "<ultimo_mensaje_en ISO>_<id>", tal como lo devuelve `siguiente`.
    antes: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_\d+$/, 'Cursor inválido')
      .optional(),
  })
  .strict();

/** Hasta 31 días: una vista de mes del calendario. */
const DIAS_MAXIMOS_AGENDA = 31;
const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');
const ConsultaAgenda = z
  .object({
    desde: FECHA,
    hasta: FECHA,
    sede: z.coerce.number().int().positive().optional(),
    especialidad: z.coerce.number().int().positive().optional(),
  })
  .strict();

const ConsultaTurnos = z
  .object({
    estado_final: z.enum(['resuelta_por_ia', 'cita_agendada', 'escalada']).optional(),
    herramienta: z.enum(NOMBRES_HERRAMIENTAS).optional(),
    conversacion_id: z.coerce.number().int().positive().optional(),
    // "true": solo turnos con alguna herramienta fallida, falla del LLM o barandilla activada.
    con_problemas: z.enum(['true', 'false']).optional(),
    limite: z.coerce.number().int().min(1).max(200).default(50),
    // Cursor: "<fecha ISO>_<message_id>", tal como lo devuelve `siguiente`.
    antes: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_.+$/, 'Cursor inválido')
      .optional(),
  })
  .strict();

const ConsultaTrazasConversaciones = z
  .object({
    estado: z.enum(ESTADOS_CONVERSACION).optional(),
    herramienta: z.enum(NOMBRES_HERRAMIENTAS).optional(),
    con_problemas: z.enum(['true', 'false']).optional(),
    limite: z.coerce.number().int().min(1).max(100).default(30),
    // Cursor: "<ultimo turno ISO>_<conversacion_id>", tal como lo devuelve `siguiente`.
    antes: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_\d+$/, 'Cursor inválido')
      .optional(),
  })
  .strict();

/** Turnos con una herramienta dada, o con algo distinto del camino normal. */
function filtroDeTurnos(opciones: { herramienta?: string | undefined; con_problemas: boolean }): Filter<DocTurno> {
  const filtro: Filter<DocTurno> = {};
  if (opciones.herramienta) filtro['herramientas.nombre'] = opciones.herramienta;
  if (opciones.con_problemas) {
    // $elemMatch y no 'herramientas.error': {$ne: null}, que también coincide con un arreglo vacío.
    filtro.$or = [
      { error: { $ne: null } },
      { herramientas: { $elemMatch: { error: { $ne: null } } } },
      { llamadas_llm: { $elemMatch: { error: { $ne: null } } } },
      { 'controles.0': { $exists: true } },
    ];
  }
  return filtro;
}

const ParametrosDetalle = z.object({ id: z.coerce.number().int().positive() }).strict();

/**
 * Lectura para el coordinador. Lee directo de las bases (sin pasar por la capa de
 * aplicación): no hay reglas de negocio que aplicar al mostrar. El teléfono sale
 * enmascarado: la prueba no tiene autenticación (D-27).
 */
export function registrarRutasDeLectura(app: FastifyInstance, deps: { pool: pg.Pool; mongo: Mongo }): void {
  app.get('/conversaciones', async (peticion, respuesta) => {
    const consulta = ConsultaBandeja.safeParse(peticion.query);
    if (!consulta.success) return respuesta.status(400).send({ error: 'consulta_invalida', detalle: detalleDeError(consulta.error) });
    const { estado, limite, antes } = consulta.data;
    const [fecha, id] = antes ? antes.split('_') : [];

    const filas = await leerBandeja(deps.pool, {
      estado: estado ?? null,
      limite: limite + 1,
      antes: fecha && id ? { ultimoMensajeEn: new Date(fecha), id: Number(id) } : null,
    });
    const pagina = filas.slice(0, limite);
    const ultima = pagina.at(-1);
    return {
      conversaciones: pagina.map((f) => ({ ...f, telefono: enmascararTelefono(f.telefono) })),
      siguiente: filas.length > limite && ultima ? `${ultima.ultimo_mensaje_en.toISOString()}_${ultima.id}` : null,
    };
  });

  app.get('/conversaciones/:id', async (peticion, respuesta) => {
    const parametros = ParametrosDetalle.safeParse(peticion.params);
    if (!parametros.success) return respuesta.status(400).send({ error: 'id_invalido', detalle: detalleDeError(parametros.error) });
    const conversacion = await leerConversacion(deps.pool, parametros.data.id);
    if (!conversacion) return respuesta.status(404).send({ error: 'no_encontrada', detalle: `No existe la conversación ${parametros.data.id}` });

    const [mensajes, turnos, pendientes, citas] = await Promise.all([
      deps.mongo.mensajes.find({ conversacion_id: conversacion.id }).sort({ fecha: 1, turno_iniciado_en: 1, orden: 1 }).limit(LIMITE_MENSAJES).toArray(),
      deps.mongo.turnos.find({ conversacion_id: conversacion.id }).sort({ fecha: 1 }).toArray(),
      leerPendientes(deps.pool, conversacion.id),
      leerCitas(deps.pool, conversacion.id),
    ]);

    // Un mensaje en proceso ya puede tener su entrada en MongoDB: no se muestra dos veces.
    const yaEnMongo = new Set(mensajes.map((m) => m.message_id));
    const costos = turnos.map((t) => t.costo_usd);
    return {
      conversacion: { ...conversacion, telefono: enmascararTelefono(conversacion.telefono) },
      mensajes: mensajes.map(({ _id, guardado_en: _g, turno_iniciado_en: _t, ...m }) => ({ id: _id, ...m })),
      pendientes: pendientes.filter((p) => !yaEnMongo.has(p.message_id)),
      respondiendo: pendientes.length > 0,
      turnos: turnos.map(({ _id, ...t }) => ({ message_id: _id, ...t })),
      citas,
      resumen: {
        turnos: turnos.length,
        tokens_entrada: turnos.reduce((s, t) => s + t.tokens_entrada, 0),
        tokens_salida: turnos.reduce((s, t) => s + t.tokens_salida, 0),
        // Un turno sin precio conocido hace desconocido el total: no se suma como 0.
        costo_usd: costos.some((c) => c === null) ? null : costos.reduce<number>((s, c) => s + (c ?? 0), 0),
      },
    };
  });

  /** Calendario del coordinador: horarios del rango [desde, hasta] (días en hora de Colombia) con su cita activa. */
  app.get('/agenda', async (peticion, respuesta) => {
    const consulta = ConsultaAgenda.safeParse(peticion.query);
    if (!consulta.success) return respuesta.status(400).send({ error: 'consulta_invalida', detalle: detalleDeError(consulta.error) });
    const desde = parsearFechaLocal(consulta.data.desde);
    const hasta = parsearFechaLocal(consulta.data.hasta);
    if (!desde.ok) return respuesta.status(400).send({ error: 'consulta_invalida', detalle: [{ campo: 'desde', mensaje: desde.detalle }] });
    if (!hasta.ok) return respuesta.status(400).send({ error: 'consulta_invalida', detalle: [{ campo: 'hasta', mensaje: hasta.detalle }] });
    const dias = hasta.dia.diff(desde.dia, 'days').days + 1;
    if (dias < 1 || dias > DIAS_MAXIMOS_AGENDA) {
      return respuesta.status(400).send({
        error: 'consulta_invalida',
        detalle: [{ campo: 'hasta', mensaje: `El rango debe ir de 1 a ${DIAS_MAXIMOS_AGENDA} días, con hasta igual o posterior a desde` }],
      });
    }
    const [catalogo, horarios] = await Promise.all([
      leerCatalogoAgenda(deps.pool),
      leerAgenda(deps.pool, {
        desde: desde.dia.toJSDate(),
        hasta: hasta.dia.plus({ days: 1 }).toJSDate(),
        sedeId: consulta.data.sede ?? null,
        especialidadId: consulta.data.especialidad ?? null,
      }),
    ]);
    return { desde: consulta.data.desde, hasta: consulta.data.hasta, catalogo, horarios };
  });

  /** Lo que tiene la base de conocimiento del RAG: documentos y fragmentos, tal como se indexaron. */
  app.get('/conocimiento', async () => {
    const documentos = await leerConocimiento(deps.pool);
    return { documentos, fragmentos: documentos.reduce((n, d) => n + d.fragmentos.length, 0) };
  });

  /**
   * Trazas de todos los turnos, para ver cómo se comporta el modelo: llamadas,
   * iteraciones, herramientas, costo y latencia. El resumen cubre todo lo filtrado,
   * no solo la página.
   */
  app.get('/turnos', async (peticion, respuesta) => {
    const consulta = ConsultaTurnos.safeParse(peticion.query);
    if (!consulta.success) return respuesta.status(400).send({ error: 'consulta_invalida', detalle: detalleDeError(consulta.error) });
    const { estado_final, herramienta, conversacion_id, con_problemas, limite, antes } = consulta.data;

    const filtro = filtroDeTurnos({ herramienta, con_problemas: con_problemas === 'true' });
    if (estado_final) filtro.estado_final = estado_final;
    if (conversacion_id) filtro.conversacion_id = conversacion_id;
    const pagina: Filter<DocTurno> = { ...filtro };
    if (antes) {
      const corte = antes.indexOf('Z_') + 1;
      const fecha = new Date(antes.slice(0, corte));
      const id = antes.slice(corte + 1);
      pagina.$and = [{ $or: [{ fecha: { $lt: fecha } }, { fecha, _id: { $lt: id } }] }];
    }

    const [filas, resumen] = await Promise.all([
      deps.mongo.turnos.find(pagina).sort({ fecha: -1, _id: -1 }).limit(limite + 1).toArray(),
      resumirTurnos(deps.mongo, filtro),
    ]);
    const turnos = filas.slice(0, limite);
    const ids = turnos.map((t) => t._id);
    const [mensajes, telefonos] = await Promise.all([
      deps.mongo.mensajes.find({ message_id: { $in: ids } }).toArray(),
      leerTelefonos(deps.pool, [...new Set(turnos.map((t) => t.conversacion_id))]),
    ]);
    const texto = (messageId: string, rol: 'paciente' | 'asistente') => mensajes.find((m) => m.message_id === messageId && m.rol === rol)?.texto ?? null;
    const ultimo = turnos.at(-1);
    return {
      turnos: turnos.map(({ _id, ...t }) => ({
        message_id: _id,
        ...t,
        telefono: enmascararTelefono(telefonos.get(t.conversacion_id) ?? ''),
        pregunta: texto(_id, 'paciente'),
        respuesta: texto(_id, 'asistente'),
      })),
      siguiente: filas.length > limite && ultimo ? `${ultimo.fecha.toISOString()}_${ultimo._id}` : null,
      resumen,
    };
  });

  /** Trazas agrupadas por conversación: una fila por conversación con sus totales; el detalle sale de /turnos?conversacion_id=. */
  app.get('/trazas/conversaciones', async (peticion, respuesta) => {
    const consulta = ConsultaTrazasConversaciones.safeParse(peticion.query);
    if (!consulta.success) return respuesta.status(400).send({ error: 'consulta_invalida', detalle: detalleDeError(consulta.error) });
    return trazasPorConversacion(deps, consulta.data);
  });
}

/** Una conversación vista desde sus trazas: lo que costó y cómo se comportó el modelo, sumado. */
interface FilaTrazaConversacion {
  conversacion_id: number;
  turnos: number;
  turnos_sin_llm: number;
  turnos_con_problemas: number;
  primer_turno: Date;
  ultimo_turno: Date;
  iteraciones: number;
  llamadas_llm: number;
  llamadas_fallidas: number;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number;
  sin_precio: number;
  latencia_total_ms: number;
  latencia_max_ms: number;
  con_barandilla: number;
  herramientas: { nombre: string; llamadas: number; errores: number }[];
}

/**
 * Trazas agrupadas por conversación. Los filtros eligen conversaciones (las que
 * tienen al menos un turno que coincide); los totales cubren todos sus turnos.
 */
async function trazasPorConversacion(
  deps: { pool: pg.Pool; mongo: Mongo },
  consulta: z.infer<typeof ConsultaTrazasConversaciones>,
) {
  const { estado, herramienta, con_problemas, limite, antes } = consulta;
  const filtroTurnos = filtroDeTurnos({ herramienta, con_problemas: con_problemas === 'true' });
  if (estado) filtroTurnos.conversacion_id = { $in: await idsConEstado(deps.pool, estado) };
  const hayFiltro = Object.keys(filtroTurnos).length > 0;
  const elegidas: Filter<DocTurno> = hayFiltro
    ? { conversacion_id: { $in: await deps.mongo.turnos.distinct('conversacion_id', filtroTurnos) } }
    : {};

  const cursor = antes ? { fecha: new Date(antes.slice(0, antes.lastIndexOf('_'))), id: Number(antes.slice(antes.lastIndexOf('_') + 1)) } : null;
  const problema = {
    $or: [
      { $ne: ['$error', null] },
      { $gt: [{ $size: { $filter: { input: '$herramientas', cond: { $ne: ['$$this.error', null] } } } }, 0] },
      { $gt: [{ $size: { $filter: { input: '$llamadas_llm', cond: { $ne: ['$$this.error', null] } } } }, 0] },
      { $gt: [{ $size: { $ifNull: ['$controles', []] } }, 0] },
    ],
  };
  const [filas, resumen] = await Promise.all([
    deps.mongo.turnos
      .aggregate<FilaTrazaConversacion>([
        { $match: elegidas },
        {
          $facet: {
            totales: [
              {
                $group: {
                  _id: '$conversacion_id',
                  turnos: { $sum: 1 },
                  turnos_sin_llm: { $sum: { $cond: [{ $eq: [{ $size: '$llamadas_llm' }, 0] }, 1, 0] } },
                  turnos_con_problemas: { $sum: { $cond: [problema, 1, 0] } },
                  primer_turno: { $min: '$fecha' },
                  ultimo_turno: { $max: '$fecha' },
                  iteraciones: { $sum: '$iteraciones' },
                  llamadas_llm: { $sum: { $size: '$llamadas_llm' } },
                  llamadas_fallidas: { $sum: { $size: { $filter: { input: '$llamadas_llm', cond: { $ne: ['$$this.error', null] } } } } },
                  tokens_entrada: { $sum: '$tokens_entrada' },
                  tokens_salida: { $sum: '$tokens_salida' },
                  costo_usd: { $sum: { $ifNull: ['$costo_usd', 0] } },
                  sin_precio: { $sum: { $cond: [{ $and: [{ $eq: ['$costo_usd', null] }, { $ne: ['$modelo', null] }] }, 1, 0] } },
                  latencia_total_ms: { $sum: '$latencia_ms' },
                  latencia_max_ms: { $max: '$latencia_ms' },
                  con_barandilla: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$controles', []] } }, 0] }, 1, 0] } },
                },
              },
            ],
            herramientas: [
              { $unwind: '$herramientas' },
              {
                $group: {
                  _id: { c: '$conversacion_id', n: '$herramientas.nombre' },
                  llamadas: { $sum: 1 },
                  errores: { $sum: { $cond: [{ $ne: ['$herramientas.error', null] }, 1, 0] } },
                },
              },
              { $sort: { llamadas: -1 } },
              { $group: { _id: '$_id.c', herramientas: { $push: { nombre: '$_id.n', llamadas: '$llamadas', errores: '$errores' } } } },
            ],
          },
        },
        { $unwind: '$totales' },
        { $replaceWith: { $mergeObjects: ['$totales', { herramientas: { $filter: { input: '$herramientas', cond: { $eq: ['$$this._id', '$totales._id'] } } } }] } },
        { $set: { conversacion_id: '$_id', herramientas: { $ifNull: [{ $first: '$herramientas.herramientas' }, []] } } },
        { $unset: '_id' },
        ...(cursor
          ? [{ $match: { $or: [{ ultimo_turno: { $lt: cursor.fecha } }, { ultimo_turno: cursor.fecha, conversacion_id: { $lt: cursor.id } }] } }]
          : []),
        { $sort: { ultimo_turno: -1, conversacion_id: -1 } },
        { $limit: limite + 1 },
      ])
      .toArray(),
    resumirTurnos(deps.mongo, elegidas),
  ]);

  const pagina = filas.slice(0, limite);
  const ids = pagina.map((f) => f.conversacion_id);
  const [conversaciones, primeros] = await Promise.all([
    leerResumenConversaciones(deps.pool, ids),
    deps.mongo.mensajes
      .aggregate<{ _id: number; texto: string }>([
        { $match: { conversacion_id: { $in: ids }, rol: 'paciente' } },
        { $sort: { fecha: 1, turno_iniciado_en: 1 } },
        { $group: { _id: '$conversacion_id', texto: { $first: '$texto' } } },
      ])
      .toArray(),
  ]);
  const ultima = pagina.at(-1);
  return {
    conversaciones: pagina.map(({ sin_precio, costo_usd, ...f }) => {
      const c = conversaciones.get(f.conversacion_id);
      return {
        ...f,
        telefono: enmascararTelefono(c?.telefono ?? ''),
        estado: c?.estado ?? null,
        citas_activas: c?.citas_activas ?? 0,
        primer_mensaje: primeros.find((p) => p._id === f.conversacion_id)?.texto ?? null,
        // Un turno del LLM sin precio conocido hace desconocido el total.
        costo_usd: sin_precio > 0 ? null : costo_usd,
      };
    }),
    siguiente: filas.length > limite && ultima ? `${ultima.ultimo_turno.toISOString()}_${ultima.conversacion_id}` : null,
    resumen,
  };
}

/** Agregados sobre los turnos filtrados: volumen, costo, latencia y uso de cada herramienta. */
async function resumirTurnos(mongo: Mongo, filtro: Filter<DocTurno>) {
  const [totales] = await mongo.turnos
    .aggregate<{
      turnos: number; costo_usd: number; sin_precio: number; tokens_entrada: number; tokens_salida: number;
      iteraciones_promedio: number; llamadas_llm: number; llamadas_fallidas: number; latencia: number[]; con_barandilla: number;
      por_estado: { k: string; v: number }[];
    }>([
      { $match: filtro },
      {
        $group: {
          _id: null,
          turnos: { $sum: 1 },
          costo_usd: { $sum: { $ifNull: ['$costo_usd', 0] } },
          sin_precio: { $sum: { $cond: [{ $and: [{ $eq: ['$costo_usd', null] }, { $ne: ['$modelo', null] }] }, 1, 0] } },
          tokens_entrada: { $sum: '$tokens_entrada' },
          tokens_salida: { $sum: '$tokens_salida' },
          iteraciones_promedio: { $avg: '$iteraciones' },
          llamadas_llm: { $sum: { $size: '$llamadas_llm' } },
          llamadas_fallidas: { $sum: { $size: { $filter: { input: '$llamadas_llm', cond: { $ne: ['$$this.error', null] } } } } },
          con_barandilla: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$controles', []] } }, 0] }, 1, 0] } },
          latencia: { $percentile: { input: '$latencia_ms', p: [0.5, 0.95], method: 'approximate' } },
          estados: { $push: '$estado_final' },
        },
      },
      {
        $set: {
          por_estado: {
            $map: {
              input: { $setUnion: ['$estados', []] },
              as: 'e',
              in: { k: '$$e', v: { $size: { $filter: { input: '$estados', cond: { $eq: ['$$this', '$$e'] } } } } },
            },
          },
        },
      },
      { $unset: ['estados', '_id'] },
    ])
    .toArray();
  const herramientas = await mongo.turnos
    .aggregate<{ nombre: string; llamadas: number; errores: number; duracion_promedio_ms: number }>([
      { $match: filtro },
      { $unwind: '$herramientas' },
      {
        $group: {
          _id: '$herramientas.nombre',
          llamadas: { $sum: 1 },
          errores: { $sum: { $cond: [{ $ne: ['$herramientas.error', null] }, 1, 0] } },
          duracion_promedio_ms: { $avg: '$herramientas.duracion_ms' },
        },
      },
      { $project: { _id: 0, nombre: '$_id', llamadas: 1, errores: 1, duracion_promedio_ms: { $round: ['$duracion_promedio_ms', 0] } } },
      { $sort: { llamadas: -1 } },
    ])
    .toArray();
  if (!totales) return null;
  const { latencia, por_estado, ...resto } = totales;
  return {
    ...resto,
    // Con un turno del LLM sin precio conocido, el total no se reporta como si fuera completo.
    costo_usd: resto.sin_precio > 0 ? null : resto.costo_usd,
    costo_promedio_usd: resto.sin_precio > 0 || resto.turnos === 0 ? null : resto.costo_usd / resto.turnos,
    latencia_p50_ms: Math.round(latencia[0] ?? 0),
    latencia_p95_ms: Math.round(latencia[1] ?? 0),
    por_estado: Object.fromEntries(por_estado.map((e) => [e.k, e.v])),
    herramientas,
  };
}
