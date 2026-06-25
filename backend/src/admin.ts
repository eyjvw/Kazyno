import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishAdminLog, publishBroadcast } from "./realtime";
import { pushNotif, pushNotifAll, type Sender } from "./notifications";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const ADMINS = (process.env.ADMIN_LOGINS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const admin = new Elysia({ prefix: "/api/admin" })
  .use(jwt({ name: "jwt", secret: SESSION_SECRET }))
  .derive(async ({ jwt, cookie: { session } }) => {
    const payload = session.value ? await jwt.verify(session.value) : false;
    const userId = payload && payload.sub ? Number(payload.sub) : null;
    let login: string | null = null;
    if (userId) {
      const r = (await sql`SELECT login FROM users WHERE id=${userId}`) as Array<{
        login: string;
      }>;
      login = r[0]?.login?.toLowerCase() ?? null;
    }
    return { userId, isAdmin: !!login && ADMINS.includes(login) };
  })

  // Always-200 check so the frontend can show/hide the admin UI.
  .get("/me", ({ userId, isAdmin, set }) => {
    if (!userId) {
      set.status = 401;
      return { isAdmin: false };
    }
    return { isAdmin };
  })

  // Search players (admin only, includes self).
  .get("/search", async ({ isAdmin, query, set }) => {
    if (!isAdmin) return forbid(set);
    const q = String(query.q ?? "").trim().toLowerCase();
    if (q.length < 1) return { results: [] };
    const results = (await sql`
      SELECT id, login, display_name, image_url, points FROM users
      WHERE lower(login) LIKE ${"%" + q + "%"}
      ORDER BY login LIMIT 20
    `) as unknown[];
    return { results };
  })

  // Broadcast a notification (to everyone, or one login).
  .post(
    "/notify",
    async ({ isAdmin, userId, body, set }) => {
      if (!isAdmin) return forbid(set);
      const message = body.message.trim().slice(0, 280);
      if (!message) return err(set, 422, "message vide");
      const me = await senderCard(userId!);
      if (body.login) {
        const r = (await sql`
          SELECT id FROM users WHERE lower(login)=${body.login.trim().toLowerCase()}
        `) as Array<{ id: number }>;
        if (!r[0]) return err(set, 404, "joueur introuvable");
        await pushNotif(r[0].id, { kind: "admin", message, from: me });
      } else {
        await pushNotifAll({ kind: "admin", message, from: me });
      }
      return { ok: true };
    },
    { body: t.Object({ message: t.String(), login: t.Optional(t.String()) }) },
  )

  // Grant (or remove, if negative) points to a user.
  .post(
    "/points",
    async ({ isAdmin, userId, body, set }) => {
      if (!isAdmin) return forbid(set);
      const amount = Math.trunc(body.amount);
      if (!amount) return err(set, 422, "montant nul");
      const rows = (await sql`
        UPDATE users SET points = GREATEST(0, points + ${amount})
        WHERE lower(login) = ${body.login.trim().toLowerCase()}
        RETURNING id, points
      `) as Array<{ id: number; points: number }>;
      if (!rows[0]) return err(set, 404, "joueur introuvable");
      publishBalance(rows[0].id, rows[0].points);
      publishAdminLog({ action: "points", target: body.login, amount, newBalance: rows[0].points });
      const me = await senderCard(userId!);
      await pushNotif(rows[0].id, {
        kind: "admin",
        message:
          amount > 0
            ? `Tu as reçu +${amount} pts 🎁`
            : `${-amount} pts retirés de ton compte`,
        from: me,
      });
      void publishLeaderboard();
      return { ok: true, points: rows[0].points };
    },
    { body: t.Object({ login: t.String(), amount: t.Integer() }) },
  )

  // Query persisted admin logs with optional filters.
  .get("/logs", async ({ isAdmin, query, set }) => {
    if (!isAdmin) return forbid(set);
    const loginRaw = (query.login  as string | undefined)?.trim() || null;
    const action   = (query.action as string | undefined)?.trim() || null;
    const from     = (query.from   as string | undefined)?.trim() || null;
    const to       = (query.to     as string | undefined)?.trim() || null;
    const limit    = Math.min(Number(query.limit  ?? 100), 500);
    const offset   = Number(query.offset ?? 0);
    const loginPat = loginRaw ? `%${loginRaw}%` : null;

    const logs = await sql`
      SELECT id, ts, action, payload FROM admin_logs
      WHERE (CAST(${loginPat} AS text) IS NULL
             OR payload->>'login'  ILIKE CAST(${loginPat} AS text)
             OR payload->>'target' ILIKE CAST(${loginPat} AS text))
        AND (CAST(${action} AS text) IS NULL OR action = CAST(${action} AS text))
        AND (CAST(${from} AS text) IS NULL OR ts >= CAST(${from} AS timestamptz))
        AND (CAST(${to}   AS text) IS NULL OR ts <= (CAST(${to} AS timestamptz) + interval '1 day'))
      ORDER BY ts DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM admin_logs
      WHERE (CAST(${loginPat} AS text) IS NULL
             OR payload->>'login'  ILIKE CAST(${loginPat} AS text)
             OR payload->>'target' ILIKE CAST(${loginPat} AS text))
        AND (CAST(${action} AS text) IS NULL OR action = CAST(${action} AS text))
        AND (CAST(${from} AS text) IS NULL OR ts >= CAST(${from} AS timestamptz))
        AND (CAST(${to}   AS text) IS NULL OR ts <= (CAST(${to} AS timestamptz) + interval '1 day'))
    ` as Array<{ count: number }>;
    return { logs, total: count };
  })

  // Reset all users' points to 1000.
  .post("/reset-all", async ({ isAdmin, userId, set }) => {
    if (!isAdmin) return forbid(set);
    await sql`UPDATE users SET points = 1000`;
    publishBroadcast({ type: "balance", points: 1000 });
    const me = await senderCard(userId!);
    await pushNotifAll({ kind: "admin", message: "🔄 Reset général — tout le monde repart à 1 000 pts !", from: me });
    publishAdminLog({ action: "reset-all" });
    void publishLeaderboard();
    return { ok: true };
  });

async function senderCard(userId: number): Promise<Sender | null> {
  const r = (await sql`
    SELECT id, login, display_name, image_url FROM users WHERE id=${userId}
  `) as Sender[];
  return r[0] ?? null;
}
function forbid(set: { status?: number | string }) {
  set.status = 403;
  return { error: "acces refuse" };
}
function err(set: { status?: number | string }, code: number, msg: string) {
  set.status = code;
  return { error: msg };
}
