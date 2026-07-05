// ═══════════════════════════════════════════════════════════════════════════
// TEMPORAIRE — Riddle Hunt (≈ 2 mois). À supprimer ensuite :
//   1. virer ce fichier + son .use() dans index.ts + l'appel
//      redeemPendingTreasure() dans auth.ts (callback OAuth)
//   2. DROP TABLE treasure_progress; DROP TABLE treasure_rotd;
//      DROP TABLE treasure_pending_trail; DROP TABLE treasure_pending_rotd;
//   3. retirer TREASURE_SECRET du .env / docker-compose
// (les paiements apparaissent dans le live log admin, filtre "Chasse au trésor")
//
// Deux types d'énigmes (spec du script externe) :
//   - "trail" : Chasse aux Énigmes — 17 badges scannés DANS L'ORDRE (1/17, 2/17…)
//   - "rotd"  : Devinette du Jour — 1 par jour (~25 au total), pas de niveau
// ═══════════════════════════════════════════════════════════════════════════
import { Elysia, t } from "elysia";
import { sql } from "./db";
import { publishBalance, publishAdminLog } from "./realtime";
import { pushNotif } from "./notifications";

const TREASURE_SECRET = process.env.TREASURE_SECRET ?? "";

// ── GAINS — à ajuster librement ─────────────────────────────────────────────
// Trail : de plus en plus haut selon la position dans la chasse (17 niveaux).
const TRAIL_REWARDS: Record<number, number> = {
	1: 50,   2: 60,   3: 75,   4: 90,   5: 110,
	6: 130,  7: 155,  8: 185,  9: 220,  10: 260,
	11: 310, 12: 370, 13: 440, 14: 520, 15: 620,
	16: 740, 17: 1000,
};
const TRAIL_DEFAULT = 250;  // filet de sécurité si un niveau manquait au barème
const ROTD_REWARD   = 150;  // points fixes par devinette du jour

function trailReward(from: number, to: number): number
{
	let total = 0;
	for (let lvl = from + 1; lvl <= to; lvl++) total += TRAIL_REWARDS[lvl] ?? TRAIL_DEFAULT;
	return total;
}

function auth(headers: Record<string, string | undefined>, set: { status?: number | string })
{
	if (!TREASURE_SECRET)
	{
		set.status = 503;
		return { error: "TREASURE_SECRET non configuré" };
	}
	const key = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
	if (key !== TREASURE_SECRET)
	{
		set.status = 401;
		return { error: "clé invalide" };
	}
}

// Tables d'état créées à la volée (supprimables d'un DROP à la fin de l'event).
let ready: Promise<void> | null = null;
function ensureTables(): Promise<void>
{
	ready ??= (async () =>
	{
		await sql`
			CREATE TABLE IF NOT EXISTS treasure_progress (
				user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
				level      INTEGER NOT NULL DEFAULT 0,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`;
		await sql`
			CREATE TABLE IF NOT EXISTS treasure_rotd (
				user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				day     DATE NOT NULL,
				PRIMARY KEY (user_id, day)
			)
		`;
		// Gains en attente pour les logins jamais connectés au casino —
		// crédités rétroactivement au premier login (redeemPendingTreasure).
		await sql`
			CREATE TABLE IF NOT EXISTS treasure_pending_trail (
				login     TEXT PRIMARY KEY,
				level     INTEGER NOT NULL,
				max_level INTEGER NOT NULL DEFAULT 17
			)
		`;
		await sql`
			CREATE TABLE IF NOT EXISTS treasure_pending_rotd (
				login TEXT NOT NULL,
				day   DATE NOT NULL,
				PRIMARY KEY (login, day)
			)
		`;
	})();
	return ready;
}

async function findUser(login: string): Promise<{ id: number; login: string } | null>
{
	const users = (await sql`
		SELECT id, login FROM users WHERE lower(login) = lower(${login}) LIMIT 1
	`) as Array<{ id: number; login: string }>;
	return users[0] ?? null;
}

async function pay(user: { id: number; login: string }, gain: number, logExtra: Record<string, unknown>, message: string)
{
	const rows = (await sql`
		UPDATE users SET points = points + ${gain} WHERE id = ${user.id} RETURNING points
	`) as Array<{ points: number }>;
	publishBalance(user.id, rows[0].points);
	publishAdminLog({ action: "treasure", login: user.login, amount: gain, ...logExtra });
	await pushNotif(user.id, { kind: "reward", message });
	return rows[0].points;
}

/** Paye les niveaux trail franchis (claim atomique). Retourne le gain payé. */
async function payTrail(user: { id: number; login: string }, level: number, maxLevel: number): Promise<number>
{
	await sql`
		INSERT INTO treasure_progress (user_id) VALUES (${user.id})
		ON CONFLICT (user_id) DO NOTHING
	`;
	// On lit l'ancien niveau verrouillé et on ne monte que s'il est inférieur —
	// un seul payeur possible par palier.
	const claimed = (await sql`
		UPDATE treasure_progress tp
		SET level = ${level}, updated_at = now()
		FROM (SELECT user_id, level AS old FROM treasure_progress WHERE user_id = ${user.id} FOR UPDATE) prev
		WHERE tp.user_id = prev.user_id AND prev.old < ${level}
		RETURNING prev.old
	`) as Array<{ old: number }>;
	if (!claimed[0]) return 0;

	const gain = trailReward(claimed[0].old, level);
	await pay(
		user, gain, { kind: "trail", level, maxLevel },
		`🗺️ Chasse aux énigmes : badge ${level}/${maxLevel} validé ! +${gain} pts`,
	);
	return gain;
}

