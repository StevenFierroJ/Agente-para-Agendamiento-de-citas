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

### D-03 · Mensajes del mismo teléfono: uno a la vez y en orden
- Bloqueo consultivo por conversación tomado con `pg_try_advisory_lock` (sin
  esperar). Si otro trabajador ya tiene la conversación, el trabajo se vuelve a
  encolar con un retraso corto en lugar de ocupar un trabajador esperando.
- Con el bloqueo tomado, se procesan los mensajes pendientes de la conversación
  en orden de `enviado_en`, no en el orden en que la cola los entregó.
- No se mantiene una transacción abierta durante la llamada al LLM.

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
