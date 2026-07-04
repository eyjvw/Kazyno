import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishBroadcast, publishAdminLog, publishLeaderboard } from "./realtime";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const ADMIN_LOGINS = (process.env.ADMIN_LOGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const RAIN_TTL_MS = 60_000;

// ── Rain drops ────────────────────────────────────────────────────────────────
// Admin drops a pot; the first N users to claim each get pot/N. In-memory —
// a rain lasts 60s, no need to persist across restarts.

interface Rain
{
	id: string;
	share: number;
	remaining: number;
	claimed: Set<number>;
	expires: number;
}

let active: Rain | null = null;

export const rain = new Elysia({ prefix: "/api/rain" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		return { userId: payload && payload.sub ? Number(payload.sub) : null };
	})
	.onBeforeHandle(({ userId, set }) =>
	{
		if (!userId)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
	})

	// Active rain, if any (for late page loads).
	.get("/", ({ userId }) =>
	{
		if (!active || Date.now() > active.expires || active.remaining <= 0) return { rain: null };
		return {
			rain: {
				id: active.id,
				share: active.share,
				remaining: active.remaining,
				expires: active.expires,
				claimed: active.claimed.has(userId!),
			},
		};
	})

	// Admin: start a rain.
	.post(
		"/start",
		async ({ body, userId, set }) =>
		{
			const rows = (await sql`SELECT login FROM users WHERE id = ${userId!}`) as Array<{ login: string }>;
			if (!rows[0] || !ADMIN_LOGINS.includes(rows[0].login))
			{
				set.status = 403;
				return { error: "admin uniquement" };
			}
			const { amount, winners } = body;
			active = {
				id: crypto.randomUUID(),
				share: Math.floor(amount / winners),
				remaining: winners,
				claimed: new Set(),
				expires: Date.now() + RAIN_TTL_MS,
			};
			publishBroadcast({
				type: "rain",
				id: active.id,
				share: active.share,
				winners,
				expires: active.expires,
			});
			publishAdminLog({ action: "rain", login: rows[0].login, amount, winners });
			return { ok: true, id: active.id };
		},
		{
			body: t.Object({
				amount: t.Integer({ minimum: 10, maximum: 1_000_000 }),
				winners: t.Integer({ minimum: 1, maximum: 100 }),
			}),
		},
	)

	// Claim a share; first come first served.
	.post(
		"/claim",
		async ({ body, userId, set }) =>
		{
			const r = active;
			if (!r || r.id !== body.id || Date.now() > r.expires)
			{
				set.status = 410;
				return { error: "la pluie est terminée" };
			}
			if (r.claimed.has(userId!))
			{
				set.status = 409;
				return { error: "déjà réclamé" };
			}
			if (r.remaining <= 0)
			{
				set.status = 410;
				return { error: "tout a été réclamé" };
			}
			// Synchronous reservation before the await — no double claim.
			r.claimed.add(userId!);
			r.remaining--;

			const rows = (await sql`
				UPDATE users SET points = points + ${r.share} WHERE id = ${userId!} RETURNING points
			`) as Array<{ points: number }>;
			publishBalance(userId!, rows[0].points);
			void publishLeaderboard();
			publishBroadcast({ type: "rain_update", id: r.id, remaining: r.remaining });
			return { amount: r.share, balance: rows[0].points };
		},
		{ body: t.Object({ id: t.String() }) },
	);
