// Evaluación de punta a punta del RAG con el modelo real: ¿el asistente responde
// bien lo que está en los documentos y se abstiene de lo que no está?
//
//   npm run harness:rag-e2e            (GASTA: ~40 turnos de Haiku + 40 juicios)
//
// Cada pregunta del goldset pasa por el ciclo completo del asistente (Haiku,
// herramientas reales, umbral calibrado, barandilla de datos). Un juez de otro
// modelo (Sonnet, para que el generador no se califique a sí mismo) clasifica la
// respuesta con el corpus completo a la vista:
//   correcta    responde con el dato de referencia, sin datos inventados
//   abstiene    dice que no tiene el dato u ofrece un asesor, sin inventar
//   inventa     afirma algo concreto que los documentos no respaldan
//   incorrecta  responde, pero contradice la referencia o no responde lo pedido
//
// EL COSTO DEL JUEZ VA APARTE
//   El juez es andamio: en producción no existe. Se informan las dos cifras, nunca
//   sumadas (el mismo criterio del harness de Morton).
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { DateTime } from 'luxon';
import pg from 'pg';
import { z } from 'zod';
import { crearHerramientas } from '../../src/aplicacion/herramientas/registro.js';
import { ejecutarTurno } from '../../src/aplicacion/orquestador.js';
import { construirPromptSistema } from '../../src/aplicacion/prompt.js';
import { leerConfig, preciosLlm } from '../../src/config.js';
import { ahoraDelMensaje, contextoTemporal } from '../../src/dominio/fechas.js';
import { EmbeddingE5 } from '../../src/infraestructura/embeddings/e5.js';
import { crearLlmReal, crearVerificadorReal } from '../../src/infraestructura/llm/crear.js';
import { AgendaPostgres } from '../../src/infraestructura/postgres/agenda.js';
import { ConocimientoPostgres } from '../../src/infraestructura/postgres/conocimiento.js';
import { RepositorioMensajesPostgres } from '../../src/infraestructura/postgres/mensajes.js';
import { DIRECTORIO_DOCUMENTOS } from '../../seed/documentos.js';
import { URL_MONGO_HARNESS, URL_POSTGRES_HARNESS, prepararBasesDelHarness, sello } from '../comun.js';
import { SEED_DESDE_HARNESS } from '../gold/cargar.js';
import type { GoldsetRag } from './evaluar.js';

const MODELO_JUEZ = process.env['JUEZ_MODELO'] ?? 'claude-sonnet-5-5';
// Precios de la página oficial, consultada el 2026-10-03 (USD por millón de tokens).
const PRECIO_JUEZ = { entrada: 2, salida: 10 };
const DIRECTORIO_SALIDA = fileURLToPath(new URL('../out/', import.meta.url));
const CSV = fileURLToPath(new URL('./METRICAS_RAG_E2E.csv', import.meta.url));
const AHORA = new Date('2026-10-05T14:00:00Z'); // lunes 9:00 a. m. en Cali

const Veredicto = z.object({
  veredicto: z.enum(['correcta', 'abstiene', 'inventa', 'incorrecta']),
  datos_inventados: z.array(z.string()),
  razon: z.string(),
});
type Veredicto = z.infer<typeof Veredicto>;

interface Resultado extends Caso, Veredicto {
  respuesta: string;
  estado_final: string;
  herramientas: string[];
  controles: string[];
  tokens_entrada: number;
  tokens_salida: number;
  juez_rejuzgado: boolean;
  juez_inconsistente: boolean;
}

interface Caso {
  pregunta: string;
  conRespuesta: boolean;
  referencia: string;
  tipo?: string;
}

