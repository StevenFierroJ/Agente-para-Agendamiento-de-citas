# Asistente de agendamiento con IA

Servicio que recibe mensajes de pacientes de una clínica ficticia (simula
WhatsApp), responde con Claude Haiku 4.5 consultando los documentos de la clínica
y agenda citas en una agenda real. La operación es en Colombia (`America/Bogota`).

- **Diseño, decisiones, costos y AWS:** [DECISIONS.md](DECISIONS.md)
- **Arquitectura en AWS** (diagrama, servicios, escalado, fallas, costo mensual y
  multi-tenant): [DECISIONS.md §3](DECISIONS.md#3-nube-aws)
- **Harness (goldset, RAG, volumen):** [backend/harness/README.md](backend/harness/README.md)

## Puesta en marcha: un comando

Requisitos: Docker con Compose v2 y una API key de Anthropic.

```bash
cp .env.example .env        # y pon tu key en ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build -d
```

O con make, que además imprime dónde abrir cada cosa al terminar:

```bash
make up
```

| Qué | Dónde |
|---|---|
| **Interfaz** (bandeja, detalle, simulador) | **http://localhost:8080** |
| API | http://localhost:3000 |

Con `-d` corre en segundo plano y te devuelve la terminal. Sin `-d` también
funciona, pero la terminal queda mostrando los logs de todos los servicios y no
"termina": son servidores que siguen corriendo hasta que los detengas.

| Para | Con make | Con docker compose |
|---|---|---|
| Ver servicios y puertos | `make ps` | `docker compose ps` |
| Seguir los logs de la aplicación | `make logs` | `docker compose logs -f api trabajador` |
| Detener todo, conservando los datos | `make down` | `docker compose down` |
| Detener todo y borrar los datos | `make reset` | `docker compose down -v` |

- **Interfaz:** http://localhost:8080. Tiene tres vistas: **bandeja** con filtro
  por estado, **detalle** de cada conversación con las herramientas y el costo
  de cada respuesta, y **simulador** de paciente.
- **API:** http://localhost:3000.

Qué levanta, en orden:

| Servicio | Qué hace |
|---|---|
| `postgres`, `mongo` | Bases de datos, con chequeo de salud |
| `preparar` | Migraciones, agenda de 14 días e indexación de documentos; termina y sale (idempotente) |
| `api` | Webhook y lectura; espera a que `preparar` termine bien |
| `trabajador` | Consume la cola y llama a Claude; sin `ANTHROPIC_API_KEY` falla con un mensaje claro |
| `web` | Frontend compilado servido por nginx, con `/api` hacia la API |

La primera construcción tarda unos minutos: instala dependencias y deja el modelo
de embeddings (~118 MB) **dentro de la imagen**, así el arranque no depende de la
red. Las URLs de las bases del `.env` apuntan a `localhost` para el modo
desarrollo; dentro de compose se reemplazan por los nombres de servicio.


## Modo desarrollo (sin contenedores para la aplicación)

Requiere Node.js 20 o superior, además de Docker para las bases.

```bash
docker compose up -d postgres mongo
cd backend && npm ci && npm run seed   # la primera vez descarga multilingual-e5-small (~118 MB)
npm run api                            # terminal 1 · http://localhost:3000
npm run trabajador                     # terminal 2
cd ../frontend && npm ci && npm run dev  # terminal 3 · http://localhost:5173
```

### Configurar la API key

Basta con `ANTHROPIC_API_KEY` en `.env` (está en `.gitignore`). El resto tiene
valores por defecto razonables:

| Variable | Por defecto | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Obligatoria para el trabajador |
| `LLM_MODEL` | `claude-haiku-4-5` | Modelo |
| `LLM_TIMEOUT_MS` / `LLM_MAX_ITERACIONES` | `20000` / `5` | Límite por llamada y tope de iteraciones del ciclo de herramientas |
| `LLM_PRECIO_ENTRADA_1M` / `LLM_PRECIO_SALIDA_1M` | — | USD por millón de tokens, para el costo de cada turno; vacío = costo desconocido |
| `RAG_UMBRAL` | `0.837` | Similitud mínima de un fragmento, calibrada (DECISIONS §4) |
| `SEED_DESDE` | hoy | Primer día de la agenda (`YYYY-MM-DD`, hora de Colombia) |
| `DATABASE_URL` / `MONGO_URL` | los de `docker-compose.yml` | Bases de datos |

### Reproducir el ejemplo del enunciado

El seed genera 14 días de agenda desde hoy. El ejemplo del enunciado llega el
`2026-10-06T03:40:00Z`; si evalúas después de esa fecha, pon `SEED_DESDE=2026-10-05`
en `.env` y vuelve a correr la preparación. Es idempotente y solo agrega los días
que faltan:

```bash
docker compose up preparar                       # con Docker
cd backend && SEED_DESDE=2026-10-05 npm run seed   # en modo desarrollo
```

## Endpoints

| Método y ruta | Respuesta |
|---|---|
| `POST /webhooks/messages` | `202 {estado: "recibido", message_id, conversacion_id}` · `200 {estado: "duplicado", …}` si el `message_id` ya llegó · `400 {error: "cuerpo_invalido", detalle: [{campo, mensaje}]}` |
| `GET /conversaciones?estado=&limite=&antes=` | Bandeja ordenada por último mensaje; `estado` ∈ `abierta`, `resuelta_por_ia`, `cita_agendada`, `escalada`; paginación con el cursor `siguiente` |
| `GET /conversaciones/:id` | Mensajes, turnos (modelo, tokens, costo, latencia, herramientas con argumentos y resultado, controles), citas, pendientes, `respondiendo` y resumen de costo |
| `GET /salud` | Estado de PostgreSQL y MongoDB |

El cuerpo del webhook es el del enunciado: `message_id`, `from` (E.164), `text`
(hasta 4.096 caracteres) y `timestamp` (ISO 8601 **con zona**). Un campo de más
también es un 400.

## Mensajes de ejemplo: casos borde

Con el sistema corriendo (`docker compose up` o el modo desarrollo). Cada
respuesta se ve en `GET /conversaciones/<conversacion_id>` o en la interfaz.

```bash
enviar() { curl -s -X POST localhost:3000/webhooks/messages -H 'content-type: application/json' -d "$1"; echo; }
AHORA=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

**1. Zona horaria: el mensaje del enunciado.** Llega a las 03:40 UTC del 6, que en
Cali son las 10:40 p. m. del 5: "mañana" es el 6. El asistente consulta
dermatología para `2026-10-06` (requiere la agenda de esa semana, ver arriba).

```bash
enviar '{"message_id":"ej.1","from":"+573001112233","text":"Hola, ¿tienen cita con dermatología mañana en la tarde?","timestamp":"2026-10-06T03:40:00Z"}'
```

**2. Mensaje duplicado:** el mismo `message_id` dos veces. Primero responde 202,
después 200, y hay un solo turno y una sola respuesta.

```bash
enviar "{\"message_id\":\"ej.2\",\"from\":\"+573002223344\",\"text\":\"Hola\",\"timestamp\":\"$AHORA\"}"
enviar "{\"message_id\":\"ej.2\",\"from\":\"+573002223344\",\"text\":\"Hola\",\"timestamp\":\"$AHORA\"}"
```

**3. Dato que no está en los documentos:** no lo inventa. Los documentos hablan de
pagos, pero no de precios. El asistente dice que no tiene el dato u ofrece un
asesor; si citara un precio, la barandilla lo detectaría y lo descartaría.

```bash
enviar "{\"message_id\":\"ej.3\",\"from\":\"+573003334455\",\"text\":\"¿Cuánto cuesta la consulta de dermatología?\",\"timestamp\":\"$AHORA\"}"
```

**4. Sede inexistente y escalamiento.** La herramienta devuelve
`sede_inexistente` con la lista de sedes válidas y el modelo pregunta. Después el
paciente pide un humano: la conversación queda `escalada`, y desde ahí cada
mensaje recibe una respuesta fija sin llamar al LLM.

```bash
enviar "{\"message_id\":\"ej.4a\",\"from\":\"+573004445566\",\"text\":\"Quiero cita de medicina general en la sede Centro\",\"timestamp\":\"$AHORA\"}"
enviar "{\"message_id\":\"ej.4b\",\"from\":\"+573004445566\",\"text\":\"Mejor quiero hablar con una persona\",\"timestamp\":\"$AHORA\"}"
```

**5. Cuerpo inválido:** un `timestamp` sin zona es ambiguo y se rechaza con 400 y
el detalle por campo.

```bash
enviar '{"message_id":"ej.5","from":"+573005556677","text":"Hola","timestamp":"2026-10-05T09:00:00"}'
```

## Tests y harness

Los tests corren contra PostgreSQL y MongoDB reales (`docker compose up -d`) y
nunca llaman al LLM real ni descargan el modelo de embeddings.

```bash
cd backend
npm test                    # 211 tests (Vitest), sin LLM real
npm run typecheck

npm run harness:gold        # 31 conversaciones guionadas por el sistema completo (no gasta)
npm run harness:gold -- --modo real                    # 10 casos con Haiku real (gasta ~USD 0,05)
npm run harness:carga       # volumen: 2.000 mensajes, duplicados, disputas, caos opcional
npm run harness:rag         # Recall@k, MRR y AUC del RAG; calibración del umbral
npm run harness:rag-e2e     # punta a punta con Haiku y un juez Sonnet (gasta ~USD 0,45)
```

Los harness usan una base aparte (`agenda_harness`) y escriben su transcript en
`backend/harness/out/`.

## Estructura

```
backend/
  src/dominio/          reglas puras (fechas en Colombia, agenda, estados, respaldo de datos)
  src/aplicacion/       ciclo del turno, herramientas, prompt, puertos
  src/infraestructura/  PostgreSQL, MongoDB, cola, Anthropic, embeddings
  src/http/             webhook y lectura
  migraciones/          SQL numerado
  seed/                 agenda y documentos de la clínica
  harness/              goldset, RAG y volumen
  tests/
frontend/               React + Vite
DECISIONS.md            decisiones, AWS, costos, trade-offs
NOTAS_IA.md             qué entregó mal la IA y cómo se corrigió
```

## Problemas comunes

- **Puerto 5432, 27017, 3000 u 8080 ocupado:** otro servicio local lo está
  usando. Detenlo, o cambia el puerto de la izquierda en `docker-compose.yml`
  (y en `.env` si es una base de datos).
- **Con Colima en macOS:** `colima start` antes de `docker compose`.
- **El trabajador no arranca:** falta `ANTHROPIC_API_KEY` en `.env`; el error lo
  dice.
- **"No hay horarios libres" en el ejemplo del enunciado:** la agenda no cubre el
  6 de octubre de 2026. Ver "Reproducir el ejemplo del enunciado".
