// Paris foot 1N2 sur les matchs synchronisés par footsync.ts. La cote est
// verrouillée au moment de la mise ; pari annulable (remboursé) jusqu'au coup
// d'envoi. Règlement automatique côté sync dès que le score tombe.
import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance } from "./realtime";
import { rl, BUCKETS } from "./ratelimit";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

const MIN_STAKE = 10;
const MAX_STAKE = 1_000_000;
const PICKS = ["home", "draw", "away"] as const;

export const foot = new Elysia({ prefix: "/api/foot" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		return { userId: payload && payload.sub ? Number(payload.sub) : null };
	})
	.onBeforeHandle(({ userId, set }) =>
	{
		if (!userId) { set.status = 401; return { error: "non authentifie" }; }
	})

	// Upcoming (and in-play, shown locked) matches with odds, grouped client-side.
	.get("/matches", async () =>
	{
		const matches = (await sql`
			SELECT m.id, m.league, m.home, m.away, m.commence_at,
			       m.odds_home, m.odds_draw, m.odds_away,
			       COUNT(fb.id)::int AS bet_count
			FROM foot_matches m
			LEFT JOIN foot_bets fb ON fb.match_id = m.id AND fb.status = 'pending'
			WHERE m.status = 'open' AND m.odds_home IS NOT NULL
				AND m.commence_at > now() - interval '3 hours'
			GROUP BY m.id
			ORDER BY m.commence_at ASC
			LIMIT 60
		`) as unknown[];
		return { matches };
	})

	// My bets: pending + settled history
	.get("/me", async ({ userId }) =>
	{
		const pending = (await sql`
			SELECT fb.id, fb.match_id, fb.pick, fb.odds, fb.stake, fb.created_at,
			       m.league, m.home, m.away, m.commence_at
			FROM foot_bets fb
			JOIN foot_matches m ON m.id = fb.match_id
			WHERE fb.user_id = ${userId} AND fb.status = 'pending'
			ORDER BY m.commence_at ASC
		`) as unknown[];
		const history = (await sql`
			SELECT fb.id, fb.pick, fb.odds, fb.stake, fb.payout, fb.settled_at,
			       m.league, m.home, m.away, m.home_score, m.away_score, m.status AS match_status
			FROM foot_bets fb
			JOIN foot_matches m ON m.id = fb.match_id
			WHERE fb.user_id = ${userId} AND fb.status = 'settled'
			ORDER BY fb.settled_at DESC LIMIT 20
		`) as unknown[];
		return { pending, history };
	})

	.get("/feed", async () =>
	{
		const feed = (await sql`
			SELECT fb.pick, fb.odds, fb.stake, fb.payout, fb.settled_at,
			       m.home, m.away, m.home_score, m.away_score,
			       u.login, u.display_name, u.image_url
			FROM foot_bets fb
			JOIN users u ON u.id = fb.user_id
			JOIN foot_matches m ON m.id = fb.match_id
			WHERE fb.status = 'settled' AND m.status = 'settled'
			ORDER BY fb.settled_at DESC LIMIT 20
		`) as unknown[];
		return { feed };
	})

	// Place a 1N2 bet — odds locked at bet time
	.post(
		"/bets",
		async ({ userId, body, set }) =>
		{
			const limited = rl(`footBets:${userId}`, BUCKETS.footBets, set);
			if (limited) return limited;

			if (!PICKS.includes(body.pick as (typeof PICKS)[number]))
				return err(set, 422, "pick invalide (home/draw/away)");

			const rows = (await sql`
				SELECT id, home, away, commence_at, odds_home, odds_draw, odds_away, status
				FROM foot_matches WHERE id = ${body.match_id}
			`) as Array<{
				id: number; home: string; away: string; commence_at: string;
				odds_home: number | null; odds_draw: number | null; odds_away: number | null; status: string;
			}>;
			const match = rows[0];
			if (!match) return err(set, 404, "match introuvable");
			if (match.status !== "open" || new Date(match.commence_at) <= new Date())
				return err(set, 409, "le match a commencé — paris fermés");

			const odds = body.pick === "home" ? match.odds_home
				: body.pick === "draw" ? match.odds_draw : match.odds_away;
			if (!odds) return err(set, 409, "cotes indisponibles pour ce match");

			const stake = Math.floor(body.stake);
			if (stake < MIN_STAKE || stake > MAX_STAKE)
				return err(set, 422, `mise entre ${MIN_STAKE} et ${MAX_STAKE}`);

			const existing = (await sql`
				SELECT 1 FROM foot_bets WHERE user_id=${userId} AND match_id=${match.id}
			`) as unknown[];
			if (existing.length) return err(set, 409, "tu as déjà un pari sur ce match");

			const debited = (await sql`
				UPDATE users SET points = points - ${stake}
				WHERE id=${userId} AND points >= ${stake} RETURNING points
			`) as Array<{ points: number }>;
			if (!debited[0]) return err(set, 400, "solde insuffisant");
			publishBalance(userId!, debited[0].points);

			const bet = (await sql`
				INSERT INTO foot_bets (user_id, match_id, pick, odds, stake)
				VALUES (${userId}, ${match.id}, ${body.pick}, ${odds}, ${stake})
				RETURNING id, match_id, pick, odds, stake, status, created_at
			`) as unknown[];
			return { bet: bet[0] };
		},
		{
			body: t.Object({
				match_id: t.Integer({ minimum: 1 }),
				pick: t.String(),
				stake: t.Integer(),
			}),
		},
	)

	// Cancel a pending bet before kickoff — full refund
	.delete("/bets/:id", async ({ userId, params, set }) =>
	{
		const limited = rl(`footBets:${userId}`, BUCKETS.footBets, set);
		if (limited) return limited;

		const current = (await sql`
			SELECT fb.id, fb.stake, m.commence_at, m.status
			FROM foot_bets fb JOIN foot_matches m ON m.id = fb.match_id
			WHERE fb.id=${Number(params.id)} AND fb.user_id=${userId} AND fb.status='pending'
			LIMIT 1
		`) as Array<{ id: number; stake: number; commence_at: string; status: string }>;
		if (!current[0]) return err(set, 404, "pari introuvable ou déjà réglé");
		if (current[0].status !== "open" || new Date(current[0].commence_at) <= new Date())
			return err(set, 409, "le match a commencé — pari verrouillé");

		await sql`DELETE FROM foot_bets WHERE id=${current[0].id}`;
		const rows = (await sql`
			UPDATE users SET points = points + ${current[0].stake} WHERE id=${userId} RETURNING points
		`) as Array<{ points: number }>;
		if (rows[0]) publishBalance(userId!, rows[0].points);
		return { ok: true, refunded: current[0].stake };
	});

function err(set: { status?: number | string }, code: number, msg: string)
{
	set.status = code;
	return { error: msg };
}
