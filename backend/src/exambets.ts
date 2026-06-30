import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishToUser } from "./realtime";
import { pushNotif } from "./notifications";
import { rl, BUCKETS } from "./ratelimit";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

const MIN_STAKE = 10;
const MAX_STAKE = 1_000_000;

export const EXAM_TYPES = ["standard", "final"] as const;
export type ExamType = (typeof EXAM_TYPES)[number];

export function stepFor(type: ExamType): number
{
	return type === "final" ? 6 : 10;
}

export function validScores(type: ExamType): number[]
{
	if (type === "standard") return Array.from({ length: 11 }, (_, i) => i * 10);
	const scores: number[] = [];
	for (let i = 0; i <= 96; i += 6) scores.push(i);
	scores.push(100);
	return scores;
}

export function multiplierFor(diff: number, step: number): number
{
	if (diff === 0)          return 10;
	if (diff <= step)        return 3;
	if (diff <= step * 2)    return 1.5;
	if (diff <= step * 3)    return 1;
	return 0;
}


async function credit(userId: number, amount: number)
{
	if (amount <= 0) return;
	const rows = (await sql`
		UPDATE users SET points = points + ${amount} WHERE id = ${userId} RETURNING points
	`) as Array<{ points: number }>;
	if (rows[0]) publishBalance(userId, rows[0].points);
}

export async function settleBet(
	bet: { id: number; user_id: number; predicted: number; stake: number; exam_type: string },
	actual: number,
)
{
	const step = stepFor((bet.exam_type as ExamType) ?? "standard");
	const diff = Math.abs(bet.predicted - actual);
	const mult = multiplierFor(diff, step);
	const payout = Math.floor(bet.stake * mult);
	await sql`
		UPDATE exam_bets
		SET status='settled', actual=${actual}, multiplier=${mult}, payout=${payout}, settled_at=now()
		WHERE id=${bet.id} AND status='pending'
	`;
	if (payout > 0) await credit(bet.user_id, payout);
	publishToUser(bet.user_id, {
		type: "exam_settled",
		predicted: bet.predicted,
		actual,
		multiplier: mult,
		payout,
		stake: bet.stake,
	});
	await pushNotif(bet.user_id, {
		kind: "exam",
		message:
			payout > 0
				? `Exam noté ${actual}/100 — gagné +${payout} pts (${mult}×)`
				: `Exam noté ${actual}/100 — pari perdu (-${bet.stake})`,
		link: "/paris",
	});
	void publishLeaderboard();
}

