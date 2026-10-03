import { DateTime } from 'luxon';

export const ZONA_COLOMBIA = 'America/Bogota';
export const DURACION_BLOQUE_MIN = 30;
export const DIAS_DE_AGENDA = 14;

export const SEDES = ['Sede Norte', 'Sede Sur'] as const;
export const ESPECIALIDADES = ['Medicina general', 'Dermatología', 'Pediatría'] as const;

type Sede = (typeof SEDES)[number];
type Especialidad = (typeof ESPECIALIDADES)[number];

/** Franja semanal: días ISO (1 = lunes … 5 = viernes) y horas en hora de Colombia. */
interface Franja {
  sede: Sede;
  dias: readonly number[];
  desde: string; // HH:mm
  hasta: string; // HH:mm
}

export interface PlantillaProfesional {
  nombre: string;
  especialidad: Especialidad;
  franjas: readonly Franja[];
}

const LUN_A_VIE = [1, 2, 3, 4, 5] as const;

// Repartidos para que haya mañana y tarde en cada sede, y especialidades que
// solo atienden en una sede ciertos días (casos de "sin_horarios").
export const PROFESIONALES: readonly PlantillaProfesional[] = [
  { nombre: 'Dra. Laura Gómez', especialidad: 'Medicina general',
    franjas: [{ sede: 'Sede Norte', dias: LUN_A_VIE, desde: '07:00', hasta: '12:00' }] },
  { nombre: 'Dr. Andrés Ruiz', especialidad: 'Medicina general',
    franjas: [{ sede: 'Sede Sur', dias: LUN_A_VIE, desde: '13:00', hasta: '18:00' }] },
  { nombre: 'Dra. Camila Restrepo', especialidad: 'Dermatología',
    franjas: [
      { sede: 'Sede Norte', dias: [1, 3, 5], desde: '14:00', hasta: '18:00' },
      { sede: 'Sede Sur', dias: [2, 4], desde: '08:00', hasta: '12:00' },
    ] },
  { nombre: 'Dr. Julián Mora', especialidad: 'Dermatología',
    franjas: [{ sede: 'Sede Sur', dias: [1, 3], desde: '14:00', hasta: '17:00' }] },
  { nombre: 'Dra. Natalia Ospina', especialidad: 'Pediatría',
    franjas: [{ sede: 'Sede Norte', dias: LUN_A_VIE, desde: '08:00', hasta: '12:00' }] },
  { nombre: 'Dr. Felipe Cárdenas', especialidad: 'Pediatría',
    franjas: [
      { sede: 'Sede Sur', dias: [1, 3, 5], desde: '08:00', hasta: '12:00' },
      { sede: 'Sede Norte', dias: [2, 4], desde: '14:00', hasta: '18:00' },
    ] },
];

export interface BloqueGenerado {
  profesional: string;
  sede: Sede;
  inicio: Date;
  fin: Date;
}

/**
 * Bloques de 30 minutos para `dias` días calendario a partir de `desde`
 * (incluido), según la plantilla. Las horas se interpretan en hora de Colombia.
 */
export function generarBloques(
  plantilla: readonly PlantillaProfesional[],
  desde: DateTime,
  dias: number = DIAS_DE_AGENDA,
): BloqueGenerado[] {
  const primerDia = desde.setZone(ZONA_COLOMBIA).startOf('day');
  const bloques: BloqueGenerado[] = [];

  for (let i = 0; i < dias; i++) {
    const dia = primerDia.plus({ days: i });
    for (const profesional of plantilla) {
      for (const franja of profesional.franjas) {
        if (!franja.dias.includes(dia.weekday)) continue;
        let inicio = enHora(dia, franja.desde);
        const limite = enHora(dia, franja.hasta);
        while (inicio.plus({ minutes: DURACION_BLOQUE_MIN }) <= limite) {
          const fin = inicio.plus({ minutes: DURACION_BLOQUE_MIN });
          bloques.push({ profesional: profesional.nombre, sede: franja.sede, inicio: inicio.toJSDate(), fin: fin.toJSDate() });
          inicio = fin;
        }
      }
    }
  }
  return bloques;
}

function enHora(dia: DateTime, horaMinuto: string): DateTime {
  const [hora, minuto] = horaMinuto.split(':').map(Number);
  if (hora === undefined || minuto === undefined || Number.isNaN(hora) || Number.isNaN(minuto)) {
    throw new Error(`Hora inválida en la plantilla: "${horaMinuto}"`);
  }
  return dia.set({ hour: hora, minute: minuto, second: 0, millisecond: 0 });
}

/** `SEED_DESDE` (YYYY-MM-DD en hora de Colombia) o, si está vacío, hoy en Colombia. */
export function resolverPrimerDia(seedDesde: string | undefined, ahora: DateTime = DateTime.now()): DateTime {
  if (!seedDesde) return ahora.setZone(ZONA_COLOMBIA).startOf('day');
  const fecha = DateTime.fromISO(seedDesde, { zone: ZONA_COLOMBIA });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seedDesde) || !fecha.isValid) {
    throw new Error(`SEED_DESDE debe tener el formato YYYY-MM-DD; llegó "${seedDesde}"`);
  }
  return fecha.startOf('day');
}
