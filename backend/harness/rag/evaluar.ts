// Evalúa la recuperación del RAG contra el goldset de preguntas y calibra RAG_UMBRAL.
//
//   npm run harness:rag
//
// MÉTRICAS
//   Recuperación (preguntas con respuesta; relevante = fragmento del documento esperado):
//     Recall@1, Recall@k (= hit rate), MRR@k.
//   Abstención (¿la similitud del mejor fragmento separa con/sin respuesta?):
//     AUC-ROC; y por umbral: recall, tasa de falsos positivos, precisión, F1.
//   Umbrales candidatos: sin falsos positivos, máximo F1 y máximo índice de Youden.
//
// LA CONFIGURACIÓN VIAJA CON LA MEDICIÓN
//   Modelo, partición, k y tamaño del goldset van en cada fila de METRICAS_RAG.csv.
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import pg from 'pg';
import { FRAGMENTOS_POR_BUSQUEDA } from '../../src/aplicacion/herramientas/buscar-conocimiento.js';
import { EmbeddingE5, MODELO_EMBEDDINGS } from '../../src/infraestructura/embeddings/e5.js';
import { ConocimientoPostgres } from '../../src/infraestructura/postgres/conocimiento.js';
import { URL_POSTGRES_HARNESS, prepararBasesDelHarness, sello } from '../comun.js';
import { SEED_DESDE_HARNESS } from '../gold/cargar.js';
import { aucRoc, barrer, metricasRecuperacion, umbralesCandidatos, type Medicion } from './metricas.js';

export interface GoldsetRag {
  con_respuesta: { pregunta: string; documento: string; dato: string }[];
  sin_respuesta: { pregunta: string; tipo: 'dominio_cercano' | 'fuera_de_dominio' }[];
}

const DIRECTORIO_SALIDA = fileURLToPath(new URL('../out/', import.meta.url));
const CSV = fileURLToPath(new URL('./METRICAS_RAG.csv', import.meta.url));
const PARTICION = 'seccion-h2+titulo';

async function main(): Promise<void> {
  const gold = JSON.parse(await readFile(new URL('./preguntas.json', import.meta.url), 'utf8')) as GoldsetRag;
  const embeddings = new EmbeddingE5();
  await prepararBasesDelHarness(SEED_DESDE_HARNESS, embeddings);
  const pool = new pg.Pool({ connectionString: URL_POSTGRES_HARNESS });
  try {
    const base = new ConocimientoPostgres(pool);
    const { rows } = await pool.query<{ titulo: string; origen: string }>('SELECT titulo, origen FROM documentos');
    const origenDe = new Map(rows.map((o) => [o.titulo, o.origen]));
    const k = FRAGMENTOS_POR_BUSQUEDA;

    const medir = async (pregunta: string) => {
      const encontrados = await base.buscar(await embeddings.embeberConsulta(pregunta), k);
      return { similitud: encontrados[0]?.similitud ?? 0, documentos: encontrados.map((f) => origenDe.get(f.titulo) ?? '?') };
    };
    const mediciones: Medicion[] = [];
    for (const p of gold.con_respuesta) mediciones.push({ pregunta: p.pregunta, conRespuesta: true, esperado: p.documento, ...(await medir(p.pregunta)) });
    for (const p of gold.sin_respuesta) mediciones.push({ pregunta: p.pregunta, conRespuesta: false, tipo: p.tipo, ...(await medir(p.pregunta)) });

    const recuperacion = metricasRecuperacion(mediciones, k);
    const auc = aucRoc(mediciones);
    const barrido = barrer(mediciones);
    const candidatos = umbralesCandidatos(barrido);

    // ---- Informe -----------------------------------------------------------
    const f = (x: number) => x.toFixed(3);
    const pct = (x: number) => `${(x * 100).toFixed(0)} %`;
    console.log(`modelo ${MODELO_EMBEDDINGS} · partición ${PARTICION} · k=${k}`);
    console.log(`goldset: ${gold.con_respuesta.length} con respuesta, ${gold.sin_respuesta.length} sin respuesta\n`);
    console.log('RECUPERACIÓN (preguntas con respuesta)');
    console.log(`  Recall@1 ${f(recuperacion.recallA1)} · Recall@${k} ${f(recuperacion.recallAk)} · MRR@${k} ${f(recuperacion.mrr)}`);
    for (const m of recuperacion.fallos) console.log(`  rango ${m.rango ?? '>' + k}: ${m.pregunta} (top1: ${m.documentos[0]})`);
    console.log('\nABSTENCIÓN (similitud del mejor fragmento)');
    console.log(`  AUC-ROC ${f(auc)}`);
    for (const [nombre, c] of Object.entries(candidatos)) {
      if (!c) continue;
      console.log(
        `  ${nombre.padEnd(18)} umbral ${f(c.umbral)} · recall ${pct(c.recall)} · FP ${c.falsosPositivos}/${c.negativos} ` +
          `(cercano ${c.fpDominioCercano}, fuera ${c.fpFueraDeDominio}) · precisión ${f(c.precision)} · F1 ${f(c.f1)}`,
      );
    }
    const porSimilitud = [...mediciones].sort((a, b) => b.similitud - a.similitud);
    console.log('\n  similitud  ¿resp?  pregunta');
    for (const m of porSimilitud) console.log(`  ${f(m.similitud)}     ${m.conRespuesta ? 'sí ' : 'no '}   ${m.pregunta}${m.tipo ? ` [${m.tipo}]` : ''}`);

    await mkdir(DIRECTORIO_SALIDA, { recursive: true });
    const marca = sello();
    const destino = path.join(DIRECTORIO_SALIDA, `rag-${marca}.json`);
    await writeFile(destino, JSON.stringify({ modelo: MODELO_EMBEDDINGS, particion: PARTICION, k, recuperacion, auc, candidatos, barrido, mediciones }, null, 1));
    await agregarCsv([
      DateTime.now().toISODate(), marca, MODELO_EMBEDDINGS, PARTICION, k, gold.con_respuesta.length, gold.sin_respuesta.length,
      f(recuperacion.recallA1), f(recuperacion.recallAk), f(recuperacion.mrr), f(auc),
      candidatos.youden ? f(candidatos.youden.umbral) : '', candidatos.youden ? f(candidatos.youden.recall) : '',
      candidatos.youden?.falsosPositivos ?? '', candidatos.sinFalsosPositivos ? f(candidatos.sinFalsosPositivos.umbral) : '',
      candidatos.sinFalsosPositivos ? f(candidatos.sinFalsosPositivos.recall) : '',
    ]);
    console.log(`\ndetalle → ${destino}`);
  } finally {
    await pool.end();
  }
}

async function agregarCsv(fila: (string | number | null)[]): Promise<void> {
  const columnas = [
    'snapshot', 'sello', 'modelo', 'particion', 'k', 'n_con_respuesta', 'n_sin_respuesta', 'recall_at_1', 'recall_at_k', 'mrr_at_k',
    'auc_roc', 'umbral_youden', 'recall_youden', 'fp_youden', 'umbral_sin_fp', 'recall_sin_fp',
  ];
  const existe = await stat(CSV).then(() => true, () => false);
  await appendFile(CSV, `${existe ? '' : `${columnas.join(',')}\n`}${fila.join(',')}\n`);
}

await main();
