import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearEscalarAHumano } from '../src/aplicacion/herramientas/escalar-a-humano.js';
import { LlmGuionado } from '../src/infraestructura/llm/falso.js';
import type { Sistema } from '../src/sistema.js';
import { esperarProcesados, levantarSistemaDeTest, limpiarConversaciones, mensaje, prepararBasesDeTest } from './ayudas/sistema.js';

describe('API de lectura', () => {
  let sistema: Sistema;
  let llm: LlmGuionado;

  beforeAll(async () => {
    await prepararBasesDeTest();
    llm = new LlmGuionado();
    ({ sistema } = await levantarSistemaDeTest({ llm, herramientas: new Map([['escalar_a_humano', crearEscalarAHumano()]]) }));
  });
  afterAll(async () => {
    await sistema.detener();
  });
  beforeEach(async () => {
    await limpiarConversaciones(sistema);
    llm.olvidar();
  });

  const get = async (url: string) => {
    const r = await sistema.api.inject({ method: 'GET', url });
    return { status: r.statusCode, cuerpo: r.json() };
  };
  const enviar = async (cuerpo: ReturnType<typeof mensaje>) => {
    const r = await sistema.api.inject({ method: 'POST', url: '/webhooks/messages', payload: cuerpo });
    return r.json() as { conversacion_id: number };
  };

  async function sembrarTresConversaciones(): Promise<void> {
    llm.guionar('a.1', [{ tipo: 'texto', texto: 'Hola A' }]);
    llm.guionar('b.1', [
      { tipo: 'herramientas', llamadas: [{ nombre: 'escalar_a_humano', argumentosCrudos: '{"motivo":"solicitud_del_paciente"}' }] },
      { tipo: 'texto', texto: 'Te paso con un asesor' },
    ]);
    llm.guionar('c.1', [{ tipo: 'texto', texto: 'Hola C' }]);
    await enviar(mensaje('a.1', 'Hola', { from: '+573000000001', timestamp: '2026-10-05T14:00:00Z' }));
    await enviar(mensaje('b.1', 'Quiero un humano', { from: '+573000000002', timestamp: '2026-10-05T14:05:00Z' }));
    await enviar(mensaje('c.1', 'Buenas', { from: '+573000000003', timestamp: '2026-10-05T14:10:00Z' }));
    await esperarProcesados(sistema.pool, ['a.1', 'b.1', 'c.1']);
  }

  describe('GET /conversaciones', () => {
    it('lista por último mensaje, con teléfono enmascarado y último texto', async () => {
      await sembrarTresConversaciones();
      const { status, cuerpo } = await get('/conversaciones');
      expect(status).toBe(200);
      expect(cuerpo.conversaciones.map((c: { telefono: string }) => c.telefono)).toEqual(['+57300***0003', '+57300***0002', '+57300***0001']);
      expect(cuerpo.conversaciones[1]).toMatchObject({ estado: 'escalada', ultimo_texto: 'Quiero un humano', mensajes_pendientes: 0 });
      expect(cuerpo.siguiente).toBeNull();
      expect(JSON.stringify(cuerpo)).not.toContain('+573000000002');
    });

    it('filtra por estado', async () => {
      await sembrarTresConversaciones();
      const { cuerpo } = await get('/conversaciones?estado=escalada');
      expect(cuerpo.conversaciones).toHaveLength(1);
      expect(cuerpo.conversaciones[0].estado).toBe('escalada');
      expect((await get('/conversaciones?estado=cita_agendada')).cuerpo.conversaciones).toEqual([]);
    });

    it('pagina con cursor sin repetir ni saltar', async () => {
      await sembrarTresConversaciones();
      const vistos: string[] = [];
      let url = '/conversaciones?limite=2';
      for (;;) {
        const { cuerpo } = await get(url);
        vistos.push(...cuerpo.conversaciones.map((c: { telefono: string }) => c.telefono));
        if (!cuerpo.siguiente) break;
        url = `/conversaciones?limite=2&antes=${encodeURIComponent(cuerpo.siguiente)}`;
      }
      expect(vistos).toEqual(['+57300***0003', '+57300***0002', '+57300***0001']);
    });

    it.each([['estado=cerrada'], ['limite=0'], ['limite=500'], ['antes=ayer'], ['otro=1']])('400 con %s', async (consulta) => {
      const { status, cuerpo } = await get(`/conversaciones?${consulta}`);
      expect(status).toBe(400);
      expect(cuerpo.error).toBe('consulta_invalida');
    });
  });

  describe('GET /conversaciones/:id', () => {
    it('mensajes en orden y, por cada respuesta, su turno con herramientas, costo y resumen', async () => {
      await sembrarTresConversaciones();
      const { conversacion_id } = await enviar(mensaje('b.2', '¿Siguen ahí?', { from: '+573000000002', timestamp: '2026-10-05T14:06:00Z' }));
      await esperarProcesados(sistema.pool, ['b.2']);

      const { status, cuerpo } = await get(`/conversaciones/${conversacion_id}`);
      expect(status).toBe(200);
      expect(cuerpo.conversacion).toMatchObject({ telefono: '+57300***0002', estado: 'escalada' });
      expect(cuerpo.mensajes.map((m: { rol: string; texto: string }) => `${m.rol}: ${m.texto}`)).toEqual([
        'paciente: Quiero un humano',
        'asistente: Te paso con un asesor',
        'paciente: ¿Siguen ahí?',
        'asistente: Tu conversación ya está con un asesor de la clínica. Te responderá lo antes posible.',
      ]);
      const [primero, segundo] = cuerpo.turnos;
      expect(primero).toMatchObject({ message_id: 'b.1', estado_final: 'escalada', modelo: 'falso-guionado' });
      expect(primero.herramientas).toEqual([
        expect.objectContaining({ nombre: 'escalar_a_humano', argumentos: { motivo: 'solicitud_del_paciente' }, error: null }),
      ]);
      expect(segundo).toMatchObject({ message_id: 'b.2', costo_usd: 0, herramientas: [] });
      expect(cuerpo.resumen.turnos).toBe(2);
      expect(cuerpo.resumen.costo_usd).toBeGreaterThan(0);
      expect(cuerpo).toMatchObject({ respondiendo: false, pendientes: [], citas: [] });
    });

    it('404 si no existe, 400 si el id no es válido', async () => {
      expect((await get('/conversaciones/999')).status).toBe(404);
      expect((await get('/conversaciones/abc')).status).toBe(400);
    });
  });
});

