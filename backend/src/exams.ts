import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const ADMINS = (process.env.ADMIN_LOGINS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

export const exams = new Elysia({ prefix: "/api/exams" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		const userId = payload && payload.sub ? Number(payload.sub) : null;
		let isAdmin = false;
		if (userId)
		{
			const r = (await sql`SELECT login FROM users WHERE id=${userId}`) as Array<{ login: string }>;
			isAdmin = !!r[0] && ADMINS.includes(r[0].login.toLowerCase());
		}
		return { userId, isAdmin };
	})

	// Public: list all exams ordered by date
	.get("/", async () =>
	{
		const rows = (await sql`
			SELECT e.id, e.label, e.exam_date, e.is_final, e.locked, e.created_at,
						 COUNT(eb.id)::int AS bet_count
			FROM exams e
			LEFT JOIN exam_bets eb ON eb.exam_id = e.id AND eb.status = 'pending'
			GROUP BY e.id
			ORDER BY e.exam_date ASC
		`) as unknown[];
		return { exams: rows };
	})

	// Admin: create exam
	.post(
		"/",
		async ({ isAdmin, body, set }) =>
		{
			if (!isAdmin) return forbid(set);
			const rows = (await sql`
				INSERT INTO exams (label, exam_date, is_final)
				VALUES (${body.label.trim()}, ${body.exam_date}, ${body.is_final ?? false})
				RETURNING id, label, exam_date, is_final, locked, created_at
			`) as unknown[];
			return { exam: rows[0] };
		},
		{
			body: t.Object({
				label: t.String({ minLength: 1, maxLength: 80 }),
				exam_date: t.String(),
				is_final: t.Optional(t.Boolean()),
			}),
		},
	)

	// Admin: lock an exam (closes betting)
	.post("/:id/lock", async ({ isAdmin, params, set }) =>
	{
		if (!isAdmin) return forbid(set);
		const rows = (await sql`
			UPDATE exams SET locked = true WHERE id = ${Number(params.id)} RETURNING id
		`) as unknown[];
		if (!rows.length) return err(set, 404, "exam introuvable");
		return { ok: true };
	})

	// Admin: delete exam (only if no bets on it)
	.delete("/:id", async ({ isAdmin, params, set }) =>
	{
		if (!isAdmin) return forbid(set);
		const bets = (await sql`
			SELECT 1 FROM exam_bets WHERE exam_id = ${Number(params.id)} LIMIT 1
		`) as unknown[];
		if (bets.length) return err(set, 409, "des paris existent sur cet exam");
		const rows = (await sql`
			DELETE FROM exams WHERE id = ${Number(params.id)} RETURNING id
		`) as unknown[];
		if (!rows.length) return err(set, 404, "exam introuvable");
		return { ok: true };
	});

function forbid(set: { status?: number | string })
{
	set.status = 403;
	return { error: "acces refuse" };
}
function err(set: { status?: number | string }, code: number, msg: string)
{
	set.status = code;
	return { error: msg };
}
