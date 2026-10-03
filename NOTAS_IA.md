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

## Paso 1 y harness

- **El ejemplo del enunciado no tenía respuesta en el seed.** La primera plantilla
  de horarios ponía al segundo dermatólogo lunes y miércoles; el martes 6 en la
  tarde ("mañana en la tarde" del ejemplo) no había dermatología en ninguna sede.
  Lo detectó el armado del goldset, al escribir el caso del enunciado contra la
  agenda real. Se movió a martes y jueves (D-10).

## Paso 3

- **Diseño de serie revisado tras leer la librería.** La D-03 aprobada usaba un
  bloqueo consultivo, porque se escribió sin revisar la versión instalada de
  pg-boss. Al leer sus tipos apareció `key_strict_fifo`, que lo resuelve en la
  cola. Se consultó al director antes de cambiar una decisión ya aprobada.
- **`Map.groupBy` en código que declara Node 20.** La IA lo usó en el runner del
  harness; existe recién en Node 21. Lo atrapó el chequeo de tipos (lib ES2023) y
  se reemplazó por un bucle.
- **Expectativa equivocada en un test.** La IA supuso que Fastify responde 415 a
  un cuerpo `text/plain`; en realidad lo acepta, y zod lo rechaza con 400. Se
  corrigió el test, no el código: el 400 con detalle es la respuesta correcta.
