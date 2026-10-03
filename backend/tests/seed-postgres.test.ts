import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrar } from '../src/infraestructura/postgres/migrar.js';
import { sembrarAgenda } from '../seed/seed.js';
import { crearPoolDeTest, reiniciarBase } from './ayudas/postgres.js';

describe('migraciones y seed contra PostgreSQL', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = crearPoolDeTest();
    await reiniciarBase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function contar(tabla: string): Promise<number> {
    const { rows } = await pool.query<{ total: string }>(`SELECT count(*) AS total FROM ${tabla}`);
    return Number(rows[0]?.total);
  }

  it('volver a migrar no aplica nada', async () => {
    expect(await migrar(pool)).toEqual([]);
  });

  it('carga 2 sedes, 3 especialidades y la agenda de dos semanas', async () => {
    const resumen = await sembrarAgenda(pool, '2026-10-03');
    expect(resumen.horariosNuevos).toBe(464);
    expect(await contar('sedes')).toBe(2);
    expect(await contar('especialidades')).toBe(3);
    expect(await contar('profesionales')).toBe(6);
  });

  it('es idempotente: correrlo otra vez no duplica nada', async () => {
    const resumen = await sembrarAgenda(pool, '2026-10-03');
    expect(resumen.horariosNuevos).toBe(0);
    expect(await contar('sedes')).toBe(2);
    expect(await contar('profesionales')).toBe(6);
    expect(await contar('horarios')).toBe(464);
  });

  it('correrlo otro día solo agrega los días nuevos', async () => {
    // Desde el lunes 12: se solapa con la semana ya cargada y agrega la del 19.
    const resumen = await sembrarAgenda(pool, '2026-10-12');
    expect(resumen.horariosNuevos).toBe(232);
    expect(await contar('horarios')).toBe(464 + 232);
  });

  it('cada sede tiene al menos una especialidad con horarios en la tarde', async () => {
    const { rows } = await pool.query<{ sede: string }>(`
      SELECT DISTINCT s.nombre AS sede
        FROM horarios h JOIN sedes s ON s.id = h.sede_id
       WHERE extract(hour FROM h.inicio AT TIME ZONE 'America/Bogota') >= 12`);
    expect(rows.map((r) => r.sede).sort()).toEqual(['Sede Norte', 'Sede Sur']);
  });
});
