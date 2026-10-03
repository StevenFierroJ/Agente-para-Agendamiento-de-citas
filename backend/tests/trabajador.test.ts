import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MENSAJE_CONVERSACION_ESCALADA, MENSAJE_FALLA_TECNICA } from '../src/aplicacion/mensajes-fijos.js';
import type { Herramienta } from '../src/aplicacion/puertos.js';
import { LlmGuionado } from '../src/infraestructura/llm/falso.js';
import type { Sistema } from '../src/sistema.js';
import { esperarProcesados, levantarSistemaDeTest, limpiarConversaciones, mensaje, prepararBasesDeTest } from './ayudas/sistema.js';

const TELEFONO = '+573001112233';

describe('trabajador', () => {
  let sistema: Sistema;
  let llm: LlmGuionado;

  beforeAll(async () => {
    await prepararBasesDeTest();
    // Latencia para que la concurrencia sea observable.
    llm = new LlmGuionado({ latenciaMs: () => 100 });
    ({ sistema } = await levantarSistemaDeTest({ llm, concurrencia: 5 }));
  });
  afterAll(async () => {
    await sistema.detener();
  });
  afterEach(async () => {
    await limpiarConversaciones(sistema);
    llm.olvidar();
  });

  async function enviar(cuerpo: ReturnType<typeof mensaje>): Promise<void> {
    const r = await sistema.api.inject({ method: 'POST', url: '/webhooks/messages', payload: cuerpo });
    expect(r.statusCode).toBe(202);
  }

  it('procesa el mensaje: respuesta y turno en MongoDB, procesado en PostgreSQL', async () => {
    llm.guionar('m.1', [{ tipo: 'texto', texto: 'Hola, ¿en qué te ayudo?' }]);
    await enviar(mensaje('m.1', 'Hola', { timestamp: '2026-10-06T03:40:00Z' }));
    await esperarProcesados(sistema.pool, ['m.1']);

    const salida = await sistema.mongo.mensajes.findOne({ _id: 'm.1:salida' });
    expect(salida?.texto).toBe('Hola, ¿en qué te ayudo?');
    expect(await sistema.mongo.mensajes.findOne({ _id: 'm.1:entrada' })).toMatchObject({ rol: 'paciente', texto: 'Hola' });

    const turno = await sistema.mongo.turnos.findOne({ _id: 'm.1' });
    expect(turno).toMatchObject({ estado_final: 'resuelta_por_ia', modelo: 'falso-guionado', iteraciones: 1, error: null });
    expect(turno?.tokens_entrada).toBeGreaterThan(0);
    expect(turno?.costo_usd).toBeGreaterThan(0);

    const { rows } = await sistema.pool.query(
      `SELECT m.estado, c.estado AS conversacion FROM mensajes_entrantes m JOIN conversaciones c ON c.id = m.conversacion_id`,
    );
    expect(rows[0]).toEqual({ estado: 'procesado', conversacion: 'resuelta_por_ia' });
  });

  it('el prompt lleva la fecha y hora de Colombia del mensaje, y el teléfono nunca llega al LLM', async () => {
    llm.guionar('m.2', [{ tipo: 'texto', texto: 'Hola' }]);
    await enviar(mensaje('m.2', 'Hola', { timestamp: '2026-10-06T03:40:00Z' }));
    await esperarProcesados(sistema.pool, ['m.2']);
    const pedido = JSON.stringify(llm.pedidos);
    expect(pedido).toContain('lunes 5 de octubre de 2026 (2026-10-05), son las 22:40. Mañana es 2026-10-06');
    expect(pedido).not.toContain(TELEFONO);
    expect(pedido).not.toContain(TELEFONO.slice(3));
  });

  it('el historial de la conversación llega al LLM en orden', async () => {
    llm.guionar('h.1', [{ tipo: 'texto', texto: 'Respuesta uno' }]);
    llm.guionar('h.2', [{ tipo: 'texto', texto: 'Respuesta dos' }]);
    await enviar(mensaje('h.1', 'Pregunta uno', { timestamp: '2026-10-05T14:00:00Z' }));
    await esperarProcesados(sistema.pool, ['h.1']);
    await enviar(mensaje('h.2', 'Pregunta dos', { timestamp: '2026-10-05T14:01:00Z' }));
    await esperarProcesados(sistema.pool, ['h.2']);
    const segundo = llm.pedidos.find((p) => p.etiqueta === 'h.2');
    expect(segundo?.mensajes.slice(1)).toEqual([
      { rol: 'paciente', contenido: 'Pregunta uno' },
      { rol: 'asistente', contenido: 'Respuesta uno' },
      { rol: 'paciente', contenido: 'Pregunta dos' },
    ]);
  });

  it('conversación escalada: no llama al LLM y responde el mensaje fijo', async () => {
    await sistema.pool.query(
      "INSERT INTO conversaciones (telefono, estado, ultimo_mensaje_en) VALUES ($1, 'escalada', now())", [TELEFONO],
    );
    await enviar(mensaje('e.1', '¿Siguen ahí?'));
    await esperarProcesados(sistema.pool, ['e.1']);
    expect(llm.llamadasDe('e.1')).toBe(0);
    expect((await sistema.mongo.mensajes.findOne({ _id: 'e.1:salida' }))?.texto).toBe(MENSAJE_CONVERSACION_ESCALADA);
    expect(await sistema.mongo.turnos.findOne({ _id: 'e.1' })).toMatchObject({ estado_final: 'escalada', costo_usd: 0 });
  });

  it('el LLM falla dos veces: mensaje fijo, conversación escalada, turno con el error', async () => {
    llm.guionar('f.1', [{ tipo: 'falla', falla: 'timeout' }, { tipo: 'falla', falla: 'error_proveedor' }]);
    await enviar(mensaje('f.1'));
    await esperarProcesados(sistema.pool, ['f.1']);
    expect((await sistema.mongo.mensajes.findOne({ _id: 'f.1:salida' }))?.texto).toBe(MENSAJE_FALLA_TECNICA);
    const turno = await sistema.mongo.turnos.findOne({ _id: 'f.1' });
    expect(turno?.estado_final).toBe('escalada');
    expect(turno?.error).toMatch(/falla_llm/);
    expect(turno?.llamadas_llm).toHaveLength(2);
    const { rows } = await sistema.pool.query('SELECT estado FROM conversaciones');
    expect(rows[0]?.estado).toBe('escalada');
  });

  it('mensajes del mismo teléfono: uno a la vez y en orden de llegada; teléfonos distintos en paralelo', async () => {
    const mismos = ['s.1', 's.2', 's.3'];
    const otros = ['o.1', 'o.2', 'o.3'];
    for (const id of [...mismos, ...otros]) llm.guionar(id, [{ tipo: 'texto', texto: `ok ${id}` }]);
    for (const [i, id] of mismos.entries()) {
      await enviar(mensaje(id, `mensaje ${i}`, { timestamp: `2026-10-05T14:00:0${i}Z` }));
    }
    await Promise.all(otros.map((id, i) => enviar(mensaje(id, 'Hola', { from: `+57300000000${i}` }))));
    await esperarProcesados(sistema.pool, [...mismos, ...otros]);

    const turnos = await sistema.mongo.turnos.find({ _id: { $in: mismos } }).sort({ iniciado_en: 1 }).toArray();
    expect(turnos.map((t) => t._id)).toEqual(mismos);
    for (let i = 1; i < turnos.length; i++) {
      expect(turnos[i]!.iniciado_en.getTime()).toBeGreaterThanOrEqual(turnos[i - 1]!.terminado_en.getTime());
    }

    const deOtros = await sistema.mongo.turnos.find({ _id: { $in: otros } }).toArray();
    const solapan = deOtros.some((a) => deOtros.some((b) => a !== b && a.iniciado_en < b.terminado_en && b.iniciado_en < a.terminado_en));
    expect(solapan).toBe(true);
  });
});

