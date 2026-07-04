import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

export const history = new Elysia({ prefix: "/api/history" })
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

	// Last 100 bets, oldest first, for the profit sparkline + table.
	.get("/me", async ({ userId }) =>
	{
		const rows = (await sql`
			SELECT game, bet, payout, created_at
			FROM game_history
			WHERE user_id = ${userId!}
			ORDER BY id DESC
			LIMIT 100
		`) as Array<{ game: string; bet: number; payout: number; created_at: string }>;
		return { history: rows.reverse() };
	});
