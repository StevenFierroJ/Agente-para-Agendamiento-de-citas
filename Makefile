# Atajos sobre docker compose. Uso: make up | make logs | make ps | make down | make reset
.PHONY: up down logs ps reset

# Un solo comando desde un clon nuevo: crea .env si falta (nunca pisa uno existente)
# y avisa si no tiene la API key antes de levantar todo.
up:
	@test -f .env || (cp .env.example .env && echo "Se creó .env a partir de .env.example")
	@grep -qE '^ANTHROPIC_API_KEY=.+' .env || (echo ""; echo "Falta tu API key: edita .env y completa ANTHROPIC_API_KEY=sk-ant-..., luego vuelve a correr make up"; echo ""; exit 1)
	docker compose up --build -d
	@echo ""
	@echo "Listo:"
	@echo "  Interfaz   http://localhost:8080   (conversaciones, trazas, agenda, conocimiento, simulador)"
	@echo "  API        http://localhost:3000   (POST /webhooks/messages, GET /conversaciones, /turnos, /agenda, /conocimiento)"
	@echo "  Logs       make logs     ·     Detener   make down"

logs:
	docker compose logs -f api trabajador

ps:
	docker compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"

down:
	docker compose down

# Borra también los datos: agenda, conversaciones y citas vuelven a cero.
reset:
	docker compose down -v
