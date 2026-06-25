import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishAdminLog } from "./realtime";
import { rl, BUCKETS } from "./ratelimit";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const EDGE = 0.99; // 1% house edge
const MAX_BET = 1_000_000;

// Crypto-strong float in [0, 1).
function rand(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

class InsufficientFunds extends Error {}

// Apply a bet result atomically: debit the wager, credit the payout, but only
// if the balance covers the wager. Returns the new balance.
async function settle(userId: number, bet: number, payout: number, game?: string): Promise<number> {
  const rows = (await sql`
    UPDATE users
    SET points = points - ${bet} + ${payout}
    WHERE id = ${userId} AND points >= ${bet}
    RETURNING points, login
  `) as Array<{ points: number; login: string }>;
  if (!rows[0]) throw new InsufficientFunds();
  const { points, login } = rows[0];
  publishBalance(userId, points);
  void publishLeaderboard();
  if (game) {
    publishAdminLog({ action: "bet", game, login, bet, payout, win: payout > 0, balance: points });
  }
  return points;
}

const betField = t.Integer({ minimum: 1, maximum: MAX_BET });

export const games = new Elysia({ prefix: "/api/games" })
  .use(jwt({ name: "jwt", secret: SESSION_SECRET }))

  // Resolve the current user id from the session cookie, or 401.
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
  .onBeforeHandle(({ userId, set }) => rl(`games:${userId}`, BUCKETS.games, set))
  .error({ InsufficientFunds })
  .onError(({ code, error, set }) => {
    if (code === "InsufficientFunds") {
      set.status = 400;
      return { error: "solde insuffisant" };
    }
  })

  // ── Coinflip ── pick a side, 50/50, ~1.98x ────────────────────────────────
  .post(
    "/coinflip",
    async ({ body, userId }) => {
      const mult = 2 * EDGE;
      const outcome = rand() < 0.5 ? "heads" : "tails";
      const win = outcome === body.side;
      const payout = win ? Math.floor(body.bet * mult) : 0;
      const balance = await settle(userId!, body.bet, payout, "coinflip");
      return { win, outcome, multiplier: win ? mult : 0, payout, balance };
    },
    {
      body: t.Object({
        bet: betField,
        side: t.Union([t.Literal("heads"), t.Literal("tails")]),
      }),
    },
  )

  // ── Dice ── roll 0-100, bet over/under a target ───────────────────────────
  .post(
    "/dice",
    async ({ body, userId }) => {
      const { bet, target, direction } = body;
      const winChance = direction === "under" ? target : 100 - target;
      const mult = (100 / winChance) * EDGE;
      const roll = Math.round(rand() * 10000) / 100; // 0.00 - 100.00
      const win = direction === "under" ? roll < target : roll > target;
      const payout = win ? Math.floor(bet * mult) : 0;
      const balance = await settle(userId!, bet, payout, "dice");
      return { win, roll, multiplier: Number(mult.toFixed(4)), payout, balance };
    },
    {
      body: t.Object({
        bet: betField,
        target: t.Number({ minimum: 2, maximum: 98 }),
        direction: t.Union([t.Literal("under"), t.Literal("over")]),
      }),
    },
  )

  // ── Limbo ── pick a target multiplier, win if result >= target ────────────
  .post(
    "/limbo",
    async ({ body, userId }) => {
      const { bet, target } = body;
      const r = rand() || 1e-9;
      const result = Math.max(1, Math.floor((EDGE / r) * 100) / 100);
      const win = result >= target;
      const payout = win ? Math.floor(bet * target) : 0;
      const balance = await settle(userId!, bet, payout, "limbo");
      return { win, result, multiplier: target, payout, balance };
    },
    {
      body: t.Object({
        bet: betField,
        target: t.Number({ minimum: 1.01, maximum: 1_000_000 }),
      }),
    },
  )

  // ── Plinko ── 8 rows, ball falls into one of 9 buckets ────────────────────
  .post(
    "/plinko",
    async ({ body, userId }) => {
      const MULT = [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6];
      const path: number[] = [];
      let bucket = 0;
      for (let i = 0; i < 8; i++) {
        const right = rand() < 0.5 ? 0 : 1;
        path.push(right);
        bucket += right;
      }
      const mult = MULT[bucket];
      const payout = Math.floor(body.bet * mult);
      const balance = await settle(userId!, body.bet, payout, "plinko");
      return {
        win: mult >= 1,
        bucket,
        path,
        multiplier: mult,
        payout,
        balance,
      };
    },
    { body: t.Object({ bet: betField }) },
  )

  // ── Slots ── 3 weighted reels, paytable below (~93% RTP) ──────────────────
  .post(
    "/slots",
    async ({ body, userId }) => {
      // [symbol, weight, three-of-a-kind multiplier]
      const REELS: Array<[string, number, number]> = [
        ["🍒", 5, 8],
        ["🍋", 5, 12],
        ["🔔", 4, 20],
        ["⭐", 3, 40],
        ["💎", 2, 90],
        ["7️⃣", 1, 250],
      ];
      const total = REELS.reduce((a, r) => a + r[1], 0);
      const spin = () => {
        let n = rand() * total;
        for (const r of REELS) {
          if (n < r[1]) return r;
          n -= r[1];
        }
        return REELS[0];
      };

      const a = spin();
      const b = spin();
      const c = spin();
      const reels = [a[0], b[0], c[0]];

      let mult = 0;
      if (a[0] === b[0] && b[0] === c[0]) {
        mult = a[2]; // three of a kind
      } else {
        // exactly two of a rare symbol still pays
        const counts: Record<string, number> = {};
        for (const s of reels) counts[s] = (counts[s] ?? 0) + 1;
        if (counts["7️⃣"] === 2) mult = 10;
        else if (counts["💎"] === 2) mult = 5;
      }

      const payout = Math.floor(body.bet * mult);
      const balance = await settle(userId!, body.bet, payout, "slots");
      return { win: mult > 0, reels, multiplier: mult, payout, balance };
    },
    { body: t.Object({ bet: betField }) },
  );