async function main(): Promise<number> {
  const config = leerConfig({ ...process.env, DATABASE_URL: URL_POSTGRES_HARNESS, MONGO_URL: URL_MONGO_HARNESS });
  if (!config.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY en .env');
  const gold = JSON.parse(await readFile(new URL('./preguntas.json', import.meta.url), 'utf8')) as GoldsetRag;
  const casos: Caso[] = [
    ...gold.con_respuesta.map((p) => ({ pregunta: p.pregunta, conRespuesta: true, referencia: p.dato })),
    ...gold.sin_respuesta.map((p) => ({ pregunta: p.pregunta, conRespuesta: false, referencia: 'Los documentos NO contienen esta información.', tipo: p.tipo })),
  ];
  const corpus = await leerCorpus();
  console.log(`${casos.length} preguntas · generador ${config.LLM_MODEL} · juez ${MODELO_JUEZ} · umbral ${config.RAG_UMBRAL} (GASTA)`);

  const embeddings = new EmbeddingE5();
  await prepararBasesDelHarness(SEED_DESDE_HARNESS, embeddings);
  const pool = new pg.Pool({ connectionString: URL_POSTGRES_HARNESS });
  const llm = crearLlmReal(config);
  const juez = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const mensajes = new RepositorioMensajesPostgres(pool);
  const herramientas = crearHerramientas({
    agenda: new AgendaPostgres(pool),
    catalogo: mensajes,
    conocimiento: { embeddings, base: new ConocimientoPostgres(pool), umbral: config.RAG_UMBRAL },
  });
  const catalogo = await mensajes.catalogo();
  const ahora = ahoraDelMensaje(AHORA);
  const promptSistema = construirPromptSistema({
    tiempo: contextoTemporal(ahora),
    sedes: catalogo.sedes.map((s) => s.nombre),
    especialidades: catalogo.especialidades.map((e) => e.nombre),
  });
  const { rows } = await pool.query<{ id: number }>("INSERT INTO conversaciones (telefono, ultimo_mensaje_en) VALUES ('+573999999999', now()) RETURNING id");
  const conversacionId = rows[0]!.id;

  const resultados: Resultado[] = [];
  let tokensJuez = { entrada: 0, salida: 0 };
  try {
    for (const [i, caso] of casos.entries()) {
      const turno = await ejecutarTurno(
        {
          messageId: `e2e.${i}`,
          conversacionId,
          estadoConversacion: 'abierta',
          citasActivas: 0,
          ahora,
          promptSistema,
          historial: [{ rol: 'paciente', contenido: caso.pregunta }],
        },
        { llm, herramientas, timeoutMs: config.LLM_TIMEOUT_MS, maxIteraciones: config.LLM_MAX_ITERACIONES, verificador: crearVerificadorReal(config) },
      );
      const juicio = await juzgarConConsistencia(juez, corpus, caso, turno.respuesta);
      tokensJuez = { entrada: tokensJuez.entrada + juicio.tokensEntrada, salida: tokensJuez.salida + juicio.tokensSalida };
      const fila: Resultado = {
        ...caso,
        respuesta: turno.respuesta,
        estado_final: turno.estadoFinal,
        herramientas: turno.herramientas.map((h) => `${h.nombre}:${h.error ?? 'ok'}`),
        controles: turno.controles.map((c) => `${c.accion}:${c.datos.join('|')}`),
        tokens_entrada: turno.tokensEntrada,
        tokens_salida: turno.tokensSalida,
        ...juicio.veredicto,
        juez_rejuzgado: juicio.rejuzgado,
        juez_inconsistente: 'inconsistente' in juicio ? juicio.inconsistente : false,
      };
      resultados.push(fila);
      const marca = { correcta: '✓', abstiene: '·', inventa: '✗', incorrecta: '≠' }[fila.veredicto];
      console.log(`${marca} [${caso.conRespuesta ? 'con' : 'sin'}] ${fila.veredicto.padEnd(10)} ${caso.pregunta}${fila.controles.length ? `  (barandilla: ${fila.controles.join('; ')})` : ''}`);
    }
  } finally {
    await pool.end();
  }

  // ---- Métricas ------------------------------------------------------------
  const con = resultados.filter((r) => r.conRespuesta);
  const sin = resultados.filter((r) => !r.conRespuesta);
  const tasa = (lista: typeof resultados, v: Veredicto['veredicto']) => lista.filter((r) => r.veredicto === v).length / (lista.length || 1);
  const precios = preciosLlm(config);
  const tokensGen = resultados.reduce((s, r) => ({ entrada: s.entrada + r.tokens_entrada, salida: s.salida + r.tokens_salida }), { entrada: 0, salida: 0 });
  const usd = (t: { entrada: number; salida: number }, p: { entrada: number; salida: number } | null) =>
    p ? (t.entrada * p.entrada + t.salida * p.salida) / 1_000_000 : null;
  const metricas = {
    con_respuesta: { n: con.length, exactitud: tasa(con, 'correcta'), abstencion_indebida: tasa(con, 'abstiene'), invencion: tasa(con, 'inventa'), incorrecta: tasa(con, 'incorrecta') },
    sin_respuesta: {
      n: sin.length,
      abstencion_correcta: tasa(sin, 'abstiene'),
      invencion: tasa(sin, 'inventa'),
      invencion_dominio_cercano: tasa(sin.filter((r) => r.tipo === 'dominio_cercano'), 'inventa'),
      invencion_fuera_de_dominio: tasa(sin.filter((r) => r.tipo === 'fuera_de_dominio'), 'inventa'),
    },
    invencion_global: tasa(resultados, 'inventa'),
    barandilla_activaciones: resultados.filter((r) => r.controles.length > 0).length,
    juez_rejuzgados: resultados.filter((r) => r.juez_rejuzgado).length,
    juez_inconsistentes: resultados.filter((r) => r.juez_inconsistente).length,
    escaladas: resultados.filter((r) => r.estado_final === 'escalada').length,
    usd_generador: usd(tokensGen, precios),
    usd_por_pregunta: usd(tokensGen, precios) === null ? null : usd(tokensGen, precios)! / resultados.length,
    usd_juez_andamio: usd(tokensJuez, PRECIO_JUEZ),
  };

  const pct = (x: number) => `${(x * 100).toFixed(0)} %`;
  console.log(`\nCON RESPUESTA (${con.length}): exactitud ${pct(metricas.con_respuesta.exactitud)} · abstención indebida ${pct(metricas.con_respuesta.abstencion_indebida)} · invención ${pct(metricas.con_respuesta.invencion)} · incorrecta ${pct(metricas.con_respuesta.incorrecta)}`);
  console.log(`SIN RESPUESTA (${sin.length}): abstención correcta ${pct(metricas.sin_respuesta.abstencion_correcta)} · invención ${pct(metricas.sin_respuesta.invencion)} (dominio cercano ${pct(metricas.sin_respuesta.invencion_dominio_cercano)}, fuera ${pct(metricas.sin_respuesta.invencion_fuera_de_dominio)})`);
  console.log(`invención global ${pct(metricas.invencion_global)} · barandilla activada ${metricas.barandilla_activaciones} · escaladas ${metricas.escaladas} · juez: ${metricas.juez_rejuzgados} rejuzgado(s), ${metricas.juez_inconsistentes} inconsistente(s)`);
  console.log(`costo generador USD ${metricas.usd_generador?.toFixed(4) ?? '?'} (${metricas.usd_por_pregunta?.toFixed(5) ?? '?'} por pregunta) · juez (andamio, no es costo de producción) USD ${metricas.usd_juez_andamio?.toFixed(4)}`);
  for (const r of resultados.filter((x) => x.veredicto === 'inventa' || x.veredicto === 'incorrecta')) {
    console.log(`\n${r.veredicto.toUpperCase()}: ${r.pregunta}\n  respuesta: ${r.respuesta.replace(/\n+/g, ' / ')}\n  juez: ${r.razon}`);
  }

  await mkdir(DIRECTORIO_SALIDA, { recursive: true });
  const marca = sello();
  const destino = path.join(DIRECTORIO_SALIDA, `rag-e2e-${marca}.json`);
  await writeFile(destino, JSON.stringify({ config: { generador: config.LLM_MODEL, juez: MODELO_JUEZ, umbral: config.RAG_UMBRAL }, metricas, resultados }, null, 1));
  await agregarCsv([
    DateTime.now().toISODate(), marca, config.LLM_MODEL, MODELO_JUEZ, config.RAG_UMBRAL, con.length, sin.length,
    metricas.con_respuesta.exactitud.toFixed(3), metricas.con_respuesta.abstencion_indebida.toFixed(3), metricas.con_respuesta.invencion.toFixed(3),
    metricas.sin_respuesta.abstencion_correcta.toFixed(3), metricas.sin_respuesta.invencion.toFixed(3), metricas.invencion_global.toFixed(3),
    metricas.barandilla_activaciones, metricas.escaladas, metricas.usd_por_pregunta?.toFixed(5) ?? '',
  ]);
  console.log(`\ndetalle → ${destino}`);
  return 0;
}

async function juzgar(juez: Anthropic, corpus: string, caso: Caso, respuesta: string, esfuerzo: 'medium' | 'high') {
  const r = await juez.messages.parse({
    model: MODELO_JUEZ,
    max_tokens: 4000,
    output_config: { effort: esfuerzo, format: zodOutputFormat(Veredicto) },
    system: [
      'Eres un evaluador estricto de un asistente de WhatsApp de una clínica. Juzgas UNA respuesta.',
      'Los documentos de la clínica son la única fuente válida. Clasifica:',
      '- correcta: responde lo preguntado con el dato de referencia y no afirma nada que los documentos no respalden.',
      '- abstiene: dice que no tiene la información y/u ofrece un asesor, sin afirmar datos no respaldados.',
      '- inventa: afirma algún dato concreto (cifra, precio, teléfono, horario, servicio, nombre) que los documentos no respaldan.',
      '- incorrecta: responde pero contradice la referencia o no responde lo preguntado.',
      'Ofrecer agendar una cita o comunicar con un asesor no es inventar. Lista en datos_inventados cada afirmación no respaldada.',
      '',
      '<documentos>',
      corpus,
      '</documentos>',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: `<pregunta>${caso.pregunta}</pregunta>\n<referencia>${caso.referencia}</referencia>\n<respuesta>${respuesta}</respuesta>`,
      },
    ],
  });
  if (!r.parsed_output) throw new Error(`El juez no devolvió un veredicto válido para: ${caso.pregunta}`);
  return { veredicto: r.parsed_output, tokensEntrada: r.usage.input_tokens, tokensSalida: r.usage.output_tokens };
}

