import { MongoClient, type Collection, type Db } from 'mongodb';
import type { AlmacenConversaciones, RegistroMensaje, RegistroTurno } from '../../aplicacion/puertos.js';

export type DocMensaje = Omit<RegistroMensaje, 'id'> & { _id: string };
export type DocTurno = Omit<RegistroTurno, 'id'> & { _id: string };

export interface Mongo {
  cliente: MongoClient;
  db: Db;
  mensajes: Collection<DocMensaje>;
  turnos: Collection<DocTurno>;
  cerrar(): Promise<void>;
}

export async function conectarMongo(url: string): Promise<Mongo> {
  // Sin socketTimeoutMS, una operación contra un servidor que dejó de responder
  // espera para siempre; con él, falla y la cola reintenta el trabajo.
  const cliente = new MongoClient(url, { serverSelectionTimeoutMS: 5_000, socketTimeoutMS: 10_000 });
  await cliente.connect();
  const db = cliente.db();
  const mensajes = db.collection<DocMensaje>('mensajes');
  const turnos = db.collection<DocTurno>('turnos');
  // Historial de una conversación en orden; detalle de una conversación con sus turnos.
  await mensajes.createIndex({ conversacion_id: 1, fecha: 1, turno_iniciado_en: 1, orden: 1 });
  await turnos.createIndex({ conversacion_id: 1, fecha: 1 });
  // Vista de trazas: todos los turnos por hora del mensaje, del más reciente al más viejo,
  // con o sin filtro por estado final.
  await turnos.createIndex({ fecha: -1, _id: -1 });
  await turnos.createIndex({ estado_final: 1, fecha: -1, _id: -1 });
  return { cliente, db, mensajes, turnos, cerrar: () => cliente.close() };
}

/** Mensajes y turnos en MongoDB, con upsert sobre `_id` determinista. */
export class AlmacenMongo implements AlmacenConversaciones {
  constructor(private readonly mongo: Mongo) {}

  async guardarMensaje({ id, ...resto }: RegistroMensaje): Promise<void> {
    await this.mongo.mensajes.replaceOne({ _id: id }, resto, { upsert: true });
  }

  async guardarTurno({ id, ...resto }: RegistroTurno): Promise<void> {
    await this.mongo.turnos.replaceOne({ _id: id }, resto, { upsert: true });
  }

  async historial(conversacionId: number, limite: number): Promise<RegistroMensaje[]> {
    const recientes = await this.mongo.mensajes
      .find({ conversacion_id: conversacionId })
      .sort({ fecha: -1, turno_iniciado_en: -1, orden: -1 })
      .limit(limite)
      .toArray();
    return recientes.reverse().map(({ _id, ...resto }) => ({ id: _id, ...resto }));
  }
}
