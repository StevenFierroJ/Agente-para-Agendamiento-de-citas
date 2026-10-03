# CLAUDE.md — Asistente de agendamiento con IA (prueba técnica WeKall)

## Qué es

Servicio que recibe mensajes de pacientes de una clínica ficticia (simula WhatsApp), responde con un LLM que consulta documentos de la clínica y agenda citas en una agenda real. Operación en Colombia (`America/Bogota`, UTC-5 fijo).

Criterio rector: **el código responde por la corrección, el modelo solo propone.** Alcance acotado y bien resuelto. No agregar funciones que el enunciado no pide.

Plazo: dos días. El enunciado completo está en `docs/enunciado.pdf`.

## Stack (decidido, no cambiar sin preguntar)

| Pieza | Elección |
|---|---|
| Lenguaje | TypeScript estricto, Node 20+ |
| HTTP | Fastify |
| Validación | zod (webhook y argumentos de herramientas) |
| PostgreSQL | `pg` con SQL a mano; migraciones en archivos `.sql` numerados. Sin ORM |
| MongoDB | Controlador oficial. Sin Mongoose |
| Vectores | `pgvector`, columna `vector(384)` |
| Embeddings | `multilingual-e5-small` local, en proceso, con `@huggingface/transformers` |
| Cola | `pg-boss` sobre el mismo PostgreSQL |
| LLM | Claude Haiku 4.5 (`claude-haiku-4-5`) con el SDK oficial `@anthropic-ai/sdk` (D-20) |
| Fechas | `luxon` |
| Frontend | React + Vite, consulta periódica |
| Tests | Vitest contra PostgreSQL y MongoDB reales en Docker |

Sin LangChain ni LangGraph: el ciclo de herramientas se escribe a mano para controlarlo.

## Estructura

```
backend/
  src/
    dominio/          reglas puras: agenda, estados, fechas en hora de Colombia. Sin E/S
    aplicacion/       orquestador del turno, herramientas, armado del prompt
    infraestructura/
      postgres/       consultas, migraciones
      mongo/          mensajes y turnos
      llm/            LlmClient: implementación real y falsa
      embeddings/     EmbeddingClient: implementación real y falsa
      cola/           pg-boss
    http/             rutas Fastify
    api.ts            punto de entrada de la API
    trabajador.ts     punto de entrada del trabajador
  migraciones/
  seed/
    documentos/       6 a 10 archivos .md de la clínica
  harness/
    gold/casos/       goldset: una conversación guionada por archivo
    carga/            harness de volumen
  tests/
frontend/
docs/
docker-compose.yml
DECISIONS.md
NOTAS_IA.md
README.md
```

`dominio/` no importa nada de `infraestructura/`. `aplicacion/` depende de interfaces, no de SDK.

La API y el trabajador se arman con `levantarSistema(opciones)` (`src/sistema.ts`), que recibe `LlmClient` y una fábrica de herramientas: el harness los levanta en proceso con un LLM falso guionado por `message_id`. `api.ts` y `trabajador.ts` solo leen el entorno y llaman a la fábrica.

## Modelo de datos

### PostgreSQL (transacciones, restricciones, fuente de verdad)

- `sedes` (id, nombre único).
- `especialidades` (id, nombre único).
- `profesionales` (id, nombre único, especialidad_id).
- `horarios` (id, profesional_id, sede_id, inicio `timestamptz`, fin `timestamptz`).
  - Único: (profesional_id, inicio).
  - Índice: (sede_id, inicio).
- `citas` (id, horario_id, conversacion_id, nombre_paciente, estado `activa|cancelada`, creada_en).
  - **Índice único parcial sobre `horario_id` donde `estado = 'activa'`.** Es la garantía contra la cita duplicada.
  - Sin campos de texto libre: ni motivo ni síntomas.
- `conversaciones` (id, telefono único, estado `abierta|resuelta_por_ia|cita_agendada|escalada`, ultimo_mensaje_en).
  - Índice: (estado, ultimo_mensaje_en desc) para la bandeja.
