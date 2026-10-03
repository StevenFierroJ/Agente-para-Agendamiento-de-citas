-- Bandeja con paginación por cursor (ultimo_mensaje_en, id):
--   con filtro:  WHERE estado = $1 ORDER BY ultimo_mensaje_en DESC, id DESC
--   sin filtro:  ORDER BY ultimo_mensaje_en DESC, id DESC
-- El índice de 001 no tenía el id de desempate ni servía a la consulta sin filtro.
DROP INDEX conversaciones_estado_ultimo_idx;
CREATE INDEX conversaciones_estado_ultimo_idx ON conversaciones (estado, ultimo_mensaje_en DESC, id DESC);
CREATE INDEX conversaciones_ultimo_idx ON conversaciones (ultimo_mensaje_en DESC, id DESC);
