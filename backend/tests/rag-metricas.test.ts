import { describe, expect, it } from 'vitest';
import { aucRoc, barrer, metricasRecuperacion, umbralesCandidatos, type Medicion } from '../harness/rag/metricas.js';

const pos = (similitud: number, documentos: string[]): Medicion => ({ pregunta: 'p', conRespuesta: true, esperado: 'A', similitud, documentos });
const neg = (similitud: number, tipo: Medicion['tipo'] = 'fuera_de_dominio'): Medicion => ({ pregunta: 'n', conRespuesta: false, tipo, similitud, documentos: [] });

describe('métricas del RAG', () => {
  it('Recall@1, Recall@k y MRR', () => {
    const m = [pos(0.9, ['A', 'B']), pos(0.9, ['B', 'A']), pos(0.9, ['B', 'C', 'D', 'A']), pos(0.9, ['B', 'C'])];
    const r = metricasRecuperacion(m, 4);
    expect(r.recallA1).toBe(0.25);
    expect(r.recallAk).toBe(0.75);
    expect(r.mrr).toBeCloseTo((1 + 1 / 2 + 1 / 4 + 0) / 4);
    expect(r.fallos.map((f) => f.rango)).toEqual([2, 4, null]);
  });

  it('AUC-ROC: 1 si separa perfecto, 0,5 con empates totales', () => {
    expect(aucRoc([pos(0.9, []), pos(0.8, []), neg(0.7), neg(0.6)])).toBe(1);
    expect(aucRoc([pos(0.8, []), neg(0.8)])).toBe(0.5);
    expect(aucRoc([pos(0.7, []), neg(0.8)])).toBe(0);
  });

  it('el barrido cuenta falsos positivos por tipo y elige candidatos', () => {
    const m = [pos(0.9, []), pos(0.85, []), pos(0.8, []), neg(0.86, 'dominio_cercano'), neg(0.82, 'fuera_de_dominio')];
    const c = umbralesCandidatos(barrer(m));
    expect(c.sinFalsosPositivos).toMatchObject({ umbral: 0.9, recall: 1 / 3, falsosPositivos: 0 });
    expect(c.sinFpFueraDeDominio).toMatchObject({ umbral: 0.85, recall: 2 / 3, fpDominioCercano: 1, fpFueraDeDominio: 0 });
  });
});
