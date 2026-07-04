import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { getServer, publishBalance, publishLeaderboard, publishAdminLog } from "./realtime";
import { rl, BUCKETS } from "./ratelimit";
import { recordStat } from "./gamestats";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const WAIT_MS  = 10_000;  // waiting phase duration
const CRASH_K  = 0.0003; // multiplier growth: mult(t) = e^(K*t)

// ── State ────────────────────────────────────────────────────────────────────
interface CrashBet
{
	userId:    number;
	login:     string;
	amount:    number;
	cashedOut: number | null; // multiplier at cashout, null = still in
}

type Phase = "waiting" | "running" | "crashed";

interface Round
{
	id:        number;
	phase:     Phase;
	crashAt:   number;
	startTime: number;  // epoch ms when running phase started
	waitStart: number;  // epoch ms when waiting phase started
	bets:      Map<number, CrashBet>;
}

let roundId = 0;
let round: Round;
const history: number[] = [];

function rand(): number
{
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return buf[0] / 2 ** 32;
}

// ~3 % instant crash, otherwise exponential distribution
function generateCrash(): number
{
	const r = rand();
	if (r < 0.03) return 1.0;
	return Math.min(1000, Math.max(1.01, 0.99 / (1 - r)));
}

function multNow(): number
{
	if (round.phase !== "running") return 1.0;
	return Math.max(1.0, Math.pow(Math.E, CRASH_K * (Date.now() - round.startTime)));
}

function betsView()
{
	return [...round.bets.values()].map(b =>
		({ login: b.login, amount: b.amount, cashedOut: b.cashedOut }));
}

function publish(payload: unknown)
{
	getServer()?.publish("crash", JSON.stringify(payload));
}

// ── Game loop ─────────────────────────────────────────────────────────────────
function startWaiting()
{
	round = {
		id:        ++roundId,
		phase:     "waiting",
		crashAt:   generateCrash(),
		startTime: 0,
		waitStart: Date.now(),
		bets:      new Map(),
	};
	publish({
		type: "crash", phase: "waiting",
		roundId: round.id, waitStart: round.waitStart, waitMs: WAIT_MS, history,
	});
	setTimeout(startRunning, WAIT_MS);
}

function startRunning()
{
	round.phase     = "running";
	round.startTime = Date.now();

	// Schedule crash at the exact predetermined multiplier
	const t_crash = Math.ceil(Math.log(Math.max(round.crashAt, 1.001)) / CRASH_K);
	publish({ type: "crash", phase: "running", roundId: round.id, startTime: round.startTime });

	setTimeout(() => void doCrash(), Math.max(0, t_crash));
}

async function doCrash()
{
	round.phase = "crashed";
	history.push(round.crashAt);
	if (history.length > 50) history.shift();

	const { updateChallengeProgress } = await import("./achievements");
	for (const [, bet] of round.bets)
	{
		if (bet.cashedOut !== null) continue;
		publishAdminLog({
			action: "bet", game: "crash", login: bet.login,
			bet: bet.amount, payout: 0, win: false,
		});
		void recordStat(bet.userId, "crash", bet.amount, 0);
		// Un pari perdant compte aussi comme partie jouée pour les défis
		void updateChallengeProgress(bet.userId, "play_crash_3");
		void updateChallengeProgress(bet.userId, "play_5_games");
	}

	publish({
		type: "crash", phase: "crashed",
		roundId: round.id, crashAt: round.crashAt, bets: betsView(), history,
	});

	setTimeout(startWaiting, 3_000);
}

// Boot immediately
startWaiting();

// ── State getter for WS subscription ─────────────────────────────────────────
export function getCrashStateJSON(): string
{
	return JSON.stringify({
		type:       "crash",
		phase:      round.phase,
		roundId:    round.id,
		startTime:  round.startTime,
		waitStart:  round.waitStart,
		waitMs:     WAIT_MS,
		multiplier: multNow(),
		bets:       betsView(),
		history,
	});
}

