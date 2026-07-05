import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

// Les exams sont créés/maj par la sync auto intra (examsync.ts) — lecture seule ici.
export const exams = new Elysia({ prefix: "/api/exams" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		const userId = payload && payload.sub ? Number(payload.sub) : null;
		return { userId };
	})

	// Public: list all exams ordered by date, plus the viewer's cursus context.
	.get("/", async ({ userId }) =>
	{
		const rows = (await sql`
			SELECT e.id, e.label, e.exam_date, e.is_final, e.locked, e.rank, e.created_at,
						 COUNT(eb.id)::int AS bet_count
			FROM exams e
			LEFT JOIN exam_bets eb ON eb.exam_id = e.id AND eb.status = 'pending'
			GROUP BY e.id
			ORDER BY e.exam_date ASC
		`) as unknown[];

		let ctx: { common_core_done: boolean; exam_rank: number | null } | null = null;
		if (userId)
		{
			const u = (await sql`
				SELECT common_core_done, exam_rank FROM users WHERE id=${userId}
			`) as Array<{ common_core_done: boolean; exam_rank: number | null }>;
			ctx = u[0] ?? null;
		}
		return { exams: rows, ctx };
	});
