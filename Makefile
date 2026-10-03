# Atajos sobre docker compose. Uso: make up | make logs | make ps | make down | make reset
.PHONY: up down logs ps reset

up:
	docker compose up --build -d
	@echo ""
	@echo "Listo:"
	@echo "  Interfaz   http://localhost:8080   (bandeja, detalle, simulador)"
	@echo "  API        http://localhost:3000   (POST /webhooks/messages, GET /conversaciones)"
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
