-- Horarios que consultar_disponibilidad le mostró al modelo en cada conversación.
-- agendar_cita solo acepta un horario ofrecido en la misma conversación (D-34):
-- el modelo no puede agendar un horario_id que no vio ni le mostró al paciente.
CREATE TABLE horarios_ofrecidos (
  conversacion_id integer NOT NULL REFERENCES conversaciones (id) ON DELETE CASCADE,
  horario_id      integer NOT NULL REFERENCES horarios (id) ON DELETE CASCADE,
  ofrecido_en     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversacion_id, horario_id)
);
