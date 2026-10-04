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

  /** Marca horarios como ofrecidos a todas las conversaciones existentes, como si consultar_disponibilidad los hubiera mostrado. */
  async function ofrecer(ids: number[]): Promise<void> {
    await pool.query(
      'INSERT INTO horarios_ofrecidos (conversacion_id, horario_id) SELECT c.id, h FROM conversaciones c, unnest($1::int[]) h ON CONFLICT DO NOTHING',
      [ids],
    );
  }

  /** Un horario del seed, ya ofrecido en las conversaciones del test (los tests de agendar no repiten la consulta). */
  async function horarioId(especialidad: string, sede: string, inicioUtc: string): Promise<number> {
    const id = await horarioSinOfrecer(especialidad, sede, inicioUtc);
    await ofrecer([id]);
    return id;
  }

  /** Cómo nombra el modelo un horario al agendar (D-37): especialidad, sede, fecha y hora de Colombia. */
  async function enHora(id: number): Promise<{ especialidad: string; sede: string; fecha: string; hora: string }> {
    const { rows } = await pool.query<{ especialidad: string; sede: string; fecha: string; hora: string }>(
      `SELECT e.nombre AS especialidad, s.nombre AS sede,
              to_char(h.inicio AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS fecha,
              to_char(h.inicio AT TIME ZONE 'America/Bogota', 'HH24:MI') AS hora
         FROM horarios h JOIN profesionales p ON p.id = h.profesional_id
         JOIN especialidades e ON e.id = p.especialidad_id JOIN sedes s ON s.id = h.sede_id
        WHERE h.id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function horarioSinOfrecer(especialidad: string, sede: string, inicioUtc: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT h.id FROM horarios h JOIN profesionales p ON p.id = h.profesional_id
         JOIN especialidades e ON e.id = p.especialidad_id JOIN sedes s ON s.id = h.sede_id
        WHERE e.nombre = $1 AND s.nombre = $2 AND h.inicio = $3`,
      [especialidad, sede, new Date(inicioUtc)],
    );
    return rows[0]!.id;
  }

  describe('consultar_disponibilidad', () => {
    it('devuelve los bloques libres en hora de Colombia, sin horario_id (D-37)', async () => {
      const r = await ejecutar('consultar_disponibilidad', { especialidad: 'Dermatología', sede: 'Sede Sur', fecha: '2026-10-06' });
      expect(r.ok).toBe(true);
      const datos = (r as { datos: { horarios: { inicio: string; profesional: string }[] } }).datos;
      expect(Object.keys(datos.horarios[0]!).sort()).toEqual(['inicio', 'profesional']);
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

  describe('resumir_disponibilidad', () => {
    type Resumen = { desde: string; hasta: string; recortado?: string; sedes: { sede: string; dias: { fecha: string; dia: string; franjas: string[] }[] }[] };
    const datos = (r: ResultadoHerramienta) => (r as { datos: Resumen }).datos;

    it('sin sede resume la semana en franjas por sede y día', async () => {
      const r = await ejecutar('resumir_disponibilidad', { especialidad: 'Dermatología', desde: '2026-10-05', hasta: '2026-10-11' });
      expect(r.ok).toBe(true);
      const { sedes } = datos(r);
      // Norte: Restrepo lunes, miércoles y viernes 14–18. Sur: Restrepo 08–12 y Mora 14–17 martes y jueves.
      expect(sedes.map((s) => s.sede)).toEqual(['Sede Norte', 'Sede Sur']);
      expect(sedes[0]!.dias.map((d) => d.fecha)).toEqual(['2026-10-05', '2026-10-07', '2026-10-09']);
      expect(sedes[1]!.dias[0]).toEqual({ fecha: '2026-10-06', dia: 'martes', franjas: ['08:00-12:00', '14:00-17:00'] });
    });

    it('con sede solo trae esa sede; parte las franjas en lo ocupado y lo que ya empezó', async () => {
      const ocupado = await horarioId('Medicina general', 'Sede Norte', '2026-10-05T15:00:00Z'); // 10:00 en Cali
      await pool.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [ocupado, conversacionB, 'Otra']);
      const r = await ejecutar('resumir_disponibilidad', { especialidad: 'Medicina general', sede: 'norte', desde: '2026-10-05', hasta: '2026-10-06' });
      const { sedes } = datos(r);
      expect(sedes).toHaveLength(1);
      // 07:00–12:00 a las 09:00 del lunes: 09:00 ya empezó y 10:00 está ocupado.
      expect(sedes[0]!.dias).toEqual([
        { fecha: '2026-10-05', dia: 'lunes', franjas: ['09:30-10:00', '10:30-12:00'] },
        { fecha: '2026-10-06', dia: 'martes', franjas: ['07:00-12:00'] },
      ]);
    });

    it('un rango que empieza en el pasado se toma desde hoy, y lo que pasa del fin de la agenda se recorta y lo avisa', async () => {
      // La agenda de los tests va del lunes 5 al viernes 16 de octubre.
      const r = await ejecutar('resumir_disponibilidad', { especialidad: 'Pediatría', desde: '2026-10-01', hasta: '2026-10-31' });
      expect(datos(r)).toMatchObject({ desde: '2026-10-05', hasta: '2026-10-16' });
      expect(datos(r).recortado).toContain('solo hasta el viernes 16 de octubre de 2026');
      expect(datos(r).recortado).toContain('no está llena');
    });

    it.each([
      ['enero de 2027', { desde: '2027-01-01', hasta: '2027-01-07' }],
      ['noviembre', { desde: '2026-11-01', hasta: '2026-11-30' }],
      ['diciembre', { desde: '2026-12-01', hasta: '2026-12-31' }],
    ])('caso real: %s, después del fin de la agenda → fuera_de_agenda, no sin_horarios (D-42)', async (_mes, rango) => {
      const r = await ejecutar('resumir_disponibilidad', { especialidad: 'Dermatología', ...rango });
      expect(r).toMatchObject({ ok: false, error: 'fuera_de_agenda' });
      expect(!r.ok && r.detalle).toContain('2026-10-16');
    });

    it('consultar un día después del fin de la agenda → fuera_de_agenda', async () => {
      const r = await ejecutar('consultar_disponibilidad', { especialidad: 'Dermatología', sede: 'Sede Norte', fecha: '2026-12-02' });
      expect(r).toMatchObject({ ok: false, error: 'fuera_de_agenda' });
      expect(!r.ok && r.detalle).toContain('aún no se ha abierto');
    });

    it.each([
      [{ especialidad: 'Cardiología', desde: '2026-10-05', hasta: '2026-10-09' }, 'especialidad_inexistente'],
      [{ especialidad: 'Pediatría', sede: 'Sede Centro', desde: '2026-10-05', hasta: '2026-10-09' }, 'sede_inexistente'],
      [{ especialidad: 'Pediatría', desde: '2026-09-28', hasta: '2026-10-04' }, 'fecha_pasada'],
      [{ especialidad: 'Pediatría', desde: '2026-10-10', hasta: '2026-10-11' }, 'sin_horarios'], // fin de semana
      [{ especialidad: 'Pediatría', desde: '2026-10-09', hasta: '2026-10-05' }, 'argumentos_invalidos'],
      [{ especialidad: 'Pediatría', desde: 'octubre', hasta: '2026-10-09' }, 'argumentos_invalidos'],
      [{ especialidad: 'Pediatría', desde: '2026-10-05' }, 'argumentos_invalidos'],
      [{ especialidad: 'Pediatría', desde: '2026-10-05', hasta: '2026-10-09', horario_id: 1 }, 'argumentos_invalidos'],
    ])('%j → %s', async (argumentos, esperado) => {
      expect(error(await ejecutar('resumir_disponibilidad', argumentos))).toBe(esperado);
    });
  });

  describe('agendar_cita', () => {
    it('agenda y devuelve los datos de la cita', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-07T13:00:00Z'); // miércoles 08:00
      const r = await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: '  Ana   María Pérez ' });
      expect(r).toMatchObject({
        ok: true,
        datos: { ya_estaba_agendada: false, inicio: '2026-10-07T08:00', especialidad: 'Pediatría', sede: 'Sede Norte', nombre_paciente: 'Ana María Pérez' },
      });
      const { rows } = await pool.query('SELECT conversacion_id, nombre_paciente, estado FROM citas');
      expect(rows).toEqual([{ conversacion_id: conversacionA, nombre_paciente: 'Ana María Pérez', estado: 'activa' }]);
    });

    it('reintento de la misma conversación: éxito con la misma cita, sin duplicar', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-07T13:30:00Z');
      const primera = await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: 'Ana Pérez' });
      const segunda = await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: 'Ana Pérez' });
      expect(segunda).toMatchObject({ ok: true, datos: { ya_estaba_agendada: true } });
      expect((segunda as { datos: { cita_id: number } }).datos.cita_id).toBe((primera as { datos: { cita_id: number } }).datos.cita_id);
      expect((await pool.query('SELECT count(*)::int AS n FROM citas')).rows[0].n).toBe(1);
    });

    it('horario de otra conversación: horario_ocupado', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-07T14:00:00Z');
      await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: 'Ana Pérez' }, { conversacionId: conversacionB });
      expect(error(await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: 'Luis Rojas' }))).toBe('horario_ocupado');
    });

    it('una cita cancelada libera el horario', async () => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-07T14:30:00Z');
      await pool.query("INSERT INTO citas (horario_id, conversacion_id, nombre_paciente, estado) VALUES ($1, $2, 'Otra', 'cancelada')", [id, conversacionB]);
      expect((await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: 'Luis Rojas' })).ok).toBe(true);
    });

    it.each([
      [{ hora: '13:00', fecha: '2026-10-08' }, 'horario_inexistente'], // pediatría Norte el jueves: 08–12 y 14–18
      [{ nombre_paciente: 'Juan 123' }, 'nombre_invalido'],
      [{ nombre_paciente: 'J' }, 'nombre_invalido'],
      [{ especialidad: 'Cardiología' }, 'especialidad_inexistente'],
      [{ sede: 'Sede Centro' }, 'sede_inexistente'],
      [{ hora: '8:00 a. m.' }, 'argumentos_invalidos'],
      [{ hora: '8:00' }, 'argumentos_invalidos'],
      [{ hora: '24:00' }, 'argumentos_invalidos'],
      [{ fecha: '08/10/2026' }, 'argumentos_invalidos'],
      [{ hora: undefined }, 'argumentos_invalidos'],
      [{ horario_id: 12 }, 'argumentos_invalidos'],
      [{ motivo: 'fiebre' }, 'argumentos_invalidos'],
      [{ telefono: '+573001112233' }, 'argumentos_invalidos'],
    ])('%j → %s', async (cambio, esperado) => {
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-08T13:00:00Z'); // jueves 08:00
      const argumentos = { ...(await enHora(id)), nombre_paciente: 'Pedro Gómez', ...cambio };
      expect(error(await ejecutar('agendar_cita', argumentos))).toBe(esperado);
      expect((await pool.query('SELECT count(*)::int AS n FROM citas')).rows[0].n).toBe(0);
    });

    it('la hora va en 24 h: 16:30 es la cita de las 4:30 p. m., no la de las 14:30 (D-37)', async () => {
      await ejecutar('consultar_disponibilidad', { especialidad: 'Dermatología', sede: 'Sede Norte', fecha: '2026-10-07' });
      const r = await ejecutar('agendar_cita', { especialidad: 'dermatologia', sede: 'norte', fecha: '2026-10-07', hora: '16:30', nombre_paciente: 'Steven Fierro' });
      expect(r).toMatchObject({ ok: true, datos: { inicio: '2026-10-07T16:30', profesional: 'Dra. Camila Restrepo' } });
    });

    it('dos profesionales a la misma hora: sin profesional pide elegir; con profesional agenda el suyo', async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO profesionales (nombre, especialidad_id) SELECT 'Dra. Prueba Duplicada', id FROM especialidades WHERE nombre = 'Pediatría' RETURNING id`,
      );
      await pool.query(
        `INSERT INTO horarios (profesional_id, sede_id, inicio, fin)
         SELECT $1, id, '2026-10-08T13:00:00Z', '2026-10-08T13:30:00Z' FROM sedes WHERE nombre = 'Sede Norte'`,
        [rows[0]!.id],
      );
      try {
        const ospina = await horarioId('Pediatría', 'Sede Norte', '2026-10-08T13:00:00Z'); // también la ofrece
        const otra = (await pool.query<{ id: number }>('SELECT id FROM horarios WHERE profesional_id = $1', [rows[0]!.id])).rows[0]!.id;
        await ofrecer([otra]);
        const argumentos = { ...(await enHora(ospina)), nombre_paciente: 'Pedro Gómez' };
        const sinElegir = await ejecutar('agendar_cita', argumentos);
        expect(sinElegir).toMatchObject({ ok: false, error: 'argumentos_invalidos' });
        expect(!sinElegir.ok && sinElegir.detalle).toContain('Dra. Natalia Ospina');
        const conElegido = await ejecutar('agendar_cita', { ...argumentos, profesional: 'Ospina' });
        expect(conElegido).toMatchObject({ ok: true, datos: { profesional: 'Dra. Natalia Ospina' } });
      } finally {
        await pool.query('DELETE FROM horarios WHERE profesional_id = $1', [rows[0]!.id]);
        await pool.query('DELETE FROM profesionales WHERE id = $1', [rows[0]!.id]);
      }
    });

    it('un horario libre que no se ofreció en esta conversación: horario_no_ofrecido y ninguna cita (D-34)', async () => {
      const id = await horarioSinOfrecer('Medicina general', 'Sede Norte', '2026-10-05T13:00:00Z'); // lunes 08:00, libre
      const r = await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: 'Steven Fierro' });
      expect(r).toMatchObject({ ok: false, error: 'horario_no_ofrecido' });
      expect(!r.ok && r.detalle).toContain('consultar_disponibilidad');
      expect((await pool.query('SELECT count(*)::int AS n FROM citas')).rows[0].n).toBe(0);
    });

    it('lo ofrecido a otra conversación no cuenta', async () => {
      const id = await horarioSinOfrecer('Medicina general', 'Sede Norte', '2026-10-05T13:30:00Z');
      await pool.query('INSERT INTO horarios_ofrecidos (conversacion_id, horario_id) VALUES ($1, $2)', [conversacionB, id]);
      expect(error(await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: 'Steven Fierro' }))).toBe('horario_no_ofrecido');
    });

    it('consultar_disponibilidad registra lo que muestra: después se agenda sin más', async () => {
      const consulta = await ejecutar('consultar_disponibilidad', { especialidad: 'Dermatología', sede: 'Sede Norte', fecha: '2026-10-07' });
      const horarios = (consulta as { datos: { horarios: { inicio: string; profesional: string }[] } }).datos.horarios;
      expect(horarios).toContainEqual({ inicio: '2026-10-07T15:00', profesional: 'Dra. Camila Restrepo' });
      const r = await ejecutar('agendar_cita', { especialidad: 'Dermatología', sede: 'Sede Norte', fecha: '2026-10-07', hora: '15:00', nombre_paciente: 'Steven Fierro' });
      expect(r).toMatchObject({ ok: true, datos: { inicio: '2026-10-07T15:00', especialidad: 'Dermatología', sede: 'Sede Norte' } });
    });

    it('los horarios ofrecidos vigentes: sin los ocupados ni los que ya empezaron, en orden de inicio (D-35)', async () => {
      const repositorio = new RepositorioMensajesPostgres(pool);
      await ejecutar('consultar_disponibilidad', { especialidad: 'Medicina general', sede: 'Sede Norte', fecha: '2026-10-05' });
      const tomado = await horarioSinOfrecer('Medicina general', 'Sede Norte', '2026-10-05T15:00:00Z'); // 10:00
      await pool.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [tomado, conversacionB, 'Otra']);
      // A las 10:30 en Cali: ya empezaron 9:30 y 10:00; 10:00 además está tomado.
      const vigentes = await repositorio.horariosOfrecidosVigentes(conversacionA, new Date('2026-10-05T15:30:00Z'), 20);
      expect(vigentes.map((h) => h.inicio.toISOString())).toEqual(['2026-10-05T16:00:00.000Z', '2026-10-05T16:30:00.000Z']);
      expect(vigentes[0]).toMatchObject({ especialidad: 'Medicina general', sede: 'Sede Norte', profesional: 'Dra. Laura Gómez' });
      expect(await repositorio.horariosOfrecidosVigentes(conversacionB, new Date('2026-10-05T15:30:00Z'), 20)).toEqual([]);
    });

    it('horario que ya empezó: horario_pasado', async () => {
      const id = await horarioId('Medicina general', 'Sede Norte', '2026-10-05T12:00:00Z'); // lunes 07:00
      expect(error(await ejecutar('agendar_cita', { ...(await enHora(id)), nombre_paciente: 'Pedro Gómez' }))).toBe('horario_pasado');
    });

    it('carrera entre la lectura y la inserción: el índice único la detecta y devuelve horario_ocupado', async () => {
      // Otra transacción inserta la cita y NO confirma: la lectura previa de la
      // herramienta no la ve, decide agendar y su INSERT queda bloqueado en el
      // índice único parcial hasta que la otra confirma; entonces recibe 23505.
      const id = await horarioId('Pediatría', 'Sede Norte', '2026-10-09T13:00:00Z');
      const enEsaHora = await enHora(id);
      const rival = await pool.connect();
      try {
        await rival.query('BEGIN');
        await rival.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [id, conversacionB, 'Rival']);
        const pendiente = ejecutar('agendar_cita', { ...enEsaHora, nombre_paciente: 'Pedro Gómez' });
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
      const enEsaHora = await enHora(id);
      const rival = await pool.connect();
      try {
        await rival.query('BEGIN');
        await rival.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [id, conversacionB, 'Rival']);
        const pendiente = ejecutar('agendar_cita', { ...enEsaHora, nombre_paciente: 'Pedro Gómez' });
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
      await ofrecer(ids);
      for (const id of ids) {
        const enEsaHora = await enHora(id);
        const resultados = await Promise.all([
          ejecutar('agendar_cita', { ...enEsaHora, nombre_paciente: 'Paciente Uno' }, { conversacionId: conversacionA }),
          ejecutar('agendar_cita', { ...enEsaHora, nombre_paciente: 'Paciente Dos' }, { conversacionId: conversacionB }),
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
      const enEsaHora = await enHora(await horarioId('Dermatología', 'Sede Norte', '2026-10-07T20:00:00Z'));
      const resultados = await Promise.all(
        rows.map((c) => ejecutar('agendar_cita', { ...enEsaHora, nombre_paciente: 'Paciente Carrera' }, { conversacionId: c.id })),
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
        required: ['especialidad', 'sede', 'fecha', 'hora', 'nombre_paciente'],
      });
      expect(Object.keys(agendar['properties'] as object)).not.toContain('telefono');
      expect(Object.keys(agendar['properties'] as object)).not.toContain('horario_id');
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
