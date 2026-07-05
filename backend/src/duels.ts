import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishToUser, publishLeaderboard, publishAdminLog } from "./realtime";
import { pushNotif, type Sender } from "./notifications";
import { rl, BUCKETS } from "./ratelimit";
import { fairRoll } from "./fair";
import { recordStat } from "./gamestats";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";
const MAX_STAKE = 100_000;

async function sender(userId: number): Promise<Sender | null>
{
	const rows = (await sql`
		SELECT id, login, display_name, image_url FROM users WHERE id = ${userId}
	`) as Sender[];
	return rows[0] ?? null;
}

// Debit `amount` from a user iff their balance covers it. Returns new balance or null.
async function debit(userId: number, amount: number): Promise<number | null>
{
	const rows = (await sql`
		UPDATE users SET points = points - ${amount}
		WHERE id = ${userId} AND points >= ${amount}
		RETURNING points
	`) as Array<{ points: number }>;
	if (!rows[0]) return null;
	publishBalance(userId, rows[0].points);
	return rows[0].points;
}

async function credit(userId: number, amount: number): Promise<number>
{
	const rows = (await sql`
		UPDATE users SET points = points + ${amount} WHERE id = ${userId} RETURNING points
	`) as Array<{ points: number }>;
	publishBalance(userId, rows[0].points);
	return rows[0].points;
}