/**
 * Un juez que dice "inventa" sin nombrar ningún dato inventado se contradice
 * (pasó: razonó "sería correcta" y marcó inventa). Se vuelve a juzgar con más
 * esfuerzo; si sigue inconsistente, el veredicto queda marcado.
 */
async function juzgarConConsistencia(juez: Anthropic, corpus: string, caso: Caso, respuesta: string) {
  const primero = await juzgar(juez, corpus, caso, respuesta, 'medium');
  if (primero.veredicto.veredicto !== 'inventa' || primero.veredicto.datos_inventados.length > 0) return { ...primero, rejuzgado: false };
  const segundo = await juzgar(juez, corpus, caso, respuesta, 'high');
  return {
    veredicto: segundo.veredicto,
    tokensEntrada: primero.tokensEntrada + segundo.tokensEntrada,
    tokensSalida: primero.tokensSalida + segundo.tokensSalida,
    rejuzgado: true,
    inconsistente: segundo.veredicto.veredicto === 'inventa' && segundo.veredicto.datos_inventados.length === 0,
  };
}

async function leerCorpus(): Promise<string> {
  const archivos = (await readdir(DIRECTORIO_DOCUMENTOS)).filter((a) => a.endsWith('.md')).sort();
  const textos = await Promise.all(archivos.map((a) => readFile(path.join(DIRECTORIO_DOCUMENTOS, a), 'utf8')));
  return textos.join('\n\n');
}

async function agregarCsv(fila: (string | number | null)[]): Promise<void> {
  const columnas = [
    'snapshot', 'sello', 'generador', 'juez', 'umbral', 'n_con', 'n_sin', 'exactitud', 'abstencion_indebida', 'invencion_con',
    'abstencion_correcta', 'invencion_sin', 'invencion_global', 'barandilla', 'escaladas', 'usd_por_pregunta',
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
