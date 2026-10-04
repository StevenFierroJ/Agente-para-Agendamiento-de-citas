import { useEffect, useRef } from 'react';
import { usd, type Turno } from '../api';
import { EtiquetaEstado } from './Estado';

/**
 * Lo que pasó detrás de una respuesta: modelo, tokens, costo, latencia, herramientas y controles.
 * `abiertoAlInicio` lo despliega solo al montar: después lo abre o cierra quien lee.
 */
export function TurnoDetalle({ turno, abiertoAlInicio = false }: { turno: Turno; abiertoAlInicio?: boolean }) {
  const controles = turno.controles ?? [];
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (abiertoAlInicio && ref.current) ref.current.open = true;
    // Solo al montar: un turno nuevo no debe cerrar ni abrir los que el usuario ya movió.
  }, []);
  return (
    <details className="turno" ref={ref}>
      <summary title="Ver herramientas, argumentos y resultados">
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
                  {c.tipo === 'escalamiento_prometido'
                    ? 'prometió un asesor sin escalar: el código escaló'
                    : c.tipo === 'verificador_no_disponible'
                      ? `verificador no disponible, decidieron las reglas: ${c.datos.join(', ')}`
                    : c.tipo === 'abstencion_sin_busqueda'
                      ? 'dijo que no tenía la información sin buscar → pidió buscar en los documentos'
                    : `${c.tipo === 'cita_no_agendada' ? 'afirmó una cita sin agendarla' : 'datos sin respaldo'} → ${
                        c.accion === 'corregir' ? 'pidió corregir' : 'descartó la respuesta'
                      }${c.datos.length ? `: ${c.datos.join(', ')}` : ''}`}
                  {c.borrador && (
                    <details className="borrador">
                      <summary>ver lo que escribió el modelo</summary>
                      <p>{c.borrador}</p>
                    </details>
                  )}
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
