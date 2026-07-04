import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishAdminLog } from "./realtime";
import { rl, BUCKETS } from "./ratelimit";
import { checkAchievements, updateChallengeProgress } from "./achievements";
import { recordStat } from "./gamestats";
import { fairRoll } from "./fair";
import { contributeJackpot, takeJackpot } from "./jackpot";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const EDGE = 0.99; // 1% house edge
const MAX_BET = 1_000_000;

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
		if (payout === 0) contributeJackpot(bet);
	}
	return points;
}

const betField = t.Integer({ minimum: 1, maximum: MAX_BET });

// ── Wheel ── 50 segments, layout partagé avec le front (index = segment) ──────
// 0×24, 1.5×16, 2×7, 3×2, 5.5×1 → RTP 49.5/50 = 99 %
const WHEEL_ODD = [1.5,2,1.5,2,1.5,3,1.5,2,1.5,1.5,2,1.5,5.5,1.5,2,1.5,1.5,2,1.5,3,1.5,2,1.5,1.5,1.5];
export const WHEEL_SLICES = Array.from({ length: 50 }, (_, i) =>
	i % 2 === 0 ? (i === 48 ? 1.5 : 0) : WHEEL_ODD[(i - 1) / 2]);

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
			const { values, nonce } = await fairRoll(userId!);
				const outcome = values[0] < 0.5 ? "heads" : "tails";
			const win = outcome === body.side;
			const payout = win ? Math.floor(body.bet * mult) : 0;
			const balance = await settle(userId!, body.bet, payout, "coinflip");
			void checkAchievements(userId!, { win, payout, bet: body.bet, mult: win ? mult : 0, game: "coinflip" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - body.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, outcome, multiplier: win ? mult : 0, payout, balance, nonce };
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
			const { values, nonce } = await fairRoll(userId!);
				const roll = Math.round(values[0] * 10000) / 100; // 0.00 - 100.00
			const win = direction === "under" ? roll < target : roll > target;
			const payout = win ? Math.floor(bet * mult) : 0;
			const balance = await settle(userId!, bet, payout, "dice");
			void checkAchievements(userId!, { win, payout, bet, mult: win ? mult : 0, game: "dice" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, roll, multiplier: Number(mult.toFixed(4)), payout, balance, nonce };
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
			const { values, nonce } = await fairRoll(userId!);
				const r = values[0] || 1e-9;
			const result = Math.max(1, Math.floor((EDGE / r) * 100) / 100);
			const win = result >= target;
			const payout = win ? Math.floor(bet * target) : 0;
			const balance = await settle(userId!, bet, payout, "limbo");
			void checkAchievements(userId!, { win, payout, bet, mult: win ? target : 0, game: "limbo" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, result, multiplier: target, payout, balance, nonce };
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
				const { values, nonce } = await fairRoll(userId!, 8);
			const path: number[] = [];
			let bucket = 0;
			for (let i = 0; i < 8; i++)
			{
				const right = values[i] < 0.5 ? 0 : 1;
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
				nonce,
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
				const { values, nonce } = await fairRoll(userId!, 3);
				let spinIdx = 0;
			const spin = () =>
			{
				let n = values[spinIdx++] * total;
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

			// Triple 7 also wins the whole progressive jackpot.
			let jackpotWon = 0;
			if (mult > 0 && reels[0] === "7\uFE0F\u20E3" && reels[1] === "7\uFE0F\u20E3" && reels[2] === "7\uFE0F\u20E3")
			{
				const [u] = (await sql`SELECT login FROM users WHERE id = ${userId!}`) as Array<{ login: string }>;
				jackpotWon = await takeJackpot(u?.login ?? "?");
			}
			const payout = Math.floor(body.bet * mult) + jackpotWon;
			const balance = await settle(userId!, body.bet, payout, "slots");
			const win = mult > 0;
			void checkAchievements(userId!, { win, payout, bet: body.bet, mult: win ? mult : 0, game: "slots" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - body.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, reels, multiplier: mult, payout, balance, nonce, jackpotWon };
		},
		{ body: t.Object({ bet: betField }) },
	)

	// ── Wheel ── roue 50 segments, voir WHEEL_SLICES ──────────────────────────
	.post(
		"/wheel",
		async ({ body, userId }) =>
		{
			const { values, nonce } = await fairRoll(userId!);
				const slice = Math.floor(values[0] * WHEEL_SLICES.length);
			const mult = WHEEL_SLICES[slice];
			const payout = Math.floor(body.bet * mult);
			const balance = await settle(userId!, body.bet, payout, "wheel");
			const win = mult > 0;
			void checkAchievements(userId!, { win, payout, bet: body.bet, mult: win ? mult : 0, game: "wheel" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - body.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");
			return { win, slice, multiplier: mult, payout, balance, nonce };
		},
		{ body: t.Object({ bet: betField }) },
	)

	// ── Roulette ── European (0-36), 1% house edge ───────────────────────────
	.post(
		"/roulette",
		async ({ body, userId, set }) =>
		{
			const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
			const { values, nonce } = await fairRoll(userId!);
				const result = Math.floor(values[0] * 37); // 0-36
			const { bet_type, number, bet } = body;
			if (bet_type === "number" && number === undefined)
			{
				set.status = 422;
				return { error: "numéro requis" };
			}
			let mult = 0;

			switch (bet_type)
			{
				// Plein paye 35:1 + mise = retour total 36x
				case "number":  if (number === result) mult = 36 * EDGE; break;
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

			return { result, win, multiplier: mult, payout, balance, nonce };
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
	)

	// ── Keno ── 40 numéros, 10 tirés, choisis 1-10 ────────────────────────────
	// Table de gains par (nb choisis → hits), edge inclus dans les multiplicateurs.
	.post(
		"/keno",
		async ({ body, userId, set }) =>
		{
			const { bet, picks } = body;
			if (new Set(picks).size !== picks.length)
			{
				set.status = 422;
				return { error: "numéros en double" };
			}

			// Tirage : Fisher-Yates partiel sur 40 numéros avec 10 valeurs fair.
			const { values, nonce } = await fairRoll(userId!, 10);
			const pool = Array.from({ length: 40 }, (_, i) => i + 1);
			const drawn: number[] = [];
			for (let i = 0; i < 10; i++)
			{
				const j = i + Math.floor(values[i] * (pool.length - i));
				[pool[i], pool[j]] = [pool[j], pool[i]];
				drawn.push(pool[i]);
			}

			const drawnSet = new Set(drawn);
			const hits = picks.filter((n) => drawnSet.has(n)).length;
			const mult = KENO_PAYTABLE[picks.length][hits];
			const win = mult > 0;
			const payout = Math.floor(bet * mult);
			const balance = await settle(userId!, bet, payout, "keno");

			void checkAchievements(userId!, { win, payout, bet, mult: win ? mult : 0, game: "keno" });
			void updateChallengeProgress(userId!, "play_5_games");
			if (win) void updateChallengeProgress(userId!, "win_5_games");
			if (win && payout - bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
			if (win && payout >= 500) void updateChallengeProgress(userId!, "big_win_500");

			return { win, drawn, hits, multiplier: mult, payout, balance, nonce };
		},
		{
			body: t.Object({
				bet:   betField,
				picks: t.Array(t.Integer({ minimum: 1, maximum: 40 }), { minItems: 1, maxItems: 10 }),
			}),
		},
	);

// Index = nb de hits. Partagé avec le front (keno.astro) pour l'affichage.
export const KENO_PAYTABLE: Record<number, number[]> = {
	1:  [0, 3.96],
	2:  [0, 1.9, 4.5],
	3:  [0, 1, 3.1, 10.4],
	4:  [0, 0.8, 1.8, 5, 22.5],
	5:  [0, 0.25, 1.4, 4.1, 16.5, 36],
	6:  [0, 0, 1, 3.7, 7, 16.5, 40],
	7:  [0, 0, 0.5, 3, 4.5, 14, 31, 60],
	8:  [0, 0, 0, 2.2, 4, 13, 22, 55, 70],
	9:  [0, 0, 0, 1.55, 3, 8, 15, 44, 60, 85],
	10: [0, 0, 0, 1.4, 2.25, 4.5, 8, 17, 50, 80, 100],
};
