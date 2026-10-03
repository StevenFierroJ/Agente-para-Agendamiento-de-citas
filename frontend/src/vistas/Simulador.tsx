import { useState, type FormEvent } from 'react';
import { ErrorApi, api } from '../api';
import { Detalle } from './Detalle';

/** Mensajes de ejemplo de los casos borde (los mismos del README). */
const EJEMPLOS: { etiqueta: string; texto: string; timestamp?: string }[] = [
  { etiqueta: 'Enunciado (22:40 del 5 en Cali)', texto: 'Hola, ¿tienen cita con dermatología mañana en la tarde?', timestamp: '2026-10-06T03:40:00Z' },
  { etiqueta: 'Fuera de los documentos', texto: '¿Cuánto cuesta la consulta de dermatología?' },
  { etiqueta: 'Sede inexistente', texto: 'Quiero cita de medicina general en la sede Centro el miércoles' },
  { etiqueta: 'Pedir un humano', texto: 'Quiero hablar con una persona' },
];

function telefonoAlAzar(): string {
  return `+57300${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
}

/** datetime-local (sin zona) interpretado en hora de Colombia, UTC-5 fijo. */
function aIsoColombia(local: string): string {
  return new Date(`${local}:00-05:00`).toISOString();
}

/** Escribe como paciente: manda al webhook y muestra la conversación mientras llega la respuesta. */
export function Simulador() {
  const [telefono, setTelefono] = useState(telefonoAlAzar);
  const [texto, setTexto] = useState('');
  const [horaActual, setHoraActual] = useState(true);
  const [horaLocal, setHoraLocal] = useState('2026-10-05T22:40');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<ErrorApi | Error | null>(null);
  const [conversacion, setConversacion] = useState<number | null>(null);

  const enviar = async (evento?: FormEvent, ejemplo?: (typeof EJEMPLOS)[number]) => {
    evento?.preventDefault();
    const cuerpoTexto = ejemplo?.texto ?? texto;
    setEnviando(true);
    setError(null);
    try {
      const respuesta = await api.enviar({
        message_id: `sim-${crypto.randomUUID()}`,
        from: telefono,
        text: cuerpoTexto,
        timestamp: ejemplo?.timestamp ?? (horaActual ? new Date().toISOString() : aIsoColombia(horaLocal)),
      });
      setConversacion(respuesta.conversacion_id);
      if (!ejemplo) setTexto('');
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="simulador">
      <form onSubmit={(e) => void enviar(e)}>
        <label>
          Teléfono del paciente
          <span className="en-linea">
            <input value={telefono} onChange={(e) => setTelefono(e.target.value)} />
            <button type="button" onClick={() => { setTelefono(telefonoAlAzar()); setConversacion(null); }}>
              Paciente nuevo
            </button>
          </span>
        </label>
        <label>
          Mensaje
          <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} placeholder="Escribe como paciente…" />
        </label>
        <label className="en-linea">
          <input type="checkbox" checked={horaActual} onChange={(e) => setHoraActual(e.target.checked)} /> Hora actual
          {!horaActual && (
            <>
              {' '}· hora de Colombia <input type="datetime-local" value={horaLocal} onChange={(e) => setHoraLocal(e.target.value)} />
            </>
          )}
        </label>
        <button type="submit" disabled={enviando || texto.trim() === ''}>
          {enviando ? 'Enviando…' : 'Enviar'}
        </button>
        <div className="ejemplos">
          Ejemplos:{' '}
          {EJEMPLOS.map((e) => (
            <button key={e.etiqueta} type="button" disabled={enviando} onClick={() => void enviar(undefined, e)}>
              {e.etiqueta}
            </button>
          ))}
        </div>
        {error && (
          <div className="aviso-error" role="alert">
            {error.message}
            {error instanceof ErrorApi && error.detalle.length > 0 && (
              <ul>
                {error.detalle.map((d) => (
                  <li key={d.campo}>
                    {d.campo}: {d.mensaje}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>
      <div className="panel">{conversacion ? <Detalle id={conversacion} /> : <p className="tenue">Envía un mensaje para ver la conversación.</p>}</div>
    </div>
  );
}
