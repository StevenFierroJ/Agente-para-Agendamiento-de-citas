# Decisiones de diseño

> Documento en construcción. Las secciones de fondo (arquitectura, datos, nube,
> pipeline de IA, costo, trade-offs) se redactan por partes y se revisan antes de
> darlas por cerradas. El registro de decisiones de abajo se escribe en el momento
> en que se toma cada una.

## Registro de decisiones y ambigüedades del enunciado

### D-01 · El texto del mensaje entrante vive en PostgreSQL
`mensajes_entrantes` guarda `texto` y `enviado_en` (el `timestamp` del webhook),
además del `message_id`. El trabajador lee de ahí, no del contenido del trabajo en
la cola: si el trabajo se reintenta o la cola cambia (pg-boss → SQS), el mensaje
sigue estando en la fuente de verdad.

### D-02 · El costo de cada turno se calcula y se guarda
El enunciado pide que el coordinador vea "cuánto costó". Cada turno guarda
`costo_usd`, calculado con los tokens que reporta el proveedor y los precios por
millón de tokens de `LLM_PRECIO_ENTRADA_1M` y `LLM_PRECIO_SALIDA_1M`. Los precios
van en configuración y no en el código porque cambian; el valor usado se anota
con fecha de consulta.

### D-03 · Mensajes del mismo teléfono: uno a la vez y en orden (revisada)
**Versión final:** la cola de `pg-boss` usa la política `key_strict_fifo` con
`singletonKey` = id de la conversación. La base garantiza, entre todos los
trabajadores, un solo trabajo activo por conversación y orden FIFO por clave.
Conversaciones distintas se procesan en paralelo.

**Primera versión, descartada:** un bloqueo consultivo por conversación
(`pg_try_advisory_lock`), con reencolado si estaba tomado y procesamiento de
los pendientes por `enviado_en`. Se descartó al revisar la API de pg-boss 12:
retenía una conexión durante la llamada al LLM, reencolaba en bucle cuando había
contención y había que reimplementarlo en producción. `key_strict_fifo` es el
mismo modelo que una cola SQS FIFO con `MessageGroupId` = conversación, así que
el diseño de AWS no cambia la semántica.

**Costos aceptados:**
- El orden es el de llegada al webhook, no el del `timestamp`. Si WhatsApp
  entrega dos mensajes invertidos, se procesan invertidos.
- Un trabajo que termina `failed` bloquea la conversación. Por eso el trabajador
  nunca deja fallar el último intento (D-14).
- Depende de una función reciente de pg-boss (12.x).

### D-04 · La agenda del seed y la fecha del ejemplo
El seed genera 14 días calendario desde hoy (hora de Colombia). `SEED_DESDE`
(YYYY-MM-DD) permite fijar el primer día, para reproducir el ejemplo del enunciado
(`2026-10-06T03:40:00Z`) aunque se evalúe en otra fecha. El simulador envía la hora
actual como `timestamp`. "Fecha pasada" y "horario pasado" se validan contra el
`timestamp` del mensaje, no contra el reloj del servidor.

### D-05 · Transiciones de estado de la conversación
- El estado de la conversación es el estado final de su último turno.
- `escalada` es terminal: los mensajes siguientes reciben un mensaje fijo y no
  pasan por el LLM. Reabrir una conversación escalada es trabajo del humano y
  queda fuera del alcance.
- `abierta` es el estado de una conversación recién creada que aún no tiene turno
  terminado.

### D-06 · Seed idempotente por llaves naturales
`sedes.nombre`, `especialidades.nombre`, `profesionales.nombre` y
`horarios (profesional_id, inicio)` son únicos; el seed inserta con
`ON CONFLICT DO NOTHING`. Correrlo dos veces no duplica; correrlo otro día agrega
solo los días que faltan.

### D-07 · Sin índice vectorial aproximado
Con un corpus de decenas de fragmentos, el recorrido completo con distancia coseno
es exacto y barato. HNSW o IVFFlat se justificarían con miles de fragmentos por
clínica.

### D-08 · Validación del cuerpo del webhook
- `timestamp` debe ser ISO 8601 **con zona** (`Z` u offset). Uno sin zona es
  ambiguo (¿hora de Colombia o UTC?) y la invariante de la hora depende de él: se
  rechaza con 400.
- `text`: no vacío después de recortar espacios, máximo 4.096 caracteres (el
  límite de un mensaje de texto de WhatsApp).
