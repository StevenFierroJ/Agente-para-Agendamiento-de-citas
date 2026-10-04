import { Fragment, useState } from 'react';
import {
  ESTADOS,
  HERRAMIENTAS,
  api,
  fechaColombia,
  usd,
  type Estado,
  type EstadoFinal,
  type ResumenTrazas,
  type TrazaConversacion,
  type Trazas as DatosTurnos,
  type TrazasConversaciones,
  type TurnoTraza,
} from '../api';
import { Aviso, EtiquetaEstado, etiquetaEstado } from '../componentes/Estado';
import { TurnoDetalle } from '../componentes/TurnoDetalle';
import { useConsulta } from '../useConsulta';

const ESTADOS_FINALES: EstadoFinal[] = ['resuelta_por_ia', 'cita_agendada', 'escalada'];

function segundos(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function porcentaje(parte: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((parte / total) * 100)} %`;
}

function tokens(entrada: number, salida: number): string {
  return `${entrada.toLocaleString('es-CO')} + ${salida.toLocaleString('es-CO')}`;
}

/** Herramientas agrupadas por nombre: "consultar disponibilidad ×7 · 7 ✗". */
function agrupar(herramientas: TurnoTraza['herramientas']): { nombre: string; llamadas: number; errores: string[] }[] {
  const grupos = new Map<string, { nombre: string; llamadas: number; errores: string[] }>();
  for (const h of herramientas) {
    const g = grupos.get(h.nombre) ?? { nombre: h.nombre, llamadas: 0, errores: [] };
    g.llamadas += 1;
    if (h.error) g.errores.push(h.error);
    grupos.set(h.nombre, g);
  }
  return [...grupos.values()];
}

function FichasHerramientas({ grupos }: { grupos: { nombre: string; llamadas: number; errores: number; detalle?: string }[] }) {
  if (grupos.length === 0) return <span className="tenue">—</span>;
  return (
    <span className="fichas">
      {grupos.map((g) => (
        <span
          key={g.nombre}
          className={`ficha ${g.errores === g.llamadas ? 'ficha-error' : g.errores ? 'ficha-mixta' : 'ficha-ok'}`}
          title={g.detalle ?? (g.errores ? `${g.errores} con error` : 'sin errores')}
        >
          {g.nombre.replace(/_/g, ' ')}
          {g.llamadas > 1 && <strong> ×{g.llamadas}</strong>}
          {g.errores > 0 && <span> · {g.errores} ✗</span>}
        </span>
      ))}
    </span>
  );
}

/** Algo salió distinto del camino normal en el turno: herramienta fallida, falla del LLM, barandilla o error. */
function problemasDe(t: TurnoTraza): string[] {
  const problemas: string[] = [];
  for (const g of agrupar(t.herramientas)) {
    for (const e of new Set(g.errores)) problemas.push(`${e}${g.errores.length > 1 ? ` ×${g.errores.filter((x) => x === e).length}` : ''}`);
  }
  const fallidas = t.llamadas_llm.filter((l) => l.error).length;
  if (fallidas) problemas.push(`${fallidas} llamada${fallidas > 1 ? 's' : ''} al LLM fallida${fallidas > 1 ? 's' : ''}`);
  for (const c of t.controles ?? []) problemas.push(`barandilla: ${c.tipo}`);
  if (t.error) problemas.push(t.error);
  return problemas;
}

/**
 * Cómo se comporta el modelo: una fila por conversación con sus totales y, al
 * desplegarla, cada turno con sus llamadas, iteraciones y herramientas.
 */
export function Trazas({ onAbrirConversacion }: { onAbrirConversacion: (id: number) => void }) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [herramienta, setHerramienta] = useState<string | null>(null);
  const [conProblemas, setConProblemas] = useState(false);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [masAntiguas, setMasAntiguas] = useState<TrazaConversacion[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [errorMas, setErrorMas] = useState<Error | null>(null);

  const filtro = { estado, herramienta, con_problemas: conProblemas };
  const { datos, error, cargando, recargar } = useConsulta<TrazasConversaciones>(
    `trazas-${estado ?? 'todas'}-${herramienta ?? 'todas'}-${conProblemas}`,
    (senal) => api.trazasConversaciones({ ...filtro, antes: null }, senal),
    () => 10_000,
  );

  const reiniciar = () => {
    setMasAntiguas([]);
    setCursor(null);
    setAbierta(null);
  };

  const cargarMas = async () => {
    const desde = cursor ?? datos?.siguiente;
    if (!desde) return;
    setCargandoMas(true);
    setErrorMas(null);
    try {
      const pagina = await api.trazasConversaciones({ ...filtro, antes: desde }, new AbortController().signal);
      setMasAntiguas((previas) => [...previas, ...pagina.conversaciones]);
      setCursor(pagina.siguiente ?? '');
    } catch (e) {
      setErrorMas(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setCargandoMas(false);
    }
  };

  const filas = [...(datos?.conversaciones ?? []), ...masAntiguas.filter((m) => !datos?.conversaciones.some((d) => d.conversacion_id === m.conversacion_id))];
  const hayMas = cursor === null ? Boolean(datos?.siguiente) : cursor !== '';

  return (
    <div className="pagina">
      <header className="pagina-cabecera">
        <div>
          <h1>Trazas del asistente</h1>
          <p className="tenue">Cada conversación con lo que costó y cómo se comportó el modelo. Despliega una para ver turno por turno.</p>
        </div>
        <div className="controles">
          <div className="filtros sin-borde" role="group" aria-label="Estado de la conversación">
            {[null, ...ESTADOS].map((e) => (
              <button key={e ?? 'todas'} type="button" className={estado === e ? 'filtro activo' : 'filtro'} onClick={() => { setEstado(e); reiniciar(); }}>
                {e ? etiquetaEstado(e) : 'Todas'}
              </button>
            ))}
          </div>
          <select value={herramienta ?? ''} onChange={(e) => { setHerramienta(e.target.value || null); reiniciar(); }} aria-label="Herramienta">
            <option value="">Cualquier herramienta</option>
            {HERRAMIENTAS.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          <label className="interruptor">
            <input type="checkbox" checked={conProblemas} onChange={(e) => { setConProblemas(e.target.checked); reiniciar(); }} /> Solo con problemas
          </label>
        </div>
      </header>

      {error && <Aviso error={error} onReintentar={recargar} />}
      {datos?.resumen && <Resumen r={datos.resumen} conversaciones={filas.length} hayMas={hayMas} />}

      <section className="tarjeta sin-relleno">
        {cargando && !datos ? (
          <p className="tenue relleno">Cargando trazas…</p>
        ) : filas.length === 0 ? (
          <p className="vacio">No hay conversaciones con estos filtros.</p>
        ) : (
          <div className="tabla-desplazable">
            <table className="tabla tabla-trazas">
              <thead>
                <tr>
                  <th>Conversación</th>
                  <th>Primer mensaje</th>
                  <th className="num">Turnos</th>
                  <th>Herramientas</th>
                  <th className="num" title="Iteraciones del ciclo de herramientas, sumadas">Iter.</th>
                  <th className="num" title="Llamadas al LLM, incluidos reintentos">LLM</th>
                  <th className="num">Tokens</th>
                  <th className="num">Costo</th>
                  <th className="num" title="Media por turno con LLM · máxima">Latencia</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((c) => {
                  const estaAbierta = abierta === c.conversacion_id;
                  const conLlm = c.turnos - c.turnos_sin_llm;
                  return (
                    <Fragment key={c.conversacion_id}>
                      <tr
                        className={`fila-traza ${estaAbierta ? 'abierta' : ''} ${c.turnos_con_problemas ? 'con-problemas' : ''}`}
                        onClick={() => setAbierta(estaAbierta ? null : c.conversacion_id)}
                      >
                        <td className="nowrap">
                          <span className="desplegar" aria-hidden>{estaAbierta ? '▾' : '▸'}</span> <strong>{c.telefono}</strong>
                          <span className="tenue bloque">{fechaColombia(c.ultimo_turno)}</span>
                        </td>
                        <td className="celda-texto" title={c.primer_mensaje ?? ''}>{c.primer_mensaje ?? '—'}</td>
                        <td className="num nowrap">
                          {c.turnos}
                          {c.turnos_sin_llm > 0 && <span className="tenue bloque" title="Respuestas fijas: conversación escalada, sin llamar al LLM">{c.turnos_sin_llm} sin LLM</span>}
                        </td>
                        <td><FichasHerramientas grupos={c.herramientas} /></td>
                        <td className="num">{c.iteraciones}</td>
                        <td className="num">
                          {c.llamadas_llm}
                          {c.llamadas_fallidas > 0 && <span className="error bloque">{c.llamadas_fallidas} fallidas</span>}
                        </td>
                        <td className="num nowrap">{tokens(c.tokens_entrada, c.tokens_salida)}</td>
                        <td className="num nowrap"><strong>{usd(c.costo_usd)}</strong></td>
                        <td className="num nowrap">
                          {conLlm > 0 ? segundos(c.latencia_total_ms / conLlm) : '—'}
                          {conLlm > 0 && <span className="tenue bloque">máx {segundos(c.latencia_max_ms)}</span>}
                        </td>
                        <td className="celda-estado">
                          {c.estado && <EtiquetaEstado estado={c.estado} />}
                          {c.citas_activas > 0 && <span className="tenue bloque">{c.citas_activas} cita{c.citas_activas > 1 ? 's' : ''} activa{c.citas_activas > 1 ? 's' : ''}</span>}
                          {c.turnos_con_problemas > 0 && (
                            <span className="error bloque">
                              {c.turnos_con_problemas} turno{c.turnos_con_problemas > 1 ? 's' : ''} con problemas
                            </span>
                          )}
                        </td>
                      </tr>
                      {estaAbierta && (
                        <tr className="fila-expandida">
                          <td colSpan={10}>
                            <TurnosDeConversacion conversacion={c} onAbrirConversacion={onAbrirConversacion} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {errorMas && <Aviso error={errorMas} />}
      {hayMas && (
        <button type="button" className="cargar-mas" onClick={() => void cargarMas()} disabled={cargandoMas}>
          {cargandoMas ? 'Cargando…' : 'Cargar más conversaciones'}
        </button>
      )}
    </div>
  );
}

function Resumen({ r, conversaciones, hayMas }: { r: ResumenTrazas; conversaciones: number; hayMas: boolean }) {
  return (
    <>
      <section className="metricas">
        <div className="metrica">
          <span className="metrica-valor">{conversaciones}{hayMas ? '+' : ''}</span>
          <span className="tenue">conversaciones · {r.turnos} turnos</span>
        </div>
        <div className="metrica">
          <span className="metrica-valor">{usd(r.costo_usd)}</span>
          <span className="tenue">costo total · {usd(r.costo_promedio_usd)} por turno</span>
        </div>
        <div className="metrica">
          <span className="metrica-valor">{r.iteraciones_promedio.toFixed(2)}</span>
          <span className="tenue">iteraciones por turno</span>
        </div>
        <div className="metrica">
          <span className="metrica-valor">{segundos(r.latencia_p50_ms)}</span>
          <span className="tenue">latencia p50 · p95 {segundos(r.latencia_p95_ms)}</span>
        </div>
        <div className="metrica">
          <span className="metrica-valor">{r.llamadas_llm}</span>
          <span className="tenue">llamadas al LLM · {r.llamadas_fallidas} fallidas</span>
        </div>
        <div className="metrica">
          <span className="metrica-valor">{(r.tokens_entrada / 1000).toFixed(1)}k / {(r.tokens_salida / 1000).toFixed(1)}k</span>
          <span className="tenue">tokens de entrada / salida</span>
        </div>
        <div className="metrica">
          <span className="metrica-valor">{r.con_barandilla}</span>
          <span className="tenue">turnos con barandilla</span>
        </div>
      </section>

      <section className="trazas-resumen">
        <div className="tarjeta">
          <h2>Uso de herramientas</h2>
          {r.herramientas.length === 0 ? (
            <p className="tenue">Ningún turno usó herramientas.</p>
          ) : (
            <table className="tabla">
              <thead>
                <tr><th>Herramienta</th><th className="num">Llamadas</th><th className="num">Por turno</th><th className="num">Errores</th><th className="num">Tasa de error</th><th className="num">Duración media</th></tr>
              </thead>
              <tbody>
                {r.herramientas.map((h) => (
                  <tr key={h.nombre}>
                    <td><code>{h.nombre}</code></td>
                    <td className="num">{h.llamadas}</td>
                    <td className="num">{(h.llamadas / r.turnos).toFixed(2)}</td>
                    <td className={`num ${h.errores ? 'error' : ''}`}>{h.errores}</td>
                    <td className="num">{porcentaje(h.errores, h.llamadas)}</td>
                    <td className="num">{h.duracion_promedio_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="tarjeta">
          <h2>Estado final de los turnos</h2>
          <ul className="barras">
            {ESTADOS_FINALES.map((e) => {
              const n = r.por_estado[e] ?? 0;
              return (
                <li key={e}>
                  <EtiquetaEstado estado={e} />
                  <span className="barra"><span className={`relleno-barra estado-${e}`} style={{ width: `${r.turnos ? (n / r.turnos) * 100 : 0}%` }} /></span>
                  <span className="num">{n} · {porcentaje(n, r.turnos)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </>
  );
}

/** Los turnos de una conversación, en orden, cada uno desplegable con su traza completa. */
function TurnosDeConversacion({ conversacion, onAbrirConversacion }: { conversacion: TrazaConversacion; onAbrirConversacion: (id: number) => void }) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const { datos, error, cargando, recargar } = useConsulta<DatosTurnos>(
    `turnos-de-${conversacion.conversacion_id}-${conversacion.ultimo_turno}`,
    (senal) => api.turnosDeConversacion(conversacion.conversacion_id, senal),
    () => null,
  );
  if (cargando && !datos) return <p className="tenue">Cargando turnos…</p>;
  if (!datos) return error ? <Aviso error={error} onReintentar={recargar} /> : null;
  const turnos = [...datos.turnos].reverse();

  return (
    <div className="turnos-conversacion">
      <div className="turnos-cabecera">
        <strong>{turnos.length} turnos de {conversacion.telefono}</strong>
        <button type="button" onClick={() => onAbrirConversacion(conversacion.conversacion_id)}>Abrir la conversación completa →</button>
      </div>
      <table className="tabla tabla-turnos">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Hora</th>
            <th>Paciente → asistente</th>
            <th>Herramientas</th>
            <th className="num">Iter.</th>
            <th className="num">LLM</th>
            <th className="num">Tokens</th>
            <th className="num">Costo</th>
            <th className="num">Latencia</th>
            <th>Estado del turno</th>
          </tr>
        </thead>
        <tbody>
          {turnos.map((t, i) => {
            const problemas = problemasDe(t);
            const sinLlm = t.llamadas_llm.length === 0;
            const estaAbierto = abierto === t.message_id;
            return (
              <Fragment key={t.message_id}>
                <tr className={`fila-traza ${estaAbierto ? 'abierta' : ''} ${problemas.length ? 'con-problemas' : ''}`} onClick={() => setAbierto(estaAbierto ? null : t.message_id)}>
                  <td className="num tenue">{i + 1}</td>
                  <td className="nowrap">{fechaColombia(t.fecha)}</td>
                  <td className="celda-intercambio">
                    <span className="recorte bloque" title={t.pregunta ?? ''}>{t.pregunta ?? '—'}</span>
                    <span className="recorte bloque tenue" title={t.respuesta ?? ''}>↳ {t.respuesta ?? '—'}</span>
                  </td>
                  <td>
                    {sinLlm ? (
                      <span className="tenue" title="La conversación ya estaba escalada: respuesta fija, sin llamar al LLM">mensaje fijo, sin LLM</span>
                    ) : (
                      <FichasHerramientas
                        grupos={agrupar(t.herramientas).map((g) => ({ nombre: g.nombre, llamadas: g.llamadas, errores: g.errores.length, detalle: g.errores.length ? `Errores: ${[...new Set(g.errores)].join(', ')}` : 'sin errores' }))}
                      />
                    )}
                  </td>
                  <td className="num">{sinLlm ? '—' : t.iteraciones}</td>
                  <td className="num">{sinLlm ? '—' : t.llamadas_llm.length}</td>
                  <td className="num nowrap">{sinLlm ? '—' : tokens(t.tokens_entrada, t.tokens_salida)}</td>
                  <td className="num nowrap">{sinLlm ? '—' : usd(t.costo_usd)}</td>
                  <td className="num nowrap">{segundos(t.latencia_ms)}</td>
                  <td className="celda-estado">
                    <EtiquetaEstado estado={t.estado_final} />
                    {problemas.length > 0 && (
                      <span className="error bloque" title={problemas.join('\n')}>
                        {problemas[0]}
                        {problemas.length > 1 ? ` (+${problemas.length - 1})` : ''}
                      </span>
                    )}
                  </td>
                </tr>
                {estaAbierto && (
                  <tr className="fila-expandida">
                    <td colSpan={10}>
                      <div className="expandido">
                        <div className="intercambio">
                          <div><span className="tenue">Paciente</span><p className="burbuja">{t.pregunta ?? '—'}</p></div>
                          <div><span className="tenue">Asistente</span><p className="burbuja burbuja-asistente">{t.respuesta ?? '—'}</p></div>
                        </div>
                        <TurnoDetalle turno={t} abiertoAlInicio />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
