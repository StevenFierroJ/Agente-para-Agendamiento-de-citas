-- Esquema inicial. PostgreSQL es la fuente de verdad de todo lo que necesita
-- transacciones y restricciones: agenda, citas, estado de las conversaciones,
-- idempotencia del webhook y vectores del RAG.

CREATE EXTENSION IF NOT EXISTS vector;

-- Agenda ---------------------------------------------------------------------

CREATE TABLE sedes (
  id     serial PRIMARY KEY,
  nombre text NOT NULL UNIQUE
);

CREATE TABLE especialidades (
  id     serial PRIMARY KEY,
  nombre text NOT NULL UNIQUE
);

CREATE TABLE profesionales (
  id              serial PRIMARY KEY,
  nombre          text NOT NULL UNIQUE,
  especialidad_id integer NOT NULL REFERENCES especialidades (id)
);

CREATE TABLE horarios (
  id             serial PRIMARY KEY,
  profesional_id integer NOT NULL REFERENCES profesionales (id),
  sede_id        integer NOT NULL REFERENCES sedes (id),
  inicio         timestamptz NOT NULL,
  fin            timestamptz NOT NULL,
  CONSTRAINT horarios_fin_despues_de_inicio CHECK (fin > inicio),
  CONSTRAINT horarios_profesional_inicio_unico UNIQUE (profesional_id, inicio)
);

-- Disponibilidad por sede y fecha: WHERE sede_id = $1 AND inicio >= $2 AND inicio < $3
CREATE INDEX horarios_sede_inicio_idx ON horarios (sede_id, inicio);

-- Conversaciones -------------------------------------------------------------

CREATE TABLE conversaciones (
  id                serial PRIMARY KEY,
  telefono          text NOT NULL UNIQUE,
  estado            text NOT NULL DEFAULT 'abierta'
                    CHECK (estado IN ('abierta', 'resuelta_por_ia', 'cita_agendada', 'escalada')),
  ultimo_mensaje_en timestamptz NOT NULL
);

-- Bandeja: WHERE estado = $1 ORDER BY ultimo_mensaje_en DESC
CREATE INDEX conversaciones_estado_ultimo_idx ON conversaciones (estado, ultimo_mensaje_en DESC);

CREATE TABLE citas (
  id              serial PRIMARY KEY,
  horario_id      integer NOT NULL REFERENCES horarios (id),
  conversacion_id integer NOT NULL REFERENCES conversaciones (id),
  nombre_paciente text NOT NULL,
  estado          text NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'cancelada')),
  creada_en       timestamptz NOT NULL DEFAULT now()
);

-- La garantía contra la cita duplicada: un horario tiene a lo sumo una cita activa.
-- Dos inserciones concurrentes sobre el mismo horario: una gana, la otra recibe 23505.
CREATE UNIQUE INDEX citas_horario_activa_unica ON citas (horario_id) WHERE estado = 'activa';

-- Idempotencia del webhook: message_id es la llave primaria.
-- El texto y el timestamp quedan aquí para que el trabajador no dependa del
-- contenido del trabajo en la cola.
CREATE TABLE mensajes_entrantes (
  message_id      text PRIMARY KEY,
  conversacion_id integer NOT NULL REFERENCES conversaciones (id),
  texto           text NOT NULL,
  enviado_en      timestamptz NOT NULL,
  estado          text NOT NULL DEFAULT 'recibido'
                  CHECK (estado IN ('recibido', 'procesando', 'procesado', 'fallido')),
  recibido_en     timestamptz NOT NULL DEFAULT now()
);

-- Mensajes pendientes de una conversación, en orden de envío.
CREATE INDEX mensajes_entrantes_conversacion_idx ON mensajes_entrantes (conversacion_id, enviado_en);

-- RAG ------------------------------------------------------------------------

CREATE TABLE documentos (
  id     serial PRIMARY KEY,
  titulo text NOT NULL,
  origen text NOT NULL UNIQUE
);

-- Sin índice vectorial (HNSW/IVFFlat): con decenas de fragmentos el recorrido
-- completo es exacto y más rápido que mantener un índice aproximado.
CREATE TABLE fragmentos (
  id           serial PRIMARY KEY,
  documento_id integer NOT NULL REFERENCES documentos (id) ON DELETE CASCADE,
  texto        text NOT NULL,
  embedding    vector(384) NOT NULL
);
