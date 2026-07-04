import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishAdminLog } from "./realtime";
import { rl, BUCKETS } from "./ratelimit";
import { recordStat } from "./gamestats";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const EDGE = 0.99;
const SUITS = ["♠", "♥", "♦", "♣"];

// Rang 2..14 (14 = As, haut). Deck infini : chaque carte est tirée uniforme.
interface HiloSession
{
	userId: number;
	bet:    number;
	rank:   number;
	suit:   string;
	mult:   number; // multiplicateur cumulé
	steps:  number; // guesses gagnés
	active: boolean;
}

const sessions = new Map<number, HiloSession>();

function rand(): number
{
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return buf[0] / 2 ** 32;
}

const drawRank = () => 2 + Math.floor(rand() * 13);
const drawSuit = () => SUITS[Math.floor(rand() * 4)];

// Égalité = perdu, donc "higher" strict depuis rank r : (14 - r) rangs gagnants sur 13.
const pHigher = (r: number) => (14 - r) / 13;
const pLower  = (r: number) => (r - 2) / 13;

const cardView = (s: HiloSession) => ({ rank: s.rank, suit: s.suit });

function stepMults(rank: number)
{
	const ph = pHigher(rank);
	const pl = pLower(rank);
	return {
		higher: ph > 0 ? Number((EDGE / ph).toFixed(4)) : null,
		lower:  pl > 0 ? Number((EDGE / pl).toFixed(4)) : null,
	};
}

export const hilo = new Elysia({ prefix: "/api/hilo" })
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
	.onBeforeHandle(({ userId, set }) => rl(`games:${userId}`, BUCKETS.games, set))

	.get("/session", ({ userId }) =>
	{
		const s = sessions.get(userId!);
		if (!s?.active) return { session: null };
		return {
			session: {
				bet:        s.bet,
				card:       cardView(s),
				multiplier: s.mult,
				steps:      s.steps,
				next:       stepMults(s.rank),
			},
		};
	})

	.post(
		"/start",
		async ({ userId, body, set }) =>
		{
			if (sessions.get(userId!)?.active)
			{
				set.status = 409;
				return { error: "Session active — cashout d'abord" };
			}

			const rows = (await sql`
				UPDATE users SET points = points - ${body.bet}
				WHERE id = ${userId!} AND points >= ${body.bet}
				RETURNING points
			`) as Array<{ points: number }>;

			if (!rows[0])
			{
				set.status = 400;
				return { error: "Solde insuffisant" };
			}

			const s: HiloSession = {
				userId: userId!,
				bet:    body.bet,
				rank:   drawRank(),
				suit:   drawSuit(),
				mult:   1,
				steps:  0,
				active: true,
			};
			sessions.set(userId!, s);
			publishBalance(userId!, rows[0].points);
			return { card: cardView(s), next: stepMults(s.rank), balance: rows[0].points };
		},
		{ body: t.Object({ bet: t.Integer({ minimum: 1, maximum: 1_000_000 }) }) },
	)

	.post(
		"/guess",
		async ({ userId, body, set }) =>
		{
			const s = sessions.get(userId!);
			if (!s?.active)
			{
				set.status = 404;
				return { error: "Pas de session active" };
			}
			const p = body.dir === "higher" ? pHigher(s.rank) : pLower(s.rank);
			if (p <= 0)
			{
				set.status = 400;
				return { error: "Pari impossible sur cette carte" };
			}

			const rank = drawRank();
			const suit = drawSuit();
			const win = body.dir === "higher" ? rank > s.rank : rank < s.rank;

			if (!win)
			{
				s.active = false;
				const [user] = (await sql`
					SELECT points, login FROM users WHERE id = ${userId!}
				`) as Array<{ points: number; login: string }>;
				publishAdminLog({
					action: "bet", game: "hilo", login: user.login,
					bet: s.bet, payout: 0, win: false, balance: user.points,
				});
				void recordStat(userId!, "hilo", s.bet, 0);
				const { updateChallengeProgress } = await import("./achievements");
				void updateChallengeProgress(userId!, "play_5_games");
				return { win: false, card: { rank, suit }, balance: user.points };
			}

			s.mult = Number((s.mult * (EDGE / p)).toFixed(4));
			s.steps++;
			s.rank = rank;
			s.suit = suit;
			return {
				win:        true,
				card:       cardView(s),
				multiplier: s.mult,
				steps:      s.steps,
				next:       stepMults(s.rank),
			};
		},
		{ body: t.Object({ dir: t.Union([t.Literal("higher"), t.Literal("lower")]) }) },
	)

	.post("/cashout", async ({ userId, set }) =>
	{
		const s = sessions.get(userId!);
		if (!s?.active || s.steps === 0)
		{
			set.status = 400;
			return { error: "Impossible de cashout" };
		}

		const payout = Math.floor(s.bet * s.mult);
		s.active = false;

		const rows = (await sql`
			UPDATE users SET points = points + ${payout}
			WHERE id = ${userId!}
			RETURNING points, login
		`) as Array<{ points: number; login: string }>;

		publishBalance(userId!, rows[0].points);
		void publishLeaderboard();
		publishAdminLog({
			action: "bet", game: "hilo", login: rows[0].login,
			bet: s.bet, payout, win: true, balance: rows[0].points,
		});
		void recordStat(userId!, "hilo", s.bet, payout);

		const { checkAchievements, updateChallengeProgress } = await import("./achievements");
		void checkAchievements(userId!, { win: true, payout, bet: s.bet, mult: s.mult, game: "hilo" });
		void updateChallengeProgress(userId!, "play_5_games");
		void updateChallengeProgress(userId!, "win_5_games");
		if (payout - s.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
		if (payout >= 500) void updateChallengeProgress(userId!, "big_win_500");

		return { payout, multiplier: s.mult, balance: rows[0].points };
	});
