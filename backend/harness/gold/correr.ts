// Corre el goldset contra el sistema completo. Ver harness/README.md.
//
//   npm run harness:gold                          modo guion (no gasta)
//   npm run harness:gold -- --solo 'webhook-*,llm-timeout'
//   npm run harness:gold -- --modo real           gasta: usa el LLM del .env
//
// SE GUARDA TODO ANTES DE PUNTUAR
//   El transcript de cada caso (envíos, respuestas HTTP, turnos, respuestas,
//   pedidos al LLM) se escribe en out/ junto con la configuración de la corrida.
//   Un caso que falla tiene que poder leerse sin volver a correrlo.
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { leerConfig, preciosLlm } from '../../src/config.js';
import { crearHerramientas } from '../../src/aplicacion/herramientas/registro.js';
import type { LlmClient } from '../../src/aplicacion/puertos.js';
import { COLA_MENSAJES } from '../../src/infraestructura/cola/cola.js';
import { LlmGuionado, type PedidoRegistrado, type RespuestaGuionada } from '../../src/infraestructura/llm/falso.js';
import type { DocMensaje, DocTurno } from '../../src/infraestructura/mongo/mongo.js';
import { registroSilencioso } from '../../src/infraestructura/registro.js';
import { levantarSistema, type Sistema } from '../../src/sistema.js';
import {
  URL_MONGO_HARNESS, URL_POSTGRES_HARNESS, esperarProcesados, prepararBasesDelHarness, resolverHorario, resolverReferencias, sello,
} from '../comun.js';
import { SEED_DESDE_HARNESS, cargarCasos } from './cargar.js';
import type { CasoGold, PasoGuion } from './esquema.js';

type Modo = 'guion' | 'real';
type Envio = CasoGold['envios'][number];

interface ResultadoCaso {
  id: string;
  ok: boolean;
  fallas: string[];
  transcript: {
    envios: { message_id: string | null; http: number[] }[];
    turnos: DocTurno[];
    respuestas: DocMensaje[];
    pedidos_llm: PedidoRegistrado[];
  };
}

