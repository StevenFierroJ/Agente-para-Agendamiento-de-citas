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
export function datosSinRespaldo(respuesta: string, evidencias: readonly string[], evidenciasDeHoras: readonly string[] = evidencias): string[] {
  const numeros = numerosSinRespaldo(respuesta, evidencias);
  // La comparación por números sueltos deja pasar una hora armada con números que
  // sí están, pero en otro lado ("6:30 p. m." con un 6 de una fecha y un 30 de otra
  // hora). Las horas se verifican además como horas (D-38).
  const horas = horasSinRespaldo(respuesta, evidenciasDeHoras).filter((h) => !numeros.some((n) => h.includes(n) || n.includes(h)));
  return [...numeros, ...horas];
}

function numerosSinRespaldo(respuesta: string, evidencias: readonly string[]): string[] {
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

// ---------------------------------------------------------------------------
// Horas (D-38)

/** "2:00 p. m.", "8 a. m.", "12:00 m.", "2:00pm": hora con su meridiano. */
const HORA_12 = /(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s*(?:([ap])\.?\s?m\b\.?|(m)\.(?!\p{L}))/giu;
/** "14:30", "08:00", "2026-10-07T14:30": hora sin meridiano. */
const HORA_24 = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g;

interface HoraEncontrada {
  texto: string;
  inicio: number;
  fin: number;
  /** Minutos desde la medianoche que puede significar: dos si no dice a. m. ni p. m. (2:00 → 02:00 o 14:00). */
  minutos: number[];
}

function horasDe(texto: string): HoraEncontrada[] {
  const encontradas: HoraEncontrada[] = [];
  const ocupado: [number, number][] = [];
  for (const m of texto.matchAll(HORA_12)) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (h > 12) continue;
    if (m[4]) h = 12; // "12:00 m.": mediodía
    else if (m[3]?.toLowerCase() === 'p' && h < 12) h += 12;
    else if (m[3]?.toLowerCase() === 'a' && h === 12) h = 0;
    encontradas.push({ texto: m[0].trim(), inicio: m.index, fin: m.index + m[0].length, minutos: [h * 60 + min] });
    ocupado.push([m.index, m.index + m[0].length]);
  }
  for (const m of texto.matchAll(HORA_24)) {
    if (ocupado.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    // "2:30" puede ser 02:30 o 14:30; "04:30" y "T04:30" (ISO, herramientas) son de la madrugada.
    const ambigua = m[1]!.length === 1 && texto[m.index - 1] !== 'T' && h >= 1;
    encontradas.push({ texto: m[0], inicio: m.index, fin: m.index + m[0].length, minutos: ambigua ? [h * 60 + min, (h + 12) * 60 + min] : [h * 60 + min] });
  }
  return encontradas.sort((a, b) => a.inicio - b.inicio);
}

/**
 * Las horas de la respuesta que no están en la evidencia: ni como hora exacta
 * (en 24 h o con a. m./p. m.) ni dentro de una franja "HH:MM-HH:MM".
 */
export function horasSinRespaldo(respuesta: string, evidencias: readonly string[]): string[] {
  const exactas = new Set<number>();
  const franjas: [number, number][] = [];
  for (const texto of evidencias) {
    for (const h of horasDe(texto)) for (const m of h.minutos) exactas.add(m);
    // Franjas: dos horas unidas por "-", "a" o "hasta": "14:00-18:00", "de 7:00 a. m. a 6:00 p. m.".
    const horas = horasDe(texto);
    for (const [i, desde] of horas.entries()) {
      const hasta = horas[i + 1];
      if (!hasta || !/^\s*(?:-|–|a|hasta)\s*$/i.test(texto.slice(desde.fin, hasta.inicio))) continue;
      for (const a of desde.minutos) for (const b of hasta.minutos) if (a <= b) franjas.push([a, b]);
    }
  }
  const respaldada = (m: number) => exactas.has(m) || franjas.some(([a, b]) => m >= a && m <= b);
  const sinRespaldo = horasDe(respuesta)
    .filter((h) => !h.minutos.some(respaldada))
    .map((h) => h.texto);
  return [...new Set(sinRespaldo)];
}

/**
 * Cada dato sin respaldo con la frase donde aparece: «3» en "…atendemos 3
 * prepagadas…". Un número suelto no le dice al modelo qué quitar; sin la frase,
 * lo repite y la respuesta se descarta entera (D-40).
 */
export function citarEnContexto(respuesta: string, datos: readonly string[], ancho = 45): string[] {
  return datos.map((dato) => {
    const buscado = dato.replace(/\s*\(.*\)$/, ''); // "lunes 7 de octubre (el 7 … es miércoles)"
    // Un número se busca entero: el "3" de "3 prepagadas", no el de "13:00".
    const escapado = buscado.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const i = /^\d/.test(buscado) ? (new RegExp(`(?<!\\d)${escapado}(?!\\d)`).exec(respuesta)?.index ?? -1) : respuesta.indexOf(buscado);
    if (i === -1) return `«${dato}»`;
    const desde = Math.max(0, i - ancho);
    const hasta = Math.min(respuesta.length, i + buscado.length + ancho);
    const frase = `${desde > 0 ? '…' : ''}${respuesta.slice(desde, hasta).replace(/\s+/g, ' ').trim()}${hasta < respuesta.length ? '…' : ''}`;
    return `«${dato}» en "${frase}"`;
  });
}
