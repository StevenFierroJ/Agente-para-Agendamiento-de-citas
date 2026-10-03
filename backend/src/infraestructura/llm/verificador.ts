import Anthropic from '@anthropic-ai/sdk';
import type { VerificadorAfirmaciones } from '../../aplicacion/puertos.js';

const INSTRUCCION = [
  'Clasificas UNA respuesta de un asistente de citas médicas.',
  '¿La respuesta afirma que una cita YA quedó agendada, reservada o confirmada?',
  'Responde SI solo si lo da por hecho. Responde NO si pregunta, ofrece, pide datos o habla de agendar en el futuro.',
  'Responde únicamente SI o NO.',
].join(' ');

/** Verificador con Haiku: una llamada corta, sin herramientas, solo cuando el filtro determinista dispara. */
export class VerificadorAnthropic implements VerificadorAfirmaciones {
  private readonly cliente: Anthropic;

  constructor(private readonly opciones: { modelo: string; apiKey: string; timeoutMs: number }) {
    this.cliente = new Anthropic({ apiKey: opciones.apiKey, maxRetries: 0, timeout: opciones.timeoutMs });
  }

  async afirmaCitaAgendada(respuesta: string): Promise<boolean> {
    const r = await this.cliente.messages.create({
      model: this.opciones.modelo,
      max_tokens: 5,
      system: INSTRUCCION,
      messages: [{ role: 'user', content: `<respuesta>${respuesta}</respuesta>` }],
    });
    const texto = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .toUpperCase();
    if (texto.startsWith('SI') || texto.startsWith('SÍ')) return true;
    if (texto.startsWith('NO')) return false;
    throw new Error(`Respuesta inesperada del verificador: "${texto}"`);
  }
}
