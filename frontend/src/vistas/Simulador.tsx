import { useState, type FormEvent } from 'react';
import { ErrorApi, api, type RespuestaWebhook } from '../api';
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

type CuerpoWebhook = Parameters<typeof api.enviar>[0];

/** Escribe como paciente: manda al webhook y muestra la conversación mientras llega la respuesta. */
export function Simulador() {
  const [telefono, setTelefono] = useState(telefonoAlAzar);
  const [texto, setTexto] = useState('');
  const [horaActual, setHoraActual] = useState(true);
  const [horaLocal, setHoraLocal] = useState('2026-10-05T22:40');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<ErrorApi | Error | null>(null);
  const [conversacion, setConversacion] = useState<number | null>(null);
  const [ultimo, setUltimo] = useState<CuerpoWebhook | null>(null);
  const [recibo, setRecibo] = useState<RespuestaWebhook | null>(null);

  const mandar = async (cuerpo: CuerpoWebhook): Promise<boolean> => {
    setEnviando(true);
    setError(null);
    setRecibo(null);
    try {
      const respuesta = await api.enviar(cuerpo);
      setConversacion(respuesta.conversacion_id);
      setUltimo(cuerpo);
      setRecibo(respuesta);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return false;
    } finally {
      setEnviando(false);
    }
  };

  const enviar = async (evento?: FormEvent, ejemplo?: (typeof EJEMPLOS)[number]) => {
    evento?.preventDefault();
    const enviado = await mandar({
      message_id: `sim-${crypto.randomUUID()}`,
      from: telefono,
      text: ejemplo?.texto ?? texto,
      timestamp: ejemplo?.timestamp ?? (horaActual ? new Date().toISOString() : aIsoColombia(horaLocal)),
    });
    if (enviado && !ejemplo) setTexto('');
  };

  return (
    <div className="pagina">
      <header className="pagina-cabecera">
        <div>
          <h1>Simulador de paciente</h1>
          <p className="tenue">Envía mensajes al webhook como si llegaran por WhatsApp y mira la respuesta del asistente.</p>
        </div>
      </header>
    <div className="simulador">
      <form className="tarjeta" onSubmit={(e) => void enviar(e)}>
        <label>
          Teléfono del paciente
          <span className="en-linea">
            <input value={telefono} onChange={(e) => setTelefono(e.target.value)} />
            <button type="button" onClick={() => { setTelefono(telefonoAlAzar()); setConversacion(null); setUltimo(null); setRecibo(null); }}>
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
        <button
          type="button"
          disabled={enviando || ultimo === null}
          onClick={() => ultimo && void mandar(ultimo)}
          title="Simula que WhatsApp reenvía el mismo mensaje: el webhook debe responder «duplicado» y no procesarlo otra vez"
        >
          Reenviar el último (mismo message_id)
        </button>
        {recibo && (
          <div className="aviso-ok" role="status">
            {recibo.estado === 'duplicado'
              ? `200 · duplicado: ${recibo.message_id} ya había llegado y no se procesó otra vez.`
              : `202 · recibido: ${recibo.message_id} quedó en cola para el asistente.`}
          </div>
        )}
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
      <div className="tarjeta panel">{conversacion ? <Detalle id={conversacion} /> : <p className="vacio">Envía un mensaje para ver la conversación.</p>}</div>
    </div>
    </div>
  );
}
