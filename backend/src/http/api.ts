import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { encolarMensaje } from '../infraestructura/cola/cola.js';
import type { Mongo } from '../infraestructura/mongo/mongo.js';
import { registrarMensajeEntrante } from '../infraestructura/postgres/mensajes.js';
import { describirError, enmascararTelefono, type Registro } from '../infraestructura/registro.js';
import { conversacionDeMensaje } from '../infraestructura/postgres/lectura.js';
import { registrarRutasDeLectura } from './lectura.js';
import { CuerpoWebhook, detalleDeError } from './webhook.js';

export interface DependenciasApi {
  pool: pg.Pool;
  boss: PgBoss;
  mongo: Mongo;
  registro: Registro;
}

export function crearApi(deps: DependenciasApi): FastifyInstance {
  const app = Fastify({ logger: false });

  // JSON mal formado y cualquier otro error, con la misma forma de respuesta.
  app.setErrorHandler((error: { statusCode?: number; message: string }, _peticion, respuesta) => {
    const estado = error.statusCode ?? 500;
    if (estado >= 500) deps.registro.error('error no controlado', { error: describirError(error) });
    return respuesta.status(estado).send({
      error: estado >= 500 ? 'error_interno' : 'peticion_invalida',
      detalle: estado >= 500 ? 'Error interno' : error.message,
    });
  });

  /**
   * Webhook: valida, registra y encola en una sola transacción, y responde.
   * Nunca llama al LLM. 202 si el mensaje es nuevo, 200 si ya se había recibido.
   */
  app.post('/webhooks/messages', async (peticion, respuesta) => {
    const cuerpo = CuerpoWebhook.safeParse(peticion.body);
    if (!cuerpo.success) {
      return respuesta.status(400).send({ error: 'cuerpo_invalido', detalle: detalleDeError(cuerpo.error) });
    }
    const { message_id: messageId, from: telefono, text: texto, timestamp } = cuerpo.data;

    const cliente = await deps.pool.connect();
    try {
      await cliente.query('BEGIN');
      const registrado = await registrarMensajeEntrante(cliente, { messageId, telefono, texto, enviadoEn: new Date(timestamp) });
      if (!registrado) {
        await cliente.query('ROLLBACK');
        const conversacionId = await conversacionDeMensaje(deps.pool, messageId);
        return respuesta.status(200).send({ estado: 'duplicado', message_id: messageId, conversacion_id: conversacionId });
      }
      await encolarMensaje(deps.boss, cliente, messageId, registrado.conversacionId);
      await cliente.query('COMMIT');
      deps.registro.info('mensaje recibido', { message_id: messageId, telefono: enmascararTelefono(telefono) });
      return respuesta.status(202).send({ estado: 'recibido', message_id: messageId, conversacion_id: registrado.conversacionId });
    } catch (error) {
      await cliente.query('ROLLBACK');
      throw error;
    } finally {
      cliente.release();
    }
  });

  registrarRutasDeLectura(app, { pool: deps.pool, mongo: deps.mongo });

  app.get('/salud', async (_peticion, respuesta) => {
    const comprobar = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok';
      } catch (error) {
        return `error: ${describirError(error)}`;
      }
    };
    const [postgres, mongodb] = await Promise.all([
      comprobar(() => deps.pool.query('SELECT 1')),
      comprobar(() => deps.mongo.db.command({ ping: 1 })),
    ]);
    const sano = postgres === 'ok' && mongodb === 'ok';
    return respuesta.status(sano ? 200 : 503).send({ estado: sano ? 'ok' : 'degradado', postgres, mongodb });
  });

  return app;
}
