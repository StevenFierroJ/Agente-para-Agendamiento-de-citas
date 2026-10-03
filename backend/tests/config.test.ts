import { describe, expect, it } from 'vitest';
import { leerConfig, preciosLlm } from '../src/config.js';

const BASE = { DATABASE_URL: 'postgres://x', MONGO_URL: 'mongodb://x' };

describe('leerConfig', () => {
  it('una variable vacía toma el valor por defecto, no 0', () => {
    const config = leerConfig({ ...BASE, RAG_UMBRAL: '', LLM_TIMEOUT_MS: '  ', LLM_PRECIO_ENTRADA_1M: '' });
    expect(config.RAG_UMBRAL).toBe(0.837);
    expect(config.LLM_TIMEOUT_MS).toBe(20_000);
    expect(preciosLlm(config)).toBeNull();
  });

  it('respeta los valores definidos', () => {
    const config = leerConfig({ ...BASE, RAG_UMBRAL: '0.9', LLM_PRECIO_ENTRADA_1M: '1', LLM_PRECIO_SALIDA_1M: '5' });
    expect(config.RAG_UMBRAL).toBe(0.9);
    expect(preciosLlm(config)).toEqual({ entrada: 1, salida: 5 });
  });

  it('falla con el nombre de la variable inválida', () => {
    expect(() => leerConfig({ ...BASE, RAG_UMBRAL: '2' })).toThrow(/RAG_UMBRAL/);
    expect(() => leerConfig({ MONGO_URL: 'x' })).toThrow(/DATABASE_URL/);
  });
});