// ── Plugin ────────────────────────────────────────────────────────────────────
export const exambets = new Elysia({ prefix: "/api/exam-bets" })
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

	// My bets: all pending (one per exam) + history
	.get("/me", async ({ userId }) =>
	{
		const pending = (await sql`
			SELECT eb.id, eb.exam_id, eb.predicted, eb.stake, eb.exam_type, eb.status, eb.created_at,
						 e.label AS exam_label, e.exam_date, e.is_final, e.locked
			FROM exam_bets eb
			JOIN exams e ON e.id = eb.exam_id
			WHERE eb.user_id = ${userId} AND eb.status = 'pending'
			ORDER BY e.exam_date ASC
		`) as unknown[];
		const history = (await sql`
			SELECT eb.id, eb.exam_id, eb.predicted, eb.stake, eb.exam_type,
						 eb.actual, eb.multiplier, eb.payout, eb.settled_at,
						 e.label AS exam_label, e.is_final
			FROM exam_bets eb
			LEFT JOIN exams e ON e.id = eb.exam_id
			WHERE eb.user_id = ${userId} AND eb.status = 'settled'
			ORDER BY eb.settled_at DESC LIMIT 20
		`) as unknown[];
		return { pending, history };
	})

	.get("/feed", async () =>
	{
		const feed = (await sql`
			SELECT eb.predicted, eb.actual, eb.multiplier, eb.payout, eb.stake, eb.exam_type,
						 eb.settled_at, e.label AS exam_label, e.is_final,
						 u.login, u.display_name, u.image_url
			FROM exam_bets eb
			JOIN users u ON u.id = eb.user_id
			LEFT JOIN exams e ON e.id = eb.exam_id
			WHERE eb.status = 'settled'
			ORDER BY eb.settled_at DESC LIMIT 20
		`) as unknown[];
		return { feed };
	})

	// Place bet on a specific exam
	.post(
		"/",
		async ({ userId, body, set }) =>
		{
			const limited = rl(`examBets:${userId}`, BUCKETS.examBets, set);
			if (limited) return limited;

			const examRows = (await sql`
				SELECT id, is_final, locked, exam_date FROM exams WHERE id = ${body.exam_id}
			`) as Array<{ id: number; is_final: boolean; locked: boolean; exam_date: string }>;
			if (!examRows[0]) return err(set, 404, "exam introuvable");
			if (examRows[0].locked || new Date(examRows[0].exam_date) < new Date())
				return err(set, 409, "les paris pour cet exam sont fermés");

			const type: ExamType = examRows[0].is_final ? "final" : "standard";
			const valid = validScores(type);
			if (!valid.includes(body.predicted)) return err(set, 422, "score invalide pour ce type d'exam");

			const stake = Math.floor(body.stake);
			if (stake < MIN_STAKE || stake > MAX_STAKE) return err(set, 422, `mise entre ${MIN_STAKE} et ${MAX_STAKE}`);

			const existing = (await sql`
				SELECT 1 FROM exam_bets WHERE user_id=${userId} AND exam_id=${body.exam_id} AND status='pending'
			`) as unknown[];
			if (existing.length) return err(set, 409, "tu as déjà un pari sur cet exam");

			const debited = (await sql`
				UPDATE users SET points = points - ${stake}
				WHERE id=${userId} AND points >= ${stake} RETURNING points
			`) as Array<{ points: number }>;
			if (!debited[0]) return err(set, 400, "solde insuffisant");
			publishBalance(userId!, debited[0].points);

			const rows = (await sql`
				INSERT INTO exam_bets (user_id, exam_id, predicted, stake, exam_type)
				VALUES (${userId}, ${body.exam_id}, ${body.predicted}, ${stake}, ${type})
				RETURNING id, exam_id, predicted, stake, exam_type, status, created_at
			`) as unknown[];
			return { bet: rows[0] };
		},
		{
			body: t.Object({
				exam_id: t.Integer({ minimum: 1 }),
				predicted: t.Integer({ minimum: 0, maximum: 100 }),
				stake: t.Integer(),
			}),
		},
	)

	// Modify a pending bet by bet id
	.put(
		"/:id",
		async ({ userId, params, body, set }) =>
		{
			const limited = rl(`examBets:${userId}`, BUCKETS.examBets, set);
			if (limited) return limited;

			const current = (await sql`
				SELECT eb.id, eb.stake, eb.exam_type, e.locked
				FROM exam_bets eb JOIN exams e ON e.id = eb.exam_id
				WHERE eb.id=${Number(params.id)} AND eb.user_id=${userId} AND eb.status='pending'
				LIMIT 1
			`) as Array<{ id: number; stake: number; exam_type: string; locked: boolean }>;
			if (!current[0]) return err(set, 404, "pari introuvable ou déjà réglé");
			if (current[0].locked) return err(set, 409, "les paris pour cet exam sont fermés");

			const type = current[0].exam_type as ExamType;
			const valid = validScores(type);
			if (!valid.includes(body.predicted)) return err(set, 422, "score invalide pour ce type d'exam");

			const newStake = Math.floor(body.stake);
			if (newStake < MIN_STAKE || newStake > MAX_STAKE) return err(set, 422, `mise entre ${MIN_STAKE} et ${MAX_STAKE}`);

			const diff = newStake - current[0].stake;
			if (diff > 0)
			{
				const debited = (await sql`
					UPDATE users SET points = points - ${diff}
					WHERE id=${userId} AND points >= ${diff} RETURNING points
				`) as Array<{ points: number }>;
				if (!debited[0]) return err(set, 400, "solde insuffisant");
				publishBalance(userId!, debited[0].points);
			}
			else if (diff < 0)
			{
				const rows = (await sql`
					UPDATE users SET points = points + ${-diff} WHERE id=${userId} RETURNING points
				`) as Array<{ points: number }>;
				if (rows[0]) publishBalance(userId!, rows[0].points);
			}

			await sql`UPDATE exam_bets SET predicted=${body.predicted}, stake=${newStake} WHERE id=${current[0].id}`;
			return { ok: true, predicted: body.predicted, stake: newStake };
		},
		{
			body: t.Object({
				predicted: t.Integer({ minimum: 0, maximum: 100 }),
				stake: t.Integer(),
			}),
		},
	)

	// Cancel a pending bet — full refund
	.delete("/:id", async ({ userId, params, set }) =>
	{
		const limited = rl(`examBets:${userId}`, BUCKETS.examBets, set);
		if (limited) return limited;

		const current = (await sql`
			SELECT id, stake FROM exam_bets
			WHERE id=${Number(params.id)} AND user_id=${userId} AND status='pending'
			LIMIT 1
		`) as Array<{ id: number; stake: number }>;
		if (!current[0]) return err(set, 404, "pari introuvable ou déjà réglé");

		await sql`DELETE FROM exam_bets WHERE id=${current[0].id}`;
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
