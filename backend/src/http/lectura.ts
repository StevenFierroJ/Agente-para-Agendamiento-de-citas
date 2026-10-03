import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ESTADOS_CONVERSACION } from '../dominio/errores.js';
import type { Mongo } from '../infraestructura/mongo/mongo.js';
import { leerBandeja, leerCitas, leerConversacion, leerPendientes } from '../infraestructura/postgres/lectura.js';
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
}
