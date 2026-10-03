// Barandilla contra datos inventados (D-26).
//
// Un dato verificable de la respuesta (número, hora, precio, teléfono, dirección,
// fecha) tiene que aparecer en la evidencia del turno: resultados de herramientas,
// mensajes de la conversación o prompt de sistema. Se compara por números, con las
// equivalencias que el modelo usa al redactar: 14:00 → 2, "06" → 6, "tres" → 3.

const NUMEROS_EN_PALABRAS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, cien: 100, mediodia: 12,
};

/** Separa los números de un texto: "Calle 16 # 100-25" → 16, 100, 25. Los puntos de miles se unen: 1.500 → 1500. */
function numerosDe(texto: string): string[] {
  const sinMiles = texto.replace(/(\d)\.(?=\d{3}\b)/g, '$1');
  return (sinMiles.match(/\d+/g) ?? []).map((n) => String(Number(n)));
}

/** Todos los números que la evidencia respalda, con sus equivalencias. */
export function numerosRespaldados(evidencias: readonly string[]): Set<string> {
  const respaldados = new Set<string>();
  for (const texto of evidencias) {
    for (const n of numerosDe(texto)) respaldados.add(n);
    // Horas de 24 h: 14:00 también respalda "2" (2:00 p. m.).
    // Sin \b: en "2026-10-06T14:00" la T pegada a la hora no deja límite de palabra.
    for (const [, hora] of texto.matchAll(/(?<!\d)([01]?\d|2[0-3]):[0-5]\d(?!\d)/g)) {
      const h = Number(hora);
      if (h > 12) respaldados.add(String(h - 12));
      if (h === 0) respaldados.add('12');
    }
    const palabras = texto.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().match(/\p{L}+/gu) ?? [];
    for (const p of palabras) {
      const valor = NUMEROS_EN_PALABRAS[p];
      if (valor !== undefined) respaldados.add(String(valor));
    }
  }
  return respaldados;
}

/**
 * Los datos de la respuesta que no aparecen en la evidencia. Lista vacía = la
 * respuesta solo usa datos respaldados. Devuelve el fragmento de la respuesta
 * que contiene cada número sin respaldo, para mostrárselo al modelo.
 */
export function datosSinRespaldo(respuesta: string, evidencias: readonly string[]): string[] {
  const respaldados = numerosRespaldados(evidencias);
  const sinRespaldo: string[] = [];
  const sinMiles = respuesta.replace(/(\d)\.(?=\d{3}\b)/g, '$1');
  // Un "dato" es una secuencia de dígitos con lo que la acompaña: $, separadores de teléfono, ":".
  for (const m of sinMiles.matchAll(/[$]?\s?\d[\d\s:.,#-]*\d|[$]?\d/g)) {
    const numeros = numerosDe(m[0]);
    if (numeros.some((n) => !respaldados.has(n))) sinRespaldo.push(m[0].trim());
  }
  return [...new Set(sinRespaldo)];
}
