import { z } from 'zod';

/**
 * Cuerpo del webhook (D-08). Estricto: un campo de más es un 400.
 * - `timestamp` ISO 8601 con zona (Z u offset): sin zona es ambiguo.
 * - `from` en E.164.
 * - `text` no vacío y de hasta 4.096 caracteres (límite de WhatsApp).
 */
export const CuerpoWebhook = z
  .object({
    message_id: z.string().trim().min(1).max(200),
    from: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Debe estar en formato E.164, por ejemplo +573001112233'),
    text: z
      .string()
      .max(4096)
      .refine((t) => t.trim().length > 0, 'No puede estar vacío'),
    timestamp: z.iso.datetime({ offset: true, message: 'Debe ser ISO 8601 con zona, por ejemplo 2026-10-06T03:40:00Z' }),
  })
  .strict();

export type CuerpoWebhook = z.infer<typeof CuerpoWebhook>;

export function detalleDeError(error: z.ZodError): { campo: string; mensaje: string }[] {
  return error.issues.map((i) => ({ campo: i.path.join('.') || '(cuerpo)', mensaje: i.message }));
}
