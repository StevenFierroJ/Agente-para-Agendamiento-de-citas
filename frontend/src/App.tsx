import { useEffect, useState } from 'react';
import { Agenda } from './vistas/Agenda';
import { Bandeja } from './vistas/Bandeja';
import { Conocimiento } from './vistas/Conocimiento';
import { Simulador } from './vistas/Simulador';
import { Trazas } from './vistas/Trazas';

type Ruta =
  | { vista: 'bandeja'; conversacion: number | null }
  | { vista: 'agenda' }
  | { vista: 'conocimiento' }
  | { vista: 'trazas' }
  | { vista: 'simulador' };

/** #/conversaciones/12 · #/trazas · #/agenda · #/conocimiento · #/simulador: cada vista tiene su enlace. */
function leerRuta(): Ruta {
  if (location.hash.startsWith('#/simulador')) return { vista: 'simulador' };
  if (location.hash.startsWith('#/agenda')) return { vista: 'agenda' };
  if (location.hash.startsWith('#/conocimiento')) return { vista: 'conocimiento' };
  if (location.hash.startsWith('#/trazas')) return { vista: 'trazas' };
  const id = /^#\/conversaciones\/(\d+)/.exec(location.hash)?.[1];
  return { vista: 'bandeja', conversacion: id ? Number(id) : null };
}

const MENU: { vista: Ruta['vista']; href: string; icono: string; nombre: string; detalle: string }[] = [
  { vista: 'bandeja', href: '#/conversaciones', icono: '💬', nombre: 'Conversaciones', detalle: 'Bandeja y detalle' },
  { vista: 'trazas', href: '#/trazas', icono: '📊', nombre: 'Trazas', detalle: 'Cómo se comporta el modelo' },
  { vista: 'agenda', href: '#/agenda', icono: '📅', nombre: 'Agenda', detalle: 'Disponibilidad y citas' },
  { vista: 'conocimiento', href: '#/conocimiento', icono: '📚', nombre: 'Base de conocimiento', detalle: 'Lo que sabe el asistente' },
  { vista: 'simulador', href: '#/simulador', icono: '📱', nombre: 'Simulador', detalle: 'Escribir como paciente' },
];

const abrirConversacion = (id: number) => {
  location.hash = `#/conversaciones/${id}`;
};

export function App() {
  const [ruta, setRuta] = useState<Ruta>(leerRuta);
  useEffect(() => {
    const alCambiar = () => setRuta(leerRuta());
    window.addEventListener('hashchange', alCambiar);
    return () => window.removeEventListener('hashchange', alCambiar);
  }, []);

  return (
    <div className="marco">
      <nav className="lateral">
        <div className="marca">
          <span className="marca-logo">+</span>
          <span>
            <strong>Clínica</strong>
            <span className="tenue">Panel del coordinador</span>
          </span>
        </div>
        <ul>
          {MENU.map((m) => (
            <li key={m.vista}>
              <a href={m.href} className={ruta.vista === m.vista ? 'activa' : ''}>
                <span className="icono" aria-hidden>{m.icono}</span>
                <span>
                  <span className="menu-nombre">{m.nombre}</span>
                  <span className="menu-detalle">{m.detalle}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
        <p className="lateral-pie tenue">Horas en America/Bogota (UTC−5)</p>
      </nav>
      <main className="contenido">
        {ruta.vista === 'simulador' && <Simulador />}
        {ruta.vista === 'agenda' && <Agenda onAbrirConversacion={abrirConversacion} />}
        {ruta.vista === 'conocimiento' && <Conocimiento />}
        {ruta.vista === 'trazas' && <Trazas onAbrirConversacion={abrirConversacion} />}
        {ruta.vista === 'bandeja' && <Bandeja seleccionada={ruta.conversacion} onSeleccionar={abrirConversacion} />}
      </main>
    </div>
  );
}
