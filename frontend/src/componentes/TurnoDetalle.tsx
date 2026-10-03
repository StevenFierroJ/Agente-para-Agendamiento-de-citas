import { usd, type Turno } from '../api';
import { EtiquetaEstado } from './Estado';

/** Lo que pasó detrás de una respuesta: modelo, tokens, costo, latencia, herramientas y controles. */
export function TurnoDetalle({ turno }: { turno: Turno }) {
  const controles = turno.controles ?? [];
  return (
    <details className="turno">
      <summary>
        <EtiquetaEstado estado={turno.estado_final} />
        <span>{turno.herramientas.length ? turno.herramientas.map((h) => h.nombre + (h.error ? ' ✗' : ' ✓')).join(' · ') : 'sin herramientas'}</span>
        <span className="tenue">
          {turno.modelo ?? 'sin LLM'} · {turno.tokens_entrada}+{turno.tokens_salida} tokens · {usd(turno.costo_usd)} · {(turno.latencia_ms / 1000).toFixed(1)} s
        </span>
      </summary>
      <dl className="turno-datos">
        <dt>Iteraciones</dt>
        <dd>{turno.iteraciones}</dd>
        <dt>Llamadas al LLM</dt>
        <dd>
          {turno.llamadas_llm.length === 0
            ? 'ninguna'
            : turno.llamadas_llm.map((l, i) => (
                <span key={i} className={l.error ? 'error' : ''}>
                  #{l.intento} {l.latencia_ms} ms{l.error ? ` (${l.error})` : ''}{' '}
                </span>
              ))}
        </dd>
        {turno.error && (
          <>
            <dt>Error</dt>
            <dd className="error">{turno.error}</dd>
          </>
        )}
        {controles.length > 0 && (
          <>
            <dt>Barandilla</dt>
            <dd>
              {controles.map((c, i) => (
                <div key={i}>
                  {c.accion === 'corregir' ? 'pidió corregir' : 'descartó la respuesta'}: {c.datos.join(', ')}
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>
      {turno.herramientas.length > 0 && (
        <table className="herramientas">
          <thead>
            <tr>
              <th>Herramienta</th>
              <th>Argumentos</th>
              <th>Resultado</th>
              <th>ms</th>
            </tr>
          </thead>
          <tbody>
            {turno.herramientas.map((h, i) => (
              <tr key={i} className={h.error ? 'fila-error' : ''}>
                <td>
                  {h.nombre}
                  {h.error && <div className="error">{h.error}</div>}
                </td>
                <td>
                  <pre>{JSON.stringify(h.argumentos, null, 1)}</pre>
                </td>
                <td>
                  <pre>{JSON.stringify(h.resultado, null, 1)}</pre>
                </td>
                <td>{h.duracion_ms}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
