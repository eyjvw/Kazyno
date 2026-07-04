import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishAdminLog } from "./realtime";
import { rl, BUCKETS } from "./ratelimit";
import { recordStat } from "./gamestats";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const ROWS = 8;
const COLS = 3;
const EDGE = 0.97; // même edge que mines

interface TowerSession
{
	userId: number;
	bet:    number;
	traps:  number[]; // index du piège (0..COLS-1) pour chaque étage
	row:    number;   // prochain étage à jouer (0 = bas)
	active: boolean;
}

const sessions = new Map<number, TowerSession>();

function rand(): number
{
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return buf[0] / 2 ** 32;
}

// 1 piège par étage sur 3 cases : p = 2/3 par étage.
const rowMult = (rowsCleared: number) =>
	rowsCleared === 0 ? 1 : Number((EDGE / Math.pow(2 / 3, rowsCleared)).toFixed(4));

export const tower = new Elysia({ prefix: "/api/tower" })
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
				row:        s.row,
				rows:       ROWS,
				cols:       COLS,
				multiplier: rowMult(s.row),
				nextMult:   s.row < ROWS ? rowMult(s.row + 1) : null,
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

			sessions.set(userId!, {
				userId: userId!,
				bet:    body.bet,
				traps:  Array.from({ length: ROWS }, () => Math.floor(rand() * COLS)),
				row:    0,
				active: true,
			});

			publishBalance(userId!, rows[0].points);
			return { rows: ROWS, cols: COLS, nextMult: rowMult(1), balance: rows[0].points };
		},
		{ body: t.Object({ bet: t.Integer({ minimum: 1, maximum: 1_000_000 }) }) },
	)

	.post(
		"/pick",
		async ({ userId, body, set }) =>
		{
			const s = sessions.get(userId!);
			if (!s?.active)
			{
				set.status = 404;
				return { error: "Pas de session active" };
			}

			const trap = s.traps[s.row];
			if (body.tile === trap)
			{
				s.active = false;
				const [user] = (await sql`
					SELECT points, login FROM users WHERE id = ${userId!}
				`) as Array<{ points: number; login: string }>;
				publishAdminLog({
					action: "bet", game: "tower", login: user.login,
					bet: s.bet, payout: 0, win: false, balance: user.points,
				});
				void recordStat(userId!, "tower", s.bet, 0);
				const { updateChallengeProgress } = await import("./achievements");
				void updateChallengeProgress(userId!, "play_5_games");
				return { safe: false, row: s.row, trap, traps: s.traps, balance: user.points };
			}

			s.row++;
			const topReached = s.row >= ROWS;
			const res = {
				safe:       true as const,
				row:        s.row - 1,
				tile:       body.tile,
				trap,
				multiplier: rowMult(s.row),
				nextMult:   topReached ? null : rowMult(s.row + 1),
				topReached,
			};
			return res;
		},
		{ body: t.Object({ tile: t.Integer({ minimum: 0, maximum: COLS - 1 }) }) },
	)

	.post("/cashout", async ({ userId, set }) =>
	{
		const s = sessions.get(userId!);
		if (!s?.active || s.row === 0)
		{
			set.status = 400;
			return { error: "Impossible de cashout" };
		}

		const mult   = rowMult(s.row);
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
			action: "bet", game: "tower", login: rows[0].login,
			bet: s.bet, payout, win: true, balance: rows[0].points,
		});
		void recordStat(userId!, "tower", s.bet, payout);

		const { checkAchievements, updateChallengeProgress } = await import("./achievements");
		void checkAchievements(userId!, { win: true, payout, bet: s.bet, mult, game: "tower" });
		void updateChallengeProgress(userId!, "play_5_games");
		void updateChallengeProgress(userId!, "win_5_games");
		if (payout - s.bet >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");
		if (payout >= 500) void updateChallengeProgress(userId!, "big_win_500");

		return { payout, multiplier: mult, traps: s.traps, balance: rows[0].points };
	});
