import { Elysia } from "elysia";
import { sql } from "./db";

// Public stats: paginated/searchable leaderboard + global counters.
export const stats = new Elysia({ prefix: "/api" })
	.get("/leaderboard", async ({ query }) =>
	{
		const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20)));
		const offset = Math.max(0, Number(query.offset ?? 0));
		const q = String(query.q ?? "").trim().toLowerCase();
		const like = `%${q}%`;
		const prefix = `${q}%`;

		const leaderboard = (await sql`
			WITH ranked AS (
				SELECT id, login, display_name, image_url, points,
							 ROW_NUMBER() OVER (ORDER BY points DESC, created_at ASC) AS rank
				FROM users
			)
			SELECT rank, login, display_name, image_url, points
			FROM ranked
			WHERE ${q} = '' OR lower(login) LIKE ${prefix} OR lower(display_name) LIKE ${like}
			ORDER BY rank
			LIMIT ${limit} OFFSET ${offset}
		`) as Array<{
			rank: number;
			login: string;
			display_name: string | null;
			image_url: string | null;
			points: number;
		}>;

		const totalRows = (await sql`
			SELECT COUNT(*)::int AS total FROM users
			WHERE ${q} = '' OR lower(login) LIKE ${prefix} OR lower(display_name) LIKE ${like}
		`) as Array<{ total: number }>;

		return { leaderboard, total: totalRows[0].total, limit, offset };
	})

	.get("/leaderboard/game/:game", async ({ params }) =>
	{
		const valid = ["coinflip", "dice", "limbo", "plinko", "slots", "roulette", "crash", "mines"];
		if (!valid.includes(params.game)) return { leaderboard: [] };

		const rows = await sql`
			SELECT u.login, u.display_name, u.image_url,
				gs.games_played,
				gs.total_wagered::bigint AS total_wagered,
				gs.total_payout::bigint  AS total_payout,
				(gs.total_payout - gs.total_wagered)::bigint AS profit,
				gs.biggest_win,
				ROW_NUMBER() OVER (ORDER BY (gs.total_payout - gs.total_wagered) DESC) AS rank
			FROM game_stats gs
			JOIN users u ON u.id = gs.user_id
			WHERE gs.game = ${params.game}
			ORDER BY profit DESC
			LIMIT 10
		`;
		return { leaderboard: rows };
	})

	.get("/stats", async () =>
	{
		const rows = (await sql`
			SELECT COUNT(*)::int AS players, COALESCE(SUM(points), 0)::int AS total_points
			FROM users
		`) as Array<{ players: number; total_points: number }>;
		return rows[0];
	});
