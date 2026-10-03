import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApi } from '../src/http/api.js';
import { registroSilencioso } from '../src/infraestructura/registro.js';
import type { Sistema } from '../src/sistema.js';
import { levantarSistemaDeTest, limpiarConversaciones, mensaje, prepararBasesDeTest } from './ayudas/sistema.js';

// Sin trabajador: aquí se prueba solo la recepción.
describe('POST /webhooks/messages', () => {
  let sistema: Sistema;

  beforeAll(async () => {
    await prepararBasesDeTest();
    ({ sistema } = await levantarSistemaDeTest({ conTrabajador: false }));
  });
  afterAll(async () => {
    await sistema.detener();
  });
  beforeEach(async () => {
    await limpiarConversaciones(sistema);
  });

  const enviar = (cuerpo: unknown) =>
    sistema.api.inject({
      method: 'POST', url: '/webhooks/messages', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(cuerpo),
    });

  async function contar(sql: string): Promise<number> {
    const { rows } = await sistema.pool.query<{ n: string }>(sql);
    return Number(rows[0]?.n);
  }
  const trabajos = () => contar("SELECT count(*) AS n FROM pgboss.job WHERE name = 'mensajes'");

  it('registra, encola y responde 202', async () => {
    const r = await enviar(mensaje('wamid.001'));
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ estado: 'recibido', message_id: 'wamid.001', conversacion_id: 1 });
    expect(await contar("SELECT count(*) AS n FROM mensajes_entrantes WHERE estado = 'recibido'")).toBe(1);
    expect(await contar('SELECT count(*) AS n FROM conversaciones')).toBe(1);
    expect(await trabajos()).toBe(1);
  });

  it('guarda texto y timestamp para que el trabajador no dependa de la cola', async () => {
    await enviar(mensaje('wamid.002', 'Hola, ¿tienen dermatología?', { timestamp: '2026-10-06T03:40:00Z' }));
    const { rows } = await sistema.pool.query('SELECT texto, enviado_en FROM mensajes_entrantes');
    expect(rows[0]).toEqual({ texto: 'Hola, ¿tienen dermatología?', enviado_en: new Date('2026-10-06T03:40:00Z') });
  });

  it('el mismo message_id dos veces: 202 y luego 200, una fila y un trabajo', async () => {
    expect((await enviar(mensaje('wamid.003'))).statusCode).toBe(202);
    const repetido = await enviar(mensaje('wamid.003'));
    expect(repetido.statusCode).toBe(200);
    expect(repetido.json()).toEqual({ estado: 'duplicado', message_id: 'wamid.003', conversacion_id: 1 });
    expect(await contar('SELECT count(*) AS n FROM mensajes_entrantes')).toBe(1);
    expect(await trabajos()).toBe(1);
  });

  it('diez envíos simultáneos del mismo message_id: exactamente un 202', async () => {
    const respuestas = await Promise.all(Array.from({ length: 10 }, () => enviar(mensaje('wamid.004'))));
    const codigos = respuestas.map((r) => r.statusCode).sort();
    expect(codigos).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
    expect(await contar('SELECT count(*) AS n FROM mensajes_entrantes')).toBe(1);
    expect(await trabajos()).toBe(1);
  });

  it('cada teléfono tiene una sola conversación', async () => {
    await enviar(mensaje('wamid.005', 'Hola', { from: '+573001112233' }));
    await enviar(mensaje('wamid.006', 'Otra vez', { from: '+573001112233' }));
    await enviar(mensaje('wamid.007', 'Hola', { from: '+573009998877' }));
    expect(await contar('SELECT count(*) AS n FROM conversaciones')).toBe(2);
  });

  const base = mensaje('wamid.x');
  const { message_id: _sinId, ...sinMessageId } = base;
  it.each([
    ['sin message_id', sinMessageId],
    ['timestamp que no es fecha', { ...base, timestamp: 'ayer a las 3' }],
    ['timestamp sin zona', { ...base, timestamp: '2026-10-05T09:00:00' }],
    ['teléfono mal formado', { ...base, from: '3001112233' }],
    ['texto vacío', { ...base, text: '   ' }],
    ['texto de más de 4.096 caracteres', { ...base, text: 'x'.repeat(4097) }],
    ['campo de más', { ...base, campo_extra: 1 }],
    ['un string en lugar de objeto', 'Hola'],
    ['null', null],
  ])('400 con detalle y nada registrado: %s', async (_caso, cuerpo) => {
    const r = await enviar(cuerpo);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'cuerpo_invalido' });
    expect(r.json().detalle.length).toBeGreaterThan(0);
    expect(await contar('SELECT count(*) AS n FROM conversaciones')).toBe(0);
    expect(await trabajos()).toBe(0);
  });

  it('JSON mal formado: 400', async () => {
    const r = await sistema.api.inject({
      method: 'POST', url: '/webhooks/messages', headers: { 'content-type': 'application/json' }, payload: '{"message_id": ',
    });
    expect(r.statusCode).toBe(400);
  });

  it('un cuerpo en texto plano: 400 cuerpo_invalido', async () => {
    const r = await sistema.api.inject({
      method: 'POST', url: '/webhooks/messages', headers: { 'content-type': 'text/plain' }, payload: 'Hola',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'cuerpo_invalido' });
  });

  it('acepta un timestamp con offset', async () => {
    expect((await enviar(mensaje('wamid.008', 'Hola', { timestamp: '2026-10-05T22:40:00-05:00' }))).statusCode).toBe(202);
  });

  it('si encolar falla, no queda ni el mensaje ni la conversación (una sola transacción)', async () => {
    const bossQueFalla = { send: () => Promise.reject(new Error('cola caída')) } as unknown as PgBoss;
    const api = crearApi({ pool: sistema.pool, boss: bossQueFalla, mongo: sistema.mongo, registro: registroSilencioso });
    const r = await api.inject({ method: 'POST', url: '/webhooks/messages', payload: mensaje('wamid.009') });
    expect(r.statusCode).toBe(500);
    expect(await contar('SELECT count(*) AS n FROM mensajes_entrantes')).toBe(0);
    expect(await contar('SELECT count(*) AS n FROM conversaciones')).toBe(0);
    await api.close();
  });

  it('GET /salud', async () => {
    const r = await sistema.api.inject({ method: 'GET', url: '/salud' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ estado: 'ok', postgres: 'ok', mongodb: 'ok' });
  });
});
