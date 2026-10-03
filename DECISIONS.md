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
