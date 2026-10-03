-- Huella del contenido de cada documento: el seed solo vuelve a calcular los
-- embeddings de un documento si su contenido cambió.
ALTER TABLE documentos ADD COLUMN contenido_hash text;

-- La sección de origen de cada fragmento, para mostrarla y citarla.
ALTER TABLE fragmentos ADD COLUMN seccion text NOT NULL DEFAULT '';
