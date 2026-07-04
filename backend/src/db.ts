import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export const sql = new SQL(url);

export interface User
{
	id: number;
	login: string;
	email: string | null;
	password_hash: string | null;
	ft_id: number | null;
	display_name: string | null;
	image_url: string | null;
	points: number;
	created_at: string;
}

// Fields safe to return to the client (never the password hash).
export type PublicUser = Pick<
	User,
	"id" | "login" | "email" | "display_name" | "image_url" | "points"
>;

// Create schema on boot, then run idempotent migrations so existing volumes
// (created before password auth) get the new columns/constraints.
export async function initDb(): Promise<void>
{
	await sql`
		CREATE TABLE IF NOT EXISTS users (
			id            SERIAL PRIMARY KEY,
			login         TEXT UNIQUE NOT NULL,
			email         TEXT UNIQUE,
			password_hash TEXT,
			ft_id         BIGINT UNIQUE,
			display_name  TEXT,
			image_url     TEXT,
			points        INTEGER NOT NULL DEFAULT 1000,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;

	// Migrations for pre-existing tables.
	await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`;
	await sql`ALTER TABLE users ALTER COLUMN ft_id DROP NOT NULL`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_login_key ON users (login)`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email)`;

	await sql`
		CREATE TABLE IF NOT EXISTS friendships (
			id            SERIAL PRIMARY KEY,
			requester_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			addressee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			status        TEXT NOT NULL DEFAULT 'pending',
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
			CHECK (requester_id <> addressee_id),
			UNIQUE (requester_id, addressee_id)
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS friendships_addressee_idx ON friendships (addressee_id)`;

	await sql`
		CREATE TABLE IF NOT EXISTS exam_bets (
			id          SERIAL PRIMARY KEY,
			user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			predicted   INTEGER NOT NULL,
			stake       INTEGER NOT NULL,
			status      TEXT NOT NULL DEFAULT 'pending',
			actual      INTEGER,
			exam_id     INTEGER,
			multiplier  REAL NOT NULL DEFAULT 0,
			payout      INTEGER NOT NULL DEFAULT 0,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
			settled_at  TIMESTAMPTZ
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS exam_bets_status_idx ON exam_bets (status)`;
	await sql`ALTER TABLE exam_bets ADD COLUMN IF NOT EXISTS exam_type TEXT NOT NULL DEFAULT 'standard'`;

	await sql`
		CREATE TABLE IF NOT EXISTS exams (
			id         SERIAL PRIMARY KEY,
			label      TEXT NOT NULL,
			exam_date  TIMESTAMPTZ NOT NULL,
			is_final   BOOLEAN NOT NULL DEFAULT false,
			locked     BOOLEAN NOT NULL DEFAULT false,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS exams_date_idx ON exams (exam_date)`;
	await sql`ALTER TABLE exam_bets ADD COLUMN IF NOT EXISTS exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL`;

	await sql`
		CREATE TABLE IF NOT EXISTS notifications (
			id          SERIAL PRIMARY KEY,
			user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			kind        TEXT NOT NULL,
			message     TEXT NOT NULL,
			from_id     INTEGER,
			from_login  TEXT,
			from_name   TEXT,
			from_image  TEXT,
			link        TEXT,
			read        BOOLEAN NOT NULL DEFAULT false,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC)`;

	await sql`
		CREATE TABLE IF NOT EXISTS admin_logs (
			id      BIGSERIAL PRIMARY KEY,
			ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
			action  TEXT NOT NULL,
			payload JSONB NOT NULL DEFAULT '{}'
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS admin_logs_ts_idx ON admin_logs (ts DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS admin_logs_action_idx ON admin_logs (action)`;
	await sql`CREATE INDEX IF NOT EXISTS admin_logs_payload_idx ON admin_logs USING gin (payload)`;

	await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_streak INT NOT NULL DEFAULT 0`;
	await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily DATE`;

	await sql`
		CREATE TABLE IF NOT EXISTS achievements (
			id          SERIAL PRIMARY KEY,
			user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			key         TEXT NOT NULL,
			unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE (user_id, key)
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS achievements_user_idx ON achievements (user_id)`;

	await sql`
		CREATE TABLE IF NOT EXISTS challenge_progress (
			id           SERIAL PRIMARY KEY,
			user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			week         INTEGER NOT NULL,
			year         INTEGER NOT NULL,
			key          TEXT NOT NULL,
			progress     INTEGER NOT NULL DEFAULT 0,
			completed    BOOLEAN NOT NULL DEFAULT false,
			completed_at TIMESTAMPTZ,
			UNIQUE (user_id, year, week, key)
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS challenge_progress_user_idx ON challenge_progress (user_id, year, week)`;

	await sql`
		CREATE TABLE IF NOT EXISTS game_stats (
			user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			game          TEXT NOT NULL,
			games_played  INTEGER NOT NULL DEFAULT 0,
			total_wagered BIGINT NOT NULL DEFAULT 0,
			total_payout  BIGINT NOT NULL DEFAULT 0,
			biggest_win   INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (user_id, game)
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS game_stats_game_idx ON game_stats (game, (total_payout - total_wagered) DESC)`;

	// Progressive jackpot: single-row pot fed by a cut of losing wagers.
	await sql`
		CREATE TABLE IF NOT EXISTS jackpot (
			id     INTEGER PRIMARY KEY CHECK (id = 1),
			amount BIGINT NOT NULL DEFAULT 10000
		)
	`;
	await sql`INSERT INTO jackpot (id, amount) VALUES (1, 10000) ON CONFLICT (id) DO NOTHING`;

	await sql`
		CREATE TABLE IF NOT EXISTS duels (
			id            SERIAL PRIMARY KEY,
			challenger_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			opponent_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			stake         INTEGER NOT NULL,
			status        TEXT NOT NULL DEFAULT 'pending',
			winner_id     INTEGER,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
			resolved_at   TIMESTAMPTZ,
			CHECK (challenger_id <> opponent_id)
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS duels_opponent_idx ON duels (opponent_id, status)`;
	await sql`CREATE INDEX IF NOT EXISTS duels_challenger_idx ON duels (challenger_id, status)`;

	// Cosmetic shop: owned items + equipped cosmetics on users.
	await sql`
		CREATE TABLE IF NOT EXISTS user_items (
			user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			item_key  TEXT NOT NULL,
			bought_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (user_id, item_key)
		)
	`;
	await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT`;
	await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name_color TEXT`;

	// Per-bet history for the personal profit graph.
	await sql`
		CREATE TABLE IF NOT EXISTS game_history (
			id         BIGSERIAL PRIMARY KEY,
			user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			game       TEXT NOT NULL,
			bet        INTEGER NOT NULL,
			payout     INTEGER NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS game_history_user_idx ON game_history (user_id, id DESC)`;

	// Provably fair seed pairs.
	await sql`
		CREATE TABLE IF NOT EXISTS user_seeds (
			user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			server_seed TEXT NOT NULL,
			client_seed TEXT NOT NULL,
			nonce       INTEGER NOT NULL DEFAULT 0
		)
	`;
}
