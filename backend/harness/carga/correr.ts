// Harness de volumen. Ver harness/README.md.
//
//   npm run harness:carga
//   npm run harness:carga -- --mensajes 5000 --telefonos 500 --concurrencia 100 --caos-llm 0.05
//   npm run harness:carga -- --caos-mongo 8
//
// Dispara mensajes concurrentes (con duplicados y grupos que pelean por el mismo
// horario) contra el sistema completo con un LLM falso de latencia simulada, y al
// final verifica las invariantes. Cualquier violación → código de salida 1.
//
// LA CONFIGURACIÓN VIAJA CON LA MEDICIÓN
//   Cada corrida escribe out/carga-<sello>.json con la configuración y todas las
//   mediciones, y agrega una fila a METRICAS_CARGA.csv.
import { execFile } from 'node:child_process';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { DateTime } from 'luxon';
import pg from 'pg';
import { crearHerramientas } from '../../src/aplicacion/herramientas/registro.js';
import type { PedidoLlm } from '../../src/aplicacion/puertos.js';
import { EmbeddingFalso } from '../../src/infraestructura/embeddings/falso.js';
import { LlmGuionado, type RespuestaGuionada } from '../../src/infraestructura/llm/falso.js';
import { registroSilencioso } from '../../src/infraestructura/registro.js';
import { levantarSistema } from '../../src/sistema.js';
import { URL_MONGO_HARNESS, URL_POSTGRES_HARNESS, prepararBasesDelHarness, sello } from '../comun.js';
import { SEED_DESDE_HARNESS } from '../gold/cargar.js';

const DIRECTORIO_SALIDA = fileURLToPath(new URL('../out/', import.meta.url));
const CSV = fileURLToPath(new URL('./METRICAS_CARGA.csv', import.meta.url));
const CONTENEDOR_MONGO = process.env['HARNESS_CONTENEDOR_MONGO'] ?? 'prueba-we-kall-mongo-1';
const POR_GRUPO = 5;
const NOMBRES = ['Ana Pérez', 'Luis Gómez', 'Marta Silva', 'Jorge Ríos', 'Sofía Vega', 'Pedro Rojas', 'Laura Díaz', 'Carlos Mejía'];

interface Config {
  mensajes: number;
  telefonos: number;
  concurrencia: number;
  duplicados: number;
  contencion: number;
  latenciaMin: number;
  latenciaMax: number;
  trabajadores: number;
  semilla: number;
  caosLlm: number;
  caosMongo: number;
}

interface Envio {
  messageId: string;
  telefono: string;
  texto: string;
  timestamp: string;
  repetir: boolean;
  grupo: number | null;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const config = leerArgumentos();
  const azar = mulberry32(config.semilla);
  console.log(`carga: ${JSON.stringify(config)}`);

  await prepararBasesDelHarness(SEED_DESDE_HARNESS);

  // Horarios desde el martes 6 (los mensajes son del lunes): ninguno está en el pasado.
  const poolAux = new pg.Pool({ connectionString: URL_POSTGRES_HARNESS });
  const filasHorarios = (
    await poolAux.query<{ id: number; especialidad: string; sede: string; fecha: string; hora: string }>(
      `SELECT h.id, e.nombre AS especialidad, s.nombre AS sede,
              to_char(h.inicio AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS fecha,
              to_char(h.inicio AT TIME ZONE 'America/Bogota', 'HH24:MI') AS hora
         FROM horarios h JOIN profesionales p ON p.id = h.profesional_id
         JOIN especialidades e ON e.id = p.especialidad_id JOIN sedes s ON s.id = h.sede_id
        WHERE h.inicio >= '2026-10-06T05:00:00Z' ORDER BY h.id`,
    )
  ).rows;
  await poolAux.end();
  const horarios = filasHorarios.map((r) => r.id);
  // agendar_cita nombra el horario por especialidad, sede, fecha y hora (D-37).
  const enHora = new Map(filasHorarios.map(({ id, ...resto }) => [id, resto]));
  const disputados = horarios.slice(0, config.contencion);
  const libres = horarios.slice(config.contencion);

  const { envios, grupos } = generar(config, azar, disputados, libres);
  await ofrecerLoQueSeAgenda(envios);
  const caos = new Set(envios.filter(() => azar() < config.caosLlm).map((e) => e.messageId));

