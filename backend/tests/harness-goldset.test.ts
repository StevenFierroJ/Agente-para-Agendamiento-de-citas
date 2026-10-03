import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { NOMBRES_HERRAMIENTAS } from '../src/dominio/errores.js';
import { SITUACIONES } from '../harness/excepciones.js';
import { SEED_DESDE_HARNESS, cargarCasos } from '../harness/gold/cargar.js';
import type { CasoGold } from '../harness/gold/esquema.js';
import { PROFESIONALES, ZONA_COLOMBIA, generarBloques } from '../seed/agenda.js';

// El goldset se valida sin bases ni LLM: es un test de los datos del harness.
describe('goldset del harness', () => {
  let casos: CasoGold[];
  beforeAll(async () => {
    casos = await cargarCasos();
  });

  it('todos los casos cumplen el esquema y tienen id único', () => {
    expect(casos.length).toBeGreaterThan(0);
    expect(new Set(casos.map((c) => c.id)).size).toBe(casos.length);
  });

  it('cada situación del catálogo tiene al menos un caso', () => {
    const cubiertas = new Set(casos.flatMap((c) => c.cubre));
    const sinCaso = SITUACIONES.filter((s) => !cubiertas.has(s));
    expect(sinCaso, `Situaciones sin caso: ${sinCaso.join(', ')}`).toEqual([]);
  });

  it('un error esperado en un turno está declarado en `cubre`', () => {
    for (const caso of casos) {
      const esperados = caso.envios.flatMap((e) => e.espera?.herramientas ?? []).flatMap((h) => (h.error ? [h.error] : []));
      for (const error of esperados) {
        expect(caso.cubre, `${caso.id} espera ${error} pero no lo declara`).toContain(error);
      }
    }
  });

  it('solo los casos de herramienta_desconocida piden herramientas que no existen', () => {
    const conocidas = new Set<string>(NOMBRES_HERRAMIENTAS);
    for (const caso of casos) {
      const pedidas = caso.envios.flatMap((e) => e.guion ?? []).flatMap((p) => (p.tipo === 'herramientas' ? p.llamadas : []));
      const desconocidas = pedidas.filter((l) => !conocidas.has(l.nombre));
      if (desconocidas.length) expect(caso.cubre, caso.id).toContain('herramienta_desconocida');
    }
  });

  it('cada referencia $horario apunta a un bloque que el seed del harness genera', () => {
    const especialidadDe = new Map(PROFESIONALES.map((p) => [p.nombre, p.especialidad]));
    const existentes = new Set(
      generarBloques(PROFESIONALES, DateTime.fromISO(SEED_DESDE_HARNESS, { zone: ZONA_COLOMBIA })).map(
        (b) =>
          `${especialidadDe.get(b.profesional)}|${b.sede}|${DateTime.fromJSDate(b.inicio, { zone: ZONA_COLOMBIA }).toFormat("yyyy-MM-dd'T'HH:mm")}`,
      ),
    );
    for (const caso of casos) {
      const referencias = [
        ...caso.preparacion.citas.map((c) => c.horario),
        ...buscarReferencias(caso.envios.flatMap((e) => e.guion ?? [])),
      ];
      for (const r of referencias) {
        expect(existentes, `${caso.id}: no hay bloque ${r.especialidad} / ${r.sede} / ${r.inicio}`).toContain(
          `${r.especialidad}|${r.sede}|${r.inicio}`,
        );
      }
    }
  });
});

interface Referencia { especialidad: string; sede: string; inicio: string }

function buscarReferencias(valor: unknown): Referencia[] {
  if (Array.isArray(valor)) return valor.flatMap(buscarReferencias);
  if (valor === null || typeof valor !== 'object') return [];
  const objeto = valor as Record<string, unknown>;
  if ('$horario' in objeto) return [objeto['$horario'] as Referencia];
  return Object.values(objeto).flatMap(buscarReferencias);
}
