import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishAdminLog } from "./realtime";
import { rl, BUCKETS } from "./ratelimit";
import { checkAchievements, updateChallengeProgress } from "./achievements";
import { recordStat } from "./gamestats";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const EDGE = 0.99; // 1% house edge
const MAX_BET = 1_000_000;

// Crypto-strong float in [0, 1).
function rand(): number
{
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return buf[0] / 2 ** 32;
}

class InsufficientFunds extends Error {}

// Apply a bet result atomically: debit the wager, credit the payout, but only
// if the balance covers the wager. Returns the new balance.
async function settle(userId: number, bet: number, payout: number, game?: string): Promise<number>
{
	const rows = (await sql`
		UPDATE users
		SET points = points - ${bet} + ${payout}
		WHERE id = ${userId} AND points >= ${bet}
		RETURNING points, login
	`) as Array<{ points: number; login: string }>;
	if (!rows[0]) throw new InsufficientFunds();
	const { points, login } = rows[0];
	publishBalance(userId, points);
	void publishLeaderboard();
	if (game)
	{
		publishAdminLog({ action: "bet", game, login, bet, payout, win: payout > 0, balance: points });
		void recordStat(userId, game, bet, payout);
	}
	return points;
}

const betField = t.Integer({ minimum: 1, maximum: MAX_BET });

