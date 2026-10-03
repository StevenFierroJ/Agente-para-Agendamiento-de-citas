import { useCallback, useEffect, useRef, useState } from 'react';

export interface Consulta<T> {
  datos: T | null;
  error: Error | null;
  cargando: boolean;
  recargar: () => void;
}

/**
 * Consulta periódica. Al cambiar `clave` empieza de cero; al desmontar, aborta la
 * petición en vuelo. Si una consulta falla se conserva el último dato bueno y se
 * muestra el error. `intervaloMs` puede depender del dato (sondeo rápido mientras
 * el asistente responde); null = no repetir.
 */
export function useConsulta<T>(
  clave: string,
  cargar: (senal: AbortSignal) => Promise<T>,
  intervaloMs: (datos: T | null) => number | null,
): Consulta<T> {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [cargando, setCargando] = useState(true);
  const [vuelta, setVuelta] = useState(0);
  const cargarRef = useRef(cargar);
  const intervaloRef = useRef(intervaloMs);
  cargarRef.current = cargar;
  intervaloRef.current = intervaloMs;

  useEffect(() => {
    setDatos(null);
    setError(null);
    setCargando(true);
  }, [clave]);

  useEffect(() => {
    const controlador = new AbortController();
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    let vigente = true;

    const ciclo = async () => {
      let ultimo: T | null = null;
      try {
        ultimo = await cargarRef.current(controlador.signal);
        if (!vigente) return;
        setDatos(ultimo);
        setError(null);
      } catch (e) {
        if (!vigente || (e instanceof DOMException && e.name === 'AbortError')) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (vigente) setCargando(false);
      }
      const siguiente = intervaloRef.current(ultimo);
      if (vigente && siguiente !== null) temporizador = setTimeout(() => void ciclo(), siguiente);
    };
    void ciclo();

    return () => {
      vigente = false;
      controlador.abort();
      clearTimeout(temporizador);
    };
  }, [clave, vuelta]);

  const recargar = useCallback(() => setVuelta((v) => v + 1), []);
  return { datos, error, cargando, recargar };
}