  const llm = new LlmGuionado({
    latenciaMs: () => config.latenciaMin + Math.floor(azar() * (config.latenciaMax - config.latenciaMin + 1)),
    porDefecto: responderPorDefecto(caos, enHora),
  });
  const sistema = await levantarSistema({
    databaseUrl: URL_POSTGRES_HARNESS,
    mongoUrl: URL_MONGO_HARNESS,
    registro: registroSilencioso,
    cola: { reintentos: 3 },
    trabajador: {
      llm,
      verificador: null,
      // Los mensajes de carga no usan el RAG: embeddings falsos, sin descargar el modelo.
      crearHerramientas: ({ agenda, mensajes, conocimiento }) =>
        crearHerramientas({ agenda, catalogo: mensajes, conocimiento: { embeddings: new EmbeddingFalso(), base: conocimiento, umbral: 0.5 } }),
      timeoutMs: config.latenciaMax + 2_000,
      maxIteraciones: 5,
      precios: { entrada: 1, salida: 5 },
      concurrencia: config.trabajadores,
    },
  });
  await sistema.api.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(sistema.api.server.address() as AddressInfo).port}`;

  // Profundidad de la cola durante la corrida.
  let colaMaxima = 0;
  let midiendo = true;
  const muestreo = (async () => {
    while (midiendo) {
      const { rows } = await sistema.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'mensajes' AND state IN ('created', 'retry', 'active')",
      );
      colaMaxima = Math.max(colaMaxima, rows[0]?.n ?? 0);
      await esperar(200);
    }
  })();

  const latenciasWebhook: number[] = [];
  const codigos = new Map<string, number[]>();
  const aceptadoEn = new Map<string, number>();
  const mandar = async (e: Envio) => {
    const veces = e.repetir ? 2 : 1;
    for (let i = 0; i < veces; i++) {
      const inicio = performance.now();
      const r = await fetch(`${base}/webhooks/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message_id: e.messageId, from: e.telefono, text: e.texto, timestamp: e.timestamp }),
      });
      await r.arrayBuffer();
      latenciasWebhook.push(performance.now() - inicio);
      codigos.set(e.messageId, [...(codigos.get(e.messageId) ?? []), r.status]);
      if (r.status === 202) aceptadoEn.set(e.messageId, Date.now());
    }
  };

  // Caos de MongoDB: pausa el contenedor a mitad de la corrida.
  const caosMongo = config.caosMongo > 0 ? pausarMongo(config.caosMongo) : Promise.resolve();

  const inicioCarga = performance.now();
  const conversaciones = [...agruparPorTelefono(envios.filter((e) => e.grupo === null)).values()];
  // Cada teléfono manda sus mensajes uno tras otro (como una persona); hasta
  // `concurrencia` teléfonos a la vez. Los grupos en disputa salen todos juntos.
  await Promise.all([
    enParalelo(conversaciones, config.concurrencia, async (lista) => {
      for (const e of lista) await mandar(e);
    }),
    ...[...grupos.values()].map((g) => Promise.all(g.map(mandar))),
  ]);
  const finEnvio = performance.now();

  const unicos = envios.map((e) => e.messageId);
  const pendientes = await esperarTodos(sistema.pool, unicos, 10 * 60_000);
  const finProceso = performance.now();
  midiendo = false;
  await muestreo;
  await caosMongo;

  // ---- Mediciones ----------------------------------------------------------
  const turnos = await sistema.mongo.turnos.find({}).toArray();
  const turnoPorId = new Map(turnos.map((t) => [t._id, t]));
  const latenciasE2e = unicos.flatMap((id) => {
    const t = turnoPorId.get(id);
    const desde = aceptadoEn.get(id);
    return t && desde ? [t.terminado_en.getTime() - desde] : [];
  });
  const todosLosCodigos = [...codigos.values()].flat();
  const { rows: reintentos } = await sistema.pool.query<{ reintentados: number; maximo: number | null }>(
    "SELECT count(*) FILTER (WHERE retry_count > 0)::int AS reintentados, max(retry_count) AS maximo FROM pgboss.job WHERE name = 'mensajes'",
  );
  const { rows: fallidos } = await sistema.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM mensajes_entrantes WHERE estado = 'fallido'",
  );
  const mediciones = {
    envios_http: todosLosCodigos.length,
    http: contar(todosLosCodigos.map(String)),
    webhook_rps: round(todosLosCodigos.length / ((finEnvio - inicioCarga) / 1000)),
    webhook_ms: percentiles(latenciasWebhook),
    extremo_a_extremo_ms: percentiles(latenciasE2e),
    vaciado_cola_s: round((finProceso - finEnvio) / 1000),
    duracion_total_s: round((finProceso - inicioCarga) / 1000),
    turnos_por_s: round(turnos.length / ((finProceso - inicioCarga) / 1000)),
    cola_maxima: colaMaxima,
    trabajos_reintentados: reintentos[0]?.reintentados ?? 0,
    reintento_maximo: reintentos[0]?.maximo ?? 0,
    mensajes_fallidos: fallidos[0]?.n ?? 0,
    estados_finales: contar(turnos.map((t) => t.estado_final)),
    llamadas_llm: llm.pedidos.length,
  };

  // ---- Invariantes ---------------------------------------------------------
  const violaciones = await verificar({ sistema, envios, codigos, grupos, caos, llm, pendientes, caosMongo: config.caosMongo > 0 });
  await sistema.detener();

  await mkdir(DIRECTORIO_SALIDA, { recursive: true });
  const marca = sello();
  const destino = path.join(DIRECTORIO_SALIDA, `carga-${marca}.json`);
  await writeFile(destino, JSON.stringify({ sello: marca, config, mediciones, violaciones }, null, 1));
  await agregarCsv(marca, config, mediciones, violaciones.length);

  console.log(JSON.stringify(mediciones, null, 2));
  if (violaciones.length) {
    console.log(`\n✗ ${violaciones.length} violación(es) de invariantes:`);
    for (const v of violaciones.slice(0, 30)) console.log(`  ${v}`);
  } else {
    console.log('\n✓ invariantes: sin violaciones');
  }
  console.log(`resultado → ${destino}`);
  return violaciones.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------

