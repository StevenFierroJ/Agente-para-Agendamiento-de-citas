import { useState } from 'react';
import { ESTADOS, api, fechaColombia, type Bandeja as DatosBandeja, type Estado, type ItemBandeja } from '../api';
import { Aviso, EtiquetaEstado, etiquetaEstado } from '../componentes/Estado';
import { useConsulta } from '../useConsulta';
import { Detalle } from './Detalle';

/** Bandeja con filtro por estado; al elegir una conversación, su detalle al lado. */
export function Bandeja({ seleccionada, onSeleccionar }: { seleccionada: number | null; onSeleccionar: (id: number) => void }) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [masAntiguas, setMasAntiguas] = useState<ItemBandeja[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [errorMas, setErrorMas] = useState<Error | null>(null);

  // La primera página se refresca sola; las siguientes se piden a mano.
  const { datos, error, cargando, recargar } = useConsulta<DatosBandeja>(
    `bandeja-${estado ?? 'todas'}`,
    (senal) => api.bandeja({ estado, antes: null }, senal),
    () => 5_000,
  );

  const cambiarEstado = (nuevo: Estado | null) => {
    setEstado(nuevo);
    setMasAntiguas([]);
    setCursor(null);
  };

  const cargarMas = async () => {
    const desde = cursor ?? datos?.siguiente;
    if (!desde) return;
    setCargandoMas(true);
    setErrorMas(null);
    try {
      const pagina = await api.bandeja({ estado, antes: desde }, new AbortController().signal);
      setMasAntiguas((previas) => [...previas, ...pagina.conversaciones]);
      setCursor(pagina.siguiente ?? '');
    } catch (e) {
      setErrorMas(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setCargandoMas(false);
    }
  };

  const filas = [...(datos?.conversaciones ?? []), ...masAntiguas.filter((m) => !datos?.conversaciones.some((d) => d.id === m.id))];
  const hayMas = cursor === null ? Boolean(datos?.siguiente) : cursor !== '';

  return (
    <div className="bandeja-con-detalle">
      <section className="bandeja">
        <label>
          Estado{' '}
          <select value={estado ?? ''} onChange={(e) => cambiarEstado((e.target.value || null) as Estado | null)}>
            <option value="">Todas</option>
            {ESTADOS.map((e) => (
              <option key={e} value={e}>
                {etiquetaEstado(e)}
              </option>
            ))}
          </select>
        </label>
        {error && <Aviso error={error} onReintentar={recargar} />}
        {cargando && !datos ? (
          <p className="tenue">Cargando conversaciones…</p>
        ) : filas.length === 0 && datos ? (
          <p className="tenue">No hay conversaciones{estado ? ` en estado «${etiquetaEstado(estado)}»` : ''}.</p>
        ) : (
          <ul className="lista">
            {filas.map((c) => (
              <li key={c.id}>
                <button type="button" className={c.id === seleccionada ? 'fila activa' : 'fila'} onClick={() => onSeleccionar(c.id)}>
                  <span className="fila-arriba">
                    <strong>{c.telefono}</strong>
                    <EtiquetaEstado estado={c.estado} />
                  </span>
                  <span className="tenue recorte">{c.ultimo_texto ?? ''}</span>
                  <span className="tenue">
                    {fechaColombia(c.ultimo_mensaje_en)}
                    {c.mensajes_pendientes > 0 && <span className="respondiendo"> · respondiendo…</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {errorMas && <Aviso error={errorMas} />}
        {hayMas && (
          <button type="button" onClick={() => void cargarMas()} disabled={cargandoMas}>
            {cargandoMas ? 'Cargando…' : 'Cargar más'}
          </button>
        )}
      </section>
      <div className="panel">{seleccionada ? <Detalle id={seleccionada} /> : <p className="tenue">Elige una conversación.</p>}</div>
    </div>
  );
}