const TIMEOUT_CASO_MS = 20_000;
const DIRECTORIO_SALIDA = fileURLToPath(new URL('../out/', import.meta.url));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      modo: { type: 'string', default: 'guion' },
      solo: { type: 'string' },
    },
  });
  const modo = values.modo as Modo;
  if (modo !== 'guion' && modo !== 'real') throw new Error(`--modo debe ser guion o real; llegó "${values.modo}"`);

  const casos = filtrar(await cargarCasos(), values.solo).filter((c) => c.modos.includes(modo));
  if (casos.length === 0) {
    console.log('No hay casos que correr con esos filtros.');
    return 2;
  }

  const config = leerConfig({ ...process.env, DATABASE_URL: URL_POSTGRES_HARNESS, MONGO_URL: URL_MONGO_HARNESS });
  const llmGuionado = new LlmGuionado();
  const llm: LlmClient = modo === 'guion' ? llmGuionado : await crearLlmReal();

  console.log(`${casos.length} caso(s) · modo ${modo}${modo === 'guion' ? ' (LLM falso, no gasta)' : ' (GASTA)'}`);
  const sinValidar = casos.filter((c) => !c.validado_por).length;
  if (sinValidar) console.log(`  ${sinValidar} caso(s) sin revisión externa (validado_por: null)`);

  await prepararBasesDelHarness(SEED_DESDE_HARNESS);
  const sistema = await levantarSistema({
    databaseUrl: URL_POSTGRES_HARNESS,
    mongoUrl: URL_MONGO_HARNESS,
    registro: registroSilencioso,
    cola: { reintentos: 3 },
    trabajador: {
      llm,
      crearHerramientas: ({ agenda, mensajes }) => crearHerramientas({ agenda, catalogo: mensajes }),
      timeoutMs: modo === 'guion' ? 2_000 : config.LLM_TIMEOUT_MS,
      maxIteraciones: config.LLM_MAX_ITERACIONES,
      precios: preciosLlm(config),
      concurrencia: 5,
    },
  });
  await sistema.api.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(sistema.api.server.address() as AddressInfo).port}`;

  const resultados: ResultadoCaso[] = [];
  try {
    for (const caso of casos) {
      const resultado = await correrCaso(caso, modo, sistema, llmGuionado, base);
      resultados.push(resultado);
      console.log(`${resultado.ok ? '✓' : '✗'} ${caso.id}`);
      for (const falla of resultado.fallas) console.log(`    ${falla}`);
    }
  } finally {
    await sistema.detener();
  }

  await mkdir(DIRECTORIO_SALIDA, { recursive: true });
  const destino = path.join(DIRECTORIO_SALIDA, `gold-${modo}-${sello()}.json`);
  // La configuración viaja con la medición: se escribe ahora, no se lee del .env al reportar.
  await writeFile(
    destino,
    JSON.stringify(
      {
        modo,
        config: {
          modelo: modo === 'real' ? config.LLM_MODEL ?? null : 'falso-guionado',
          precios: preciosLlm(config),
          rag_umbral: config.RAG_UMBRAL ?? null,
          max_iteraciones: config.LLM_MAX_ITERACIONES,
          seed_desde: SEED_DESDE_HARNESS,
        },
        sin_validar: sinValidar,
        resultados,
      },
      null,
      1,
    ),
  );

  const fallidos = resultados.filter((r) => !r.ok);
  const turnos = resultados.flatMap((r) => r.transcript.turnos);
  const costos = turnos.map((t) => t.costo_usd);
  console.log(`\n${resultados.length - fallidos.length}/${resultados.length} casos en verde`);
  if (modo === 'real') {
    const tokens = turnos.reduce((s, t) => s + t.tokens_entrada + t.tokens_salida, 0);
    const costo = costos.some((c) => c === null) ? 'desconocido (faltan precios)' : `USD ${costos.reduce<number>((s, c) => s + (c ?? 0), 0).toFixed(4)}`;
    console.log(`tokens: ${tokens} · costo: ${costo}`);
  }
  console.log(`transcript → ${destino}`);
  return fallidos.length ? 1 : 0;
}

/** `--solo 'webhook-*,llm-timeout'`: ids exactos o prefijos con `*`. */
function filtrar(casos: CasoGold[], solo: string | undefined): CasoGold[] {
  if (!solo) return casos;
  const patrones = solo.split(',').map((p) => p.trim()).filter(Boolean);
  return casos.filter((c) => patrones.some((p) => (p.endsWith('*') ? c.id.startsWith(p.slice(0, -1)) : c.id === p)));
}

async function crearLlmReal(): Promise<LlmClient> {
  throw new Error('El modo real necesita el cliente del LLM real (paso 5).');
}

// ---------------------------------------------------------------------------
// Un caso
// ---------------------------------------------------------------------------

async function correrCaso(caso: CasoGold, modo: Modo, sistema: Sistema, llm: LlmGuionado, base: string): Promise<ResultadoCaso> {
  const fallas: string[] = [];
  await limpiar(sistema, llm);
  await preparar(caso, sistema.pool);

  if (modo === 'guion') {
    for (const envio of caso.envios) {
      if (envio.cuerpo && envio.guion) {
        llm.guionar(envio.cuerpo.message_id, await convertirGuion(envio.guion, sistema.pool));
      }
    }
  }

  // Envíos: los de un mismo grupo salen a la vez; el resto, en orden.
  const http = new Map<Envio, number[]>();
  for (const tanda of agruparEnvios(caso.envios)) {
    await Promise.all(tanda.map(async (envio) => http.set(envio, await mandar(base, envio))));
  }

  const aceptados = caso.envios.filter((e) => e.cuerpo && http.get(e)?.includes(202)).map((e) => e.cuerpo!.message_id);
  const pendientes = await esperarProcesados(sistema.pool, aceptados, TIMEOUT_CASO_MS);
  if (pendientes.length) fallas.push(`sin terminar tras ${TIMEOUT_CASO_MS} ms: ${pendientes.join(', ')}`);

  const ids = caso.envios.flatMap((e) => (e.cuerpo ? [e.cuerpo.message_id] : []));
  const turnos = await sistema.mongo.turnos.find({ _id: { $in: ids } }).toArray();
  const respuestas = await sistema.mongo.mensajes.find({ message_id: { $in: ids }, rol: 'asistente' }).toArray();
  const pedidos = llm.pedidos.filter((p) => ids.includes(p.etiqueta));

  for (const envio of caso.envios) {
    const nombre = envio.cuerpo?.message_id ?? 'cuerpo inválido';
    const codigos = http.get(envio) ?? [];
    if (JSON.stringify(codigos) !== JSON.stringify(envio.http)) {
      fallas.push(`${nombre}: HTTP ${JSON.stringify(codigos)}, se esperaba ${JSON.stringify(envio.http)}`);
    }
    if (!envio.cuerpo || !envio.http.includes(202)) continue;
    const id = envio.cuerpo.message_id;
    const turno = turnos.find((t) => t._id === id);
    const respuesta = respuestas.find((r) => r.message_id === id);
    if (!turno || !respuesta) {
      fallas.push(`${id}: no hay turno o respuesta en MongoDB`);
      continue;
    }
    if (modo === 'guion' && envio.espera) {
      fallas.push(...evaluarGuion(id, envio.espera, turno, respuesta, llm, pedidos));
    }
    if (modo === 'real' && envio.espera_real) {
      fallas.push(...evaluarReal(id, envio.espera_real, turno, respuesta));
    }
  }

  fallas.push(...(await evaluarFinal(caso, sistema)));
  fallas.push(...(await invariantes(caso, sistema, pedidos)));

  return {
    id: caso.id,
    ok: fallas.length === 0,
    fallas,
    transcript: {
      envios: caso.envios.map((e) => ({ message_id: e.cuerpo?.message_id ?? null, http: http.get(e) ?? [] })),
      turnos,
      respuestas,
      pedidos_llm: pedidos,
    },
  };
}

async function limpiar(sistema: Sistema, llm: LlmGuionado): Promise<void> {
  await sistema.boss.deleteAllJobs(COLA_MENSAJES);
  await sistema.pool.query('TRUNCATE citas, mensajes_entrantes, conversaciones RESTART IDENTITY CASCADE');
  await Promise.all([sistema.mongo.mensajes.deleteMany({}), sistema.mongo.turnos.deleteMany({})]);
  llm.olvidar();
}

async function preparar(caso: CasoGold, pool: pg.Pool): Promise<void> {
  const conversacion = async (telefono: string, estado: string) => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO conversaciones (telefono, estado, ultimo_mensaje_en) VALUES ($1, $2, now())
       ON CONFLICT (telefono) DO UPDATE SET estado = EXCLUDED.estado RETURNING id`,
      [telefono, estado],
    );
    return rows[0]!.id;
  };
  for (const telefono of caso.preparacion.escaladas) await conversacion(telefono, 'escalada');
  for (const cita of caso.preparacion.citas) {
    const conversacionId = await conversacion(cita.telefono, 'cita_agendada');
    const horarioId = await resolverHorario(pool, cita.horario);
    await pool.query('INSERT INTO citas (horario_id, conversacion_id, nombre_paciente) VALUES ($1, $2, $3)', [
      horarioId, conversacionId, cita.nombre_paciente,
    ]);
  }
}

