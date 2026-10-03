import { setTimeout as esperar } from 'node:timers/promises';
import { ErrorLlm, type LlmClient, type MensajeLlm, type PedidoLlm, type RespuestaLlm } from '../../aplicacion/puertos.js';

export type RespuestaGuionada =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'herramientas'; llamadas: { nombre: string; argumentosCrudos: string }[] }
  | { tipo: 'falla'; falla: 'timeout' | 'error_proveedor' };

export interface PedidoRegistrado {
  etiqueta: string;
  mensajes: MensajeLlm[];
  herramientas: string[];
  en: number;
}

export interface OpcionesLlmGuionado {
  /** Respuesta para etiquetas sin guion (harness de volumen). Sin esto, falta de guion = error. */
  porDefecto?: (pedido: PedidoLlm) => RespuestaGuionada;
  /** Latencia simulada por llamada. Respeta la señal de aborto. */
  latenciaMs?: (pedido: PedidoLlm) => number;
}

/**
 * LLM falso para tests y harness. Responde, por cada `etiqueta` (message_id),
 * los pasos guionados en orden: una llamada al LLM consume un paso.
 * Registra cada pedido, para revisar el prompt y que el teléfono nunca llegó.
 */
export class LlmGuionado implements LlmClient {
  readonly pedidos: PedidoRegistrado[] = [];
  /** Etiquetas que pidieron más pasos de los que tenía su guion: un error del caso, no del sistema. */
  readonly agotados = new Set<string>();
  private readonly guiones = new Map<string, RespuestaGuionada[]>();
  private contador = 0;

  constructor(private readonly opciones: OpcionesLlmGuionado = {}) {}

  guionar(etiqueta: string, pasos: readonly RespuestaGuionada[]): void {
    this.guiones.set(etiqueta, [...pasos]);
  }

  olvidar(): void {
    this.guiones.clear();
    this.agotados.clear();
    this.pedidos.length = 0;
  }

  /** Pasos del guion que nadie pidió: el sistema tomó otro camino que el previsto. */
  pendientes(etiqueta: string): number {
    return this.guiones.get(etiqueta)?.length ?? 0;
  }

  llamadasDe(etiqueta: string): number {
    return this.pedidos.filter((p) => p.etiqueta === etiqueta).length;
  }

  async completar(pedido: PedidoLlm): Promise<RespuestaLlm> {
    this.pedidos.push({
      etiqueta: pedido.etiqueta,
      mensajes: structuredClone([...pedido.mensajes]),
      herramientas: pedido.herramientas.map((h) => h.nombre),
      en: Date.now(),
    });
    const latencia = this.opciones.latenciaMs?.(pedido) ?? 0;
    if (latencia > 0) {
      try {
        await esperar(latencia, undefined, { signal: pedido.senal });
      } catch (error) {
        throw new ErrorLlm('timeout', 'El LLM falso fue abortado', { cause: error });
      }
    }

    const paso = this.guiones.get(pedido.etiqueta)?.shift() ?? this.opciones.porDefecto?.(pedido);
    if (!paso) {
      this.agotados.add(pedido.etiqueta);
      throw new ErrorLlm('proveedor', `Guion agotado para ${pedido.etiqueta}`);
    }
    if (paso.tipo === 'falla') {
      throw new ErrorLlm(paso.falla === 'timeout' ? 'timeout' : 'proveedor', `Falla guionada: ${paso.falla}`);
    }

    const tokensEntrada = Math.ceil(JSON.stringify(pedido.mensajes).length / 4);
    if (paso.tipo === 'texto') {
      return {
        texto: paso.texto,
        llamadas: [],
        mensajeCrudo: { role: 'assistant', content: paso.texto },
        tokensEntrada,
        tokensSalida: Math.ceil(paso.texto.length / 4),
        modelo: 'falso-guionado',
      };
    }
    const llamadas = paso.llamadas.map((l) => ({ id: `llamada-${++this.contador}`, nombre: l.nombre, argumentosCrudos: l.argumentosCrudos }));
    return {
      texto: null,
      llamadas,
      mensajeCrudo: {
        role: 'assistant',
        content: null,
        tool_calls: llamadas.map((l) => ({ id: l.id, type: 'function', function: { name: l.nombre, arguments: l.argumentosCrudos } })),
      },
      tokensEntrada,
      tokensSalida: Math.ceil(JSON.stringify(paso.llamadas).length / 4),
      modelo: 'falso-guionado',
    };
  }
}
