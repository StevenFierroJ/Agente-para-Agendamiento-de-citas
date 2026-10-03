import type { Config } from '../../config.js';
import { LlmAnthropic } from './anthropic.js';

/** El LLM real según la configuración. Falla al arrancar si falta la key. */
export function crearLlmReal(config: Config): LlmAnthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('Falta ANTHROPIC_API_KEY en .env (ver .env.example).');
  }
  return new LlmAnthropic({ modelo: config.LLM_MODEL, maxTokens: config.LLM_MAX_TOKENS, apiKey: config.ANTHROPIC_API_KEY });
}
