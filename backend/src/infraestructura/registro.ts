/** `+573001112233` → `+57300***2233`. El teléfono nunca sale completo en los registros. */
export function enmascararTelefono(telefono: string): string {
  if (telefono.length <= 8) return '***';
  return `${telefono.slice(0, 6)}***${telefono.slice(-4)}`;
}

export interface Registro {
  info(mensaje: string, datos?: Record<string, unknown>): void;
  error(mensaje: string, datos?: Record<string, unknown>): void;
}

/** Una línea JSON por evento, a stdout/stderr. */
export const registroConsola: Registro = {
  info: (mensaje, datos) => console.log(JSON.stringify({ nivel: 'info', mensaje, ...datos, en: new Date().toISOString() })),
  error: (mensaje, datos) => console.error(JSON.stringify({ nivel: 'error', mensaje, ...datos, en: new Date().toISOString() })),
};

export const registroSilencioso: Registro = { info: () => {}, error: () => {} };

export function describirError(error: unknown): string {
  if (error instanceof Error) return error.cause ? `${error.message} (${describirError(error.cause)})` : error.message;
  return String(error);
}
