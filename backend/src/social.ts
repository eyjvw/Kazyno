import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { isOnline, onlineList, publishToUser, publishBalance, publishAdminLog } from "./realtime";
import { pushNotif } from "./notifications";
import { rl, BUCKETS } from "./ratelimit";
import { checkGiftSent } from "./achievements";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

interface UserCard
{
	id: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
}

async function card(userId: number): Promise<UserCard | null>
{
	const rows = (await sql`
		SELECT id, login, display_name, image_url FROM users WHERE id = ${userId}
	`) as UserCard[];
	return rows[0] ?? null;
}

/** Trade-off: if you hide your own presence, you don't see anyone else's either. */
async function canSeePresence(viewerId: number | null): Promise<boolean>
{
	if (!viewerId) return true;
	const rows = (await sql`SELECT show_presence FROM users WHERE id = ${viewerId}`) as Array<{
		show_presence: boolean;
	}>;
	return rows[0]?.show_presence ?? true;
}

export const social = new Elysia({ prefix: "/api" })
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
	{
		const write = request.method !== "GET";
		return write
			? rl(`social-w:${userId}`, BUCKETS.socialWrite, set)
			: rl(`social-r:${userId}`, BUCKETS.socialRead, set);
	})

	// Who is online right now (excluding self).
	.get("/presence", async ({ userId }) =>
	{
		if (!(await canSeePresence(userId))) return { online: [] };
		return { online: onlineList().filter((u) => u.id !== userId) };
	})

	// Public profile of a user by login, with my relationship + rank.
	.get("/users/:login", async ({ userId, params, set }) =>
	{
		const login = params.login.toLowerCase();
		const rows = (await sql`
			SELECT id, login, display_name, image_url, points, created_at, title, name_color
			FROM users WHERE lower(login) = ${login}
		`) as Array<UserCard & { points: number; created_at: string; title: string | null; name_color: string | null }>;
		const u = rows[0];
		if (!u)
		{
			set.status = 404;
			return { error: "joueur introuvable" };
		}

		const rk = (await sql`
			SELECT rank FROM (
				SELECT id, ROW_NUMBER() OVER (ORDER BY points DESC, created_at ASC) AS rank
				FROM users
			) t WHERE id = ${u.id}
		`) as Array<{ rank: number }>;

		let status = "none";
		if (u.id === userId)
		{
			status = "self";
		}
		else
		{
			const fr = (await sql`
				SELECT requester_id, status FROM friendships
				WHERE (requester_id = ${userId} AND addressee_id = ${u.id})
					 OR (requester_id = ${u.id} AND addressee_id = ${userId})
			`) as Array<{ requester_id: number; status: string }>;
			const f = fr[0];
			if (f)
			{
				status =
					f.status === "accepted"
						? "friend"
						: f.requester_id === userId
							? "pending_out"
							: "pending_in";
			}
		}

		const seePresence = await canSeePresence(userId);
		return {
			user: { ...u, rank: rk[0]?.rank ?? null, online: seePresence && isOnline(u.id), status },
		};
	})

	// Current user's global leaderboard rank.
	.get("/leaderboard/me", async ({ userId }) =>
	{
		const rows = (await sql`
			SELECT rank FROM (
				SELECT id, ROW_NUMBER() OVER (ORDER BY points DESC, created_at ASC) AS rank
				FROM users
			) t WHERE id = ${userId}
		`) as Array<{ rank: number }>;
		return { rank: rows[0]?.rank ?? null };
	})

	// Search players by login / display name, annotated with relation status.
	.get("/users/search", async ({ userId, query }) =>
	{
		const q = String(query.q ?? "").trim().toLowerCase();
		if (q.length < 1) return { results: [] };

		const rows = (await sql`
			SELECT id, login, display_name, image_url
			FROM users
			WHERE id <> ${userId}
				AND (lower(login) LIKE ${q + "%"} OR lower(display_name) LIKE ${"%" + q + "%"})
			ORDER BY login
			LIMIT 10
		`) as UserCard[];

		const rels = (await sql`
			SELECT requester_id, addressee_id, status FROM friendships
			WHERE requester_id = ${userId} OR addressee_id = ${userId}
		`) as Array<{ requester_id: number; addressee_id: number; status: string }>;

		const statusFor = (otherId: number) =>
		{
			const r = rels.find(
				(x) => x.requester_id === otherId || x.addressee_id === otherId,
			);
			if (!r) return "none";
			if (r.status === "accepted") return "friend";
			return r.requester_id === userId ? "pending_out" : "pending_in";
		};

		const seePresence = await canSeePresence(userId);
		return {
			results: rows.map((u) => ({
				...u,
				status: statusFor(u.id),
				online: seePresence && isOnline(u.id),
			})),
		};
	})

	// Accepted friends, with live online status.
	.get("/friends", async ({ userId }) =>
	{
		const rows = (await sql`
			SELECT u.id, u.login, u.display_name, u.image_url, u.points
			FROM friendships f
			JOIN users u ON u.id = CASE
				WHEN f.requester_id = ${userId} THEN f.addressee_id ELSE f.requester_id END
			WHERE (f.requester_id = ${userId} OR f.addressee_id = ${userId})
				AND f.status = 'accepted'
			ORDER BY u.login
		`) as Array<UserCard & { points: number }>;
		const seePresence = await canSeePresence(userId);
		return {
			friends: rows.map((r) => ({ ...r, online: seePresence && isOnline(r.id) })),
		};
	})

	// Pending requests: received (incoming) and sent (outgoing).
	.get("/friends/requests", async ({ userId }) =>
	{
		const incoming = (await sql`
			SELECT u.id, u.login, u.display_name, u.image_url
			FROM friendships f
			JOIN users u ON u.id = f.requester_id
			WHERE f.addressee_id = ${userId} AND f.status = 'pending'
			ORDER BY f.created_at DESC
		`) as UserCard[];
		const outgoing = (await sql`
			SELECT u.id, u.login, u.display_name, u.image_url
			FROM friendships f
			JOIN users u ON u.id = f.addressee_id
			WHERE f.requester_id = ${userId} AND f.status = 'pending'
			ORDER BY f.created_at DESC
		`) as UserCard[];
		return { incoming, outgoing };
	})

	// Cancel a request I sent.
	.post(
		"/friends/cancel",
		async ({ userId, body }) =>
		{
			await sql`
				DELETE FROM friendships
				WHERE requester_id = ${userId} AND addressee_id = ${body.userId}
					AND status = 'pending'
			`;
			publishToUser(body.userId, { type: "friend_removed", userId });
			return { ok: true };
		},
		{ body: t.Object({ userId: t.Integer() }) },
	)

	// Send a request by login. Auto-accepts if the reverse request exists.
	.post(
		"/friends/request",
		async ({ userId, body, set }) =>
		{
			const login = body.login.trim().toLowerCase();
			const targetRows = (await sql`
				SELECT id FROM users WHERE lower(login) = ${login}
			`) as Array<{ id: number }>;
			const target = targetRows[0];
			if (!target)
			{
				set.status = 404;
				return { error: "joueur introuvable" };
			}
			if (target.id === userId)
			{
				set.status = 400;
				return { error: "tu ne peux pas t'ajouter toi-meme" };
			}

			const existing = (await sql`
				SELECT id, requester_id, status FROM friendships
				WHERE (requester_id = ${userId} AND addressee_id = ${target.id})
					 OR (requester_id = ${target.id} AND addressee_id = ${userId})
			`) as Array<{ id: number; requester_id: number; status: string }>;
			const e = existing[0];

			if (e?.status === "accepted")
			{
				set.status = 409;
				return { error: "deja amis" };
			}
			if (e?.status === "pending")
			{
				if (e.requester_id === userId)
				{
					set.status = 409;
					return { error: "demande deja envoyee" };
				}
				// Reverse pending -> accept it now.
				await sql`UPDATE friendships SET status = 'accepted' WHERE id = ${e.id}`;
				const me = await card(userId!);
				const them = await card(target.id);
				publishToUser(target.id, { type: "friend_accepted", user: me });
				publishToUser(userId!, { type: "friend_accepted", user: them });
				if (me)
					await pushNotif(target.id, {
						kind: "friend_accepted",
						message: `${me.login} a accepté ta demande d'ami`,
						from: me,
						link: "/friends",
					});
				return { status: "accepted" };
			}

			await sql`
				INSERT INTO friendships (requester_id, addressee_id, status)
				VALUES (${userId}, ${target.id}, 'pending')
			`;
			const me = await card(userId!);
			publishToUser(target.id, { type: "friend_request", user: me });
			if (me)
				await pushNotif(target.id, {
					kind: "friend_request",
					message: `${me.login} t'a envoyé une demande d'ami`,
					from: me,
					link: "/friends",
				});
			return { status: "pending" };
		},
		{ body: t.Object({ login: t.String({ minLength: 1, maxLength: 32 }) }) },
	)

	// Accept a pending request from a given user.
	.post(
		"/friends/accept",
		async ({ userId, body, set }) =>
		{
			const rows = (await sql`
				UPDATE friendships SET status = 'accepted'
				WHERE requester_id = ${body.userId} AND addressee_id = ${userId}
					AND status = 'pending'
				RETURNING id
			`) as Array<{ id: number }>;
			if (!rows[0])
			{
				set.status = 404;
				return { error: "demande introuvable" };
			}
			const me = await card(userId!);
			const them = await card(body.userId);
			publishToUser(body.userId, { type: "friend_accepted", user: me });
			publishToUser(userId!, { type: "friend_accepted", user: them });
			if (me)
				await pushNotif(body.userId, {
					kind: "friend_accepted",
					message: `${me.login} a accepté ta demande d'ami`,
					from: me,
					link: "/friends",
				});
			return { ok: true };
		},
		{ body: t.Object({ userId: t.Integer() }) },
	)

	// Decline a pending request.
	.post(
		"/friends/decline",
		async ({ userId, body }) =>
		{
			await sql`
				DELETE FROM friendships
				WHERE requester_id = ${body.userId} AND addressee_id = ${userId}
					AND status = 'pending'
			`;
			return { ok: true };
		},
		{ body: t.Object({ userId: t.Integer() }) },
	)

	// Remove an existing friend (either direction).
	.delete("/friends/:userId", async ({ userId, params }) =>
	{
		const other = Number(params.userId);
		await sql`
			DELETE FROM friendships
			WHERE status = 'accepted'
				AND ((requester_id = ${userId} AND addressee_id = ${other})
					OR (requester_id = ${other} AND addressee_id = ${userId}))
		`;
		publishToUser(other, { type: "friend_removed", userId });
		return { ok: true };
	})

	// Gift points to another player.
	.post(
		"/social/gift",
		async ({ userId, body, set }) =>
		{
			const [me] = (await sql`
				SELECT login FROM users WHERE id = ${userId!}
			`) as Array<{ login: string }>;

			if (me?.login?.toLowerCase() === body.to_login.toLowerCase())
			{
				set.status = 400;
				return { error: "Tu ne peux pas t'offrir des points à toi-même" };
			}

			const [target] = (await sql`
				SELECT id, login, display_name FROM users
				WHERE lower(login) = lower(${body.to_login}) LIMIT 1
			`) as Array<{ id: number; login: string; display_name: string | null }>;

			if (!target) { set.status = 404; return { error: "Utilisateur introuvable" }; }

			// Atomic deduct from sender
			const [sender] = (await sql`
				UPDATE users SET points = points - ${body.amount}
				WHERE id = ${userId!} AND points >= ${body.amount}
				RETURNING points, login
			`) as Array<{ points: number; login: string }>;

			if (!sender) { set.status = 400; return { error: "Solde insuffisant" }; }

			// Credit recipient
			const [recv] = (await sql`
				UPDATE users SET points = points + ${body.amount}
				WHERE id = ${target.id}
				RETURNING points
			`) as Array<{ points: number }>;

			publishBalance(userId!, sender.points);
			publishBalance(target.id, recv.points);
			publishAdminLog({ action: "gift", login: sender.login });

			const msg = `@${sender.login} t'a offert ${body.amount.toLocaleString("fr-FR")} pts 🎁`;
			await pushNotif(target.id,
			{
				kind:    "gift",
				message: msg,
				from:    { id: userId!, login: sender.login, display_name: me.login, image_url: null },
				link:    `/profile?u=${sender.login}`,
			});

			void checkGiftSent(userId!);

			return { balance: sender.points, to: target.login };
		},
		{
			body: t.Object({
				to_login: t.String({ minLength: 1 }),
				amount:   t.Integer({ minimum: 1, maximum: 100_000 }),
			}),
		},
	);