/**
 * Los AGENDAR del guion van directo a agendar_cita, sin consulta previa: se marcan
 * como ya ofrecidos a ese teléfono (D-34), para medir la contención y no la regla
 * de ofrecidos, que tiene sus tests y su caso de goldset.
 */
async function ofrecerLoQueSeAgenda(envios: readonly Envio[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: URL_POSTGRES_HARNESS });
  try {
    for (const e of envios) {
      const [orden, horario] = e.texto.split(' ');
      if (orden !== 'AGENDAR') continue;
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO conversaciones (telefono, ultimo_mensaje_en) VALUES ($1, now())
         ON CONFLICT (telefono) DO UPDATE SET telefono = EXCLUDED.telefono RETURNING id`,
        [e.telefono],
      );
      await pool.query('INSERT INTO horarios_ofrecidos (conversacion_id, horario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rows[0]!.id, Number(horario)]);
    }
  } finally {
    await pool.end();
  }
}

function generar(config: Config, azar: () => number, disputados: number[], libres: number[]) {
  const base = DateTime.fromISO('2026-10-05T13:00:00Z');
  const envios: Envio[] = [];
  const grupos = new Map<number, Envio[]>();
  const telefono = (i: number) => `+5731${String(i).padStart(8, '0')}`;
  const nombre = () => NOMBRES[Math.floor(azar() * NOMBRES.length)]!;

  // Grupos en disputa: POR_GRUPO teléfonos propios piden el mismo horario a la vez.
  let t = config.telefonos;
  for (const [g, horarioId] of disputados.entries()) {
    const grupo: Envio[] = [];
    for (let k = 0; k < POR_GRUPO; k++) {
      grupo.push({
        messageId: `carga.g${g}.${k}`,
        telefono: telefono(t++),
        texto: `AGENDAR ${horarioId} ${nombre()}`,
        timestamp: base.toISO()!,
        repetir: false,
        grupo: g,
      });
    }
    grupos.set(g, grupo);
    envios.push(...grupo);
  }

  // Mensajes comunes repartidos entre los teléfonos, con timestamps crecientes por teléfono.
  const siguiente = new Map<number, number>();
  for (let i = 0; i < config.mensajes; i++) {
    const tel = Math.floor(azar() * config.telefonos);
    const n = siguiente.get(tel) ?? 0;
    siguiente.set(tel, n + 1);
    const tipo = azar();
    const texto =
      tipo < 0.6 ? 'PREGUNTA ¿Qué horario tiene la sede?'
      : tipo < 0.85 ? 'CONSULTAR'
      : `AGENDAR ${libres[Math.floor(azar() * libres.length)]} ${nombre()}`;
    envios.push({
      messageId: `carga.${i}`,
      telefono: telefono(tel),
      texto,
      timestamp: base.plus({ minutes: n }).toISO()!,
      repetir: azar() < config.duplicados,
      grupo: null,
    });
  }
  return { envios, grupos };
}

/**
 * El LLM falso decide según el texto del último mensaje del paciente:
 * AGENDAR → agendar_cita, CONSULTAR → consultar_disponibilidad, otro → texto.
 * Después de un resultado de herramienta, responde texto. Las etiquetas de
 * `caos` fallan dos veces (llamada y reintento) para forzar el escalamiento.
 */
function responderPorDefecto(
  caos: ReadonlySet<string>,
  enHora: ReadonlyMap<number, { especialidad: string; sede: string; fecha: string; hora: string }>,
) {
  const fallas = new Map<string, number>();
  return (pedido: PedidoLlm): RespuestaGuionada => {
    if (caos.has(pedido.etiqueta)) {
      const n = fallas.get(pedido.etiqueta) ?? 0;
      if (n < 2) {
        fallas.set(pedido.etiqueta, n + 1);
        return { tipo: 'falla', falla: 'error_proveedor' };
      }
    }
    const ultimo = pedido.mensajes.at(-1);
    if (ultimo?.rol !== 'paciente') return { tipo: 'texto', texto: 'Listo.' };
    const [orden, horario, ...nombre] = ultimo.contenido.split(' ');
    if (orden === 'AGENDAR') {
      return {
        tipo: 'herramientas',
        llamadas: [{ nombre: 'agendar_cita', argumentosCrudos: JSON.stringify({ ...enHora.get(Number(horario)), nombre_paciente: nombre.join(' ') }) }],
      };
    }
    if (orden === 'CONSULTAR') {
      return {
        tipo: 'herramientas',
        llamadas: [{ nombre: 'consultar_disponibilidad', argumentosCrudos: JSON.stringify({ especialidad: 'Pediatría', sede: 'Sede Norte', fecha: '2026-10-07' }) }],
      };
    }
    return { tipo: 'texto', texto: 'La sede atiende de lunes a viernes.' };
  };
}

// ---------------------------------------------------------------------------
// Invariantes
// ---------------------------------------------------------------------------

async function verificar(ctx: {
  sistema: Awaited<ReturnType<typeof levantarSistema>>;
  envios: Envio[];
  codigos: Map<string, number[]>;
  grupos: Map<number, Envio[]>;
  caos: ReadonlySet<string>;
  llm: LlmGuionado;
  pendientes: string[];
  caosMongo: boolean;
}): Promise<string[]> {
  const { sistema, envios } = ctx;
  const v: string[] = [];

  // 5. Nada quedó a medias.
  if (ctx.pendientes.length) v.push(`5: ${ctx.pendientes.length} mensaje(s) sin terminar (${ctx.pendientes.slice(0, 5).join(', ')}…)`);

  // 2. Un 202 por message_id; los reenvíos, 200.
  for (const e of envios) {
    const c = ctx.codigos.get(e.messageId) ?? [];
    const esperado = e.repetir ? [202, 200] : [202];
    if (JSON.stringify(c) !== JSON.stringify(esperado)) v.push(`2: ${e.messageId} recibió ${JSON.stringify(c)}`);
  }

  // 1. Cada mensaje: una fila, procesado, un turno y dos mensajes en MongoDB.
  const { rows: filas } = await sistema.pool.query<{ message_id: string; estado: string; conversacion: string }>(
    `SELECT m.message_id, m.estado, c.estado AS conversacion FROM mensajes_entrantes m JOIN conversaciones c ON c.id = m.conversacion_id`,
  );
  if (filas.length !== envios.length) v.push(`1: ${filas.length} filas en mensajes_entrantes para ${envios.length} mensajes únicos`);
  const [turnosPorId, mensajesPorId] = await Promise.all([
    contarPorId(sistema.mongo.turnos.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$_id', n: { $sum: 1 } } }]).toArray()),
    contarPorId(sistema.mongo.mensajes.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$message_id', n: { $sum: 1 } } }]).toArray()),
  ]);
  for (const f of filas) {
    if (f.estado === 'fallido') {
      // Solo aceptable con caos de MongoDB (D-14), y siempre con la conversación escalada.
      if (!ctx.caosMongo) v.push(`1: ${f.message_id} terminó fallido sin caos de MongoDB`);
      if (f.conversacion !== 'escalada') v.push(`1: ${f.message_id} fallido pero la conversación quedó ${f.conversacion}`);
      continue;
    }
    if (f.estado !== 'procesado') continue; // contado en 5
    if (turnosPorId.get(f.message_id) !== 1) v.push(`1: ${f.message_id} tiene ${turnosPorId.get(f.message_id) ?? 0} turno(s)`);
    if (mensajesPorId.get(f.message_id) !== 2) v.push(`1: ${f.message_id} tiene ${mensajesPorId.get(f.message_id) ?? 0} mensaje(s) en MongoDB`);
  }

  // 3. Nunca dos citas activas por horario; cada horario disputado, exactamente una.
  const { rows: dobles } = await sistema.pool.query(
    "SELECT horario_id FROM citas WHERE estado = 'activa' GROUP BY horario_id HAVING count(*) > 1",
  );
  for (const d of dobles) v.push(`3: el horario ${d.horario_id} tiene más de una cita activa`);
  const turnos = await sistema.mongo.turnos.find({}).toArray();
  for (const [g, grupo] of ctx.grupos) {
    const resultados = grupo.flatMap((e) => turnos.find((t) => t._id === e.messageId)?.herramientas ?? []).filter((h) => h.nombre === 'agendar_cita');
    const exitos = resultados.filter((h) => h.error === null).length;
    const ocupados = resultados.filter((h) => h.error === 'horario_ocupado').length;
    const sinLlm = grupo.filter((e) => ctx.caos.has(e.messageId)).length;
    if (exitos !== 1 || exitos + ocupados !== grupo.length - sinLlm) {
      v.push(`3: grupo ${g}: ${exitos} cita(s) y ${ocupados} horario_ocupado de ${grupo.length} pedidos`);
    }
  }

  // 4. Turnos de una conversación: sin solaparse y en orden de timestamp.
  const porConversacion = new Map<number, typeof turnos>();
  for (const t of turnos) porConversacion.set(t.conversacion_id, [...(porConversacion.get(t.conversacion_id) ?? []), t]);
  for (const [id, lista] of porConversacion) {
    lista.sort((a, b) => a.iniciado_en.getTime() - b.iniciado_en.getTime());
    for (let i = 1; i < lista.length; i++) {
      if (lista[i]!.iniciado_en < lista[i - 1]!.terminado_en) v.push(`4: turnos solapados en la conversación ${id}`);
      if (lista[i]!.fecha < lista[i - 1]!.fecha) v.push(`4: turnos fuera de orden en la conversación ${id}`);
    }
  }

  // 6. Con caos del LLM: cada mensaje que llegó a fallar dos veces escaló por falla.
  const conFalla = turnos.filter((t) => t.error?.startsWith('falla_llm')).map((t) => t._id);
  const caosQueLlegaron = [...ctx.caos].filter((id) => ctx.llm.llamadasDe(id) >= 2);
  if (conFalla.length !== caosQueLlegaron.length) {
    v.push(`6: ${conFalla.length} turno(s) con falla del LLM para ${caosQueLlegaron.length} falla(s) inyectada(s)`);
  }

  // 7. Ningún pedido al LLM lleva un teléfono.
  const telefonos = new Set(envios.map((e) => e.telefono));
  for (const p of ctx.llm.pedidos) {
    const texto = JSON.stringify(p.mensajes);
    for (const tel of telefonos) {
      if (texto.includes(tel) || texto.includes(tel.slice(3))) {
        v.push(`7: el teléfono ${tel} llegó al LLM en ${p.etiqueta}`);
        break;
      }
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function leerArgumentos(): Config {
  const { values } = parseArgs({
    options: {
      mensajes: { type: 'string', default: '2000' },
      telefonos: { type: 'string', default: '300' },
      concurrencia: { type: 'string', default: '50' },
      duplicados: { type: 'string', default: '0.1' },
      contencion: { type: 'string', default: '20' },
      'latencia-llm': { type: 'string', default: '300-1500' },
      trabajadores: { type: 'string', default: '20' },
      semilla: { type: 'string', default: '42' },
      'caos-llm': { type: 'string', default: '0' },
      'caos-mongo': { type: 'string', default: '0' },
    },
  });
  const [min, max] = values['latencia-llm']!.split('-').map(Number);
  const config: Config = {
    mensajes: Number(values.mensajes),
    telefonos: Number(values.telefonos),
    concurrencia: Number(values.concurrencia),
    duplicados: Number(values.duplicados),
    contencion: Number(values.contencion),
    latenciaMin: min ?? NaN,
    latenciaMax: max ?? NaN,
    trabajadores: Number(values.trabajadores),
    semilla: Number(values.semilla),
    caosLlm: Number(values['caos-llm']),
    caosMongo: Number(values['caos-mongo']),
  };
  for (const [clave, valor] of Object.entries(config)) {
    if (!Number.isFinite(valor) || valor < 0) throw new Error(`Argumento inválido: ${clave} = ${String(valor)}`);
  }
  if (config.latenciaMin > config.latenciaMax) throw new Error('--latencia-llm: el mínimo supera al máximo');
  return config;
}

function agruparPorTelefono(envios: Envio[]): Map<string, Envio[]> {
  const mapa = new Map<string, Envio[]>();
  for (const e of envios) mapa.set(e.telefono, [...(mapa.get(e.telefono) ?? []), e]);
  return mapa;
}

async function enParalelo<T>(items: readonly T[], limite: number, fn: (item: T) => Promise<void>): Promise<void> {
  let siguiente = 0;
  const trabajar = async () => {
    while (siguiente < items.length) await fn(items[siguiente++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajar));
}

async function esperarTodos(pool: pg.Pool, ids: string[], timeoutMs: number): Promise<string[]> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ message_id: string }>(
      "SELECT message_id FROM mensajes_entrantes WHERE estado NOT IN ('procesado', 'fallido')",
    );
    const { rows: total } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM mensajes_entrantes');
    if ((rows.length === 0 && (total[0]?.n ?? 0) >= ids.length) || Date.now() > limite) return rows.map((r) => r.message_id);
    await esperar(250);
  }
}

async function pausarMongo(segundos: number): Promise<void> {
  const docker = promisify(execFile);
  await esperar(3_000);
  console.log(`caos: pausando ${CONTENEDOR_MONGO} por ${segundos} s`);
  await docker('docker', ['pause', CONTENEDOR_MONGO]);
  try {
    await esperar(segundos * 1000);
  } finally {
    await docker('docker', ['unpause', CONTENEDOR_MONGO]);
    console.log('caos: MongoDB reanudado');
  }
}

async function contarPorId(filas: Promise<{ _id: string; n: number }[]>): Promise<Map<string, number>> {
  return new Map((await filas).map((f) => [f._id, f.n]));
}

function percentiles(valores: number[]) {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const p = (q: number) => round(orden[Math.min(orden.length - 1, Math.floor(q * orden.length))]!);
  return { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: round(orden.at(-1)!) };
}

function contar(valores: string[]): Record<string, number> {
  const r: Record<string, number> = {};
  for (const x of valores) r[x] = (r[x] ?? 0) + 1;
  return r;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** PRNG con semilla: dos corridas con la misma semilla generan la misma carga. */
function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function agregarCsv(marca: string, config: Config, m: Record<string, unknown>, violaciones: number): Promise<void> {
  const columnas = [
    'snapshot', 'sello', 'mensajes', 'telefonos', 'concurrencia', 'duplicados', 'contencion', 'latencia_llm', 'trabajadores',
    'caos_llm', 'caos_mongo', 'semilla', 'webhook_rps', 'webhook_p50', 'webhook_p95', 'webhook_p99', 'e2e_p50', 'e2e_p95',
    'e2e_p99', 'vaciado_cola_s', 'cola_maxima', 'turnos_por_s', 'trabajos_reintentados', 'mensajes_fallidos', 'violaciones',
  ];
  const w = m['webhook_ms'] as Record<string, number> | null;
  const e = m['extremo_a_extremo_ms'] as Record<string, number> | null;
  const fila = [
    DateTime.now().toISODate(), marca, config.mensajes, config.telefonos, config.concurrencia, config.duplicados, config.contencion,
    `${config.latenciaMin}-${config.latenciaMax}`, config.trabajadores, config.caosLlm, config.caosMongo, config.semilla,
    m['webhook_rps'], w?.['p50'], w?.['p95'], w?.['p99'], e?.['p50'], e?.['p95'], e?.['p99'],
    m['vaciado_cola_s'], m['cola_maxima'], m['turnos_por_s'], m['trabajos_reintentados'], m['mensajes_fallidos'], violaciones,
  ];
  const existe = await stat(CSV).then(() => true, () => false);
  await appendFile(CSV, `${existe ? '' : `${columnas.join(',')}\n`}${fila.join(',')}\n`);
}

main().then(
  (codigo) => process.exit(codigo),
  (error: unknown) => {
    console.error(error);
    process.exit(2);
  },
);
