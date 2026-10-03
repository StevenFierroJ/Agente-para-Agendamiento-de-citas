import { describe, expect, it } from 'vitest';
import { partirMarkdown } from '../src/aplicacion/rag/particion.js';

describe('partirMarkdown', () => {
  it('un fragmento por sección ##, con título y sección en el texto', () => {
    const r = partirMarkdown('# Sedes\n\n## Sede Norte\nAvenida 6N.\n\n## Sede Sur\nCalle 16.\n', 'x.md');
    expect(r).toEqual({
      titulo: 'Sedes',
      fragmentos: [
        { seccion: 'Sede Norte', texto: 'Sedes — Sede Norte\nAvenida 6N.' },
        { seccion: 'Sede Sur', texto: 'Sedes — Sede Sur\nCalle 16.' },
      ],
    });
  });

  it('el texto antes de la primera sección y un documento sin secciones son fragmentos', () => {
    expect(partirMarkdown('# Nota\nTexto suelto.', 'x.md').fragmentos).toEqual([{ seccion: '', texto: 'Nota\nTexto suelto.' }]);
  });

  it('descarta secciones vacías y falla sin título', () => {
    expect(partirMarkdown('# T\n## Vacía\n\n## Llena\nalgo', 'x.md').fragmentos.map((f) => f.seccion)).toEqual(['Llena']);
    expect(() => partirMarkdown('## Sin título\nalgo', 'x.md')).toThrow(/título/);
  });
});