async function convertirGuion(pasos: readonly PasoGuion[], pool: pg.Pool): Promise<RespuestaGuionada[]> {
  const convertidos: RespuestaGuionada[] = [];
  for (const paso of pasos) {
    if (paso.tipo !== 'herramientas') {
      convertidos.push(paso);
      continue;
    }
    const llamadas = [];
    for (const l of paso.llamadas) {
      const argumentosCrudos = l.argumentos_crudos ?? JSON.stringify(await resolverReferencias(pool, l.argumentos));
      llamadas.push({ nombre: l.nombre, argumentosCrudos });
    }
    convertidos.push({ tipo: 'herramientas', llamadas });
  }
  return convertidos;
}

function agruparEnvios(envios: readonly Envio[]): Envio[][] {
  const tandas: Envio[][] = [];
  for (const envio of envios) {
    const anterior = tandas.at(-1);
    if (envio.grupo && anterior?.[0]?.grupo === envio.grupo) anterior.push(envio);
    else tandas.push([envio]);
  }
  return tandas;
}

async function mandar(base: string, envio: Envio): Promise<number[]> {
  const cuerpo = JSON.stringify(envio.cuerpo ?? envio.cuerpo_crudo);
  const codigos: number[] = [];
  for (let i = 0; i < envio.envios; i++) {
    const r = await fetch(`${base}/webhooks/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: cuerpo });
    await r.arrayBuffer();
    codigos.push(r.status);
  }
  return codigos;
}

// ---------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------

function comoLista<T>(valor: T | T[]): T[] {
  return Array.isArray(valor) ? valor : [valor];
}

function evaluarGuion(
  id: string,
  espera: NonNullable<Envio['espera']>,
  turno: DocTurno,
  respuesta: DocMensaje,
  llm: LlmGuionado,
  pedidos: readonly PedidoRegistrado[],
): string[] {
  const fallas: string[] = [];
  const llamadas = llm.llamadasDe(id);
  if (espera.llamo_llm !== llamadas > 0) fallas.push(`${id}: llamadas al LLM = ${llamadas}, se esperaba llamo_llm=${espera.llamo_llm}`);
  if (llm.agotados.has(id)) fallas.push(`${id}: el sistema pidió más pasos de los que tenía el guion`);
  if (llm.pendientes(id) > 0) fallas.push(`${id}: quedaron ${llm.pendientes(id)} paso(s) del guion sin usar`);

  if (espera.herramientas) {
    const obtenidas = turno.herramientas.map((h) => `${h.nombre}:${h.error ?? 'ok'}`);
    const esperadas = espera.herramientas.map((h) => `${h.nombre}:${h.error ?? 'ok'}`);
    if (JSON.stringify(obtenidas) !== JSON.stringify(esperadas)) {
      fallas.push(`${id}: herramientas [${obtenidas.join(', ')}], se esperaba [${esperadas.join(', ')}]`);
    }
  }
  const estados = comoLista(espera.estado_final);
  if (!estados.includes(turno.estado_final)) fallas.push(`${id}: estado ${turno.estado_final}, se esperaba ${estados.join(' o ')}`);
  fallas.push(...revisarTexto(id, respuesta.texto, espera.respuesta_contiene, espera.respuesta_no_contiene));

  if (espera.prompt_contiene) {
    const sistemaPrompt = pedidos.find((p) => p.etiqueta === id)?.mensajes.find((m) => m.rol === 'sistema');
    const texto = sistemaPrompt && 'contenido' in sistemaPrompt ? sistemaPrompt.contenido : '';
    for (const fragmento of espera.prompt_contiene) {
      if (!texto.includes(fragmento)) fallas.push(`${id}: el prompt de sistema no contiene "${fragmento}"`);
    }
  }
  return fallas;
}

function evaluarReal(id: string, espera: NonNullable<Envio['espera_real']>, turno: DocTurno, respuesta: DocMensaje): string[] {
  const fallas: string[] = [];
  const estados = comoLista(espera.estado_final);
  if (!estados.includes(turno.estado_final)) fallas.push(`${id}: estado ${turno.estado_final}, se esperaba ${estados.join(' o ')}`);
  const usadas = new Set(turno.herramientas.map((h) => h.nombre));
  for (const nombre of espera.herramientas_incluye ?? []) if (!usadas.has(nombre)) fallas.push(`${id}: no usó ${nombre}`);
  for (const nombre of espera.herramientas_excluye ?? []) if (usadas.has(nombre)) fallas.push(`${id}: usó ${nombre} y no debía`);
  for (const esperada of espera.herramientas_con_argumentos ?? []) {
    const coincide = turno.herramientas.some(
      (h) =>
        h.nombre === esperada.nombre &&
        typeof h.argumentos === 'object' && h.argumentos !== null &&
        Object.entries(esperada.argumentos).every(([k, v]) => JSON.stringify((h.argumentos as Record<string, unknown>)[k]) === JSON.stringify(v)),
    );
    if (!coincide) fallas.push(`${id}: ninguna llamada a ${esperada.nombre} con ${JSON.stringify(esperada.argumentos)}`);
  }
  fallas.push(...revisarTexto(id, respuesta.texto, undefined, espera.respuesta_no_contiene));
  return fallas;
}

function revisarTexto(id: string, texto: string, contiene?: string[], noContiene?: string[]): string[] {
  const fallas: string[] = [];
  const t = texto.toLowerCase();
  for (const f of contiene ?? []) if (!t.includes(f.toLowerCase())) fallas.push(`${id}: la respuesta no contiene "${f}"`);
  for (const f of noContiene ?? []) if (t.includes(f.toLowerCase())) fallas.push(`${id}: la respuesta contiene "${f}"`);
  return fallas;
}

async function evaluarFinal(caso: CasoGold, sistema: Sistema): Promise<string[]> {
  const fallas: string[] = [];
  const espera = caso.espera_final;
  const { rows: conversaciones } = await sistema.pool.query<{ telefono: string; estado: string; citas: string }>(
    `SELECT c.telefono, c.estado, count(ci.id) FILTER (WHERE ci.estado = 'activa') AS citas
       FROM conversaciones c LEFT JOIN citas ci ON ci.conversacion_id = c.id GROUP BY c.id`,
  );
  for (const [telefono, esperada] of Object.entries(espera.conversaciones ?? {})) {
    const c = conversaciones.find((x) => x.telefono === telefono);
    if (!c) fallas.push(`final: no existe la conversación ${telefono}`);
    else if (c.estado !== esperada.estado || Number(c.citas) !== esperada.citas_activas) {
      fallas.push(`final: ${telefono} quedó ${c.estado} con ${c.citas} cita(s); se esperaba ${esperada.estado} con ${esperada.citas_activas}`);
    }
  }
  if (espera.conteo_estados) {
    const conteo: Record<string, number> = {};
    for (const c of conversaciones) conteo[c.estado] = (conteo[c.estado] ?? 0) + 1;
    for (const [estado, n] of Object.entries(espera.conteo_estados)) {
      if ((conteo[estado] ?? 0) !== n) fallas.push(`final: ${conteo[estado] ?? 0} conversación(es) en ${estado}, se esperaban ${n}`);
    }
  }
  if (espera.citas_activas_total !== undefined) {
    const total = conversaciones.reduce((s, c) => s + Number(c.citas), 0);
    if (total !== espera.citas_activas_total) fallas.push(`final: ${total} cita(s) activa(s), se esperaban ${espera.citas_activas_total}`);
  }
  if (espera.conversaciones_total !== undefined && conversaciones.length !== espera.conversaciones_total) {
    fallas.push(`final: ${conversaciones.length} conversación(es), se esperaban ${espera.conversaciones_total}`);
  }
  const turnos = await sistema.mongo.turnos.find({}).sort({ iniciado_en: 1 }).toArray();
  if (espera.turnos_total !== undefined && turnos.length !== espera.turnos_total) {
    fallas.push(`final: ${turnos.length} turno(s), se esperaban ${espera.turnos_total}`);
  }
  if (espera.turnos_en_serie) {
    const porConversacion = new Map<number, DocTurno[]>();
    for (const t of turnos) porConversacion.set(t.conversacion_id, [...(porConversacion.get(t.conversacion_id) ?? []), t]);
    for (const [conversacionId, lista] of porConversacion) {
      for (let i = 1; i < lista.length; i++) {
        const anterior = lista[i - 1]!;
        const actual = lista[i]!;
        if (actual.iniciado_en < anterior.terminado_en) fallas.push(`final: turnos solapados en la conversación ${conversacionId}`);
        if (actual.fecha < anterior.fecha) fallas.push(`final: turnos fuera de orden en la conversación ${conversacionId}`);
      }
    }
  }
  return fallas;
}

/** Lo que se revisa en todos los casos, aunque el caso no lo pida. */
async function invariantes(caso: CasoGold, sistema: Sistema, pedidos: readonly PedidoRegistrado[]): Promise<string[]> {
  const fallas: string[] = [];
  const telefonos = new Set([
    ...caso.envios.flatMap((e) => (e.cuerpo ? [e.cuerpo.from] : [])),
    ...caso.preparacion.escaladas,
    ...caso.preparacion.citas.map((c) => c.telefono),
  ]);
  const enviado = JSON.stringify(pedidos);
  for (const telefono of telefonos) {
    if (enviado.includes(telefono) || enviado.includes(telefono.replace(/^\+57/, ''))) {
      fallas.push(`invariante: el teléfono ${telefono} llegó al LLM`);
    }
  }
  const { rows: dobles } = await sistema.pool.query(
    `SELECT horario_id FROM citas WHERE estado = 'activa' GROUP BY horario_id HAVING count(*) > 1`,
  );
  if (dobles.length) fallas.push(`invariante: horarios con más de una cita activa: ${dobles.map((d) => d.horario_id).join(', ')}`);

  const { rows: mensajes } = await sistema.pool.query<{ message_id: string; estado: string }>(
    'SELECT message_id, estado FROM mensajes_entrantes',
  );
  for (const m of mensajes) {
    if (m.estado !== 'procesado') {
      fallas.push(`invariante: ${m.message_id} terminó en ${m.estado}`);
      continue;
    }
    const [turno, enMongo] = await Promise.all([
      sistema.mongo.turnos.countDocuments({ _id: m.message_id }),
      sistema.mongo.mensajes.countDocuments({ message_id: m.message_id }),
    ]);
    if (turno !== 1 || enMongo !== 2) fallas.push(`invariante: ${m.message_id} tiene ${turno} turno(s) y ${enMongo} mensaje(s) en MongoDB`);
  }
  return fallas;
}

main().then(
  (codigo) => process.exit(codigo),
  (error: unknown) => {
    console.error(error);
    process.exit(2);
  },
);
