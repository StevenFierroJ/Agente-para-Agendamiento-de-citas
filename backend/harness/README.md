# Harness

Dos herramientas que corren el sistema **completo** (webhook → cola → trabajador →
herramientas → PostgreSQL y MongoDB) y comparan lo que quedó en las bases contra
lo esperado. No reemplazan a los tests de Vitest, que prueban piezas; miden el
sistema armado.

| | Goldset (`gold/`) | Volumen (`carga/`) |
|---|---|---|
| Pregunta | ¿cada excepción se maneja como se decidió? | ¿las invariantes aguantan con concurrencia y duplicados? |
| Entrada | 26 conversaciones (25 guionadas y 1 solo para el modelo real) | mensajes generados con semilla |
| LLM | falso guionado (`guion`) o real (`real`) | falso, con latencia simulada |
| Falla si | un turno o el estado final no coincide | se viola cualquier invariante |

## Goldset

```bash
npm run harness:gold                       # modo guion: no gasta, determinista
npm run harness:gold -- --solo llm-timeout,webhook-duplicado
npm run harness:gold -- --modo real        # gasta: llama al LLM configurado en .env
```

### Qué es un caso

Un archivo en `gold/casos/<id>.json` con el esquema de `gold/esquema.ts`:

- `cubre`: las situaciones de `excepciones.ts` que el caso ejercita. El test
  `tests/harness-goldset.test.ts` falla si alguna situación queda sin caso; si se
  agrega un código de error al dominio, hay que escribir su caso.
- `preparacion`: citas previas y conversaciones ya escaladas.
- `envios`: cuerpos que se mandan al webhook. Los del mismo `grupo` salen a la
  vez; el resto, en orden. `http` es el código esperado de cada envío.
- `guion`: en modo guion, la respuesta del LLM falso a cada llamada, en orden.
  Una `falla` simula timeout o error del proveedor.
- `espera`: lo que tuvo que pasar en el turno (herramientas exactas y en orden,
  con su error o éxito; estado final; texto de la respuesta; prompt de sistema).
- `espera_real`: lo mismo, laxo, para el modo real. Un caso sin `real` en
  `modos` no se corre con el LLM real (por ejemplo, los de fallas inyectadas).
- `espera_final`: el estado de las bases al terminar.

Los horarios se nombran por especialidad, sede e inicio (`$horario`), nunca por
id: el runner los resuelve contra la agenda del harness, que siempre arranca el
lunes 5 de octubre de 2026 (`SEED_DESDE_HARNESS`).

### Decisiones heredadas del harness de Morton

1. **El guion declara su paso.** El LLM falso no decide cuándo equivocarse; si
   lo hiciera, dos corridas no serían comparables.
2. **Se guarda todo antes de puntuar.** `out/gold-<sello>.json` lleva el
   transcript completo (envíos, respuestas HTTP, turnos, prompts, llamadas). Un
   caso que falla tiene que poder leerse sin volver a correrlo.
3. **La configuración viaja con la medición.** Modelo, precios y umbral se
   escriben en la corrida al momento de correr, no se leen del `.env` al reportar.
4. **Un precio desconocido es vacío, no cero.** Si faltan los precios, el costo
   se reporta como desconocido.
5. **`validado_por`.** Los casos los escribió quien construyó el sistema; el
   reporte cuenta cuántos van sin revisión externa.

### Invariantes que se revisan en todos los casos

- Ningún pedido al LLM contiene el teléfono del remitente.
- Ningún horario tiene más de una cita activa.
- Todo mensaje aceptado (202) terminó `procesado`, con un turno y dos mensajes
  (entrada y salida) en MongoDB.
- Un mensaje rechazado (400) no dejó conversación, ni fila en
  `mensajes_entrantes`, ni trabajo en la cola.

## Volumen

```bash
npm run harness:carga -- --mensajes 2000 --telefonos 300 --concurrencia 50 \
  --duplicados 0.1 --contencion 20 --latencia-llm 300-1500 --semilla 42
```

### Qué genera

- `--mensajes` en total, repartidos entre `--telefonos` conversaciones, enviados
  con `--concurrencia` peticiones simultáneas.
- `--duplicados`: fracción de mensajes que se reenvían con el mismo `message_id`.
- `--contencion`: grupos de conversaciones que piden el mismo horario a la vez.
- El LLM falso responde según el texto generado (pregunta, consulta o agendamiento)
  con una latencia aleatoria dentro de `--latencia-llm`.
- `--caos llm=0.05`: fracción de llamadas al LLM que fallan dos veces seguidas.
- `--caos mongo`: pausa el contenedor de MongoDB a mitad de la corrida y lo reanuda.

### Qué mide

- Webhook: peticiones por segundo, latencia p50/p95/p99/máx, conteo por código HTTP.
- Extremo a extremo (envío → respuesta guardada en MongoDB): p50/p95/p99.
- Tiempo hasta vaciar la cola y profundidad máxima de la cola.

### Invariantes (cualquier violación → código de salida 1)

1. Cada `message_id` único tiene exactamente una fila en `mensajes_entrantes`, en
   `procesado`, un turno y dos mensajes en MongoDB.
2. Un duplicado recibió 200, nunca un segundo 202.
3. Ningún horario tiene más de una cita activa; cada horario disputado tiene
   exactamente una, y los perdedores recibieron `horario_ocupado`.
4. Los turnos de una conversación no se solapan y siguen el orden de `timestamp`.
5. Al terminar no queda ningún mensaje en `recibido` ni `procesando`.
6. Con `--caos llm`, las conversaciones escaladas por falla coinciden con las
   fallas inyectadas.
7. Ningún pedido al LLM contiene un teléfono.

### Referencia de escala

20.000 mensajes al día para 50 clínicas son ~0,23 mensajes por segundo en
promedio; con un pico de 10× en horario de oficina, ~2–3 por segundo. La corrida
por defecto (2.000 mensajes con 50 simultáneos) está muy por encima de ese pico:
mide holgura, no el caso medio.

### Qué se midió (2026-10-03)

| Corrida | Resultado |
|---|---|
| 2.000 mensajes, 300 teléfonos, 10 % duplicados, 20 grupos en disputa, caos LLM 5 % | sin violaciones; webhook p95 57 ms; 15,9 turnos/s |
| 300 mensajes, MongoDB en pausa 25 s (antes de D-22) | 4 violaciones: grupos en disputa sin la traza de `agendar_cita` |
| la misma, después de D-22 | sin violaciones; 8 trabajos reintentados |
| 300 mensajes, MongoDB en pausa 60 s | sin violaciones; 38 trabajos reintentados, hasta el último intento |

El histórico completo está en `carga/METRICAS_CARGA.csv`.

### Salidas

`out/carga-<sello>.json` con la configuración y todas las mediciones, y una fila
por corrida en `METRICAS_CARGA.csv` (`snapshot`, configuración, métricas,
violaciones) para comparar entre corridas.
