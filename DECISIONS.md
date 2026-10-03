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

### D-05 · Transiciones de estado de la conversación (revisada)
- El estado de la conversación solo sube de prioridad:
  `escalada` > `cita_agendada` > `resuelta_por_ia` > `abierta`. El estado final
  de cada turno se guarda aparte, en su traza en MongoDB.
- **Por qué:** la bandeja es la herramienta del coordinador y debe mostrar lo
  más importante que pasó en la conversación, no lo último. Con la primera
  versión ("el estado del último turno"), un "gracias" después de agendar bajaba
  la conversación a `resuelta_por_ia` y la escondía del filtro `cita_agendada`.
  Como cancelar no está en el alcance, nada legítimo deshace una cita.
- **Costo:** un paciente con una cita anterior que vuelve con otra consulta sigue
  apareciendo como `cita_agendada`. Lo compensan la bandeja ordenada por último
  mensaje y el detalle con el estado de cada turno.
- `escalada` es terminal: los mensajes siguientes reciben un mensaje fijo y no
  pasan por el LLM. Reabrir una conversación escalada es trabajo del humano y
  queda fuera del alcance.

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

### D-18 · Las herramientas: validación y forma de los errores
- **Una sola fuente.** El esquema zod que valida los argumentos genera también
  el JSON Schema que ve el modelo (`z.toJSONSchema`). No pueden desalinearse.
- **Orden de validación** en `consultar_disponibilidad`:
  1. esquema (campos, tipos, campos de más);
  2. formato de la fecha;
  3. especialidad;
  4. sede;
  5. fecha pasada;
  6. horarios libres.

  Ante varios errores, el modelo recibe primero el que exige preguntarle algo al
  paciente.
- **El error dice cómo corregir.** `especialidad_inexistente` y
  `sede_inexistente` traen la lista de nombres válidos; `horario_ocupado` pide
  volver a consultar.
- **`consultar_disponibilidad` devuelve el día completo.** No filtra por mañana
  o tarde: con a lo sumo ~20 bloques por especialidad y sede, el modelo elige
  la franja. Agregar un parámetro de franja sumaría otro argumento que el modelo
  puede mandar mal.
- **`escalar_a_humano` no escribe en la base.** El estado `escalada` lo fija el
  código al cerrar el turno, igual que los demás estados (estadoFinalDelTurno).

### D-19 · Cita duplicada: lectura previa más índice único
`agendar_cita` lee el horario y la cita activa, decide con la regla del dominio
e inserta, todo en una transacción. La lectura previa resuelve el caso común con
un mensaje claro. La garantía es el índice único parcial: si otro paciente
inserta entre la lectura y la inserción, el `INSERT` recibe `23505`, se vuelve
a un savepoint, se relee la cita ganadora y se devuelve `horario_ocupado` (o
éxito, si la ganadora es de la misma conversación). No se usa `SELECT … FOR
UPDATE` sobre el horario: el índice ya serializa, y un bloqueo explícito
agregaría esperas sin cambiar el resultado.

### D-20 · Proveedor de LLM: Claude Haiku 4.5
Decisión del director, que reemplaza el plan inicial (Gemini por su punto de
acceso compatible con OpenAI). Se usa `claude-haiku-4-5` con el SDK oficial
`@anthropic-ai/sdk`, sin LangChain, con el ciclo de herramientas escrito a mano.
- **Precio** (página oficial, consultada el 2026-10-03): $1 por millón de tokens
  de entrada y $5 por millón de salida. Usar herramientas agrega 496 tokens de
  prompt de sistema por llamada.
- **Reintentos:** el SDK se configura con `maxRetries: 0`. El orquestador hace
  una llamada y un reintento con su propio límite de 20 s. Si el SDK también
  reintentara, el peor caso pasaría de 40 s a 120 s.
- **Errores:** cancelación y tiempo agotado → `timeout`; cualquier otro error
  del SDK (4xx, 5xx, conexión) → `proveedor`. `stop_reason` `max_tokens` o
  `refusal` también son falla: no se usa una respuesta incompleta.
- **Medido con el goldset real** (3 turnos del ejemplo del enunciado): entre
  1.650 y 6.960 tokens de entrada por turno, USD 0,016 la conversación completa,
  de 1,4 a 4,4 s por turno.

### D-21 · Sin prompt caching (por ahora)
Haiku 4.5 solo cachea prefijos de 4.096 tokens o más. El prefijo estable
(definiciones de herramientas y prompt de sistema) mide unos 1.500 tokens, así
que `cache_control` no tendría efecto. Además, el prompt de sistema lleva la
fecha y la hora del turno; si algún día se cachea, esa parte tiene que ir
después del último punto de corte. Se reevalúa si el prefijo crece (por
ejemplo, con instrucciones por clínica) o si se cambia a un modelo con un
mínimo de 512 tokens.

### D-22 · Un reintento no ve su propia respuesta anterior
Lo encontró el harness de volumen pausando MongoDB 25 s. Si un intento guardaba
la respuesta (`:salida`) y fallaba al guardar el turno, el reintento leía el
historial con esa respuesta incluida: el modelo veía su propia contestación al
mensaje que estaba respondiendo. En los grupos que peleaban por un horario, la
cita quedaba hecha en PostgreSQL, pero el reintento no volvía a llamar a
`agendar_cita`: la traza la perdía y la conversación bajaba de `cita_agendada` a
`resuelta_por_ia`. Ahora el historial de un turno excluye la salida de su propio
mensaje. El reintento vuelve a llamar a `agendar_cita`, que devuelve "ya era
tuya" (invariante 4), y la traza queda completa. Hay un test de regresión en
`tests/trabajador.test.ts`.

