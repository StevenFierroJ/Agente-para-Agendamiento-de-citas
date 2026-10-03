import { MongoClient, type Collection, type Db } from 'mongodb';
import type { EstadoFinalTurno } from '../../dominio/estados.js';

/**
 * Un mensaje de la conversación. `_id` determinista (`<message_id>:entrada|salida`):
 * un reintento del turno sobrescribe, no duplica.
 * `fecha` es la del mensaje del paciente para los dos; `orden` (0 entrada,
 * 1 salida) los ordena sin depender del reloj del servidor.
 */
export interface DocMensaje {
  _id: string;
  conversacion_id: number;
  message_id: string;
  rol: 'paciente' | 'asistente';
  texto: string;
  fecha: Date;
  orden: 0 | 1;
  guardado_en: Date;
}

export interface TrazaHerramienta {
  nombre: string;
  argumentos: unknown;
  resultado: unknown;
  error: string | null;
  duracion_ms: number;
}

export interface TrazaLlamadaLlm {
  intento: number;
  latencia_ms: number;
  tokens_entrada: number;
  tokens_salida: number;
  error: string | null;
}

/** Un turno: todo lo necesario para auditar y medir una respuesta. `_id` = message_id. */
export interface DocTurno {
  _id: string;
  conversacion_id: number;
  fecha: Date;
  iniciado_en: Date;
  terminado_en: Date;
  modelo: string | null;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number | null;
  latencia_ms: number;
  iteraciones: number;
  llamadas_llm: TrazaLlamadaLlm[];
  herramientas: TrazaHerramienta[];
  estado_final: EstadoFinalTurno;
  error: string | null;
}

export interface Mongo {
  cliente: MongoClient;
  db: Db;
  mensajes: Collection<DocMensaje>;
  turnos: Collection<DocTurno>;
  cerrar(): Promise<void>;
}

export async function conectarMongo(url: string): Promise<Mongo> {
  const cliente = new MongoClient(url, { serverSelectionTimeoutMS: 5_000 });
  await cliente.connect();
  const db = cliente.db();
  const mensajes = db.collection<DocMensaje>('mensajes');
  const turnos = db.collection<DocTurno>('turnos');
  // Historial de una conversación en orden; detalle de una conversación con sus turnos.
  await mensajes.createIndex({ conversacion_id: 1, fecha: 1, orden: 1 });
  await turnos.createIndex({ conversacion_id: 1, fecha: 1 });
  return { cliente, db, mensajes, turnos, cerrar: () => cliente.close() };
}

export async function guardarMensaje(mongo: Mongo, doc: DocMensaje): Promise<void> {
  await mongo.mensajes.replaceOne({ _id: doc._id }, doc, { upsert: true });
}

export async function guardarTurno(mongo: Mongo, doc: DocTurno): Promise<void> {
  await mongo.turnos.replaceOne({ _id: doc._id }, doc, { upsert: true });
}

/** Los últimos `limite` mensajes de la conversación, del más viejo al más nuevo. */
export async function leerHistorial(mongo: Mongo, conversacionId: number, limite: number): Promise<DocMensaje[]> {
  const recientes = await mongo.mensajes
    .find({ conversacion_id: conversacionId })
    .sort({ fecha: -1, orden: -1 })
    .limit(limite)
    .toArray();
  return recientes.reverse();
}