describe('API de lectura: mensaje sin procesar', () => {
  let sistema: Sistema;
  beforeAll(async () => {
    await prepararBasesDeTest();
    ({ sistema } = await levantarSistemaDeTest({ conTrabajador: false }));
  });
  afterAll(async () => {
    await sistema.detener();
  });

  it('muestra el mensaje pendiente y "respondiendo" mientras el trabajador no lo procesa', async () => {
    const r = await sistema.api.inject({ method: 'POST', url: '/webhooks/messages', payload: mensaje('p.1', 'Hola, ¿hay cita?') });
    const { conversacion_id } = r.json() as { conversacion_id: number };
    const detalle = (await sistema.api.inject({ method: 'GET', url: `/conversaciones/${conversacion_id}` })).json();
    expect(detalle.respondiendo).toBe(true);
    expect(detalle.pendientes).toEqual([expect.objectContaining({ message_id: 'p.1', texto: 'Hola, ¿hay cita?', estado: 'recibido' })]);
    expect(detalle.conversacion.estado).toBe('abierta');
    const bandeja = (await sistema.api.inject({ method: 'GET', url: '/conversaciones' })).json();
    expect(bandeja.conversaciones[0]).toMatchObject({ mensajes_pendientes: 1, ultimo_texto: 'Hola, ¿hay cita?' });
  });
});
