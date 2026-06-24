import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export const sql = new SQL(url);

export interface User {
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
export async function initDb(): Promise<void> {
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
}