- `from`: formato E.164 (`+` y de 8 a 15 dígitos).
- Campos de más → 400. El webhook acepta exactamente lo que el enunciado define.

### D-09 · Dos harness además de los tests
Los tests de Vitest prueban piezas; no dicen si el sistema armado maneja cada
excepción ni si las invariantes aguantan con carga. Se agregan:
- un **goldset** de conversaciones guionadas que cubre cada situación con nombre
  (cada código de error, fallas del LLM, duplicados, concurrencia, zona horaria),
  ejecutable sin LLM (modo guion) y con el LLM real;
- un **harness de volumen** que dispara mensajes concurrentes con duplicados y
  contención por horario, y verifica las invariantes al final.
El patrón viene del harness de evaluación de otro proyecto propio (guion
declarado, transcript antes de puntuar, configuración junto a la medición). El
costo: más código que mantener y casos escritos por quien construyó el sistema
(`validado_por: null`), que prueban que el sistema hace lo que se decidió, no que
lo decidido sea lo correcto.

### D-10 · La agenda del seed tiene huecos a propósito
Dermatología no atiende en la Sede Norte los martes y jueves, y la Sede Sur solo
tiene dermatología en la tarde esos días. Así el ejemplo del enunciado ("mañana en
la tarde", martes 6) tiene respuesta en una sede y `sin_horarios` en la otra.

### D-11 · Cómo se reconoce una sede o especialidad que nombra el modelo
Se compara sin mayúsculas, tildes ni espacios de más, y se acepta la sede sin la
palabra "sede" ("norte" → Sede Norte). No hay coincidencia aproximada: "derma" no
es Dermatología. Una coincidencia difusa podría agendar en el lugar equivocado;
es preferible devolver `especialidad_inexistente` con la lista válida y que el
modelo pregunte.

### D-12 · Agendar y escalar en el mismo turno
Si en un turno se agendó una cita y además se escaló, el estado final es
`escalada`: la cita queda hecha, pero hay algo que un humano tiene que mirar.

### D-13 · Un horario "pasado" es uno que ya empezó
Se compara el inicio del bloque contra el `timestamp` del mensaje. El reintento
de un turno que ya agendó se revisa **antes** que la hora: si la cita es de esta
conversación, se devuelve aunque el reintento llegue cuando el bloque ya empezó.

### D-14 · El último intento no se deja fallar
Cada mensaje tiene 1 intento más 3 reintentos con espera exponencial. Si el
último también falla (por ejemplo, MongoDB caído todo ese tiempo), el
trabajador:
- marca el mensaje `fallido`;
- pasa la conversación a `escalada`;
- intenta guardar el mensaje fijo;
- y termina el trabajo sin error, para no bloquear la conversación (D-03).

Si MongoDB sigue caído, el mensaje fijo no queda guardado. El coordinador ve la
conversación escalada en la bandeja, que se lee de PostgreSQL.

### D-15 · Orden de los mensajes en MongoDB
Entrada y salida llevan la misma `fecha` (el `timestamp` del mensaje del
paciente) y un campo `orden` (0 y 1). El historial se ordena por
`(fecha, orden)`. Si la salida usara la hora del servidor, un mensaje con
`timestamp` futuro (como los del enunciado) quedaría después de su respuesta.

### D-16 · El historial que ve el modelo es solo texto
Al LLM le llegan los últimos 20 mensajes de paciente y asistente, sin las
llamadas a herramientas de turnos anteriores. Es más barato y basta para el
contexto de la conversación. A cambio, el modelo no ve los `horario_id` de un
turno anterior: si el paciente elige un horario ofrecido antes, tiene que volver
a consultar disponibilidad. Así además confirma que el horario sigue libre.

### D-17 · Respuestas del webhook
- **202** `{estado: "recibido"}`: mensaje nuevo, registrado y encolado.
- **200** `{estado: "duplicado"}`: el `message_id` ya existía. La transacción se
  revierte, así que un duplicado no toca la conversación.
- **400** `{error: "cuerpo_invalido", detalle: [{campo, mensaje}]}`: cuerpo
  inválido, incluidos JSON mal formado y texto plano.
- **500**: si falla el encolado, la transacción se revierte y no queda nada. El
  proveedor reintenta y el mensaje entra como nuevo.

## Secciones pendientes

- Arquitectura general
- Modelo de datos
- Nube (AWS)
- Pipeline de IA
- Confiabilidad
- Costo
- Trade-offs
- Uso de IA (se alimenta de `NOTAS_IA.md`)
- Qué haría distinto
