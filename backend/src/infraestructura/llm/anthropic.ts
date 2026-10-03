import Anthropic from '@anthropic-ai/sdk';
import {
  ErrorLlm, type DefinicionHerramienta, type LlmClient, type MensajeLlm, type PedidoLlm, type RespuestaLlm,
} from '../../aplicacion/puertos.js';

export interface OpcionesLlmAnthropic {
  modelo: string;
  maxTokens: number;
  /** Solo si no se usa ANTHROPIC_API_KEY del entorno. */
  apiKey?: string;
  /** Para tests: un fetch falso en lugar de la red. */
  fetch?: typeof globalThis.fetch;
}

/**
 * LlmClient sobre la API de mensajes de Anthropic (Claude Haiku 4.5).
 *
 * - Sin reintentos del SDK (`maxRetries: 0`): el orquestador hace una llamada y
 *   un reintento con su propio límite de tiempo; reintentos del SDK multiplicarían
 *   el tiempo de pared.
 * - El mensaje del asistente con `tool_use` se reenvía tal como llegó (`content`).
 * - Los resultados de herramientas consecutivos van en un solo mensaje `user`.
 */
export class LlmAnthropic implements LlmClient {
  private readonly cliente: Anthropic;

  constructor(private readonly opciones: OpcionesLlmAnthropic) {
    this.cliente = new Anthropic({
      maxRetries: 0,
      ...(opciones.apiKey ? { apiKey: opciones.apiKey } : {}),
      ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
    });
  }

  async completar(pedido: PedidoLlm): Promise<RespuestaLlm> {
    const { system, messages } = aMensajesAnthropic(pedido.mensajes);
    let respuesta: Anthropic.Message;
    try {
      respuesta = await this.cliente.messages.create(
        {
          model: this.opciones.modelo,
          max_tokens: this.opciones.maxTokens,
          system,
          messages,
          tools: pedido.herramientas.map(aHerramientaAnthropic),
        },
        { signal: pedido.senal },
      );
    } catch (error) {
      throw traducirError(error);
    }

    if (respuesta.stop_reason === 'max_tokens' || respuesta.stop_reason === 'model_context_window_exceeded') {
      throw new ErrorLlm('proveedor', `Respuesta truncada (stop_reason ${respuesta.stop_reason})`);
    }
    if (respuesta.stop_reason === 'refusal') {
      throw new ErrorLlm('proveedor', 'El modelo declinó responder (stop_reason refusal)');
    }

    const llamadas = respuesta.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, nombre: b.name, argumentosCrudos: JSON.stringify(b.input) }));
    const texto = respuesta.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return {
      texto: texto || null,
      llamadas,
      mensajeCrudo: respuesta.content,
      // Sin cache_control (el prefijo no alcanza el mínimo cacheable de Haiku 4.5),
      // así que cache_creation y cache_read vienen en 0; se suman por si cambia.
      tokensEntrada:
        respuesta.usage.input_tokens + (respuesta.usage.cache_creation_input_tokens ?? 0) + (respuesta.usage.cache_read_input_tokens ?? 0),
      tokensSalida: respuesta.usage.output_tokens,
      modelo: respuesta.model,
    };
  }
}

function aHerramientaAnthropic(definicion: DefinicionHerramienta): Anthropic.Tool {
  return {
    name: definicion.nombre,
    description: definicion.descripcion,
    input_schema: definicion.parametros as Anthropic.Tool.InputSchema,
  };
}

/**
 * Del formato del puerto al de la API:
 * - `sistema` va al campo `system`;
 * - resultados de herramientas consecutivos se agrupan en un solo mensaje `user`;
 * - mensajes de texto consecutivos del mismo rol se unen (la API alterna roles);
 * - si el historial recortado empieza con el asistente, se descarta ese inicio.
 */
export function aMensajesAnthropic(mensajes: readonly MensajeLlm[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system = mensajes.flatMap((m) => (m.rol === 'sistema' ? [m.contenido] : [])).join('\n\n');
  const salida: Anthropic.MessageParam[] = [];

  const agregar = (role: 'user' | 'assistant', bloques: Anthropic.ContentBlockParam[]) => {
    const ultimo = salida.at(-1);
    if (ultimo && ultimo.role === role && Array.isArray(ultimo.content)) {
      ultimo.content.push(...bloques);
      return;
    }
    if (salida.length === 0 && role === 'assistant') return;
    salida.push({ role, content: bloques });
  };

  for (const m of mensajes) {
    switch (m.rol) {
      case 'sistema':
        break;
      case 'paciente':
        agregar('user', [{ type: 'text', text: m.contenido }]);
        break;
      case 'asistente':
        agregar('assistant', [{ type: 'text', text: m.contenido }]);
        break;
      case 'asistente_con_llamadas':
        // Tal como llegó: los bloques de la respuesta anterior, sin reconstruir.
        salida.push({ role: 'assistant', content: m.crudo as Anthropic.ContentBlockParam[] });
        break;
      case 'herramienta':
        agregar('user', [{ type: 'tool_result', tool_use_id: m.llamadaId, content: m.contenido, is_error: m.esError }]);
        break;
    }
  }
  return { system, messages: salida };
}

/** Errores del SDK → ErrorLlm. Cancelación y tiempo agotado son `timeout`; el resto, `proveedor`. */
export function traducirError(error: unknown): ErrorLlm {
  if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ErrorLlm('timeout', 'La llamada al LLM superó el tiempo límite', { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ErrorLlm('proveedor', `Sin conexión con el proveedor: ${error.message}`, { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new ErrorLlm('proveedor', `El proveedor respondió ${error.status ?? '?'}: ${error.message}`, { cause: error });
  }
  return new ErrorLlm('proveedor', error instanceof Error ? error.message : String(error), { cause: error });
}
