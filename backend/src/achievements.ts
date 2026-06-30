import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishToUser } from "./realtime";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

// ── Achievement definitions ───────────────────────────────────────────────────
export const ACHIEVEMENT_DEFS: Record<string, { name: string; icon: string; desc: string }> =
{
	first_win:      { name: "Première victoire",    icon: "🏆", desc: "Gagner une première mise" },
	big_win_5x:     { name: "Gros coup",            icon: "💰", desc: "Gagner 5× ou plus sa mise" },
	big_win_10x:    { name: "Jackpot",              icon: "💎", desc: "Gagner 10× ou plus sa mise" },
	richest:        { name: "Riche",                icon: "🤑", desc: "Atteindre 10 000 pts" },
	generous:       { name: "Généreux",             icon: "🎁", desc: "Offrir des points à quelqu'un" },
	daily_7:        { name: "Régulier",             icon: "📅", desc: "7 jours de connexion consécutifs" },
	oracle:         { name: "Oracle",               icon: "🔮", desc: "Prédire sa note d'exam exactement" },
	crash_5x:       { name: "Diamond Hands",        icon: "🙌", desc: "Cashout à 5× ou plus au Crash" },
	mines_15safe:   { name: "Démineur",             icon: "🧨", desc: "Révéler 15 cases sûres en une partie" },
	roulette_35x:   { name: "Tout sur un chiffre",  icon: "🎡", desc: "Gagner un pari numéro à la roulette" },
};

async function grant(userId: number, key: string): Promise<boolean>
{
	const def = ACHIEVEMENT_DEFS[key];
	if (!def) return false;

	try
	{
		const rows = await sql`
			INSERT INTO achievements (user_id, key)
			VALUES (${userId}, ${key})
			ON CONFLICT DO NOTHING
			RETURNING id
		` as Array<{ id: number }>;

		if (!rows[0]) return false;

		publishToUser(userId,
		{
			type:        "achievement",
			achievement: { key, ...def },
		});
		return true;
	}
	catch { return false; }
}

export async function getAchievements(userId: number)
{
	const rows = await sql`
		SELECT key, unlocked_at FROM achievements WHERE user_id = ${userId} ORDER BY unlocked_at DESC
	` as Array<{ key: string; unlocked_at: string }>;
	return rows.map(r => ({ key: r.key, unlocked_at: r.unlocked_at, ...ACHIEVEMENT_DEFS[r.key] }));
}

interface BetContext
{
	win:   boolean;
	payout: number;
	bet:   number;
	mult:  number;
	game:  string;
}

export async function checkAchievements(userId: number, ctx: BetContext)
{
	if (ctx.win)
	{
		void grant(userId, "first_win");
		if (ctx.mult >= 5)  void grant(userId, "big_win_5x");
		if (ctx.mult >= 10) void grant(userId, "big_win_10x");
		if (ctx.game === "roulette" && ctx.mult >= 34) void grant(userId, "roulette_35x");
		if (ctx.game === "crash"    && ctx.mult >= 5)  void grant(userId, "crash_5x");
	}

	const [user] = await sql`SELECT points FROM users WHERE id = ${userId}` as Array<{ points: number }>;
	if (user?.points >= 10_000) void grant(userId, "richest");
}

export async function checkDailyStreak(userId: number, streak: number)
{
	if (streak >= 7) void grant(userId, "daily_7");
}

export async function checkGiftSent(userId: number)
{
	void grant(userId, "generous");
}

export async function checkExamExact(userId: number)
{
	void grant(userId, "oracle");
}

export async function checkMinesSafe(userId: number, safeCount: number)
{
	if (safeCount >= 15) void grant(userId, "mines_15safe");
}

// ── Weekly challenges ─────────────────────────────────────────────────────────
const CHALLENGE_DEFS: Record<string, { desc: string; target: number; reward: number; icon: string }> =
{
	play_10_games:    { desc: "Jouer 10 parties",               target: 10,   reward: 200, icon: "🎮" },
	win_5_games:      { desc: "Gagner 5 parties",               target: 5,    reward: 300, icon: "🏅" },
	win_1000_pts:     { desc: "Gagner 1 000 pts net en un coup", target: 1,   reward: 500, icon: "💸" },
	play_crash_3:     { desc: "Jouer 3 parties au Crash",       target: 3,    reward: 150, icon: "📈" },
	play_mines_3:     { desc: "Jouer 3 parties aux Mines",      target: 3,    reward: 150, icon: "💣" },
	cashout_crash_2x: { desc: "Cashout à 2× ou + au Crash",    target: 1,    reward: 250, icon: "🚀" },
	play_5_games:     { desc: "Jouer 5 parties",                target: 5,    reward: 100, icon: "🎲" },
	big_win_500:      { desc: "Gagner 500 pts en un coup",      target: 1,    reward: 350, icon: "💰" },
	daily_streak_3:   { desc: "Se connecter 3 jours de suite",  target: 3,    reward: 250, icon: "🔥" },
};

