import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishAdminLog } from "./realtime";
import { recordStat } from "./gamestats";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const GRID = 25;

interface MineSession
{
	userId:   number;
	bet:      number;
	mines:    Set<number>;
	revealed: Set<number>;
	mines_n:  number;
	active:   boolean;
}

const sessions = new Map<number, MineSession>();

function rand(): number
{
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return buf[0] / 2 ** 32;
}

function generateMines(count: number): Set<number>
{
	const mines = new Set<number>();
	while (mines.size < count) mines.add(Math.floor(rand() * GRID));
	return mines;
}

// Probability-based multiplier (3 % house edge)
function calcMult(mines_n: number, revealed: number): number
{
	if (revealed === 0) return 1.0;
	let prob = 1;
	for (let i = 0; i < revealed; i++)
		prob *= (GRID - mines_n - i) / (GRID - i);
	return Math.max(1.01, 0.97 / prob);
}

export const minesGame = new Elysia({ prefix: "/api/mines" })
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

	.get("/session", ({ userId }) =>
	{
		const s = sessions.get(userId!);
		if (!s?.active) return { session: null };
		return {
			session: {
				mines_n:    s.mines_n,
				bet:        s.bet,
				revealed:   [...s.revealed],
				multiplier: calcMult(s.mines_n, s.revealed.size),
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
				RETURNING points, login
			`) as Array<{ points: number; login: string }>;

			if (!rows[0])
			{
				set.status = 400;
				return { error: "Solde insuffisant" };
			}

			sessions.set(userId!, {
				userId:   userId!,
				bet:      body.bet,
				mines:    generateMines(body.mines_n),
				revealed: new Set(),
				mines_n:  body.mines_n,
				active:   true,
			});

			publishBalance(userId!, rows[0].points);
			return { balance: rows[0].points };
		},
		{
			body: t.Object({
				bet:     t.Integer({ minimum: 1, maximum: 1_000_000 }),
				mines_n: t.Integer({ minimum: 1, maximum: 24 }),
			}),
		},
	)

	.post(
		"/reveal",
		async ({ userId, body, set }) =>
		{
			const s = sessions.get(userId!);
			if (!s?.active)
			{
				set.status = 404;
				return { error: "Pas de session active" };
			}
			if (body.tile < 0 || body.tile >= GRID || s.revealed.has(body.tile))
			{
				set.status = 400;
				return { error: "Case invalide" };
			}

			s.revealed.add(body.tile);
			const hit = s.mines.has(body.tile);

			if (hit)
			{
				s.active = false;
				const [user] = (await sql`
					SELECT points, login FROM users WHERE id = ${userId!}
				`) as Array<{ points: number; login: string }>;
				publishAdminLog({
					action: "bet", game: "mines", login: user.login,
					bet: s.bet, payout: 0, win: false, balance: user.points,
				});
				void recordStat(userId!, "mines", s.bet, 0);
				return { hit: true, tile: body.tile, mines: [...s.mines], balance: user.points };
			}

			return {
				hit:        false,
				tile:       body.tile,
				multiplier: calcMult(s.mines_n, s.revealed.size),
				safeLeft:   GRID - s.mines_n - s.revealed.size,
			};
		},
		{ body: t.Object({ tile: t.Integer({ minimum: 0, maximum: 24 }) }) },
	)

	.post("/cashout", async ({ userId, set }) =>
	{
		const s = sessions.get(userId!);
		if (!s?.active || s.revealed.size === 0)
		{
			set.status = 400;
			return { error: "Impossible de cashout" };
		}

		const mult   = calcMult(s.mines_n, s.revealed.size);
		const payout = Math.floor(s.bet * mult);
		s.active     = false;

		const rows = (await sql`
			UPDATE users SET points = points + ${payout}
			WHERE id = ${userId!}
			RETURNING points, login
		`) as Array<{ points: number; login: string }>;

		publishBalance(userId!, rows[0].points);
		void publishLeaderboard();
		publishAdminLog({
			action: "bet", game: "mines", login: rows[0].login,
			bet: s.bet, payout, win: true, balance: rows[0].points,
		});
		void recordStat(userId!, "mines", s.bet, payout);

		const { checkAchievements, updateChallengeProgress, checkMinesSafe } = await import("./achievements");
		void checkAchievements(userId!, { win: true, payout, bet: s.bet, mult, game: "mines" });
		void checkMinesSafe(userId!, s.revealed.size);
		void updateChallengeProgress(userId!, "play_mines_3");
		void updateChallengeProgress(userId!, "play_5_games");
		void updateChallengeProgress(userId!, "win_5_games");
		if (payout - s.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");

		return { payout, multiplier: mult, mines: [...s.mines], balance: rows[0].points };
	});
