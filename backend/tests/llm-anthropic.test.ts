import { describe, expect, it } from 'vitest';
import { ErrorLlm, type MensajeLlm, type PedidoLlm } from '../src/aplicacion/puertos.js';
import { LlmAnthropic, aMensajesAnthropic } from '../src/infraestructura/llm/anthropic.js';

// Sin red: un fetch falso responde como la API de mensajes.
function fetchFalso(responder: (cuerpo: Record<string, unknown>, init: RequestInit) => Promise<Response> | Response) {
  const pedidos: Record<string, unknown>[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const cuerpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
    pedidos.push(cuerpo);
    return responder(cuerpo, init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, pedidos };
}

const json = (status: number, cuerpo: unknown) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });

const mensajeApi = (content: unknown[], stop_reason = 'end_turn') => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});

function pedido(mensajes: MensajeLlm[], senal = new AbortController().signal): PedidoLlm {
  return {
    mensajes,
    herramientas: [{ nombre: 'consultar_disponibilidad', descripcion: 'd', parametros: { type: 'object', properties: {} } }],
    senal,
    etiqueta: 'm.1',
  };
}

const llm = (fetch: typeof globalThis.fetch) => new LlmAnthropic({ modelo: 'claude-haiku-4-5', maxTokens: 1024, apiKey: 'sk-test', fetch });

describe('aMensajesAnthropic', () => {
  it('saca el sistema, reenvía tal cual los bloques del asistente y agrupa los resultados de herramientas', () => {
    const crudo = [
      { type: 'text', text: 'Consulto' },
      { type: 'tool_use', id: 'tu_1', name: 'a', input: {} },
      { type: 'tool_use', id: 'tu_2', name: 'b', input: {} },
    ];
    const { system, messages } = aMensajesAnthropic([
      { rol: 'sistema', contenido: 'Eres el asistente' },
      { rol: 'paciente', contenido: 'Hola' },
      { rol: 'asistente_con_llamadas', crudo },
      { rol: 'herramienta', llamadaId: 'tu_1', contenido: '{"ok":true}', esError: false },
      { rol: 'herramienta', llamadaId: 'tu_2', contenido: '{"ok":false}', esError: true },
    ]);
    expect(system).toBe('Eres el asistente');
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: 'assistant', content: crudo });
    expect(messages[1]!.content).toBe(crudo); // el mismo objeto, sin reconstruir
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":true}', is_error: false },
        { type: 'tool_result', tool_use_id: 'tu_2', content: '{"ok":false}', is_error: true },
      ],
    });
  });

  it('une mensajes consecutivos del mismo rol y descarta un historial que empieza con el asistente', () => {
    const { messages } = aMensajesAnthropic([
      { rol: 'asistente', contenido: 'respuesta de un turno recortado' },
      { rol: 'paciente', contenido: 'uno' },
      { rol: 'paciente', contenido: 'dos' },
    ]);
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'uno' }, { type: 'text', text: 'dos' }] }]);
  });
});

describe('LlmAnthropic', () => {
  it('devuelve las llamadas a herramientas con sus argumentos como JSON, y los tokens', async () => {
    const { fetch, pedidos } = fetchFalso(() =>
      json(200, mensajeApi([{ type: 'tool_use', id: 'tu_1', name: 'consultar_disponibilidad', input: { fecha: '2026-10-06' } }], 'tool_use')),
    );
    const r = await llm(fetch).completar(pedido([{ rol: 'sistema', contenido: 's' }, { rol: 'paciente', contenido: 'Hola' }]));
    expect(r.llamadas).toEqual([{ id: 'tu_1', nombre: 'consultar_disponibilidad', argumentosCrudos: '{"fecha":"2026-10-06"}' }]);
    expect(r).toMatchObject({ texto: null, tokensEntrada: 1200, tokensSalida: 40, modelo: 'claude-haiku-4-5' });
    expect(pedidos[0]).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: 's',
      tools: [{ name: 'consultar_disponibilidad', description: 'd', input_schema: { type: 'object', properties: {} } }],
    });
  });

  it('devuelve el texto final', async () => {
    const { fetch } = fetchFalso(() => json(200, mensajeApi([{ type: 'text', text: 'Hola, ¿en qué te ayudo?' }])));
    const r = await llm(fetch).completar(pedido([{ rol: 'paciente', contenido: 'Hola' }]));
    expect(r).toMatchObject({ texto: 'Hola, ¿en qué te ayudo?', llamadas: [] });
  });

  it.each([[500], [529], [429], [400], [401]])('un %i es ErrorLlm de proveedor y el SDK no reintenta solo', async (status) => {
    const { fetch, pedidos } = fetchFalso(() => json(status, { type: 'error', error: { type: 'x', message: 'falla' } }));
    const error = await llm(fetch).completar(pedido([{ rol: 'paciente', contenido: 'Hola' }])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorLlm);
    expect((error as ErrorLlm).tipo).toBe('proveedor');
    expect(pedidos).toHaveLength(1);
  });

  it('abortar la señal (el límite de tiempo del orquestador) es ErrorLlm de timeout', async () => {
    const { fetch } = fetchFalso(
      (_c, init) =>
        new Promise<Response>((_, rechazar) => {
          init.signal?.addEventListener('abort', () => rechazar(new DOMException('abortado', 'AbortError')));
        }),
    );
    const controlador = new AbortController();
    const promesa = llm(fetch).completar(pedido([{ rol: 'paciente', contenido: 'Hola' }], controlador.signal));
    setTimeout(() => controlador.abort(), 20);
    const error = await promesa.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorLlm);
    expect((error as ErrorLlm).tipo).toBe('timeout');
  });

  it.each([['max_tokens'], ['refusal']])('stop_reason %s es ErrorLlm: no se usa una respuesta incompleta', async (stop) => {
    const { fetch } = fetchFalso(() => json(200, mensajeApi([{ type: 'text', text: 'Respuesta cort' }], stop)));
    await expect(llm(fetch).completar(pedido([{ rol: 'paciente', contenido: 'Hola' }]))).rejects.toBeInstanceOf(ErrorLlm);
  });
});
