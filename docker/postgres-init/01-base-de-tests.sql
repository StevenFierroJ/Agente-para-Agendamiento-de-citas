-- Base separada para los tests: se migra y se vacía en cada corrida.
CREATE DATABASE agenda_test OWNER agenda;

-- Base del harness (goldset y volumen): se vacía entre casos.
CREATE DATABASE agenda_harness OWNER agenda;
