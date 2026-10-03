export interface DocumentoPartido {
  titulo: string;
  fragmentos: { seccion: string; texto: string }[];
}

/**
 * Parte un documento Markdown por sus secciones `##`: los documentos son cortos
 * y cada sección trata un solo tema, así que una sección es un fragmento.
 * El título (`#`) y la sección van dentro del texto del fragmento: dan contexto
 * al embedding ("Sede Sur" sola no dice que se trata de horarios).
 * Un documento sin secciones es un único fragmento.
 */
export function partirMarkdown(markdown: string, origen: string): DocumentoPartido {
  const lineas = markdown.replace(/\r\n/g, '\n').split('\n');
  const titulo = lineas.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim();
  if (!titulo) throw new Error(`El documento ${origen} no tiene título (# ...)`);

  const fragmentos: { seccion: string; lineas: string[] }[] = [];
  let actual: { seccion: string; lineas: string[] } | null = null;
  for (const linea of lineas) {
    if (/^#\s+/.test(linea)) continue;
    const seccion = /^##\s+(.+)$/.exec(linea)?.[1];
    if (seccion) {
      actual = { seccion: seccion.trim(), lineas: [] };
      fragmentos.push(actual);
      continue;
    }
    if (!actual) {
      actual = { seccion: '', lineas: [] };
      fragmentos.push(actual);
    }
    actual.lineas.push(linea);
  }

  const resultado = fragmentos
    .map((f) => ({ seccion: f.seccion, cuerpo: f.lineas.join('\n').trim() }))
    .filter((f) => f.cuerpo.length > 0)
    .map((f) => ({ seccion: f.seccion, texto: `${titulo}${f.seccion ? ` — ${f.seccion}` : ''}\n${f.cuerpo}` }));
  if (resultado.length === 0) throw new Error(`El documento ${origen} no tiene contenido`);
  return { titulo, fragmentos: resultado };
}
