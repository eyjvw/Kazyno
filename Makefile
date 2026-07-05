# Kazyno — raccourcis docker compose (dev local + VPS)

.PHONY: up down build deploy logs ps psql backup restore

# Build + démarre tout
up:
	docker compose up -d --build

down:
	docker compose down

build:
	docker compose build

# Déploiement VPS : pull + rebuild + restart + ménage
deploy:
	git pull
	docker compose up -d --build
	docker image prune -f

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

# Console SQL directe
psql:
	docker compose exec postgres psql -U kazyno -d kazyno

# Dump gzippé horodaté dans ./backups/
backup:
	@mkdir -p backups
	docker compose exec -T postgres pg_dump -U kazyno kazyno | gzip > backups/kazyno-$$(date +%Y%m%d-%H%M).sql.gz
	@command ls -lh backups/ | tail -3

# make restore FILE=backups/kazyno-XXXX.sql.gz  (ATTENTION : écrase la DB)
restore:
	@test -n "$(FILE)" || (echo "usage: make restore FILE=backups/xxx.sql.gz" && exit 1)
	gunzip -c $(FILE) | docker compose exec -T postgres psql -U kazyno -d kazyno