### D-23 · MongoDB con `socketTimeoutMS`
Sin ese límite, una operación contra un MongoDB que dejó de responder espera
para siempre, y el trabajo nunca falla ni se reintenta. Con 10 s, la operación
falla y la cola reintenta con espera exponencial. Medido con el harness de
volumen: una pausa de 8 s no provoca reintentos (las operaciones esperan y
siguen); con 25 s se reintentan 8 trabajos y con 60 s, 38 (hasta el último
intento). En los tres casos no hubo mensajes perdidos ni violaciones.

### D-24 · Capacidad medida
Con el harness de volumen (LLM falso con 300–1.500 ms de latencia, 20 turnos en
paralelo, un solo proceso trabajador): el webhook responde con p95 de 57 ms a
más de 3.000 peticiones por segundo, y el trabajador procesa entre 10 y 16 turnos
por segundo. El escenario del enunciado (20.000 mensajes al día, ~2–3 por segundo
en hora pico) usa una fracción de un solo proceso. En esas corridas el cuello de
botella es la latencia del LLM, no las bases. La prueba fue una ráfaga de 2.100
mensajes de una vez, no un flujo sostenido. Con el LLM real la latencia por
turno es de 1,4 a 4,4 s (D-20), así que la concurrencia del trabajador debe
dimensionarse con esa cifra y con los límites de tasa del proveedor.

### D-25 · RAG: modelo, partición, umbral y cómo se midió
- **Modelo:** `multilingual-e5-small`, local, en proceso (ONNX cuantizado q8).
  Cifras de las fichas oficiales, consultadas el 2026-10-03:

  | | `multilingual-e5-small` | `bge-m3` |
  |---|---|---|
  | Parámetros | 117.654.272 | — |
  | Capas | 12 | 24 |
  | Dimensiones | 384 | 1.024 |
  | Entrada máxima | 512 tokens | 8.192 tokens |
  | Peso en disco | 118 MB (ONNX q8), 470 MB (fp32) | 2,27 GB |

  Para 7 documentos con secciones de menos de 100 palabras, 384 dimensiones y
  512 tokens alcanzan. La ficha exige los prefijos `query: ` y `passage: `.
- **Partición:** una sección `##` es un fragmento; el título y la sección van
  dentro del texto que se embebe. Son 21 fragmentos.
- **Búsqueda:** pgvector, distancia coseno, recorrido exacto (D-07), k = 4.
- **Goldset** (`harness/rag/preguntas.json`): 24 preguntas con respuesta (con
  documento esperado y dato de referencia) y 16 sin respuesta (11 de dominio
  cercano, 5 fuera de dominio).
- **Recuperación** (`npm run harness:rag`): Recall@1 0,958, Recall@4 1,000,
  MRR@4 0,972.
- **Umbral 0,837.** La ficha de e5 avisa que las similitudes caen entre 0,7 y
  1,0, y medido sobre el goldset las dos poblaciones se solapan (AUC-ROC 0,885).
  Exigir cero falsos positivos deja pasar solo el 58 % de las preguntas con
  respuesta. Tres criterios (máximo F1, índice de Youden y cero falsos positivos
  fuera de dominio) coinciden en 0,837: deja pasar el 92 % de las preguntas con
  respuesta y bloquea todas las de fuera de dominio. Pasan 4 de dominio cercano
  (el tema está, el dato no); esas las resuelven el prompt y la barandilla
  (D-26).
- **Limitaciones, dichas con honestidad:**
  - el umbral se eligió sobre el mismo goldset que lo mide (no hay datos
    apartados);
  - el margen es de 0,001 (la pregunta más alta fuera de dominio dio 0,836);
  - el modelo reformula la pregunta antes de buscar, así que la similitud real
    varía. Un caso del goldset lo mostró: "precio de un trasplante de corazón"
    pasa el umbral y la pregunta original no.

### D-26 · Barandilla contra datos que no están en las fuentes
Hay tres capas, porque ninguna alcanza sola:
1. **Umbral** (D-25): filtra lo que está fuera de dominio.
2. **Prompt:** responder solo con los fragmentos y, si no mencionan algo, ni
   afirmarlo ni negarlo. La única lista cerrada es la de especialidades.
3. **Verificación determinista en código** (`dominio/respaldo.ts`):
   - todo número de la respuesta (hora, precio, teléfono, dirección, fecha)
     tiene que estar en la evidencia del turno: resultados de herramientas,
     conversación o prompt de sistema;
   - se aceptan las equivalencias que el modelo usa al redactar: 14:00 → 2,
     "06" → 6, "tres" → 3;
   - los argumentos del propio modelo no cuentan como evidencia;
   - si hay datos sin respaldo, el modelo recibe la lista y una oportunidad de
     corregir. Si insiste, se descarta su respuesta, va un mensaje fijo y la
     conversación escala. Cada control queda en la traza del turno.

**Medido de punta a punta** (`npm run harness:rag-e2e`, Haiku real más un juez
Sonnet 5.5 que ve el corpus completo):

| | Sin la regla del prompt | Con la regla |
|---|---|---|
| Exactitud (con respuesta) | 88 % | 92 % |
| Abstención correcta (sin respuesta) | 81 % | 94 % |
| Invención global | 8 % | 3 % |

La invención que queda es un "no hacemos cirugías" deducido de la lista cerrada
de especialidades: no es una cifra, así que la capa 3 no la ve. Cuesta USD 0,0043
por pregunta; el juez, que es andamio, va aparte. El juez se contradijo una vez
(razonó "correcta" y marcó "inventa"); ahora un `inventa` sin datos listados se
vuelve a juzgar. Es una sola corrida de 40 preguntas: el resultado es una señal,
no una cifra exacta.

**Pendiente de decisión:** una cuarta capa, un verificador con LLM para
afirmaciones sin cifras, a costa de una llamada más por respuesta informativa.

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
