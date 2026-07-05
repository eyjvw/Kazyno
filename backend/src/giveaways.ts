import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishBroadcast, publishLeaderboard } from "./realtime";
import { pushNotif, pushNotifAll } from "./notifications";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const ADMINS = (process.env.ADMIN_LOGINS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

const CHECK_INTERVAL = 60 * 1000; // vérifie les giveaways expirés chaque minute

export const giveaways = new Elysia({ prefix: "/api/giveaways" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		const userId = payload && payload.sub ? Number(payload.sub) : null;
		let isAdmin = false;
		if (userId)
		{
			const r = (await sql`SELECT login FROM users WHERE id=${userId}`) as Array<{ login: string }>;
			isAdmin = !!r[0] && ADMINS.includes(r[0].login.toLowerCase());
		}
		return { userId, isAdmin };
	})

	// Public: active giveaways + recent drawn history, with per-user entered flag.
	.get("/", async ({ userId }) =>
	{
		const active = (await sql`
			SELECT g.id, g.title, g.description, g.prize_points, g.ends_at, g.created_at,
						 COUNT(e.user_id)::int AS entry_count,
						 EXISTS(
							 SELECT 1 FROM giveaway_entries e2
							 WHERE e2.giveaway_id = g.id AND e2.user_id = ${userId ?? 0}
						 ) AS entered
			FROM giveaways g
			LEFT JOIN giveaway_entries e ON e.giveaway_id = g.id
			WHERE g.drawn = false
			GROUP BY g.id
			ORDER BY g.ends_at ASC
		`) as unknown[];

		const history = (await sql`
			SELECT g.id, g.title, g.prize_points, g.ends_at, u.login AS winner_login,
						 u.display_name AS winner_name, u.image_url AS winner_image
			FROM giveaways g
			LEFT JOIN users u ON u.id = g.winner_id
			WHERE g.drawn = true
			ORDER BY g.ends_at DESC
			LIMIT 20
		`) as unknown[];

		return { active, history };
	})

	// Enter an active giveaway (idempotent).
	.post("/:id/enter", async ({ userId, params, set }) =>
	{
		if (!userId) return err(set, 401, "non authentifie");
		const id = Number(params.id);
		if (!(await isOpen(id))) return err(set, 404, "giveaway introuvable ou termine");
		await sql`
			INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (${id}, ${userId})
			ON CONFLICT DO NOTHING
		`;
		return { ok: true };
	})

	// Withdraw from an active giveaway (only while it's still open).
	.delete("/:id/enter", async ({ userId, params, set }) =>
	{
		if (!userId) return err(set, 401, "non authentifie");
		const id = Number(params.id);
		if (!(await isOpen(id))) return err(set, 404, "giveaway introuvable ou termine");
		await sql`
			DELETE FROM giveaway_entries WHERE giveaway_id=${id} AND user_id=${userId}
		`;
		return { ok: true };
	})

	// Admin: create a giveaway.
	.post(
		"/",
		async ({ isAdmin, body, set }) =>
		{
			if (!isAdmin) return forbid(set);
			const rows = (await sql`
				INSERT INTO giveaways (title, description, prize_points, ends_at)
				VALUES (${body.title.trim()}, ${body.description?.trim() ?? null}, ${body.prize_points}, ${body.ends_at})
				RETURNING id, title, description, prize_points, ends_at, created_at
			`) as unknown[];
			void pushNotifAll({
				kind: "giveaway",
				message: `🎁 Nouveau giveaway : ${body.title.trim()} (${body.prize_points} pts) !`,
				link: "/giveaways",
			});
			return { giveaway: rows[0] };
		},
		{
			body: t.Object({
				title: t.String({ minLength: 1, maxLength: 80 }),
				description: t.Optional(t.String({ maxLength: 280 })),
				prize_points: t.Integer({ minimum: 1 }),
				ends_at: t.String(),
			}),
		},
	)

	// Admin: delete a giveaway not yet drawn.
	.delete("/:id", async ({ isAdmin, params, set }) =>
	{
		if (!isAdmin) return forbid(set);
		const rows = (await sql`
			DELETE FROM giveaways WHERE id=${Number(params.id)} AND drawn=false RETURNING id
		`) as unknown[];
		if (!rows.length) return err(set, 404, "giveaway introuvable ou deja tire");
		return { ok: true };
	});

/** True if the giveaway exists, hasn't been drawn, and hasn't expired. */
async function isOpen(id: number): Promise<boolean>
{
	const rows = (await sql`
		SELECT 1 FROM giveaways WHERE id=${id} AND drawn=false AND ends_at > now()
	`) as unknown[];
	return rows.length > 0;
}

function forbid(set: { status?: number | string })
{
	set.status = 403;
	return { error: "acces refuse" };
}
function err(set: { status?: number | string }, code: number, msg: string)
{
	set.status = code;
	return { error: msg };
}

/** Tire un gagnant au hasard parmi les inscrits d'un giveaway expiré. */
async function drawGiveaway(g: { id: number; title: string; prize_points: number }): Promise<void>
{
	const entrants = (await sql`
		SELECT user_id FROM giveaway_entries WHERE giveaway_id=${g.id}
	`) as Array<{ user_id: number }>;

	let winnerId: number | null = null;
	if (entrants.length > 0)
	{
		winnerId = entrants[Math.floor(Math.random() * entrants.length)].user_id;
		const rows = (await sql`
			UPDATE users SET points = points + ${g.prize_points} WHERE id=${winnerId}
			RETURNING points
		`) as Array<{ points: number }>;
		publishBalance(winnerId, rows[0].points);
		await pushNotif(winnerId, {
			kind: "giveaway",
			message: `🎉 Tu as gagné le giveaway "${g.title}" ! +${g.prize_points} pts`,
			link: "/giveaways",
		});
		void publishLeaderboard();
	}

	await sql`
		UPDATE giveaways SET drawn=true, winner_id=${winnerId} WHERE id=${g.id}
	`;

	publishBroadcast({
		type: "giveaway_drawn",
		giveaway_id: g.id,
		title: g.title,
	});

	console.log(`[giveaway] #${g.id} "${g.title}" tiré, ${entrants.length} participant(s), gagnant=${winnerId ?? "aucun"}`);
}

async function runDraws(): Promise<void>
{
	const due = (await sql`
		SELECT id, title, prize_points FROM giveaways WHERE drawn=false AND ends_at <= now()
	`) as Array<{ id: number; title: string; prize_points: number }>;
	for (const g of due) await drawGiveaway(g);
}

export async function initGiveaways(): Promise<void>
{
	await runDraws();
	setInterval(() => void runDraws(), CHECK_INTERVAL);
}
