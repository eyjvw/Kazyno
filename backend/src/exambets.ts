import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishToUser } from "./realtime";
import { pushNotif } from "./notifications";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const FT_UID = process.env.FT_UID ?? "";
const FT_SECRET = process.env.FT_SECRET ?? "";
const FT_TOKEN = "https://api.intra.42.fr/oauth/token";

const MIN_STAKE = 10;
const MAX_STAKE = 1_000_000;

// Payout multiplier from how close the prediction is (|predicted - actual|).
// Bands chosen to fit 42 exam steps (paliers of ~6 to 10 points).
export function multiplierFor(diff: number): number {
  if (diff === 0) return 10;
  if (diff <= 6) return 3;
  if (diff <= 12) return 1.5;
  if (diff <= 20) return 1; // stake returned
  return 0; // lost
}

// ── 42 app token (client_credentials) — reads public exam data ──────────────
let appToken: string | null = null;
let appExp = 0;
async function ftToken(): Promise<string | null> {
  if (appToken && Date.now() < appExp) return appToken;
  if (!FT_UID || !FT_SECRET) return null;
  const r = await fetch(FT_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: FT_UID,
      client_secret: FT_SECRET,
      scope: "public",
    }),
  });
  if (!r.ok) return null;
  const d = (await r.json()) as { access_token: string; expires_in: number };
  appToken = d.access_token;
  appExp = Date.now() + (d.expires_in - 60) * 1000;
  return appToken;
}

async function credit(userId: number, amount: number) {
  if (amount <= 0) return;
  const rows = (await sql`
    UPDATE users SET points = points + ${amount} WHERE id = ${userId} RETURNING points
  `) as Array<{ points: number }>;
  if (rows[0]) publishBalance(userId, rows[0].points);
}

async function settleBet(
  bet: { id: number; user_id: number; predicted: number; stake: number },
  actual: number,
  examId: number | null,
) {
  const diff = Math.abs(bet.predicted - actual);
  const mult = multiplierFor(diff);
  const payout = Math.floor(bet.stake * mult);
  await sql`
    UPDATE exam_bets
    SET status='settled', actual=${actual}, exam_id=${examId},
        multiplier=${mult}, payout=${payout}, settled_at=now()
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

// ── Cron: poll 42 for graded exams of users with a pending bet ──────────────
async function pollExams() {
  const pend = (await sql`
    SELECT eb.id, eb.predicted, eb.stake, eb.created_at, u.id AS user_id, u.ft_id
    FROM exam_bets eb JOIN users u ON u.id = eb.user_id
    WHERE eb.status='pending' AND u.ft_id IS NOT NULL
  `) as Array<{
    id: number;
    predicted: number;
    stake: number;
    created_at: string;
    user_id: number;
    ft_id: number;
  }>;
  if (!pend.length) return;
  const tok = await ftToken();
  if (!tok) return;

  for (const b of pend) {
    try {
      const r = await fetch(
        `https://api.intra.42.fr/v2/users/${b.ft_id}/exams_users?sort=-updated_at&page[size]=10`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!r.ok) continue;
      const exams = (await r.json()) as Array<{
        id: number;
        exam_id: number | null;
        final_mark: number | null;
        updated_at: string;
      }>;
      const graded = exams.find(
        (e) =>
          e.final_mark != null && new Date(e.updated_at) > new Date(b.created_at),
      );
      if (graded) await settleBet(b, graded.final_mark!, graded.exam_id);
    } catch {
      /* skip this user this round */
    }
  }
}
setInterval(() => void pollExams(), 180_000);

// ── Plugin ──────────────────────────────────────────────────────────────
export const exambets = new Elysia({ prefix: "/api/exam-bets" })
  .use(jwt({ name: "jwt", secret: SESSION_SECRET }))
  .derive(async ({ jwt, cookie: { session } }) => {
    const payload = session.value ? await jwt.verify(session.value) : false;
    return { userId: payload && payload.sub ? Number(payload.sub) : null };
  })
  .onBeforeHandle(({ userId, set }) => {
    if (!userId) {
      set.status = 401;
      return { error: "non authentifie" };
    }
  })

  // My pending bet + my recent history.
  .get("/me", async ({ userId }) => {
    const pending = (await sql`
      SELECT id, predicted, stake, status, created_at
      FROM exam_bets WHERE user_id=${userId} AND status='pending'
      ORDER BY created_at DESC LIMIT 1
    `) as unknown[];
    const history = (await sql`
      SELECT id, predicted, stake, actual, multiplier, payout, settled_at
      FROM exam_bets WHERE user_id=${userId} AND status='settled'
      ORDER BY settled_at DESC LIMIT 10
    `) as unknown[];
    return { pending: pending[0] ?? null, history };
  })

  // Recent settled bets across everyone (social feed).
  .get("/feed", async () => {
    const feed = (await sql`
      SELECT eb.predicted, eb.actual, eb.multiplier, eb.payout, eb.settled_at,
             u.login, u.display_name, u.image_url
      FROM exam_bets eb JOIN users u ON u.id = eb.user_id
      WHERE eb.status='settled'
      ORDER BY eb.settled_at DESC LIMIT 20
    `) as unknown[];
    return { feed };
  })

  // Place a bet on your next exam grade.
  .post(
    "/",
    async ({ userId, body, set }) => {
      const existing = (await sql`
        SELECT 1 FROM exam_bets WHERE user_id=${userId} AND status='pending'
      `) as unknown[];
      if (existing.length) return err(set, 409, "tu as deja un pari en cours");

      const stake = Math.floor(body.stake);
      if (stake < MIN_STAKE || stake > MAX_STAKE)
        return err(set, 422, `mise entre ${MIN_STAKE} et ${MAX_STAKE}`);

      const debited = (await sql`
        UPDATE users SET points = points - ${stake}
        WHERE id=${userId} AND points >= ${stake} RETURNING points
      `) as Array<{ points: number }>;
      if (!debited[0]) return err(set, 400, "solde insuffisant");
      publishBalance(userId!, debited[0].points);

      const rows = (await sql`
        INSERT INTO exam_bets (user_id, predicted, stake)
        VALUES (${userId}, ${body.predicted}, ${stake})
        RETURNING id, predicted, stake, status, created_at
      `) as unknown[];
      return { bet: rows[0] };
    },
    {
      body: t.Object({
        predicted: t.Integer({ minimum: 0, maximum: 100 }),
        stake: t.Integer(),
      }),
    },
  );

function err(set: { status?: number | string }, code: number, msg: string) {
  set.status = code;
  return { error: msg };
}
