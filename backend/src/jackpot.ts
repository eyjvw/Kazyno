import { Elysia } from "elysia";
import { sql } from "./db";
import { publishBroadcast } from "./realtime";

// ── Progressive jackpot ───────────────────────────────────────────────────────
// 1% of every losing wager feeds the pot. Hitting three 7️⃣ on slots wins the
// whole pot; it then resets to the seed value.

const SEED = 10_000;
const CUT = 0.01;

let cached = SEED;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

async function refresh(): Promise<number>
{
	const rows = (await sql`SELECT amount FROM jackpot WHERE id = 1`) as Array<{ amount: number }>;
	cached = Number(rows[0]?.amount ?? SEED);
	return cached;
}

// Coalesce pot pushes: at most one broadcast per second.
function schedulePush()
{
	if (pushTimer) return;
	pushTimer = setTimeout(() =>
	{
		pushTimer = null;
		publishBroadcast({ type: "jackpot", amount: cached });
	}, 1000);
}

/** Feed the pot from a losing wager. Fire-and-forget. */
export function contributeJackpot(bet: number)
{
	const cut = Math.floor(bet * CUT);
	if (cut < 1) return;
	void sql`UPDATE jackpot SET amount = amount + ${cut} WHERE id = 1 RETURNING amount`
		.then((rows: any) =>
		{
			cached = Number(rows[0]?.amount ?? cached);
			schedulePush();
		})
		.catch(() => {});
}

/** Atomic read-and-reset (slots triple 7). Returns the amount won. */
export async function takeJackpot(login: string): Promise<number>
{
	const rows = (await sql`
		WITH old AS (SELECT amount FROM jackpot WHERE id = 1 FOR UPDATE)
		UPDATE jackpot SET amount = ${SEED}
		FROM old
		WHERE jackpot.id = 1
		RETURNING old.amount
	`) as Array<{ amount: number }>;
	const won = Number(rows[0]?.amount ?? 0);
	cached = SEED;
	publishBroadcast({ type: "jackpot", amount: SEED, won, login });
	return won;
}

/** Weekly reset: pot back to the seed, broadcast the new value. */
export async function resetJackpot(): Promise<void>
{
	await sql`UPDATE jackpot SET amount = ${SEED} WHERE id = 1`;
	cached = SEED;
	publishBroadcast({ type: "jackpot", amount: SEED });
}

// Module import runs before initDb(); table may not exist yet on first boot.
void refresh().catch(() => {});

export const jackpotRoutes = new Elysia({ prefix: "/api/jackpot" })
	.get("/", async () => ({ amount: await refresh() }));