export const games = new Elysia({ prefix: "/api/games" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))

	// Resolve the current user id from the session cookie, or 401.
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
	.onBeforeHandle(({ userId, set }) => rl(`games:${userId}`, BUCKETS.games, set))
	.error({ InsufficientFunds })
	.onError(({ code, error, set }) =>
	{
		if (code === "InsufficientFunds")
		{
			set.status = 400;
			return { error: "solde insuffisant" };
		}
	})

	// ── Coinflip ── pick a side, 50/50, ~1.98x ────────────────────────────────
	.post(
		"/coinflip",
		async ({ body, userId }) =>
		{
			const mult = 2 * EDGE;
			const outcome = rand() < 0.5 ? "heads" : "tails";
			const win = outcome === body.side;
			const payout = win ? Math.floor(body.bet * mult) : 0;
			const balance = await settle(userId!, body.bet, payout, "coinflip");
			void checkAchievements(userId!, { win, payout, bet: body.bet, mult: win ? mult : 0, game: "coinflip" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - body.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, outcome, multiplier: win ? mult : 0, payout, balance };
		},
		{
			body: t.Object({
				bet: betField,
				side: t.Union([t.Literal("heads"), t.Literal("tails")]),
			}),
		},
	)

	// ── Dice ── roll 0-100, bet over/under a target ───────────────────────────
	.post(
		"/dice",
		async ({ body, userId }) =>
		{
			const { bet, target, direction } = body;
			const winChance = direction === "under" ? target : 100 - target;
			const mult = (100 / winChance) * EDGE;
			const roll = Math.round(rand() * 10000) / 100; // 0.00 - 100.00
			const win = direction === "under" ? roll < target : roll > target;
			const payout = win ? Math.floor(bet * mult) : 0;
			const balance = await settle(userId!, bet, payout, "dice");
			void checkAchievements(userId!, { win, payout, bet, mult: win ? mult : 0, game: "dice" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, roll, multiplier: Number(mult.toFixed(4)), payout, balance };
		},
		{
			body: t.Object({
				bet: betField,
				target: t.Number({ minimum: 2, maximum: 98 }),
				direction: t.Union([t.Literal("under"), t.Literal("over")]),
			}),
		},
	)

	// ── Limbo ── pick a target multiplier, win if result >= target ────────────
	.post(
		"/limbo",
		async ({ body, userId }) =>
		{
			const { bet, target } = body;
			const r = rand() || 1e-9;
			const result = Math.max(1, Math.floor((EDGE / r) * 100) / 100);
			const win = result >= target;
			const payout = win ? Math.floor(bet * target) : 0;
			const balance = await settle(userId!, bet, payout, "limbo");
			void checkAchievements(userId!, { win, payout, bet, mult: win ? target : 0, game: "limbo" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, result, multiplier: target, payout, balance };
		},
		{
			body: t.Object({
				bet: betField,
				target: t.Number({ minimum: 1.01, maximum: 1_000_000 }),
			}),
		},
	)

	// ── Plinko ── 8 rows, ball falls into one of 9 buckets ────────────────────
	.post(
		"/plinko",
		async ({ body, userId }) =>
		{
			const MULT = [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6];
			const path: number[] = [];
			let bucket = 0;
			for (let i = 0; i < 8; i++)
			{
				const right = rand() < 0.5 ? 0 : 1;
				path.push(right);
				bucket += right;
			}
			const mult = MULT[bucket];
			const payout = Math.floor(body.bet * mult);
			const balance = await settle(userId!, body.bet, payout, "plinko");
			const win = mult >= 1;
			void checkAchievements(userId!, { win, payout, bet: body.bet, mult: win ? mult : 0, game: "plinko" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - body.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return {
				win,
				bucket,
				path,
				multiplier: mult,
				payout,
				balance,
			};
		},
		{ body: t.Object({ bet: betField }) },
	)

	// ── Slots ── 3 weighted reels, paytable below (~93% RTP) ──────────────────
	.post(
		"/slots",
		async ({ body, userId }) =>
		{
			// [symbol, weight, three-of-a-kind multiplier]
			const REELS: Array<[string, number, number]> = [
				["🍒", 5, 8],
				["🍋", 5, 12],
				["🔔", 4, 20],
				["⭐", 3, 40],
				["💎", 2, 90],
				["7️⃣", 1, 250],
			];
			const total = REELS.reduce((a, r) => a + r[1], 0);
			const spin = () =>
			{
				let n = rand() * total;
				for (const r of REELS)
				{
					if (n < r[1]) return r;
					n -= r[1];
				}
				return REELS[0];
			};

			const a = spin();
			const b = spin();
			const c = spin();
			const reels = [a[0], b[0], c[0]];

			let mult = 0;
			if (a[0] === b[0] && b[0] === c[0])
			{
				mult = a[2]; // three of a kind
			}
			else
			{
				// exactly two of a rare symbol still pays
				const counts: Record<string, number> = {};
				for (const s of reels) counts[s] = (counts[s] ?? 0) + 1;
				if (counts["7️⃣"] === 2) mult = 10;
				else if (counts["💎"] === 2) mult = 5;
			}

			const payout = Math.floor(body.bet * mult);
			const balance = await settle(userId!, body.bet, payout, "slots");
			const win = mult > 0;
			void checkAchievements(userId!, { win, payout, bet: body.bet, mult: win ? mult : 0, game: "slots" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - body.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, reels, multiplier: mult, payout, balance };
		},
		{ body: t.Object({ bet: betField }) },
	)

	// ── Roulette ── European (0-36), 1% house edge ───────────────────────────
	.post(
		"/roulette",
		async ({ body, userId }) =>
		{
			const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
			const result = Math.floor(rand() * 37); // 0-36
			const { bet_type, number, bet } = body;
			let mult = 0;

			switch (bet_type)
			{
				case "number":  if (number === result) mult = 35 * EDGE; break;
				case "red":     if (REDS.has(result)) mult = 2 * EDGE; break;
				case "black":   if (!REDS.has(result) && result !== 0) mult = 2 * EDGE; break;
				case "even":    if (result !== 0 && result % 2 === 0) mult = 2 * EDGE; break;
				case "odd":     if (result % 2 === 1) mult = 2 * EDGE; break;
				case "low":     if (result >= 1 && result <= 18) mult = 2 * EDGE; break;
				case "high":    if (result >= 19 && result <= 36) mult = 2 * EDGE; break;
				case "dozen1":  if (result >= 1  && result <= 12) mult = 3 * EDGE; break;
				case "dozen2":  if (result >= 13 && result <= 24) mult = 3 * EDGE; break;
				case "dozen3":  if (result >= 25 && result <= 36) mult = 3 * EDGE; break;
				case "col1":    if (result !== 0 && result % 3 === 1) mult = 3 * EDGE; break;
				case "col2":    if (result !== 0 && result % 3 === 2) mult = 3 * EDGE; break;
				case "col3":    if (result !== 0 && result % 3 === 0) mult = 3 * EDGE; break;
			}

			const win    = mult > 0;
			const payout = win ? Math.floor(bet * mult) : 0;
			const balance = await settle(userId!, bet, payout, "roulette");

			void checkAchievements(userId!, { win, payout, bet, mult: win ? mult : 0, game: "roulette" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			if (win && payout - bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");

			return { result, win, multiplier: mult, payout, balance };
		},
		{
			body: t.Object({
				bet:      betField,
				bet_type: t.Union([
					t.Literal("number"), t.Literal("red"),   t.Literal("black"),
					t.Literal("even"),   t.Literal("odd"),   t.Literal("low"),
					t.Literal("high"),   t.Literal("dozen1"), t.Literal("dozen2"),
					t.Literal("dozen3"), t.Literal("col1"),  t.Literal("col2"),
					t.Literal("col3"),
				]),
				number: t.Optional(t.Integer({ minimum: 0, maximum: 36 })),
			}),
		},
	);
