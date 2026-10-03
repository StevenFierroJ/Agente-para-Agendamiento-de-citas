import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbeddingClient } from '../../aplicacion/puertos.js';

export const MODELO_EMBEDDINGS = 'Xenova/multilingual-e5-small';
const DIRECTORIO_CACHE = fileURLToPath(new URL('../../../.cache/modelos/', import.meta.url));

/**
 * multilingual-e5-small local, en proceso (ONNX cuantizado, ~118 MB).
 * La ficha del modelo exige prefijos: "query: " al consultar y "passage: " al indexar.
 * La primera carga descarga el modelo a .cache/modelos.
 */
export class EmbeddingE5 implements EmbeddingClient {
  private extractor: Promise<FeatureExtractionPipeline> | null = null;

  private cargar(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      env.cacheDir = path.resolve(DIRECTORIO_CACHE);
      this.extractor = pipeline('feature-extraction', MODELO_EMBEDDINGS, { dtype: 'q8' });
    }
    return this.extractor;
  }

  async embeberConsulta(texto: string): Promise<number[]> {
    const [vector] = await this.embeber([`query: ${texto}`]);
    if (!vector) throw new Error('El modelo de embeddings no devolvió vector');
    return vector;
  }

  embeberPasajes(textos: readonly string[]): Promise<number[][]> {
    return this.embeber(textos.map((t) => `passage: ${t}`));
  }

  private async embeber(textos: string[]): Promise<number[][]> {
    const extractor = await this.cargar();
    const salida = await extractor(textos, { pooling: 'mean', normalize: true });
    return salida.tolist() as number[][];
  }
}
