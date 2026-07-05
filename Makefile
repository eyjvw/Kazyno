# Kazyno — raccourcis docker compose
# Dev local :  make up / down / logs        (gateway sur localhost:8080)
# Prod VPS  :  make deploy / prod-up / prod-down   (Caddy devant, ports 80/443)

COMPOSE      = docker compose
COMPOSE_PROD = docker compose -f docker-compose.yml -f docker-compose.prod.yml

.PHONY: up down build deploy prod-up prod-down logs ps psql backup restore

# ── Dev local ────────────────────────────────────────────────────────────
up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

build:
	$(COMPOSE) build

# ── Prod (VPS, avec Caddy) ───────────────────────────────────────────────
prod-up:
	$(COMPOSE_PROD) up -d --build

prod-down:
	$(COMPOSE_PROD) down

# Déploiement : pull + rebuild + restart + ménage
deploy:
	git pull
	$(COMPOSE_PROD) up -d --build
	docker image prune -f

# ── Commun ───────────────────────────────────────────────────────────────
logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

# Console SQL directe
psql:
	$(COMPOSE) exec postgres psql -U kazyno -d kazyno

# Dump gzippé horodaté dans ./backups/
backup:
	@mkdir -p backups
	$(COMPOSE) exec -T postgres pg_dump -U kazyno kazyno | gzip > backups/kazyno-$$(date +%Y%m%d-%H%M).sql.gz
	@command ls -lh backups/ | tail -3

# make restore FILE=backups/kazyno-XXXX.sql.gz  (ATTENTION : écrase la DB)
restore:
	@test -n "$(FILE)" || (echo "usage: make restore FILE=backups/xxx.sql.gz" && exit 1)
	gunzip -c $(FILE) | $(COMPOSE) exec -T postgres psql -U kazyno -d kazyno
