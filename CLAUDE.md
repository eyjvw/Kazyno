# Kazyno

Casino de l'intra 42 Le Havre : les étudiants se connectent en OAuth 42 et misent des **points** (pas d'argent réel) sur des mini-jeux, des paris d'exam et des paris foot.

## Stack & layout

- `backend/` — Bun + Elysia + Postgres (`Bun.SQL`). Un module = un fichier dans `src/`, exporté comme plugin Elysia et branché dans `src/index.ts`. Pas d'ORM : SQL brut, schéma + migrations idempotentes dans `src/db.ts` (`initDb()` au boot).
- `frontend/` — Astro statique, pages dans `src/pages/`, helpers API dans `src/lib/casino.ts` (fetch + listeners WebSocket), i18n minimal fr/en dans `src/lib/i18n.ts`.
- `gateway/` — proxy Bun : `/api/*` → backend, le reste → frontend, WS sur `/api/ws`.
- Docker compose (postgres, backend, frontend, gateway) ; prod = override `docker-compose.prod.yml` avec Caddy devant.

## Lancer

```bash
cp .env.example .env   # remplir FT_UID / FT_SECRET (app OAuth intra) sinon login = 500
docker compose up -d --build   # dev sur http://localhost:8080
make deploy                    # prod (compose + prod override + Caddy)
```

Sans `.env` rempli le backend démarre quand même — seuls le login (FT_UID) et les features à clé API sont désactivés.

## Conventions

- Code : tabs, accolades Allman côté backend, commentaires et messages d'erreur **en français**, UI en français (i18n fr/en pour la nav).
- Commits : `feat(scope): description en français` (voir `git log`).
- Chaque mutation de points passe par un `UPDATE ... WHERE points >= mise RETURNING points` (débit atomique) + `publishBalance()` pour le temps réel.
- Rate limiting par domaine dans `src/ratelimit.ts` (`BUCKETS`), appelé en tête de chaque handler de mutation.
- Realtime : `publishToUser`/`publishBalance`/`publishLeaderboard` (`realtime.ts`), dispatch côté client dans le `switch` de `casino.ts` (~ligne 210).
- Notifications : `pushNotif(userId, { kind, message, link })` — les kinds inconnus de `CATEGORY_BY_KIND` (notifications.ts) sont toujours envoyés.

## Syncs automatiques (pattern examsync)

Jobs `setInterval` initialisés dans `index.ts` après le boot :
- `examsync.ts` — exams du campus depuis l'API 42, toutes les heures.
- `footsync.ts` — matchs + cotes 1N2 depuis **The Odds API** toutes les 6 h, règlement des paris toutes les 30 min via l'endpoint scores. Nécessite `ODDS_API_KEY` (clé gratuite the-odds-api.com, 500 crédits/mois — le rythme actuel en consomme ~400 pour 3 ligues). Ligues via `FOOT_LEAGUES` (sport keys The Odds API).

## Paris (page /paris)

Deux onglets : **Exams** (prédiction de note, barème par écart) et **Foot** (1N2, cote moyenne bookmakers verrouillée à la mise, annulable jusqu'au coup d'envoi, un pari par match). Backend : `exambets.ts`/`exams.ts` et `foot.ts`/`footsync.ts`. Le hash `#foot` ouvre l'onglet foot (utilisé par les liens de notification).

## Tester en dev sans OAuth

Pas de login mot de passe. Pour tester une route authentifiée : insérer un user en base (`docker exec kazyno-postgres psql -U kazyno -d kazyno`), puis forger le cookie `session` = JWT HS256 `{ sub: "<id>" }` signé avec le `SESSION_SECRET` du `.env` (via `jose`, dispo dans `backend/node_modules`).

## Pièges connus

- Cotes/floats en base : utiliser `DOUBLE PRECISION`, jamais `REAL` (1.65 → 1.649999976).
- `Bun.sql` + jsonb : caster `::text::jsonb` sinon les objets passés en string deviennent des scalars (voir fix notif_prefs dans db.ts).
- Docker sans sudo : le user doit être dans le groupe `docker` (session à relancer après `usermod -aG`).