const ROTATION: string[][] = [
	["play_10_games",  "win_5_games",    "win_1000_pts"],
	["play_crash_3",   "play_mines_3",   "cashout_crash_2x"],
	["play_5_games",   "big_win_500",    "daily_streak_3"],
];

function getISOWeek(d = new Date()): { week: number; year: number }
{
	const date = new Date(d);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
	const week1 = new Date(date.getFullYear(), 0, 4);
	return {
		week: 1 + Math.round(((date.getTime() - week1.getTime()) / 86_400_000 - 3 + (week1.getDay() + 6) % 7) / 7),
		year: date.getFullYear(),
	};
}

export function getWeeklyChallengeDefs()
{
	const { week } = getISOWeek();
	const keys = ROTATION[week % ROTATION.length];
	return keys.map(k => ({ key: k, ...CHALLENGE_DEFS[k] }));
}

export async function getWeeklyChallengesForUser(userId: number)
{
	const { week, year } = getISOWeek();
	const keys = ROTATION[week % ROTATION.length];

	const rows = await sql`
		SELECT key, progress, completed FROM challenge_progress
		WHERE user_id = ${userId} AND year = ${year} AND week = ${week}
	` as Array<{ key: string; progress: number; completed: boolean }>;

	const progressMap = new Map(rows.map(r => [r.key, r]));

	return keys.map(k =>
	{
		const def  = CHALLENGE_DEFS[k];
		const prog = progressMap.get(k);
		return {
			key:       k,
			...def,
			progress:  prog?.progress ?? 0,
			completed: prog?.completed ?? false,
		};
	});
}

export async function updateChallengeProgress(userId: number, event: string, amount = 1)
{
	const { week, year } = getISOWeek();
	const keys = ROTATION[week % ROTATION.length];

	for (const key of keys)
	{
		// Match exact key or key contains the event token
		if (key !== event && !key.startsWith(event) && !event.startsWith(key.split("_")[0])) continue;
		const def = CHALLENGE_DEFS[key];
		if (!def) continue;

		const rows = await sql`
			INSERT INTO challenge_progress (user_id, year, week, key, progress)
			VALUES (${userId}, ${year}, ${week}, ${key}, ${amount})
			ON CONFLICT (user_id, year, week, key) DO UPDATE
			SET progress = CASE
				WHEN challenge_progress.completed THEN challenge_progress.progress
				ELSE LEAST(challenge_progress.progress + ${amount}, ${def.target})
			END
			RETURNING progress, completed
		` as Array<{ progress: number; completed: boolean }>;

		const row = rows[0];
		if (row && !row.completed && row.progress >= def.target)
		{
			await sql`
				UPDATE challenge_progress
				SET completed = true, completed_at = now()
				WHERE user_id = ${userId} AND year = ${year} AND week = ${week} AND key = ${key}
			`;
			await sql`UPDATE users SET points = points + ${def.reward} WHERE id = ${userId}`;
			const [updated] = await sql`SELECT points FROM users WHERE id = ${userId}` as Array<{ points: number }>;
			publishToUser(userId,
			{
				type:      "challenge_complete",
				challenge: { key, ...def },
				balance:   updated.points,
			});
		}
	}
}

// ── HTTP routes ───────────────────────────────────────────────────────────────
export const achievementsRoutes = new Elysia({ prefix: "/api" })
	.get("/achievements/:login", async ({ params }) =>
	{
		const [user] = await sql`
			SELECT id FROM users WHERE lower(login) = lower(${params.login}) LIMIT 1
		` as Array<{ id: number }>;
		if (!user) return { achievements: [] };
		const list = await getAchievements(user.id);
		return { achievements: list };
	})
	.get("/challenges", () => ({ challenges: getWeeklyChallengeDefs() }))
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		return { userId: payload && payload.sub ? Number(payload.sub) : null };
	})
	.get("/challenges/me", async ({ userId }) =>
	{
		if (!userId) return { challenges: [] };
		const list = await getWeeklyChallengesForUser(userId);
		return { challenges: list };
	});
