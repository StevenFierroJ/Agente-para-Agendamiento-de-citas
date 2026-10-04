import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearEscalarAHumano } from '../src/aplicacion/herramientas/escalar-a-humano.js';
import { LlmGuionado } from '../src/infraestructura/llm/falso.js';
import type { Sistema } from '../src/sistema.js';
import { EmbeddingFalso } from '../src/infraestructura/embeddings/falso.js';
import { sembrarDocumentos } from '../seed/documentos.js';
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

  describe('GET /turnos', () => {
    it('lista los turnos de todas las conversaciones, del más reciente al más viejo, con pregunta y respuesta', async () => {
      await sembrarTresConversaciones();
      const { status, cuerpo } = await get('/turnos');
      expect(status).toBe(200);
      expect(cuerpo.turnos.map((t: { message_id: string }) => t.message_id)).toEqual(['c.1', 'b.1', 'a.1']);
      expect(cuerpo.turnos[1]).toMatchObject({
        telefono: '+57300***0002',
        pregunta: 'Quiero un humano',
        respuesta: 'Te paso con un asesor',
        estado_final: 'escalada',
        herramientas: [{ nombre: 'escalar_a_humano', error: null }],
      });
      expect(cuerpo.resumen).toMatchObject({
        turnos: 3,
        por_estado: { resuelta_por_ia: 2, escalada: 1 },
        herramientas: [{ nombre: 'escalar_a_humano', llamadas: 1, errores: 0 }],
      });
      expect(cuerpo.resumen.latencia_p95_ms).toBeGreaterThanOrEqual(cuerpo.resumen.latencia_p50_ms);
    });

    it('filtra por herramienta y por estado final; el resumen sigue al filtro', async () => {
      await sembrarTresConversaciones();
      const porHerramienta = (await get('/turnos?herramienta=escalar_a_humano')).cuerpo;
      expect(porHerramienta.turnos.map((t: { message_id: string }) => t.message_id)).toEqual(['b.1']);
      expect(porHerramienta.resumen.turnos).toBe(1);
      const porEstado = (await get('/turnos?estado_final=resuelta_por_ia')).cuerpo;
      expect(porEstado.turnos.map((t: { message_id: string }) => t.message_id)).toEqual(['c.1', 'a.1']);
      const sinProblemas = (await get('/turnos?con_problemas=true')).cuerpo;
      expect(sinProblemas.turnos).toEqual([]);
      expect(sinProblemas.resumen).toBeNull();
    });

    it('con_problemas trae los turnos con una herramienta fallida', async () => {
      await sembrarTresConversaciones();
      llm.guionar('d.1', [
        { tipo: 'herramientas', llamadas: [{ nombre: 'escalar_a_humano', argumentosCrudos: '{"motivo":"porque si"}' }] },
        { tipo: 'texto', texto: '¿En qué te ayudo?' },
      ]);
      await enviar(mensaje('d.1', 'Hola', { from: '+573000000004', timestamp: '2026-10-05T14:20:00Z' }));
      await esperarProcesados(sistema.pool, ['d.1']);
      const { cuerpo } = await get('/turnos?con_problemas=true');
      expect(cuerpo.turnos.map((t: { message_id: string }) => t.message_id)).toEqual(['d.1']);
      expect(cuerpo.resumen.herramientas).toEqual([{ nombre: 'escalar_a_humano', llamadas: 1, errores: 1, duracion_promedio_ms: expect.any(Number) }]);
    });

    it('pagina con el cursor siguiente sin repetir ni saltar turnos', async () => {
      await sembrarTresConversaciones();
      const primera = (await get('/turnos?limite=2')).cuerpo;
      expect(primera.turnos).toHaveLength(2);
      expect(primera.siguiente).not.toBeNull();
      const segunda = (await get(`/turnos?limite=2&antes=${encodeURIComponent(primera.siguiente)}`)).cuerpo;
      expect(segunda.turnos.map((t: { message_id: string }) => t.message_id)).toEqual(['a.1']);
      expect(segunda.siguiente).toBeNull();
    });

    it.each(['/turnos?herramienta=borrar_todo', '/turnos?estado_final=abierta', '/turnos?limite=0', '/turnos?antes=ayer', '/turnos?extra=1'])(
      '%s → 400',
      async (url) => {
        expect((await get(url)).status).toBe(400);
      },
    );
  });

  describe('GET /trazas/conversaciones', () => {
    type Fila = { conversacion_id: number; telefono: string; estado: string; turnos: number; primer_mensaje: string; herramientas: unknown[]; tokens_entrada: number };
    const telefonos = (cuerpo: { conversaciones: Fila[] }) => cuerpo.conversaciones.map((c) => c.telefono);

    it('una fila por conversación, la de actividad más reciente primero, con los totales de todos sus turnos', async () => {
      await sembrarTresConversaciones();
      llm.guionar('a.2', [{ tipo: 'texto', texto: 'Con gusto' }]);
      await enviar(mensaje('a.2', 'Gracias', { from: '+573000000001', timestamp: '2026-10-05T14:30:00Z' }));
      await esperarProcesados(sistema.pool, ['a.2']);

      const { status, cuerpo } = await get('/trazas/conversaciones');
      expect(status).toBe(200);
      expect(telefonos(cuerpo)).toEqual(['+57300***0001', '+57300***0003', '+57300***0002']);
      const [a] = cuerpo.conversaciones as Fila[];
      const turnosDeA = (await get(`/turnos?conversacion_id=${a!.conversacion_id}`)).cuerpo.turnos as { tokens_entrada: number }[];
      expect(a).toMatchObject({ turnos: 2, estado: 'resuelta_por_ia', primer_mensaje: 'Hola', herramientas: [] });
      expect(turnosDeA).toHaveLength(2);
      expect(a!.tokens_entrada).toBe(turnosDeA.reduce((n, t) => n + t.tokens_entrada, 0));
      expect(cuerpo.conversaciones[2]).toMatchObject({ estado: 'escalada', herramientas: [{ nombre: 'escalar_a_humano', llamadas: 1, errores: 0 }] });
      expect(cuerpo.resumen.turnos).toBe(4);
    });

    it('los filtros eligen conversaciones; el resumen cubre solo esas', async () => {
      await sembrarTresConversaciones();
      for (const url of ['/trazas/conversaciones?herramienta=escalar_a_humano', '/trazas/conversaciones?estado=escalada']) {
        const { cuerpo } = await get(url);
        expect(telefonos(cuerpo)).toEqual(['+57300***0002']);
        expect(cuerpo.resumen.turnos).toBe(1);
      }
      expect((await get('/trazas/conversaciones?con_problemas=true')).cuerpo.conversaciones).toEqual([]);
    });

    it('pagina con el cursor siguiente', async () => {
      await sembrarTresConversaciones();
      const primera = (await get('/trazas/conversaciones?limite=2')).cuerpo;
      expect(telefonos(primera)).toEqual(['+57300***0003', '+57300***0002']);
      const segunda = (await get(`/trazas/conversaciones?limite=2&antes=${encodeURIComponent(primera.siguiente)}`)).cuerpo;
      expect(telefonos(segunda)).toEqual(['+57300***0001']);
      expect(segunda.siguiente).toBeNull();
    });

    it.each(['/trazas/conversaciones?estado=cerrada', '/trazas/conversaciones?antes=ayer', '/trazas/conversaciones?limite=500', '/turnos?conversacion_id=abc'])(
      '%s → 400',
      async (url) => {
        expect((await get(url)).status).toBe(400);
      },
    );
  });

  describe('GET /agenda', () => {
    it('trae los horarios del rango en hora de Colombia, filtrados, con su cita activa', async () => {
      const { rows } = await sistema.pool.query<{ id: number }>(
        `SELECT h.id FROM horarios h JOIN sedes s ON s.id = h.sede_id JOIN profesionales p ON p.id = h.profesional_id
          JOIN especialidades e ON e.id = p.especialidad_id
         WHERE s.nombre = 'Sede Sur' AND e.nombre = 'Dermatología' AND h.inicio = '2026-10-06T13:00:00Z'`,
      );
      const { rows: conv } = await sistema.pool.query<{ id: number }>(
        "INSERT INTO conversaciones (telefono, ultimo_mensaje_en) VALUES ('+573000000009', now()) RETURNING id",
      );
      await sistema.pool.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [rows[0]!.id, conv[0]!.id, 'Ana Pérez']);

      const { cuerpo: catalogo } = await get('/agenda?desde=2026-10-06&hasta=2026-10-06');
      const sur = catalogo.catalogo.sedes.find((s: { nombre: string }) => s.nombre === 'Sede Sur').id;
      const derma = catalogo.catalogo.especialidades.find((e: { nombre: string }) => e.nombre === 'Dermatología').id;

      const { status, cuerpo } = await get(`/agenda?desde=2026-10-06&hasta=2026-10-06&sede=${sur}&especialidad=${derma}`);
      expect(status).toBe(200);
      // Martes en la Sede Sur: Restrepo 08–12 (8 bloques) y Mora 14–17 (6 bloques).
      expect(cuerpo.horarios).toHaveLength(14);
      const conCita = cuerpo.horarios.filter((h: { cita: unknown }) => h.cita !== null);
      expect(conCita).toHaveLength(1);
      expect(conCita[0]).toMatchObject({ inicio: '2026-10-06T13:00:00.000Z', cita: { nombre_paciente: 'Ana Pérez', conversacion_id: conv[0]!.id } });
    });

    it.each([
      ['/agenda', 'sin rango'],
      ['/agenda?desde=2026-10-09&hasta=2026-10-05', 'hasta antes que desde'],
      ['/agenda?desde=2026-10-01&hasta=2026-11-15', 'más de 31 días'],
      ['/agenda?desde=2026-02-30&hasta=2026-03-02', 'fecha que no existe'],
      ['/agenda?desde=2026-10-05&hasta=2026-10-09&sede=norte', 'sede que no es un id'],
    ])('%s → 400 (%s)', async (url) => {
      const { status, cuerpo } = await get(url);
      expect(status).toBe(400);
      expect(cuerpo.error).toBe('consulta_invalida');
    });
  });

  describe('GET /conocimiento', () => {
    it('lista los documentos indexados con sus fragmentos, sin los vectores', async () => {
      await sembrarDocumentos(sistema.pool, new EmbeddingFalso());
      const { status, cuerpo } = await get('/conocimiento');
      expect(status).toBe(200);
      expect(cuerpo.documentos.length).toBeGreaterThanOrEqual(6);
      expect(cuerpo.fragmentos).toBe(cuerpo.documentos.reduce((n: number, d: { fragmentos: unknown[] }) => n + d.fragmentos.length, 0));
      const fragmento = cuerpo.documentos[0].fragmentos[0];
      expect(Object.keys(fragmento).sort()).toEqual(['id', 'seccion', 'texto']);
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