// ── HTTP routes ───────────────────────────────────────────────────────────────
export const crash = new Elysia({ prefix: "/api/crash" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value
			? await jwt.verify(session.value as string)
			: false;
		return { userId: payload && payload.sub ? Number(payload.sub) : null };
	})

	// Public — no auth needed
	.get("/state", () =>
	({
		phase:      round.phase,
		roundId:    round.id,
		startTime:  round.startTime,
		waitStart:  round.waitStart,
		waitMs:     WAIT_MS,
		multiplier: multNow(),
		bets:       betsView(),
		history,
	}))

	// Auth-protected below
	.onBeforeHandle(({ userId, set }) =>
	{
		if (!userId)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
	})
	.onBeforeHandle(({ userId, set }) => rl(`games:${userId}`, BUCKETS.games, set))

	.post(
		"/bet",
		async ({ userId, body, set }) =>
		{
			if (round.phase !== "waiting")
			{
				set.status = 409;
				return { error: "Manche déjà lancée" };
			}
			if (round.bets.has(userId!))
			{
				set.status = 409;
				return { error: "Pari déjà placé" };
			}

			const rows = (await sql`
				UPDATE users SET points = points - ${body.amount}
				WHERE id = ${userId!} AND points >= ${body.amount}
				RETURNING points, login
			`) as Array<{ points: number; login: string }>;

			if (!rows[0])
			{
				set.status = 400;
				return { error: "Solde insuffisant" };
			}

			round.bets.set(userId!, {
				userId: userId!,
				login:  rows[0].login,
				amount: body.amount,
				cashedOut: null,
			});

			publishBalance(userId!, rows[0].points);
			publish({
				type: "crash", phase: "waiting",
				roundId: round.id, bets: betsView(),
				waitStart: round.waitStart, waitMs: WAIT_MS, history,
			});

			return { balance: rows[0].points };
		},
		{ body: t.Object({ amount: t.Integer({ minimum: 1, maximum: 1_000_000 }) }) },
	)

	.post("/cashout", async ({ userId, set }) =>
	{
		if (round.phase !== "running")
		{
			set.status = 409;
			return { error: "Pas en cours" };
		}

		const bet = round.bets.get(userId!);
		if (!bet || bet.cashedOut !== null)
		{
			set.status = 409;
			return { error: "Pas de pari actif" };
		}

		// Le timer de crash peut être en retard : si le multiplicateur réel a
		// déjà dépassé le point de crash, le pari est perdu.
		const mult = multNow();
		if (mult >= round.crashAt)
		{
			set.status = 409;
			return { error: "Crashed" };
		}
		const payout = Math.floor(bet.amount * mult);
		bet.cashedOut = mult;

		const rows = (await sql`
			UPDATE users SET points = points + ${payout}
			WHERE id = ${userId!}
			RETURNING points, login
		`) as Array<{ points: number; login: string }>;

		publishBalance(userId!, rows[0].points);
		void publishLeaderboard();
		publishAdminLog({
			action: "bet", game: "crash", login: rows[0].login,
			bet: bet.amount, payout, win: true, balance: rows[0].points,
		});
		void recordStat(userId!, "crash", bet.amount, payout);

		const { checkAchievements, updateChallengeProgress } = await import("./achievements");
		void checkAchievements(userId!, { win: true, payout, bet: bet.amount, mult, game: "crash" });
		void updateChallengeProgress(userId!, "play_crash_3");
		void updateChallengeProgress(userId!, "play_5_games");
		void updateChallengeProgress(userId!, "win_5_games");
		if (mult >= 2) void updateChallengeProgress(userId!, "cashout_crash_2x");
		if (payout - bet.amount >= 1000) void updateChallengeProgress(userId!, "win_1000_pts");

		publish({
			type: "crash", phase: "running", roundId: round.id,
			cashout: { login: rows[0].login, multiplier: mult, payout },
			bets: betsView(),
		});

		return { multiplier: mult, payout, balance: rows[0].points };
	});