- `mensajes_entrantes` (message_id llave primaria, conversacion_id, texto, enviado_en, estado `recibido|procesando|procesado|fallido`, recibido_en).
  - Índice: (conversacion_id, enviado_en) para procesar pendientes en orden (D-03).
- `documentos` (id, titulo, origen único).
- `fragmentos` (id, documento_id, texto, embedding `vector(384)`).

### MongoDB (forma variable, crecimiento rápido)

- `mensajes`: `_id` determinista (`<message_id>:entrada`, `<message_id>:salida`), conversacion_id, message_id, rol, texto, fecha (timestamp del paciente en ambos), orden (0/1), guardado_en.
  - Índice: (conversacion_id, fecha, orden) (D-15).
- `turnos`: `_id` = `message_id`, conversacion_id, fecha, iniciado_en, terminado_en, iteraciones, llamadas_llm, modelo, tokens_entrada, tokens_salida, costo_usd, latencia_ms, herramientas `[{nombre, argumentos, resultado, error, duracion_ms}]`, estado_final, error.
  - Índice: (conversacion_id, fecha).

### Consistencia entre las dos bases

1. PostgreSQL confirma primero.
2. MongoDB se escribe con `upsert` sobre `_id` determinista: un reintento sobrescribe, no duplica.
3. `mensajes_entrantes.estado` pasa a `procesado` solo después de que MongoDB confirmó. Si MongoDB falla, el trabajo se reintenta.

## Invariantes (cada una con su test)

1. **Idempotencia del webhook.** `INSERT` en `mensajes_entrantes` y envío del trabajo a `pg-boss` en la misma transacción. Conflicto en `message_id` → responder 200 sin encolar.
2. **Webhook rápido.** Valida, registra, encola y responde 202. Nunca llama al LLM.
3. **Cita sin duplicado.** `agendar_cita` inserta dentro de una transacción; la violación de unicidad (código `23505`) se traduce a error `horario_ocupado` que vuelve al modelo. Test con dos inserciones concurrentes: una gana.
4. **Reintento del mismo turno.** Si el horario ya tiene cita activa de la **misma** conversación, `agendar_cita` devuelve éxito con esa cita.
5. **Hora de Colombia.** El "ahora" de un turno es el `timestamp` del mensaje convertido a `America/Bogota`. Nunca el reloj del servidor. Caso del enunciado: `2026-10-06T03:40:00Z` es 5 de octubre 10:40 p.m. en Cali; "mañana" es el 6.
6. **Serie por conversación.** Dos mensajes del mismo teléfono no se procesan a la vez. Cola `key_strict_fifo` de pg-boss con `singletonKey` = conversación: un trabajo activo por clave, FIFO por llegada. El último intento nunca termina `failed` (lo bloquearía): se marca `fallido` y se escala (D-03, D-14). No mantener una transacción abierta durante la llamada al LLM.
7. **Conversación escalada.** No se llama al LLM; se responde un mensaje fijo.

## Herramientas

Cada una: esquema zod estricto (`.strict()`), validación contra la base, y resultado tipado `{ok: true, datos}` o `{ok: false, error, detalle}`. El error se devuelve al modelo como resultado de la herramienta para que corrija o pregunte.

- `buscar_conocimiento(pregunta)` — los 4 fragmentos más cercanos por coseno. Por debajo de `RAG_UMBRAL` devuelve `sin_resultados`.
- `consultar_disponibilidad(especialidad, sede, fecha)` — fecha `YYYY-MM-DD` en hora de Colombia. Errores: `fecha_pasada`, `sede_inexistente`, `especialidad_inexistente`, `sin_horarios`.
- `agendar_cita(horario_id, nombre_paciente)` — errores: `horario_inexistente`, `horario_pasado`, `horario_ocupado`, `nombre_invalido`.
- `escalar_a_humano(motivo)` — motivo de una lista cerrada (`sin_informacion`, `solicitud_del_paciente`, `fuera_de_alcance`, `error_tecnico`).

