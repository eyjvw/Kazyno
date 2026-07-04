import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance } from "./realtime";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

// Day 1→7 rewards, then repeats
const REWARDS = [50, 100, 150, 200, 300, 500, 1000];

export const daily = new Elysia({ prefix: "/api/daily" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value
			? await jwt.verify(session.value as string)
			: false;
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

	.get("/status", async ({ userId }) =>
	{
		const [user] = (await sql`
			SELECT daily_streak, last_daily FROM users WHERE id = ${userId!}
		`) as Array<{ daily_streak: number; last_daily: Date | null }>;

		const today = new Date().toISOString().split("T")[0];
		const lastStr = user.last_daily
			? new Date(user.last_daily).toISOString().split("T")[0]
			: null;
		const claimed = lastStr === today;

		return {
			streak:     user.daily_streak,
			claimed,
			rewards:    REWARDS,
			nextReward: REWARDS[user.daily_streak % 7],
		};
	})

	.post("/claim", async ({ userId, set }) =>
	{
		const today     = new Date().toISOString().split("T")[0];
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];

		const [user] = (await sql`
			SELECT daily_streak, last_daily FROM users WHERE id = ${userId!}
		`) as Array<{ daily_streak: number; last_daily: Date | null }>;

		const lastStr = user.last_daily
			? new Date(user.last_daily).toISOString().split("T")[0]
			: null;

		if (lastStr === today)
		{
			set.status = 409;
			return { error: "Déjà réclamé aujourd'hui" };
		}

		const newStreak = lastStr === yesterday ? user.daily_streak + 1 : 1;
		const reward    = REWARDS[(newStreak - 1) % 7];

		// Garde anti double-claim : refuse si last_daily a déjà été mis à
		// aujourd'hui par une requête concurrente entre le SELECT et l'UPDATE.
		const [updated] = (await sql`
			UPDATE users
			SET points       = points + ${reward},
			    daily_streak  = ${newStreak},
			    last_daily    = ${today}::date
			WHERE id = ${userId!}
			  AND (last_daily IS NULL OR last_daily < ${today}::date)
			RETURNING points
		`) as Array<{ points: number }>;

		if (!updated)
		{
			set.status = 409;
			return { error: "Déjà réclamé aujourd'hui" };
		}

		publishBalance(userId!, updated.points);

		const { checkDailyStreak, updateChallengeProgress } = await import("./achievements");
		void checkDailyStreak(userId!, newStreak);
		void updateChallengeProgress(userId!, "daily_streak_3", newStreak >= 3 ? 1 : 0);

		return { reward, streak: newStreak, balance: updated.points };
	});
