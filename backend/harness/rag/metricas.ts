// Métricas del goldset de RAG. Funciones puras: se prueban sin modelo ni base.

export interface Medicion {
  pregunta: string;
  conRespuesta: boolean;
  /** Documento esperado (solo con respuesta). */
  esperado?: string;
  tipo?: 'dominio_cercano' | 'fuera_de_dominio';
  /** Similitud del mejor fragmento. */
  similitud: number;
  /** Documento de cada fragmento recuperado, en orden. */
  documentos: string[];
}

export interface Recuperacion {
  recallA1: number;
  recallAk: number;
  mrr: number;
  fallos: (Medicion & { rango: number | null })[];
}

/** Rango (1-based) del primer fragmento del documento esperado, o null si no está en los k. */
export function rango(m: Medicion): number | null {
  const i = m.documentos.findIndex((d) => d === m.esperado);
  return i === -1 ? null : i + 1;
}

export function metricasRecuperacion(mediciones: readonly Medicion[], k: number): Recuperacion {
  const positivas = mediciones.filter((m) => m.conRespuesta);
  if (positivas.length === 0) throw new Error('El goldset no tiene preguntas con respuesta');
  const rangos = positivas.map((m) => ({ ...m, rango: rango(m) }));
  return {
    recallA1: rangos.filter((r) => r.rango === 1).length / positivas.length,
    recallAk: rangos.filter((r) => r.rango !== null && r.rango <= k).length / positivas.length,
    mrr: rangos.reduce((s, r) => s + (r.rango ? 1 / r.rango : 0), 0) / positivas.length,
    fallos: rangos.filter((r) => r.rango !== 1),
  };
}

/**
 * AUC-ROC de la similitud como clasificador "tiene respuesta": la probabilidad de
 * que una pregunta con respuesta puntúe más alto que una sin respuesta (empates 0,5).
 */
export function aucRoc(mediciones: readonly Medicion[]): number {
  const pos = mediciones.filter((m) => m.conRespuesta).map((m) => m.similitud);
  const neg = mediciones.filter((m) => !m.conRespuesta).map((m) => m.similitud);
  if (pos.length === 0 || neg.length === 0) throw new Error('AUC necesita preguntas con y sin respuesta');
  let suma = 0;
  for (const p of pos) for (const n of neg) suma += p > n ? 1 : p === n ? 0.5 : 0;
  return suma / (pos.length * neg.length);
}

export interface PuntoUmbral {
  umbral: number;
  recall: number;
  tasaFalsosPositivos: number;
  falsosPositivos: number;
  fpDominioCercano: number;
  fpFueraDeDominio: number;
  negativos: number;
  precision: number;
  f1: number;
}

/** Evalúa cada similitud observada como umbral (similitud ≥ umbral → pasa). */
export function barrer(mediciones: readonly Medicion[]): PuntoUmbral[] {
  const pos = mediciones.filter((m) => m.conRespuesta);
  const neg = mediciones.filter((m) => !m.conRespuesta);
  const umbrales = [...new Set(mediciones.map((m) => m.similitud))].sort((a, b) => a - b);
  return umbrales.map((umbral) => {
    const vp = pos.filter((m) => m.similitud >= umbral).length;
    const fps = neg.filter((m) => m.similitud >= umbral);
    const recall = vp / pos.length;
    const precision = vp + fps.length === 0 ? 1 : vp / (vp + fps.length);
    return {
      umbral,
      recall,
      tasaFalsosPositivos: fps.length / neg.length,
      falsosPositivos: fps.length,
      fpDominioCercano: fps.filter((m) => m.tipo === 'dominio_cercano').length,
      fpFueraDeDominio: fps.filter((m) => m.tipo === 'fuera_de_dominio').length,
      negativos: neg.length,
      precision,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    };
  });
}

export function umbralesCandidatos(barrido: readonly PuntoUmbral[]) {
  const mejor = (lista: readonly PuntoUmbral[], valor: (p: PuntoUmbral) => number) =>
    [...lista].sort((a, b) => valor(b) - valor(a) || b.umbral - a.umbral)[0] ?? null;
  return {
    sinFalsosPositivos: mejor(barrido.filter((p) => p.falsosPositivos === 0), (p) => p.recall),
    sinFpFueraDeDominio: mejor(barrido.filter((p) => p.fpFueraDeDominio === 0), (p) => p.recall),
    maximoF1: mejor(barrido, (p) => p.f1),
    youden: mejor(barrido, (p) => p.recall - p.tasaFalsosPositivos),
  };
}
