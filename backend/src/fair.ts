import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

// ── Provably fair ─────────────────────────────────────────────────────────────
// Each user has a (server_seed, client_seed, nonce) triple. The server only
// reveals sha256(server_seed) up-front; each bet derives its floats from
// HMAC-SHA256(server_seed, `${client_seed}:${nonce}:${i}`). Rotating the pair
// reveals the old server seed so past bets can be re-verified.

function randomHex(bytes = 32): string
{
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sha256Hex(s: string): string
{
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(s);
	return hasher.digest("hex");
}

function hmacHex(key: string, msg: string): string
{
	const hasher = new Bun.CryptoHasher("sha256", key);
	hasher.update(msg);
	return hasher.digest("hex");
}

interface SeedRow
{
	server_seed: string;
	client_seed: string;
	nonce: number;
}

async function getOrCreateSeeds(userId: number): Promise<SeedRow>
{
	const rows = (await sql`
		SELECT server_seed, client_seed, nonce FROM user_seeds WHERE user_id = ${userId}
	`) as SeedRow[];
	if (rows[0]) return rows[0];
	const server_seed = randomHex();
	const client_seed = randomHex(8);
	const inserted = (await sql`
		INSERT INTO user_seeds (user_id, server_seed, client_seed, nonce)
		VALUES (${userId}, ${server_seed}, ${client_seed}, 0)
		ON CONFLICT (user_id) DO UPDATE SET nonce = user_seeds.nonce
		RETURNING server_seed, client_seed, nonce
	`) as SeedRow[];
	return inserted[0];
}

/** Draw `n` provably-fair floats in [0,1) for a bet; consumes one nonce. */
export async function fairRoll(userId: number, n = 1): Promise<{ values: number[]; nonce: number }>
{
	const rows = (await sql`
		UPDATE user_seeds SET nonce = nonce + 1
		WHERE user_id = ${userId}
		RETURNING server_seed, client_seed, nonce
	`) as SeedRow[];
	const seeds = rows[0] ?? await (async () =>
	{
		await getOrCreateSeeds(userId);
		const r = (await sql`
			UPDATE user_seeds SET nonce = nonce + 1
			WHERE user_id = ${userId}
			RETURNING server_seed, client_seed, nonce
		`) as SeedRow[];
		return r[0];
	})();

	const values: number[] = [];
	for (let i = 0; i < n; i++)
	{
		const hex = hmacHex(seeds.server_seed, `${seeds.client_seed}:${seeds.nonce}:${i}`);
		values.push(parseInt(hex.slice(0, 8), 16) / 2 ** 32);
	}
	return { values, nonce: seeds.nonce };
}

export const fair = new Elysia({ prefix: "/api/fair" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
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

	// Current pair: hashed server seed + client seed + nonce.
	.get("/", async ({ userId }) =>
	{
		const s = await getOrCreateSeeds(userId!);
		return {
			server_seed_hash: sha256Hex(s.server_seed),
			client_seed: s.client_seed,
			nonce: s.nonce,
		};
	})

	// Rotate: reveal the old server seed, start a fresh pair.
	.post(
		"/rotate",
		async ({ userId, body }) =>
		{
			const old = await getOrCreateSeeds(userId!);
			const server_seed = randomHex();
			const client_seed = (body.client_seed ?? "").trim() || randomHex(8);
			await sql`
				UPDATE user_seeds
				SET server_seed = ${server_seed}, client_seed = ${client_seed}, nonce = 0
				WHERE user_id = ${userId!}
			`;
			return {
				revealed: {
					server_seed: old.server_seed,
					server_seed_hash: sha256Hex(old.server_seed),
					client_seed: old.client_seed,
					last_nonce: old.nonce,
				},
				server_seed_hash: sha256Hex(server_seed),
				client_seed,
				nonce: 0,
			};
		},
		{ body: t.Object({ client_seed: t.Optional(t.String({ maxLength: 64 })) }) },
	);
