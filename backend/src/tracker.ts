import { Elysia, t } from "elysia";
import { sql } from "./db";
import { settleBet } from "./exambets";

const TRACKER_SECRET = process.env.TRACKER_SECRET ?? "";

function auth(headers: Record<string, string | undefined>, set: { status?: number | string }) {
  if (!TRACKER_SECRET) {
    set.status = 503;
    return { error: "TRACKER_SECRET non configuré" };
  }
  const key = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "")
            || (headers["x-tracker-key"] ?? "");
  if (key !== TRACKER_SECRET) {
    set.status = 401;
    return { error: "clé invalide" };
  }
}

export const tracker = new Elysia({ prefix: "/api/tracker" })

  // Début d'exam → verrouille les paris
  .post("/:id/start", async ({ params, headers, set }) => {
    const denied = auth(headers, set);
    if (denied) return denied;

    await sql`UPDATE exams SET locked = true WHERE id = ${Number(params.id)}`;
    return { ok: true };
  })

  // Note d'un étudiant → règle son pari
  .post(
    "/:id/grade",
    async ({ params, body, headers, set }) => {
      const denied = auth(headers, set);
      if (denied) return denied;

      const examId = Number(params.id);

      const users = (await sql`
        SELECT id FROM users WHERE login = ${body.login} LIMIT 1
      `) as Array<{ id: number }>;
      if (!users.length) return { ok: false, note: "user inconnu" };
      const userId = users[0].id;

      const bets = (await sql`
        SELECT id, predicted, stake, exam_type, user_id
        FROM exam_bets
        WHERE user_id = ${userId} AND exam_id = ${examId} AND status = 'pending'
        LIMIT 1
      `) as Array<{ id: number; predicted: number; stake: number; exam_type: string; user_id: number }>;

      if (!bets.length) return { ok: false, note: "pas de pari en attente" };

      await settleBet(bets[0], body.score);
      return { ok: true };
    },
    {
      body: t.Object({
        login: t.String({ minLength: 1 }),
        score: t.Integer({ minimum: 0, maximum: 100 }),
      }),
    },
  )

  // Fin d'exam → signal de clôture (idempotent, utile pour monitoring)
  .post("/:id/end", async ({ params, headers, set }) => {
    const denied = auth(headers, set);
    if (denied) return denied;

    await sql`UPDATE exams SET locked = true WHERE id = ${Number(params.id)}`;
    return { ok: true };
  });
