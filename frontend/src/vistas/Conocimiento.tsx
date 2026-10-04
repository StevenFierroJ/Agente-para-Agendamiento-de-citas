import { useMemo, useState, type ReactNode } from 'react';
import { api, type Conocimiento as DatosConocimiento } from '../api';
import { Aviso } from '../componentes/Estado';
import { useConsulta } from '../useConsulta';

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Resalta las apariciones de `buscado` sin importar tildes ni mayúsculas. */
function resaltar(texto: string, buscado: string): ReactNode {
  const aguja = normalizar(buscado.trim());
  if (!aguja) return texto;
  const pajar = normalizar(texto);
  const partes: ReactNode[] = [];
  let desde = 0;
  for (let i = pajar.indexOf(aguja); i !== -1; i = pajar.indexOf(aguja, desde)) {
    partes.push(texto.slice(desde, i), <mark key={i}>{texto.slice(i, i + aguja.length)}</mark>);
    desde = i + aguja.length;
  }
  partes.push(texto.slice(desde));
  return partes;
}

/**
 * Lo que sabe el asistente: los documentos de la clínica tal como los partió e
 * indexó el RAG. Si un dato no está aquí, el asistente no lo puede responder.
 */
export function Conocimiento() {
  const { datos, error, cargando, recargar } = useConsulta<DatosConocimiento>('conocimiento', (senal) => api.conocimiento(senal), () => null);
  const [elegido, setElegido] = useState<number | null>(null);
  const [buscado, setBuscado] = useState('');

  const documentos = useMemo(() => {
    const aguja = normalizar(buscado.trim());
    return (datos?.documentos ?? []).map((d) => ({
      ...d,
      coincidencias: aguja ? d.fragmentos.filter((f) => normalizar(`${f.seccion} ${f.texto}`).includes(aguja)) : d.fragmentos,
    }));
  }, [datos, buscado]);

  const buscando = buscado.trim() !== '';
  const visibles = buscando ? documentos.filter((d) => d.coincidencias.length > 0) : documentos.filter((d) => d.id === (elegido ?? documentos[0]?.id));

  return (
    <div className="pagina">
      <header className="pagina-cabecera">
        <div>
          <h1>Base de conocimiento</h1>
          <p className="tenue">
            Lo que el asistente puede consultar con <code>buscar_conocimiento</code>. Si un dato no está aquí, el asistente no lo responde: lo dice o escala.
          </p>
        </div>
        {datos && (
          <div className="metricas metricas-compactas">
            <div className="metrica"><span className="metrica-valor">{datos.documentos.length}</span><span className="tenue">documentos</span></div>
            <div className="metrica"><span className="metrica-valor">{datos.fragmentos}</span><span className="tenue">fragmentos indexados</span></div>
          </div>
        )}
      </header>

      {error && <Aviso error={error} onReintentar={recargar} />}
      {cargando && !datos && <p className="tenue">Cargando documentos…</p>}

      {datos && (
        <div className="conocimiento">
          <aside className="tarjeta lista-documentos">
            <input type="search" placeholder="Buscar en los documentos…" value={buscado} onChange={(e) => setBuscado(e.target.value)} />
            <ul>
              {documentos.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className={!buscando && d.id === (elegido ?? documentos[0]?.id) ? 'activa' : ''}
                    disabled={buscando && d.coincidencias.length === 0}
                    onClick={() => { setBuscado(''); setElegido(d.id); }}
                  >
                    <span>{d.titulo}</span>
                    <span className="contador">{buscando ? d.coincidencias.length : d.fragmentos.length}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="fragmentos">
            {visibles.length === 0 && <p className="vacio">Ningún fragmento menciona «{buscado}». El asistente tampoco lo encontraría.</p>}
            {visibles.map((d) => (
              <article key={d.id} className="tarjeta documento">
                <header>
                  <h2>{d.titulo}</h2>
                  <code className="tenue">{d.origen}</code>
                </header>
                {d.coincidencias.map((f) => (
                  <div key={f.id} className="fragmento">
                    <div className="fragmento-cabecera">
                      <span className="ficha">{f.seccion || 'Sin sección'}</span>
                      <span className="tenue">fragmento #{f.id}</span>
                    </div>
                    <p>{resaltar(f.texto, buscado)}</p>
                  </div>
                ))}
              </article>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
