import { DatabaseError } from 'pg';
import type pg from 'pg';
import type { DecisionAgendamiento } from '../../dominio/agenda.js';
import type { Agenda, HorarioDelDia, HorarioParaAgendar, ResultadoAgendar } from '../../aplicacion/puertos.js';

const VIOLACION_DE_UNICIDAD = '23505';

/** La agenda sobre PostgreSQL. */
export class AgendaPostgres implements Agenda {
  constructor(private readonly pool: pg.Pool) {}

  /** Usa el índice (sede_id, inicio). */
  async horariosDelDia(especialidadId: number, sedeId: number, desde: Date, hasta: Date): Promise<HorarioDelDia[]> {
    const { rows } = await this.pool.query<{ id: number; inicio: Date; profesional: string; ocupado: boolean }>(
      `SELECT h.id, h.inicio, p.nombre AS profesional,
              EXISTS (SELECT 1 FROM citas c WHERE c.horario_id = h.id AND c.estado = 'activa') AS ocupado
         FROM horarios h JOIN profesionales p ON p.id = h.profesional_id
        WHERE h.sede_id = $1 AND h.inicio >= $2 AND h.inicio < $3 AND p.especialidad_id = $4
        ORDER BY h.inicio, p.nombre`,
      [sedeId, desde, hasta, especialidadId],
    );
    return rows.map((f) => ({ horarioId: f.id, inicio: f.inicio, profesional: f.profesional, ocupado: f.ocupado }));
  }

  async agendar(
    pedido: { horarioId: number; conversacionId: number; nombrePaciente: string },
    decidir: (horario: HorarioParaAgendar | null, citaActiva: { id: number; conversacionId: number } | null) => DecisionAgendamiento,
  ): Promise<ResultadoAgendar> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');
      const horario = await leerHorario(cliente, pedido.horarioId);
      const citaActiva = horario ? await leerCitaActiva(cliente, horario.id) : null;
      const decision = decidir(horario, citaActiva);

      if (decision.tipo === 'error') {
        await cliente.query('ROLLBACK');
        return decision;
      }
      if (decision.tipo === 'ya_es_tuya') {
        await cliente.query('COMMIT');
        return { tipo: 'ya_era_tuya', citaId: decision.citaId, horario: horario! };
      }

      await cliente.query('SAVEPOINT antes_de_insertar');
      try {
        const { rows } = await cliente.query<{ id: number }>(
          'INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3) RETURNING id',
          [pedido.horarioId, pedido.conversacionId, pedido.nombrePaciente],
        );
        await cliente.query('COMMIT');
        return { tipo: 'agendada', citaId: rows[0]!.id, horario: horario! };
      } catch (error) {
        if (!(error instanceof DatabaseError) || error.code !== VIOLACION_DE_UNICIDAD) throw error;
        // Otro paciente ganó la carrera entre la lectura y la inserción.
        await cliente.query('ROLLBACK TO SAVEPOINT antes_de_insertar');
        const ganadora = await leerCitaActiva(cliente, pedido.horarioId);
        await cliente.query('COMMIT');
        if (ganadora?.conversacionId === pedido.conversacionId) {
          return { tipo: 'ya_era_tuya', citaId: ganadora.id, horario: horario! };
        }
        return { tipo: 'error', error: 'horario_ocupado' };
      }
    } catch (error) {
      await cliente.query('ROLLBACK');
      throw error;
    } finally {
      cliente.release();
    }
  }
}

async function leerHorario(cliente: pg.PoolClient, horarioId: number): Promise<HorarioParaAgendar | null> {
  const { rows } = await cliente.query<HorarioParaAgendar>(
    `SELECT h.id, h.inicio, e.nombre AS especialidad, s.nombre AS sede, p.nombre AS profesional
       FROM horarios h
       JOIN profesionales p ON p.id = h.profesional_id
       JOIN especialidades e ON e.id = p.especialidad_id
       JOIN sedes s ON s.id = h.sede_id
      WHERE h.id = $1`,
    [horarioId],
  );
  return rows[0] ?? null;
}

async function leerCitaActiva(cliente: pg.PoolClient, horarioId: number): Promise<{ id: number; conversacionId: number } | null> {
  const { rows } = await cliente.query<{ id: number; conversacion_id: number }>(
    "SELECT id, conversacion_id FROM citas WHERE horario_id = $1 AND estado = 'activa'",
    [horarioId],
  );
  const fila = rows[0];
  return fila ? { id: fila.id, conversacionId: fila.conversacion_id } : null;
}
