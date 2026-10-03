# Notas sobre el uso de IA

Registro, durante el trabajo, de lo que la IA entregó mal o incompleto y cómo se
corrigió. Alimenta la sección "Uso de IA" de `DECISIONS.md`.

## Especificación inicial (`CLAUDE.md`)

- **`turnos` sin campo de fecha.** El plan declaraba un índice
  `(conversacion_id, fecha)` sobre la colección `turnos`, pero el esquema no tenía
  `fecha`. Se agregó el campo.
- **El trabajador no tenía de dónde leer el mensaje.** `mensajes_entrantes` solo
  guardaba id y estado; ni el texto ni el `timestamp`. Se agregaron (ver D-01).
- **El costo no estaba en ninguna parte.** El enunciado pide mostrar cuánto costó
  cada conversación; el plan solo guardaba tokens. Ver D-02.
- **Bloqueo de sesión que bloquea al trabajador.** El plan pedía un bloqueo
  consultivo de sesión sin decir qué hace el segundo mensaje mientras espera, ni
  cómo se garantiza el orden. Ver D-03.
- **Seed atado a la fecha de ejecución.** El ejemplo del enunciado deja de tener
  horarios si se evalúa en otra fecha. Ver D-04.
