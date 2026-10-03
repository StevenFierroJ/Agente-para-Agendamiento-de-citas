import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearHerramientas } from '../src/aplicacion/herramientas/registro.js';
import type { ContextoHerramienta, Herramienta, ResultadoHerramienta } from '../src/aplicacion/puertos.js';
import { ahoraDelMensaje } from '../src/dominio/fechas.js';
import { EmbeddingFalso } from '../src/infraestructura/embeddings/falso.js';
import { AgendaPostgres } from '../src/infraestructura/postgres/agenda.js';
import { ConocimientoPostgres } from '../src/infraestructura/postgres/conocimiento.js';
import { sembrarDocumentos } from '../seed/documentos.js';
import { RepositorioMensajesPostgres } from '../src/infraestructura/postgres/mensajes.js';
import { urlPostgresDeTest } from './ayudas/postgres.js';
import { prepararBasesDeTest } from './ayudas/sistema.js';

// Agenda del lunes 5 de octubre de 2026. "Ahora" = lunes 09:00 en Cali, salvo indicación.
const LUNES_9AM = ahoraDelMensaje(new Date('2026-10-05T14:00:00Z'));

describe('herramientas', () => {
  let pool: pg.Pool;
  let herramientas: Map<string, Herramienta>;
  let conversacionA: number;
  let conversacionB: number;

  beforeAll(async () => {
    await prepararBasesDeTest();
    pool = new pg.Pool({ connectionString: urlPostgresDeTest(), max: 30 });
    await sembrarDocumentos(pool, new EmbeddingFalso());
    herramientas = crearHerramientas({
      agenda: new AgendaPostgres(pool),
      catalogo: new RepositorioMensajesPostgres(pool),
      conocimiento: { embeddings: new EmbeddingFalso(), base: new ConocimientoPostgres(pool), umbral: 0.25 },
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE citas, mensajes_entrantes, conversaciones RESTART IDENTITY CASCADE');
    const { rows } = await pool.query<{ id: number }>(
      "INSERT INTO conversaciones (telefono, ultimo_mensaje_en) VALUES ('+573000000001', now()), ('+573000000002', now()) RETURNING id",
    );
    [conversacionA, conversacionB] = rows.map((r) => r.id) as [number, number];
  });

  const ejecutar = (nombre: string, argumentos: unknown, contexto: Partial<ContextoHerramienta> = {}): Promise<ResultadoHerramienta> =>
    herramientas.get(nombre)!.ejecutar(argumentos, { conversacionId: conversacionA, ahora: LUNES_9AM, ...contexto });

  function error(resultado: ResultadoHerramienta): string | null {
    return resultado.ok ? null : resultado.error;
  }

  async function horarioId(especialidad: string, sede: string, inicioUtc: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT h.id FROM horarios h JOIN profesionales p ON p.id = h.profesional_id
         JOIN especialidades e ON e.id = p.especialidad_id JOIN sedes s ON s.id = h.sede_id
        WHERE e.nombre = $1 AND s.nombre = $2 AND h.inicio = $3`,
      [especialidad, sede, new Date(inicioUtc)],
    );
    return rows[0]!.id;
  }

  describe('consultar_disponibilidad', () => {
    it('devuelve los bloques libres en hora de Colombia, con su horario_id', async () => {
      const r = await ejecutar('consultar_disponibilidad', { especialidad: 'Dermatología', sede: 'Sede Sur', fecha: '2026-10-06' });
      expect(r.ok).toBe(true);
      const datos = (r as { datos: { horarios: { horario_id: number; inicio: string; profesional: string }[] } }).datos;
      // Martes: Restrepo 08–12 (8 bloques) y Mora 14–17 (6 bloques) en la Sede Sur.
      expect(datos.horarios).toHaveLength(14);
      expect(datos.horarios[0]).toMatchObject({ inicio: '2026-10-06T08:00', profesional: 'Dra. Camila Restrepo' });
      expect(datos.horarios.at(-1)).toMatchObject({ inicio: '2026-10-06T16:30', profesional: 'Dr. Julián Mora' });
    });

    it('acepta mayúsculas, sin tildes y la sede sin la palabra "sede"', async () => {
      const r = await ejecutar('consultar_disponibilidad', { especialidad: 'DERMATOLOGIA', sede: 'sur', fecha: '2026-10-06' });
      expect(r.ok).toBe(true);
    });

    it('quita los horarios ocupados y los que ya empezaron', async () => {
      const ocupado = await horarioId('Medicina general', 'Sede Norte', '2026-10-05T15:00:00Z'); // 10:00 en Cali
      await pool.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [ocupado, conversacionB, 'Otra']);
      const r = await ejecutar('consultar_disponibilidad', { especialidad: 'Medicina general', sede: 'Sede Norte', fecha: '2026-10-05' });
      const inicios = (r as { datos: { horarios: { inicio: string }[] } }).datos.horarios.map((h) => h.inicio);
      // 07:00–12:00; a las 09:00 ya empezaron 07:00 a 09:00; 10:00 está ocupado.
      expect(inicios).toEqual(['2026-10-05T09:30', '2026-10-05T10:30', '2026-10-05T11:00', '2026-10-05T11:30']);
    });

    it.each([
      [{ especialidad: 'Cardiología', sede: 'Sede Sur', fecha: '2026-10-06' }, 'especialidad_inexistente'],
      [{ especialidad: 'Pediatría', sede: 'Sede Centro', fecha: '2026-10-06' }, 'sede_inexistente'],
      [{ especialidad: 'Pediatría', sede: 'Sede Norte', fecha: '2026-10-04' }, 'fecha_pasada'],
      [{ especialidad: 'Dermatología', sede: 'Sede Norte', fecha: '2026-10-06' }, 'sin_horarios'],
      [{ especialidad: 'Pediatría', sede: 'Sede Norte', fecha: '2026-10-10' }, 'sin_horarios'], // sábado
      [{ especialidad: 'Pediatría', sede: 'Sede Norte', fecha: '07/10/2026' }, 'argumentos_invalidos'],
      [{ especialidad: 'Pediatría', sede: 'Sede Norte', fecha: '2026-02-30' }, 'argumentos_invalidos'],
      [{ especialidad: 'Pediatría', sede: 'Sede Norte' }, 'argumentos_invalidos'],
      [{ especialidad: 'Pediatría', sede: 'Sede Norte', fecha: '2026-10-07', telefono: '+57300' }, 'argumentos_invalidos'],
      ['Pediatría', 'argumentos_invalidos'],
    ])('%j → %s', async (argumentos, esperado) => {
      expect(error(await ejecutar('consultar_disponibilidad', argumentos))).toBe(esperado);
    });

    it('a las 22:40 del 5 en Cali, el 5 es hoy (sin horarios) y no fecha pasada', async () => {
      const noche = ahoraDelMensaje(new Date('2026-10-06T03:40:00Z'));
      const argumentos = { especialidad: 'Medicina general', sede: 'Sede Norte', fecha: '2026-10-05' };
      expect(error(await ejecutar('consultar_disponibilidad', argumentos, { ahora: noche }))).toBe('sin_horarios');
    });

    it('el error de especialidad lista las válidas para que el modelo corrija', async () => {
      const r = await ejecutar('consultar_disponibilidad', { especialidad: 'derma', sede: 'Sede Sur', fecha: '2026-10-06' });
      expect(r).toMatchObject({ ok: false, error: 'especialidad_inexistente' });
      expect(!r.ok && r.detalle).toContain('Dermatología');
    });
  });

  describe('agendar_cita', () => {
    it('agenda y devuelve los datos de la cita', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-07T13:00:00Z'); // miércoles 08:00
      const r = await ejecutar('agendar_cita', { horario_id: id, nombre_paciente: '  Ana   María Pérez ' });
      expect(r).toMatchObject({
        ok: true,
        datos: { ya_estaba_agendada: false, inicio: '2026-10-07T08:00', especialidad: 'Pediatría', sede: 'Sede Norte', nombre_paciente: 'Ana María Pérez' },
      });
      const { rows } = await pool.query('SELECT conversacion_id, nombre_paciente, estado FROM citas');
      expect(rows).toEqual([{ conversacion_id: conversacionA, nombre_paciente: 'Ana María Pérez', estado: 'activa' }]);
    });

    it('reintento de la misma conversación: éxito con la misma cita, sin duplicar', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-07T13:30:00Z');
      const primera = await ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Ana Pérez' });
      const segunda = await ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Ana Pérez' });
      expect(segunda).toMatchObject({ ok: true, datos: { ya_estaba_agendada: true } });
      expect((segunda as { datos: { cita_id: number } }).datos.cita_id).toBe((primera as { datos: { cita_id: number } }).datos.cita_id);
      expect((await pool.query('SELECT count(*)::int AS n FROM citas')).rows[0].n).toBe(1);
    });

    it('horario de otra conversación: horario_ocupado', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-07T14:00:00Z');
      await ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Ana Pérez' }, { conversacionId: conversacionB });
      expect(error(await ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Luis Rojas' }))).toBe('horario_ocupado');
    });

    it('una cita cancelada libera el horario', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-07T14:30:00Z');
      await pool.query("INSERT INTO citas (horario_id, conversacion_id, nombre_paciente, estado) VALUES ($1, $2, 'Otra', 'cancelada')", [id, conversacionB]);
      expect((await ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Luis Rojas' })).ok).toBe(true);
    });

    it.each([
      [{ horario_id: 999999, nombre_paciente: 'Pedro Gómez' }, 'horario_inexistente'],
      [{ horario_id: 'PLACEHOLDER', nombre_paciente: 'Juan 123' }, 'nombre_invalido'],
      [{ horario_id: 'PLACEHOLDER', nombre_paciente: 'J' }, 'nombre_invalido'],
      [{ horario_id: '12', nombre_paciente: 'Pedro Gómez' }, 'argumentos_invalidos'],
      [{ horario_id: 1.5, nombre_paciente: 'Pedro Gómez' }, 'argumentos_invalidos'],
      [{ horario_id: 'PLACEHOLDER', nombre_paciente: 'Pedro Gómez', motivo: 'fiebre' }, 'argumentos_invalidos'],
      [{ horario_id: 'PLACEHOLDER', nombre_paciente: 'Pedro Gómez', telefono: '+573001112233' }, 'argumentos_invalidos'],
    ])('%j → %s', async (argumentos, esperado) => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-08T13:00:00Z');
      const conId = argumentos.horario_id === 'PLACEHOLDER' ? { ...argumentos, horario_id: id } : argumentos;
      expect(error(await ejecutar('agendar_cita', conId))).toBe(esperado);
      expect((await pool.query('SELECT count(*)::int AS n FROM citas')).rows[0].n).toBe(0);
    });

    it('horario que ya empezó: horario_pasado', async () => {
      const id = await horarioId('Medicina general', 'Sede Norte', '2026-10-05T12:00:00Z'); // lunes 07:00
      expect(error(await ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Pedro Gómez' }))).toBe('horario_pasado');
    });

    it('carrera entre la lectura y la inserción: el índice único la detecta y devuelve horario_ocupado', async () => {
      // Otra transacción inserta la cita y NO confirma: la lectura previa de la
      // herramienta no la ve, decide agendar y su INSERT queda bloqueado en el
      // índice único parcial hasta que la otra confirma; entonces recibe 23505.
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-09T13:00:00Z');
      const rival = await pool.connect();
      try {
        await rival.query('BEGIN');
        await rival.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [id, conversacionB, 'Rival']);
        const pendiente = ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Pedro Gómez' });
        await esperarBloqueo(pool);
        await rival.query('COMMIT');
        expect(error(await pendiente)).toBe('horario_ocupado');
      } finally {
        rival.release();
      }
      const { rows } = await pool.query("SELECT conversacion_id FROM citas WHERE estado = 'activa'");
      expect(rows).toEqual([{ conversacion_id: conversacionB }]);
    });

    it('si la otra transacción se revierte, la cita es de quien esperaba', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-09T13:30:00Z');
      const rival = await pool.connect();
      try {
        await rival.query('BEGIN');
        await rival.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [id, conversacionB, 'Rival']);
        const pendiente = ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Pedro Gómez' });
        await esperarBloqueo(pool);
        await rival.query('ROLLBACK');
        expect((await pendiente).ok).toBe(true);
      } finally {
        rival.release();
      }
    });

    it('dos conversaciones piden el mismo horario a la vez: una gana, la otra recibe horario_ocupado (×25)', async () => {
      const ids = (
        await pool.query<{ id: number }>(
          `SELECT h.id FROM horarios h JOIN profesionales p ON p.id = h.profesional_id
            WHERE p.nombre = 'Dr. Andrés Ruiz' AND h.inicio > '2026-10-06' ORDER BY h.inicio LIMIT 25`,
        )
      ).rows.map((r) => r.id);
      for (const id of ids) {
        const resultados = await Promise.all([
          ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Paciente Uno' }, { conversacionId: conversacionA }),
          ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Paciente Dos' }, { conversacionId: conversacionB }),
        ]);
        expect(resultados.filter((r) => r.ok)).toHaveLength(1);
        expect(resultados.map(error).filter(Boolean)).toEqual(['horario_ocupado']);
      }
      const { rows } = await pool.query(
        "SELECT horario_id, count(*)::int AS n FROM citas WHERE estado = 'activa' GROUP BY horario_id HAVING count(*) > 1",
      );
      expect(rows).toEqual([]);
      expect((await pool.query("SELECT count(*)::int AS n FROM citas WHERE estado = 'activa'")).rows[0].n).toBe(25);
    });

    it('diez conversaciones contra el mismo horario: exactamente una cita', async () => {
      const telefonos = Array.from({ length: 10 }, (_, i) => `+5730100000${String(i).padStart(2, '0')}`);
      const { rows } = await pool.query<{ id: number }>(
        'INSERT INTO conversaciones (telefono, ultimo_mensaje_en) SELECT unnest($1::text[]), now() RETURNING id',
        [telefonos],
      );
      const id = await horarioId('Dermatología', 'Sede Norte', '2026-10-07T20:00:00Z');
      const resultados = await Promise.all(
        rows.map((c) => ejecutar('agendar_cita', { horario_id: id, nombre_paciente: 'Paciente Carrera' }, { conversacionId: c.id })),
      );
      expect(resultados.filter((r) => r.ok)).toHaveLength(1);
      expect(resultados.filter((r) => error(r) === 'horario_ocupado')).toHaveLength(9);
    });
  });

  describe('buscar_conocimiento (embeddings falsos: bolsa de palabras)', () => {
    it('devuelve los fragmentos que superan el umbral, con documento y sección', async () => {
      const r = await ejecutar('buscar_conocimiento', { pregunta: '¿Cuál es el horario de atención de la Sede Norte?' });
      expect(r.ok).toBe(true);
      const fragmentos = (r as { datos: { fragmentos: { documento: string; seccion: string; similitud: number }[] } }).datos.fragmentos;
      expect(fragmentos[0]).toMatchObject({ documento: 'Horarios de atención', seccion: 'Sede Norte' });
      expect(fragmentos.length).toBeLessThanOrEqual(4);
      expect(fragmentos.every((f) => f.similitud >= 0.25)).toBe(true);
    });

    it('sin fragmentos sobre el umbral: sin_resultados, sin texto del que inventar', async () => {
      const r = await ejecutar('buscar_conocimiento', { pregunta: 'zzz qqq xyzw' });
      expect(r).toMatchObject({ ok: false, error: 'sin_resultados' });
    });

    it.each([[{ pregunta: 'ok' }], [{}], [{ pregunta: 'horarios', k: 10 }]])('rechaza %j', async (argumentos) => {
      expect(error(await ejecutar('buscar_conocimiento', argumentos))).toBe('argumentos_invalidos');
    });
  });

  describe('escalar_a_humano', () => {
    it('acepta un motivo de la lista cerrada', async () => {
      expect(await ejecutar('escalar_a_humano', { motivo: 'solicitud_del_paciente' })).toEqual({
        ok: true, datos: { escalada: true, motivo: 'solicitud_del_paciente' },
      });
    });
    it.each([[{ motivo: 'porque sí' }], [{}], [{ motivo: 'sin_informacion', nota: 'x' }]])('rechaza %j', async (argumentos) => {
      expect(error(await ejecutar('escalar_a_humano', argumentos))).toBe('argumentos_invalidos');
    });
  });

  describe('definiciones para el modelo', () => {
    it('salen del mismo esquema que valida: estrictas y con los campos requeridos', () => {
      const agendar = herramientas.get('agendar_cita')!.definicion.parametros;
      expect(agendar).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['horario_id', 'nombre_paciente'],
      });
      expect(Object.keys(agendar['properties'] as object)).not.toContain('telefono');
      expect(herramientas.get('escalar_a_humano')!.definicion.parametros).toMatchObject({
        properties: { motivo: { enum: ['sin_informacion', 'solicitud_del_paciente', 'fuera_de_alcance', 'error_tecnico'] } },
      });
    });
  });
});

/** Espera a que alguna sesión quede bloqueada esperando un lock (el INSERT contra el índice único). */
async function esperarBloqueo(pool: pg.Pool): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'");
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Ninguna sesión quedó esperando el lock');
}