### Filtros de datos sensibles

- El teléfono nunca se envía al LLM. `agendar_cita` lo toma de la conversación.
- `nombre_paciente`: 2 a 80 caracteres, solo letras, espacios, apóstrofo y guion. Con dígitos se rechaza.
- Campos adicionales en los argumentos → rechazo por esquema.
- El teléfono sale enmascarado en los registros del servidor (`+57300***2233`).

## Ciclo del LLM

- Interfaz `LlmClient.completar({mensajes, herramientas, senal, etiqueta}) → {texto?, llamadas[], tokens, modelo}`. Implementación real `LlmAnthropic` (`maxRetries: 0`: el reintento es del orquestador). Implementación falsa `LlmGuionado` para tests y harness.
- Tope: 5 iteraciones. Al agotarse → escalar.
- Límite de 20 s por llamada, con `AbortController`. Un reintento.
- Si falla tras el reintento: mensaje fijo al paciente, conversación a `escalada`, turno guardado con el error.
- Historial: últimos 20 mensajes de la conversación, sin la salida del propio mensaje (un reintento no ve su respuesta anterior, D-22).
- Al reenviar el mensaje del asistente con llamadas a herramientas, **se reenvían los bloques `content` tal como llegaron**, sin reconstruirlos. Los `tool_result` consecutivos van en un solo mensaje `user`, con `is_error` cuando la herramienta falló.
- Prompt de sistema, armado por código en cada turno: fecha, hora y día de la semana en Colombia; lista de sedes y especialidades válidas leída de la base; regla de responder solo con lo que devuelve `buscar_conocimiento`; regla de escalar o decir que no se sabe.

### Estado final del turno (lo decide el código, no el modelo)

- `agendar_cita` exitosa → `cita_agendada`.
- `escalar_a_humano`, tope de iteraciones o falla del LLM → `escalada`.
- Respuesta sin escalar → `resuelta_por_ia`.

## RAG

- Partición: por sección de encabezado Markdown. Documentos cortos, un fragmento por sección.
- `multilingual-e5-small` exige prefijos: `passage: ` al indexar y `query: ` al consultar.
- `RAG_UMBRAL` = 0,837, calibrado con `npm run harness:rag` (Recall@k, MRR, AUC-ROC, barrido de umbrales) sobre `harness/rag/preguntas.json` (D-25). Una variable de entorno vacía toma el valor por defecto.
- Barandilla de datos (D-26): todo número de la respuesta final debe estar en la evidencia del turno; si no, una corrección y luego mensaje fijo y escalamiento. `npm run harness:rag-e2e` mide exactitud, abstención e invención con Haiku real y un juez Sonnet.
- Motivo de la elección del modelo, para `DECISIONS.md`: 384 dimensiones bastan para un corpus de 6 a 10 documentos cortos, y el modelo ocupa menos disco y memoria que BGE-M3. Confirmar los tamaños en la ficha de cada modelo antes de escribir cifras.

## API

- `POST /webhooks/messages` → 202 (o 200 si es repetido). 400 con detalle si el cuerpo es inválido.
- `GET /conversaciones?estado=&limite=&antes=` → bandeja con cursor `(ultimo_mensaje_en, id)`; teléfono enmascarado (D-27).
- `GET /conversaciones/:id` → mensajes, turnos con herramientas y controles, citas, pendientes, `respondiendo` y resumen de costo.
- `GET /salud`.

Sin envío a WhatsApp: la respuesta se guarda y se muestra en la interfaz.

## Frontend

Tres vistas: bandeja con filtro por estado, detalle de conversación con herramientas por respuesta, simulador de paciente. Estados explícitos de carga, error y "el asistente está respondiendo" (consulta periódica hasta que aparece el mensaje de salida). Sin trabajo de diseño visual.

## Seed