/** Crédite rétroactivement les gains stockés avant le premier login.
 * Appelé depuis le callback OAuth — DELETE...RETURNING = claim atomique,
 * un double login simultané ne paye pas deux fois. */
export async function redeemPendingTreasure(userId: number, login: string): Promise<void>
{
	try
	{
		await ensureTables();
		const lower = login.toLowerCase();
		const user = { id: userId, login };

		const trail = (await sql`
			DELETE FROM treasure_pending_trail WHERE login = ${lower}
			RETURNING level, max_level
		`) as Array<{ level: number; max_level: number }>;
		if (trail[0]) await payTrail(user, trail[0].level, trail[0].max_level);

		// day::text — Bun.sql renvoie les DATE en objet Date JS, dont la
		// sérialisation par défaut n'est pas un format que Postgres accepte.
		const days = (await sql`
			DELETE FROM treasure_pending_rotd WHERE login = ${lower} RETURNING day::text AS day
		`) as Array<{ day: string }>;
		let paidDays = 0;
		for (const d of days)
		{
			const ins = (await sql`
				INSERT INTO treasure_rotd (user_id, day) VALUES (${userId}, ${d.day})
				ON CONFLICT (user_id, day) DO NOTHING
				RETURNING day
			`) as unknown[];
			if (ins.length) paidDays++;
		}
		if (paidDays)
		{
			await pay(
				user, paidDays * ROTD_REWARD, { kind: "rotd", days: paidDays },
				`💡 ${paidDays} devinette${paidDays > 1 ? "s" : ""} du jour rattrapée${paidDays > 1 ? "s" : ""} ! +${paidDays * ROTD_REWARD} pts`,
			);
		}
	}
	catch (e)
	{
		console.error("[treasure-redeem]", e);
	}
}

export const treasure = new Elysia({ prefix: "/api/treasure" })

	// Route unique : énigme résolue (trail ou devinette du jour).
	// Anti-replay server-side dans les deux cas — rejouer une requête ne
	// repaye jamais deux fois.
	.post(
		"/progress",
		async ({ body, headers, set }) =>
		{
			const denied = auth(headers, set);
			if (denied) return denied;
			await ensureTables();

			const user = await findUser(body.login);

			// ── Joueur jamais connecté : on stocke, crédité à son 1er login ────
			if (!user)
			{
				const lower = body.login.toLowerCase();
				if (body.type === "rotd")
				{
					await sql`
						INSERT INTO treasure_pending_rotd (login, day) VALUES (${lower}, CURRENT_DATE)
						ON CONFLICT (login, day) DO NOTHING
					`;
				}
				else
				{
					if (body.level === undefined)
					{
						set.status = 422;
						return { error: "level requis pour type=trail" };
					}
					await sql`
						INSERT INTO treasure_pending_trail (login, level, max_level)
						VALUES (${lower}, ${body.level}, ${body.maxLevel ?? 17})
						ON CONFLICT (login) DO UPDATE SET
							level     = GREATEST(treasure_pending_trail.level, EXCLUDED.level),
							max_level = EXCLUDED.max_level
					`;
				}
				return { ok: true, paid: 0, pending: true, note: "joueur pas encore inscrit au casino — sera crédité à son premier login" };
			}

			// ── Devinette du Jour : points fixes, une seule fois par jour ──────
			if (body.type === "rotd")
			{
				const claimed = (await sql`
					INSERT INTO treasure_rotd (user_id, day) VALUES (${user.id}, CURRENT_DATE)
					ON CONFLICT (user_id, day) DO NOTHING
					RETURNING day
				`) as unknown[];
				if (!claimed.length) return { ok: true, paid: 0, note: "devinette du jour déjà payée" };

				const balance = await pay(
					user, ROTD_REWARD, { kind: "rotd" },
					`💡 Devinette du jour résolue ! +${ROTD_REWARD} pts`,
				);
				return { ok: true, paid: ROTD_REWARD, balance };
			}

			// ── Chasse aux Énigmes (trail) : niveaux payés dans l'ordre ────────
			if (body.level === undefined)
			{
				set.status = 422;
				return { error: "level requis pour type=trail" };
			}
			if (body.maxLevel !== undefined && body.level > body.maxLevel)
			{
				set.status = 422;
				return { error: "level > maxLevel" };
			}

			const gain = await payTrail(user, body.level, body.maxLevel ?? 17);
			if (!gain) return { ok: true, paid: 0, note: "niveau déjà payé" };
			return { ok: true, paid: gain, level: body.level };
		},
		{
			body: t.Object({
				type:     t.Union([t.Literal("trail"), t.Literal("rotd")]),
				login:    t.String({ minLength: 1, maxLength: 32 }),
				level:    t.Optional(t.Integer({ minimum: 1, maximum: 17 })),
				maxLevel: t.Optional(t.Integer({ minimum: 1, maximum: 17 })),
			}),
		},
	);