describe('trabajador: último intento agotado', () => {
  let sistema: Sistema;
  let llm: LlmGuionado;
  // Una herramienta que siempre lanza: simula la base caída durante todos los reintentos.
  const explota: Herramienta = {
    definicion: { nombre: 'explota', descripcion: 'falla siempre', parametros: { type: 'object' } },
    ejecutar: () => Promise.reject(new Error('base caída')),
  };

  beforeAll(async () => {
    await prepararBasesDeTest();
    llm = new LlmGuionado({
      porDefecto: (pedido) =>
        pedido.etiqueta === 'x.1'
          ? { tipo: 'herramientas', llamadas: [{ nombre: 'explota', argumentosCrudos: '{}' }] }
          : { tipo: 'texto', texto: 'Hola de nuevo' },
    });
    ({ sistema } = await levantarSistemaDeTest({ llm, reintentos: 1, herramientas: new Map([['explota', explota]]) }));
  });
  afterAll(async () => {
    await sistema.detener();
  });

  it('marca fallido, escala, guarda el mensaje fijo y no bloquea la conversación', async () => {
    await sistema.api.inject({ method: 'POST', url: '/webhooks/messages', payload: mensaje('x.1') });
    await sistema.api.inject({ method: 'POST', url: '/webhooks/messages', payload: mensaje('x.2', 'Sigo aquí') });
    await esperarProcesados(sistema.pool, ['x.1', 'x.2'], 20_000);

    const { rows } = await sistema.pool.query('SELECT message_id, estado FROM mensajes_entrantes ORDER BY message_id');
    expect(rows).toEqual([{ message_id: 'x.1', estado: 'fallido' }, { message_id: 'x.2', estado: 'procesado' }]);
    expect(llm.llamadasDe('x.1')).toBe(2); // primer intento y un reintento de la cola
    expect((await sistema.mongo.mensajes.findOne({ _id: 'x.1:salida' }))?.texto).toBe(MENSAJE_FALLA_TECNICA);
    // x.2 llega a una conversación ya escalada: mensaje fijo, sin LLM.
    expect(llm.llamadasDe('x.2')).toBe(0);
    expect((await sistema.mongo.mensajes.findOne({ _id: 'x.2:salida' }))?.texto).toBe(MENSAJE_CONVERSACION_ESCALADA);
  });
});