- 2 sedes, 3 especialidades como mínimo, profesionales repartidos.
- Horarios: bloques de 30 minutos, lunes a viernes, 14 días calendario desde la fecha de ejecución del seed.
- 6 a 10 documentos: horarios, sedes, preparación de exámenes, política de cancelación, cobertura de servicios.
- Idempotente: correrlo dos veces no duplica.

## Variables de entorno

```
ANTHROPIC_API_KEY=
LLM_MODEL=claude-haiku-4-5
LLM_MAX_TOKENS=1024
LLM_TIMEOUT_MS=20000
LLM_MAX_ITERACIONES=5
LLM_PRECIO_ENTRADA_1M=
LLM_PRECIO_SALIDA_1M=
RAG_UMBRAL=
DATABASE_URL=
MONGO_URL=
SEED_DESDE=
```

`.env.example` en el repositorio; `.env` en `.gitignore`. Ninguna llave en el código ni en el historial de Git. Precios de Haiku 4.5 verificados el 2026-10-03 en la página oficial ($1 / $5 por millón).

## Harness (ver `backend/harness/README.md`)

- **Goldset** (`harness/gold/`): 25 conversaciones guionadas que cubren cada situación de `harness/excepciones.ts` (cada código de error del dominio, fallas del LLM, duplicados, concurrencia, zona horaria). Modo `guion` (LLM falso, no gasta) y modo `real`. Un test de Vitest falla si una situación queda sin caso.
- **Volumen** (`harness/carga/`): mensajes generados con semilla, duplicados, contención por el mismo horario, latencia del LLM simulada y caos opcional (fallas del LLM, MongoDB en pausa). Verifica las invariantes y mide latencias y vaciado de la cola.
- Patrón tomado del harness de Morton: el guion declara su paso, el transcript se guarda antes de puntuar, la configuración viaja con la medición, un precio desconocido es vacío y no cero.

## Orden de construcción

1. `docker-compose.yml` (PostgreSQL con pgvector, MongoDB), migraciones, seed.
2. Dominio: fechas en hora de Colombia y reglas de agenda, con tests.
3. Webhook, idempotencia, cola y trabajador con `LlmClient` falso. Runner del goldset; casos `webhook-*`, `conv-escalada` y `serie-*` en verde.
4. Herramientas con validación; test de concurrencia de citas. Casos `herr-*`, `zona-*`, `feliz-enunciado-*` y `concurrencia-*` en verde.
5. Ciclo del LLM, trazas en MongoDB, manejo de falla. Casos `llm-*` en verde; harness de volumen sin violaciones.
6. RAG: indexación en el seed, búsqueda, umbral. Casos `rag-*` y `feliz-pregunta-*` en verde; goldset completo en modo `guion`, y una corrida en modo `real` registrada.
7. API de lectura y frontend.
8. `README.md`, diagrama de AWS en Mermaid, `DECISIONS.md`.

Cada paso termina con sus tests y sus casos del goldset en verde antes de pasar al siguiente. Un commit por paso.

## Reglas de trabajo

- Los tests no llaman al LLM real ni descargan el modelo de embeddings: usan las implementaciones falsas.
- Errores explícitos. Ningún `catch` vacío. Ningún `any`.
- Nombres de dominio en español (tablas, herramientas, estados), como en el enunciado.
- Una ambigüedad del enunciado se decide, y la decisión se anota en `DECISIONS.md` en el momento.
- `NOTAS_IA.md`: registrar durante el trabajo lo que la IA entregó mal o incompleto y cómo se corrigió. `DECISIONS.md` lo exige y no se reconstruye al final.
- No redactar `DECISIONS.md` completo sin el director: las decisiones y los trade-offs son suyos. Proponer borrador por sección y esperar revisión.
- Cifras de costo (LLM e infraestructura AWS): se consultan en la página de precios vigente y se anotan con fecha y supuestos. No se escriben de memoria.

## DECISIONS.md

Secciones 1 a 9 (borrador en revisión del director) y, como apéndice, el registro D-01 a D-27 escrito en el momento de cada decisión. Cifras de costo con fecha y fuente.
