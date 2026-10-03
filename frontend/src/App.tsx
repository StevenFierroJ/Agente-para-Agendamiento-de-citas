import { useEffect, useState } from 'react';
import { Bandeja } from './vistas/Bandeja';
import { Simulador } from './vistas/Simulador';

type Ruta = { vista: 'bandeja'; conversacion: number | null } | { vista: 'simulador' };

/** #/conversaciones/12 · #/conversaciones · #/simulador: el enlace a una conversación se puede compartir. */
function leerRuta(): Ruta {
  if (location.hash.startsWith('#/simulador')) return { vista: 'simulador' };
  const id = /^#\/conversaciones\/(\d+)/.exec(location.hash)?.[1];
  return { vista: 'bandeja', conversacion: id ? Number(id) : null };
}

export function App() {
  const [ruta, setRuta] = useState<Ruta>(leerRuta);
  useEffect(() => {
    const alCambiar = () => setRuta(leerRuta());
    window.addEventListener('hashchange', alCambiar);
    return () => window.removeEventListener('hashchange', alCambiar);
  }, []);

  return (
    <>
      <nav className="menu">
        <strong>Asistente de agendamiento</strong>
        <a href="#/conversaciones" className={ruta.vista === 'bandeja' ? 'activa' : ''}>
          Bandeja
        </a>
        <a href="#/simulador" className={ruta.vista === 'simulador' ? 'activa' : ''}>
          Simulador de paciente
        </a>
      </nav>
      <main>
        {ruta.vista === 'simulador' ? (
          <Simulador />
        ) : (
          <Bandeja seleccionada={ruta.conversacion} onSeleccionar={(id) => (location.hash = `#/conversaciones/${id}`)} />
        )}
      </main>
    </>
  );
}
