import { api, fechaColombia, usd, type Detalle as DatosDetalle } from '../api';
import { Aviso, EtiquetaEstado } from '../componentes/Estado';
import { TurnoDetalle } from '../componentes/TurnoDetalle';
import { useConsulta } from '../useConsulta';

const SONDEO_RAPIDO_MS = 1_000; // mientras el asistente responde
const SONDEO_NORMAL_MS = 5_000;

/** Conversación completa: mensajes y, por cada respuesta, el turno que la produjo. */
export function Detalle({ id }: { id: number }) {
  const { datos, error, cargando, recargar } = useConsulta<DatosDetalle>(
    `detalle-${id}`,
    (senal) => api.detalle(id, senal),
    (d) => (d?.respondiendo ? SONDEO_RAPIDO_MS : SONDEO_NORMAL_MS),
  );

  if (cargando && !datos) return <p className="tenue">Cargando conversación…</p>;
  if (!datos) return error ? <Aviso error={error} onReintentar={recargar} /> : null;

  const turnoDe = new Map(datos.turnos.map((t) => [t.message_id, t]));
  return (
    <section className="detalle">
      {error && <Aviso error={error} onReintentar={recargar} />}
      <header className="detalle-cabecera">
        <h2>{datos.conversacion.telefono}</h2>
        <EtiquetaEstado estado={datos.conversacion.estado} />
        <span className="tenue">
          {datos.resumen.turnos} turnos · {datos.resumen.tokens_entrada}+{datos.resumen.tokens_salida} tokens · {usd(datos.resumen.costo_usd)}
        </span>
      </header>

      {datos.citas.length > 0 && (
        <ul className="citas">
          {datos.citas.map((c) => (
            <li key={c.id}>
              Cita {c.estado}: {c.especialidad}, {c.sede}, {fechaColombia(c.inicio)} con {c.profesional} — {c.nombre_paciente}
            </li>
          ))}
        </ul>
      )}

      <ol className="mensajes">
        {datos.mensajes.map((m) => (
          <li key={m.id} className={`mensaje mensaje-${m.rol}`}>
            <div className="burbuja">{m.texto}</div>
            <div className="tenue">{fechaColombia(m.fecha)}</div>
            {m.rol === 'asistente' && turnoDe.get(m.message_id) && <TurnoDetalle turno={turnoDe.get(m.message_id)!} />}
          </li>
        ))}
        {datos.pendientes.map((p) => (
          <li key={p.message_id} className="mensaje mensaje-paciente pendiente">
            <div className="burbuja">{p.texto}</div>
            <div className="tenue">{fechaColombia(p.enviado_en)}</div>
          </li>
        ))}
        {datos.mensajes.length === 0 && datos.pendientes.length === 0 && <li className="tenue">Sin mensajes.</li>}
      </ol>
      {datos.respondiendo && <p className="respondiendo">El asistente está respondiendo…</p>}
    </section>
  );
}
