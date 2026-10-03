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

## Paso 4

- **`aplicacion/` importaba infraestructura.** En el paso 3 la IA escribió
  `procesar-mensaje.ts` llamando directamente funciones de PostgreSQL y MongoDB,
  contra la regla del CLAUDE.md. Se detectó al diseñar las herramientas y se
  corrigió con puertos (`RepositorioMensajes`, `AlmacenConversaciones`, `Agenda`)
  e implementaciones en `infraestructura/`.
- **Una medición falsa casi lleva a una conclusión equivocada.** Para verificar
  que el test concurrente ejercía el índice único, la IA instrumentó el código
  con `sed`, que no aplicó el cambio (caracteres no ASCII en el patrón), y
  concluyó que el camino `23505` nunca se tomaba. Se reescribió el test como uno
  determinista: otra transacción inserta sin confirmar y la herramienta queda
  bloqueada en el índice. Al repetir la medición con una inserción confiable,
  ese camino se toma 28 veces en los tests concurrentes. Quedaron los dos tests.
  Lección: verificar que la instrumentación se aplicó antes de leer su resultado.

## Paso 5

- **El goldset en modo real esperaba un único camino.** La IA escribió lo
  esperado del caso del enunciado como si el modelo fuera a consultar las dos
  sedes en el primer mensaje. Haiku preguntó la sede (el paciente no la dijo) y
  pidió confirmación antes de agendar: un comportamiento correcto que el caso
  marcaba como falla. Se separó en un caso de guion y uno real de tres mensajes,
  con lo esperado revisado sobre la conversación completa (`llamadas_incluyen`).
- **Markdown en WhatsApp.** El modelo respondía con `**negritas**`, que WhatsApp
  muestra literal. Se agregó una regla de formato al prompt.
- **Bug de reintentos escrito por la IA y encontrado por el caos.** `procesar-mensaje.ts`
  leía el historial sin excluir la respuesta del propio mensaje; un reintento
  veía su contestación anterior (D-22). Los tests y el goldset no lo vieron: hizo
  falta pausar MongoDB más de lo que dura `socketTimeoutMS`.
- **Una prueba de caos que no probaba nada.** La primera corrida de caos pausó
  MongoDB 8 s y salió "sin violaciones". La IA casi la reporta como prueba de que
  los reintentos funcionan, pero la pausa fue más corta que el tiempo límite del
  socket y no hubo un solo reintento. Se agregó al harness la métrica de trabajos
  reintentados. Lección: un "sin violaciones" vale si el caos efectivamente
  ocurrió.