export const duels = new Elysia({ prefix: "/api/duels" })
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
	.onBeforeHandle(({ userId, set, request }) =>
		request.method === "GET"
			? rl(`social-r:${userId}`, BUCKETS.socialRead, set)
			: rl(`duels-w:${userId}`, BUCKETS.socialWrite, set))

	// My duels: incoming challenges + outgoing pending + recent history.
	.get("/me", async ({ userId }) =>
	{
		const rows = (await sql`
			SELECT d.id, d.stake, d.status, d.winner_id, d.created_at,
			       d.challenger_id, d.opponent_id,
			       c.login AS challenger_login, c.display_name AS challenger_name, c.image_url AS challenger_image,
			       o.login AS opponent_login,   o.display_name AS opponent_name,   o.image_url AS opponent_image
			FROM duels d
			JOIN users c ON c.id = d.challenger_id
			JOIN users o ON o.id = d.opponent_id
			WHERE d.challenger_id = ${userId} OR d.opponent_id = ${userId}
			ORDER BY d.created_at DESC
			LIMIT 30
		`) as unknown[];
		return { duels: rows };
	})

	// Challenge a friend to a coinflip duel; stake is escrowed immediately.
	.post(
		"/",
		async ({ body, userId, set }) =>
		{
			const { login, stake } = body;
			const rows = (await sql`
				SELECT id FROM users WHERE lower(login) = ${login.toLowerCase()}
			`) as Array<{ id: number }>;
			const opponent = rows[0];
			if (!opponent)
			{
				set.status = 404;
				return { error: "joueur introuvable" };
			}
			if (opponent.id === userId)
			{
				set.status = 400;
				return { error: "tu ne peux pas te défier toi-même" };
			}

			const friend = (await sql`
				SELECT 1 FROM friendships
				WHERE status = 'accepted'
				  AND ((requester_id = ${userId} AND addressee_id = ${opponent.id})
				    OR (requester_id = ${opponent.id} AND addressee_id = ${userId}))
			`) as unknown[];
			if (!friend[0])
			{
				set.status = 403;
				return { error: "vous devez être amis pour vous défier" };
			}

			const balance = await debit(userId!, stake);
			if (balance === null)
			{
				set.status = 400;
				return { error: "solde insuffisant" };
			}

			const [duel] = (await sql`
				INSERT INTO duels (challenger_id, opponent_id, stake)
				VALUES (${userId!}, ${opponent.id}, ${stake})
				RETURNING id
			`) as Array<{ id: number }>;

			const me = await sender(userId!);
			void pushNotif(opponent.id, {
				kind: "duel",
				message: `⚔️ ${me?.display_name || me?.login} te défie en duel pour ${stake} pts !`,
				from: me,
				link: "/friends",
			});
			publishToUser(opponent.id, { type: "duel", action: "challenge", duelId: duel.id });

			return { id: duel.id, balance };
		},
		{
			body: t.Object({
				login: t.String({ minLength: 1, maxLength: 30 }),
				stake: t.Integer({ minimum: 10, maximum: MAX_STAKE }),
			}),
		},
	)

	// Accept: escrow my stake, flip server-side, winner takes the pot.
	.post("/:id/accept", async ({ params, userId, set }) =>
	{
		// Lock the duel row optimistically so two accepts can't both run.
		const [duel] = (await sql`
			UPDATE duels SET status = 'resolving'
			WHERE id = ${Number(params.id)} AND opponent_id = ${userId!} AND status = 'pending'
			RETURNING id, challenger_id, opponent_id, stake
		`) as Array<{ id: number; challenger_id: number; opponent_id: number; stake: number }>;
		if (!duel)
		{
			set.status = 404;
			return { error: "duel introuvable ou déjà résolu" };
		}

		const balance = await debit(userId!, duel.stake);
		if (balance === null)
		{
			await sql`UPDATE duels SET status = 'pending' WHERE id = ${duel.id}`;
			set.status = 400;
			return { error: "solde insuffisant" };
		}

		const { values } = await fairRoll(userId!);
		const challengerWins = values[0] < 0.5;
		const winnerId = challengerWins ? duel.challenger_id : duel.opponent_id;
		const loserId  = challengerWins ? duel.opponent_id : duel.challenger_id;
		const pot = duel.stake * 2;

		await sql`
			UPDATE duels SET status = 'resolved', winner_id = ${winnerId}, resolved_at = now()
			WHERE id = ${duel.id}
		`;
		const winnerBalance = await credit(winnerId, pot);
		void publishLeaderboard();

		void recordStat(duel.challenger_id, "duel", duel.stake, challengerWins ? pot : 0);
		void recordStat(duel.opponent_id, "duel", duel.stake, challengerWins ? 0 : pot);

		const w = await sender(winnerId);
		const l = await sender(loserId);
		void pushNotif(winnerId, {
			kind: "duel",
			message: `⚔️ Duel gagné contre ${l?.display_name || l?.login} : +${duel.stake} pts !`,
			from: l, link: "/friends",
		});
		void pushNotif(loserId, {
			kind: "duel",
			message: `⚔️ Duel perdu contre ${w?.display_name || w?.login} : -${duel.stake} pts.`,
			from: w, link: "/friends",
		});
		publishToUser(duel.challenger_id, { type: "duel", action: "resolved", duelId: duel.id, winnerId });
		publishToUser(duel.opponent_id, { type: "duel", action: "resolved", duelId: duel.id, winnerId });
		publishAdminLog({ action: "duel", winner: w?.login, loser: l?.login, stake: duel.stake });

		return {
			win: winnerId === userId,
			winnerId,
			pot,
			balance: winnerId === userId ? winnerBalance : balance,
		};
	})

	// Decline: refund the challenger.
	.post("/:id/decline", async ({ params, userId, set }) =>
	{
		const [duel] = (await sql`
			UPDATE duels SET status = 'declined', resolved_at = now()
			WHERE id = ${Number(params.id)} AND opponent_id = ${userId!} AND status = 'pending'
			RETURNING challenger_id, stake
		`) as Array<{ challenger_id: number; stake: number }>;
		if (!duel)
		{
			set.status = 404;
			return { error: "duel introuvable" };
		}
		await credit(duel.challenger_id, duel.stake);
		const me = await sender(userId!);
		void pushNotif(duel.challenger_id, {
			kind: "duel",
			message: `⚔️ ${me?.display_name || me?.login} a refusé ton duel (mise remboursée).`,
			from: me, link: "/friends",
		});
		publishToUser(duel.challenger_id, { type: "duel", action: "declined" });
		return { ok: true };
	})

	// Cancel my own pending challenge: refund.
	.post("/:id/cancel", async ({ params, userId, set }) =>
	{
		const [duel] = (await sql`
			UPDATE duels SET status = 'cancelled', resolved_at = now()
			WHERE id = ${Number(params.id)} AND challenger_id = ${userId!} AND status = 'pending'
			RETURNING stake, opponent_id
		`) as Array<{ stake: number; opponent_id: number }>;
		if (!duel)
		{
			set.status = 404;
			return { error: "duel introuvable" };
		}
		const balance = await credit(userId!, duel.stake);
		publishToUser(duel.opponent_id, { type: "duel", action: "cancelled" });
		return { ok: true, balance };
	});
