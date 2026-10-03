import type { Estado } from '../api';

const ETIQUETAS: Record<Estado, string> = {
  abierta: 'Abierta',
  resuelta_por_ia: 'Resuelta por IA',
  cita_agendada: 'Cita agendada',
  escalada: 'Escalada',
};

export function EtiquetaEstado({ estado }: { estado: Estado }) {
  return <span className={`estado estado-${estado}`}>{ETIQUETAS[estado]}</span>;
}

export function etiquetaEstado(estado: Estado): string {
  return ETIQUETAS[estado];
}

export function Aviso({ error, onReintentar }: { error: Error; onReintentar?: () => void }) {
  return (
    <div className="aviso-error" role="alert">
      {error.message}
      {onReintentar && (
        <button type="button" onClick={onReintentar}>
          Reintentar
        </button>
      )}
    </div>
  );
}
