import { useMemo, useState } from 'react';
import { api, diaColombia, horaColombia, lunesDe, sumarDias, type Agenda as DatosAgenda, type HorarioAgenda } from '../api';
import { Aviso } from '../componentes/Estado';
import { useConsulta } from '../useConsulta';

const NOMBRES_DIA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Un color por especialidad, estable por orden alfabético del catálogo. */
const TONOS = ['tono-1', 'tono-2', 'tono-3', 'tono-4', 'tono-5'];

/** "HH:mm" en Colombia: la fila del calendario de un horario. */
function franjaDe(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function etiquetaDia(dia: string): { nombre: string; numero: string } {
  const fecha = new Date(`${dia}T12:00:00Z`);
  return { nombre: NOMBRES_DIA[(fecha.getUTCDay() + 6) % 7] ?? '', numero: `${fecha.getUTCDate()} ${MESES[fecha.getUTCMonth()]}` };
}

function apellido(profesional: string): string {
  return profesional.split(' ').slice(-1)[0] ?? profesional;
}

/** Calendario del coordinador: horarios libres y citas de la semana, por día y hora. */
export function Agenda({ onAbrirConversacion }: { onAbrirConversacion: (id: number) => void }) {
  const hoy = diaColombia();
  // Un sábado o domingo la semana en curso ya no tiene agenda: se abre la siguiente.
  const semanaInicial = () => (lunesDe(hoy) === lunesDe(sumarDias(hoy, 2)) ? lunesDe(hoy) : lunesDe(sumarDias(hoy, 2)));
  const [lunes, setLunes] = useState(semanaInicial);
  const [sede, setSede] = useState<number | null>(null);
  const [especialidad, setEspecialidad] = useState<number | null>(null);
  const domingo = sumarDias(lunes, 6);

  const { datos, error, cargando, recargar } = useConsulta<DatosAgenda>(
    `agenda-${lunes}-${sede ?? 'todas'}-${especialidad ?? 'todas'}`,
    (senal) => api.agenda({ desde: lunes, hasta: domingo, sede, especialidad }, senal),
    () => 15_000,
  );

  const vista = useMemo(() => {
    const horarios = datos?.horarios ?? [];
    const dias = Array.from({ length: 7 }, (_, i) => sumarDias(lunes, i)).filter(
      (d, i) => i < 5 || horarios.some((h) => diaColombia(new Date(h.inicio)) === d),
    );
    const franjas = [...new Set(horarios.map((h) => franjaDe(h.inicio)))].sort();
    const celdas = new Map<string, HorarioAgenda[]>();
    for (const h of horarios) {
      const clave = `${diaColombia(new Date(h.inicio))}|${franjaDe(h.inicio)}`;
      celdas.set(clave, [...(celdas.get(clave) ?? []), h]);
    }
    const tono = new Map((datos?.catalogo.especialidades ?? []).map((e, i) => [e.nombre, TONOS[i % TONOS.length] ?? '']));
    const citas = horarios.filter((h) => h.cita !== null);
    const ahora = Date.now();
    const libres = horarios.filter((h) => h.cita === null && new Date(h.inicio).getTime() > ahora).length;
    return { dias, franjas, celdas, tono, citas, libres };
  }, [datos, lunes]);

  const rango = `${etiquetaDia(lunes).numero} – ${etiquetaDia(domingo).numero} ${domingo.slice(0, 4)}`;

  return (
    <div className="pagina">
      <header className="pagina-cabecera">
        <div>
          <h1>Agenda</h1>
          <p className="tenue">Horarios libres y citas agendadas, en hora de Colombia.</p>
        </div>
        <div className="controles">
          <div className="grupo-botones">
            <button type="button" onClick={() => setLunes(sumarDias(lunes, -7))} aria-label="Semana anterior">‹</button>
            <button type="button" onClick={() => setLunes(semanaInicial())}>Hoy</button>
            <button type="button" onClick={() => setLunes(sumarDias(lunes, 7))} aria-label="Semana siguiente">›</button>
          </div>
          <strong className="rango">{rango}</strong>
          <select value={sede ?? ''} onChange={(e) => setSede(e.target.value ? Number(e.target.value) : null)} aria-label="Sede">
            <option value="">Todas las sedes</option>
            {datos?.catalogo.sedes.map((s) => (
              <option key={s.id} value={s.id}>{s.nombre}</option>
            ))}
          </select>
          <select value={especialidad ?? ''} onChange={(e) => setEspecialidad(e.target.value ? Number(e.target.value) : null)} aria-label="Especialidad">
            <option value="">Todas las especialidades</option>
            {datos?.catalogo.especialidades.map((e) => (
              <option key={e.id} value={e.id}>{e.nombre}</option>
            ))}
          </select>
        </div>
      </header>

      {error && <Aviso error={error} onReintentar={recargar} />}

      <section className="metricas">
        <div className="metrica"><span className="metrica-valor">{vista.libres}</span><span className="tenue">horarios libres por delante</span></div>
        <div className="metrica"><span className="metrica-valor">{vista.citas.length}</span><span className="tenue">citas en la semana</span></div>
        <div className="leyenda">
          {datos?.catalogo.especialidades.map((e) => (
            <span key={e.id} className={`ficha ${vista.tono.get(e.nombre)}`}>{e.nombre}</span>
          ))}
          <span className="ficha ficha-libre-muestra">libre</span>
          <span className="ficha ficha-ocupada-muestra">con cita</span>
        </div>
      </section>

      <div className="agenda-cuerpo">
        <div className="tarjeta calendario-contenedor">
          {cargando && !datos ? (
            <p className="tenue relleno">Cargando agenda…</p>
          ) : vista.franjas.length === 0 ? (
            <p className="vacio">No hay horarios en esta semana{sede || especialidad ? ' con estos filtros' : ''}. La agenda sembrada cubre 14 días.</p>
          ) : (
            <table className="calendario">
              <thead>
                <tr>
                  <th className="col-hora" />
                  {vista.dias.map((d) => {
                    const { nombre, numero } = etiquetaDia(d);
                    return (
                      <th key={d} className={d === hoy ? 'hoy' : ''}>
                        <span className="dia-nombre">{nombre}</span> <span className="dia-numero">{numero}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {vista.franjas.map((f) => (
                  <tr key={f}>
                    <th className="col-hora">{f}</th>
                    {vista.dias.map((d) => (
                      <td key={d} className={d === hoy ? 'hoy' : ''}>
                        {(vista.celdas.get(`${d}|${f}`) ?? []).map((h) => {
                          const pasado = new Date(h.inicio).getTime() <= Date.now();
                          const titulo = `${h.especialidad} · ${h.profesional} · ${h.sede} · ${horaColombia(h.inicio)}`;
                          return h.cita ? (
                            <button
                              key={h.horario_id}
                              type="button"
                              className={`ficha ficha-ocupada ${vista.tono.get(h.especialidad)} ${pasado ? 'pasada' : ''}`}
                              title={`${titulo}\nCita: ${h.cita.nombre_paciente} (abrir conversación)`}
                              onClick={() => onAbrirConversacion(h.cita!.conversacion_id)}
                            >
                              {h.cita.nombre_paciente}
                            </button>
                          ) : (
                            <span key={h.horario_id} className={`ficha ficha-libre ${vista.tono.get(h.especialidad)} ${pasado ? 'pasada' : ''}`} title={`${titulo}\nLibre`}>
                              {apellido(h.profesional)} · {h.sede.replace('Sede ', '')}
                            </span>
                          );
                        })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <aside className="tarjeta citas-semana">
          <h2>Citas de la semana</h2>
          {vista.citas.length === 0 ? (
            <p className="tenue">Sin citas agendadas en esta semana.</p>
          ) : (
            <ul>
              {vista.citas.map((h) => (
                <li key={h.horario_id}>
                  <button type="button" onClick={() => onAbrirConversacion(h.cita!.conversacion_id)}>
                    <span className={`punto ${vista.tono.get(h.especialidad)}`} />
                    <span>
                      <strong>{h.cita!.nombre_paciente}</strong>
                      <span className="tenue">
                        {etiquetaDia(diaColombia(new Date(h.inicio))).nombre} {etiquetaDia(diaColombia(new Date(h.inicio))).numero} · {horaColombia(h.inicio)}
                      </span>
                      <span className="tenue">{h.especialidad} · {h.profesional} · {h.sede}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
